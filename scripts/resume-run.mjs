#!/usr/bin/env node
/**
 * Rebind a run to the current session and return it to an active phase.
 *
 * A suspended run stopped cleanly below the Stop-hook block cap; its phase is intact and its
 * artefacts are on disk. Resuming is therefore a matter of re-establishing the session→run
 * pointer (the hooks' only way to find the run) and restoring the phase the run was in when it
 * yielded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fail, emitJson, resolveProjectRoot } from './lib/cli.mjs';
import { bindSession, artifacts, activeRunId, listRuns } from './lib/paths.mjs';
import { loadState, tryLoadState, mutateState } from './lib/state.mjs';
import { PHASES, isTerminal } from './lib/phases.mjs';
import { logEvent } from './lib/telemetry.mjs';

const { flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const sessionId = flags.session ?? process.env.CLAUDE_CODE_SESSION_ID;
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
  if (typeof flags.run === 'string') return flags.run;
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
    s.turn = { promptId: null, blocks: 0 };
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
// policy explicitly permitted. Dropping it makes the next observation a fresh baseline.
try { fs.rmSync(path.join(artifacts(projectRoot, runId).base, 'git-fingerprint.json'), { force: true }); } catch { /* nothing to clear */ }

// The check above refuses to *steal* a run from a session that may still be driving it. This is
// the other half: once ownership legitimately moves, the previous owner must stop being one.
// `bindSession` enforces the exclusivity and reports whom it displaced.
const { displaced } = bindSession(projectRoot, sessionId, runId);
mutateState(projectRoot, runId, (s) => { s.sessionId = sessionId; });
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
