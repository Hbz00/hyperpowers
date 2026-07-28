/**
 * Review pack assembly (spec §8.3, §12 phase 6, §23 Risk 5).
 *
 * A review pack is the *only* thing the external reviewer sees. Two properties matter:
 *
 *  1. **Bounded size.** The documented failure mode is a long adversarial review that burns
 *     tens of thousands of tokens and never returns a conforming message. The pack is capped,
 *     and sections are dropped by ascending priority when the cap binds.
 *  2. **Honest truncation.** Anything dropped is announced inside the pack, so the reviewer
 *     reports reduced coverage in `coverage_notes` instead of silently reviewing a fragment
 *     and declaring it clean.
 *
 * The reviewer never receives the producing agent's reasoning — only artefacts, evidence and
 * paths (spec §3.2, "le reviewer doit disposer d'un contexte propre").
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readText, readJson } from './io.mjs';
import { artifacts } from './paths.mjs';
import { ALL_ROUNDS } from './phases.mjs';
import { excludeOwnFiles } from './workspace.mjs';

/**
 * Run a read-only git command, returning `null` when it fails.
 *
 * Returning null rather than an error string matters: a failing `git diff --name-only` writes
 * multi-line usage text, and a caller that treated the result as data once parsed those lines
 * as filenames and reported git's own help output as out-of-scope changes. Failure must be
 * unambiguous at the type level, not encoded in a string a caller might forget to check.
 */
export function gitTry(projectRoot, args, { maxBytes = 400_000 } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.pager=cat', ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: maxBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return null;
  }
}

/** Same, but yielding a human-readable placeholder for inclusion in a review pack. */
export function gitRead(projectRoot, args, options) {
  const out = gitTry(projectRoot, args, options);
  return out === null ? `(git ${args.join(' ')} unavailable)` : out;
}

/** Line list from a read-only git command; an empty array means "no data", never "no changes". */
export function gitLines(projectRoot, args, options) {
  const out = gitTry(projectRoot, args, options);
  if (out === null) return null;
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Ceiling for collecting the working-tree diff, deliberately far above `reviewPackMaxBytes`.
 *
 * The pack's own cap is what decides how much of a diff a reviewer sees; this only decides
 * whether the diff can be read at all. Keeping the two apart is the point — when they were the
 * same order of magnitude, "too large to show fully" and "too large to read" collapsed into one
 * outcome, and the larger the change the more likely the round was to see nothing.
 */
const DIFF_COLLECT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * @param {boolean} mandatory Marks a section the round cannot run without. Flagged structurally
 *   rather than recognised by title downstream: the adapter's hard-fail used to match section
 *   names defined here, so renaming one would have silently disabled the guard and returned the
 *   pack to exactly the behaviour the guard exists to prevent.
 * @param {object} [opts]
 * @param {string} [opts.recover] How the reviewer can obtain this content itself — an absolute
 *   path or a read-only command. No pack can carry a 600 kB diff, so a section that does not fit
 *   must say where the rest is rather than silently end. Measured: `codex exec --sandbox
 *   read-only -C <project>` reads absolute paths *outside* the project, including the run
 *   directory, and does so unprompted.
 * @param {string} [opts.boundary] A line prefix this section may only be cut on, so truncating a
 *   diff cannot hand the reviewer half a hunk and let it draw conclusions from the wreckage.
 * @param {boolean} [opts.unavailable] The source could not be read at all. A mandatory section
 *   satisfied by a placeholder is the emptiest kind of present: `gitRead` returns "(git diff …
 *   unavailable)" on failure, roughly forty bytes, which fits any budget — so the size path was
 *   closed while the failure path let a round proceed having seen no code.
 * @param {number} [opts.maxShare] Largest fraction of the whole budget this section may take,
 *   even when more is free. One section grows without bound with feature size — the diff — and
 *   letting it take everything starves the plan and the evidence it is meant to be checked
 *   against. Measured on a 29-file change: the diff alone was 145 kB of a 180 kB pack.
 */
function section(title, body, priority, mandatory = false, opts = {}) {
  return {
    title,
    body: String(body ?? '').trim(),
    priority,
    mandatory,
    recover: opts.recover ?? null,
    boundary: opts.boundary ?? null,
    maxShare: opts.maxShare ?? null,
    unavailable: opts.unavailable === true,
  };
}

/**
 * Build the ordered section list for a round.
 * Lower `priority` means "drop last" — the artefact under review is priority 0.
 */
export function collectSections(projectRoot, runId, round) {
  const a = artifacts(projectRoot, runId);
  const spec = ALL_ROUNDS[round];
  if (!spec) throw new Error(`Unknown review round '${round}'`);

  const sections = [];
  const request = readText(a.request, '');
  const design = readText(a.design, '');
  const plan = readText(a.plan, '');

  if (spec.artifact === 'design') {
    sections.push(section('ARTEFACT UNDER REVIEW — design.md', design, 0, false, { recover: a.design }));
    sections.push(section('ORIGINAL REQUEST', request, 1, false, { recover: a.request }));
    sections.push(section('CONSOLIDATED NEED (brainstorm summary)', readText(a.brainstorm, ''), 2, false, { recover: a.brainstorm }));
  }

  if (spec.artifact === 'plan') {
    sections.push(section('ARTEFACT UNDER REVIEW — plan.md', plan, 0, false, { recover: a.plan }));
    sections.push(section('WORK PACKAGES (tasks.json)', summariseTasks(readJson(a.tasks, { tasks: [] })), 1, false, { recover: a.tasks }));
    sections.push(section('LOCKED DESIGN (context, already reviewed and approved)', design, 2, false, { recover: a.design }));
    sections.push(section('ORIGINAL REQUEST', request, 3, false, { recover: a.request }));
  }

  if (spec.artifact === 'implementation') {
    // Hyperpowers' own files are excluded from the change under review, with the same list the
    // completion gate uses. Showing them was not a cosmetic problem: a live round-5 reviewer
    // raised a blocking finding against `.claude/settings.json`, correctly noting an unowned file
    // in the diff that disables workflows — and burned a mandatory round and an adjudication cycle
    // on `/hyperpowers:setup`'s own output. The gate already excused them; only the reviewer was
    // being shown a change the run had not made.
    const own = excludeOwnFiles();
    sections.push(section('CHANGED FILES', gitRead(projectRoot, ['status', '--short', '--untracked-files=all', ...own]), 0));
    sections.push(section('DIFF STATISTICS', gitRead(projectRoot, ['diff', '--stat', 'HEAD', ...own]), 0));
    sections.push(section('EVIDENCE MATRIX (criteria → proof)', formatEvidence(readJson(a.evidence, null)), 0, false, { recover: a.evidence }));
    // Priority 0 and mandatory: this *is* the artefact under review. At priority 1 it was dropped
    // outright rather than truncated — `renderPack` only truncates priority ≤ 0 — so a large
    // change produced a pack with the file list, the statistics and the evidence matrix and **no
    // code**, and the round returned a verdict on it. Simulated on a 120-file change: 600 kB of
    // diff dropped, `droppedMandatory` empty, nothing failed, 123 kB of a 180 kB budget used.
    // The command carries the same exclusions the section does. A bare `git diff HEAD` shows
    // Hyperpowers' own files, and a round-5 reviewer that saw them raised a blocking finding
    // against `/hyperpowers:setup`'s output — so an incomplete recovery instruction would
    // reintroduce, through the back door, the exact false positive the exclusion exists to stop.
    // Collected with a budget far above the pack's, because the renderer is what must bound this
    // section — not `execFileSync`. At the 400 kB default a 561 kB diff (one 535 kB file) came
    // back `null`, the section was marked unavailable and the round hard-failed: the truncation
    // and recovery path built for exactly that size was unreachable, since nothing ever reached
    // it. Measured in a real repository. Beyond this, failing is right — a diff that large is not
    // a review, it is a data dump.
    const diff = gitTry(projectRoot, ['diff', 'HEAD', ...own], { maxBytes: DIFF_COLLECT_MAX_BYTES });
    sections.push(section('WORKING TREE DIFF', diff ?? '(git diff HEAD unavailable)', 0, true, {
      unavailable: diff === null,
      recover: `run \`git diff HEAD ${own.join(' ')}\` in ${projectRoot} — verified to work under a read-only sandbox`,
      boundary: 'diff --git ',
      maxShare: 0.5,
    }));
    // What the implementers actually observed. Its absence was found by an adjudicator, not by a
    // reviewer: round 5 raised a **blocking** finding that the plan's mandatory mutation audit was
    // "not evidenced", and the adjudicator refuted the premise by pointing at
    // `reports/WP-002-attempt1.json`, which carries the whole mutation table — and noted the
    // report "was NOT in the review pack". The reviewer was shown the plan's *demands* and the
    // diff, and asked whether the work was finished, without the evidence that answers it. This is
    // evidence, not the producing agent's reasoning (spec §3.2): commands run, output observed,
    // what each agent states it did not verify.
    sections.push(section('WORK PACKAGE REPORTS (what each implementer observed)', formatReports(a), 2, false, {
      recover: `the JSON reports in ${a.reportsDir}`,
      boundary: '### ',
    }));
    sections.push(section('UNTRACKED FILE INVENTORY', gitRead(projectRoot, ['ls-files', '--others', '--exclude-standard', ...own]), 3));
    // The plan is what "fidelity" is measured against, and the prompt puts two of its nine attack
    // surfaces on it — *"where does the implementation diverge from the design or the plan"* and
    // *"behaviour in the design with no corresponding test"*. In the first production run both
    // this and the design were dropped, so those two surfaces were unanswerable and the reviewer
    // said so in its residual risks. Ahead of the design because the plan carries the task
    // contracts, the criterion→task map and the file ownership; the design is narrative around it.
    sections.push(section('LOCKED PLAN', plan, 1, false, { recover: a.plan }));
    sections.push(section('LOCKED DESIGN', design, 4, false, { recover: a.design }));
    sections.push(section('ORIGINAL REQUEST', request, 5, false, { recover: a.request }));
  }

  // Targeted rounds additionally receive the previous round and how it was adjudicated
  // (spec §8.7: round two must verify corrections, not repeat round one).
  if (spec.kind === 'targeted') {
    // Round 2 verifies round 1; an extra round verifies round 2, and names it explicitly.
    const previousRound = spec.verifies ?? round.replace(/-2$/, '-1');
    const previous = readJson(a.review(previousRound), null);
    const state = readJson(a.state, {});
    const adjudication = state.adjudications?.[previousRound] ?? null;
    // Priority -1, not 0: for a targeted round these two *are* the review. Round two verifies
    // corrections rather than repeating round one (spec §8.7), which is impossible without the
    // findings being verified and the decisions taken on them. At priority 0 they sorted last
    // among equal-priority peers (stable sort), so an oversized evidence or diff section
    // consumed the budget and these were the first things dropped — leaving a "targeted"
    // reviewer with nothing to target, announced only in a coverage note.
    // Deliberately given no `recover`, unlike the diff. A recovery path turns truncation from a
    // gap into a pointer, which is right for an artefact that grows without bound and wrong for
    // these: a findings list and an adjudication record are small and bounded, so one that does
    // not fit means something is badly wrong rather than merely large. Truncation here still
    // fails the round, which is the §8.7 guarantee — a targeted round with a partial view of what
    // it must verify is not a targeted round.
    sections.push(section(`PREVIOUS ROUND FINDINGS (${previousRound})`, formatFindings(previous), -1, true));
    sections.push(section('ADJUDICATION RECORD', formatAdjudications(adjudication, previous), -1, true));
  }

  return sections.filter((s) => s.body.length > 0);
}

function summariseTasks(tasks) {
  const list = tasks?.tasks ?? [];
  if (list.length === 0) return '';
  return list
    .map((t) =>
      [
        `## ${t.id} — ${t.status}`,
        `Objective: ${t.objective}`,
        `Owned files: ${(t.scope?.owned_files ?? []).join(', ') || '(none)'}`,
        `Acceptance criteria: ${(t.acceptance_criteria ?? []).join(', ') || '(none)'}`,
        `Verification: ${(t.verification?.commands ?? []).join(' && ') || '(none)'}`,
        `Depends on: ${(t.depends_on ?? []).join(', ') || '(none)'}`,
        `Out of scope: ${(t.out_of_scope ?? []).join('; ') || '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

function formatEvidence(evidence) {
  if (!evidence) return '';
  const lines = [];
  for (const c of evidence.criteria ?? []) {
    lines.push(`- [${c.status}] ${c.id}: ${c.statement}`);
    for (const e of c.evidence ?? []) lines.push(`    proof: ${e}`);
  }
  if (evidence.checks?.length) {
    lines.push('', 'Suite-level checks:');
    for (const c of evidence.checks) lines.push(`- ${c.name}: ${c.status} (${c.command})`);
  }
  const residue = evidence.residue ?? {};
  const residueLines = Object.entries(residue)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `- ${k}: ${v.join(', ')}`);
  if (residueLines.length) lines.push('', 'Residue detected:', ...residueLines);
  return lines.join('\n');
}

/**
 * The work-package reports, as evidence rather than narrative.
 *
 * `results` and `evidence` are the parts a reviewer can check — a command, what it was expected to
 * print, what it actually printed. `unverified` and `risks` are included because an implementer
 * stating what it did *not* check is the most useful thing in the file, and hiding it would make
 * the dossier read stronger than it is.
 */
function formatReports(a) {
  let files;
  try {
    files = fs.readdirSync(a.reportsDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return '';
  }
  // `reports/` holds three unrelated things: the file an agent writes at the path its prompt
  // gives it (`WP-001.json`), the copy the validator stores (`WP-001-attempt1.json`), and the
  // adjudication ledgers (`design-1-decisions.json`). Rendering the directory verbatim sent every
  // report **twice** and three empty blocks besides: measured on the first production run, 13
  // blocks for 6 work packages, 24 kB of a 72 kB section — which is what evicted the locked plan.
  // Keep the highest attempt per work package; a ledger has no `work_package_id` and is not one.
  // `storedAt` is stamped by the one code path that *accepts* a report, so it is the difference
  // between what the run stands behind and a draft an agent happened to leave at the path its
  // prompt named. Deduplicating on the id alone was not enough: `sort()` puts
  // `WP-001-attempt1.json` before `WP-001.json` (`-` < `.`), so the unvalidated draft overwrote
  // the stored record — verified on the production run, where the surviving block read
  // "WP-001 — complete (implementer)" instead of the stored one that disclosed its own report had
  // been reconstructed. A report the validator refused is not evidence; it is kept in
  // `reports/rejected/` for the coordinator, and belongs nowhere near the contradictor.
  const latest = new Map();
  for (const file of files) {
    const r = readJson(path.join(a.reportsDir, file), null);
    if (!r?.work_package_id || !r.storedAt) continue;
    const seen = latest.get(r.work_package_id);
    if (!seen || (r.attempt ?? 1) > (seen.attempt ?? 1)) latest.set(r.work_package_id, r);
  }

  const blocks = [];
  for (const r of latest.values()) {
    const lines = [`### ${r.work_package_id} — ${r.status ?? 'unknown'} (${r.agent ?? 'unknown agent'})`];
    for (const c of r.commands_run ?? []) lines.push(`  ran: ${c}`);
    for (const res of r.results ?? []) {
      lines.push(`  [${res.passed ? 'pass' : 'FAIL'}] ${res.check}`);
      lines.push(`      expected: ${res.expected}`);
      lines.push(`      observed: ${res.observed}`);
    }
    for (const e of r.evidence ?? []) lines.push(`  evidence: ${e}`);
    for (const u of r.unverified ?? []) lines.push(`  NOT verified: ${u}`);
    for (const k of r.risks ?? []) lines.push(`  risk: ${k}`);
    if (r.out_of_scope_changes?.length) lines.push(`  declared out-of-scope writes: ${r.out_of_scope_changes.join(', ')}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function formatFindings(review) {
  if (!review?.findings?.length) return review ? '(previous round reported no findings)' : '';
  return review.findings
    .map((f) =>
      `### ${f.id} [${f.severity}${f.blocking ? ', blocking' : ''}] ${f.category} @ ${f.location}\n` +
      `Claim: ${f.claim}\nRecommendation: ${f.recommendation}`,
    )
    .join('\n\n');
}

function formatAdjudications(adjudication, review) {
  const decisions = adjudication?.decisions ?? [];
  if (decisions.length === 0) return '';
  const byId = new Map((review?.findings ?? []).map((f) => [f.id, f]));
  return decisions
    .map((d) => {
      const f = byId.get(d.finding_id);
      return [
        `### ${d.finding_id} → ${d.decision.toUpperCase()}`,
        f ? `Original claim: ${f.claim}` : null,
        `Rationale: ${d.rationale}`,
        d.required_change ? `Change applied: ${d.required_change}` : null,
        d.verification ? `Verification: ${d.verification}` : null,
        d.duplicate_of ? `Duplicate of: ${d.duplicate_of}` : null,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/**
 * Truncate to a **byte** budget without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, and every budget in this file is counted in
 * bytes. On ASCII the two agree, which is why the mismatch survived: on accented Latin text a
 * 10,000-byte cap produced a 17,772-byte pack, and on CJK a 26,397-byte one — measured, not
 * estimated. That defeats the one number the "review that never returns" mitigation depends on
 * (spec §23 Risk 5), and it does so on exactly the projects whose artefacts are not in English.
 *
 * Cutting at `maxBytes` can land inside a multi-byte sequence, so the cut walks back over UTF-8
 * continuation bytes (`0b10xxxxxx`) rather than emitting a replacement character. Astral
 * characters are one four-byte sequence here, so surrogate pairs need no separate handling.
 */
function sliceBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) return String(text ?? '');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

const TRUNCATION_MARK = '\n\n[TRUNCATED: section exceeded the review-pack budget';

/**
 * Cut `text` to `maxBytes`, backing up to the last `boundary` line when one is given.
 *
 * A diff cut at an arbitrary byte ends mid-hunk, and a reviewer reading half a hunk is reasoning
 * about code that does not exist. Backing up to the last `diff --git` keeps every file shown
 * whole; showing fewer files honestly beats showing one of them wrongly.
 */
function sliceOnBoundary(text, maxBytes, boundary) {
  const cut = sliceBytes(text, maxBytes);
  if (!boundary || cut.length === text.length) return cut;
  const at = cut.lastIndexOf(`\n${boundary}`);
  return at > 0 ? cut.slice(0, at) : cut;
}

/**
 * Render sections into a single document under `maxBytes`.
 * @returns {{text: string, dropped: string[], truncated: string[], truncatedMandatory: string[],
 *   droppedMandatory: string[], bytes: number}}
 */
export function renderPack(sections, maxBytes) {
  const dropped = [];
  const truncated = [];
  const droppedMandatory = [];
  const truncatedMandatory = [];
  // A mandatory section cut short with no stated source is unrecoverable; one that names where
  // the rest lives is merely partial. The adapter fails on the first and tolerates the second.
  const truncatedMandatoryWithoutRecovery = [];
  const unavailableMandatory = sections.filter((s) => s.mandatory && s.unavailable).map((s) => s.title);
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);

  const header = (s) => `\n\n${'='.repeat(72)}\n${s.title}\n${'='.repeat(72)}\n\n`;
  // The coverage notice is prepended after the sections are chosen, so its size has to be
  // reserved up front or the pack overshoots the cap it exists to enforce — the one number the
  // "review that never returns" mitigation depends on. Reserved unconditionally: a pack that
  // needs no notice merely comes in slightly under budget, which is the harmless direction.
  // Raised from 1 kB once the notice started carrying recovery paths: it is now the instruction
  // that makes a dropped section retrievable, so clamping it away would remove the remedy along
  // with the complaint.
  const NOTICE_ALLOWANCE = 2_048;
  let budget = Math.max(0, maxBytes - NOTICE_ALLOWANCE);
  const kept = [];

  for (const s of ordered) {
    const cost = Buffer.byteLength(header(s)) + Buffer.byteLength(s.body);
    // A share cap turns "first served" into "served, then the rest still eats". Without it the
    // diff — the one section that grows with the size of the feature — took the whole budget on a
    // 29-file change and the locked plan, the reports and the evidence it is checked against were
    // all dropped. Capped, everything is present in some form and whatever was cut says where the
    // rest is; the reviewer is proven able to fetch it.
    const shareCap = s.maxShare ? Math.floor(maxBytes * s.maxShare) : Infinity;
    if (cost <= budget && cost <= shareCap) {
      kept.push(s);
      budget -= cost;
      continue;
    }
    // Sections at priority <= 0 are the artefact under review and (for a targeted round) the
    // findings it must verify: truncate rather than drop them, because a review missing these
    // is not a weaker review, it is a different one.
    //
    // The budget is decremented by what the truncated body actually costs rather than being
    // zeroed. Zeroing meant the *first* oversized section consumed the entire remaining budget
    // and every later section — including other mandatory ones — was dropped outright.
    const mark = s.recover ? `${TRUNCATION_MARK}\nThe rest is at: ${s.recover}]` : `${TRUNCATION_MARK}]`;
    const room = Math.min(budget, shareCap) - Buffer.byteLength(header(s)) - Buffer.byteLength(mark);
    // Truncate anything that can be cut on a safe boundary *and* says where the rest is; drop
    // only what can be neither. The greedy skip left 47 kB of budget unspent while dropping a
    // 48 kB section whole — measured on the production run — because "may be truncated" was tied
    // to priority rather than to whether truncating it produces something honest.
    const cuttable = s.priority <= 0 || (s.boundary && s.recover);
    if (cuttable && room > 2_000) {
      const body = `${sliceOnBoundary(s.body, room, s.boundary)}${mark}`;
      kept.push({ ...s, body });
      truncated.push(s.title);
      if (s.mandatory) {
        truncatedMandatory.push(s.title);
        if (!s.recover) truncatedMandatoryWithoutRecovery.push(s.title);
      }
      budget -= Buffer.byteLength(header(s)) + Buffer.byteLength(body);
      continue;
    }
    dropped.push(s.title);
    if (s.mandatory) droppedMandatory.push(s.title);
  }

  // Naming where a dropped section can be read turns the warning from an apology into an
  // instruction. `codex exec --sandbox read-only` reads absolute paths outside the project — the
  // run directory included — so the reviewer can recover what the budget could not carry.
  const recoveryFor = new Map(sections.filter((s) => s.recover).map((s) => [s.title, s.recover]));
  const withRecovery = (titles) =>
    titles.map((t) => (recoveryFor.has(t) ? `${t} — read it at: ${recoveryFor.get(t)}` : t)).join('\n  ');

  let notice =
    dropped.length || truncated.length
      ? `\n\n${'!'.repeat(72)}\nCOVERAGE WARNING — this pack is incomplete.\n` +
        (truncated.length ? `Truncated sections:\n  ${withRecovery(truncated)}\n` : '') +
        (dropped.length ? `Omitted sections:\n  ${withRecovery(dropped)}\n` : '') +
        `You have read-only filesystem access: read the paths above before concluding anything ` +
        `about what they contain.\nYou MUST record this in "coverage_notes" and must NOT report ` +
        `"clean" for anything you could not see.\n${'!'.repeat(72)}\n`
      : '';
  // The allowance reserved above is a fixed number, so a pack that drops many long-titled
  // sections could produce a notice larger than the room kept for it and push the whole document
  // back over the cap — the notice announcing the cap being what broke it.
  if (Buffer.byteLength(notice) > NOTICE_ALLOWANCE) notice = `${sliceBytes(notice, NOTICE_ALLOWANCE - 4)}…\n`;

  // Restore authoring order for readability once the budget decision is made.
  const byTitle = new Map(kept.map((s) => [s.title, s]));
  const text =
    notice +
    sections
      .filter((s) => byTitle.has(s.title))
      .map((s) => header(s) + byTitle.get(s.title).body)
      .join('');

  return {
    text, dropped, truncated, droppedMandatory, truncatedMandatory,
    truncatedMandatoryWithoutRecovery, unavailableMandatory, bytes: Buffer.byteLength(text),
  };
}

export function buildPack(projectRoot, runId, round, maxBytes) {
  const sections = collectSections(projectRoot, runId, round);
  return renderPack(sections, maxBytes);
}
