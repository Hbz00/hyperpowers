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
 *   state-machine.mjs ask        [--run <id>] --file <packet.json>
 *   state-machine.mjs answer     [--run <id>] --json '["…"]'
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs, fail, emitJson, resolveProjectRoot, resolveRunId, requireSafeId } from './lib/cli.mjs';
import { newRunId, bindSession, artifacts, PLUGIN_ROOT } from './lib/paths.mjs';
import { ensureDir, writeJson, writeFileAtomic, readJson, nowIso } from './lib/io.mjs';
import { captureWorkspaceBaseline, misplacedOrchestrationFile, insideRunDir } from './lib/workspace.mjs';
import { stampFingerprint } from './lib/git-fingerprint.mjs';
import { newState, saveState, loadState, mutateState, transition, checkGate, progressSignature, pendingQuestion, pendingErrand, refuseIfEnded, reviewedArtifactDigest } from './lib/state.mjs';
import { PHASES, PHASE_ORDER, isKnownPhase, isTerminal, phaseIndex } from './lib/phases.mjs';
import { loadConfig, describeBounds, costNotice, durationNotice, DIRECTOR_AGENT } from './lib/config.mjs';
import { validate } from './lib/validate.mjs';
import { lintMermaid, extractMermaid } from './lib/mermaid.mjs';
import { logEvent, summarise, scoreAgainstTargets } from './lib/telemetry.mjs';
import { measuredCostFor } from './lib/transcript.mjs';
// Engage only. The release lives in `transition()` so all three paths to a terminal phase get it.
import { engageSubagentCache } from './lib/session-settings.mjs';

const { positional, flags } = parseArgs();
const command = positional[0];
const projectRoot = resolveProjectRoot(flags);

const COMMANDS = {
  init: cmdInit,
  show: cmdShow,
  check: cmdCheck,
  transition: cmdTransition,
  count: cmdCount,
  risk: cmdRisk,
  task: cmdTask,
  ask: cmdAsk,
  answer: cmdAnswer,
  abort: cmdAbort,
  'publish-request': cmdPublishRequest,
  published: cmdPublished,
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
  const sessionId = requireSafeId('session', flags.session ?? process.env.CLAUDE_CODE_SESSION_ID);
  if (!sessionId) fail('init requires --session <id> (or CLAUDE_CODE_SESSION_ID in the environment).');

  const runId = flags.run !== undefined ? requireSafeId('run', flags.run) : newRunId();
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
  // The Git baseline exists from the moment the run exists. Left to the guard's first
  // PostToolUse firing, the baseline was the post-call state of whatever Bash invocation ran
  // first — so a mutation inside that same invocation was absorbed and never reported.
  stampFingerprint(projectRoot, a.base);
  writeJson(a.tasks, { tasks: [] });
  writeJson(a.locks, { owners: {} });
  bindSession(projectRoot, sessionId, runId);
  logEvent(projectRoot, runId, { type: 'run_started', sessionId, projectRoot });

  // The run is live, so it installs the 1-hour subagent cache (`session-settings.mjs`) — which
  // reaches every session sharing `~/.claude/`, not only this one. Here rather than in a hook
  // because this is the director's *first* tool call and the write applies to the live session,
  // including the conversation making it. Never fatal, and now true: `engageSubagentCache` cannot
  // throw, because when it could, an unwritable config directory killed this call and the run with
  // it, under this very comment (§V20). A run on the 5-minute tier is dearer and entirely correct.
  const cache = engageSubagentCache(projectRoot, { config, runId });
  logEvent(projectRoot, runId, {
    type: 'subagent_cache', action: 'engage', changed: cache.changed, wrote: cache.wrote ?? false, reason: cache.reason,
  });

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

/**
 * The run this verb targets — and it may still be written to (§S14).
 *
 * Ending a run ends its *state*, not its subagents: the harness keeps them running and
 * `PreToolUse` carries no `agent_id` (§D5), so nothing can tell one of their tool calls from the
 * user's. What is achievable is that they accomplish nothing, and `state.mjs` states the rule as
 * *every* verb that writes. It was three of eleven, and the one the measured incident names — a plan
 * coordinator adjudicating for nine minutes past an abort — was among the eight.
 *
 * Read verbs deliberately do not call this: auditing a finished run has to keep working, which is
 * the same reason `verify-completion` still evaluates a gate it will not record. `abort` keeps its
 * own softer answer, because "already ended" is the outcome it was asked for.
 */
function requireLiveRun() {
  const runId = requireRun();
  const ended = refuseIfEnded(projectRoot, runId);
  if (ended) fail(ended, 2);
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
    // Overrides the config refused, next to the bounds they would have moved — preflight warns
    // about these too, but `show` is what gets read mid-run.
    rejectedOverrides: loadConfig(projectRoot).rejectedOverrides ?? [],
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
  // §S14 before anything is measured or logged: a terminal run is refused by `canTransition` anyway,
  // but the cost notice was emitted *first*, so a closed record took one more journal line on the way
  // to being told no.
  const runId = requireLiveRun();
  const to = typeof flags.to === 'string' ? flags.to.toUpperCase() : null;
  if (!to) fail('transition requires --to <PHASE>.');
  if (!isKnownPhase(to)) {
    fail(`Unknown phase '${to}'. Known phases: ${Object.keys(PHASES).join(', ')}`);
  }

  const before = loadState(projectRoot, runId);

  /**
   * A phase change is the checkpoint where spend gets reported.
   *
   * This used to be a second enforcement point for budget bounds, added because the Stop
   * controller — the only other one — ran **once** in an 86-minute run (§O14). The frequency
   * diagnosis was right and the remedy was not: what the two call sites enforced was a move to
   * `BUDGET_EXCEEDED`, a terminal phase with no successors that `resume-run.mjs` refuses to
   * reopen. A run three quarters finished, design and plan locked, packages built, became
   * permanently unfinishable for crossing a number.
   *
   * The last comment here argued that stopping a finished run at the last step "would spend the
   * whole budget and discard the result, which is the one outcome worse than overspending". That
   * reasoning was correct and did not go far enough — it is the outcome at *every* step, not only
   * the last. So nothing stops now. The figure is measured and stated; the person paying decides.
   */
  let notice = null;
  if (!isTerminal(to)) {
    const config = loadConfig(projectRoot);
    // Measured fresh from the transcript, not read from `observedUsage`. That field is written
    // only by the Stop controller — the hook that runs once per run — so consulting it here would
    // have compared the bound against an hours-old figure and never fired, which is the same
    // "checked once" defect this check exists to close, one level down.
    const measuredCost = measuredCostFor(before) ?? before.observedUsage?.totals?.costUsd ?? 0;
    // Reported, never enforced. This call site exists because the Stop controller fired once in an
    // 86-minute run (§O14) — the frequency problem was real and the fix was right. What was wrong
    // was the consequence: crossing the line moved the run to a terminal phase no resume could
    // reopen. The notice keeps the visibility and drops the destruction.
    const cost = costNotice({ config, measuredCost });
    if (cost) logEvent(projectRoot, runId, { type: 'cost_notice', measuredCost, threshold: config.budgets?.costNoticeUsd });
    // Wall-clock rides beside spend, same shape, same polarity: the spec asks for a duration
    // control, the ceiling's removal left none, and duration is the one dimension §K6 records the
    // old breaker actually working on.
    const duration = durationNotice({ config, startedAt: before.createdAt });
    if (duration) logEvent(projectRoot, runId, { type: 'duration_notice', startedAt: before.createdAt, threshold: config.budgets?.durationNoticeMs });
    notice = [cost, duration].filter(Boolean).join(' ') || null;
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
  // terminal transition — it leaves a stale document, which is what happened before. This covers
  // the CLI `transition` and `abort` verbs only: the subagent controller's forced-BLOCKED path
  // calls `transition()` directly inside a hook budget a 30 s subprocess would blow, so a run
  // force-blocked there keeps its preterminal report, whose own banner says to regenerate it.
  regenerateFinalReport(runId, state.phase);

  emitJson({
    runId,
    from: before.phase,
    to: state.phase,
    revision: state.revision,
    owner: PHASES[state.phase].owner,
    next: PHASES[state.phase].next,
    // Present only when spend has passed the notice threshold. It rides on the transition the
    // director already reads, so the figure reaches a decision-maker without a hook that fires
    // once an hour and without anything being refused.
    ...(notice ? { costNotice: notice } : {}),
  });
}

/** Refresh a preterminal final report after a terminal transition — see the comment at the call site. */
function regenerateFinalReport(runId, phase) {
  if (!isTerminal(phase) || !fs.existsSync(artifacts(projectRoot, runId).finalReport)) return;
  try {
    execFileSync(process.execPath, [
      path.join(PLUGIN_ROOT, 'scripts', 'report.mjs'), 'final',
      '--project', projectRoot, '--run', runId,
    ], { stdio: 'ignore', timeout: 30_000 });
  } catch {
    // A stale report is better than a refused terminal transition — but a silent stale report
    // headed "not terminal yet" was undiagnosable. The event is the trace.
    try { logEvent(projectRoot, runId, { type: 'report_regeneration_failed', phase }); } catch { /* best effort */ }
  }
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
  const runId = requireLiveRun();
  const state = loadState(projectRoot, runId);
  const text = flags.add;
  if (typeof text !== 'string' || text.trim().length < 10) {
    fail('risk requires --add "<what the residual risk actually is>" (at least 10 characters).');
  }
  const entry = {
    at: nowIso(),
    risk: text.trim(),
    source: typeof flags.source === 'string' ? flags.source : null,
    // The implementation tree this statement was made about. A waiver is a claim about a specific
    // state, and a timestamp alone let one statement authorise every future edit: state the risk
    // once after the review, keep rewriting the implementation, and the old sentence stayed
    // "newer than the review" forever — reproduced. The digest is what lets the completion gate
    // refuse a waiver describing a tree two rewrites ago. Stamped on every risk (it is cheap
    // provenance either way); only the digest-anchored conditions compare it.
    implementationDigest: reviewedArtifactDigest(projectRoot, runId, 'implementation'),
  };

  // A citation that matches nothing is the `count --counter codexInvocation` defect in the verb that
  // discharges a gate condition: it reports success, the gate keeps failing with the same message, and
  // the two facts never meet. So the reply says whether the source landed on a condition a stored gate
  // verdict is actually waiting on. Reported, not refused — a residual risk may legitimately cite a
  // finding id, a file, or nothing at all; only a *stated* citation that resolves to nothing is worth
  // remarking on.
  const awaiting = new Set(Object.values(state.gates ?? {})
    .flatMap((g) => (g.unverifiable ?? []).map((u) => String(u).split(':')[0].trim())));
  const cites = Boolean(entry.source) && awaiting.has(entry.source);
  const risks = mutateState(projectRoot, runId, (s) => {
    s.residualRisks = [...(s.residualRisks ?? []), entry];
    return s.residualRisks;
  });
  logEvent(projectRoot, runId, { type: 'residual_risk', risk: entry.risk, source: entry.source });
  emitJson({
    runId,
    recorded: entry,
    total: risks.length,
    discharges: cites ? entry.source : null,
    next: cites
      ? `This risk discharges \`${entry.source}\`, appears in the completion gate summary and the final `
        + `report, and Fable sees it at FINAL_ACCEPTANCE. Re-run the gate to confirm.`
      : `This risk appears in the completion gate summary and the final report. Fable sees it at `
        + `FINAL_ACCEPTANCE.${entry.source && awaiting.size ? ` Note: \`--source ${entry.source}\` matches `
          + `no condition awaiting a decision (${[...awaiting].join(', ')}), so it discharges nothing.` : ''}`,
  });
}

/**
 * Persist the diagram's own source alongside the page that will be published.
 *
 * The first run satisfied condition 14 with a `mermaid.live` link: real, product-oriented, and
 * entirely dependent on a third-party renderer staying up and the reader clicking. The URL is the
 * *publication*; the source is the artefact. Keeping it means the final report can show the
 * diagram inline, and that a run's deliverable survives a dead link.
 *
 * `--source` is optional, because condition 14 is satisfied by a published URL — but "always pass
 * `--source`" was an instruction, and its measured compliance across two production runs was 0%.
 * So the source is *derived* when the flag is absent: the published page is Markdown with a
 * ```mermaid fence (the phase instructions say to write exactly that), and the first fence IS the
 * source. Removing the instruction nobody followed beats enforcing it — the deliverable survives
 * without anyone having to remember anything.
 */
function persistDiagramSource(a, publishedFile = null) {
  // The page is the artefact, so the page is what gets linted. `--source` used to win, which meant
  // the common path — the one the director's instructions ask for — validated a *parallel string*
  // and let a valid flag ride along with a broken page. It stays as the fallback for a page whose
  // markup the extractor cannot read, so an unrecognised container still records its diagram.
  let source = '';
  if (publishedFile) {
    try {
      source = extractMermaid(fs.readFileSync(publishedFile, 'utf8')) ?? '';
    } catch { /* no page to derive from — the reply below says what was lost */ }
  }
  if (!source && typeof flags.source === 'string') source = flags.source.trim();
  if (!source) return null;
  const problems = lintMermaid(source);
  if (problems.length) {
    fail(
      `The diagram will not render as written:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n` +
        `Fix it in the page and request publication again.`,
      2,
    );
  }
  ensureDir(a.base);
  const file = path.join(a.base, 'diagram.mmd');
  writeFileAtomic(file, source);
  return file;
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
  if (['COMPLETE', 'ABORTED', 'BLOCKED', 'POLICY_VIOLATION'].includes(state.phase)) {
    emitJson({ runId, phase: state.phase, note: 'Run had already ended; nothing to abort.' });
    return;
  }
  transition(projectRoot, runId, 'ABORTED', { actor: 'user', reason, note: `aborted from ${state.phase}` });
  regenerateFinalReport(runId, 'ABORTED');
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

  // Below the `--list` branch on purpose: listing packages is how a finished run gets audited.
  requireLiveRun();

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
    // Acceptance is judgement about evidence, and the evidence has to say the work succeeded.
    // "Has a report" admitted a `failed` or `blocked` report — the schema's own vocabulary — so
    // "all tasks accepted" could become semantically false while reading as done. The coordinator
    // may still accept over a non-success report, but only by writing down why: an exception on
    // the record is a decision, an exception by default is the defect.
    if (status === 'accepted') {
      // The newest *referenced* report is authoritative — resolved from the id list, never from
      // whichever files happen to be readable. Sorting the surviving files let a missing or
      // corrupt attempt 2 quietly reinstate attempt 1's old success as "latest": exactly the
      // interrupted-storage case in which acceptance must refuse, accepting more easily the more
      // evidence had been lost. (Reading every id and skipping the whole check when all were
      // missing was the same defect, one step earlier.)
      const attemptOf = (rid) => Number(/-attempt(\d+)$/.exec(String(rid))?.[1] ?? 0);
      const intended = [...(task.reports ?? [])].sort((x, y) => attemptOf(x) - attemptOf(y)).at(-1);
      const latest = readJson(a.report(intended), null);
      if (!latest) {
        throw new Error(
          `Work package '${id}' names '${intended}' as its newest report and that file cannot be ` +
            `read from ${a.reportsDir}. An older attempt's success does not stand in for missing ` +
            `newer evidence. Re-submit the report with validate-agent-report.mjs, then accept.`,
        );
      }
      const override = typeof flags['override-reason'] === 'string' ? flags['override-reason'].trim() : '';
      if (latest.status !== 'success' && override.length < 10) {
        throw new Error(
          `Work package '${id}' cannot be accepted: its latest report (attempt ${latest.attempt ?? 1}) ` +
            `has status '${latest.status}', not 'success'. Either remediate and get a successful ` +
            `report, or accept explicitly over it with --override-reason "<why the non-success ` +
            `report is acceptable>" (at least 10 characters — an exception without a reason is not ` +
            `an exception) — the reason is recorded with the task and in telemetry.`,
        );
      }
      if (latest.status !== 'success') {
        task.notes = [...(task.notes ?? []), `accepted despite '${latest.status}' report: ${override}`];
      }
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
    // The error message promises the override reaches telemetry; a promise the event did not keep.
    ...(typeof flags['override-reason'] === 'string' && flags['override-reason'].trim()
      ? { overrideReason: flags['override-reason'].trim() }
      : {}),
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

/**
 * The scalar counters an agent may move, read from the state contract itself.
 *
 * `count` accepted any name and created it. `--counter codexInvocation` reported success, stored a
 * field nothing reads, and left the real `codexInvocations` untouched — a dead field minted by a typo,
 * which is this repository's recurring defect with an agent's finger on it. Derived from
 * `state.schema.json` rather than listed here, so a counter added to the contract becomes settable and
 * one removed stops being settable, with nothing to remember.
 *
 * `retries` and `extraReviews` are excluded because they are maps, not scalars: their own verbs key
 * them by task and by artefact.
 */
function settableCounters() {
  const schema = readJson(path.join(PLUGIN_ROOT, 'schemas', 'state.schema.json'), null);
  const props = schema?.properties?.counters?.properties ?? {};
  return Object.entries(props).filter(([, v]) => v?.type === 'integer').map(([k]) => k);
}

function cmdCount() {
  const runId = requireLiveRun();
  const counter = flags.counter;
  const allowed = settableCounters();
  if (typeof counter !== 'string' || !allowed.includes(counter)) {
    fail(`count requires --counter <${allowed.join('|')}>.${typeof counter === 'string' ? ` '${counter}' is not one of them — a counter this command invents is read by nothing.` : ''}`);
  }
  // `9 > "seven"` is false, so a non-numeric `--by` would silently turn the counter into `NaN` and
  // every bound that reads it into a comparison nothing can satisfy — the same failure mode
  // `config.mjs` records for a mistyped numeric override.
  const by = Number(flags.by ?? 1);
  if (!Number.isInteger(by)) fail(`--by must be a whole number; got '${flags.by}'.`);
  const value = mutateState(projectRoot, runId, (s) => {
    s.counters[counter] = (s.counters[counter] ?? 0) + by;
    return s.counters[counter];
  });
  emitJson({ runId, counter, value });
}

/**
 * The director asks the user something — by writing it down and stopping.
 *
 * `AskUserQuestion` is removed from every subagent's tool list (§R1), so the director cannot ask
 * directly. It writes a packet here and ends its dispatch; the `SubagentStop` controller sees a
 * pending question and **allows** the stop instead of re-driving, which is what lets the question
 * reach the main thread at all; the main thread renders it and calls `answer`.
 *
 * Validated on write, against a schema that mirrors `AskUserQuestion`'s own input. A packet the
 * main thread cannot render faithfully is a question silently reworded on its way to the user.
 */
function cmdAsk() {
  const runId = requireLiveRun();
  const state = loadState(projectRoot, runId);
  const file = typeof flags.file === 'string' ? flags.file : null;
  if (!file) fail('ask requires --file <packet.json>. Write the packet, then point at it.');

  // Spec §20, and the third door onto it. `validate-agent-report` and `adjudication-ledger` both
  // guard their agent-supplied paths with this; a live run had already written `tests/wp-001-
  // report.json` into the working tree before the first one existed. A question packet left in the
  // project would land in the reviewer's diff and fail the completion gate as an unowned file.
  const misplaced = misplacedOrchestrationFile(file, projectRoot, artifacts(projectRoot, runId).base);
  if (misplaced) fail(misplaced, 2);

  const packet = readJson(file, null);
  if (!packet) fail(`Cannot read a JSON question packet at ${file}.`);

  // The phase is stamped from state, never taken from the packet: the packet's value is caller
  // input, and a director could label a post-brainstorm question as BRAINSTORMING. The publish
  // verb already stamped truthfully; this one trusted its caller — the same fact from two verbs.
  const draft = { ...packet, askedAt: packet.askedAt ?? nowIso(), phase: state.phase };
  delete draft.answeredAt;
  delete draft.answers;

  // BRAINSTORMING is the only interactive phase (spec §10.3; phases.mjs says so twice). Asking
  // later is contractually wrong but is *warned*, not refused: the only alternative the machine
  // could force is BLOCKED, which is terminal — turning an answerable question into a dead run is
  // the §S1/§S29 shape, and worse than an off-contract question the user can simply answer.
  if (state.phase !== 'BRAINSTORMING') {
    logEvent(projectRoot, runId, { type: 'question_out_of_phase', phase: state.phase });
  }

  const schema = readJson(path.join(PLUGIN_ROOT, 'schemas', 'question-packet.schema.json'), null);
  const result = validate(draft, schema);
  if (!result.valid) {
    fail(`The question packet does not validate:\n  - ${result.errors.join('\n  - ')}\n\n`
      + `It must mirror AskUserQuestion: 1–4 questions, each with a header of at most 12 characters `
      + `and 2–4 options carrying a label and a description.`, 2);
  }

  const existing = pendingQuestion(projectRoot, runId);
  if (existing) {
    fail(`Run ${runId} is already waiting on a question asked at ${existing.askedAt}. One question `
      + `at a time: the answer has to come back before the next is asked.`, 2);
  }

  writeJson(artifacts(projectRoot, runId).question, draft);
  logEvent(projectRoot, runId, { type: 'question_asked', phase: draft.phase, count: draft.questions.length });
  emitJson({
    runId,
    asked: draft.questions.length,
    file: artifacts(projectRoot, runId).question,
    ...(state.phase !== 'BRAINSTORMING'
      ? {
          warning: `This question was asked during ${state.phase}. The contract makes BRAINSTORMING `
            + 'the only interactive phase: after it, local ambiguity is Opus\'s to resolve, product '
            + 'ambiguity is yours, and a genuine external impossibility becomes BLOCKED. This is '
            + 'recorded.',
        }
      : {}),
    next: 'Stop now. Do not guess an answer and do not continue past it. The main thread will render '
      + 'this and re-dispatch you with the reply.',
  });
}

/** The main thread relays the user's reply. One answer per question, in order. */
/**
 * Ask the main thread to publish a file as an Artifact.
 *
 * The director cannot do this usefully. It *can* call `Artifact` — run 7 did, and got a valid URL —
 * but publishing from a subagent produces no page on anybody's screen, because the surface that
 * opens one belongs to the main thread. So this parks the errand exactly as a question parks, and
 * the URL comes back through `published`.
 *
 * The file must live in the run directory: spec §20 keeps Hyperpowers' own artefacts out of the
 * working tree the reviewer sees.
 */
function cmdPublishRequest() {
  const runId = requireLiveRun();
  const state = loadState(projectRoot, runId);
  // Publication has exactly one site in the contract: condition 14, decided at FINAL_ACCEPTANCE
  // (phases.mjs names the verb there and nowhere else). Refusing early costs nothing — the
  // director publishes when it arrives at the phase that reads the URL — unlike the ask verb,
  // where a refusal could strand an answerable question.
  if (state.phase !== 'FINAL_ACCEPTANCE') {
    fail(
      `publish-request is a FINAL_ACCEPTANCE verb (spec §13 condition 14) and this run is in ` +
        `${state.phase}. Publish when the run reaches FINAL_ACCEPTANCE — the phase's own ` +
        `instructions say exactly how.`,
      2,
    );
  }
  const file = typeof flags.file === 'string' ? flags.file : null;
  if (!file) fail('publish-request requires --file <path to the html or markdown to publish>.');
  if (typeof flags.title !== 'string' || !flags.title.trim()) {
    fail('publish-request requires --title "<what this page is>". It names the artifact for the user.');
  }
  const misplaced = misplacedOrchestrationFile(file, projectRoot, artifacts(projectRoot, runId).base);
  if (misplaced) fail(misplaced, 2);
  if (!fs.existsSync(file)) fail(`No file at ${file}. Write the page first, then request its publication.`, 2);
  // A published page is a run deliverable, and the main thread will read whatever this path
  // resolves to. Requiring it inside the run directory — canonically, so a symlink cannot point
  // elsewhere — makes the prompt's instruction ("write it into your run directory") mechanical.
  if (!insideRunDir(file, artifacts(projectRoot, runId).base)) {
    fail(
      `${file} is not inside this run's directory. The published page is a run deliverable: write ` +
        `it under ${artifacts(projectRoot, runId).base} (not a scratch path, not a symlink to one) ` +
        `and request publication again.`,
      2,
    );
  }

  const open = pendingErrand(projectRoot, runId);
  if (open) fail(`Run ${runId} is already waiting on the main thread (${open.kind}). One errand at a time.`, 2);

  // The source travels with the request, not with the URL.
  //
  // It used to arrive through `artifact --name diagramUrl --source …`, a verb the director called
  // *after* publishing — which only made sense while the director published. It no longer does
  // (§S21), and leaving the two apart meant the source had a home nobody was told about: run 8's
  // director wrote `diagram.mmd` by hand, at the right path, by inference. One verb takes both, so
  // the deliverable and its publication cannot come apart.
  const sourceFile = persistDiagramSource(artifacts(projectRoot, runId), file);

  writeJson(artifacts(projectRoot, runId).publish, {
    askedAt: nowIso(), phase: state.phase, file, title: flags.title, description: flags.description ?? null,
  });
  logEvent(projectRoot, runId, { type: 'publish_requested', phase: state.phase, file, sourceFile });
  emitJson({
    runId,
    parked: 'publish',
    sourceFile,
    next: sourceFile
      ? 'Stop your turn. The main thread publishes the page and records the URL; you are resumed after.'
      : 'Stop your turn. Note: no diagram source could be recorded — the page carries no '
        + '```mermaid fence and no `--source` was given — so the final report will have only the '
        + 'published link, and the one artefact aimed at a reader who will not read the rest dies '
        + 'with it.',
  });
}

/** The main thread reporting back: the page is live and the user can see it. */
function cmdPublished() {
  // Every write verb refuses a closed record (§S14) — and this one especially, because the whole
  // reason publishing parks mid-run is that it cannot be done afterwards.
  const runId = requireLiveRun();
  const packet = readJson(artifacts(projectRoot, runId).publish, null);
  if (!packet?.askedAt || packet.publishedAt) fail(`Run ${runId} is not waiting on a publication.`, 2);
  const url = typeof flags.url === 'string' ? flags.url.trim() : '';
  if (!/^https:\/\//i.test(url)) fail('published requires --url <https url returned by the Artifact tool>.');

  writeJson(artifacts(projectRoot, runId).publish, { ...packet, publishedAt: nowIso(), url });
  mutateState(projectRoot, runId, (s) => {
    s.artifacts = { ...(s.artifacts ?? {}), diagramUrl: url };
  });
  logEvent(projectRoot, runId, { type: 'artifact_recorded', name: 'diagramUrl', by: 'main-thread' });
  emitJson({ runId, published: url, next: `Resume the director so it can finish the run.` });
}

function cmdAnswer() {
  const runId = requireLiveRun();
  const packet = pendingQuestion(projectRoot, runId);
  if (!packet) fail(`Run ${runId} is not waiting on a question.`, 2);

  let answers;
  try {
    answers = JSON.parse(typeof flags.json === 'string' ? flags.json : '');
  } catch {
    answers = null;
  }
  if (!Array.isArray(answers) || answers.some((a) => typeof a !== 'string')) {
    fail('answer requires --json with an array of strings, one per question, in order.');
  }
  if (answers.length !== packet.questions.length) {
    fail(`${packet.questions.length} questions were asked and ${answers.length} answers were given. `
      + `A missing answer becomes an assumption the director did not make.`, 2);
  }

  writeJson(artifacts(projectRoot, runId).question, { ...packet, answeredAt: nowIso(), answers });
  logEvent(projectRoot, runId, { type: 'question_answered', count: answers.length });
  // The same preference every other surface states: resume the agent that already holds the run's
  // context. This verb said "re-dispatch a fresh director" while the Stop controller said
  // "SendMessage by id" — and this stdout is the last thing the main thread reads before acting,
  // so it was the instruction most likely to win. Cold restarts are the measured cost driver
  // (§T2: $15.48 of one run), and SendMessage-to-a-returned-agent is unmeasured, which is why the
  // cold dispatch stays as the stated fallback rather than being removed.
  const resume = loadState(projectRoot, runId).directorTurn?.agentId ?? null;
  emitJson({
    runId,
    answered: answers.length,
    next: (resume
      ? `Resume the director: SendMessage → \`${resume}\` ("answered, continue run ${runId}") — it `
        + `keeps the context it already holds. If that fails, `
      : '') + `dispatch \`hyperpowers:${DIRECTOR_AGENT}\` telling it to resume run ${runId}`
      + `${resume ? ' (a fresh dispatch starts cold and re-reads everything)' : ''}. The answers `
      + `are in its run directory; it reads them itself.`,
  });
}
