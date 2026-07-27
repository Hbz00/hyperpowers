/**
 * Append-only event log and the derived 1–3–9 distribution metrics (spec §6.2, §24).
 *
 * The point of the log is not observability for its own sake: the spec's central economic
 * claim is that work distributes as roughly 1 Fable : 3 Opus : 9 Sonnet. That claim is
 * unfalsifiable unless every model invocation is counted, so counting is a first-class
 * concern rather than a debugging aid.
 */

import { appendJsonl, readJsonl, readJson, nowIso } from './io.mjs';
import { artifacts } from './paths.mjs';
import { measuredUsageFor } from './transcript.mjs';

export const TIERS = Object.freeze(['fable', 'opus', 'sonnet', 'codex']);

export function logEvent(projectRoot, runId, event) {
  const record = { at: nowIso(), runId, ...event };
  try {
    appendJsonl(artifacts(projectRoot, runId).telemetry, record);
  } catch {
    // Telemetry must never break a run. A lost event is preferable to a wedged state machine.
  }
  return record;
}

export function readEvents(projectRoot, runId) {
  return readJsonl(artifacts(projectRoot, runId).telemetry);
}

/**
 * Cost is computed in exactly one place: `scripts/lib/transcript.mjs`.
 *
 * A second pricing table lived here, fed by a `usage` event that nothing ever emitted — so it
 * was both dead and wrong (it ignored cache read/write multipliers entirely). Two tables that
 * happen to agree today are a pricing change away from disagreeing silently, and the one a
 * future author would reach for first was the one no run used. The `usage` branch below is kept
 * only so a hand-written event cannot crash the aggregator; it contributes nothing.
 */

/**
 * Aggregate a run into the indicators listed in spec §6.2 so that the targets there can be
 * checked against reality rather than assumed.
 */
export function summarise(projectRoot, runId) {
  const events = readEvents(projectRoot, runId);
  const byTier = Object.fromEntries(
    TIERS.map((t) => [t, { workPackages: 0, decisions: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }]),
  );
  const summary = {
    runId,
    events: events.length,
    transitions: 0,
    workPackages: 0,
    retries: 0,
    escalations: { sonnetToOpus: 0, opusToFable: 0 },
    fallbacks: 0,
    codexRounds: 0,
    codexFindings: 0,
    codexFindingsAccepted: 0,
    codexFindingsRejected: 0,
    firstPassAcceptance: { accepted: 0, total: 0, rate: null },
    policyViolations: 0,
    policyBlocked: 0,
    measured: false,
    byTier,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    shares: { workPackages: {}, outputTokens: {}, costUsd: {} },
  };

  /** Work packages folded by id, so lifecycle chatter cannot inflate the counts. */
  const packages = new Map();

  for (const e of events) {
    switch (e.type) {
      case 'transition':
        summary.transitions += 1;
        if (Array.isArray(e.fallbacks)) summary.fallbacks += e.fallbacks.length;
        break;
      // A package emits an event at every lifecycle step (in_progress → reported → accepted),
      // from two different scripts. Counting each event as a package inflated the totals ~3×,
      // reported one retry per status change, and — because the status-change emitter hardcodes
      // `tier: 'sonnet'` — made the §6.2 work-package distribution unable to show Opus's real
      // share, which is the one number the 1–3–9 claim rests on. Events are therefore folded
      // per package id and counted once, below this loop.
      case 'work_package': {
        const id = e.workPackage ?? '(unattributed)';
        const previous = packages.get(id) ?? { tier: null, attempts: 1, outcome: null };
        packages.set(id, {
          // The submit path knows the real model; the status path does not. Prefer any explicit,
          // non-default attribution over the placeholder.
          tier: e.tierExplicit ? e.tier : (previous.tier ?? (TIERS.includes(e.tier) ? e.tier : null)),
          attempts: Math.max(previous.attempts, e.attempt ?? 1),
          outcome: ['accepted', 'failed'].includes(e.outcome) ? e.outcome : previous.outcome,
        });
        break;
      }
      case 'decision': {
        const tier = TIERS.includes(e.tier) ? e.tier : 'opus';
        byTier[tier].decisions += 1;
        break;
      }
      case 'usage': {
        const tier = TIERS.includes(e.tier) ? e.tier : 'sonnet';
        byTier[tier].inputTokens += e.inputTokens ?? 0;
        byTier[tier].outputTokens += e.outputTokens ?? 0;
        byTier[tier].durationMs += e.durationMs ?? 0;
        break;
      }
      case 'escalation':
        if (e.from === 'sonnet' && e.to === 'opus') summary.escalations.sonnetToOpus += 1;
        if (e.from === 'opus' && e.to === 'fable') summary.escalations.opusToFable += 1;
        break;
      case 'fallback':
        summary.fallbacks += 1;
        break;
      case 'codex_review':
        summary.codexRounds += 1;
        summary.codexFindings += e.findings ?? 0;
        break;
      case 'adjudication':
        if (e.decision === 'accepted') summary.codexFindingsAccepted += 1;
        if (e.decision === 'rejected') summary.codexFindingsRejected += 1;
        // Spec §6.2 asks for the Opus→Fable escalation rate. The datum was already logged on
        // every adjudication and simply never aggregated.
        if (e.escalated || e.decision === 'escalated_to_fable') summary.escalations.opusToFable += 1;
        break;
      case 'stall_escalation':
        if (e.to === 'opus') summary.escalations.sonnetToOpus += 1;
        if (e.to === 'fable') summary.escalations.opusToFable += 1;
        break;
      // A mutation that actually happened (detected by the PostToolUse guard) is a violation.
      // An attempt the PreToolUse hook stopped is the control working, and is counted apart —
      // conflating the two made prevention look like breach.
      case 'policy_violation':
        summary.policyViolations += 1;
        break;
      case 'policy_blocked':
        summary.policyBlocked += 1;
        break;
      default:
        break;
    }
  }

  // One count per package, not per lifecycle event.
  for (const pkg of packages.values()) {
    const tier = TIERS.includes(pkg.tier) ? pkg.tier : 'sonnet';
    byTier[tier].workPackages += 1;
    summary.workPackages += 1;
    if (pkg.attempts > 1) summary.retries += 1;
    // First-pass acceptance is about *settled* packages: one still in flight has no outcome to
    // judge, and counting it as a miss made a healthy run look like it was failing.
    if (pkg.outcome) {
      summary.firstPassAcceptance.total += 1;
      if (pkg.outcome === 'accepted' && pkg.attempts === 1) summary.firstPassAcceptance.accepted += 1;
    }
  }

  // Token and cost figures come from the session transcript, which records the model and real
  // usage of every assistant message including subagents. The event log has no producer for
  // them — there is no `usage` emitter — so reading only events reported $0.00 for every run and
  // left the distribution shares null. Ground truth wins; events remain the source for the
  // process counters above.
  //
  // Measured *now* rather than read from `state.observedUsage`, which the Stop controller writes
  // and which is therefore as old as the last continuation — one, in an 86-minute run. The
  // §6.2 distribution table exists to reveal a tier inversion; reading a snapshot from the run's
  // first minutes is how it would have missed one. The stored snapshot remains the fallback for a
  // run whose transcript has been rotated away.
  const state = readJson(artifacts(projectRoot, runId).state, null);
  // The memo is shared with the Stop controller, which analyses the same transcript on every
  // continuation: without it each caller re-parses megabytes for the same answer.
  const measured = measuredUsageFor(state, { cacheDir: artifacts(projectRoot, runId).base }) ?? state?.observedUsage ?? null;
  if (measured?.byFamily) {
    summary.measured = true;
    for (const [family, bucket] of Object.entries(measured.byFamily)) {
      if (!byTier[family]) continue;
      byTier[family].inputTokens = bucket.inputTokens ?? 0;
      byTier[family].outputTokens = bucket.outputTokens ?? 0;
      byTier[family].costUsd = bucket.costUsd ?? 0;
      byTier[family].messages = bucket.messages ?? 0;
    }
  }

  for (const t of TIERS) {
    summary.totals.inputTokens += byTier[t].inputTokens;
    summary.totals.outputTokens += byTier[t].outputTokens;
    summary.totals.costUsd += byTier[t].costUsd;
  }
  const share = (value, total) => (total > 0 ? Number(((value / total) * 100).toFixed(1)) : null);
  for (const t of TIERS) {
    summary.shares.workPackages[t] = share(byTier[t].workPackages, summary.workPackages);
    summary.shares.outputTokens[t] = share(byTier[t].outputTokens, summary.totals.outputTokens);
    summary.shares.costUsd[t] = share(byTier[t].costUsd, summary.totals.costUsd);
  }
  const fp = summary.firstPassAcceptance;
  fp.rate = fp.total > 0 ? Number(((fp.accepted / fp.total) * 100).toFixed(1)) : null;

  return summary;
}

/**
 * Spec §6.2 reference bands, expressed as ranges so a run can be described objectively.
 *
 * These are ORIENTATION, never enforcement. The 1–3–9 idea is a statement of intent — push
 * volume down the pyramid and keep judgement at the top — not a quota. Nothing in Hyperpowers
 * reads these to gate, block, retry or route: `scoreAgainstTargets` is consumed only by
 * `/hyperpowers:status` and the run report. A run that sits outside every band and produces a
 * correct feature is a good run; the metric is cost per correctly finished feature (§24), not
 * conformance to a ratio.
 */
export const TARGETS = Object.freeze({
  workPackages: { fable: [0, 10], opus: [20, 30], sonnet: [60, 70] },
  outputTokens: { fable: [0, 10], opus: [20, 25], sonnet: [65, 100] },
});

export function scoreAgainstTargets(summary) {
  const rows = [];
  for (const [metric, perTier] of Object.entries(TARGETS)) {
    for (const [tier, [lo, hi]] of Object.entries(perTier)) {
      const observed = summary.shares[metric]?.[tier];
      rows.push({
        metric,
        tier,
        target: `${lo}–${hi}%`,
        observed: observed === null || observed === undefined ? null : `${observed}%`,
        withinTarget: observed === null || observed === undefined ? null : observed >= lo && observed <= hi,
      });
    }
  }
  return rows;
}
