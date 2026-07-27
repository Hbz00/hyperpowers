#!/usr/bin/env node
/**
 * Stop hook — the autonomy loop (spec §16).
 *
 * Replaces `/goal`. On every attempt to end the turn it reads the run's persisted state and
 * either allows the stop or blocks it with the next action, computed from the phase table
 * rather than from anything the model said.
 *
 * Two measured behaviours shape this design:
 *
 *  - A blocked Stop continues the *same* turn, which preserves the Fable model pin
 *    (ledger B2). The whole feature therefore runs in one turn.
 *  - Consecutive blocks are capped by the harness (ledger D4). The controller yields a few
 *    blocks early into `SUSPENDED` so a run ends resumable instead of truncated.
 *
 * It also enforces spec §16.3: raising the cap is not enough, the machine must prove progress
 * between continuations. A run that keeps stopping without changing its state signature is
 * escalated and finally blocked.
 */

import fs from 'node:fs';
import { runHook, emitBlock, emitAllowStop, projectRootFrom } from './lib/hookio.mjs';
import { activeRunId, artifacts } from './lib/paths.mjs';
import {
  loadState, tryLoadState, mutateState, transition, checkGate,
  progressSignature, recordStall,
} from './lib/state.mjs';
import { PHASES, nextAction, stopAllowed, isTerminal } from './lib/phases.mjs';
import { loadConfig, budgetOverrun } from './lib/config.mjs';
import { logEvent, summarise } from './lib/telemetry.mjs';
import { analyseTranscript, currentMainThreadModel, familyOf } from './lib/transcript.mjs';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? '${CLAUDE_PLUGIN_ROOT}';

/**
 * Substituted through replacer functions, not strings.
 *
 * `String.replaceAll` honours `$$`, `$&`, `` $` `` and `$'` inside a string replacement, so a
 * plugin installed under a path containing one of those sequences — legal on every Unix — would
 * splice surrounding template text into the *command this instruction tells an agent to run*.
 * The same mistake corrupted a review pack in a live run (ledger §O8); a function replacement is
 * used verbatim and removes the class rather than this instance of it.
 */
function renderNext(phase, runId) {
  return nextAction(phase)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => PLUGIN_ROOT)
    .replaceAll('<RUN_ID>', () => runId);
}

function blockMessage({ state, runId, gate, stall, config }) {
  const phase = state.phase;
  const spec = PHASES[phase];
  const lines = [
    `HYPERPOWERS — run ${runId} is not finished. Phase: ${phase} (owner: ${spec.owner}).`,
    '',
    `Goal of this phase: ${spec.summary}`,
    '',
    'Next action:',
    renderNext(phase, runId),
  ];

  if (gate && !gate.ok) {
    lines.push(
      '',
      'This phase cannot be exited yet. Unmet exit requirements:',
      ...gate.failures.map((f) => `  - ${f}`),
    );
  }

  if (stall.count >= config.stop.stallRetryAt) {
    lines.push('', stallGuidance(stall, config));
  }

  lines.push(
    '',
    'Rules that still apply: no user validation may be requested; Git is read-only; no ' +
      'commits, branches or worktrees; record every transition through ' +
      `\`node "${PLUGIN_ROOT}/scripts/state-machine.mjs" transition --run ${runId} --to <PHASE>\`. ` +
      'If this phase is genuinely impossible, transition to BLOCKED with a reason rather than ' +
      'stopping silently.',
    '',
    // The escape hatch has to be visible at the moment someone wants it: this hook blocks every
    // attempt to end the turn, so a user who wants out needs to see the way out here.
    `To stop this run: \`node "${PLUGIN_ROOT}/scripts/state-machine.mjs" abort --run ${runId} --reason "<why>"\` ` +
      '(or tell the user to run `/hyperpowers:abort`). Nothing is reverted — Hyperpowers never ' +
      'mutated the repository — and the artefacts stay on disk.',
  );
  return lines.join('\n');
}

function stallGuidance(stall, config) {
  const { count } = stall;
  if (count >= config.stop.stallEscalateFableAt) {
    return (
      `No progress detected across ${count} consecutive continuations. Escalate to Fable: ` +
      `re-read the request and the design, decide whether the current approach is wrong, and ` +
      `either redirect the phase or transition to BLOCKED with a precise reason. Do not repeat ` +
      `the previous attempt.`
    );
  }
  if (count >= config.stop.stallEscalateOpusAt) {
    return (
      `No progress detected across ${count} consecutive continuations. Escalate to Opus at ` +
      `xhigh effort with an explicit diagnostic brief: what was attempted, what was observed, ` +
      `and which hypothesis is being tested next (spec §16.3).`
    );
  }
  return (
    `No progress detected since the previous continuation. Retry the current work package ` +
    `with a different approach — repeating the same attempt is not progress. State exactly ` +
    `what you will do differently.`
  );
}

await runHook(
  'stop-controller',
  async (input) => {
    const projectRoot = projectRootFrom(input);
    const sessionId = input.session_id;
    const runId = sessionId ? activeRunId(projectRoot, sessionId) : null;

    // No Hyperpowers run bound to this session: stay out of the way entirely.
    if (!runId) return emitAllowStop();

    const state = tryLoadState(projectRoot, runId);
    if (!state) {
      // "No state" and "unreadable state" are different facts and must not look alike. A run
      // whose state.json is corrupt or on an unsupported schema silently stopped being governed:
      // the hook emitted the same empty payload it uses when no run exists, so the loop
      // disengaged with nothing said to anyone.
      const present = fs.existsSync(artifacts(projectRoot, runId).state);
      return emitAllowStop(
        present
          ? `Hyperpowers run ${runId} has an unreadable state.json, so its autonomy loop is not ` +
            `running. Nothing is governing this session. Inspect it with \`/hyperpowers:status\`, ` +
            `or start a new run — the artefacts of the old one remain on disk.`
          : undefined,
      );
    }

    const config = loadConfig(projectRoot);

    // --- observe what actually ran, rather than what was requested (ledger A3) ------
    // The payload carries the effort in force; its absence means the model has no effort
    // support at all. The transcript carries the model and real token usage, including
    // subagents. Together these make the pyramid self-auditing instead of self-reported.
    try {
      const observedModel = input.transcript_path ? currentMainThreadModel(input.transcript_path) : null;
      const usage = input.transcript_path
        ? analyseTranscript(input.transcript_path, {
            since: state.createdAt,
            cacheDir: artifacts(projectRoot, runId).base,
          })
        : null;
      const expected = state.config?.models?.director ?? 'fable';
      const actualFamily = observedModel ? familyOf(observedModel) : null;

      mutateState(projectRoot, runId, (s) => {
        if (input.effort?.level) s.observedEffort = input.effort.level;
        if (observedModel) s.observedDirectorModel = observedModel;
        if (usage?.available) s.observedUsage = { totals: usage.totals, shares: usage.shares, byFamily: usage.byFamily };
      });

      // A demoted director is a real defect, not a curiosity: the whole architecture assumes
      // product authority sits with the strongest model.
      if (actualFamily && actualFamily !== expected && !state.directorMismatchReported) {
        mutateState(projectRoot, runId, (s) => { s.directorMismatchReported = true; });
        logEvent(projectRoot, runId, {
          type: 'model_mismatch', expected, observed: observedModel,
          note: 'Main thread is not running the configured director model.',
        });
      }
    } catch {
      /* observation must never break the loop */
    }

    if (stopAllowed(state.phase)) {
      const summary = isTerminal(state.phase) ? summarise(projectRoot, runId) : null;
      return emitAllowStop(
        summary
          ? `Hyperpowers run ${runId} ended in ${state.phase}. ` +
            `${summary.workPackages} work packages, ${summary.codexRounds} Codex rounds, ` +
            `estimated $${summary.totals.costUsd.toFixed(2)}. Report: ${projectRoot ? '' : ''}` +
            `run \`/hyperpowers:status\` for the full breakdown.`
          : `Hyperpowers run ${runId} is suspended and resumable. Run \`/hyperpowers:resume\`.`,
      );
    }

    // --- budget bounds (spec §18) ------------------------------------------------
    // Cost comes from the transcript, not from event bookkeeping. The event path never had a
    // producer — no `usage` event is emitted anywhere — so `maxCostUsd` was structurally unable
    // to fire, and so were the two counter bounds. A budget nobody can exceed is not a budget.
    const elapsed = Date.now() - new Date(state.createdAt).getTime();
    const fresh = tryLoadState(projectRoot, runId) ?? state;
    const measuredCost = fresh.observedUsage?.totals?.costUsd ?? summarise(projectRoot, runId).totals.costUsd;
    const counters = fresh.counters ?? {};
    // Shared with `state-machine.mjs transition`, because this hook alone is not enough: it ran
    // exactly once in an 86-minute run, across nineteen transitions that never asked (§O14).
    const overrun = budgetOverrun({ config, state: fresh, elapsedMs: elapsed, measuredCost });
    if (overrun) {
      transition(projectRoot, runId, 'BUDGET_EXCEEDED', {
        actor: 'system',
        reason: `Bound ${overrun} exceeded`,
        note:
          `elapsed=${Math.round(elapsed / 1000)}s cost=$${measuredCost.toFixed(2)} ` +
          `wp=${counters.workPackages ?? 0} subagents=${counters.subagentsCompleted ?? 0} ` +
          `fallbacks=${counters.fallbacks ?? 0}`,
      });
      return emitAllowStop(
        `Hyperpowers stopped run ${runId}: the configured bound \`${overrun}\` was exceeded. ` +
          `Raise it in .hyperpowers.json and \`/hyperpowers:resume\`, or inspect the run with ` +
          `\`/hyperpowers:status\`.`,
      );
    }

    // --- yield below the harness block cap ---------------------------------------
    const promptId = input.prompt_id ?? null;
    const blocks = mutateState(projectRoot, runId, (s) => {
      if (s.turn.promptId !== promptId) s.turn = { promptId, blocks: 0 };
      s.turn.blocks += 1;
      return s.turn.blocks;
    });

    const softCap = Math.max(1, config.stop.blockCap - config.stop.softCapMargin);
    if (blocks >= softCap) {
      transition(projectRoot, runId, 'SUSPENDED', {
        actor: 'system',
        note: `yielded at ${blocks} continuations (cap ${config.stop.blockCap})`,
      });
      logEvent(projectRoot, runId, { type: 'suspended', blocks, cap: config.stop.blockCap });
      return emitAllowStop(
        `Hyperpowers suspended run ${runId} after ${blocks} continuations, just below this ` +
          `session's Stop-hook cap, so the run stays resumable. Phase ${state.phase} is ` +
          `preserved. Run \`/hyperpowers:resume\` to continue.`,
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
        reason: `No progress across ${stallCount} consecutive continuations in phase ${state.phase}`,
      });
      logEvent(projectRoot, runId, { type: 'stall_blocked', phase: state.phase, stallCount });
      const spanMin = Math.round((config.stop.stallMinIntervalMs * stallCount) / 60000);
      return emitAllowStop(
        `Hyperpowers blocked run ${runId}: phase ${state.phase} made no measurable progress ` +
          `across ${stallCount} continuations${spanMin > 0 ? `, spanning at least ${spanMin} minutes` : ''}. ` +
          `This is a real impasse, not a timeout — see \`/hyperpowers:status\` for the last state ` +
          `and evidence. BLOCKED is terminal: the artefacts stay on disk, but this run cannot be ` +
          `resumed. Do not keep working around it — report what is blocking and stop.`,
      );
    }

    const gate = checkGate(projectRoot, runId, state);
    logEvent(projectRoot, runId, {
      type: 'continuation',
      phase: state.phase,
      blocks,
      stallCount,
      gateOk: gate.ok,
    });

    // Spec §6.2 wants escalation rates measured, not just enacted. The ladder already decides
    // who takes over; recording the step is what makes the rate observable afterwards.
    if (stallCount === config.stop.stallEscalateOpusAt || stallCount === config.stop.stallEscalateFableAt) {
      logEvent(projectRoot, runId, {
        type: 'stall_escalation',
        phase: state.phase,
        from: stallCount === config.stop.stallEscalateOpusAt ? 'sonnet' : 'opus',
        to: stallCount === config.stop.stallEscalateOpusAt ? 'opus' : 'fable',
        stallCount,
      });
    }

    emitBlock(blockMessage({ state, runId, gate, stall: { count: stallCount }, config }));
  },
  () => {
    // Advisory failure direction: a controller bug must never make a session unstoppable.
    emitAllowStop(
      'Hyperpowers stop-controller failed and allowed the turn to end. Run `/hyperpowers:status` ' +
        'to inspect the run, then `/hyperpowers:resume`.',
    );
  },
  { budgetMs: 25_000 }, // Stop is declared at 30 s in hooks.json
);
