/**
 * How far a run has actually got — from facts the state machine already proves.
 *
 * The rule this file exists to obey: **nothing here reads a field somebody has to remember to
 * update.** Every input is something a gate, a transition or a work-package status already had to
 * be true for the run to be where it is. A progress bar fed by a bespoke counter would display a
 * confident number about a run nobody was measuring, which is worse than no bar at all.
 *
 * It is deliberately *not* a percentage of time. The measured spread is `DESIGN_LOCK` at 24–26 min
 * and `PLAN_LOCK` at 54–57 min across three runs, but only **one** run has ever been timed to
 * `COMPLETE`. Dividing by an n=1 denominator would give a guess the authority of a measurement.
 * So the bar is a weighted walk over milestones, and elapsed time and spend ride beside it as
 * text — never as the thing that fills it.
 */

import { readJson } from './io.mjs';
import { artifacts } from './paths.mjs';
import { PHASE_ORDER, phaseIndex, isTerminal } from './phases.mjs';

/**
 * Weights are a product judgement; the boundaries are not.
 *
 * Each segment closes when a **real phase** has been reached, and `tests` asserts every `through`
 * exists in `PHASE_ORDER` and that they appear in order — so this table cannot drift away from the
 * machine the way a hand-maintained copy of the workflow would. The 25/25 split for design and plan
 * is consistent with the 54–57 min measured to `PLAN_LOCK` (about two thirds of the only timed run)
 * without depending on it: a run that spends two hours in execution does not make the bar lie, it
 * just advances more slowly inside that segment.
 */
export const SEGMENTS = Object.freeze([
  { key: 'scoping', label: 'scoping', through: 'BRAINSTORMING', weight: 5 },
  { key: 'design', label: 'design', through: 'DESIGN_LOCK', weight: 25 },
  { key: 'plan', label: 'plan', through: 'PLAN_LOCK', weight: 25 },
  { key: 'execution', label: 'execution', through: 'EXECUTION', weight: 25 },
  { key: 'verification', label: 'verification', through: 'IMPLEMENTATION_REVIEW_2', weight: 15 },
  { key: 'acceptance', label: 'acceptance', through: 'COMPLETE', weight: 5 },
]);

/**
 * The furthest phase this run has ever reached, and how often it went back.
 *
 * `state.phase` alone is not progress: `PHASES` has real back edges — a round-2 review returns to
 * remediation, `SYSTEM_VERIFICATION` returns to `EXECUTION`. A bar that slides backwards reads as a
 * bug, and it would also be wrong: remediation *adds* work, it does not undo what was proven. So
 * the fill holds at the high-water mark and the retreats are shown as a count instead. That is a
 * new fact on screen, not a hidden one.
 */
export function highWater(state) {
  let max = -1;
  let retries = 0;
  let previous = -1;
  for (const entry of [...(state?.history ?? []), { to: state?.phase }]) {
    const i = phaseIndex(entry?.to);
    if (i === null) continue;
    if (previous !== -1 && i < previous) retries += 1;
    previous = i;
    if (i > max) max = i;
  }
  return { index: max, phase: max >= 0 ? PHASE_ORDER[max] : null, retries };
}

/** Fraction of one segment that is done, from evidence rather than from being in the phase. */
function segmentFill(segment, { state, tasks, reachedIndex }) {
  const through = phaseIndex(segment.through);
  if (through !== null && reachedIndex > through) return 1;

  const reviews = state?.reviews ?? {};
  const done = (round) => (reviews[round] ? 1 : 0);
  const gate = (name) => (state?.gates?.[name]?.passed ? 1 : 0);

  switch (segment.key) {
    case 'scoping':
      // Two artefacts, and the phase table already refuses to leave without them.
      return reachedIndex >= phaseIndex('BRAINSTORMING') ? 0.5 + 0.5 * gate('design') : 0;
    case 'design':
      return Math.min(1, (done('design-1') + done('design-2') + gate('design')) / 3);
    case 'plan':
      return Math.min(1, (done('plan-1') + done('plan-2') + gate('plan')) / 3);
    case 'execution': {
      // The only genuinely continuous sub-progress in the run, and it comes from the one field a
      // package cannot fake: `accepted` is written by the state machine, not claimed by an agent.
      const list = Array.isArray(tasks?.tasks) ? tasks.tasks : [];
      if (!list.length) return 0;
      return list.filter((t) => t?.status === 'accepted').length / list.length;
    }
    case 'verification':
      return Math.min(1, (done('implementation-1') + done('implementation-2')
        + (readJsonSafe(state?.__evidencePath) ? 1 : 0)) / 3);
    case 'acceptance':
      return gate('completion');
    default:
      return 0;
  }
}

function readJsonSafe(p) {
  return p ? readJson(p, null) : null;
}

/**
 * `{ percent, phase, segment, retries, tasks }` — or `null` when there is nothing to show.
 *
 * `null` is a real answer and callers must render nothing for it: a status line that decorates a
 * session with no Hyperpowers run has replaced somebody's default row with our silence.
 */
export function runProgress(projectRoot, runId) {
  const a = artifacts(projectRoot, runId);
  const state = readJson(a.state, null);
  if (!state) return null;

  const tasks = readJson(a.tasks, null);
  const reached = highWater(state);
  if (reached.index < 0) return null;

  const ctx = { state: { ...state, __evidencePath: a.evidence }, tasks, reachedIndex: reached.index };
  let percent = 0;
  let current = SEGMENTS[0];
  for (const segment of SEGMENTS) {
    const fill = segmentFill(segment, ctx);
    percent += segment.weight * fill;
    if (fill < 1) { current = segment; break; }
    current = segment;
  }

  const list = Array.isArray(tasks?.tasks) ? tasks.tasks : [];
  const updatedAt = Date.parse(state.updatedAt ?? '');
  return {
    // A terminal COMPLETE is the one place the bar may assert 100: the completion gate is the
    // fourteen conditions, so it is the only claim of doneness this codebase accepts.
    percent: state.phase === 'COMPLETE' ? 100 : Math.min(99, Math.round(percent)),
    phase: state.phase,
    segment: current.label,
    retries: reached.retries,
    terminal: isTerminal(state.phase),
    tasks: list.length ? { accepted: list.filter((t) => t?.status === 'accepted').length, total: list.length } : null,
    // How long since anything mutated the run. `saveState` stamps `updatedAt` on every mutation,
    // so this obeys the file's own rule — no field anybody has to remember to update — and it is
    // the one signal that keeps moving on this surface while every hook is silent: a wedged
    // director is a live subagent, the panel ticks every 5 s throughout, and run 9b sat
    // unobservable for six hours with a healthy-looking row. Detection is the honest ceiling
    // here: no plugin surface can cancel a wedged dispatch (§S14); a human told in time can.
    staleMs: Number.isFinite(updatedAt) ? Math.max(0, Date.now() - updatedAt) : null,
  };
}
