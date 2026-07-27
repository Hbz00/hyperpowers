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
 * @param {boolean} mandatory Marks a section the round cannot run without. Flagged structurally
 *   rather than recognised by title downstream: the adapter's hard-fail used to match section
 *   names defined here, so renaming one would have silently disabled the guard and returned the
 *   pack to exactly the behaviour the guard exists to prevent.
 */
function section(title, body, priority, mandatory = false) {
  return { title, body: String(body ?? '').trim(), priority, mandatory };
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
    sections.push(section('ARTEFACT UNDER REVIEW — design.md', design, 0));
    sections.push(section('ORIGINAL REQUEST', request, 1));
    sections.push(section('CONSOLIDATED NEED (brainstorm summary)', readText(a.brainstorm, ''), 2));
  }

  if (spec.artifact === 'plan') {
    sections.push(section('ARTEFACT UNDER REVIEW — plan.md', plan, 0));
    sections.push(section('WORK PACKAGES (tasks.json)', summariseTasks(readJson(a.tasks, { tasks: [] })), 1));
    sections.push(section('LOCKED DESIGN (context, already reviewed and approved)', design, 2));
    sections.push(section('ORIGINAL REQUEST', request, 3));
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
    sections.push(section('EVIDENCE MATRIX (criteria → proof)', formatEvidence(readJson(a.evidence, null)), 0));
    sections.push(section('WORKING TREE DIFF', gitRead(projectRoot, ['diff', 'HEAD', ...own]), 1));
    // What the implementers actually observed. Its absence was found by an adjudicator, not by a
    // reviewer: round 5 raised a **blocking** finding that the plan's mandatory mutation audit was
    // "not evidenced", and the adjudicator refuted the premise by pointing at
    // `reports/WP-002-attempt1.json`, which carries the whole mutation table — and noted the
    // report "was NOT in the review pack". The reviewer was shown the plan's *demands* and the
    // diff, and asked whether the work was finished, without the evidence that answers it. This is
    // evidence, not the producing agent's reasoning (spec §3.2): commands run, output observed,
    // what each agent states it did not verify.
    sections.push(section('WORK PACKAGE REPORTS (what each implementer observed)', formatReports(a), 1));
    sections.push(section('UNTRACKED FILE INVENTORY', gitRead(projectRoot, ['ls-files', '--others', '--exclude-standard', ...own]), 2));
    sections.push(section('LOCKED PLAN', plan, 3));
    sections.push(section('LOCKED DESIGN', design, 3));
    sections.push(section('ORIGINAL REQUEST', request, 4));
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
  const blocks = [];
  for (const file of files) {
    const r = readJson(path.join(a.reportsDir, file), null);
    if (!r) continue;
    const lines = [`### ${r.work_package_id ?? file} — ${r.status ?? 'unknown'} (${r.agent ?? 'unknown agent'})`];
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

const TRUNCATION_MARK = '\n\n[TRUNCATED: section exceeded the review-pack budget]';

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
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);

  const header = (s) => `\n\n${'='.repeat(72)}\n${s.title}\n${'='.repeat(72)}\n\n`;
  // The coverage notice is prepended after the sections are chosen, so its size has to be
  // reserved up front or the pack overshoots the cap it exists to enforce — the one number the
  // "review that never returns" mitigation depends on. Reserved unconditionally: a pack that
  // needs no notice merely comes in slightly under budget, which is the harmless direction.
  const NOTICE_ALLOWANCE = 1_024;
  let budget = Math.max(0, maxBytes - NOTICE_ALLOWANCE);
  const kept = [];

  for (const s of ordered) {
    const cost = Buffer.byteLength(header(s)) + Buffer.byteLength(s.body);
    if (cost <= budget) {
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
    const room = budget - Buffer.byteLength(header(s)) - Buffer.byteLength(TRUNCATION_MARK);
    if (s.priority <= 0 && room > 2_000) {
      const body = `${sliceBytes(s.body, room)}${TRUNCATION_MARK}`;
      kept.push({ ...s, body });
      truncated.push(s.title);
      if (s.mandatory) truncatedMandatory.push(s.title);
      budget -= Buffer.byteLength(header(s)) + Buffer.byteLength(body);
      continue;
    }
    dropped.push(s.title);
    if (s.mandatory) droppedMandatory.push(s.title);
  }

  let notice =
    dropped.length || truncated.length
      ? `\n\n${'!'.repeat(72)}\nCOVERAGE WARNING — this pack is incomplete.\n` +
        (truncated.length ? `Truncated sections: ${truncated.join('; ')}\n` : '') +
        (dropped.length ? `Omitted sections: ${dropped.join('; ')}\n` : '') +
        `You MUST record this in "coverage_notes" and must NOT report "clean" for anything you could not see.\n${'!'.repeat(72)}\n`
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

  return { text, dropped, truncated, droppedMandatory, truncatedMandatory, bytes: Buffer.byteLength(text) };
}

export function buildPack(projectRoot, runId, round, maxBytes) {
  const sections = collectSections(projectRoot, runId, round);
  return renderPack(sections, maxBytes);
}
