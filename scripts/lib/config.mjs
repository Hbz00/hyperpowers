/**
 * Configuration: built-in defaults, overridable per project.
 *
 * Bounds exist to stop a *failing* loop from burning tokens indefinitely (spec §18); they are
 * not there to interrupt a healthy feature. Defaults are therefore generous, and every one of
 * them is reported in the run summary so a run that hits a bound says so plainly instead of
 * silently degrading.
 */

import path from 'node:path';
import { readJson } from './io.mjs';

export const DEFAULTS = Object.freeze({
  models: {
    director: 'fable',
    coordinator: 'opus',
    worker: 'sonnet',
  },

  /**
   * Spec §7.4. `high` is also the harness default for all three models (ledger A5), so this
   * profile is mainly about *when* to escalate, not about overriding a default.
   */
  effort: {
    default: 'high',
    escalation: 'xhigh',
    maxEnabled: false,
    mediumEnabled: false,
  },

  codex: {
    binary: process.env.HYPERPOWERS_CODEX_BIN || 'codex',
    timeoutMs: 15 * 60 * 1000,
    retries: 1,
    /** Spec §23 Risk 5: an oversized pack is the main cause of a review that never returns. */
    reviewPackMaxBytes: 180_000,
    sandbox: 'read-only',
    /**
     * Spec §8.6: "Sol High indisponible → Luna Xhigh". The escalation to `xhigh` is part of the
     * fallback, not an afterthought — Luna is not expected to match Sol's architectural
     * judgement, so it is given more reasoning to compensate. Carrying the original effort
     * across (which is what happened) quietly degraded the review twice over. Luna does not
     * degrade further; the run blocks instead.
     */
    fallback: {
      'gpt-5.6-sol': { model: 'gpt-5.6-luna', effort: 'xhigh' },
      'gpt-5.6-luna': null,
    },
  },

  /**
   * Spec §18. Every bound listed here is enforced by the Stop controller, which transitions the
   * run to `BUDGET_EXCEEDED` rather than letting it degrade quietly.
   *
   * `maxAttemptsPerTask` is the exception: it bounds a decision the coordinator makes inside a
   * single turn, so it is stated in the routing policy and surfaced in the run report, but no
   * hook sits between the coordinator and its own retry. It is listed in `ADVISORY_BOUNDS` so
   * `/hyperpowers:status` can say which bounds are mechanical and which are instructions — an
   * inert bound that looks mechanical is worse than an honest advisory one.
   *
   * `maxExtraReviewsPerArtifact` used to be advisory too, for a worse reason: the extra round
   * had no implementation at all, so the bound governed something nobody could do. Now that
   * `<artifact>-extra` is a real round, the adapter enforces it.
   */
  budgets: {
    maxCostUsd: 100,
    maxDurationMs: 6 * 60 * 60 * 1000,
    maxWorkPackages: 80,
    maxAttemptsPerTask: 3,
    maxExtraReviewsPerArtifact: 1,
    maxFallbacks: 3,
    maxSubagents: 200,
    /**
     * Files one work package may own, enforced by the plan gate.
     *
     * Not a style preference — a turn budget. Measured across six packages of one run: 3, 4, 5
     * and 5 owned files finished in 37 to 40 turns against a cap of 40, and **9 files exhausted
     * both a 40-turn implementer and a 50-turn retry**, leaving the coordinator to finish the
     * work itself. Seven sits above every size observed to succeed and below the one observed to
     * fail. Raise it deliberately if a change genuinely cannot be split.
     */
    maxFilesPerWorkPackage: 7,
  },

  stop: {
    /**
     * The harness caps consecutive Stop-hook blocks (ledger D4: default 8, raised via
     * `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Hyperpowers yields `softCapMargin` blocks early so a
     * run ends on a clean, resumable `SUSPENDED` state rather than being cut off mid-phase.
     */
    blockCap: 200,
    softCapMargin: 4,
    /**
     * Consecutive no-progress cycles before each escalation step (spec §16.3), and the shortest
     * time a "cycle" may be.
     *
     * Without the interval, a cycle is one Stop-hook firing, and the Stop hook fires every time the
     * director yields the turn — every few seconds when work is in flight. The second full run
     * walked all four rungs in 83 seconds and blocked a healthy `EXECUTION`. One minute is longer
     * than the gap between yields and far shorter than any work package measured (2.9–16 min), so
     * it separates "paused" from "stuck" without slowing a real impasse by more than five minutes.
     */
    stallMinIntervalMs: 60 * 1000,
    stallRetryAt: 1,
    stallEscalateOpusAt: 2,
    stallEscalateFableAt: 3,
    stallBlockAt: 5,
  },

  /**
   * `enforce: 'run'` — the read-only-Git guarantee is in force while a run owns the session,
   * and the user's own Git works normally the rest of the time. `'always'` makes it a standing
   * property of the project for anyone who wants that.
   */
  git: { mode: 'read-only', enforce: 'run' },

  /**
   * Parallel writes are opt-in per spec §15 and require disjoint, owned file sets. These are
   * guidance to the execution coordinator, not a scheduler: the plan gate rejects overlapping
   * ownership among parallel-safe packages, and `validate-agent-report` rejects a report whose
   * `files_modified` escape its package. Those two are the mechanical parts.
   */
  concurrency: { maxParallelWriters: 3, maxParallelReaders: 6 },
});

/**
 * Bounds stated to the coordinator rather than enforced by a hook.
 *
 * They are listed so `/hyperpowers:status` can name them as advisory. A limit that is neither
 * enforced nor mentioned is indistinguishable from one that does not exist — which is how three
 * budget bounds sat inert without anyone noticing.
 */
export const ADVISORY_BOUNDS = Object.freeze([
  'maxAttemptsPerTask',
  'maxParallelWriters',
  'maxParallelReaders',
]);

/**
 * Bounds enforced somewhere other than the Stop hook, with where.
 *
 * `describeBounds` used to answer "mechanical — the Stop hook transitions the run to
 * BUDGET_EXCEEDED" for everything not listed as advisory, which would have been a lie about the
 * first bound enforced by a gate. Naming the enforcer is the whole point of the distinction.
 */
export const GATE_ENFORCED_BOUNDS = Object.freeze({
  maxFilesPerWorkPackage: 'mechanical — the plan gate refuses a package that owns more files',
  maxExtraReviewsPerArtifact: 'mechanical — the Codex adapter refuses a further extra round',
});

/**
 * Which bound, if any, this run has passed — one implementation, used at every checkpoint.
 *
 * §K6 found `maxCostUsd` inert because nothing produced a cost figure, and fixed the producer.
 * The first real run then showed the mirror image: the figure exists, and the breaker is
 * *consulted* only inside the Stop controller. That controller ran **once** in 86 minutes,
 * because a healthy run spends the whole turn dispatching subagents and never tries to end it.
 * The bound was therefore evaluated once, near the start, and never again across nineteen phase
 * transitions. A budget checked once is not a budget, which is exactly what §K6 said about a budget
 * with no producer. (The figure it was compared against was also inflated ~2× by the row-summing
 * defect of §P7, so the run it was drawn from never actually approached its limit — a bound that is
 * neither consulted nor correctly measured fails twice over.)
 *
 * Living here rather than in the Stop controller is the point: every caller that can plausibly
 * notice — the controller, and each phase transition — asks the same question of the same code.
 */
export function budgetOverrun({ config, state, elapsedMs, measuredCost }) {
  const c = state?.counters ?? {};
  const b = config.budgets ?? {};
  if (elapsedMs > b.maxDurationMs) return 'maxDurationMs';
  if (measuredCost > b.maxCostUsd) return 'maxCostUsd';
  if ((c.workPackages ?? 0) > b.maxWorkPackages) return 'maxWorkPackages';
  if ((c.subagentsCompleted ?? 0) > b.maxSubagents) return 'maxSubagents';
  if ((c.fallbacks ?? 0) > b.maxFallbacks) return 'maxFallbacks';
  return null;
}

/** Every configured bound, flattened, each labelled with what actually enforces it. */
export function describeBounds(config) {
  const entries = [
    ...Object.entries(config.budgets ?? {}),
    ...Object.entries(config.concurrency ?? {}),
  ];
  return Object.fromEntries(entries.map(([key, limit]) => [
    key,
    {
      limit,
      enforcement: ADVISORY_BOUNDS.includes(key)
        ? 'advisory — stated to the coordinator, not enforced by a hook'
        : GATE_ENFORCED_BOUNDS[key]
          ?? 'mechanical — the Stop hook transitions the run to BUDGET_EXCEEDED',
    },
  ]));
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/**
 * Load effective config. Project overrides live in `.hyperpowers.json` at the project root —
 * a normal, reviewable file rather than hidden state.
 */
/**
 * Settings a project file may never set, because they are the guarantees rather than the tuning.
 *
 * `.hyperpowers.json` is deep-merged over the defaults, which made every nested field reachable —
 * including `codex.sandbox`. A project could set `danger-full-access` and the adapter passed it
 * straight to the CLI, turning the independent read-only contradictor into a writer; `codex.binary`
 * could replace the contradictor outright. Neither field is advertised as configurable, and both
 * are excluded from the review pack as Hyperpowers' own file, so the change would be invisible to
 * the reviewer it subverts.
 */
const IMMUTABLE_PATHS = Object.freeze([
  ['codex', 'sandbox'],
  ['codex', 'binary'],
  ['git', 'mode'],
]);

function stripImmutable(overrides) {
  const rejected = [];
  const clone = JSON.parse(JSON.stringify(overrides));
  for (const [group, key] of IMMUTABLE_PATHS) {
    if (clone?.[group] && Object.prototype.hasOwnProperty.call(clone[group], key)) {
      rejected.push(`${group}.${key}`);
      delete clone[group][key];
    }
  }

  // A bound whose default is a number must stay one. Every comparison here is `observed > limit`,
  // and `9 > "seven"` is `false` — so a mistyped override does not raise the limit, it deletes it,
  // silently, which is the exact defect class this project keeps finding in itself. Reproduced
  // against `maxFilesPerWorkPackage`; `maxCostUsd` and every other budget had the same exposure.
  // Dropped back to the default and reported through the channel that already exists for a
  // refused override, because a bound the user believes they set is worse than one they did not.
  for (const group of ['budgets', 'concurrency', 'stop', 'codex']) {
    const defaults = DEFAULTS[group] ?? {};
    for (const key of Object.keys(clone?.[group] ?? {})) {
      if (typeof defaults[key] !== 'number') continue;
      const value = clone[group][key];
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      rejected.push(`${group}.${key} (not a finite number: ${JSON.stringify(value)})`);
      delete clone[group][key];
    }
  }
  return { clone, rejected };
}

export function loadConfig(projectRoot) {
  const raw = readJson(path.join(projectRoot, '.hyperpowers.json'), null);
  const { clone: overrides, rejected } = raw ? stripImmutable(raw) : { clone: null, rejected: [] };
  let config = overrides ? deepMerge(DEFAULTS, overrides) : DEFAULTS;
  if (rejected.length) config = { ...config, rejectedOverrides: rejected };

  const envCap = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP);
  if (Number.isFinite(envCap) && envCap > 0) {
    config = deepMerge(config, { stop: { blockCap: envCap } });
  }
  return config;
}

/**
 * The environment contract `/hyperpowers:setup` must establish.
 *
 * `plugin.json` cannot contribute `env` (ledger G4), so these must be written into the
 * project's `.claude/settings.json`. Hooks can read them back (ledger D6), which is how
 * preflight verifies the contract instead of trusting that setup ran.
 */
export const REQUIRED_ENV = Object.freeze({
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: {
    value: '2',
    why: 'Caps delegation at Fable → Opus → Sonnet and makes depth-3 spawning a harness error rather than a prompt request (spec §4.3).',
  },
  CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: {
    value: String(DEFAULTS.stop.blockCap),
    why: 'A whole feature runs inside one turn, so the consecutive-block cap must cover the run (spec §16.2).',
  },

  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: {
    value: '1',
    why: 'Removes the built-in commit/PR guidance that contradicts the read-only Git policy (spec §17).',
  },
  CLAUDE_CODE_DISABLE_WORKFLOWS: {
    value: '1',
    why: 'Workflow orchestration would run outside the state machine and its accounting (spec §17).',
  },
});

/**
 * Written by setup and reported by preflight, but never required.
 *
 * Spec §17 asks for the advisor to be off so escalation goes up this plugin's ladder and lands in
 * its ledger. That is a purity property, not a safety one: no run mechanism reads the variable, and
 * nothing breaks mechanically when an advisor exists. Its cost, however, is borne *outside* runs —
 * the variable is project-scoped, so requiring it took the advisor away from every ordinary session
 * in that repository. Refusing to start a run over it was disproportionate, and it contradicted the
 * README, which tells the user they may remove it. Reported, not enforced.
 */
export const RECOMMENDED_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: {
    value: '1',
    why: 'Hyperpowers supplies its own escalation path; a second advisor would arbitrate outside the ledger (spec §17). Optional: no run mechanism reads it.',
  },
});

/** Settings keys `/hyperpowers:setup` writes alongside `env`. */
export const REQUIRED_SETTINGS = Object.freeze({
  disableWorkflows: {
    value: true,
    why: 'Documented, non-managed setting — the supported route to disable Workflows (ledger E1).',
  },
  includeGitInstructions: {
    value: false,
    why: 'Settings-level equivalent of CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS.',
  },
});
