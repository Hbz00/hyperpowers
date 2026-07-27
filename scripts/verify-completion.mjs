#!/usr/bin/env node
/**
 * Gate verification (spec §10.4, §12, §13).
 *
 * The central claim of spec §13 is that green tests do not mean finished — they may only mean
 * the missing behaviour is untested. Each gate is therefore evaluated mechanically here, and
 * Fable is handed a result rather than an argument. A condition that cannot be evaluated is
 * reported `unverifiable` rather than quietly counted as a pass.
 *
 *   verify-completion.mjs --gate design|plan|completion [--run <id>]
 *
 * Exit 0 when the gate passes, 6 when it fails.
 */

import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, fail, emitJson, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { artifacts, PLUGIN_ROOT } from './lib/paths.mjs';
import { validate } from './lib/validate.mjs';
import { readJson, readText, nowIso } from './lib/io.mjs';
import { loadState, mutateState } from './lib/state.mjs';
import { REVIEW_ROUNDS, EXTRA_ROUNDS, ALL_ROUNDS } from './lib/phases.mjs';
import { logEvent } from './lib/telemetry.mjs';
import { gitLines } from './lib/review-pack.mjs';
import { splitByBaseline, HYPERPOWERS_OWN_FILES } from './lib/workspace.mjs';

const { flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const runId = resolveRunId(projectRoot, flags);
if (!runId) fail(`No Hyperpowers run found for ${projectRoot}.`);
const gate = flags.gate;
if (!['design', 'plan', 'completion'].includes(gate)) fail('--gate must be design, plan or completion.');

const a = artifacts(projectRoot, runId);
const state = loadState(projectRoot, runId);
const conditions = [];
const add = (id, description, status, detail = '') => conditions.push({ id, description, status, detail });

/**
 * Everything runs from `main()`, called at the very bottom of this module, and that placement is
 * load-bearing rather than stylistic.
 *
 * The gates used to be dispatched here, at the top. A `const` declared further down the file is
 * in its temporal dead zone until execution reaches it, so `changedFiles()` — three hundred lines
 * below — threw `ReferenceError: Cannot access 'HYPERPOWERS_OWN_FILES' before initialization` the
 * moment it got as far as consulting that set. It only got that far when Git answered, which is
 * to say **only inside a real repository**: every fixture in the suite is a plain temporary
 * directory, so `changedFiles()` returned `null` early and the crash was invisible to 358 passing
 * tests and to four rounds of review.
 *
 * The consequence was total. `verify-completion.mjs` is the only writer of the completion
 * verdict, `FINAL_ACCEPTANCE` cannot be left without one, so in the environment Hyperpowers is
 * built for, no run could ever have reached `COMPLETE`.
 *
 * Hoisting the one constant would have fixed the instance. Calling `main()` last fixes the class:
 * every declaration in the file is initialised before any of it runs, and the next constant
 * someone adds at the bottom cannot resurrect this.
 */
function main() {
  const GATES = { design: designGate, plan: planGate, completion: completionGate };
  GATES[gate]();

  const failed = conditions.filter((c) => c.status === 'fail');
  const unverifiable = conditions.filter((c) => c.status === 'unverifiable');
  const passed = failed.length === 0;

  const result = {
    gate,
    complete: passed,
    evaluatedAt: nowIso(),
    conditions,
    openBlockers: (state.openBlockers ?? []).map((b) => (typeof b === 'string' ? b : `${b.id} (${b.round}): ${b.reason}`)),
    residualRisks: (state.residualRisks ?? []).map((r) =>
      typeof r === 'string' ? r : `${r.risk}${r.source ? ` (${r.source})` : ''}`),
  };

  try {
    mutateState(projectRoot, runId, (s) => {
      s.gates[gate] = { passed, at: result.evaluatedAt, reason: passed ? null : failed.map((f) => f.id).join(', '), evidence: `${conditions.filter((c) => c.status === 'pass').length}/${conditions.length} conditions passed` };
    });
    logEvent(projectRoot, runId, { type: 'gate', gate, passed, failed: failed.map((f) => f.id) });
  } catch { /* gate recording must not mask the result */ }

  emitJson({
    ...result,
    summary: `${conditions.filter((c) => c.status === 'pass').length} passed, ${failed.length} failed, ` +
      `${conditions.filter((c) => c.status === 'not_applicable').length} not applicable, ${unverifiable.length} unverifiable.`,
    verdict: passed
      ? unverifiable.length
        ? `Gate '${gate}' PASSED, with ${unverifiable.length} condition(s) that could not be verified. Treat those as residual risk and state them explicitly in the decision.`
        : `Gate '${gate}' PASSED.`
      : `Gate '${gate}' FAILED on: ${failed.map((f) => f.id).join(', ')}. Do not proceed; remediate or transition to BLOCKED.`,
  });

  process.exit(passed ? 0 : 6);
}

// ------------------------------------------------------------------- gates ----

function reviewRoundsFor(artifact) {
  return Object.entries(REVIEW_ROUNDS).filter(([, r]) => r.artifact === artifact).map(([name]) => name);
}

/**
 * Rounds this gate must account for: the mandatory ones always, plus any §18 extra round that
 * actually ran.
 *
 * An extra round is optional to *run* and mandatory to *answer*. Scoping this loop to the six
 * meant a `<artifact>-extra` round could raise a critical blocking finding, have it adjudicated
 * by nobody, and the gate would pass — verified. That is the worst possible place for the hole,
 * because §18 only sanctions an extra round when round 2 has already surfaced a *new blocker*:
 * every finding it produces is, by construction, from the situation the breaker exists for.
 */
function roundsToAccountFor(artifact) {
  const mandatory = reviewRoundsFor(artifact);
  const extras = Object.entries(EXTRA_ROUNDS)
    .filter(([name, r]) => r.artifact === artifact && readJson(a.review(name), null))
    .map(([name]) => name);
  return [...mandatory, ...extras];
}

/** Shared across all three gates: every round ran, everything decided, nothing left open. */
function checkReviewCycle(artifact) {
  for (const round of roundsToAccountFor(artifact)) {
    const review = readJson(a.review(round), null);
    if (!review || review.status !== 'completed') {
      add(`review-${round}`, `Codex round ${round} completed`, 'fail', review ? `status=${review.status}: ${review.reason ?? ''}` : 'no review artefact');
      continue;
    }
    add(`review-${round}`, `Codex round ${round} completed`, 'pass', `${review.model} @ ${review.effort}, verdict ${review.verdict}, ${review.findings.length} findings`);

    const decisions = state.adjudications?.[round]?.decisions ?? [];
    const decided = new Set(decisions.map((d) => d.finding_id));
    const undecided = review.findings.filter((f) => !decided.has(f.id)).map((f) => f.id);
    add(`adjudicated-${round}`, `Every ${round} finding adjudicated`, undecided.length ? 'fail' : 'pass',
      undecided.length ? `undecided: ${undecided.join(', ')}` : `${decisions.length} decisions recorded`);

    const unresolved = decisions.filter((d) => d.decision === 'accepted' && !d.resolved).map((d) => d.finding_id);
    add(`resolved-${round}`, `Accepted ${round} corrections proven applied`, unresolved.length ? 'fail' : 'pass',
      unresolved.length ? `not proven resolved: ${unresolved.join(', ')}` : 'all accepted corrections carry resolution evidence');
  }

  // Scoped to this artefact's own rounds: the design gate has no business failing on an
  // implementation blocker that does not exist yet, and reporting one there is misleading.
  // `ALL_ROUNDS`, not just the mandatory six — a blocker raised by the §18 extra round belongs
  // to its artefact as much as one from round 2, and scoping by the six alone filtered it out
  // of the very gate meant to see it.
  const rounds = new Set(Object.entries(ALL_ROUNDS).filter(([, r]) => r.artifact === artifact).map(([name]) => name));
  const open = (state.openBlockers ?? []).filter((b) => typeof b === 'string' || rounds.has(b.round));
  add(`no-open-blockers-${artifact}`, `No accepted blocking ${artifact} finding remains open`, open.length ? 'fail' : 'pass',
    open.length ? open.map((b) => (typeof b === 'string' ? b : `${b.id}: ${b.reason}`)).join('; ') : 'none');
}

function designGate() {
  const design = readText(a.design, '');
  add('design-exists', 'A design document exists', design.length > 200 ? 'pass' : 'fail', `${design.length} bytes`);

  const criteria = extractCriteria(design);
  add('acceptance-criteria', 'The design states acceptance criteria', criteria.length ? 'pass' : 'fail',
    criteria.length ? `${criteria.length} criteria: ${criteria.map((c) => c.id).join(', ')}` : 'no criteria of the form "AC-<n>: ..." were found');

  // A criterion that cannot fail cannot gate anything (Codex flagged exactly this class of
  // defect in testing, which is why it is checked mechanically too).
  const vague = criteria.filter((c) => isUnfalsifiable(c.statement));
  add('criteria-falsifiable', 'Acceptance criteria are observable and falsifiable', vague.length ? 'fail' : 'pass',
    vague.length
      ? `not falsifiable — no observable outcome stated: ${vague.map((c) => c.id).join(', ')}`
      : 'each criterion states an observable outcome');

  add('non-goals', 'The design states explicit non-goals', /non[- ]goals?|out of scope/i.test(design) ? 'pass' : 'fail',
    'scope boundaries prevent drift during execution (spec §5.1)');

  checkReviewCycle('design');
}

function planGate() {
  const plan = readText(a.plan, '');
  const tasks = readJson(a.tasks, { tasks: [] }).tasks ?? [];
  const design = readText(a.design, '');
  const criteria = extractCriteria(design);

  add('plan-exists', 'A plan document exists', plan.length > 200 ? 'pass' : 'fail', `${plan.length} bytes`);
  add('tasks-exist', 'The plan is decomposed into work packages', tasks.length ? 'pass' : 'fail', `${tasks.length} packages`);

  /**
   * Spec §3.2: a Sonnet never receives "implement this part of the plan", it receives a
   * self-contained contract. `work-package.schema.json` states that contract in eight required
   * parts — and had no code consumer anywhere. The gate checked coverage, verifiability,
   * dependencies and ownership, which are the properties it needed for its *own* reasoning, and
   * never asked whether the package a Sonnet would actually be handed was complete. A package
   * carrying an id, one criterion and a command passed this gate while lacking its objective,
   * interfaces, constraints and exclusions — the whole reason the contract exists.
   *
   * The failure is reported per package with the specific missing field, because "invalid" sends
   * the coordinator back to guess and a named field sends it back to fix.
   */
  {
    const schemaPath = path.join(PLUGIN_ROOT, 'schemas', 'work-package.schema.json');
    const schema = readJson(schemaPath, null);
    const invalid = schema
      ? tasks.map((t, i) => ({ id: t?.id ?? `#${i + 1}`, errors: validate(t, schema).errors }))
        .filter((r) => r.errors.length)
      : [];
    add('tasks-well-formed', 'Every work package is a complete delegation contract (spec §3.2)',
      !schema ? 'unverifiable' : tasks.length === 0 ? 'fail' : invalid.length ? 'fail' : 'pass',
      !schema
        ? `the work-package schema could not be read at ${schemaPath}`
        : tasks.length === 0
          ? 'no work packages to check'
          : invalid.length
            ? invalid.map((r) => `${r.id}: ${r.errors.slice(0, 4).join('; ')}`).join(' | ')
            : `${tasks.length} package(s) match work-package.schema.json`);
  }

  // Spec §12 phase 3: every acceptance criterion must be covered by at least one task.
  // Canonicalised on both sides: the design and the plan are written by different agents, and a
  // package claiming `AC1` must satisfy a design that wrote `AC-1`.
  const covered = new Set(tasks.flatMap((t) => t.acceptance_criteria ?? []).map(canonicalCriterionId));
  const uncovered = criteria.filter((c) => !covered.has(c.id)).map((c) => c.id);
  add('criteria-covered', 'Every acceptance criterion is covered by a work package',
    criteria.length === 0 ? 'unverifiable' : uncovered.length ? 'fail' : 'pass',
    criteria.length === 0 ? 'no criteria could be extracted from the design' : uncovered.length ? `uncovered: ${uncovered.join(', ')}` : `${criteria.length} criteria covered`);

  const unverifiableTasks = tasks.filter((t) => !(t.verification?.commands ?? []).length && !t.verification?.method).map((t) => t.id);
  add('tasks-verifiable', 'Every work package carries a verification method', unverifiableTasks.length ? 'fail' : 'pass',
    unverifiableTasks.length ? `no verification: ${unverifiableTasks.join(', ')}` : 'all packages verifiable');

  const ids = new Set(tasks.map((t) => t.id));
  const danglingDeps = tasks.flatMap((t) => (t.depends_on ?? []).filter((d) => !ids.has(d)).map((d) => `${t.id}→${d}`));
  add('dependencies-resolve', 'Task dependencies reference existing tasks', danglingDeps.length ? 'fail' : 'pass',
    danglingDeps.length ? `dangling: ${danglingDeps.join(', ')}` : 'all dependencies resolve');

  const cycle = findCycle(tasks);
  add('dependencies-acyclic', 'Task dependencies are acyclic', cycle ? 'fail' : 'pass', cycle ? `cycle: ${cycle.join(' → ')}` : 'no cycles');

  // Spec §15: parallel writers must own disjoint files, or they corrupt each other's work.
  const conflicts = fileOwnershipConflicts(tasks);
  add('parallel-safety', 'Packages marked parallel-safe own disjoint files', conflicts.length ? 'fail' : 'pass',
    conflicts.length ? conflicts.join('; ') : 'no overlapping ownership among parallel packages');

  checkReviewCycle('plan');
}

function completionGate() {
  const evidence = readJson(a.evidence, null);
  const design = readText(a.design, '');
  const criteria = extractCriteria(design);
  const tasks = readJson(a.tasks, { tasks: [] }).tasks ?? [];

  // Conditions are numbered to match spec §13 so a failure is traceable to the contract.
  const unproven = (evidence?.criteria ?? []).filter((c) => c.status !== 'satisfied' || !(c.evidence ?? []).length);
  add('13.1-criteria-proven', 'Every acceptance criterion has evidence',
    !evidence ? 'fail' : unproven.length ? 'fail' : 'pass',
    !evidence ? 'evidence.json is missing' : unproven.length ? `without proof: ${unproven.map((c) => c.id).join(', ')}` : `${evidence.criteria.length} criteria proven`);

  const proven = new Set((evidence?.criteria ?? []).map((e) => canonicalCriterionId(e.id)));
  const missingFromEvidence = criteria.filter((c) => !proven.has(c.id)).map((c) => c.id);
  add('13.1b-criteria-complete', 'The evidence matrix covers every design criterion',
    criteria.length === 0 ? 'unverifiable' : missingFromEvidence.length ? 'fail' : 'pass',
    missingFromEvidence.length ? `absent from evidence.json: ${missingFromEvidence.join(', ')}` : 'complete');

  // Spec §13 condition 2 is "tous les tests requis passent" — every suite the verifier ran, not
  // just the unit suite. Checking only `unit-tests` meant a recorded `integration-tests: fail`
  // or `e2e-tests: fail` passed the gate: the evidence schema and the verifier agent both cover
  // those names, so the gate was narrower than the artefact it gates.
  const TEST_CHECKS = ['unit-tests', 'integration-tests', 'e2e-tests', 'regression'];
  {
    const present = (evidence?.checks ?? []).filter((c) => TEST_CHECKS.includes(c.name));
    const failing = present.filter((c) => c.status !== 'pass' && c.status !== 'absent');
    add('13.2-tests', 'Every recorded test suite passes',
      present.length === 0 ? 'unverifiable' : failing.length ? 'fail' : 'pass',
      present.length === 0
        ? 'no test suite was recorded in the evidence matrix'
        : failing.length
          ? `failing: ${failing.map((c) => `${c.name} (${c.command} → ${c.status})`).join('; ')}`
          : `${present.map((c) => c.name).join(', ')} all pass`);
  }

  for (const [num, name, label] of [
    ['13.3', 'build', 'The build passes where one exists'],
    ['13.4a', 'lint', 'Lint passes where it exists'],
    ['13.4b', 'typecheck', 'Typecheck passes where it exists'],
    ['13.4c', 'runtime', 'Runtime behaviour was exercised where applicable'],
  ]) {
    const check = (evidence?.checks ?? []).find((c) => c.name === name);
    add(`${num}-${name}`, label,
      !check ? 'unverifiable' : check.status === 'pass' ? 'pass' : check.status === 'absent' ? 'not_applicable' : 'fail',
      check ? `${check.command} → ${check.status}` : 'not recorded in the evidence matrix');
  }

  const failingBefore = evidence?.failing_before_fix ?? [];
  add('13.5-tests-failed-before', 'Added tests demonstrably failed before the change',
    failingBefore.length ? 'pass' : 'unverifiable',
    failingBefore.length ? `${failingBefore.length} recorded` : 'not recorded; a test that never failed may not test anything');

  const open = state.openBlockers ?? [];
  const criticalOpen = open.filter((b) => typeof b === 'object' && b.severity === 'critical');
  add('13.6-no-open-critical', 'No accepted critical finding is open', criticalOpen.length ? 'fail' : 'pass',
    criticalOpen.length ? criticalOpen.map((b) => b.id).join(', ') : 'none');
  add('13.7-no-open-blocking-high', 'No accepted blocking finding is open', open.length ? 'fail' : 'pass',
    open.length ? open.map((b) => (typeof b === 'string' ? b : b.id)).join(', ') : 'none');

  checkReviewCycle('implementation');

  const residue = evidence?.residue ?? {};
  const residueFound = Object.entries(residue).filter(([, v]) => Array.isArray(v) && v.length);
  add('13.9-no-residue', 'No unintended TODO, placeholder or mock remains',
    !evidence ? 'unverifiable' : residueFound.length ? 'fail' : 'pass',
    residueFound.map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || 'clean');

  const ownedFiles = new Set(tasks.flatMap((t) => [...(t.scope?.owned_files ?? []), ...(t.scope?.files ?? [])]).map(normalise));
  const changed = changedFiles();
  const { preExisting, byTheRun } = splitByBaseline(state.workspaceBaseline, changed ?? [], projectRoot);
  const outOfScope = byTheRun.filter((f) => !ownedFiles.has(normalise(f)));
  const baselineNote = preExisting.length
    ? ` ${preExisting.length} file(s) were already modified when the run started and are unchanged since, ` +
      `so they are not this run's doing: ${preExisting.slice(0, 6).join(', ')}${preExisting.length > 6 ? ` (+${preExisting.length - 6} more)` : ''}.`
    : '';
  add('13.10-no-out-of-scope-changes', 'No file was modified outside the planned scope',
    changed === null ? 'unverifiable' : outOfScope.length ? 'fail' : 'pass',
    changed === null
      ? 'Git could not report the changed files, so scope drift could not be checked'
      : outOfScope.length
        ? `unplanned: ${outOfScope.slice(0, 12).join(', ')}${outOfScope.length > 12 ? ` (+${outOfScope.length - 12} more)` : ''}.${baselineNote}`
        : `${byTheRun.length} file(s) changed by this run, all owned by a work package.${baselineNote}`);

  // Spec §13 condition 11 asks whether a mutation was *executed*, not whether one was attempted.
  // Only `git-guard.mjs` can answer that: it fingerprints the repository after every Bash call
  // and records `policy_violation` when the state actually changed. A `policy_blocked` event
  // means the PreToolUse hook stopped an attempt before it ran — the control working, not a
  // breach — and counting those here made a single blocked `git commit` (or even a blocked
  // `Workflow` call) fail the gate permanently, since telemetry is append-only.
  const executed = readEvents().filter((e) => e.type === 'policy_violation');
  const blocked = readEvents().filter((e) => e.type === 'policy_blocked');
  add('13.11-no-git-mutation', 'No Git mutation was executed', executed.length ? 'fail' : 'pass',
    executed.length
      ? `${executed.length} mutation(s) detected after the fact: ${executed.map((e) => (e.drift ?? []).join('; ')).join(' | ')}`
      : `repository state never changed${blocked.length ? ` (${blocked.length} attempt(s) blocked before execution — the policy held)` : ''}`);

  const fallbacks = readEvents().filter((e) => e.type === 'fallback');
  // A fallback is concealed when it happened but the review record does not name the model that
  // actually answered. Comparing the two is what makes this condition falsifiable; asserting
  // "pass" unconditionally, as it did, made it decorative.
  const unrecorded = fallbacks.filter((f) => {
    const review = readJson(a.review(f.round), null);
    return !review || (review.model !== f.to && review.status === 'completed');
  });
  add('13.12-no-hidden-fallback', 'No model fallback was concealed',
    unrecorded.length ? 'fail' : 'pass',
    unrecorded.length
      ? `fallback(s) whose review does not record the substituted model: ${unrecorded.map((f) => `${f.round} ${f.from}→${f.to}`).join(', ')}`
      : fallbacks.length
        ? `${fallbacks.length} fallback(s), each recorded on its review: ${fallbacks.map((f) => `${f.round} ${f.from}→${f.to}`).join(', ')}`
        : 'no fallbacks occurred');

  const mismatch = readEvents().filter((e) => e.type === 'model_mismatch');
  add('13.12b-director-model', 'The director tier ran on the configured model',
    mismatch.length ? 'fail' : state.observedDirectorModel ? 'pass' : 'unverifiable',
    mismatch.length ? `observed ${mismatch[0].observed}, expected ${mismatch[0].expected}` : state.observedDirectorModel ?? 'not observed');

  // Spec §13 condition 13. This cannot verify that Fable *judged* well — no mechanism can — but
  // it can verify the run actually reached the gate through the director's phase rather than
  // arriving at COMPLETE from somewhere else, and that the transition was attributed. Leaving it
  // out entirely made "Fable gives final acceptance" the one condition with no check at all.
  {
    const arrivals = (state.history ?? []).filter((h) => h.to === 'FINAL_ACCEPTANCE');
    // Passing after COMPLETE too keeps the gate idempotent: re-running it to audit a finished
    // run must not rewrite its own verdict to a failure.
    const atGate = state.phase === 'FINAL_ACCEPTANCE' || state.phase === 'COMPLETE';
    const decided = arrivals.length > 0 && atGate;
    add('13.13-fable-acceptance', 'The run reached the director gate for a final decision',
      decided ? 'pass' : 'fail',
      decided
        ? `entered FINAL_ACCEPTANCE ${arrivals.length}× (last actor: ${arrivals.at(-1).actor ?? 'unrecorded'})`
        : `the completion gate is only meaningful once the run has reached FINAL_ACCEPTANCE ` +
          `(current phase: ${state.phase}, arrivals: ${arrivals.length})`);
  }

  /**
   * The condition claimed to verify publication *as an Artifact* and in fact verified that a
   * non-empty string had been recorded. A live run satisfied it with a `mermaid.live` link and
   * passed — the diagram was real and product-oriented, but no Artifact existed and no claude.ai
   * page ever opened.
   *
   * Enforcing a `claude.ai` URL is not the right fix: Artifact publishing may simply be
   * unavailable in a headless session, and failing a finished run over the rendering host would
   * punish the environment rather than the work. So the check accepts either and **says which**,
   * because the alternative to a checkable claim is an honest one, not a louder one.
   */
  {
    const url = state.artifacts?.diagramUrl ?? null;
    const isArtifact = typeof url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*claude\.ai\//i.test(url);
    add('13.14-product-diagram', 'A product diagram was published and its URL recorded',
      url ? 'pass' : 'fail',
      !url
        ? 'record it with `state-machine.mjs artifact --name diagramUrl` once published (spec §13 condition 14)'
        : isArtifact
          ? `published as an Artifact: ${url}`
          : `recorded, but not as an Artifact — this is a fallback rendering, so no shareable ` +
            `Artifact page exists for this run: ${url}`);
  }
}

// ----------------------------------------------------------------- helpers ----

/**
 * A criterion is unfalsifiable when it leans on a vague quality word and offers nothing
 * observable to check it against.
 *
 * The earlier form anchored the vague word to the end of the statement, so it caught only the
 * most obvious cases: "the limiter works" failed, but "the limiter works correctly under
 * concurrent load", "handles errors properly in all cases" and "performance is fast enough"
 * all passed — a check that advertised falsifiability while missing most of what it exists to
 * catch. Now the vague word is looked for anywhere, and a concrete anchor rescues the
 * criterion: a number, a status code, an identifier in backticks, a quoted literal, or a
 * comparison. That keeps "returns HTTP 429 quickly when the budget is exceeded" passing while
 * failing "it is fast".
 */
function isUnfalsifiable(statement) {
  const text = String(statement ?? '').trim();
  if (!text) return true;
  const vague = /\b(works?|working|correct(ly)?|good|fast|quick(ly)?|reliabl[ey]|robust|properly|appropriately|as expected|seamless(ly)?|efficient(ly)?|user[- ]friendly|performant|sensible|reasonable)\b/i;
  if (!vague.test(text)) return false;
  const anchored =
    /\d/.test(text) ||                       // a count, a code, a duration, a threshold
    /`[^`]+`/.test(text) ||                  // a named identifier
    /["'][^"']+["']/.test(text) ||           // a literal value
    /\b(returns?|responds?|raises?|emits?|logs?|equals?|contains?|within|at most|at least|no more than|fewer than|greater than|less than|exactly)\b/i.test(text);
  return !anchored;
}

/**
 * Canonical form of a criterion id.
 *
 * `AC1`, `AC-1`, `AC 1` and `ac-01` all name the same criterion, and which spelling a document
 * happens to use must not decide whether a run can complete. Measured on the first pilot run:
 * the design coordinator wrote sixteen criteria as `**AC1 — …**`, the extractor required a
 * literal `AC-1:`, and so the design gate saw **zero** criteria in a document that stated
 * sixteen. Two of the three criterion conditions then reported `unverifiable` and the third
 * failed outright — over a hyphen.
 *
 * Canonicalising here rather than loosening each comparison is what keeps the sides consistent:
 * the design states the ids, `tasks.json` claims coverage of them and `evidence.json` proves
 * them, and all three are written by different agents at different times.
 */
function canonicalCriterionId(value) {
  const m = /^\s*ac[-\s_]?0*(\d+)\s*$/i.exec(String(value ?? ''));
  return m ? `AC-${m[1]}` : String(value ?? '').trim().toUpperCase();
}

function extractCriteria(markdown) {
  const out = [];
  const seen = new Set();
  // Bullet and bold markers optional; `AC1`/`AC-1`/`AC 1` all accepted; separated from the
  // statement by a colon, a full stop, or any of the dashes a writer might reach for.
  const re = /^\s*[-*]?\s*\**\s*(AC[-\s]?\d+)\s*\**\s*[:.—–-]\s*\**\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(markdown))) {
    const id = canonicalCriterionId(m[1]);
    if (seen.has(id)) continue; // a criterion restated later is the same criterion
    seen.add(id);
    out.push({ id, statement: m[2].replace(/\*\*/g, '').trim() });
  }
  return out;
}

function findCycle(tasks) {
  const graph = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]));
  const state = new Map();
  const stack = [];
  let cycle = null;
  const visit = (id) => {
    if (cycle) return;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      cycle = [...stack.slice(stack.indexOf(id)), id];
      return;
    }
    state.set(id, 'open');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) if (graph.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of graph.keys()) visit(id);
  return cycle;
}

function fileOwnershipConflicts(tasks) {
  const parallel = tasks.filter((t) => t.parallel_safe);
  const conflicts = [];
  for (let i = 0; i < parallel.length; i += 1) {
    for (let j = i + 1; j < parallel.length; j += 1) {
      const a1 = new Set((parallel[i].scope?.owned_files ?? []).map(normalise));
      const overlap = (parallel[j].scope?.owned_files ?? []).map(normalise).filter((f) => a1.has(f));
      if (overlap.length) conflicts.push(`${parallel[i].id} and ${parallel[j].id} both own ${overlap.join(', ')}`);
    }
  }
  return conflicts;
}

function normalise(p) {
  return path.normalize(String(p)).replace(/^\.\//, '');
}

/**
 * Files changed in the working tree, or `null` when Git cannot tell us.
 *
 * `null` and `[]` mean different things and must not be conflated: `[]` is "nothing changed",
 * `null` is "we could not find out", and only the first of those can justify passing a
 * scope-drift check.
 */
/**
 * Files Hyperpowers itself writes into the working tree. They are not the feature's changes and
 * no work package will ever own them, so counting them as scope drift would fail condition
 * §13.10 on every project where `/hyperpowers:setup` did its job.
 */
const OWN_FILES = new Set(HYPERPOWERS_OWN_FILES);

function changedFiles() {
  const tracked = gitLines(projectRoot, ['diff', '--name-only', 'HEAD']);
  const untracked = gitLines(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  if (tracked === null && untracked === null) return null;
  return [...(tracked ?? []), ...(untracked ?? [])].filter((f) => !OWN_FILES.has(normalise(f)));
}

function readEvents() {
  try {
    return fs.readFileSync(a.telemetry, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return {}; }
    });
  } catch {
    return [];
  }
}

// Last line on purpose — see the comment on `main`. Nothing may be declared below this.
main();
