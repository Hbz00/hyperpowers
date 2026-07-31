#!/usr/bin/env node
/**
 * Agent report validation (spec §16.4).
 *
 *   Un Sonnet ne peut pas terminer avec « Done. »
 *
 * Two modes, one contract:
 *
 *  - **CLI** (`submit`): an agent writes its report and submits it. The report is validated
 *    against `agent-report.schema.json` and rejected with precise errors if it is not
 *    evidence-bearing. This is where enforcement really happens, because the agent cannot
 *    proceed without a stored, valid report.
 *  - **Hook** (SubagentStop): catches the agent that finished without submitting anything at
 *    all, and blocks once so it can correct itself.
 *
 * The hook is deliberately conservative. A SubagentStop payload does not reliably identify
 * which work package the finishing agent owned, so it only intervenes when the answer is
 * unambiguous: exactly one package is in progress and it has no valid report. Blocking on a
 * guess would stall legitimate parallel work, which is a worse failure than missing one report
 * that the coordinator's own OPUS_CHECK step would catch anyway.
 */

import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, fail, emitJson, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { artifacts, PLUGIN_ROOT, activeRunId } from './lib/paths.mjs';
import { readJson, writeJson, nowIso } from './lib/io.mjs';
import { tryLoadState, mutateState, refuseIfEnded } from './lib/state.mjs';
import { validate } from './lib/validate.mjs';
import { misplacedOrchestrationFile } from './lib/workspace.mjs';
import { logEvent } from './lib/telemetry.mjs';
import { runHook, emitBlock, emitAllowStop, projectRootFrom } from './lib/hookio.mjs';

const SCHEMA = readJson(path.join(PLUGIN_ROOT, 'schemas', 'agent-report.schema.json'), null);

const { positional, flags } = parseArgs();

if (positional[0] === 'submit' || positional[0] === 'check') {
  runCli(positional[0]);
} else {
  await runAsHook();
}

function runCli(mode) {
  const projectRoot = resolveProjectRoot(flags);
  const runId = resolveRunId(projectRoot, flags);
  if (!runId) fail(`No Hyperpowers run found for ${projectRoot}.`);
  // §S14: `submit` stores the report and moves the package's status. `check` only validates, and
  // validating a report against a finished run is legitimate auditing.
  if (mode === 'submit') {
    const ended = refuseIfEnded(projectRoot, runId);
    if (ended) fail(ended, 2);
  }
  if (typeof flags.file !== 'string') fail(`${mode} requires --file <report.json>.`);

  const reportPath = path.resolve(projectRoot, flags.file);
  const a0 = artifacts(projectRoot, runId);

  /**
   * Orchestration artefacts do not go in the user's repository (spec §20).
   *
   * Five agent prompts said `--file <report.json>` and never said *where*, so an agent wrote its
   * report into the working tree — observed in a live run as `tests/wp-001-report.json`. Two
   * things follow from that, and neither is obvious at the time: rounds 5 and 6 review the real
   * diff and the untracked inventory, so the reviewer would be handed Hyperpowers' own logs as
   * part of the change under review; and §13.10 fails the completion gate on a file no work
   * package owns — the run refused by an artefact the run itself created.
   *
   * Refused rather than tolerated, because exempting it from the scope check would leave the
   * §20 breach in place and merely hide the symptom. The message names the correct path, so the
   * agent's next attempt succeeds instead of guessing.
   */
  const misplaced = misplacedOrchestrationFile(reportPath, projectRoot, a0.base);
  if (misplaced) fail(misplaced, 3);

  const report = readJson(reportPath, null);
  if (!report) fail(`Cannot read a JSON report at ${reportPath}.`);
  const { valid, errors } = validate(report, SCHEMA);
  const semantic = semanticChecks(report);
  const ownership = ownershipChecks(report, readJson(a0.tasks, { tasks: [] }));
  const allErrors = [...errors, ...semantic, ...ownership];

  if (allErrors.length) {
    // Spec §16.4 allows one correction, and that has to be counted rather than announced: the
    // message claimed "this is the only rejection you get" while the CLI accepted invalid
    // resubmissions forever, so an agent could grind against the validator indefinitely instead
    // of escalating. Counting is per package, and only on the `submit` path — `check` is a
    // free dry run precisely so a careful agent never spends its correction.
    let rejections = 0;
    if (mode === 'submit') {
      try {
        rejections = mutateState(projectRoot, runId, (s) => {
          const id = report?.work_package_id ?? '(unknown)';
          s.reportRejections = { ...(s.reportRejections ?? {}) };
          s.reportRejections[id] = (Number(s.reportRejections[id]) || 0) + 1;
          return s.reportRejections[id];
        });
      } catch { /* counting must never mask the validation error itself */ }
    }
    // Keep the refused report. Rejecting it used to discard it, and an agent that has already
    // spent its turn budget cannot rewrite what it observed: in the first production run every
    // one of six narratives was lost this way or to a turn cap, the coordinator had to re-run the
    // verification to reconstruct them, and completion condition §13.5 — tests demonstrably
    // failing before the fix — became unverifiable for the whole run.
    //
    // In `reports/rejected/`, not beside the valid ones: the review pack globs `*.json` in
    // `reports/`, so a sibling would be handed to Codex as though the run stood behind it. A
    // subdirectory is invisible to that glob without any consumer having to learn a filename rule.
    let keptAt = null;
    if (mode === 'submit') {
      try {
        const dir = path.join(a0.reportsDir, 'rejected');
        fs.mkdirSync(dir, { recursive: true });
        keptAt = confined(dir, `${report?.work_package_id ?? 'unknown'}-attempt${report?.attempt ?? 1}-r${rejections}.json`);
        if (keptAt) writeJson(keptAt, { rejectedAt: nowIso(), errors: allErrors, submitted: report });
      } catch { keptAt = null; /* preserving it must never mask the validation error */ }
    }

    const exhausted = rejections > 1;
    fail(
      `Agent report REJECTED (spec §16.4 — a report must carry evidence, not an assertion):\n` +
        allErrors.map((e) => `  - ${e}`).join('\n') +
        `\n\nSchema: ${path.join(PLUGIN_ROOT, 'schemas', 'agent-report.schema.json')}\n` +
        (keptAt
          ? `What you submitted is kept at ${keptAt} — the coordinator can read what you observed ` +
            `without re-running your verification.\n`
          : '') +
        (exhausted
          ? `This work package has now had ${rejections} rejected reports. Its correction is spent: ` +
            `stop resubmitting and hand it back to the coordinator, which must re-dispatch it ` +
            `(attempt ${rejections} of the §18 ladder) or record it as failed.`
          : `Fix the report and submit it again. This is the only correction for this package; a ` +
            `second invalid report escalates it to the coordinator. Validate without spending it ` +
            `using \`check\` instead of \`submit\`.`),
      7,
    );
  }

  if (mode === 'check') {
    emitJson({ valid: true, workPackage: report.work_package_id });
    return;
  }

  const a = a0;
  const reportId = `${report.work_package_id}-attempt${report.attempt ?? 1}`;
  const stored = confined(a.reportsDir, `${reportId}.json`);
  if (!stored) fail(`Work package id '${report.work_package_id}' does not resolve inside ${a.reportsDir}.`, 7);
  writeJson(stored, { ...report, storedAt: nowIso() });

  mutateState(projectRoot, runId, (s) => {
    const tasksFile = readJson(a.tasks, { tasks: [] });
    const task = (tasksFile.tasks ?? []).find((t) => t.id === report.work_package_id);
    if (task) {
      task.status = report.status === 'success' ? 'reported' : report.status === 'blocked' ? 'failed' : 'reported';
      task.attempts = Math.max(task.attempts ?? 0, report.attempt ?? 1);
      task.reports = [...new Set([...(task.reports ?? []), reportId])];
      writeJson(a.tasks, tasksFile);
    }
  });

  logEvent(projectRoot, runId, {
    // `tierExplicit` marks this as a real attribution derived from the reporting agent's own
    // model, so the aggregator can prefer it over the status-change emitter's placeholder.
    type: 'work_package', tier: tierOf(report), tierExplicit: true, workPackage: report.work_package_id,
    attempt: report.attempt ?? 1, status: report.status, outcome: 'reported',
    filesModified: report.files_modified?.length ?? 0,
  });

  const failedChecks = report.results.filter((r) => !r.passed);
  emitJson({
    accepted: true,
    workPackage: report.work_package_id,
    storedAt: stored,
    status: report.status,
    failedChecks: failedChecks.map((r) => r.check),
    unverified: report.unverified,
    outOfScopeChanges: report.out_of_scope_changes ?? [],
    next:
      failedChecks.length
        ? `Report stored, but ${failedChecks.length} verification(s) failed. The coordinator must decide: remediate or escalate.`
        : 'Report stored. The coordinator performs OPUS_CHECK, then records the outcome with ' +
          `\`state-machine.mjs task --run ${runId} --id ${report.work_package_id} --status accepted|remediating\`. ` +
          'EXECUTION cannot be exited until every package is accepted.',
  });
}

/**
 * A list, whatever the agent actually sent.
 *
 * `x ?? []` only defends against null and undefined. A report whose `evidence` is an *object* —
 * the exact shape a live implementer submitted — sails past it and dies on `.some`, turning the
 * clean, actionable rejection this validator exists to produce into a Node stack trace and exit 1.
 * The comment below already stated the invariant; five call sites did not implement it.
 *
 * A `function` and not a `const` arrow: everything here runs from a call at the top of the file,
 * so a `const` declared down here is in its temporal dead zone when the checks reach it — the
 * same failure `verify-completion.mjs` records, reproduced while fixing this one.
 */
function arr(x) { return Array.isArray(x) ? x : []; }

/**
 * A destination inside the run's reports directory, or `null`.
 *
 * The id comes from the agent and is interpolated into a filename. `../../../../escaped` wrote
 * `projects/escaped-attempt1-r1.json` — outside the run, outside `reports/`, reproduced. The
 * schema now constrains the shape, and this constrains the *result*: the two are not redundant,
 * because the schema is a claim about data and this is a fact about the path that gets written.
 */
function confined(dir, name) {
  const target = path.resolve(dir, name);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

/**
 * Checks the schema cannot express, each aimed at a specific way a report can be technically
 * valid and substantively empty.
 */
function semanticChecks(report) {
  const problems = [];
  // Every field is read defensively: this function runs on reports that have already failed
  // schema validation, so nothing about their shape can be assumed. Crashing here would turn a
  // clean rejection into an opaque exit-1, which is exactly what an agent cannot act on.
  const results = Array.isArray(report?.results) ? report.results : [];

  if (report?.status === 'success' && results.some((r) => r && !r.passed)) {
    problems.push('status is "success" but at least one result is marked failed — reconcile the two.');
  }
  if (arr(report?.files_modified).length && !arr(report?.commands_run).length) {
    problems.push('files were modified but no command was run — a change with no verification is not a result.');
  }
  for (const [i, r] of results.entries()) {
    const expected = String(r?.expected ?? '').trim();
    const observed = String(r?.observed ?? '').trim();
    if (expected === observed && expected.length < 3) {
      problems.push(`results[${i}]: expected/observed are empty placeholders.`);
    }
    if (/^(ok|done|fine|good|yes|pass|passed)$/i.test(observed)) {
      problems.push(`results[${i}]: "${observed}" is an assertion, not an observation. Quote what the command actually printed.`);
    }
  }
  if (arr(report?.evidence).some((e) => String(e ?? '').trim().length < 5)) {
    problems.push('evidence contains an entry too short to be checkable.');
  }
  if (report?.status === 'success' && arr(report?.unverified).length === 0 && arr(report?.risks).length === 0) {
    // Not fatal, but worth surfacing: total certainty is usually incomplete analysis.
    problems.push('status "success" with no unverified items and no risks — state explicitly what you did not verify, even if the answer is a specific "nothing".');
  }
  return problems;
}

/**
 * Spec §15, enforced at runtime rather than only at plan time.
 *
 * Worktrees are forbidden, so parallel implementers share one working tree and the only thing
 * keeping them from destroying each other's work is file ownership. `PLAN_LOCK` checks that the
 * *plan* assigns disjoint ownership; nothing checked that an agent then stayed inside it. The
 * check lives here because a report is where an agent states what it touched — an agent that
 * wrote outside its package has to say so, and saying so has to have a consequence.
 */
function ownershipChecks(report, tasksFile) {
  const task = arr(tasksFile?.tasks).find((t) => t?.id === report?.work_package_id);
  if (!task) return [];
  const owned = new Set([...arr(task.scope?.owned_files), ...arr(task.scope?.files)].map(normalisePath));
  if (owned.size === 0) return [];
  const declared = new Set(arr(report?.out_of_scope_changes).map(normalisePath));
  const escaped = arr(report?.files_modified)
    .map(normalisePath)
    .filter((f) => !owned.has(f) && !declared.has(f));
  if (escaped.length === 0) return [];
  return [
    `files_modified escapes the work package's owned files: ${escaped.join(', ')}. ` +
      `Owned: ${[...owned].join(', ')}. Another agent may be working in the same tree — there is ` +
      `no worktree to isolate you (spec §15). Revert the change, or declare it in ` +
      `out_of_scope_changes with a reason so the coordinator can adjudicate it.`,
  ];
}

function normalisePath(p) {
  return path.normalize(String(p ?? '')).replace(/^\.\//, '');
}

function tierOf(report) {
  const model = String(report.model ?? report.agent ?? '').toLowerCase();
  if (model.includes('fable')) return 'fable';
  if (model.includes('opus')) return 'opus';
  return 'sonnet';
}

async function runAsHook() {
  await runHook(
    'validate-agent-report',
    async (input) => {
      const projectRoot = projectRootFrom(input);
      const runId = input.session_id ? activeRunId(projectRoot, input.session_id) : null;
      if (!runId) return emitAllowStop();

      const state = tryLoadState(projectRoot, runId);
      if (!state) return emitAllowStop();

      // Nothing is counted into a finished run (§S14). Subagents outlive the run's state — the harness
      // keeps them going and no hook can stop them — so without this the closed record kept growing a
      // `subagentsCompleted` for work that had nowhere to go.
      if (refuseIfEnded(projectRoot, runId)) return emitAllowStop();

      // Every finished subagent is counted here. This is the only place the harness tells us a
      // delegation completed, so it is what makes the `maxSubagents` bound real — the counter it
      // replaces was declared and never incremented, so that circuit breaker could never trip.
      try {
        mutateState(projectRoot, runId, (s) => { s.counters.subagentsCompleted = (s.counters.subagentsCompleted ?? 0) + 1; });
      } catch { /* accounting must never block a subagent from finishing */ }

      if (state.phase !== 'EXECUTION') return emitAllowStop();

      // The hook is registered with an empty matcher, so it fires for *every* subagent in the
      // session — an `Explore`, a `general-purpose` researcher, anything the user runs
      // alongside. Only an implementer owes a work-package report, and the reminder below is
      // one-shot per package: letting an unrelated agent's stop consume it silently disarmed
      // §16.4 for the package that actually needed it.
      const agentType = String(input.agent_type ?? input.subagent_type ?? '');
      if (agentType && !/implementer/i.test(agentType)) return emitAllowStop();

      const a = artifacts(projectRoot, runId);
      const tasks = readJson(a.tasks, { tasks: [] }).tasks ?? [];
      const inProgress = tasks.filter((t) => t.status === 'in_progress');

      // Only act when the attribution is unambiguous — see the note at the top of this file.
      if (inProgress.length !== 1) return emitAllowStop();
      const task = inProgress[0];
      if ((task.reports ?? []).length > 0) return emitAllowStop();

      // One correction per package, shared with the `submit` rejection counter: §16.4 grants a
      // single retry for the package, not one per channel that can notice the problem.
      if (Number(state.reportRejections?.[task.id]) > 0) return emitAllowStop();
      mutateState(projectRoot, runId, (s) => {
        s.reportRejections = { ...(s.reportRejections ?? {}) };
        s.reportRejections[task.id] = (Number(s.reportRejections[task.id]) || 0) + 1;
      });
      logEvent(projectRoot, runId, { type: 'report_rejected', workPackage: task.id, reason: 'no report submitted' });

      emitBlock(
        `HYPERPOWERS — work package ${task.id} finished without submitting a report.\n\n` +
          `A Hyperpowers agent may not end with "Done." It must return evidence (spec §16.4): ` +
          `status, files read, files modified, commands run, expected-versus-observed results, ` +
          `what was NOT verified, risks, evidence, and a recommendation.\n\n` +
          `Write the report as JSON matching ` +
          `${path.join(PLUGIN_ROOT, 'schemas', 'agent-report.schema.json')} and submit it:\n` +
          `  node "${PLUGIN_ROOT}/scripts/validate-agent-report.mjs" submit --run ${runId} --file <report.json>\n\n` +
          `This is the only automatic reminder for ${task.id}.`,
      );
    },
    () => emitAllowStop(),
    { budgetMs: 16_000 }, // SubagentStop is declared at 20 s in hooks.json
  );
}
