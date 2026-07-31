#!/usr/bin/env node
/**
 * Codex adversarial review adapter (spec §8).
 *
 * Hyperpowers does not type `/codex:adversarial-review`: that command sets
 * `disable-model-invocation: true` (verified by reading the installed command file), targets a
 * Git diff rather than an arbitrary document, and does not forward the requested effort.
 * This adapter keeps the *philosophy* of that command — independent contradiction, read-only,
 * structured findings, a reviewer with clean context — while owning the mechanics.
 *
 * Every invocation is fully specified, so a review is reproducible and its provenance
 * provable (spec §8.4):
 *
 *   codex exec --model <model>
 *              -c model_reasoning_effort='"<effort>"'
 *              --sandbox read-only
 *              --ignore-user-config          # never inherit ~/.codex/config.toml
 *              --output-schema <schema>      # findings shape is enforced, not requested
 *              -o <last-message file>        # no stdout scraping
 *              -C <projectRoot>
 *
 * `--ignore-user-config` is what makes spec §8.4's concern moot: the adapter never reads,
 * writes or reasons about the user's Codex configuration or project trust level.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, fail, emitJson, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { artifacts, PLUGIN_ROOT } from './lib/paths.mjs';
import { ensureDir, writeJson, writeFileAtomic, readJson, nowIso } from './lib/io.mjs';
import { loadConfig } from './lib/config.mjs';
import { EXTRA_ROUNDS, ALL_ROUNDS, REVIEW_ROUNDS, PHASE_ORDER, phaseIndex } from './lib/phases.mjs';
import { buildPack } from './lib/review-pack.mjs';
import { loadState, mutateState, reviewedArtifactDigest, refuseIfEnded } from './lib/state.mjs';
import { logEvent } from './lib/telemetry.mjs';
import { validate } from './lib/validate.mjs';

const { flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const runId = resolveRunId(projectRoot, flags);
if (!runId) fail(`No Hyperpowers run found for ${projectRoot}.`);

const round = flags.round;
if (typeof round !== 'string' || !ALL_ROUNDS[round]) {
  fail(`--round must be one of: ${Object.keys(ALL_ROUNDS).join(', ')}`);
}

// §S14, and before anything is spent: a review of a finished run has nowhere to be recorded, and
// this verb is the one that costs real Codex quota to discover that.
const ended = refuseIfEnded(projectRoot, runId);
if (ended) fail(ended, 2);

const config = loadConfig(projectRoot);
const a = artifacts(projectRoot, runId);
const spec = ALL_ROUNDS[round];

// Spec §18 allows exactly one extra targeted review per artefact after a round-2 blocker. The
// bound is enforced here rather than stated in a prompt, because "one more review" is precisely
// the kind of limit an agent under pressure talks itself past.
//
// A *replay* of a completed mandatory round is the same spend under a different spelling. The cap
// used to bind only the `*-extra` names, so re-running `design-2` consumed nothing and could be
// repeated indefinitely — run 9 replayed two rounds with `extraReviews` still `{}`, and a rerun
// that comes back clean vacuously satisfies `adjudicated-<round>` for the findings it erased. The
// first run of each mandatory round is free; every further review of the artefact, whatever it is
// called, draws on the same §18 allowance.
//
// "Has this round ever completed" is asked of the archives as well as the canonical file. Reading
// only the current file made a *failed* replay reset the answer: the completed attempt had been
// archived, the failed record sat canonical, and the next success was treated as a free first
// execution — so failure→success cycles walked around the cap indefinitely.
const isReplay = readJson(a.review(round), null)?.status === 'completed'
  || completedAttemptExists();

// Only *completed* archived attempts make a replay: a failed attempt yielded no review, so
// re-running it is the ordinary retry path, not a re-review — charging the allowance for an
// infrastructure failure would block the legitimate route back to a working round.
function completedAttemptExists() {
  try {
    return fs.readdirSync(a.reviewsDir)
      .filter((f) => f.startsWith(`${round}.attempt`) && f.endsWith('.json'))
      .some((f) => readJson(path.join(a.reviewsDir, f), null)?.status === 'completed');
  } catch {
    return false;
  }
}
if (EXTRA_ROUNDS[round] || isReplay) {
  const used = loadState(projectRoot, runId).counters?.extraReviews?.[spec.artifact] ?? 0;
  const allowed = config.budgets.maxExtraReviewsPerArtifact;
  if (used >= allowed) {
    fail(
      `The ${spec.artifact} artefact has already used its ${allowed} extra review round${allowed === 1 ? '' : 's'}` +
        `${isReplay ? ` — and re-running the completed '${round}' counts as one` : ''}. ` +
        `Spec §18: if a critical blocker survives the extra round, the run goes to BLOCKED rather ` +
        `than reviewing indefinitely. Transition to BLOCKED with the surviving finding as the reason.`,
      7,
    );
  }
}
// A mandatory round is consumed by the phase that names it, so its **first** execution must
// happen there: run early it reviews an artefact that is not finished, and the file it leaves
// behind later satisfies the exit gate of a phase it never ran in — reproduced from PREFLIGHT.
// A replay or a §18 extra round re-reads a *moved* artefact, and the places that legitimately
// order one span the artefact's whole segment: its round-1 phase through the phase after its
// round-2 (the lock, or FINAL_ACCEPTANCE), because the gate's own "state it or run an extra
// round" offer is made at the lock, which has no edge back to remediation. The segment is
// derived from the phase tables rather than declared, so a renamed phase cannot leave a stale
// copy here.
{
  const phase = loadState(projectRoot, runId).phase;
  const first = phaseIndex(REVIEW_ROUNDS[`${spec.artifact}-1`].phase);
  const last = phaseIndex(REVIEW_ROUNDS[`${spec.artifact}-2`].phase) + 1;
  const segment = PHASE_ORDER.slice(first, last + 1);
  const allowed = (EXTRA_ROUNDS[round] || isReplay) ? segment : [spec.phase];
  if (!allowed.includes(phase)) {
    fail(
      `Round '${round}' cannot run while the run is in ${phase}. ` +
        (EXTRA_ROUNDS[round] || isReplay
          ? `A ${isReplay ? 'replay' : 'targeted extra round'} of the ${spec.artifact} may run ` +
            `between ${segment[0]} and ${segment.at(-1)} — the segment where a gate can order one.`
          : `Its first execution belongs to ${spec.phase}, the phase whose exit gate consumes it: ` +
            `reviewed early, the round reads an artefact that is not finished, and its file later ` +
            `satisfies a gate it never ran in.`),
      7,
    );
  }
}

const outputSchemaPath = path.join(PLUGIN_ROOT, 'schemas', 'codex-review-output.schema.json');
const outputSchema = readJson(outputSchemaPath, null);
if (!outputSchema) fail(`Missing review output schema at ${outputSchemaPath}`);

const ID_PREFIX = { design: 'DESIGN', plan: 'PLAN', implementation: 'IMPL' }[spec.artifact];

main().catch((err) => fail(`codex-adversary failed: ${err.stack ?? err.message}`));

async function main() {
  loadState(projectRoot, runId); // fail fast if the run is unreadable

  ensureDir(a.reviewsDir);
  ensureDir(a.packsDir);

  // Provenance is never overwritten. A rerun used to replace the review JSON, the pack, the
  // prompt and the raw reviewer output in place — so a blocking finding could be erased by
  // running the same command again, and run 9's record holds an adjudication for a finding no
  // surviving review contains. Whatever this invocation produces, the previous attempt's files
  // are moved aside first, under a name every later reader can find.
  archiveExistingRound();

  const pack = buildPack(projectRoot, runId, round, config.codex.reviewPackMaxBytes);
  if (pack.bytes < 200) {
    fail(`Review pack for round '${round}' is empty — the artefact under review does not exist yet.`);
  }
  const gaps = mandatoryGaps(pack);
  if (gaps.length) fail(mandatoryGapMessage(round, gaps), 4);
  const packPath = path.join(a.packsDir, `${round}.md`);
  writeFileAtomic(packPath, pack.text);

  const promptPath = path.join(a.packsDir, `${round}.prompt.md`);
  const prompt = buildPrompt(round, spec, pack);
  writeFileAtomic(promptPath, prompt);

  // The version under review is the version the pack was built from — computed here, not after
  // the reviewer returns. For a document the difference is seconds; for the implementation the
  // review takes minutes, and a digest taken afterwards would describe a tree the reviewer never
  // read (run 9: pack at 15:12, review back at 15:14).
  const artifactDigest = reviewedArtifactDigest(projectRoot, runId, spec.artifact);

  // --- model routing with the single documented fallback (spec §8.6) ----------
  const attempts = [];
  let model = spec.model;
  let effort = spec.effort;
  let review = null;
  let currentPrompt = prompt;
  const retriesUsed = new Map(); // per model — a retry is a property of the model that failed

  while (model) {
    const isRetry = (retriesUsed.get(model) ?? 0) > 0;
    const result = await invokeCodex({ model, effort, prompt: currentPrompt, packPath });
    attempts.push({
      model, effort, ok: result.ok, reason: result.reason, ms: result.ms, logPath: result.logPath,
      ...(isRetry ? { retry: true } : {}),
    });

    if (result.ok) {
      review = finalise(result.value, model, effort, attempts, artifactDigest);
      break;
    }

    // Every failed attempt is classified the same way, retries included. The retry's
    // classification used to be discarded — only `retry.ok` was read — so a primary model that
    // failed transiently and then reported itself unavailable on the retry never reached this
    // hop, and the round failed where the documented Sol → Luna fallback should have run.
    if (result.classification === 'model_unavailable') {
      const next = config.codex.fallback[model] ?? null;
      // Accept both the object form and a bare model id, so an older `.hyperpowers.json`
      // override keeps working.
      const nextModel = typeof next === 'string' ? next : next?.model ?? null;
      const nextEffort = typeof next === 'string' ? effort : next?.effort ?? effort;
      logEvent(projectRoot, runId, {
        type: 'fallback', event: 'FALLBACK_REVIEW_MODEL', round,
        from: model, fromEffort: effort, to: nextModel, toEffort: nextEffort, reason: result.reason,
      });
      if (!nextModel) break;
      mutateState(projectRoot, runId, (s) => { s.counters.fallbacks += 1; });
      model = nextModel;
      effort = nextEffort;
      // The fallback model starts from the full pack, not from whatever half-size retry pack the
      // failed model may have left on disk.
      writeFileAtomic(packPath, pack.text);
      currentPrompt = prompt;
      writeFileAtomic(promptPath, prompt);
      continue;
    }

    // A transient or malformed-output failure earns exactly one retry per model, with a smaller
    // pack (spec §23 Risk 5: reduce the scope rather than repeat the same oversized request).
    if ((retriesUsed.get(model) ?? 0) < config.codex.retries) {
      const smaller = buildPack(projectRoot, runId, round, Math.floor(config.codex.reviewPackMaxBytes / 2));
      // The retry halves the budget, which makes losing mandatory context *more* likely than on
      // the first attempt — so this is precisely where the check may not be skipped. Sending it
      // anyway would answer a gate with a review of something else, and a retry that "succeeded"
      // is far more convincing than one that failed.
      const retryGaps = mandatoryGaps(smaller);
      if (retryGaps.length) {
        // `skipped` keeps this decision on the record while keeping it out of `codexInvocations`:
        // no process was launched, and a counter named "invocations" that counted decisions
        // overstated every round that ever declined a retry.
        attempts.push({
          model, effort, ok: false, retry: true, skipped: true, ms: 0,
          reason: `retry not attempted: the half-size pack could not carry ${retryGaps.join('; ')}`,
        });
        break;
      }
      retriesUsed.set(model, (retriesUsed.get(model) ?? 0) + 1);
      writeFileAtomic(packPath, smaller.text);
      currentPrompt = buildPrompt(round, spec, smaller);
      writeFileAtomic(promptPath, currentPrompt);
      continue;
    }
    break;
  }

  if (!review) {
    const record = {
      round, status: 'failed', artifact: spec.artifact, attempts, at: nowIso(),
      reason: attempts.at(-1)?.reason ?? 'unknown',
    };
    writeJson(a.review(round), record);
    // Failed attempts spent real Codex quota; counting them only on success made
    // `codexInvocations` — the figure cost and audit read — silently understate every round that
    // ever failed.
    try {
      mutateState(projectRoot, runId, (s) => { s.counters.codexInvocations += attempts.filter((x) => !x.skipped).length; });
    } catch { /* accounting must not mask the failure being reported */ }
    logEvent(projectRoot, runId, { type: 'codex_review', round, status: 'failed', attempts: attempts.length });
    // Spec §3.2/§8.6: no silent substitution. A review that cannot run is a blocking fact.
    fail(
      `Codex round '${round}' could not be completed.\n` +
        attempts.map((x) => `  - ${x.model} @ ${x.effort}: ${x.reason}`).join('\n') +
        `\n\nNo silent fallback is permitted. Transition the run to BLOCKED with this as the reason, ` +
        `or fix Codex availability and retry.`,
      4,
    );
  }

  writeJson(a.review(round), review);
  mutateState(projectRoot, runId, (s) => {
    s.reviews[round] = {
      at: review.at, model: review.model, effort: review.effort, verdict: review.verdict,
      findings: review.findings.length, blocking: review.findings.filter((f) => f.blocking).length,
    };
    s.counters.codexInvocations += attempts.filter((x) => !x.skipped).length;
    // A replay of a completed mandatory round consumes the same §18 allowance as a `*-extra`
    // round — see the cap check above. Counting only the `-extra` spelling left the bound
    // enforceable for one of four spellings per artefact.
    if (EXTRA_ROUNDS[round] || isReplay) {
      s.counters.extraReviews = { ...(s.counters.extraReviews ?? {}), [spec.artifact]: (s.counters.extraReviews?.[spec.artifact] ?? 0) + 1 };
    }
  });
  logEvent(projectRoot, runId, {
    type: 'codex_review', round, status: 'completed', model: review.model, effort: review.effort,
    verdict: review.verdict, findings: review.findings.length,
  });

  emitJson({
    round,
    status: 'completed',
    model: review.model,
    effort: review.effort,
    verdict: review.verdict,
    summary: review.summary,
    findings: review.findings.map((f) => ({ id: f.id, severity: f.severity, blocking: f.blocking, location: f.location, claim: f.claim })),
    blockingCount: review.findings.filter((f) => f.blocking).length,
    coverageNotes: review.coverage_notes,
    packBytes: pack.bytes,
    packTruncated: pack.truncated,
    packDropped: pack.dropped,
    reviewFile: a.review(round),
    next: `Adjudicate every finding with hyperpowers:opus-review-adjudicator. Codex is not the authority (spec §9).`,
  });
}

/**
 * Context this round cannot run without, and did not get.
 *
 * The size cap protects against a review that never returns; it must not quietly redefine what is
 * being reviewed. Two ways it did:
 *
 *  - **Truncated, not only dropped.** Mandatory sections sit at priority -1 precisely so the budget
 *    truncates them rather than dropping them — which routed the common failure through the one
 *    branch this guard was not checking. A reviewer handed half the previous round's findings
 *    verifies half the corrections and reports on the half it saw, and the gate reads a completed
 *    round. The pack prints a coverage warning, but a warning asks the reviewer to disclose the gap;
 *    it does not guarantee the round did its job.
 *  - **General rounds too.** This was scoped to targeted rounds until a 120-file change was
 *    simulated: the working-tree diff sat at priority 1, was dropped rather than truncated, and a
 *    *general* implementation round would have returned a verdict having seen the file list, the
 *    statistics and the evidence matrix — and no code — with nothing failing.
 */
/**
 * Move a previous attempt's artefacts aside before this invocation writes anything.
 *
 * The review JSON, the pack, the prompt and the raw reviewer outputs all wrote to fixed,
 * round-named paths, so a rerun destroyed the only copy of what a previous round found — for an
 * unadjudicated finding, without trace. Renamed rather than copied: every downstream reader
 * resolves `a.review(round)` and keeps reading the current attempt; the archive is for audit.
 * Failed attempts are archived too — a dead replay must not destroy a completed round's record,
 * and a failed record is provenance in its own right.
 */
function archiveExistingRound() {
  let existing;
  try {
    existing = fs.statSync(a.review(round)).isFile();
  } catch {
    existing = false;
  }
  if (!existing) return;
  let n = 1;
  while (fs.existsSync(path.join(a.reviewsDir, `${round}.attempt${n}.json`))) n += 1;
  try {
    fs.renameSync(a.review(round), path.join(a.reviewsDir, `${round}.attempt${n}.json`));
    for (const f of fs.readdirSync(a.packsDir)) {
      if (f === `${round}.md` || f === `${round}.prompt.md` || f.startsWith(`${round}.md.`)) {
        fs.renameSync(path.join(a.packsDir, f), path.join(a.packsDir, `attempt${n}.${f}`));
      }
    }
  } catch (err) {
    // An archive that cannot be written must not block the round — but overwriting evidence
    // silently is the defect this exists to fix, so failing loudly is the only honest fallback.
    fail(`Cannot archive the previous '${round}' attempt before re-running it: ${err.message}`);
  }
}

function mandatoryGaps(pack) {
  return [
    ...(pack.droppedMandatory ?? []).map((t) => `${t} (dropped entirely)`),
    // Truncation is only a gap when the reviewer cannot obtain the rest. A diff too large for any
    // pack is the normal case on a large change, and it carries the command that reads it in
    // full; failing there would block every big feature. A section truncated with nowhere to go
    // is the real gap, which is why the recovery path is recorded per section rather than assumed.
    ...(pack.truncatedMandatoryWithoutRecovery ?? []).map((t) => `${t} (truncated, no source given)`),
    // Present, small, and empty of the thing it is named after.
    ...(pack.unavailableMandatory ?? []).map((t) => `${t} (could not be read — placeholder only)`),
  ];
}

function mandatoryGapMessage(roundName, gaps) {
  return (
    `Review pack for '${roundName}' could not carry context this round cannot run without: ` +
    `${gaps.join('; ')}.\n\nA round that cannot see its own subject — the artefact under review, ` +
    `or for a targeted round the findings it must verify (spec §8.7) — is not a weaker review, ` +
    `it is a different one. Reduce the artefact under review, or raise ` +
    `codex.reviewPackMaxBytes in .hyperpowers.json.`
  );
}

function finalise(value, model, effort, attempts, artifactDigest) {
  // Ids arrive reviewer-local (F1, 1, DESIGN-001…). Normalising them to a stable, artefact
  // scoped form is what lets round two verify round one's findings by id (spec §23 Risk 4).
  // Ids must also be unique within the round: a reviewer that returns two findings labelled
  // `DESIGN-001` would otherwise keep both, and every downstream lookup — adjudication by id,
  // round-two verification by id, open-blocker tracking — silently addresses only one of them.
  const usedIds = new Set();
  const findings = (value.findings ?? []).map((f, i) => {
    let id = /^[A-Z]+-\d{3,}$/.test(f.id) ? f.id : `${ID_PREFIX}-${String(i + 1).padStart(3, '0')}`;
    if (usedIds.has(id)) {
      let n = i + 1;
      do { id = `${ID_PREFIX}-${String(n += 1).padStart(3, '0')}`; } while (usedIds.has(id));
    }
    usedIds.add(id);
    return { ...f, id, artifact: spec.artifact, round };
  });
  return {
    round, status: 'completed', artifact: spec.artifact, kind: spec.kind,
    // The version of the artefact this verdict is about — computed when the pack was built, not
    // here: the reviewer read the version the pack carried, and for the implementation the tree
    // can legitimately move while the review runs. Without it a review proves only that *some*
    // review happened, and the gate cannot see that the artefact moved underneath it — see
    // `reviewedArtifactDigest`.
    artifactDigest,
    // The model and effort that actually answered, which may differ from the round's routing
    // after a fallback. Completion condition §13.12 compares the two.
    model, effort, requestedModel: spec.model, requestedEffort: spec.effort, at: nowIso(),
    verdict: value.verdict, summary: value.summary,
    residual_risks: value.residual_risks ?? [],
    coverage_notes: value.coverage_notes ?? '',
    findings, attempts,
  };
}

function buildPrompt(roundName, roundSpec, pack) {
  const promptFile = path.join(
    PLUGIN_ROOT, 'prompts',
    roundSpec.kind === 'targeted' ? 'targeted-rereview.md' : `${roundSpec.artifact}-adversarial-review.md`,
  );
  const sharedFile = path.join(PLUGIN_ROOT, 'prompts', '_shared-contract.md');
  let template;
  let shared;
  try {
    template = fs.readFileSync(promptFile, 'utf8');
    shared = fs.readFileSync(sharedFile, 'utf8');
  } catch (err) {
    fail(`Missing review prompt template: ${err.message}`);
  }
  // The output contract lives in exactly one file; every round substitutes it in, so the
  // schema, the id convention and the coverage rules can never drift between rounds.
  //
  // **Every replacement is a function, and that is load-bearing.** `String.replaceAll` honours
  // `$$`, `$&`, `` $` `` and `$'` inside a *string* replacement even when the pattern is a plain
  // string. Artefacts are full of those sequences — `grep -Eq '^fail 0$'` ends in `$'`, which
  // means "insert everything after the match" — so substituting the pack as a string spliced the
  // remainder of this template into the middle of the reviewed content.
  //
  // Observed in a real run: a plan's verification command arrived at the reviewer as
  // `grep -Eq '^(ℹ|#) fail 0` followed by a bare `</review_pack>`, and Codex raised a **critical
  // blocking finding** against a malformation Hyperpowers had introduced. A review round, an
  // adjudication cycle and a correction were spent on a defect that did not exist in the artefact.
  //
  // The security reading is worse than the correctness one. `` $` `` splices the text *before* the
  // match — the prompt's own instructions — into the reviewed content. Any document containing it
  // could relocate part of the frame into the material being judged, which is precisely what
  // `neutraliseFrame` exists to prevent, arriving through the substitution itself rather than
  // through the delimiters. A replacer function is used verbatim and disables the whole class.
  const literal = (value) => () => value;
  return template
    .replaceAll('{{SHARED_CONTRACT}}', literal(shared))
    .replaceAll('{{ROUND}}', literal(roundName))
    .replaceAll('{{ARTIFACT}}', literal(roundSpec.artifact))
    .replaceAll('{{ID_PREFIX}}', literal(ID_PREFIX))
    .replaceAll('{{PACK}}', literal(neutraliseFrame(pack.text)));
}

/**
 * Defuse text inside the pack that would otherwise close or forge the prompt's own framing.
 *
 * The pack embeds material Hyperpowers does not author — the design and plan under review, and
 * in rounds 5–6 the working-tree diff. A file containing `</review_pack>` followed by its own
 * instructions landed in the prompt verbatim, so reviewed content could end the frame early and
 * address the reviewer directly, or forge the coverage-warning banner the pack uses to report
 * its own truncation honestly. Escaping the delimiters costs nothing and removes the whole
 * class; the reviewer still reads the content, it just cannot impersonate the harness.
 */
function neutraliseFrame(text) {
  // Visible, greppable replacements on purpose. The first version inserted a zero-width space,
  // which made the two strings look identical in source — a formatter, a copy-paste or any
  // Unicode-normalising step would have silently reverted the fix with nothing failing.
  return String(text ?? '')
    .replaceAll('</review_pack>', '[/review_pack]')
    .replaceAll('<review_pack>', '[review_pack]');
}

/**
 * Run one `codex exec`. Success is judged by the *output file*, not the exit code alone:
 * an error run writes no file (verified empirically), and a run can exit 0 while producing
 * a message that does not satisfy the schema.
 */
function invokeCodex({ model, effort, prompt, packPath }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const outFile = `${packPath}.${model}.last.json`;
    const logFile = `${packPath}.${model}.log`;
    try { fs.rmSync(outFile, { force: true }); } catch { /* fine */ }

    const args = [
      'exec',
      '--model', model,
      '-c', `model_reasoning_effort="${effort}"`,
      '--sandbox', config.codex.sandbox,
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-C', projectRoot,
      '--output-schema', outputSchemaPath,
      '-o', outFile,
      '--color', 'never',
    ];

    // `detached` puts the child in its own process group so the timeout can kill the *group*.
    // Killing only the immediate child left any helper it had forked still running — verified
    // against a stand-in binary — so a timed-out review could keep consuming the user's quota
    // after Hyperpowers had already recorded the round as failed and moved on.
    const child = spawn(config.codex.binary, args, { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let log = '';
    const capture = (buf) => { log += buf.toString(); if (log.length > 400_000) log = log.slice(-400_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole process group
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, config.codex.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, classification: 'binary_missing', reason: `cannot execute '${config.codex.binary}': ${err.message}`, ms: Date.now() - started });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      try { writeFileAtomic(logFile, log); } catch { /* logging is best-effort */ }

      if (signal === 'SIGKILL') {
        return resolve({ ok: false, classification: 'timeout', reason: `timed out after ${config.codex.timeoutMs} ms`, ms, logPath: logFile });
      }

      const raw = safeRead(outFile);
      if (raw === null) {
        return resolve({
          ok: false,
          classification: classifyFailure(log),
          reason: extractError(log) || `exit ${code} with no final message`,
          ms, logPath: logFile,
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return resolve({ ok: false, classification: 'malformed_output', reason: `final message was not JSON: ${err.message}`, ms, logPath: logFile });
      }

      const { valid, errors } = validate(parsed, outputSchema);
      if (!valid) {
        return resolve({ ok: false, classification: 'malformed_output', reason: `final message violated the review schema: ${errors.slice(0, 3).join('; ')}`, ms, logPath: logFile });
      }
      resolve({ ok: true, value: parsed, ms, logPath: logFile });
    });

    child.stdin.end(prompt);
  });
}

function safeRead(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

/**
 * Why an invocation failed.
 *
 * Order matters: transient network conditions are recognised *before* the model patterns.
 * There is exactly one fallback hop (Sol → Luna, then BLOCKED), so spending it on a blip is
 * spending all of it — and a message like "model endpoint temporarily not found, retry shortly"
 * matched the model pattern while describing a network fault. Anything unrecognised stays
 * `transient`, which retries rather than swapping models: the safe direction, since a wrong
 * `transient` costs one retry while a wrong `model_unavailable` costs the fallback.
 */
function classifyFailure(log) {
  if (/timed? out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|temporarily|retry shortly|502|503|504/i.test(log)) {
    return 'transient';
  }
  if (/is not supported when using Codex|model .* not found|invalid_enum_value.*model|unknown model|does not have access to/i.test(log)) {
    return 'model_unavailable';
  }
  if (/not logged in|authentication|unauthorized|401/i.test(log)) return 'auth';
  if (/rate limit|429|quota/i.test(log)) return 'rate_limited';
  return 'transient';
}

function extractError(log) {
  const match = log.match(/ERROR:\s*(\{[\s\S]*?\}|.+)/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed?.error?.message ?? match[1];
  } catch {
    return match[1].trim().slice(0, 300);
  }
}
