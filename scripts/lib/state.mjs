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
import { readJson, writeJson, withLock, nowIso, sha256, ensureDir } from './io.mjs';
import { artifacts, runDir, PLUGIN_ROOT } from './paths.mjs';
import { validate } from './validate.mjs';
import { PHASES, canTransition, isKnownPhase, isTerminal } from './phases.mjs';
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
    blocked: null,
  };
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

  // A gate requirement reads the verdict `verify-completion.mjs` *stored*, not a fresh
  // evaluation — the verifier is the only writer, so this cannot be forged, but it is a
  // snapshot. Evidence that arrives between the verifier running and the transition (a git
  // mutation detected by the PostToolUse guard, say) is not reflected until the gate is re-run.
  // Re-running it before transitioning is cheap and is what the phase instructions tell the
  // director to do.
  if (requirement.startsWith('gate:')) {
    const gate = requirement.slice('gate:'.length);
    const record = state.gates?.[gate];
    if (!record) return { ok: false, detail: `gate ${gate} not evaluated` };
    if (!record.passed) return { ok: false, detail: `gate ${gate} failed: ${record.reason ?? 'unknown'}` };
    return { ok: true, detail: `gate ${gate} passed at ${record.at} (stored verdict; re-run the verifier if the run has changed since)` };
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
    // Terminal phases skip the exit gate so a failing run can always reach BLOCKED, ABORTED,
    // BUDGET_EXCEEDED or POLICY_VIOLATION — a machine you cannot stop is worse than one you
    // cannot finish. `COMPLETE` is the exception: it is terminal, but it is also the *success*
    // claim, and its exit requirements (`gate:completion`, `finalReport`) are the entire
    // mechanical content of spec §13. Exempting it made all fourteen conditions advisory at the
    // one moment they decide anything — a run could declare success with nothing proven. Success
    // is the one terminal state that must be earned.
    const skipGate = meta.force === true || to === 'SUSPENDED' || (isTerminal(to) && to !== 'COMPLETE');
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

export function runExists(projectRoot, runId) {
  try {
    return fs.statSync(runDir(projectRoot, runId)).isDirectory();
  } catch {
    return false;
  }
}
