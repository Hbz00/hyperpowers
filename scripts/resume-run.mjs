#!/usr/bin/env node
/**
 * Rebind a run to the current session and return it to an active phase.
 *
 * A suspended run stopped cleanly below the Stop-hook block cap; its phase is intact and its
 * artefacts are on disk. Resuming is therefore a matter of re-establishing the session→run
 * pointer (the hooks' only way to find the run) and restoring the phase the run was in when it
 * yielded.
 */

import { parseArgs, fail, emitJson, resolveProjectRoot, requireSafeId } from './lib/cli.mjs';
import { bindSession, artifacts, activeRunId, listRuns } from './lib/paths.mjs';
import { loadState, tryLoadState, mutateState } from './lib/state.mjs';
import { PHASES, isTerminal } from './lib/phases.mjs';
import { logEvent } from './lib/telemetry.mjs';
import { stampFingerprint } from './lib/git-fingerprint.mjs';

const { flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const sessionId = requireSafeId('session', flags.session ?? process.env.CLAUDE_CODE_SESSION_ID);
if (!sessionId) fail('resume requires --session <id> (or CLAUDE_CODE_SESSION_ID in the environment).');

/**
 * Which run to resume.
 *
 * The generic resolver falls back to "newest run in this project", which is wrong here in two
 * ways. Newest is not the same as resumable: a fresh `PREFLIGHT` run started minutes ago
 * outranked the `SUSPENDED` run the user actually wants back. And it ignores ownership, so
 * resume would silently rebind a run another live session was already driving, leaving two
 * sessions convinced they own it. Resume prefers the newest *suspended* run, and refuses to
 * steal one that is bound elsewhere unless asked explicitly.
 */
const runId = (() => {
  // An explicit `--run` with no usable value is refused, never reinterpreted as "pick one".
  if (flags.run !== undefined) return requireSafeId('run', flags.run);
  const bound = activeRunId(projectRoot, sessionId);
  if (bound) return bound;
  const candidates = listRuns(projectRoot)
    .map((id) => ({ id, state: tryLoadState(projectRoot, id) }))
    .filter((c) => c.state && !isTerminal(c.state.phase));
  return (candidates.find((c) => c.state.phase === 'SUSPENDED') ?? candidates[0])?.id ?? null;
})();
if (!runId) fail(`No resumable Hyperpowers run found for ${projectRoot}.`);

const state = loadState(projectRoot, runId);

// A SUSPENDED run has already yielded its turn — nothing is driving it, so adopting it from a
// new session is the ordinary path, not a seizure. Any other non-terminal phase may still be
// mid-flight in the session that owns it, and two owners means the Stop controller governs turns
// in both.
if (state.phase !== 'SUSPENDED' && state.sessionId && state.sessionId !== sessionId && flags.force !== true) {
  fail(
    `Run ${runId} is in ${state.phase} and bound to session ${state.sessionId}, which may still ` +
      `be driving it. Resuming here would leave two sessions believing they own the same run.\n\n` +
      `If that session is gone, re-run with --force. To inspect without taking ownership, use ` +
      `\`/hyperpowers:status\`.`,
    9,
  );
}
if (isTerminal(state.phase)) {
  fail(
    `Run ${runId} already ended in ${state.phase}${state.blocked ? `: ${state.blocked}` : ''}.\n` +
      `A terminal run is not resumable. Start a new one with /hyperpowers:feature.`,
    8,
  );
}

// A suspended run resumes into the phase it was working on when it yielded — that is recorded
// as the `from` side of the SUSPENDED transition, so no information is invented here.
let target = state.phase;
if (state.phase === 'SUSPENDED') {
  const suspension = [...state.history].reverse().find((h) => h.to === 'SUSPENDED');
  target = suspension?.from;
  if (!target || !PHASES[target]) fail(`Cannot determine which phase run ${runId} was suspended from.`);
  mutateState(projectRoot, runId, (s) => {
    s.phase = target;
    // Both counters, because neither resets on its own: `turn` on a new `prompt_id`,
    // `directorTurn` on a new `agent_id`, and a resume changes neither. A run that suspended at its
    // soft cap and came back still over it yielded again on the next hook firing — observed live,
    // 90 seconds after a resume. `directorTurn` was missed on the day §S5 added it.
    //
    // It has to be here and not in `transition()`: `SUSPENDED.successors` is empty, so no legal
    // transition leaves it — this script is the only route out, and a guard in `transition()` would
    // be unreachable code guarding nothing.
    s.turn = { promptId: null, blocks: 0 };
    // Blocks, not identity: the id is how the main thread learns which agent to resume, and
    // clearing it left the Stop hook printing "(no director agent recorded yet)" — observed live,
    // after which the main thread launched a duplicate director before catching itself.
    // `yielded: true` because a resume *is* the hand-back: control sits with whoever ran this,
    // not with a director. It is also the release valve for the one-director rule — while a
    // director is driving, `git-policy.mjs` refuses to dispatch another, and resuming is the
    // documented way to say "the old one is gone, a fresh dispatch is legitimate".
    s.directorTurn = { agentId: s.directorTurn?.agentId ?? null, blocks: 0, yielded: true };
    s.stall = { signature: null, count: 0, lastAt: null };
    s.history.push({
      from: 'SUSPENDED', to: target, at: new Date().toISOString(), actor: 'system',
      artifact: null, evidence: null, cost: null, fallbacks: [], openProblems: [],
      note: 'resumed',
    });
  });
}

// A suspended run hands Git back to the user (`stopAllowed`), so the repository may legitimately
// have moved while it was stopped — that is the point of suspending. The stale fingerprint would
// read those commits as drift on the first Bash call after resuming and fail §13.11 for work the
// policy explicitly permitted. This used to *delete* the file, which deferred the new baseline to
// the first PostToolUse firing — and absorbed any mutation made by that same call, silently.
// Worse, the deletion was unconditional: a resume of a run that never released Git (any
// non-SUSPENDED phase) threw away a valid baseline for nothing, and the tag created before the
// next Bash call escaped detection — reproduced. Stamping a fresh fingerprint *now*, and only on
// the path where Git was actually released, keeps the rationale and closes both windows.
if (state.phase === 'SUSPENDED') stampFingerprint(projectRoot, artifacts(projectRoot, runId).base);

// The check above refuses to *steal* a run from a session that may still be driving it. This is
// the other half: once ownership legitimately moves, the previous owner must stop being one.
// `bindSession` enforces the exclusivity and reports whom it displaced.
const { displaced } = bindSession(projectRoot, sessionId, runId);
mutateState(projectRoot, runId, (s) => {
  const adopted = s.sessionId && s.sessionId !== sessionId;
  s.sessionId = sessionId;
  // Adopting a run from another session must also release the one-director rule. The previous
  // session's director — if one is even alive — can no longer be resumed from here, and its
  // recorded `agentId` with `yielded: false` would make `git-policy` deny the fresh dispatch this
  // resume exists to enable: the run is told to redispatch, obeys, and is refused — a wedge,
  // reproduced. Reaching this line with a different owner means the ownership check above was
  // satisfied (`--force`, or the phase was SUSPENDED), i.e. the user has already asserted the old
  // session is gone. A same-session resume leaves the flag alone: its director may be mid-flight.
  if (adopted && s.phase !== 'SUSPENDED') {
    s.directorTurn = { agentId: s.directorTurn?.agentId ?? null, blocks: 0, yielded: true };
  }
});
logEvent(projectRoot, runId, { type: 'resumed', sessionId, phase: target, displacedSessions: displaced });

const a = artifacts(projectRoot, runId);
emitJson({
  runId,
  phase: target,
  displacedSessions: displaced,
  owner: PHASES[target].owner,
  summary: PHASES[target].summary,
  next: PHASES[target].next,
  artifacts: { state: a.state, request: a.request, design: a.design, plan: a.plan, tasks: a.tasks, evidence: a.evidence, reviews: a.reviewsDir },
  reminder:
    'Before continuing, check that the plan\'s premises still hold — files, signatures and test ' +
    'results may have changed while the run was stopped. Resuming into a changed world is the ' +
    'main way a resumed run produces confidently wrong output.',
});
