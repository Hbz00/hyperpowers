#!/usr/bin/env node
/**
 * Run reporting: list runs, and render the final report.
 *
 * The final report is generated from recorded facts rather than written from memory. What a
 * run *did* is on disk — transitions, reviews, adjudications, evidence, measured token usage —
 * so the report states it rather than reconstructing it, and cannot flatter the run by
 * omission.
 *
 *   report.mjs --list
 *   report.mjs final [--run <id>]
 */

import path from 'node:path';
import { parseArgs, fail, emitJson, ok, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { listRuns, artifacts } from './lib/paths.mjs';
import { readJson, readText, writeFileAtomic } from './lib/io.mjs';
import { tryLoadState, loadState } from './lib/state.mjs';
import { REVIEW_ROUNDS, EXTRA_ROUNDS, PHASES, TERMINAL_PHASES } from './lib/phases.mjs';
import { summarise, scoreAgainstTargets } from './lib/telemetry.mjs';
import { analyseTranscript } from './lib/transcript.mjs';

const { positional, flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);

if (flags.list === true || positional[0] === 'list') {
  const runs = listRuns(projectRoot).map((id) => {
    const s = tryLoadState(projectRoot, id);
    return s
      ? { runId: id, phase: s.phase, updatedAt: s.updatedAt, request: (s.request?.description ?? '').slice(0, 80) }
      : { runId: id, phase: 'unreadable' };
  });
  emitJson({ projectRoot, runs });
} else if (positional[0] === 'final') {
  renderFinal();
} else {
  fail('Usage: report.mjs --list | report.mjs final [--run <id>]');
}

/**
 * Rounds the report must account for: the six mandatory ones always, plus any §18 extra round
 * that actually ran.
 *
 * The completion gate learned this and the report did not, so a `<artifact>-extra` round could
 * decide the fate of a run and appear nowhere in the document the user reads. That is the worse
 * of the two omissions: the gate at least *failed* on an unadjudicated extra finding, whereas a
 * report simply not mentioning the round leaves no trace that anything was missing. And §18 only
 * sanctions an extra round after round 2 surfaced a **new blocker** — so the round most likely to
 * be absent from the audit is the one covering the run's most serious moment.
 */
function roundsThatMatter(a) {
  return [
    ...Object.keys(REVIEW_ROUNDS),
    ...Object.keys(EXTRA_ROUNDS).filter((name) => readJson(a.review(name), null)),
  ];
}

function renderFinal() {
  const runId = resolveRunId(projectRoot, flags);
  if (!runId) fail(`No Hyperpowers run found for ${projectRoot}.`);
  const state = loadState(projectRoot, runId);
  const a = artifacts(projectRoot, runId);
  const evidence = readJson(a.evidence, null);
  const usage = summarise(projectRoot, runId);
  const measured = state.observedUsage ?? null;

  const L = [];
  const p = (...lines) => L.push(...lines);

  p(`# Hyperpowers run report — ${runId}`, '');
  // `state.phase` is whatever the run is in *right now*. The phase table requires this report to
  // exist before `FINAL_ACCEPTANCE → COMPLETE`, so a report generated once records the phase it was
  // written in, not the outcome. History is authoritative: if a terminal phase was reached, that is
  // the outcome, and its transition — not `updatedAt`, which any later probe moves — is the finish.
  const terminal = [...(state.history ?? [])].reverse().find((h) => TERMINAL_PHASES.includes(h.to));
  const outcome = terminal?.to ?? state.phase;
  p(`**Outcome:** ${outcome}${state.blocked ? ` — ${state.blocked}` : ''}` +
    (terminal ? '' : ' *(not terminal yet — regenerate this report after the final transition)*') + '  ');
  p(`**Started:** ${state.createdAt}  `);
  p(`**Finished:** ${terminal?.at ?? state.updatedAt}  `);
  p(`**Duration:** ${humanDuration(Date.parse(state.updatedAt) - Date.parse(state.createdAt))}`, '');

  p('## What was asked for', '', state.request?.description || '(not recorded)', '');

  // --- acceptance criteria -----------------------------------------------------
  p('## Acceptance criteria', '');
  if (evidence?.criteria?.length) {
    p('| Criterion | Status | Evidence |', '| --- | --- | --- |');
    for (const c of evidence.criteria) {
      p(`| ${c.id} — ${escapePipes(c.statement)} | ${c.status} | ${escapePipes((c.evidence ?? []).join('; ')) || '—'} |`);
    }
    const unproven = evidence.criteria.filter((c) => c.status !== 'satisfied');
    if (unproven.length) {
      p('', `**${unproven.length} criterion/criteria are not proven satisfied:** ${unproven.map((c) => c.id).join(', ')}.`);
    }
  } else {
    p('No evidence matrix was produced. No acceptance criterion can be considered proven.');
  }
  p('');

  // --- verification ------------------------------------------------------------
  p('## Verification', '');
  if (evidence?.checks?.length) {
    p('| Check | Command | Result |', '| --- | --- | --- |');
    for (const c of evidence.checks) p(`| ${c.name} | \`${escapePipes(c.command)}\` | ${c.status} |`);
  } else {
    p('No suite-level checks were recorded.');
  }
  const residue = Object.entries(evidence?.residue ?? {}).filter(([, v]) => Array.isArray(v) && v.length);
  if (residue.length) {
    p('', '**Residue detected:**', '');
    for (const [k, v] of residue) p(`- ${k}: ${v.join(', ')}`);
  }
  p('');

  // --- reviews -----------------------------------------------------------------
  p('## Adversarial reviews', '');
  p('| Round | Model | Effort | Verdict | Findings | Blocking | Accepted | Rejected |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const round of roundsThatMatter(a)) {
    const review = readJson(a.review(round), null);
    if (!review) {
      p(`| \`${round}\` | — | — | **not run** | — | — | — | — |`);
      continue;
    }
    const decisions = state.adjudications?.[round]?.decisions ?? [];
    const count = (d) => decisions.filter((x) => x.decision === d).length;
    p(`| \`${round}\` | ${review.model ?? '—'} | ${review.effort ?? '—'} | ${review.verdict ?? review.status} | ` +
      `${review.findings?.length ?? 0} | ${(review.findings ?? []).filter((f) => f.blocking).length} | ${count('accepted')} | ${count('rejected')} |`);
  }
  p('');

  const openBlockers = state.openBlockers ?? [];
  if (openBlockers.length) {
    p('### Open blockers', '');
    for (const b of openBlockers) p(`- ${typeof b === 'string' ? b : `**${b.id}** (${b.round}, ${b.severity}) — ${b.reason}`}`);
    p('');
  }

  // --- risks -------------------------------------------------------------------
  p('## Residual risks and what was not verified', '');
  // Conditions the completion gate could not evaluate. It passes on them by design — a condition it
  // cannot judge is never silently counted as a pass — but the contract only permits that as
  // *stated* residual risk, so the statement has to appear here rather than depend on the director
  // remembering to write it.
  for (const [name, record] of Object.entries(state.gates ?? {})) {
    for (const item of record.unverifiable ?? []) {
      p(`- **Not verifiable by the ${name} gate** — ${item}`);
    }
  }
  const risks = [
    // Recorded risks are objects (`risk`, `source`); reviewer-reported ones are plain strings.
    ...(state.residualRisks ?? []).map((r) => (typeof r === 'string' ? r : `${r.risk}${r.source ? ` (${r.source})` : ''}`)),
    ...roundsThatMatter(a).flatMap((r) => readJson(a.review(r), null)?.residual_risks ?? []),
    ...((evidence?.criteria ?? []).filter((c) => c.status === 'unverifiable').map((c) => `${c.id} could not be verified: ${c.statement}`)),
  ];
  if (risks.length) for (const r of [...new Set(risks)]) p(`- ${r}`);
  else p('None recorded. That is a strong claim — treat it with suspicion if the feature was non-trivial.');
  p('');

  // --- process -----------------------------------------------------------------
  p('## Process', '');
  // The director's own tier, stated where a human reads it. `observedDirectorModel` is compared
  // against the configured tier and fails completion condition 12b on a mismatch; `observedEffort`
  // is only ever observed, so the report is the one place it can be noticed at all.
  {
    const expected = state.config?.models?.director ?? 'fable';
    const observed = state.observedDirectorModel ?? 'not observed';
    const effort = state.observedEffort ?? 'not observed';
    const configured = state.config?.effort?.default ?? 'high';
    p(`- Director tier: ${observed} (configured: ${expected}), effort ${effort}` +
      (effort !== 'not observed' && effort !== configured ? ` — **configured ${configured}**` : ` (configured: ${configured})`));
  }
  p(`- Phases traversed: ${state.history.length}`);
  p(`- Work packages: ${state.counters.workPackages}${usage.retries ? ` (${usage.retries} retried)` : ''}`);
  p(`- Subagents completed: ${state.counters.subagentsCompleted ?? 0}`);
  p(`- Codex invocations: ${state.counters.codexInvocations}`);
  p(`- Escalations: ${usage.escalations.sonnetToOpus} Sonnet→Opus, ${usage.escalations.opusToFable} Opus→Fable`);
  if (usage.policyBlocked) {
    p(`- Blocked policy attempts: ${usage.policyBlocked} (prevented before execution — not violations)`);
  }
  if (usage.policyViolations) {
    p(`- **Policy violations: ${usage.policyViolations}** — repository state changed during a read-only run`);
  }
  p(`- Model fallbacks: ${state.counters.fallbacks}${state.counters.fallbacks ? ' — see the event log for each from/to pair' : ''}`);
  if (state.gitDrift?.length) {
    // Two kinds, and conflating them would either understate a breach or overstate an
    // `npm install`. Entries from an older build carry no flag; treat those as escalated, which
    // is how they were recorded at the time.
    const escalated = state.gitDrift.filter((d) => d.escalated !== false);
    const noticed = state.gitDrift.filter((d) => d.escalated === false);
    if (escalated.length) {
      p(`- **Git drift detected ${escalated.length} time(s)** — the repository changed during a read-only run:`);
      for (const d of escalated) p(`  - ${d.at}: ${d.drift.join('; ')}`);
    }
    if (noticed.length) {
      p(`- Git state observed moving ${noticed.length} time(s) in ways ordinary tooling also produces (recorded, not counted as a violation):`);
      for (const d of noticed) p(`  - ${d.at}: ${d.drift.join('; ')}${d.command ? ` — after \`${escapePipes(d.command)}\`` : ''}`);
    }
  }
  p('');

  // --- cost --------------------------------------------------------------------
  p('## Cost and work distribution', '');
  p('Measured from the session transcript (per-model token usage including subagents), not estimated.', '');
  if (measured?.byFamily && Object.keys(measured.byFamily).length) {
    p('| Tier | Messages | Output tokens | Cost | Share of cost |', '| --- | --- | --- | --- | --- |');
    for (const [family, b] of Object.entries(measured.byFamily)) {
      p(`| ${family} | ${b.messages} | ${b.outputTokens.toLocaleString()} | $${b.costUsd.toFixed(2)} | ${measured.shares?.[family]?.costUsd ?? '—'}% |`);
    }
    p('', `**Total: $${measured.totals.costUsd.toFixed(2)}** across ${measured.totals.messages} model messages.`);
  } else {
    p(`Estimated $${usage.totals.costUsd.toFixed(2)} from recorded events; transcript measurement unavailable.`);
  }
  p('', 'Reference bands from the design intent (orientation only — nothing gates on these):', '');
  p('| Metric | Tier | Band | Observed | Within |', '| --- | --- | --- | --- | --- |');
  for (const row of scoreAgainstTargets(usage)) {
    p(`| ${row.metric} | ${row.tier} | ${row.target} | ${row.observed ?? '—'} | ${row.withinTarget === null ? '—' : row.withinTarget ? 'yes' : 'no'} |`);
  }
  p('');

  // The diagram is the one deliverable aimed at someone who will not read the rest, so it is
  // shown rather than linked. A `mermaid.live` URL is opaque, perishable and invisible unless
  // clicked; the source renders inline anywhere Markdown does.
  {
    const source = readText(path.join(a.base, 'diagram.mmd'), '');
    const url = state.artifacts?.diagramUrl ?? null;
    if (source || url) {
      p('## Product view', '');
      if (source) p('```mermaid', source.trim(), '```', '');
      if (url) p(`Published: ${url}`, '');
      if (!source) p('_Source not recorded with the run — only the link above survives._', '');
    }
  }

  p('## Artefacts', '');
  for (const [label, file] of [['Request', a.request], ['Design', a.design], ['Plan', a.plan], ['Tasks', a.tasks], ['Evidence', a.evidence], ['Reviews', a.reviewsDir], ['State', a.state]]) {
    p(`- ${label}: \`${file}\``);
  }
  p('');

  p('---', '', `Generated ${new Date().toISOString()} by Hyperpowers.`);

  const text = L.join('\n') + '\n';
  writeFileAtomic(a.finalReport, text);
  ok(text);
}

function escapePipes(s) {
  return String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
