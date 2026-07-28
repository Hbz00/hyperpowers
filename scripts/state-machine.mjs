#!/usr/bin/env node
/**
 * State machine CLI — the only supported way to move a run between phases.
 *
 * Agents never edit `state.json` directly. Every transition goes through here so that the
 * legality check and the exit-gate check of spec §11 are enforced by code rather than by an
 * agent's good intentions, and so that each transition records its own evidence.
 *
 *   state-machine.mjs init       --session <id> [--description "..."]
 *   state-machine.mjs show       [--run <id>]
 *   state-machine.mjs check      [--run <id>]
 *   state-machine.mjs transition [--run <id>] --to <PHASE> [--actor …] [--artifact …]
 *                                [--evidence …] [--note …] [--reason …] [--fallback …]
 *   state-machine.mjs count      [--run <id>] --counter <name> [--by <n>]
 *   state-machine.mjs risk       [--run <id>] --add "<residual risk>" [--source <ref>]
 *   state-machine.mjs task       [--run <id>] --id <task> --status <status> [--note …]
 *   state-machine.mjs task       [--run <id>] --list
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs, fail, emitJson, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { newRunId, bindSession, artifacts, runsDir, listRuns, PLUGIN_ROOT } from './lib/paths.mjs';
import { ensureDir, writeJson, writeFileAtomic, readJson, nowIso } from './lib/io.mjs';
import { captureWorkspaceBaseline } from './lib/workspace.mjs';
import { newState, saveState, loadState, mutateState, transition, checkGate, progressSignature } from './lib/state.mjs';
import { PHASES, PHASE_ORDER, isKnownPhase, isTerminal, phaseIndex } from './lib/phases.mjs';
import { loadConfig, describeBounds, budgetOverrun } from './lib/config.mjs';
import { logEvent, summarise, scoreAgainstTargets } from './lib/telemetry.mjs';
import { measuredCostFor } from './lib/transcript.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];
const projectRoot = resolveProjectRoot(flags);

const COMMANDS = {
  init: cmdInit,
  show: cmdShow,
  check: cmdCheck,
  transition: cmdTransition,
  count: cmdCount,
  artifact: cmdArtifact,
  risk: cmdRisk,
  task: cmdTask,
  abort: cmdAbort,
};

/** Work-package lifecycle, mirroring `schemas/work-package.schema.json`. */
const TASK_STATUSES = ['pending', 'in_progress', 'reported', 'accepted', 'remediating', 'failed'];

const handler = COMMANDS[command];
if (!handler) {
  fail(
    `Unknown command '${command ?? '(none)'}'.\n` +
      `Usage: state-machine.mjs <${Object.keys(COMMANDS).join('|')}> [--run <id>] [flags]`,
  );
}
handler();

function cmdInit() {
  const sessionId = flags.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) fail('init requires --session <id> (or CLAUDE_CODE_SESSION_ID in the environment).');

  const runId = typeof flags.run === 'string' ? flags.run : newRunId();
  const a = artifacts(projectRoot, runId);
  ensureDir(a.base);
  ensureDir(a.reviewsDir);
  ensureDir(a.reportsDir);
  ensureDir(a.packsDir);

  const config = loadConfig(projectRoot);
  const state = newState({
    runId,
    sessionId,
    projectRoot,
    description: typeof flags.description === 'string' ? flags.description : '',
    config: { budgets: config.budgets, effort: config.effort, models: config.models },
  });
  state.workspaceBaseline = captureWorkspaceBaseline(projectRoot);
  saveState(projectRoot, runId, state);
  writeJson(a.tasks, { tasks: [] });
  writeJson(a.locks, { owners: {} });
  bindSession(projectRoot, sessionId, runId);
  logEvent(projectRoot, runId, { type: 'run_started', sessionId, projectRoot });

  emitJson({
    runId,
    phase: state.phase,
    runDir: a.base,
    artifacts: {
      state: a.state, request: a.request, brainstorm: a.brainstorm, design: a.design,
      plan: a.plan, tasks: a.tasks, evidence: a.evidence, reviews: a.reviewsDir,
      reports: a.reportsDir, finalReport: a.finalReport,
    },
    next: PHASES[state.phase].next,
  });
}

function requireRun() {
  const runId = resolveRunId(projectRoot, flags);
  if (!runId) fail(`No Hyperpowers run found for ${projectRoot}. Start one with /hyperpowers:feature.`);
  return runId;
}

function cmdShow() {
  const runId = requireRun();
  const state = loadState(projectRoot, runId);
  const gate = checkGate(projectRoot, runId, state);
  const usage = summarise(projectRoot, runId);
  emitJson({
    runId,
    phase: state.phase,
    phasePosition: describePosition(state.phase),
    owner: PHASES[state.phase].owner,
    summary: PHASES[state.phase].summary,
    revision: state.revision,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    exitRequirements: { satisfied: gate.ok, unmet: gate.failures },
    next: PHASES[state.phase].next,
    counters: state.counters,
    openBlockers: state.openBlockers,
    residualRisks: state.residualRisks,
    observedEffort: state.observedEffort ?? null,
    stall: state.stall,
    usage,
    distribution: scoreAgainstTargets(usage),
    // Saying which bounds a hook enforces and which are instructions to the coordinator is the
    // difference between a circuit breaker and a comment.
    bounds: describeBounds(loadConfig(projectRoot)),
    runDir: artifacts(projectRoot, runId).base,
    history: state.history.slice(-12),
  });
}

function describePosition(phase) {
  const i = phaseIndex(phase);
  if (i === null) return `${phase} (off the happy path)`;
  return `${i + 1}/${PHASE_ORDER.length} — ${PHASE_ORDER[i]}`;
}

function cmdCheck() {
  const runId = requireRun();
  const state = loadState(projectRoot, runId);
  const gate = checkGate(projectRoot, runId, state);
  emitJson({
    runId,
    phase: state.phase,
    canExit: gate.ok,
    unmet: gate.failures,
    allowedNextPhases: PHASES[state.phase].successors,
    signature: progressSignature(projectRoot, runId, state),
  });
  if (!gate.ok) process.exit(3);
}

function cmdTransition() {
  const runId = requireRun();
  const to = typeof flags.to === 'string' ? flags.to.toUpperCase() : null;
  if (!to) fail('transition requires --to <PHASE>.');
  if (!isKnownPhase(to)) {
    fail(`Unknown phase '${to}'. Known phases: ${Object.keys(PHASES).join(', ')}`);
  }

  const before = loadState(projectRoot, runId);

  /**
   * A phase change is a checkpoint, and it has to be one.
   *
   * The Stop controller was the only place a budget was ever consulted, and it ran **once** in an
   * 86-minute run — a healthy run spends its whole turn dispatching subagents and rarely tries to
   * end. The bound was therefore evaluated once, near the start, and never again across nineteen
   * transitions (§O14). That run did not in fact overrun — the accounting that said it had was
   * itself wrong by a factor of two (§P7) — which is the sharper version of the lesson: a bound
   * consulted once tells you nothing either way.
   *
   * Terminal targets are exempt: a run that is already over budget must still be able to reach
   * `BLOCKED`, `ABORTED` — or `COMPLETE`, when the work is finished and proven and the only thing
   * left is to say so. Stopping a finished run at the last step would spend the whole budget and
   * discard the result, which is the one outcome worse than overspending.
   */
  if (!isTerminal(to)) {
    const config = loadConfig(projectRoot);
    // Measured fresh from the transcript, not read from `observedUsage`. That field is written
    // only by the Stop controller — the hook that runs once per run — so consulting it here would
    // have compared the bound against an hours-old figure and never fired, which is the same
    // "checked once" defect this check exists to close, one level down.
    const measuredCost = measuredCostFor(before) ?? before.observedUsage?.totals?.costUsd ?? 0;
    const overrun = budgetOverrun({
      config,
      state: before,
      elapsedMs: Date.now() - Date.parse(before.createdAt),
      measuredCost,
    });
    if (overrun) {
      transition(projectRoot, runId, 'BUDGET_EXCEEDED', {
        actor: 'system',
        reason: `Bound ${overrun} exceeded`,
        note: `refused ${before.phase} → ${to}; cost=$${measuredCost.toFixed(2)}`,
      });
      logEvent(projectRoot, runId, { type: 'budget_exceeded', bound: overrun, at: before.phase, measuredCost });
      fail(
        `Budget bound \`${overrun}\` is exceeded (cost $${measuredCost.toFixed(2)} of ` +
          `$${config.budgets.maxCostUsd}). The run has been moved to BUDGET_EXCEEDED rather than ` +
          `entering ${to}.\n\nRaise the bound in \`.hyperpowers.json\` and start a new run, or accept ` +
          `the result as it stands — the artefacts are on disk and nothing was reverted.`,
        7,
      );
    }
  }

  let state;
  try {
    state = transition(projectRoot, runId, to, {
      actor: flags.actor,
      artifact: flags.artifact,
      evidence: flags.evidence,
      note: flags.note,
      reason: flags.reason,
      fallbacks: flags.fallback ? [flags.fallback] : [],
      cost: flags.cost ? Number(flags.cost) : null,
    });
  } catch (err) {
    // A refused transition is information, not a crash: report precisely what is missing so
    // the agent can act on it rather than retrying blindly.
    fail(
      `Transition refused: ${err.message}\n\n` +
        `Current phase ${before.phase} allows: ${PHASES[before.phase].successors.join(', ') || '(none)'}.\n` +
        `Run \`state-machine.mjs check --run ${runId}\` to see the unmet exit requirements.`,
      2,
    );
  }

  // The final report is required *before* the run may leave FINAL_ACCEPTANCE, so the document a
  // user is handed was written while the outcome was still pending. The production run proves it:
  // the delivered report opens "Outcome: FINAL_ACCEPTANCE (not terminal yet — regenerate this
  // report after the final transition)" for a run that reached COMPLETE. The instruction to
  // regenerate existed and nobody ran it, which is what an instruction is worth here.
  //
  // Regenerated from the transition itself, so the artefact and the outcome are one operation. A
  // subprocess rather than an import because `report.mjs` is a CLI whose top-level dispatch would
  // `fail()` on this script's argv. It is best-effort on purpose: the report already exists and
  // the gate has already read it, so a regeneration that cannot run must not undo a legitimate
  // terminal transition — it leaves a stale document, which is what happened before.
  if (isTerminal(state.phase) && fs.existsSync(artifacts(projectRoot, runId).finalReport)) {
    try {
      execFileSync(process.execPath, [
        path.join(PLUGIN_ROOT, 'scripts', 'report.mjs'), 'final',
        '--project', projectRoot, '--run', runId,
      ], { stdio: 'ignore', timeout: 30_000 });
    } catch { /* a stale report is better than a refused terminal transition */ }
  }

  emitJson({
    runId,
    from: before.phase,
    to: state.phase,
    revision: state.revision,
    owner: PHASES[state.phase].owner,
    next: PHASES[state.phase].next,
  });
}

/**
 * Record a residual risk (spec §9, §12 phase 9).
 *
 * Without this the instruction given to the adjudicator — "an out-of-scope finding is recorded
 * as a residual risk, not made to disappear" — had nowhere to write. `state.residualRisks` had
 * three readers (the final report, the gate summary, `show`) and no producer, so an accepted
 * risk vanished from every surface built to display it. Same defect class as the unreachable
 * `diagramUrl` and the unsettable task status: a field the system reads and nothing writes.
 */
function cmdRisk() {
  const runId = requireRun();
  const text = flags.add;
  if (typeof text !== 'string' || text.trim().length < 10) {
    fail('risk requires --add "<what the residual risk actually is>" (at least 10 characters).');
  }
  const entry = {
    at: nowIso(),
    risk: text.trim(),
    source: typeof flags.source === 'string' ? flags.source : null,
  };
  const risks = mutateState(projectRoot, runId, (s) => {
    s.residualRisks = [...(s.residualRisks ?? []), entry];
    return s.residualRisks;
  });
  logEvent(projectRoot, runId, { type: 'residual_risk', risk: entry.risk, source: entry.source });
  emitJson({
    runId,
    recorded: entry,
    total: risks.length,
    next: 'This risk now appears in the completion gate summary and the final report. Fable sees it at FINAL_ACCEPTANCE.',
  });
}

/**
 * Record an external artefact produced by the run — currently the published Artifact URL that
 * satisfies spec §13 condition 14.
 *
 * Without this, that condition could never pass, `gate:completion` could never be satisfied,
 * and every run would stall in FINAL_ACCEPTANCE and terminate BLOCKED. The completion contract
 * has to be reachable, not merely checkable.
 */
/**
 * Optionally persist the diagram's own source alongside its URL.
 *
 * The first run satisfied condition 14 with a `mermaid.live` link: real, product-oriented, and
 * entirely dependent on a third-party renderer staying up and the reader clicking. The URL is the
 * *publication*; the source is the artefact. Keeping it means the final report can show the
 * diagram inline, and that a run's deliverable survives a dead link.
 *
 * `--source` is optional so nothing breaks for a caller that only has a URL.
 */
function persistDiagramSource(a) {
  if (typeof flags.source !== 'string' || !flags.source.trim()) return null;
  ensureDir(a.base);
  const file = path.join(a.base, 'diagram.mmd');
  writeFileAtomic(file, flags.source.trim());
  return file;
}

function cmdArtifact() {
  const runId = requireRun();
  const name = flags.name;
  const value = flags.value;
  if (typeof name !== 'string') fail('artifact requires --name <key> (for example: diagramUrl).');
  if (typeof value !== 'string' || value.length === 0) fail('artifact requires --value <string>.');

  const sourceFile = persistDiagramSource(artifacts(projectRoot, runId));
  mutateState(projectRoot, runId, (s) => {
    s.artifacts = { ...(s.artifacts ?? {}), [name]: value };
  });
  logEvent(projectRoot, runId, { type: 'artifact_recorded', name, value, sourceFile });
  emitJson({
    runId,
    artifact: name,
    value,
    sourceFile,
    next: sourceFile
      ? 'The diagram source is stored with the run and will be embedded in the final report.'
      : 'Pass --source "<mermaid>" as well so the diagram survives the link and appears in the report.',
  });
}

/**
 * The escape hatch. The Stop controller blocks every attempt to end the turn until a terminal
 * phase is reached, and SessionStart re-binds an unfinished run — so without an explicit abort
 * a user who wants out would have to delete files by hand.
 */
function cmdAbort() {
  const runId = requireRun();
  const reason = typeof flags.reason === 'string' ? flags.reason : 'aborted by the user';
  const state = loadState(projectRoot, runId);
  if (['COMPLETE', 'ABORTED', 'BLOCKED', 'POLICY_VIOLATION', 'BUDGET_EXCEEDED'].includes(state.phase)) {
    emitJson({ runId, phase: state.phase, note: 'Run had already ended; nothing to abort.' });
    return;
  }
  transition(projectRoot, runId, 'ABORTED', { actor: 'user', reason, note: `aborted from ${state.phase}` });
  emitJson({
    runId,
    from: state.phase,
    to: 'ABORTED',
    reason,
    note: 'The run is stopped. Its artefacts remain on disk for inspection; nothing was reverted, ' +
      'because Hyperpowers never mutated your repository in the first place.',
  });
}

/**
 * Move a work package through its lifecycle.
 *
 * Without this, `EXECUTION` was a dead end. Its exit requirement is `tasks:all-accepted`, and
 * nothing in the system could set a task to `accepted`: `validate-agent-report submit` only
 * reaches `reported`, and no other verb touched task status. Every run would have stalled in
 * `EXECUTION` until the progress detector gave up and transitioned it to `BLOCKED`.
 *
 * Two rules are enforced here rather than asked for in a prompt:
 *
 *  - `accepted` requires a stored report. Acceptance is the coordinator's judgement, but it has
 *    to be judgement *about evidence*; a package accepted with no report is an assertion.
 *  - `in_progress` is what makes the SubagentStop report check able to fire at all — that hook
 *    only acts when exactly one package is in progress, so nothing ever setting the status also
 *    meant §16.4 was never enforced automatically.
 */
function cmdTask() {
  const runId = requireRun();
  const a = artifacts(projectRoot, runId);

  if (flags.list === true) {
    const tasks = readJson(a.tasks, { tasks: [] }).tasks ?? [];
    emitJson({
      runId,
      total: tasks.length,
      byStatus: tasks.reduce((acc, t) => ({ ...acc, [t.status ?? 'pending']: (acc[t.status ?? 'pending'] ?? 0) + 1 }), {}),
      tasks: tasks.map((t) => ({ id: t.id, status: t.status ?? 'pending', attempts: t.attempts ?? 0, reports: (t.reports ?? []).length })),
    });
    return;
  }

  const id = flags.id;
  const status = flags.status;
  if (typeof id !== 'string') fail('task requires --id <work package id> (or --list).');
  if (!TASK_STATUSES.includes(status)) fail(`task requires --status <${TASK_STATUSES.join('|')}>.`);

  let result;
  try {
    result = mutateState(projectRoot, runId, (s) => {
    const file = readJson(a.tasks, { tasks: [] });
    const task = (file.tasks ?? []).find((t) => t.id === id);
    if (!task) {
      throw new Error(
        `No work package '${id}' in tasks.json. Known packages: ${(file.tasks ?? []).map((t) => t.id).join(', ') || '(none)'}`,
      );
    }
    if (status === 'accepted' && (task.reports ?? []).length === 0) {
      throw new Error(
        `Work package '${id}' has no submitted report, so it cannot be accepted. The implementer ` +
          `must submit one first:\n  validate-agent-report.mjs submit --run ${runId} --file <report.json>`,
      );
    }
    const previous = task.status ?? 'pending';
    task.status = status;
    if (status === 'in_progress') {
      task.attempts = (task.attempts ?? 0) + 1;
      if (previous === 'pending') s.counters.workPackages += 1;
    }
    if (typeof flags.note === 'string') task.notes = [...(task.notes ?? []), flags.note];
    writeJson(a.tasks, file);

    const remaining = (file.tasks ?? []).filter((t) => t.status !== 'accepted').map((t) => t.id);
    return { previous, attempts: task.attempts ?? 0, remaining, total: (file.tasks ?? []).length };
    });
  } catch (err) {
    // A refused update is information the coordinator can act on, not a crash.
    fail(err.message, 2);
  }

  logEvent(projectRoot, runId, {
    type: 'work_package', tier: 'sonnet', workPackage: id,
    attempt: result.attempts, status, outcome: status, note: flags.note ?? null,
  });

  emitJson({
    runId,
    task: id,
    from: result.previous,
    to: status,
    attempts: result.attempts,
    accepted: result.total - result.remaining.length,
    total: result.total,
    remaining: result.remaining,
    next: result.remaining.length
      ? `${result.remaining.length} package(s) still unaccepted: ${result.remaining.join(', ')}.`
      : 'Every work package is accepted. EXECUTION can now be exited to SYSTEM_VERIFICATION.',
  });
}

function cmdCount() {
  const runId = requireRun();
  const counter = flags.counter;
  if (typeof counter !== 'string') fail('count requires --counter <name>.');
  const by = Number(flags.by ?? 1);
  const value = mutateState(projectRoot, runId, (s) => {
    s.counters[counter] = (s.counters[counter] ?? 0) + by;
    return s.counters[counter];
  });
  emitJson({ runId, counter, value });
}
