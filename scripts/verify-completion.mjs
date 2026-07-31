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
import { loadConfig } from './lib/config.mjs';
import { readJson, readText, nowIso } from './lib/io.mjs';
import { loadState, mutateState, gateInputDigest, refuseIfEnded, reviewedArtifactDigest } from './lib/state.mjs';
import { REVIEW_ROUNDS, EXTRA_ROUNDS, ALL_ROUNDS } from './lib/phases.mjs';
import { logEvent } from './lib/telemetry.mjs';
import { gitPathsZ } from './lib/review-pack.mjs';
import { directorTier } from './lib/transcript.mjs';
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
 * Conditions whose own text offers the director a choice, and which therefore have to see one made.
 *
 * Scoped deliberately, and narrowly. Most `unverifiable` statuses mean *the environment could not
 * answer*: no runtime check is declared, Git is unavailable, the transcript is absent, the review
 * predates artefact-version recording. Asking for a residual risk about "Git could not be queried" is
 * noise, and noise is how a real signal gets ignored — the same argument that scoped the drift check to
 * the last round in the first place.
 *
 * What belongs here is the one condition that says *"State the change as residual risk, or run an extra
 * round"*: a promise the gate makes on the director's behalf, which nothing checked. An id registers
 * itself at the point that promise is printed, so the two cannot drift apart.
 *
 * The value anchors the statement in time: `{ file }` for a condition about a document (the
 * statement must postdate the document's last edit), or `{ at }` for a condition about something
 * with no single file — the implementation tree, an unobservable tier — where the honest floor is
 * the timestamp of the fact the statement discharges. A citation is a token, and a token with no
 * version behind it discharges its condition for ever: state the risk once, then keep editing the
 * document, and the gate stays satisfied by a sentence describing a change two edits ago. Comparing
 * the statement's timestamp against the anchor is the same invariant as `gateInputDigest` — a claim
 * does not carry over to a state it was not made about — using only fields that already exist.
 */
const mustBeStated = new Map();

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
  dischargeUnverifiable();

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
    // Evaluate always — re-running this to audit a finished run is legitimate and must keep
    // working. **Record only while the run is live.** On an aborted run this wrote `state.gates`
    // three times, seven to nine minutes after the end, from a coordinator nobody could stop: a
    // closed record was still being appended to. Reporting is auditing; recording is writing.
    const live = !refuseIfEnded(projectRoot, runId);
    if (live) {
      mutateState(projectRoot, runId, (s) => {
      // Digested from `state` — the object the conditions were actually evaluated against — and never
      // from the one `mutateState` reloads. Another agent may have recorded a blocker in between, and
      // hashing *that* would stamp this verdict with a fingerprint of inputs it never judged: exactly
      // what the digest exists to make impossible. Binding the judged state instead means a
      // concurrent change simply makes the stored verdict stale, and the transition refuses it until
      // the verifier has run again.
      //
      // `unverifiable` is tolerated by the gate but must not vanish with it. The contract says the
      // director may accept such a condition *as stated residual risk*; storing only a pass/fail and
      // a count left nothing for the report to state, so the acceptance existed only in whatever the
      // director happened to write. The ids are cheap and make the toleration auditable.
        s.gates[gate] = {
          passed,
          at: result.evaluatedAt,
          inputs: gateInputDigest(projectRoot, runId, state, gate),
          reason: passed ? null : failed.map((f) => f.id).join(', '),
          unverifiable: unverifiable.map((c) => `${c.id}: ${c.detail ?? 'no detail'}`),
          evidence: `${conditions.filter((c) => c.status === 'pass').length}/${conditions.length} conditions passed`,
        };
      });
      logEvent(projectRoot, runId, { type: 'gate', gate, passed, failed: failed.map((f) => f.id) });
    }
  } catch { /* gate recording must not mask the result */ }

  // Drop the static label; keep every measurement.
  //
  // The only reader of this output is the director — a subagent whose context is billed on Fable
  // and, because a subagent's prompt cache dies after five minutes of idling, rewritten in full on
  // every resumption. Run 7 kept **38k characters** of gate output in that context across four
  // calls, the single largest contributor to it.
  //
  // The first attempt at this stripped `detail` from passing conditions too, and it was wrong: a
  // pass often *is* the measurement. `13.12b-director-model` passes and its detail names the model
  // and effort actually observed; `criteria-covered` passes and its detail says how many criteria
  // matched. Removing those would have saved bytes by deleting the answer. `description` is a fixed
  // label derivable from the id and repeated verbatim on every call — that, and only that, goes.
  const terse = ({ description, ...rest }) => rest;

  emitJson({
    ...result,
    conditions: conditions.map(terse),
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

/**
 * Every `unverifiable` condition must be discharged by one of the two branches the gate offers.
 *
 * The gate has always said an unverifiable condition is acceptable *as stated residual risk* — "State
 * the change as residual risk, or run an extra round." Runs 7 and 8 each locked two artefacts that had
 * moved after their last review, all four gates reported it, and all four passed. Run 8's archive says
 * what happened next: four residual risks recorded, sourced `DESIGN-002`, `PLAN-004`, `PLAN-006`,
 * `IMPL-001` — every one a finding the director would have recorded anyway, and **not one citing the
 * drift**. `extraReviews: {}` both runs, so the other branch was not taken either.
 *
 * The disjunction was offered and neither side of it performed. That is not §18 being too permissive;
 * §18's extra round is deliberately optional, because forcing a Codex round onto every typo fix is the
 * cost this avoided in the first place. It is the *cheaper* branch having no mechanical form, so it
 * read as free.
 *
 * `risk --add --source` already exists, so the discharge is one command and one entry somebody can
 * read. The status of the unverifiable condition itself is deliberately unchanged: what fails is the
 * absence of a decision about it, which is the thing the contract asked for and nothing checked.
 */
function dischargeUnverifiable() {
  const open = conditions.filter((c) => c.status === 'unverifiable' && mustBeStated.has(c.id));
  if (open.length === 0) return;

  // Matched on the citation, not on prose: a risk that happens to mention the same words is not a
  // decision about this condition. `--source` is the field that makes the link checkable — and the
  // anchor is what stops the link outliving what it described.
  const bySource = new Map();
  for (const r of state.residualRisks ?? []) {
    if (typeof r === 'string' || !r.source) continue;
    bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  }

  const stale = [];
  const undischarged = [];
  for (const c of open) {
    const risks = bySource.get(c.id);
    if (!risks) { undischarged.push(c.id); continue; }
    const anchor = mustBeStated.get(c.id) ?? {};
    // Three anchor kinds, in increasing strength. A `file` anchor compares the statement's
    // timestamp against the document's last edit; an `at` anchor against the moment the
    // discharged fact was established; a `digest` anchor requires the statement to have been made
    // about *this exact* implementation tree. The digest form exists because a timestamp floor
    // let one statement authorise unlimited later edits: any risk newer than the review stayed
    // valid however many times the tree moved afterwards — reproduced end-to-end, including with
    // the implementation replaced by broken code. Anything that fails to resolve reads as
    // undischargeable, the direction that asks for a fresh decision.
    if (anchor.digest !== undefined) {
      if (!risks.some((r) => r.implementationDigest === anchor.digest)) stale.push(c.id);
      continue;
    }
    const at = Math.max(...risks.map((r) => Date.parse(r.at ?? '')).filter(Number.isFinite), -Infinity);
    if (at === -Infinity) { undischarged.push(c.id); continue; }
    const threshold = anchor.file !== undefined
      ? changedAt(anchor.file)
      : (Number.isFinite(Date.parse(anchor.at ?? '')) ? Date.parse(anchor.at) : Infinity);
    if (at < threshold) stale.push(c.id);
  }

  const owed = [...undischarged, ...stale];
  add('unverifiable-stated', 'Every condition that offered a choice has had one made',
    owed.length ? 'fail' : 'pass',
    owed.length
      ? `${undischarged.length ? `nothing states ${undischarged.join(', ')}. ` : ''}`
        + `${stale.length ? `the statement for ${stale.join(', ')} describes a version that has `
          + `since moved — a waiver is about one specific state, and this is not it any more. ` : ''}`
        + `Record it — \`state-machine.mjs risk --add "<what is unproven and why it is acceptable>" `
        + `--source ${owed[0]}\` — or run the one extra review §18 allows, which removes the condition `
        + `instead of accepting it.`
      : `${open.length} unverifiable condition(s), each cited by a residual risk stated about the current state`);
}

/** When a file last changed, or `Infinity` when that cannot be established — which fails safe. */
function changedAt(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
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
  // Only the **last** round for this artefact is asked whether it read the current text.
  //
  // Round 1 → remediation → round 2 is the mandated cycle, so round 1's digest is stale by
  // construction in every correct run — and run 7 duly reported `review-design-1-current` and
  // `review-plan-1-current` as unverifiable while nothing at all was wrong. A condition that fires
  // on every healthy run carries no signal and teaches people to skim past the ones that do. This
  // is the same reasoning that excluded the `implementation` rounds; it simply was not applied
  // here first time.
  const accountable = roundsToAccountFor(artifact);
  const lastRound = accountable[accountable.length - 1];

  for (const round of accountable) {
    const review = readJson(a.review(round), null);
    if (!review || review.status !== 'completed') {
      add(`review-${round}`, `Codex round ${round} completed`, 'fail', review ? `status=${review.status}: ${review.reason ?? ''}` : 'no review artefact');
      continue;
    }
    add(`review-${round}`, `Codex round ${round} completed`, 'pass', `${review.model} @ ${review.effort}, verdict ${review.verdict}, ${review.findings.length} findings`);

    // Did the artefact move after the round that last read it?
    //
    // Run 6 locked a design that had been edited after its final review, and every condition
    // passed, because "a review exists" and "a review of this text exists" were the same check.
    // `unverifiable`, not `fail`: §18 permits post-round-2 remediation when round 2 raised no new
    // blocker, and that is exactly what happened there. The gate tolerates this status and the
    // director must state it as residual risk — so the fact stops being invisible without forcing a
    // Codex round onto every typo fix. The implementation rounds record a tree digest now too:
    // excluding them was argued from "the tree moves between every round", which stopped being true
    // when this check narrowed to the last round — and the production run proved the cost: a
    // round-6 blocker was fixed *after* round 6, no round read the fix, and the gate said nothing.
    if (round === lastRound) {
      const now = reviewedArtifactDigest(projectRoot, runId, artifact);
      // Registered here, at the one place the "state it or re-review" offer is made, and only for a
      // digest that genuinely differs — a review predating the field could not be compared and makes
      // no such offer. The anchor is the document for design/plan (a later edit makes the statement
      // stale by mtime); the implementation has no single file, so the anchor is the **current tree
      // digest itself**: the waiver must have been stated about this exact tree. A review-timestamp
      // floor was tried first and it made the waiver eternal — one statement after the review
      // stayed valid through every subsequent rewrite, broken code included.
      if (now !== null && review.artifactDigest && review.artifactDigest !== now) {
        const file = { design: a.design, plan: a.plan }[artifact];
        mustBeStated.set(`review-${round}-current`, file ? { file } : { digest: now });
      }
      add(`review-${round}-current`, `The ${artifact} is as round ${round} read it`,
        now === null ? 'not_applicable' : !review.artifactDigest ? 'unverifiable' : review.artifactDigest === now ? 'pass' : 'unverifiable',
        now === null
          ? `no current version of the ${artifact} could be computed`
          : !review.artifactDigest
            ? 'this review predates artefact-version recording, so the two cannot be compared'
            : review.artifactDigest === now
              ? 'byte-identical to the version reviewed'
              : artifact === 'implementation'
                ? `the working tree moved after round ${round} read it — remediation is the usual `
                  + 'cause, and the fix was never adversarially read. State what changed as residual '
                  + 'risk, or run the one extra round §18 allows (implementation-extra).'
                : `the ${artifact} was edited after its last review — the locked text was never `
                  + 'adversarially read. State the change as residual risk, or run an extra round.');
    }

    const decisions = state.adjudications?.[round]?.decisions ?? [];
    const decided = new Set(decisions.map((d) => d.finding_id));
    const undecided = review.findings.filter((f) => !decided.has(f.id)).map((f) => f.id);
    // Decisions must also point at findings the *current* review actually contains. A re-run
    // round replaces the review file, and a decision for a finding that no longer exists is an
    // adjudication of evidence nobody can read — run 9 carried a DESIGN-003 decision whose
    // finding survives in no review file. Failing here forces the round to be re-adjudicated
    // against what the current attempt actually reported.
    const known = new Set(review.findings.map((f) => f.id));
    const orphaned = decisions.filter((d) => !known.has(d.finding_id)).map((d) => d.finding_id);
    add(`adjudicated-${round}`, `Every ${round} finding adjudicated`,
      undecided.length || orphaned.length ? 'fail' : 'pass',
      undecided.length || orphaned.length
        ? `${undecided.length ? `undecided: ${undecided.join(', ')}. ` : ''}`
          + `${orphaned.length ? `decisions for findings absent from the current review (a re-run `
            + `replaced it): ${orphaned.join(', ')} — re-record the adjudication against the `
            + `current findings` : ''}`
        : `${decisions.length} decisions recorded`);

    // Every unresolved decision, not only the accepted ones.
    //
    // `adjudication-ledger` puts `accepted`, `needs_evidence` and `escalated_to_fable` in
    // `REQUIRES_RESOLUTION` — "neither is an answer" — and stores all three with `resolved: false`,
    // while the decisions that close without changing anything are stored already resolved. This
    // filtered on `accepted`, so two of the three obligations closed a round merely by existing: a
    // finding could be parked as `needs_evidence` and the gate would report the round complete.
    // Reading the same field the ledger writes is what keeps the two halves saying the same thing.
    const unresolved = decisions.filter((d) => d.resolved !== true)
      .map((d) => `${d.finding_id} (${d.decision})`);
    add(`resolved-${round}`, `Open ${round} obligations discharged`, unresolved.length ? 'fail' : 'pass',
      unresolved.length ? `not proven resolved: ${unresolved.join(', ')}` : 'every obligation carries resolution evidence');
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

  // A package too large for one agent's turn budget does not fail loudly: the agent is cut off
  // mid-task, its report is lost with everything it observed, and the coordinator finishes the
  // work itself — a documented circuit-breaker path, entered for a reason nobody chose. Measured:
  // 3-to-5-file packages used 37–40 of 40 turns, and one 9-file package exhausted a 40-turn
  // implementer and a 50-turn retry. The plan review prompt already carries "a task too large to
  // review as one unit will be accepted without being understood" and did not catch it, which is
  // this project's recurring lesson: an instruction is not an invariant.
  {
    const limit = loadConfig(projectRoot).budgets.maxFilesPerWorkPackage;
    const oversized = tasks
      .map((t) => ({ id: t?.id ?? '?', n: (t?.scope?.owned_files ?? []).length }))
      .filter((t) => t.n > limit);
    add('tasks-sized', `No work package owns more than ${limit} files`,
      oversized.length ? 'fail' : 'pass',
      oversized.length
        ? `${oversized.map((t) => `${t.id} owns ${t.n}`).join(', ')} — split it, or raise ` +
          'budgets.maxFilesPerWorkPackage in .hyperpowers.json if the change genuinely cannot be split'
        : `largest package owns ${Math.max(0, ...tasks.map((t) => (t?.scope?.owned_files ?? []).length))} files`);
  }

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
    // The detail names both halves. It used to interpolate every *present* name into "all pass",
    // so a matrix recording nothing but `absent` suites rendered "unit-tests all pass" — a check
    // that ran nothing, reported as a check that passed, to the one reader (the director) who
    // decides on the sentence.
    const passing = present.filter((c) => c.status === 'pass').map((c) => c.name);
    const absent = present.filter((c) => c.status === 'absent').map((c) => c.name);
    add('13.2-tests', 'Every recorded test suite passes',
      present.length === 0 ? 'unverifiable' : failing.length ? 'fail' : 'pass',
      present.length === 0
        ? 'no test suite was recorded in the evidence matrix'
        : failing.length
          ? `failing: ${failing.map((c) => `${c.name} (${c.command} → ${c.status})`).join('; ')}`
          : `${passing.join(', ') || 'none'} pass${absent.length ? `; ${absent.join(', ')} absent` : ''}`);

    // The composition nobody documented: every per-check `absent` is sanctioned by the contract,
    // but a matrix in which *nothing at all was executed* is not a proof of anything. Reproduced:
    // all suites absent, no runtime check, criteria evidence of one assertion string —
    // `complete: true`, and the run reached COMPLETE. `unverifiable` + a forced statement rather
    // than `fail`, because a genuinely test-less deliverable (docs, configuration) must stay
    // finishable — with the waiver written down, not for free.
    const executed = (evidence?.checks ?? [])
      .filter((c) => [...TEST_CHECKS, 'runtime'].includes(c.name) && c.status === 'pass');
    if (evidence && executed.length === 0) mustBeStated.set('13.2b-something-executed', { file: a.evidence });
    add('13.2b-something-executed', 'At least one behavioural check was actually executed',
      !evidence ? 'fail' : executed.length ? 'pass' : 'unverifiable',
      !evidence
        ? 'evidence.json is missing'
        : executed.length
          ? `executed and passing: ${executed.map((c) => c.name).join(', ')}`
          : 'no test suite and no runtime check was executed — nothing behavioural was proven. '
            + 'State why that is acceptable as a residual risk (`risk --add … --source '
            + '13.2b-something-executed`), or record an executed check.');
  }

  for (const [num, name, label] of [
    ['13.3', 'build', 'The build passes where one exists'],
    ['13.4a', 'lint', 'Lint passes where it exists'],
    ['13.4b', 'typecheck', 'Typecheck passes where it exists'],
    ['13.4c', 'runtime', 'Runtime behaviour was exercised where applicable'],
  ]) {
    const check = (evidence?.checks ?? []).find((c) => c.name === name);
    // The contract says `runtime` may be "absent **with a reason**" (condition 4c) — the reason
    // clause was documented and nothing read it, so a bare `runtime: absent` was rendered
    // not-applicable for free. With a reason it still is; without one it is a decision nobody
    // wrote down, and the discharge mechanism is exactly for those.
    const bareRuntimeAbsent = name === 'runtime' && check?.status === 'absent'
      && !String(check.output_excerpt ?? '').trim();
    if (bareRuntimeAbsent) mustBeStated.set(`${num}-${name}`, { file: a.evidence });
    add(`${num}-${name}`, label,
      !check ? 'unverifiable'
        : check.status === 'pass' ? 'pass'
          : check.status === 'absent' ? (bareRuntimeAbsent ? 'unverifiable' : 'not_applicable') : 'fail',
      !check ? 'not recorded in the evidence matrix'
        : bareRuntimeAbsent
          ? `${check.command} → absent, with no reason recorded. The contract permits an absent `
            + 'runtime check only with one: put the reason in `output_excerpt`, or state it as a '
            + `residual risk (\`risk --add … --source ${num}-${name}\`).`
          : `${check.command} → ${check.status}`);
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

  // `tasks:all-accepted` is EXECUTION's exit requirement, so it is checked once, on the way out, and
  // never again. Nothing stops a status moving afterwards — `task --status pending` is a documented
  // verb with no phase constraint — and completion read `tasks.json` only for file ownership. So a
  // package could regress to `pending` after EXECUTION and the run could still declare success on
  // work it had stopped claiming was done. Re-asserting it here costs one read.
  const packages = readJson(a.tasks, null)?.tasks;
  const decomposed = Array.isArray(packages) && packages.length > 0;
  const unaccepted = decomposed
    ? packages.filter((t) => t.status !== 'accepted').map((t) => `${t.id} (${t.status ?? 'pending'})`)
    : [];
  // And the evidence that justified each acceptance still exists and still says what it said.
  // Acceptance checks the newest referenced report once, on the way out of EXECUTION; nothing
  // stopped that file being deleted or rewritten afterwards while "accepted" stood — the status
  // survived its own justification. Same re-assertion as the status check above, one layer down.
  const attemptOf = (rid) => Number(/-attempt(\d+)$/.exec(String(rid))?.[1] ?? 0);
  const unevidenced = decomposed
    ? packages.filter((t) => t.status === 'accepted').flatMap((t) => {
        const intended = [...(t.reports ?? [])].sort((x, y) => attemptOf(x) - attemptOf(y)).at(-1);
        if (!intended) return [`${t.id} (no report referenced)`];
        const report = readJson(a.report(intended), null);
        if (!report) return [`${t.id} ('${intended}' unreadable)`];
        const overridden = (t.notes ?? []).some((n) => String(n).startsWith('accepted despite'));
        if (report.status !== 'success' && !overridden) return [`${t.id} ('${intended}' is '${report.status}' with no recorded override)`];
        return [];
      })
    : [];
  add('packages-accepted', 'Every work package is still accepted, on evidence that still exists',
    decomposed && unaccepted.length === 0 && unevidenced.length === 0 ? 'pass' : 'fail',
    !decomposed
      ? 'tasks.json records no work packages'
      : unaccepted.length || unevidenced.length
        ? `${unaccepted.length ? `not accepted: ${unaccepted.join(', ')}. ` : ''}`
          + `${unevidenced.length ? `accepted without surviving evidence: ${unevidenced.join(', ')}` : ''}`
        : `${packages.length} package(s) accepted, each with its newest report on disk`);

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
  //
  // Read from **both** records the guard writes. It stamps escalating drift durably into
  // `state.gitDrift` and also emits a `policy_violation` event, and this read only the event — while
  // `logEvent` swallows a failed append by design, so a mutation that was detected and durably
  // recorded could still be reported as "repository state never changed". Treating the absence of the
  // weaker record as proof is the shape of the defect, not the missing write.
  const executed = readEvents().filter((e) => e.type === 'policy_violation');
  const blocked = readEvents().filter((e) => e.type === 'policy_blocked');
  const recorded = (state.gitDrift ?? []).filter((d) => d.escalated !== false);
  const mutations = [
    ...executed.map((e) => (e.drift ?? []).join('; ')),
    ...recorded.map((d) => `${(d.drift ?? []).join('; ')}${d.command ? ` [${d.command}]` : ''}`),
  ].filter(Boolean);
  add('13.11-no-git-mutation', 'No Git mutation was executed', mutations.length ? 'fail' : 'pass',
    mutations.length
      ? `${mutations.length} mutation(s) detected after the fact: ${[...new Set(mutations)].join(' | ')}`
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

  // Three sources, because the first two can be silent. `model_mismatch` needs the Stop controller
  // to have noticed; `observedDirectorModel` needs it to have run at all — it fired once in an
  // 86-minute run (§O14) and not before this gate in a four-hour one, so the condition reported
  // "not observed" about a model the transcript answers on demand. `ok: null` still means
  // genuinely unobservable.
  const mismatch = readEvents().filter((e) => e.type === 'model_mismatch');
  const tier = directorTier(state);
  const wrong = mismatch.length
    ? `observed ${mismatch[0].observed}, expected ${mismatch[0].expected}`
    : tier.ok === false
      ? `observed ${tier.observed} (${tier.family}), expected the ${tier.expected} tier`
      : null;
  const observedModel = state.observedDirectorModel ?? tier.observed;
  // How the run was launched, and at what effort, ride in the detail — never in the status. A wrong
  // *model* means product authority was exercised by the wrong tier: an inversion, and a fail. A
  // wrong *effort* on the right model is a degradation — the run is still the system it claims to
  // be, reasoning less hard about it. Failing completion on that would turn a finished four-hour
  // run into `BLOCKED` over something that did not change who decided. Reported, not enforced.
  const launchNote = tier.agent
    ? ` Directed by the \`${tier.agent}\` subagent at depth ${tier.spawnDepth ?? '?'}` +
      `${tier.effort ? `, effort \`${tier.effort}\`` : ''}` +
      `${tier.effortOk === false ? ` — configured for \`${tier.expectedEffort}\`` : ''}.`
    : ' The director subagent was not found in this session\'s transcripts, so the tier could not be'
      + ' read here.';
  // An unobservable tier is not agreement (`transcript.mjs` says so in terms), and it used to be
  // free: `unverifiable` never fails a gate, and nothing owed a decision about it. Registering it
  // makes the silence cost a written statement — the same discharge every other tolerated
  // condition pays. Anchored on the run's start: any risk stated during the run discharges it.
  if (!wrong && !observedModel) mustBeStated.set('13.12b-director-model', { at: state.createdAt });
  add('13.12b-director-model', 'The director tier ran on the configured model',
    wrong ? 'fail' : observedModel ? 'pass' : 'unverifiable',
    (wrong ?? observedModel ?? 'not observed — state this as residual risk (`risk --add … --source '
      + '13.12b-director-model`): a tier nobody observed is a tier nobody verified') + launchNote);

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
        // Naming the verb matters, and naming the *wrong* verb matters more: this said
        // `artifact --name diagramUrl`, which is how a director publishes the page itself and
        // produces a URL that opens on nobody's screen (§S21) — the reported bug, restated as an
        // instruction by the very check that is supposed to catch it.
        ? 'write the page into the run directory, then `state-machine.mjs publish-request --file '
          + '<path> --title "<what it shows>" --source "<mermaid>"` and stop. The main thread '
          + 'publishes it and records the URL (spec §13 condition 14).'
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
 * Files Hyperpowers itself used to write into the working tree. Nothing writes them any more —
 * nothing is installed at all — but the exemption stays for repositories
 * configured by an earlier version, where the file is still present and still owned by no work
 * package. Removing it would fail condition §13.10 on exactly those projects.
 */
const OWN_FILES = new Set(HYPERPOWERS_OWN_FILES);

/**
 * Files changed in the working tree, or `null` when Git cannot tell us.
 *
 * `null` and `[]` mean different things and must not be conflated: `[]` is "nothing changed",
 * `null` is "we could not find out", and only the first of those can justify passing a
 * scope-drift check.
 */
function changedFiles() {
  // `-z` both times: these names are compared against work-package ownership, and a C-quoted
  // non-ASCII name matches nothing it should (see `gitPathsZ`).
  const tracked = gitPathsZ(projectRoot, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = gitPathsZ(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  // Either query failing means the inventory is unknown. `[]` is "nothing changed" and only that
  // can justify passing a scope check — the doc block above says so, and `&&` said otherwise.
  if (tracked === null || untracked === null) return null;
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
