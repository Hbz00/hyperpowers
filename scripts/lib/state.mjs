/**
 * Run state: creation, validated transitions, progress signatures.
 *
 * Spec §11 requires every transition to record the previous phase, the new phase, a
 * timestamp, the responsible agent, the artefact produced, proof of transition, observed
 * cost, any fallbacks and remaining open problems. That is enforced here rather than asked
 * for in a prompt, because a state machine an agent can talk its way past is not a state
 * machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, readText, writeJson, withLock, nowIso, sha256, ensureDir } from './io.mjs';
import { loadConfig, DIRECTOR_AGENT } from './config.mjs';
import { artifacts, PLUGIN_ROOT } from './paths.mjs';
import { validate } from './validate.mjs';
import { PHASES, ALL_ROUNDS, canTransition, isKnownPhase, isTerminal, phaseIndex } from './phases.mjs';
import { excludeOwnFiles } from './workspace.mjs';
import { directorTier, childAgents, directorSubagent } from './transcript.mjs';
import { logEvent } from './telemetry.mjs';

export const STATE_SCHEMA_VERSION = 1;

export function newState({ runId, sessionId, projectRoot, description = '', config = {} }) {
  const at = nowIso();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId,
    sessionId,
    projectRoot: path.resolve(projectRoot),
    createdAt: at,
    updatedAt: at,
    phase: 'PREFLIGHT',
    revision: 0,
    request: { description },
    config,
    history: [],
    counters: {
      workPackages: 0,
      subagentsCompleted: 0,
      fallbacks: 0,
      retries: {},
      extraReviews: {},
      codexInvocations: 0,
    },
    reviews: {},
    adjudications: {},
    gates: {},
    openBlockers: [],
    residualRisks: [],
    stall: { signature: null, count: 0, lastAt: null },
    turn: { promptId: null, blocks: 0 },
    // The main thread's block counter. The director's lives in `directorTurn` and is keyed on
    // `agent_id`, because `prompt_id` is identical across `Stop` and `SubagentStop` (§R5) — one
    // counter for two independent loops would suspend a healthy run whenever a subagent finished.
    //
    // `yielded` says which way the *director's* loop last went, and only `subagent-controller`
    // writes it: `true` when it let the director stop, `false` when it blocked and sent it back to
    // work. The main thread's Stop hook reads it and nothing else. It replaces an `inFlight` flag
    // set on `SubagentStart` and cleared on every `SubagentStop` before the block decision — which
    // meant it was false for the whole life of a director after its first stop. The loop that makes
    // the decision is the only honest reporter of it.
    directorTurn: { agentId: null, blocks: 0, yielded: false },
    // Which subagents are running right now, `agent_id → { at, type }`. Written on
    // `SubagentStart`/`SubagentStop`, both measured to fire for every subagent (§T1).
    // Parentage is deliberately *not* stored — see `liveChildren`.
    children: {},
    blocked: null,
  };
}

/**
 * How long an entry in `children` may sit before it is assumed stale.
 *
 * The registry leaks if a subagent dies without a `SubagentStop` — a crash, an API error, a
 * harness kill, or the run being aborted out from under it (all four are in run 6's record). A
 * leaked entry would make the director look permanently busy and it would never be re-driven
 * again: a silent hang, which is worse than the churn this whole mechanism removes.
 *
 * So entries expire. The bound is measured, not guessed: the longest-lived subagent across every
 * recorded run is the run-6 adjudicator at **36 minutes**, and the longest a *working* agent went
 * without writing a message is **17.7 minutes**. One hour is comfortably above the first and far
 * enough above the second that no live agent is ever pruned.
 */
export const CHILD_STALE_MS = 60 * 60 * 1000;

/**
 * A digest of the document a Codex round actually read, or `null` where the reviewed thing is not
 * a document.
 *
 * Recorded in the review, compared at the gate. Nothing tied a review to a *version* before this,
 * and run 6 walked straight through the gap: `design.md` was edited at 02:08:08 to resolve a
 * finding the 02:06:45 round-2 review had raised, and the run then re-entered `DESIGN_REVIEW_2` and
 * left it for `DESIGN_LOCK` **50 ms later** with no fresh review. The design gate passed 11/11 and
 * the locked text was not the reviewed text.
 *
 * That is *permitted* — §18 only mandates a further round when round 2 raises a new blocker, and
 * this finding was non-blocking. What was missing is that nobody could see it: the gate could not
 * distinguish a two-line correction from a rewrite. Hence `unverifiable` rather than `fail` at the
 * call site — the fact becomes a stated residual risk instead of a silent one.
 *
 * `implementation` used to be excluded on the argument that the tree "moves for legitimate
 * reasons between every round, so a mismatch there would fire always and mean nothing". That was
 * true while every round was checked; once the gate narrowed to the *last* round only, the
 * premise no longer held — between IMPLEMENTATION_REVIEW_2 and the completion gate the phase
 * graph intends no tree movement at all. The production run walked through the gap: round 6
 * raised a blocker, remediation rewrote the fix *after* the review, no further round read it,
 * and the completion gate passed with nothing recorded (§18's own case). The digest is the tree
 * as the reviewer saw it — `excludeOwnFiles()`, matching what the review pack shows — so an edit
 * to Hyperpowers' own files cannot trip a digest over content no reviewer was given.
 */
export function reviewedArtifactDigest(projectRoot, runId, artifact) {
  const a = artifacts(projectRoot, runId);
  if (artifact === 'implementation') return sha256(gitSnapshot(projectRoot, excludeOwnFiles()));
  const file = { design: a.design, plan: a.plan }[artifact];
  if (!file) return null;
  return sha256(readText(file, 'absent'));
}

/**
 * Is a director currently driving this run?
 *
 * Used by the one rule that stops a second director existing at all. Run 6 grew two: an
 * `opus-review-adjudicator` — which has the `Agent` tool, legitimately, to escalate — read "reply to
 * the director" as "dispatch the director" and spawned one at depth 3 ($4.37, and it drove the run's
 * continuations for four minutes); and the main thread launched a cold duplicate at depth 1 where
 * its own skill says to use `SendMessage`. Neither is distinguishable by *who* asked, because
 * `PreToolUse` carries no `agent_id` (§D5) — but neither has to be. A run has one director, and if one
 * is driving, a request for another is wrong whoever makes it.
 *
 * Three inputs, in this order, and the order is the whole design (§S40):
 *
 *  1. **An explicit yield always releases.** `subagent-controller` sets `yielded` true only where it
 *     lets the director's stop through, and `resume-run.mjs` sets it when a user releases a stuck run.
 *     Consulting this first is what keeps a director that died *without* stopping replaceable — a
 *     fallback that ignored it would deny every replacement for ever, which is worse than the hole it
 *     closes.
 *  2. **A recorded id means somebody is at the wheel.** The ordinary case.
 *  3. **Otherwise, the meta files on disk.** Run 9 measured why this is needed: no hook observes the
 *     director's *start*, because `/hyperpowers:feature` dispatches it and the director then creates the
 *     run — so `subagent-controller` returns at `if (!runId)` and state cannot know the id until the
 *     first stop. For the whole of phase one this rule was therefore inert. `directorSubagent` reads the
 *     depth-1 meta the harness writes live (§S4 T28), and ranks a wrong depth last, so run 6's depth-3
 *     impostor is not mistaken for the thing it impersonates.
 *
 * `transcriptPath` is optional: without it the answer degrades to (1) and (2), which is exactly the
 * behaviour that shipped before — callers that have no transcript lose nothing.
 */
export function directorIsDriving(state, transcriptPath = null) {
  if (!state || isTerminal(state.phase)) return false;
  if (state.directorTurn?.yielded === true) return false;
  // The Stop controller sets this when it tells the main thread to resume-or-replace the
  // director: the yield was consumed by being reported, and without the marker the recorded id
  // would deny exactly the dispatch that message instructs. Cleared by the next director
  // SubagentStart/Stop, so it cannot leave the rule open while a director genuinely drives.
  if (state.directorTurn?.replaceable === true) return false;
  if (state.directorTurn?.agentId) return true;
  if (!transcriptPath) return false;
  const found = directorSubagent(transcriptPath);
  return Boolean(found?.agentId) && found.spawnDepth === 1;
}

/**
 * The subagents `parentAgentId` dispatched that have not reported stopping.
 *
 * This is the fact that distinguishes a director which is **waiting** from one which is **stuck**,
 * and run 6 turned on it: 12 of that run's 20 continuations were a director politely reporting
 * "coordinator still active, watcher armed" while the loop counted each report as a stall sample
 * and burned a continuation for it.
 *
 * The registry stores only which agents are live; parentage is looked up from the meta files at
 * read time (`childAgents`), because `SubagentStart` carries no `parentAgentId` (§T1).
 *
 * **Fail-open is the whole design.** Every path that cannot produce positive, fresh evidence — an
 * unreadable transcript directory, a missing meta, an expired entry — returns fewer children, and
 * fewer children means the director gets re-driven, which is exactly today's behaviour. Nothing
 * here can invent a wait.
 */
export function liveChildren(state, transcriptPath, parentAgentId) {
  const registry = state?.children ?? {};
  const cutoff = Date.now() - CHILD_STALE_MS;
  return childAgents(transcriptPath, parentAgentId).filter(({ agentId }) => {
    const entry = registry[agentId];
    if (!entry) return false;
    const at = Date.parse(entry.at ?? '');
    return Number.isFinite(at) && at > cutoff;
  });
}

export function loadState(projectRoot, runId) {
  const a = artifacts(projectRoot, runId);
  const state = readJson(a.state, null);
  if (!state) throw new Error(`No state.json for run ${runId}`);
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `state.json schemaVersion ${state.schemaVersion} is not supported by this Hyperpowers ` +
        `build (expects ${STATE_SCHEMA_VERSION}). Start a new run.`,
    );
  }
  return state;
}

export function tryLoadState(projectRoot, runId) {
  try {
    return loadState(projectRoot, runId);
  } catch {
    return null;
  }
}

export function saveState(projectRoot, runId, state) {
  const a = artifacts(projectRoot, runId);
  ensureDir(a.base);
  state.updatedAt = nowIso();
  writeJson(a.state, state);
  return state;
}

/** Run a read-modify-write under the run's lock so concurrent agents cannot clobber state. */
export function mutateState(projectRoot, runId, fn) {
  const a = artifacts(projectRoot, runId);
  ensureDir(a.base);
  return withLock(a.lock, () => {
    const state = loadState(projectRoot, runId);
    const result = fn(state);
    state.revision += 1;
    saveState(projectRoot, runId, state);
    return result === undefined ? state : result;
  });
}

/**
 * Why a finished run must refuse this write, or `null` when it is still live.
 *
 * A run ends its *state*, not its subagents: the harness keeps them running, and `PreToolUse`
 * carries no `agent_id` (§D5), so no hook can tell one of their tool calls from the user's own and
 * none can stop them. Measured on an aborted run: the plan coordinator wrote for nine more minutes
 * and three `gate=plan` evaluations landed in a finished run's record.
 *
 * What is achievable is that they accomplish nothing. Every verb that writes refuses with a reason
 * naming the end, so an agent that keeps going fails fast and winds down instead of quietly
 * appending to a run somebody already closed.
 */
export function refuseIfEnded(projectRoot, runId) {
  const state = tryLoadState(projectRoot, runId);
  if (!state || !isTerminal(state.phase)) return null;
  return `Run ${runId} ended in ${state.phase}${state.blocked ? `: ${state.blocked}` : ''}. `
    + `Its record is closed and nothing may be written to it. If you are a subagent still running, `
    + `stop now and report that the run ended — the work you are doing has nowhere to go.`;
}

/**
 * The question the director is waiting on, or `null`.
 *
 * Truth is the file, not a state flag. A flag would be a second thing to keep in step with the
 * packet, and this codebase's recurring defect is exactly that — a field one half writes and the
 * other half forgets. `askedAt` without `answeredAt` *is* the pending state.
 */
export function pendingQuestion(projectRoot, runId) {
  const packet = readJson(artifacts(projectRoot, runId).question, null);
  if (!packet?.askedAt || packet.answeredAt) return null;
  return packet;
}

/**
 * Anything the director needs the **main thread** to do, because only the main thread can.
 *
 * There turned out to be two of these, not one. Questions were the first (§S6, §R1: the harness
 * removes `AskUserQuestion` from every subagent). Publishing is the second, and run 7 found it: the
 * director called `Artifact` itself, got a perfectly valid URL, recorded it, and **nothing opened**,
 * because the main thread made exactly one tool call in the whole run and had nothing to present.
 * The completion gate passed on a URL existing — it checks the record, not that a human saw it.
 *
 * Same shape, same two controllers, one predicate: the `SubagentStop` hook must *allow* the
 * director's stop so the errand can leave it, and the `Stop` hook must *block* the main thread
 * until it is run. Getting either backwards strands the run — which is why they read the same
 * function rather than each testing for their own kind.
 *
 * Truth is the file, never a flag: `askedAt` without its completion stamp *is* the pending state.
 */
export function pendingErrand(projectRoot, runId) {
  const question = pendingQuestion(projectRoot, runId);
  if (question) return { kind: 'question', ...question };
  const publish = readJson(artifacts(projectRoot, runId).publish, null);
  if (publish?.askedAt && !publish.publishedAt) return { kind: 'publish', ...publish };
  return null;
}

/**
 * Resolve a `requires` entry to a concrete, checkable condition.
 * Returns `{ ok, detail }`. Anything unknown fails closed.
 */
export function checkRequirement(projectRoot, runId, state, requirement) {
  const a = artifacts(projectRoot, runId);
  const nonEmptyFile = (p, minBytes = 1) => {
    try {
      return fs.statSync(p).size >= minBytes;
    } catch {
      return false;
    }
  };

  if (requirement.startsWith('review:')) {
    const round = requirement.slice('review:'.length);
    const file = a.review(round);
    if (!nonEmptyFile(file)) return { ok: false, detail: `missing review artefact ${file}` };
    const review = readJson(file, null);
    if (!review || review.status !== 'completed') {
      return { ok: false, detail: `review ${round} did not complete (status=${review?.status ?? 'none'})` };
    }
    return { ok: true, detail: `${review.findings?.length ?? 0} findings` };
  }

  if (requirement.startsWith('adjudicated:')) {
    const round = requirement.slice('adjudicated:'.length);
    const review = readJson(a.review(round), null);
    if (!review) return { ok: false, detail: `no review ${round} to adjudicate` };
    const decisions = state.adjudications?.[round]?.decisions ?? [];
    const decided = new Set(decisions.map((d) => d.finding_id));
    const undecided = (review.findings ?? []).filter((f) => !decided.has(f.id)).map((f) => f.id);
    if (undecided.length) {
      return { ok: false, detail: `undecided findings: ${undecided.join(', ')}` };
    }
    return { ok: true, detail: `${decisions.length} findings adjudicated` };
  }

  // A gate requirement reads the verdict `verify-completion.mjs` stored — the verifier is the only
  // writer, so it cannot be forged — but a verdict judges a *state*, not a run.
  //
  // Reproduced: record a passing completion gate, insert a critical open blocker, and the stored
  // `passed` still satisfied the requirement, so `COMPLETE` was reachable on a judgement of an
  // earlier run. "Re-run the verifier first" was an instruction to the director, and an instruction
  // is not an invariant. The revision counter moves on every mutation, so binding the verdict to
  // the revision it judged makes staleness mechanical: anything that changes the run — a new
  // blocker, fresh evidence, detected Git drift, an edited control file — invalidates it.
  if (requirement.startsWith('gate:')) {
    const gate = requirement.slice('gate:'.length);
    const record = state.gates?.[gate];
    if (!record) return { ok: false, detail: `gate ${gate} not evaluated` };
    if (!record.passed) return { ok: false, detail: `gate ${gate} failed: ${record.reason ?? 'unknown'}` };
    const now = gateInputDigest(projectRoot, runId, state, gate);
    if (record.inputs && record.inputs !== now) {
      return {
        ok: false,
        detail: `gate ${gate} passed at ${record.at}, but its inputs have changed since — a new ` +
          `blocker, a changed decision, fresh evidence, a task status or detected Git drift. Re-run ` +
          `\`verify-completion.mjs --gate ${gate}\`: a verdict does not carry over to a state it did not judge.`,
      };
    }
    return { ok: true, detail: `gate ${gate} passed at ${record.at}${record.inputs ? '' : ' (inputs unrecorded)'}` };
  }

  if (requirement === 'tasks:all-accepted') {
    const tasks = readJson(a.tasks, null);
    if (!tasks || !Array.isArray(tasks.tasks) || tasks.tasks.length === 0) {
      return { ok: false, detail: 'tasks.json is missing or empty' };
    }
    const pending = tasks.tasks.filter((t) => t.status !== 'accepted').map((t) => t.id);
    if (pending.length) return { ok: false, detail: `tasks not accepted: ${pending.join(', ')}` };
    return { ok: true, detail: `${tasks.tasks.length} tasks accepted` };
  }

  // Structured artefacts are checked for content, not just for existence. A byte-size check
  // passed the init-time stub `{"tasks": []}` and an empty `{}` evidence file, so a run could
  // walk PLAN_DRAFT → two mandatory Codex rounds → remediation with no work packages at all,
  // spending real reviews on nothing before the deep gate noticed at PLAN_LOCK.
  if (requirement === 'tasks') {
    const tasks = readJson(a.tasks, null);
    const list = tasks?.tasks;
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: false, detail: 'tasks.json contains no work packages — the plan has not been decomposed yet' };
    }
    return { ok: true, detail: `${list.length} work packages` };
  }

  if (requirement === 'evidence') {
    const evidence = readJson(a.evidence, null);
    const criteria = evidence?.criteria;
    const checks = evidence?.checks;
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return { ok: false, detail: 'evidence.json records no acceptance criteria — nothing has been proven yet' };
    }
    if (!Array.isArray(checks) || checks.length === 0) {
      return { ok: false, detail: 'evidence.json records no suite-level checks (tests, lint, typecheck, build)' };
    }
    /**
     * Shape, not just presence.
     *
     * Six §13 conditions read this file by *name* — `unit-tests`, `lint`, `typecheck`, `build`,
     * `runtime` — and the schema pins that vocabulary with an enum. Nothing enforced it, so a
     * verifier writing `tests` instead of `unit-tests` produced a file that looked complete and
     * left every one of those conditions reporting `unverifiable`: the run would then spend two
     * mandatory Codex rounds before the completion gate mentioned it. Failing here instead is
     * the same argument that stopped an empty `tasks.json` burning the plan rounds.
     */
    const schema = readJson(path.join(PLUGIN_ROOT, 'schemas', 'evidence-matrix.schema.json'), null);
    if (schema) {
      const { valid, errors } = validate(evidence, schema);
      if (!valid) {
        return {
          ok: false,
          detail: `evidence.json does not match evidence-matrix.schema.json — ${errors.slice(0, 4).join('; ')}`,
        };
      }
    }
    return { ok: true, detail: `${criteria.length} criteria, ${checks.length} checks` };
  }

  // Otherwise it names an artefact key directly.
  const target = a[requirement];
  if (typeof target !== 'string') return { ok: false, detail: `unknown requirement '${requirement}'` };
  // A design or plan of a few bytes is a placeholder, not an artefact.
  const minBytes = ['design', 'plan', 'brainstorm', 'request', 'finalReport'].includes(requirement) ? 200 : 1;
  if (!nonEmptyFile(target, minBytes)) {
    return { ok: false, detail: `artefact '${requirement}' missing or too small: ${target}` };
  }
  return { ok: true, detail: path.basename(target) };
}

export function checkGate(projectRoot, runId, state, phase = state.phase) {
  const spec = PHASES[phase];
  if (!spec) return { ok: false, failures: [`unknown phase ${phase}`] };
  const failures = [];
  for (const requirement of spec.requires) {
    const result = checkRequirement(projectRoot, runId, state, requirement);
    if (!result.ok) failures.push(`${requirement}: ${result.detail}`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Perform a validated transition. `force` exists only for the terminal states a controller
 * must be able to reach unconditionally (BLOCKED and friends).
 */
export function transition(projectRoot, runId, to, meta = {}) {
  return mutateState(projectRoot, runId, (state) => {
    const from = state.phase;
    if (!isKnownPhase(to)) throw new Error(`Unknown target phase '${to}'`);
    if (from === to) return state;
    if (!canTransition(from, to)) {
      throw new Error(
        `Illegal transition ${from} -> ${to}. Allowed: ${PHASES[from].successors.join(', ') || '(none)'}`,
      );
    }
    // Terminal phases skip the exit gate so a failing run can always reach BLOCKED, ABORTED or
    // POLICY_VIOLATION — a machine you cannot stop is worse than one you cannot finish. `COMPLETE` is the exception: it is terminal, but it is also the *success*
    // claim, and its exit requirements (`gate:completion`, `finalReport`) are the entire
    // mechanical content of spec §13. Exempting it made all fourteen conditions advisory at the
    // one moment they decide anything — a run could declare success with nothing proven. Success
    // is the one terminal state that must be earned.
    // The director tier, checked once, at the only moment it is still cheap to act on.
    //
    // The Stop controller already raises `model_mismatch`, and completion condition 12b already
    // fails on it — but the Stop hook fires when the director tries to *end* its turn, which a
    // healthy run does once in 86 minutes (§O14). Both real runs on a live project discovered the
    // demotion after the fact; the first had spent $4.19. Preflight reports it too, but preflight
    // is an instruction the skill gives, not something the machine requires — and today has been a
    // long lesson in the difference. Leaving PREFLIGHT is the machine's first opportunity.
    //
    // Terminal targets are exempt: a run that cannot start must still be able to reach BLOCKED.
    //
    // Launching as the director agent enforces the tier, so this looks redundant now. It is not.
    // Two ways remain for the tier to be wrong, and this is the only thing that catches either:
    //
    //   1. `--model` beats the agent's own pin — measured, §Q16 T2. `claude --model opus --agent
    //      hyperpowers:hyperpowers-director` yields an Opus director and nothing else objects.
    //   2. The legacy `/hyperpowers:feature` path, where the pin is a skill's and does not hold.
    //
    // Deleting it would restore precisely the failure that cost two four-hour runs, for a check
    // that costs one transcript read.
    if (from === 'PREFLIGHT' && !isTerminal(to)) {
      const tier = directorTier(state);
      if (tier.ok === false) {
        throw new Error(
          `The director is running on \`${tier.observed}\` (${tier.family}), but this run is ` +
            `configured for the \`${tier.expected}\` tier. Product authority — the design gate, the ` +
            `final acceptance, every irreversible trade-off — would be exercised by the wrong model, ` +
            `and completion condition 12b would fail at the end of the run rather than now.\n\n` +
            `The director runs as the \`${DIRECTOR_AGENT}\` subagent. Its declared \`model:\` holds ` +
            `against the session default but is outranked by a per-invocation \`model\` argument ` +
            `and by \`CLAUDE_CODE_SUBAGENT_MODEL\` (§V2) — check \`model:\` in ` +
            `\`agents/${DIRECTOR_AGENT}.md\`, and that variable in this session's environment.\n\n` +
            `If you mean to direct with ${tier.family}, say so and this stops being a mismatch: ` +
            `put {"models":{"director":"${tier.family}"}} in .hyperpowers.json and start a new run.`,
        );
      }
    }

    // An exit gate proves the work before a run goes **forward** on it. A backward edge is the
    // redoing itself, so gating it locks the door it exists to open.
    //
    // Every gated phase declares one: `DESIGN_LOCK → DESIGN_DRAFT`, `PLAN_LOCK → PLAN_DRAFT`,
    // `FINAL_ACCEPTANCE → IMPLEMENTATION_REMEDIATION | SYSTEM_VERIFICATION`. Each exists for exactly
    // one situation — the gate said no — and in exactly that situation none of them was reachable.
    // `FINAL_ACCEPTANCE` is the worst case: the director's three answers are COMPLETE, REMEDIATE and
    // BLOCKED, and a failing completion gate refused COMPLETE (rightly) *and* both REMEDIATE edges,
    // so a run one fixable finding from success could only be declared insoluble. BLOCKED is terminal.
    //
    // Derived from `PHASE_ORDER` rather than declared, because a second list of "recovery edges" is a
    // second thing to keep in step with `successors` — this repository's recurring defect. No gate is
    // escaped: coming forward again re-checks every gate on the way, so the only thing a backward
    // edge buys is the work.
    const backwards = phaseIndex(to) !== null && phaseIndex(from) !== null && phaseIndex(to) < phaseIndex(from);
    const skipGate = meta.force === true || to === 'SUSPENDED' || backwards
      || (isTerminal(to) && to !== 'COMPLETE');
    if (!skipGate) {
      const gate = checkGate(projectRoot, runId, state, from);
      if (!gate.ok) {
        throw new Error(
          `Cannot leave ${from}: unmet exit requirements —\n  - ${gate.failures.join('\n  - ')}`,
        );
      }
    }

    const entry = {
      from,
      to,
      at: nowIso(),
      actor: meta.actor ?? PHASES[from].owner,
      artifact: meta.artifact ?? null,
      evidence: meta.evidence ?? null,
      cost: meta.cost ?? null,
      fallbacks: meta.fallbacks ?? [],
      openProblems: meta.openProblems ?? state.openBlockers.map((b) => b.id ?? b),
      note: meta.note ?? null,
    };
    state.phase = to;
    state.history.push(entry);
    // A new phase is progress by definition; do not carry a stall counter across it.
    state.stall = { signature: null, count: 0, lastAt: null };
    if (isTerminal(to)) state.blocked = meta.reason ?? state.blocked ?? null;

    logEvent(projectRoot, runId, { type: 'transition', ...entry });
    return state;
  });
}

/**
 * A fingerprint of everything a gate verdict depends on.
 *
 * Deliberately *not* `state.revision`: the revision counts every mutation, including the Stop
 * controller's own bookkeeping, so binding a verdict to it made `COMPLETE` unreachable — the
 * reachability test caught that within one run of the suite, which is what it is for.
 *
 * What must invalidate a verdict is a change to what it judged — and *what it judged* means the
 * substance, not the labels. Hashing ids and statuses alone left a passing completion gate intact
 * while the implementation, the evidence proofs, the command a proof cited and the run's budget
 * were all rewritten underneath it. It now covers the contents of the artefacts each gate reads,
 * the reviews and adjudications for that gate's rounds, and — for completion only — the working
 * tree and the effective configuration. Everything outside that gate's reading may still move
 * freely between the verifier and the transition, which is the point of doing this per gate.
 */
export function gateInputDigest(projectRoot, runId, state, gate = 'completion') {
  const a = artifacts(projectRoot, runId);
  // Per gate, because each one reads different things. A single digest over everything was tried
  // first and refused a legitimate `DESIGN_LOCK → PLAN_DRAFT`: writing `tasks.json` for the plan
  // phase invalidated the *design* verdict, which had never read it. Over-binding is not a safer
  // kind of binding — it makes the check something people learn to route around.
  // Each gate reads its rounds' review *files* (findings, verdicts, digests), not only the
  // summaries in `state.reviews` — so the files are hashed too. They change only when a round
  // runs, which already invalidates legitimately; what this closes is a replaced review file
  // whose state summary happens to match.
  const reviewFiles = (artifact) => Object.entries(ALL_ROUNDS)
    .filter(([, r]) => r.artifact === artifact)
    .map(([name]) => a.review(name));
  const reads = {
    design: { artefacts: [a.design, ...reviewFiles('design')], artefact: 'design', tree: false, config: false },
    // `config: true` because `planGate` reads `budgets.maxFilesPerWorkPackage`: a plan that passed
    // at a limit of 7 kept its pass after the limit was lowered to 3, and `.hyperpowers.json` is
    // excluded from the review pack as Hyperpowers' own file, so the change is invisible in the
    // diff a reviewer sees. A gate is bound to everything it reads, config included.
    plan: { artefacts: [a.plan, a.tasks, ...reviewFiles('plan')], artefact: 'plan', tree: false, config: true },
    // `a.design` because condition 13.1b extracts the criteria from it — the design lives in the
    // run directory, outside the tree hash, and an edit there changed 13.1b's answer while the
    // stored verdict stayed fresh: reproduced, the run reached COMPLETE past a failing condition.
    // The work-package report files too: acceptance is justified by them, and a report deleted or
    // rewritten after acceptance left the completion digest byte-identical — the evidence that
    // authorised "accepted" could vanish under a fresh verdict. Reports are only legitimately
    // written before FINAL_ACCEPTANCE, so binding them over-binds nothing.
    completion: {
      artefacts: [a.evidence, a.tasks, a.design, ...reviewFiles('implementation'), ...reportFiles()],
      artefact: 'implementation', tree: true, config: true,
    },
  }[gate] ?? { artefacts: [a.evidence, a.tasks], artefact: null, tree: true, config: true };

  // Every stored report in `reports/` (not `rejected/` — a refused draft is not evidence the run
  // stands behind), sorted so the digest is order-independent.
  function reportFiles() {
    try {
      return fs.readdirSync(a.reportsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(a.reportsDir, f));
    } catch {
      return [];
    }
  }

  // Matched by artefact prefix rather than a fixed list of round names, so `design-extra` counts
  // for the design gate. Spec §18 only sanctions an extra round *after* a round-2 blocker, so a
  // named list would have been blind at precisely the moment a run is in trouble.
  const pick = (obj) => (reads.artefact
    ? Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => k.startsWith(`${reads.artefact}-`)))
    : (obj ?? {}));

  return sha256([
    gate,
    // Statuses first: cheap, and they are what a *legitimate* change moves. Severity included:
    // condition 13.6 reads it, and a blocker quietly downgraded from `critical` left the digest
    // byte-identical.
    (state.openBlockers ?? []).map((b) => `${b.id}:${b.status ?? 'open'}:${b.severity ?? ''}`).sort().join(','),
    String((state.gitDrift ?? []).length),
    // The residual risks, whole records: `dischargeUnverifiable` reads them to decide the
    // `unverifiable-stated` condition, so a risk added or reworded after a verdict is a changed
    // input to that verdict. Telemetry is deliberately NOT hashed — it grows on every
    // continuation, and binding a verdict to it would invalidate every pass on every director
    // stop, the over-binding this function's own comment warns against.
    sha256(JSON.stringify(state.residualRisks ?? [])),

    // Then the contents themselves. Hashing ids and statuses alone let a verdict survive changes
    // to everything it was a verdict *about*: rewriting an evidence proof to a fabrication,
    // swapping the command it claims to have run, replacing the implementation with broken code
    // and editing the budget all left the digest byte-identical — reproduced. A gate answers a
    // question about a state; if the state's substance can change underneath a passing answer,
    // the answer is decoration.
    sha256(JSON.stringify(pick(state.adjudications))),
    sha256(JSON.stringify(pick(state.reviews))),
    reads.artefacts.map((f) => sha256(readText(f, 'absent'))).join(','),

    // The working tree, because §13.10 ("no file outside the plan changed") is computed from it.
    // Without this the one condition that reads the repository was the one condition whose input
    // could change without invalidating its own verdict. Only the completion gate reads it.
    reads.tree ? sha256(gitSnapshot(projectRoot)) : 'no-tree',

    // The effective configuration, which decides the bounds the gate reasons under and is re-read
    // live on every call. `.hyperpowers.json` is excluded from the review pack and the scope check
    // as Hyperpowers' own file, so a change there is invisible in the diff a reviewer sees.
    reads.config ? sha256(JSON.stringify(loadConfig(projectRoot))) : 'no-config',
  ].join('|'));
}

/**
 * A stable fingerprint of the working tree, or a marker when Git cannot answer.
 *
 * The name list and the diff both matter: a file added and a file's contents rewritten are
 * different changes and neither may pass for the other. Failure is folded into the digest rather
 * than ignored, so "Git stopped answering" is itself a change of state.
 */
function gitSnapshot(projectRoot, pathspec = []) {
  // 5 s each, not 30.
  //
  // This runs inside `checkGate`, which the `SubagentStop` controller calls on every director stop —
  // a hook budgeted at 20 s and killed by the harness at 30. `execFileSync` blocks the event loop, so
  // the budget timer cannot fire while Git is running: three calls at 30 s could reach 90 s, the
  // harness would kill the process before `onError` ran, and a fail-open hook that never reaches its
  // own failure path is not fail-open — the director would simply not be re-driven. Git answering a
  // status or a diff takes milliseconds; a call that needs five seconds is a hang, and the folded
  // `(unavailable)` marker is the honest result of one.
  const run = (args, input) => {
    try {
      return execFileSync('git', ['-c', 'core.pager=cat', ...args], {
        cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        timeout: 5_000,
        ...(input === undefined ? {} : { input }),
      });
    } catch {
      return '(unavailable)';
    }
  };

  // Untracked *contents*, not just untracked paths.
  //
  // `status --short` prints `?? src/feature.mjs` and `diff HEAD` omits the file entirely, so the two
  // together fingerprinted the name of every new file and the bytes of none of them. In this workflow
  // that is the normal case, not an edge one: the user performs all Git, so a feature's new files stay
  // untracked for the whole run — run 8's entire deliverable was two of them. A passing completion
  // verdict therefore survived the feature being replaced with broken code.
  //
  // `hash-object --stdin-paths` does the hashing in one Git process: no argv limit, no file contents
  // crossing this boundary, and the blob ids change exactly when the bytes do.
  // Deliberately NOT the `-z` form the other path-identity sites use — measured, not assumed,
  // because assuming cost exactly the defect it claimed to fix: `git hash-object` has no `-z`
  // switch (unknown switch, exit 129, git 2.55), so passing it collapsed the whole blob term to
  // a constant `(unavailable)` and the digest stopped noticing untracked bytes at all — §S30
  // reopened by its own remediation. And the quoting concern never applied here: `--stdin-paths`
  // *dequotes* default-quoted names itself (verified: a C-quoted `"caf\303\251 file.mjs"` hashes
  // correctly, exit 0). Quoted-in, dequoted-inside is also what keeps a filename with an embedded
  // newline intact, which a newline-joined `-z` list would split.
  const untracked = run(['ls-files', '--others', '--exclude-standard', ...pathspec]);
  const untrackedBlobs = untracked && untracked !== '(unavailable)' && untracked.trim()
    ? run(['hash-object', '--stdin-paths'], untracked)
    : untracked;

  return [
    run(['status', '--short', '--untracked-files=all', ...pathspec]),
    run(['diff', 'HEAD', ...pathspec]),
    untrackedBlobs,
  ].join('\n');
}

/**
 * Signature used for no-progress detection (spec §16.3). It deliberately mixes phase, task
 * state, findings and evidence: a run that is "thinking" without changing any of these has,
 * for Hyperpowers' purposes, not progressed.
 *
 * `revision` is deliberately NOT included. It counts every mutation, including the controller's
 * own bookkeeping — recording a stall is itself a mutation — so including it made the signature
 * change on every observation and stall detection could never fire. Progress must be measured
 * by *content*, never by the act of measuring it.
 *
 * `attempts` is excluded for the same reason, one field further out. Re-declaring a package
 * `in_progress` increments it, so a coordinator retrying the same failing package in a loop —
 * precisely the situation §16.3 exists to catch — kept minting a fresh signature and never
 * escalated. Attempting is not progress; only a changed *outcome* is. The attempt count is still
 * recorded and reported, it just cannot vouch for itself here.
 */
export function progressSignature(projectRoot, runId, state) {
  const a = artifacts(projectRoot, runId);
  const tasks = readJson(a.tasks, { tasks: [] });
  const evidence = readJson(a.evidence, null);
  const parts = [
    state.phase,
    String(state.counters.workPackages),
    (tasks.tasks ?? []).map((t) => `${t.id}:${t.status}:${(t.reports ?? []).length}`).join(','),
    Object.keys(state.reviews ?? {}).sort().join(','),
    Object.entries(state.adjudications ?? {})
      .map(([k, v]) => `${k}:${v.decisions?.length ?? 0}`)
      .sort()
      .join(','),
    // Statuses, not counts. Counting entries missed the case that matters most during
    // SYSTEM_VERIFICATION: a check flipping fail→pass, or a criterion going unsatisfied→
    // satisfied, without any new entry being added. That is real progress and it read as a
    // stall.
    evidence
      ? [
          ...(evidence.criteria ?? []).map((c) => `${c.id}:${c.status}:${(c.evidence ?? []).length}`),
          ...(evidence.checks ?? []).map((c) => `${c.name}:${c.status}`),
        ].join(',')
      : 'no-evidence',
    // File mtimes catch in-place edits to design.md/plan.md that do not bump other counters.
    ['design', 'plan', 'brainstorm', 'request'].map((k) => statMtime(a[k])).join(','),
  ];
  return sha256(parts.join('|'));
}

function statMtime(p) {
  try {
    return String(Math.floor(fs.statSync(p).mtimeMs));
  } catch {
    return '0';
  }
}

/**
 * Count an unchanged signature — but no faster than `minIntervalMs`.
 *
 * §16.3's ladder is written in *cycles*: retry at 1, escalate to Opus at 2, to Fable at 3, block at
 * 5. A cycle was silently defined as "one Stop-hook firing", and Stop fires whenever the director
 * yields the turn. In the second full run the director yielded five times in **83 seconds** while
 * two implementers were mid-flight, walked the whole ladder, and blocked a run that was working:
 * a successful work-package report landed 35 seconds after the impasse was declared. Nothing in
 * the signature *can* change while an implementer runs, so the count measured how often the
 * director paused, not whether the run was stuck.
 *
 * The gate restores the unit. Five consecutive stalls now take at least five minutes, which is
 * longer than any work package in either measured run, and an actually wedged phase still reaches
 * the same verdict — a little later, and correctly.
 *
 * Rejected alternative: folding the newest subagent-transcript mtime into `progressSignature`, so
 * "a subagent is writing" counts as progress. It reads better and is worse — a subagent spinning
 * forever would keep the signature moving and the detector would never fire, and it makes the
 * signature depend on *when* the hook happens to run. That is the defect being fixed, wearing a
 * second clock.
 */
export function recordStall(projectRoot, runId, signature, { minIntervalMs = 0 } = {}) {
  return mutateState(projectRoot, runId, (state) => {
    if (state.stall.signature !== signature) {
      state.stall = { signature, count: 0, lastAt: nowIso() };
      return state.stall.count;
    }
    const since = state.stall.lastAt ? Date.now() - Date.parse(state.stall.lastAt) : Infinity;
    // Too soon to count again: leave `lastAt` alone, or the clock resets on every observation and
    // the gate never opens.
    if (since < minIntervalMs) return state.stall.count;
    state.stall.count += 1;
    state.stall.lastAt = nowIso();
    return state.stall.count;
  });
}
