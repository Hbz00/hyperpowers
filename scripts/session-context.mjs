#!/usr/bin/env node
/**
 * SessionStart context injection — survival across context loss (spec §23 Risk 7).
 *
 * Anthropic's own guidance is that compaction alone is insufficient for long-running agents:
 * durable artefacts and incremental tasks are what let a fresh context resume. Hyperpowers
 * keeps everything durable on disk, and this hook is the bridge that tells a newly-started or
 * just-compacted context that the disk state exists and where to look.
 *
 * SessionStart is the whole mechanism, deliberately. This was also registered on `PreCompact`,
 * which cannot inject context at all — that event only decides whether compaction proceeds, so
 * the "persist before you lose this" reminder was written into a channel nothing reads. The
 * *post*-compaction moment is what matters anyway, and SessionStart fires there (source
 * `compact`) with the same empty matcher used here.
 *
 * It reports; it never adopts. A session becomes responsible for a run only through
 * `/hyperpowers:resume`, which is the one place that can also re-pin the director's model.
 */

import { runHook, emitContext, emitAllowStop, projectRootFrom } from './lib/hookio.mjs';
import { listRuns, activeRunId, artifacts, markDataRootAuthoritative } from './lib/paths.mjs';
import { tryLoadState } from './lib/state.mjs';
import { PHASES, isTerminal } from './lib/phases.mjs';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? '${CLAUDE_PLUGIN_ROOT}';

await runHook(
  'session-context',
  async (input) => {
    const projectRoot = projectRootFrom(input);
    const sessionId = input.session_id;

    // A hook subprocess is the one context where the harness sets `CLAUDE_PLUGIN_DATA` itself,
    // so this is the only place that can say authoritatively where run data belongs. Stamping it
    // lets `preflight` prove the CLI half resolved the same directory instead of assuming so —
    // which is precisely what nobody could check while the two halves silently disagreed.
    markDataRootAuthoritative();

    let runId = sessionId ? activeRunId(projectRoot, sessionId) : null;
    let bound = Boolean(runId);

    // A restarted or unrelated session has a new id, and an unfinished run may be sitting on
    // disk. It is *mentioned* here, never adopted.
    //
    // Auto-binding was the original behaviour and it was hostile: a run interrupted mid-phase
    // (Escape, a crash, a closed terminal) captured the next session opened in that project —
    // any session, for any unrelated work — and the Stop controller then blocked every attempt
    // to end a turn until the user discovered `/hyperpowers:abort`. Adoption is a decision, so
    // it belongs to `/hyperpowers:resume`, which is also the only thing that can re-establish
    // the director's model pin (ADR-0001).
    if (!runId) {
      runId = listRuns(projectRoot).find((candidate) => {
        const state = tryLoadState(projectRoot, candidate);
        return state && !isTerminal(state.phase);
      }) ?? null;
    }

    if (!runId) return emitAllowStop();

    const state = tryLoadState(projectRoot, runId);
    if (!state) return emitAllowStop();

    if (!bound && !isTerminal(state.phase)) {
      return emitContext(
        'SessionStart',
        `HYPERPOWERS — this project has an unfinished run that is NOT attached to this session.\n\n` +
          `Run: ${runId}\nPhase: ${state.phase}${state.phase === 'SUSPENDED' ? ' (suspended cleanly)' : ' (interrupted)'}\n` +
          `Last updated: ${state.updatedAt}\n\n` +
          `Nothing in this session is governed by it: Git works normally and turns end normally. ` +
          `Mention it to the user only if it is relevant to what they are doing, and let them choose:\n` +
          `  /hyperpowers:resume  — attach this session and continue the run\n` +
          `  /hyperpowers:abort   — end it; artefacts stay on disk\n` +
          `  /hyperpowers:status  — inspect it without touching it\n\n` +
          `Do not resume it on your own initiative.`,
      );
    }

    const a = artifacts(projectRoot, runId);
    const phase = PHASES[state.phase];

    if (isTerminal(state.phase)) {
      return emitContext(
        'SessionStart',
        `Hyperpowers run ${runId} for this project ended in ${state.phase}. ` +
          `Its report is at ${a.finalReport}. Run \`/hyperpowers:status\` for the full record, ` +
          `or \`/hyperpowers:feature\` to start a new one.`,
      );
    }

    const lines = [
      `HYPERPOWERS — an autonomous run is in progress for this project.`,
      ``,
      `Run: ${runId}`,
      `Phase: ${state.phase} (${phase?.owner ?? 'unknown'} owns it) — ${phase?.summary ?? ''}`,
      `Revision: ${state.revision}, last updated ${state.updatedAt}`,
      ``,
      `Everything this run needs is on disk, not in this conversation:`,
      `  state      ${a.state}`,
      `  request    ${a.request}`,
      `  design     ${a.design}`,
      `  plan       ${a.plan}`,
      `  tasks      ${a.tasks}`,
      `  evidence   ${a.evidence}`,
      `  reviews    ${a.reviewsDir}`,
      ``,
      state.phase === 'SUSPENDED'
        ? `This run is suspended and resumable. Run \`/hyperpowers:resume\` to continue it.`
        // Replacer functions, not strings — see `renderNext` in stop-controller.mjs and ledger §O8.
        : `Next action:\n${String(phase?.next ?? '').replaceAll('${CLAUDE_PLUGIN_ROOT}', () => PLUGIN_ROOT).replaceAll('<RUN_ID>', () => runId)}`,
    ];

    emitContext('SessionStart', lines.join('\n'));
  },
  () => emitAllowStop(),
  { budgetMs: 12_000 }, // SessionStart is declared at 15 s in hooks.json
);
