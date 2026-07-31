#!/usr/bin/env node
/**
 * Adjudication ledger (spec §9).
 *
 *   Codex n'est jamais l'autorité finale.
 *
 * Every finding gets an explicit, reasoned decision recorded here. Two properties follow, and
 * both matter more than they look:
 *
 *  - A finding cannot be resolved by being ignored. The phase gate checks that every finding
 *    id has a decision, so silence is not an available answer.
 *  - Rejections are as auditable as acceptances. The next Codex round receives the rejection
 *    rationale and is explicitly asked whether it holds (spec §8.7 step 4), which is what
 *    stops adjudication from becoming a way to make inconvenient findings disappear.
 *
 *   adjudication-ledger.mjs record   --round <r> --file <decisions.json>
 *   adjudication-ledger.mjs resolve  --round <r> --finding <id> --evidence "..."
 *   adjudication-ledger.mjs status   [--round <r>]
 *   adjudication-ledger.mjs pending  --round <r>
 */

import path from 'node:path';
import { parseArgs, fail, emitJson, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { artifacts, PLUGIN_ROOT } from './lib/paths.mjs';
import { readJson, nowIso } from './lib/io.mjs';
import { loadState, mutateState, refuseIfEnded } from './lib/state.mjs';
import { validate } from './lib/validate.mjs';
import { misplacedOrchestrationFile } from './lib/workspace.mjs';
import { logEvent, readEvents } from './lib/telemetry.mjs';
import { ALL_ROUNDS } from './lib/phases.mjs';

const { positional, flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const runId = resolveRunId(projectRoot, flags);
if (!runId) fail(`No Hyperpowers run found for ${projectRoot}.`);
const a = artifacts(projectRoot, runId);
const schema = readJson(path.join(PLUGIN_ROOT, 'schemas', 'adjudication.schema.json'), null);

/**
 * Decisions that leave the finding as an open obligation until proven resolved.
 *
 * `needs_evidence` and `escalated_to_fable` belong here for the same reason `accepted` does:
 * neither is an answer. They previously defaulted to `resolved: true`, so a *blocking* finding
 * could be closed by escalating it — and Fable never had to decide. That is precisely the "make
 * an inconvenient finding disappear" move the rest of this file exists to prevent.
 */
const REQUIRES_RESOLUTION = new Set(['accepted', 'needs_evidence', 'escalated_to_fable']);
/** Decisions that close the finding without any change to the artefact. */
const CLOSES_WITHOUT_CHANGE = new Set(['rejected', 'duplicate', 'out_of_scope', 'deferred_non_blocking']);

const COMMANDS = { record: cmdRecord, resolve: cmdResolve, status: cmdStatus, pending: cmdPending };
const handler = COMMANDS[positional[0]];
if (!handler) fail(`Usage: adjudication-ledger.mjs <${Object.keys(COMMANDS).join('|')}> --round <round> [flags]`);

// §S14: a finished run's record is closed. This is the verb the measured incident names — a plan
// coordinator that kept adjudicating for nine minutes past an abort, because ending a run ends its
// state and not its subagents. `status` and `pending` only read, and auditing a finished run is
// exactly what they are for.
if (positional[0] === 'record' || positional[0] === 'resolve') {
  const ended = refuseIfEnded(projectRoot, runId);
  if (ended) fail(ended, 2);
}
handler();

function requireRound() {
  const round = flags.round;
  if (typeof round !== 'string' || !ALL_ROUNDS[round]) {
    fail(`--round must be one of: ${Object.keys(ALL_ROUNDS).join(', ')}`);
  }
  return round;
}

function loadReview(round) {
  const review = readJson(a.review(round), null);
  if (!review) fail(`No review artefact for round '${round}'. Run codex-adversary.mjs first.`);
  if (review.status !== 'completed') fail(`Review '${round}' did not complete (status=${review.status}).`);
  return review;
}

function cmdRecord() {
  const round = requireRound();
  const review = loadReview(round);
  if (typeof flags.file !== 'string') fail('record requires --file <decisions.json> (an array of adjudication objects).');

  const decisionsPath = path.resolve(projectRoot, flags.file);
  // Same rule as `validate-agent-report submit`, from the same implementation: an adjudication
  // record is orchestration data and must not land in the repository under review (spec §20).
  const misplaced = misplacedOrchestrationFile(decisionsPath, projectRoot, artifacts(projectRoot, runId).base);
  if (misplaced) fail(misplaced, 3);

  const decisions = readJson(decisionsPath, null);
  if (!Array.isArray(decisions)) fail(`${flags.file} must contain a JSON array of adjudication objects.`);

  // Validate every decision before recording any of them: a half-written ledger is worse
  // than none, because the gate would report a misleading count of undecided findings.
  const errors = [];
  decisions.forEach((d, i) => {
    const { valid, errors: errs } = validate(d, schema);
    if (!valid) errors.push(`decision[${i}] (${d?.finding_id ?? 'no id'}): ${errs.join('; ')}`);
  });

  const known = new Set(review.findings.map((f) => f.id));
  for (const d of decisions) {
    if (d?.finding_id && !known.has(d.finding_id)) {
      errors.push(`decision for unknown finding '${d.finding_id}' — round ${round} reported: ${[...known].join(', ') || '(none)'}`);
    }
  }
  const seen = new Set();
  for (const d of decisions) {
    if (seen.has(d?.finding_id)) errors.push(`duplicate decision for '${d.finding_id}'`);
    seen.add(d?.finding_id);
  }
  // `resolved` is earned through `resolve`, which demands evidence. Accepting it as an input
  // let a decision arrive pre-closed and skip that step entirely — the one obligation this
  // ledger exists to impose. Recording a decision and proving it are deliberately two acts.
  for (const d of decisions) {
    if (d?.resolved === true) {
      errors.push(
        `decision for '${d.finding_id}' arrives with resolved:true. A finding is closed by ` +
          `\`adjudication-ledger.mjs resolve --finding ${d.finding_id} --evidence "…"\` once the ` +
          `correction is proven, never by asserting it here.`,
      );
    }
  }
  if (errors.length) fail(`Adjudication rejected:\n  - ${errors.join('\n  - ')}`, 2);

  const undecided = review.findings.filter((f) => !seen.has(f.id)).map((f) => f.id);

  // Which of these findings had already been decided in this round. Read before the write, because
  // `record` replaces the round wholesale and the previous decisions are gone a line later.
  //
  // §S22 established the rule on `resolve` and stopped there. `record` had the same disease and run 8
  // measured it: **17 `adjudication` events for 14 distinct findings**, `plan-2` alone emitting 6 for
  // 3 — the same three, two minutes apart. The state was right both times; only the journal
  // over-counted, and the journal is what anyone measuring the run reads. Revisiting a decision is
  // legitimate work and stays on the record under its own name; it is simply not a second finding.
  const alreadyDecided = new Set(
    (loadState(projectRoot, runId).adjudications?.[round]?.decisions ?? []).map((d) => d.finding_id),
  );

  mutateState(projectRoot, runId, (s) => {
    s.adjudications[round] = {
      at: nowIso(),
      decisions: decisions.map((d) => ({ ...d, resolved: d.resolved ?? !REQUIRES_RESOLUTION.has(d.decision) })),
    };
    s.openBlockers = recomputeOpenBlockers(s);
  });
  for (const d of decisions) {
    logEvent(projectRoot, runId, {
      type: alreadyDecided.has(d.finding_id) ? 'adjudication_decision_replaced' : 'adjudication',
      round, finding: d.finding_id, decision: d.decision, escalated: d.escalate_to_fable,
    });
  }

  const state = loadState(projectRoot, runId);
  emitJson({
    round,
    recorded: decisions.length,
    undecided,
    complete: undecided.length === 0,
    escalatedToFable: decisions.filter((d) => d.escalate_to_fable).map((d) => d.finding_id),
    openObligations: state.adjudications[round].decisions.filter((d) => !d.resolved).map((d) => d.finding_id),
    openBlockers: state.openBlockers,
    next: undecided.length
      ? `Findings still undecided: ${undecided.join(', ')}. Every finding needs a decision before this phase can be exited.`
      : 'All findings adjudicated. Apply accepted corrections, then mark each one resolved with `resolve`.',
  });
}

function cmdResolve() {
  const round = requireRound();
  const findingId = flags.finding;
  if (typeof findingId !== 'string') fail('resolve requires --finding <id>.');
  if (typeof flags.evidence !== 'string' || flags.evidence.length < 10) {
    fail('resolve requires --evidence "<how this correction was proven>". A resolution without proof is an assertion.');
  }

  let updated;
  let alreadyResolved = false;
  try {
    updated = mutateState(projectRoot, runId, (s) => {
      const entry = s.adjudications[round];
      if (!entry) throw new Error(`No adjudication recorded for round '${round}'.`);
      const decision = entry.decisions.find((d) => d.finding_id === findingId);
      // An escalation is closed by the answer, never by a note saying it was escalated.
      //
      // `escalated_to_fable` means "the coordinator is not the one who decides this" (spec §9). Any
      // ten-character string satisfied `--evidence`, so the coordinator that escalated a *blocking*
      // finding could close it with "escalated to the director as agreed" — the blocker left
      // `openBlockers`, completion passed, and the director never decided. That is precisely the "make
      // an inconvenient finding disappear" move the rest of this file exists to prevent, arriving
      // through the one verb built to demand proof.
      if (decision?.decision === 'escalated_to_fable') {
        throw new Error(
          `'${findingId}' is escalated to the director, so the coordinator cannot resolve it. What `
          + `closes an escalation is the director's decision: record it, replacing this one —\n`
          + `  adjudication-ledger.mjs record --round ${round} --file <decisions.json>\n`
          + `with the finding decided \`accepted\` or \`rejected\` and the director's rationale. `
          + `Re-recording is on the record as \`adjudication_decision_replaced\`, so nothing is hidden.`,
        );
      }
      if (!decision) throw new Error(`No decision recorded for finding '${findingId}' in round '${round}'.`);
      alreadyResolved = decision.resolved === true;
      decision.resolved = true;
      decision.resolved_evidence = flags.evidence;
      decision.resolved_at = nowIso();
      s.openBlockers = recomputeOpenBlockers(s);
      return decision;
    });
  } catch (err) {
    fail(err.message, 2);
  }

  // Two different facts must not share an event name — the same discipline that keeps
  // `policy_blocked` apart from `policy_violation`. Runs 6 and 7 both logged more
  // `adjudication_resolved` events than there were findings, because re-stating a resolution looked
  // identical to closing a new one, and anyone counting the record would have over-counted the work
  // the run actually did. Replacing evidence is legitimate and stays on the record under its own
  // name; only the first closure counts as a closure.
  //
  // "Ever closed" is asked of the journal, not of the state field: `record` replaces a round
  // wholesale and resets `resolved` to false — a *documented* flow, since closing an escalation
  // requires a re-record — so the in-memory flag forgets. Run 9 measured the result: 14
  // `adjudication_resolved` events for 13 findings, the extra one a record/resolve interleave on
  // one finding. Telemetry is append-only by design, which makes it the one authority this
  // question has; deriving from it keeps the journal self-consistent by construction.
  const everResolved = alreadyResolved || readEvents(projectRoot, runId).some(
    (e) => (e.type === 'adjudication_resolved' || e.type === 'adjudication_resolution_replaced')
      && e.round === round && e.finding === findingId,
  );
  logEvent(projectRoot, runId, {
    type: everResolved ? 'adjudication_resolution_replaced' : 'adjudication_resolved',
    round,
    finding: findingId,
  });
  emitJson({ round, finding: findingId, resolved: true, replaced: everResolved, evidence: updated.resolved_evidence });
}

function cmdPending() {
  const round = requireRound();
  const review = loadReview(round);
  const state = loadState(projectRoot, runId);
  const decided = new Set((state.adjudications[round]?.decisions ?? []).map((d) => d.finding_id));
  emitJson({
    round,
    total: review.findings.length,
    pending: review.findings
      .filter((f) => !decided.has(f.id))
      .map((f) => ({ id: f.id, severity: f.severity, blocking: f.blocking, category: f.category, location: f.location, claim: f.claim, recommendation: f.recommendation, evidence: f.evidence, confidence: f.confidence })),
    schema: path.join(PLUGIN_ROOT, 'schemas', 'adjudication.schema.json'),
    decisionVocabulary: ['accepted', 'rejected', 'needs_evidence', 'duplicate', 'out_of_scope', 'deferred_non_blocking', 'escalated_to_fable'],
    guidance:
      'Judge each finding on its merits, not on how convenient it is. Accepting a finding ' +
      'requires a concrete change and a verification. Rejecting one requires a rationale that ' +
      'will itself be reviewed in the next round. Escalate to Fable only for product intent, ' +
      'scope, or an irreversible architectural trade-off.',
  });
}

function cmdStatus() {
  const state = loadState(projectRoot, runId);
  const rounds = flags.round ? [flags.round] : Object.keys(ALL_ROUNDS);
  const out = [];
  for (const round of rounds) {
    const review = readJson(a.review(round), null);
    if (!review || review.status !== 'completed') continue;
    const decisions = state.adjudications[round]?.decisions ?? [];
    const byDecision = {};
    for (const d of decisions) byDecision[d.decision] = (byDecision[d.decision] ?? 0) + 1;
    const decided = new Set(decisions.map((d) => d.finding_id));
    out.push({
      round,
      verdict: review.verdict,
      findings: review.findings.length,
      blocking: review.findings.filter((f) => f.blocking).length,
      decisions: decisions.length,
      byDecision,
      undecided: review.findings.filter((f) => !decided.has(f.id)).map((f) => f.id),
      unresolved: decisions.filter((d) => !d.resolved).map((d) => d.finding_id),
    });
  }
  emitJson({ runId, rounds: out, openBlockers: state.openBlockers });
}

/**
 * An open blocker is a finding that is blocking, was accepted, and has not yet been proven
 * resolved. `deferred_non_blocking` deliberately cannot apply to a blocking finding — that
 * combination is how a critical defect would otherwise be talked out of existence.
 */
function recomputeOpenBlockers(state) {
  const open = [];
  for (const [round, entry] of Object.entries(state.adjudications ?? {})) {
    const review = readJson(a.review(round), null);
    if (!review) continue;
    const findings = new Map(review.findings.map((f) => [f.id, f]));
    for (const d of entry.decisions ?? []) {
      const f = findings.get(d.finding_id);
      if (!f?.blocking) continue;
      if (CLOSES_WITHOUT_CHANGE.has(d.decision) && d.decision !== 'deferred_non_blocking') continue;
      if (d.decision === 'deferred_non_blocking') {
        open.push({ id: d.finding_id, round, severity: f.severity, reason: 'a blocking finding cannot be deferred as non-blocking' });
        continue;
      }
      if (!d.resolved) {
        const why = {
          accepted: 'accepted but not yet proven resolved',
          needs_evidence: 'marked needs_evidence: the question is still open, so the finding is not closed',
          escalated_to_fable: 'escalated to Fable and awaiting a product verdict',
        }[d.decision] ?? 'not yet proven resolved';
        open.push({ id: d.finding_id, round, severity: f.severity, decision: d.decision, reason: why });
      }
    }
  }
  return open;
}
