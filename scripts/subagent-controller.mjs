#!/usr/bin/env node
/**
 * `SubagentStop` hook — the autonomy loop, now that the director is a subagent.
 *
 * The loop used to live on `Stop`. It could not stay there: blocking `Stop` re-drives the **main
 * thread**, and the main thread no longer directs anything — it dispatches and relays (§S4). What
 * re-drives a subagent is a `SubagentStop` block (§R6, measured: `stop_hook_active` flips true and
 * the agent takes another turn), so that is where the phase machine belongs.
 *
 * Three things had to be got right, and the analysis that produced them was done against the
 * *old* architecture, where two of the three said "do not port". Under a subagent director they
 * invert, and the reason is the same in every case — this hook filters to the director:
 *
 *  - **Stall detection.** Sampling on every `SubagentStop` would count a healthy wave of ten
 *    implementers as ten "no progress" samples, because an implementer's process ends before its
 *    report lands on disk. Filtering to `agent_type === hyperpowers-director` removes the hazard
 *    entirely: the director stopping *is* the checkpoint, exactly as ending a turn used to be.
 *  - **Block counting.** `prompt_id` is **identical** across `Stop`, `SubagentStart` and
 *    `SubagentStop` (§R5). Counting on it here would increment the main thread's counter and
 *    suspend a healthy run because subagents finished. The counter is keyed on `agent_id`, which
 *    §R5 measured as stable and present on both events, and lives in `state.directorTurn` —
 *    a different field from `state.turn`, because they count two independent loops (8 blocks each,
 *    measured).
 *  - **Cost and tier observation.** `transcript_path` on this payload is still the **main**
 *    transcript (§R5), so the accounting is unchanged. This is a straight gain: `Stop` fired once
 *    in an 86-minute run (§O14), which is why the budget check had to be duplicated into every
 *    transition; this hook fires whenever the director pauses.
 *
 * Fails open. An internal error here must never wedge a run — the same direction as every hook
 * except the Git policy.
 */

import { runHook, emitBlock, emitAllowStop, projectRootFrom } from './lib/hookio.mjs';
import { activeRunId } from './lib/paths.mjs';
import {
  tryLoadState, mutateState, transition, checkGate,
  progressSignature, recordStall, pendingErrand, liveChildren,
} from './lib/state.mjs';
import { PHASES, nextAction, stopAllowed, isTerminal } from './lib/phases.mjs';
import { loadConfig, DIRECTOR_AGENT, bareAgentName, isDirectorMeta, softBlockCap } from './lib/config.mjs';
import { logEvent, summarise } from './lib/telemetry.mjs';
import { analyseTranscript, directorTier, subagentMeta } from './lib/transcript.mjs';
import { nowIso } from './lib/io.mjs';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? '${CLAUDE_PLUGIN_ROOT}';

/**
 * Let the director's turn end, and record that this loop is the one that decided.
 *
 * `yielded` exists so the main thread's Stop hook can tell "the director is working" from "the
 * director has genuinely stopped" without guessing. Every exit from this hook goes through here or
 * through `driveDirector`, so the flag cannot fall out of step with the decision it describes.
 *
 * The block count resets here, and here only, because that is what the harness does: it caps
 * *consecutive* blocks, so allowing a stop ends the series and starts the next one over (§D4, §R6).
 * Modelling the same thing the harness models is the whole point — a lifetime total for an agent
 * that may be resumed many times would yield earlier on every resumption.
 */
function yieldDirector(projectRoot, runId, message) {
  try {
    mutateState(projectRoot, runId, (s) => {
      s.directorTurn = { ...(s.directorTurn ?? { agentId: null }), blocks: 0, yielded: true };
    });
  } catch { /* the stop still has to be allowed */ }
  return emitAllowStop(message);
}

/** Send the director back into its turn. The main thread must stay out while that is true. */
function driveDirector(projectRoot, runId, message) {
  try {
    mutateState(projectRoot, runId, (s) => {
      s.directorTurn = { ...(s.directorTurn ?? { agentId: null, blocks: 0 }), yielded: false };
    });
  } catch { /* blocking is still the right call */ }
  return emitBlock(message);
}

/**
 * Count this block against the dispatch.
 *
 * **One counter, because the harness has one.** It honours 8 *consecutive* blocks from this hook
 * (§R6: 9 invocations, 8 honoured) and never asks which branch emitted them. Waiting and working
 * each had their own, both yielding at the soft cap, which permitted 2×softCap — measured at 12
 * against a ceiling of 8 by alternating the two things a healthy director does: dispatch, wait for
 * the child, dispatch again. The blocks past the line are dropped, `yielded` is still false because
 * the last decision was a block, and the main thread's Stop hook then allows. The run goes idle
 * without a word: §S2's defect, reached through the branch written to prevent it.
 *
 * What waiting is exempt from is the **stall** budget — run 6 reached 3 of the 5 samples that move a
 * healthy run to `BLOCKED` by polling a working coordinator. It stays exempt, because that branch
 * returns before `recordStall`. Cheap and free are different claims, and only one of them was ever
 * true.
 *
 * Keyed on `agent_id`, never `prompt_id`: the latter is shared with the main thread (§R5), so
 * counting on it would suspend a healthy run because a subagent finished.
 */
function countBlock(projectRoot, runId, agentId) {
  return mutateState(projectRoot, runId, (s) => {
    const cur = s.directorTurn ?? { agentId: null, blocks: 0 };
    s.directorTurn = cur.agentId === agentId
      ? { ...cur, blocks: (cur.blocks ?? 0) + 1 }
      : { agentId, blocks: 1 };
    return s.directorTurn.blocks;
  });
}

function renderNext(phase, runId) {
  return nextAction(phase)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => PLUGIN_ROOT)
    .replaceAll('<RUN_ID>', () => runId);
}

function blockMessage({ state, runId, gate, stallCount, config }) {
  const spec = PHASES[state.phase];
  const lines = [
    `HYPERPOWERS — run ${runId} is not finished. Phase: ${state.phase} (owner: ${spec.owner}).`,
    '',
    `Goal of this phase: ${spec.summary}`,
    '',
    'Next action:',
    renderNext(state.phase, runId),
  ];

  if (gate && !gate.ok) {
    lines.push('', 'This phase cannot be exited yet. Unmet exit requirements:',
      ...gate.failures.map((f) => `  - ${f}`));
  }

  if (stallCount >= config.stop.stallRetryAt) {
    lines.push('', stallGuidance(stallCount, config));
  }

  lines.push(
    '',
    'Rules that still apply: you cannot reach the user — return a question packet and stop, never '
      + 'guess. Git is read-only. Record every transition through '
      + `\`node "${PLUGIN_ROOT}/scripts/state-machine.mjs" transition --run ${runId} --to <PHASE>\`. `
      + 'If this phase is genuinely impossible, transition to BLOCKED with a reason rather than '
      + 'stopping silently.',
  );
  return lines.join('\n');
}

/**
 * What to say to a director whose delegate is still running.
 *
 * The mechanism above takes waiting out of the stall budget. This makes it *cheap*: run 6's director
 * spent twelve separate Fable turns saying "coordinator active, watcher armed, yielding" — each one a
 * full turn re-reading its context, which is where two thirds of the bill goes (§P8). One turn that
 * waits beats twelve that check. The instruction is deliberately concrete, because "wait" on its own
 * is what produced the polling.
 */
function waitMessage(waiting, state, runId) {
  const who = waiting.map((c) => `\`${c.agentId}\` (${bareAgentName(c.meta?.agentType)})`).join(', ');
  return [
    `HYPERPOWERS — run ${runId}: you are still waiting on ${waiting.length === 1 ? 'a delegate' : 'delegates'}.`,
    '',
    `Running now: ${who}.`,
    '',
    'Waiting is not being stuck: it does not feed the stall detector, so let the work take the time '
      + 'it takes. It does spend one of this dispatch\'s continuations, because the harness counts '
      + 'every one of them — so wait in few long turns, not many short ones. Do **not** '
      + 'duplicate-dispatch, and do not take the work back.',
    '',
    'Wait inside *this* turn in **bounded** stretches — twenty to thirty minutes, then stop once so '
      + 'the loop can take a sample. An unbounded wait is invisible: a dead delegate\'s registry '
      + 'entry expires only when you next stop, so a turn that never ends waits on it forever — a '
      + 'real run spent six hours exactly there. One long bounded wait beats twelve short checks '
      + '(each is a full context re-read at director rates), and beats one endless one.',
    '',
    `Phase ${state.phase} is unchanged and nothing is wrong.`,
  ].join('\n');
}

function stallGuidance(count, config) {
  // Spec §16.3's top rung was "escalate to Fable". The director *is* Fable now, so the escalation
  // is no longer a hand-off — it is the director stopping delegating and deciding itself.
  if (count >= config.stop.stallEscalateFableAt) {
    return `No progress detected across ${count} consecutive continuations. Escalate to your own `
      + `judgement: stop delegating, re-read the request and the design, decide whether the approach `
      + `is wrong, and either redirect the phase or transition to BLOCKED with a precise reason. Do `
      + `not repeat the previous attempt.`;
  }
  if (count >= config.stop.stallEscalateOpusAt) {
    return `No progress detected across ${count} consecutive continuations. Escalate to Opus at `
      + `xhigh effort with an explicit diagnostic brief: what was attempted, what was observed, and `
      + `which hypothesis is being tested next (spec §16.3).`;
  }
  return `No progress detected since the previous continuation. Retry the current work package with `
    + `a different approach — repeating the same attempt is not progress. State exactly what you `
    + `will do differently.`;
}

await runHook(
  'subagent-controller',
  async (input) => {
    const projectRoot = projectRootFrom(input);
    const runId = input.session_id ? activeRunId(projectRoot, input.session_id) : null;
    if (!runId) return emitAllowStop();

    const state = tryLoadState(projectRoot, runId);
    if (!state) return emitAllowStop();

    // --- the live-subagent registry (§T1) ----------------------------------------
    // Written for **every** agent and before any filter, because the question it answers is asked
    // about somebody else: "does the director still have a delegate running?". Only membership and a
    // timestamp are stored: parentage *and* agent type are resolved from the meta files at read time,
    // since `SubagentStart` carries no `parentAgentId` (measured, §T1). An `agent_type` copy lived here
    // and nothing ever read it — `liveChildren` and the wait message both use the meta — which is a
    // field that can only go stale, in a file whose recurring defect is exactly that.
    if (input.agent_id) {
      const starting = input.hook_event_name === 'SubagentStart';
      try {
        mutateState(projectRoot, runId, (s) => {
          s.children ??= {};
          if (starting) s.children[input.agent_id] = { at: nowIso() };
          else delete s.children[input.agent_id];
        });
      } catch { /* a registry miss must never wedge a subagent; it re-drives as it always did */ }
    }

    // Anything that is not the director is somebody else's business — and treating a returning
    // implementer as a director checkpoint is precisely the defect this filter prevents (§L3,
    // inverted). Its start and stop are still in the registry above, which is the point.
    if (bareAgentName(input.agent_type) !== DIRECTOR_AGENT) return emitAllowStop();

    // Name is not enough: the director is the one at **depth 1**.
    //
    // Measured on a live run — an adjudicator at depth 2 dispatched a second `hyperpowers-director`
    // at depth 3. It reported as the director to this hook, which counted its blocks and wrote its
    // id into `directorTurn`, so the Stop hook then told the main thread to resume *it*: an agent
    // that cannot dispatch anything (the harness refuses at depth 3) and holds none of the run's
    // context. 3 of 23 recorded `agentId` events belonged to that impostor, and the id flip-flopped
    // between the two for the rest of the run. `git-policy.mjs` now refuses to let such an agent be
    // dispatched at all; this stays as the detection half of that pair (ADR 0003's shape).
    //
    // `spawnDepth` is not in the payload (§R5) but it is in the meta file the harness writes beside
    // the transcript, live (§S4 T28) — which is what `subagentMeta` reads.
    //
    // The predicate itself lives in `config.mjs` as `isDirectorMeta`, because `statusline.mjs` asks
    // the same question for the same reason — whose row carries the run's bar, and whose dispatch
    // tree the roster walks — and §U's defect class is a rule implemented in some of the places it
    // names. What stays here is the *fallback*: an unreadable meta is no evidence against an agent
    // the payload already named as the director, so it is allowed through.
    if (input.transcript_path && input.agent_id) {
      const meta = subagentMeta(input.transcript_path, input.agent_id);
      if (meta && !isDirectorMeta(meta)) return emitAllowStop();
    }

    // Record which agent is the director — here, where every branch below passes.
    //
    // This is the *only* write of `agentId`, and it has to be, because the branches below do not all
    // count blocks: the parked-errand path and the stop-allowed path yield without counting, and
    // `countBlock` used to be the sole writer. Run 9's BRAINSTORMING parks a question by design, so a run
    // whose first stop is a park never recorded its director at all — and the relay then told the main
    // thread to dispatch a cold one instead of resuming this one, which is §T2's cost driver (§S40).
    //
    // A `SubagentStart` reaching here is a *re-dispatch*: the first one cannot, because
    // `/hyperpowers:feature` dispatches the director and the director creates the run, so this hook
    // returned at `if (!runId)` above. That is why `directorIsDriving()` also reads the meta files —
    // state is late by construction, and the gap is the whole of phase one.
    const starting = input.hook_event_name === 'SubagentStart';
    if (input.agent_id) {
      try {
        mutateState(projectRoot, runId, (s) => {
          const cur = s.directorTurn ?? {};
          // A fresh dispatch starts a fresh harness block series; a stop keeps the count it has
          // earned. Either way a director is demonstrably at the wheel, so the Stop controller's
          // `replaceable` marker — "the last one may be gone, a replacement is legitimate" — is
          // consumed here: leaving it set would let a second director be dispatched beside a
          // living one, which is run 6's defect with a new door.
          s.directorTurn = cur.agentId === input.agent_id && !starting
            ? { ...cur, agentId: input.agent_id, replaceable: false }
            : { agentId: input.agent_id, blocks: 0, yielded: false };
        });
      } catch { /* an unrecorded id must never wedge a subagent */ }
    }
    if (starting) return emitAllowStop();

    const config = loadConfig(projectRoot);

    // --- observe what actually ran (ledger A3, §S4) -------------------------------
    try {
      const tier = directorTier(state);
      const usage = input.transcript_path
        ? analyseTranscript(input.transcript_path, { since: state.createdAt })
        : null;
      mutateState(projectRoot, runId, (s) => {
        // The payload's `effort` is this subagent's own (§Q16 T29) — and this subagent is the
        // director, so here, and only here, it is the director's effort.
        if (input.effort?.level ?? input.effort) s.observedEffort = input.effort?.level ?? input.effort;
        if (tier.observed) s.observedDirectorModel = tier.observed;
        if (usage?.available) s.observedUsage = { totals: usage.totals, shares: usage.shares, byFamily: usage.byFamily };
      });
      if (tier.ok === false && !state.directorMismatchReported) {
        mutateState(projectRoot, runId, (s) => { s.directorMismatchReported = true; });
        logEvent(projectRoot, runId, {
          type: 'model_mismatch', expected: tier.expected, observed: tier.observed,
          note: 'The director subagent is not running the configured model.',
        });
      }
    } catch { /* observation must never break the loop */ }

    // --- park (§S6) ---------------------------------------------------------------
    // The one place this hook must *not* re-drive the director. It has written a question and
    // stopped; blocking here would send it straight back into its own turn and the question would
    // never reach the main thread, which is the only process that can render one (§R1).
    const parked = pendingErrand(projectRoot, runId);
    if (parked) {
      logEvent(projectRoot, runId, {
        type: parked.kind === 'publish' ? 'publish_parked' : 'question_parked',
        phase: state.phase,
        count: parked.kind === 'publish' ? 1 : parked.questions.length,
      });
      // Both errands end the same way, in the same words as the Stop controller: resume the
      // director by id when one is recorded — a fresh dispatch works but starts cold, and cold
      // restarts are the measured cost driver (§T2). Two surfaces saying "re-dispatch" while a
      // third said "resume by id" made the cheapest instruction the least likely to be followed.
      const resume = state.directorTurn?.agentId
        ? `then resume the director — SendMessage → \`${state.directorTurn.agentId}\` (a fresh `
          + `\`Agent\` dispatch works but starts cold).`
        : 'then re-dispatch the director.';
      return yieldDirector(projectRoot, runId, parked.kind === 'publish'
        ? `Hyperpowers run ${runId} needs the main thread to publish \`${parked.title}\`. Publish `
          + `${parked.file} with the Artifact tool, record the URL with \`state-machine.mjs published `
          + `--run ${runId} --url <url>\`, ${resume}`
        : `Hyperpowers run ${runId} is waiting on ${parked.questions.length} question(s) from phase `
          + `${parked.phase}. Render them with AskUserQuestion, record the reply with `
          + `\`state-machine.mjs answer --run ${runId} --json '["…"]'\`, ${resume}`);
    }

    if (stopAllowed(state.phase)) {
      const summary = isTerminal(state.phase) ? summarise(projectRoot, runId) : null;
      return yieldDirector(projectRoot, runId,
        summary
          ? `Hyperpowers run ${runId} ended in ${state.phase}. ${summary.workPackages} work `
            + `packages, ${summary.codexRounds} Codex rounds. Run \`/hyperpowers:status\` for the `
            + `full breakdown.`
          : `Hyperpowers run ${runId} is suspended and resumable. Run \`/hyperpowers:resume\`.`,
      );
    }

    // --- the director is waiting on a delegate, which is not the same as being stuck ------
    //
    // Run 6, the defect this exists for: an `opus-plan-coordinator` legitimately took 26 minutes,
    // and after an API error cut the director's *synchronous* dispatch there was no way back into a
    // blocking wait — `SendMessage` is async — so the director could only poll. Every poll is a
    // stop. **12 of that run's 20 continuations landed in one 4-minute window**, each burning a
    // continuation and feeding the stall detector, which reached 3 of the 5 that would have moved a
    // perfectly healthy run to `BLOCKED` while telling the director to "stop delegating".
    //
    // A synchronous dispatch never reaches here at all — the director does not stop while inside
    // one, measured: zero continuations across the design coordinator's nine minutes. So this
    // branch is exactly the polling case and nothing else.
    //
    // It still **blocks**, deliberately. Allowing the stop would idle the director with nothing to
    // wake it: the main thread is notified about its own background dispatch, not about a grandchild
    // the director launched. What changes is that waiting no longer feeds the **stall detector** —
    // run 6 reached 3 of the 5 samples that move a healthy run to `BLOCKED` by polling a coordinator
    // that was working — so the run can wait as long as the work honestly takes. This branch returns
    // before `recordStall`, and that is where the exemption lives. The bound against a leaked
    // registry entry is `CHILD_STALE_MS`, not a counter.
    //
    // It is *not* exempt from the block count, and giving it its own counter was a defect: see
    // `countBlock`. A long wait therefore yields resumably at the soft cap like any other long
    // dispatch, which also restarts the harness's consecutive series.
    const agentId = input.agent_id ?? null;
    const waiting = liveChildren(state, input.transcript_path, input.agent_id);
    if (waiting.length) {
      const blocks = countBlock(projectRoot, runId, agentId);
      logEvent(projectRoot, runId, {
        type: 'awaiting_delegate', phase: state.phase, agentId, blocks,
        children: waiting.map((c) => bareAgentName(c.meta?.agentType)),
      });

      if (blocks >= softBlockCap(config)) {
        return yieldDirector(projectRoot, runId,
          `Hyperpowers: the director is waiting on ${waiting.map((c) => c.agentId).join(', ')} and is `
            + `yielding this dispatch before the harness cap rather than blocking past it. Run ${runId} `
            + `is still live in ${state.phase} and nothing has gone wrong — resume agent `
            + `\`${agentId}\` so it keeps its context and its wait.`);
      }
      return driveDirector(projectRoot, runId, waitMessage(waiting, state, runId));
    }

    // --- yield below the harness block cap ---------------------------------------
    const blocks = countBlock(projectRoot, runId, agentId);

    // A dispatch running out of blocks is **not** a run running out of road, and conflating the two
    // is what a live run caught. This used to open `SUSPENDED`, which is in `STOP_ALLOWED_PHASES` —
    // so the main thread's own Stop hook then saw a stoppable phase and returned immediately,
    // never reaching its re-dispatch branch. Measured on that run: `directorTurn.blocks = 6`
    // (saturated) against `turn.blocks = 0` (never incremented) and zero `redispatch_required`
    // events. The run only survived because the main thread improvised a resume of its own.
    //
    // So this yields the *dispatch* and says so. The run stays in its phase, the main thread's Stop
    // hook finds a live run with no director attached, and re-dispatching is its job. `SUSPENDED`
    // now means only what it should: the **main thread** is out of blocks, which is the one case
    // where a human really is the next step.
    if (blocks >= softBlockCap(config)) {
      logEvent(projectRoot, runId, { type: 'dispatch_exhausted', blocks, cap: config.stop.blockCap, agentId, phase: state.phase });
      return yieldDirector(projectRoot, runId,
        `Hyperpowers: the director has used ${blocks} of this dispatch's continuations and is `
          + `yielding before the harness cap. Run ${runId} is still live in ${state.phase} — resume `
          + `agent \`${agentId}\` so it keeps its context, rather than dispatching a fresh one.`,
      );
    }

    // --- progress detection (spec §16.3) -----------------------------------------
    const signature = progressSignature(projectRoot, runId, state);
    const stallCount = recordStall(projectRoot, runId, signature, {
      minIntervalMs: config.stop.stallMinIntervalMs,
    });
    if (stallCount >= config.stop.stallBlockAt) {
      transition(projectRoot, runId, 'BLOCKED', {
        actor: 'system',
        reason: `No progress across ${stallCount} consecutive director continuations in phase ${state.phase}`,
      });
      logEvent(projectRoot, runId, { type: 'stall_blocked', phase: state.phase, stallCount });
      return yieldDirector(projectRoot, runId,
        `Hyperpowers blocked run ${runId}: phase ${state.phase} made no measurable progress across `
          + `${stallCount} director continuations. This is a real impasse, not a timeout — see `
          + `\`/hyperpowers:status\`. BLOCKED is terminal: the artefacts stay on disk.`,
      );
    }

    const gate = checkGate(projectRoot, runId, state);
    logEvent(projectRoot, runId, {
      type: 'continuation', phase: state.phase, blocks, stallCount, gateOk: gate.ok, agentId,
    });

    driveDirector(projectRoot, runId, blockMessage({ state, runId, gate, stallCount, config }));
  },
  () => emitAllowStop(),
  // One script now serves both `SubagentStart` and `SubagentStop`, so `hooks/hooks.json` declares
  // **30 s for both**. A budget above the smaller declared timeout would let the harness kill the
  // process before `onError` runs, and a fail-open hook that never reaches its own failure path is
  // not fail-open. Change one and change the other.
  { budgetMs: 20_000 },
);
