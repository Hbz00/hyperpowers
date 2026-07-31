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

/**
 * The subagent the director runs as.
 *
 * `/hyperpowers:feature` dispatches it; nothing about the user's session decides its tier. A
 * **subagent's** `effort:` pin holds unconditionally (§S3 T26) and its `model:` holds against the
 * session default (outranked only by a per-invocation argument and `CLAUDE_CODE_SUBAGENT_MODEL`,
 * §V2) — unlike a skill's pins (§Q8) and a *main-session* agent's effort (§Q16 T1b/T3), which is
 * why the director is a subagent rather than a launch flag, and why the PREFLIGHT transition
 * check reads the *observed* tier rather than trusting the declaration. This name is the contract
 * between `skills/feature`, the file in `agents/`, and every check that verifies the run is the
 * system it claims to be, so it exists once and is imported, never spelled out again.
 */
export const DIRECTOR_AGENT = 'hyperpowers-director';

/**
 * Agent names arrive namespaced from the harness (`hyperpowers:sonnet-researcher`, measured) but
 * may be written bare in frontmatter and payloads. Compare through here, never directly.
 */
export function bareAgentName(name) {
  const s = String(name ?? '');
  return s.slice(s.lastIndexOf(':') + 1);
}

/**
 * The block at which a controller yields to `SUSPENDED`, one implementation for both loops.
 *
 * The main thread and the director each have their own counter and their own harness cap (§R6),
 * but the *rule* for when to yield is one rule — and a rule copied into two files is a rule that
 * gets fixed in one of them. §S2 is what happens when this number stops describing reality.
 */
export function softBlockCap(config) {
  return Math.max(1, config.stop.blockCap - config.stop.softCapMargin);
}

export const DEFAULTS = Object.freeze({
  models: {
    director: 'fable',
    coordinator: 'opus',
    worker: 'sonnet',
  },

  /**
   * Spec §7.4. `high` is also the harness default for all three models (ledger A5), so this
   * profile is mainly about *when* to escalate, not about overriding a default.
   *
   * **Effort is never written into the user's settings**, even though §Q16 T6b measured that
   * `effortLevel` there would pin it: that file is project-scoped and would re-set the reasoning
   * effort of every ordinary session in the repository, which is the disproportion that demoted
   * `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` to optional. It does not need to be. Each agent declares its
   * own `effort:` and a subagent honours it (§S3 T26), so this value is what the *director's*
   * declaration is checked against — not something anybody has to install.
   *
   * `maxEnabled` and `mediumEnabled` used to sit here. Nothing read them — not a gate, not a hook,
   * not a prompt — so they were two booleans a user could set and watch have no effect, which is
   * the same defect as a bound that does not bind. Removed rather than wired: there is no rung
   * above `xhigh` this project routes to, and `medium` is a demotion nothing asks for.
   */
  effort: {
    default: 'high',
    escalation: 'xhigh',
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
   * Bounds on the **shape of the work**, not on how much a run may spend.
   *
   * There used to be five more here — `maxCostUsd`, `maxDurationMs`, `maxWorkPackages`,
   * `maxSubagents`, `maxFallbacks` — and crossing any of them moved the run to `BUDGET_EXCEEDED`.
   * That phase was terminal with no successors, and `resume-run.mjs` refuses every terminal phase
   * ("A terminal run is not resumable", exit 8). So the bound did not cap a run, it **destroyed**
   * one: three quarters of the way through a feature, with the design locked, the plan locked and
   * the packages built, the whole thing became unfinishable. Worse, the Stop controller printed
   * *"Raise it in .hyperpowers.json and `/hyperpowers:resume`"* — a remedy the resume path rejects.
   *
   * A cost ceiling that converts an expensive result into no result is not a safety feature. What
   * remains below are bounds a run can actually act on, and none of them ends anything:
   * `maxExtraReviewsPerArtifact` and `maxFilesPerWorkPackage` are gate-enforced, and
   * `maxAttemptsPerTask` is advisory — stated to the coordinator, enforced by nothing, and
   * `ADVISORY_BOUNDS` below says so. (This passage used to call two of them "retry breakers",
   * which overstated the advisory one — a §U-class claim sitting inside the very rationale for
   * removing the ceiling.) Spend and duration are measured and reported — see `costNoticeUsd` and
   * `durationNoticeMs` — because knowing is useful and dying is not.
   */
  budgets: {
    /**
     * Above this, every transition says so. Informational only: nothing stops, nothing refuses.
     * The number also renders on the director's status-line row, so the person paying sees it
     * without polling — `/hyperpowers:abort` is always available.
     */
    costNoticeUsd: 75,
    /**
     * Same shape for wall-clock. The spec asks for a configurable duration control and the cost
     * ceiling's removal (§S1) took the duration one with it, leaving no substitute at all —
     * although §K6 records duration as the one breaker that ever actually worked. Six hours sits
     * above both completed production runs (3h53m, 5h19m); a healthy run should never hear this.
     */
    durationNoticeMs: 6 * 60 * 60 * 1000,
    maxAttemptsPerTask: 3,
    maxExtraReviewsPerArtifact: 1,
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
     * The harness's real cap, not the one we wish for.
     *
     * This defaulted to **200** — the value a mandatory setup step used to write into the project's
     * `.claude/settings.json` as `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. The harness's own default is
     * **8** (ledger D4, reconfirmed on `SubagentStop` in §Q17 T20). So in any session where that
     * env var was not in force — which is now every session, since nothing writes settings any
     * more — the controller computed `softCap = 200 - 4 = 196`, never reached it, never yielded,
     * and the harness truncated the turn at 8 with no `SUSPENDED` state and nothing to resume.
     *
     * The mechanism built to make truncation graceful was inert exactly when it was needed. A
     * bound that does not bind is this codebase's signature defect; a bound that describes an
     * environment that is not the one you are running in is the same defect wearing a number.
     *
     * `loadConfig()` still raises this from `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` when it *is* set, so
     * a session launched with a higher cap gets the higher soft cap automatically.
     */
    blockCap: 8,
    /**
     * Blocks held back so the yield happens *before* the harness truncates.
     *
     * The margin absorbs disagreement between this counter and the harness's — ours resets on a
     * new `prompt_id`, theirs on the turn actually ending. Two is enough for an off-by-one and a
     * spare. It was 4, which was harmless against a cap of 200 and would surrender **half** the
     * budget against the real cap of 8.
     */
    softCapMargin: 2,
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
 * What this run has spent, and whether that is worth mentioning. **Never a reason to stop.**
 *
 * This replaces `budgetOverrun()`, which returned the name of a breached bound and whose callers
 * moved the run to `BUDGET_EXCEEDED`. Two measurements killed that design rather than one:
 *
 *   1. It did not work. The breaker was consulted from the Stop controller, which ran **once** in
 *      an 86-minute run (§O14) — evaluated near the start and never again across nineteen phase
 *      transitions. Adding the transition call site fixed the frequency but not the next problem.
 *   2. It was worse than not working. `BUDGET_EXCEEDED` is terminal with no successors, and
 *      `resume-run.mjs` refuses every terminal phase ("A terminal run is not resumable", exit 8).
 *      A run that crossed the line three quarters of the way through could not be continued at
 *      any price — while the Stop controller told the user to raise the bound and resume.
 *
 * So the answer to "this is costing a lot" is now to say so, every transition, and let the person
 * paying decide. `/hyperpowers:abort` was always the honest version of this feature.
 */
export function costNotice({ config, measuredCost }) {
  const threshold = config?.budgets?.costNoticeUsd;
  if (!Number.isFinite(threshold) || !Number.isFinite(measuredCost) || measuredCost <= threshold) return null;
  return `This run has spent $${measuredCost.toFixed(2)}, past the $${threshold} notice threshold. `
    + `Nothing is stopping — this is information, not a limit. `
    + `Use /hyperpowers:abort if it is no longer worth finishing.`;
}

/** Wall-clock sibling of `costNotice`: reports, never stops. Evaluated at the same checkpoints. */
export function durationNotice({ config, startedAt, now = Date.now() }) {
  const threshold = config?.budgets?.durationNoticeMs;
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(threshold) || !Number.isFinite(started)) return null;
  const elapsed = now - started;
  if (elapsed <= threshold) return null;
  const hours = (elapsed / 3_600_000).toFixed(1);
  return `This run has been going ${hours}h, past the ${(threshold / 3_600_000).toFixed(1)}h notice `
    + `threshold. Nothing is stopping — this is information, not a limit. `
    + `Use /hyperpowers:abort if it is no longer worth finishing.`;
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
      // The fallback used to read "the Stop hook transitions the run to BUDGET_EXCEEDED". Nothing
      // does that any more, and a label naming an enforcer that no longer exists is worse than no
      // label — `/hyperpowers:status` would report a bound as mechanical while nothing enforced it.
      enforcement: key === 'costNoticeUsd' || key === 'durationNoticeMs'
        ? 'informational — reported at every transition, never enforced'
        : ADVISORY_BOUNDS.includes(key)
          ? 'advisory — stated to the coordinator, not enforced by a hook'
          : GATE_ENFORCED_BOUNDS[key]
            ?? 'advisory — no mechanism ends a run for crossing it',
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

  // Finite is not safe. A *type*-valid override of these three silently disables or inverts a
  // safety mechanism — each reproduced against the real controllers: `stop.stallBlockAt: 0`
  // moved a run to terminal BLOCKED on the first SubagentStop firing; a zero-or-negative
  // `stop.softCapMargin` pushed the soft cap past the harness's real ceiling of 8, so the run
  // was truncated instead of suspending resumably (§S2, reached through the config file); and a
  // `codex.timeoutMs` above 2^31-1 is clamped by Node to **1 ms**, turning "effectively no
  // timeout" into an instant SIGKILL of every review. Rejected back to the default, and
  // reported: a clamp nobody can see is just a second silent restoration.
  const RANGES = [
    ['stop', 'stallBlockAt', (v) => Number.isInteger(v) && v >= 1,
      'must be an integer >= 1 — at 0 the first controller firing blocks a healthy run, terminally'],
    ['stop', 'softCapMargin', (v) => Number.isInteger(v) && v >= 1,
      'must be an integer >= 1 — zero or negative defeats the resumable yield below the harness cap'],
    ['codex', 'timeoutMs', (v) => v > 0 && v <= 2 ** 31 - 1,
      'must be in (0, 2^31-1] — Node clamps larger delays to 1 ms, an instant kill of every review'],
  ];
  for (const [group, key, ok, why] of RANGES) {
    const value = clone?.[group]?.[key];
    if (typeof value !== 'number' || ok(value)) continue;
    rejected.push(`${group}.${key} (${JSON.stringify(value)} ${why})`);
    delete clone[group][key];
  }
  return { clone, rejected };
}

/** The harness's own consecutive-block ceiling — measured (§D4, §Q17 T20), not configurable here. */
const HARNESS_BLOCK_CAP = 8;

/**
 * Load effective config. Project overrides live in `.hyperpowers.json` at the project root —
 * a normal, reviewable file rather than hidden state.
 */
export function loadConfig(projectRoot) {
  const raw = readJson(path.join(projectRoot, '.hyperpowers.json'), null);
  const { clone: overrides, rejected } = raw ? stripImmutable(raw) : { clone: null, rejected: [] };
  let config = overrides ? deepMerge(DEFAULTS, overrides) : DEFAULTS;
  if (rejected.length) config = { ...config, rejectedOverrides: rejected };

  const envCap = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP);
  if (Number.isFinite(envCap) && envCap > 0) {
    config = deepMerge(config, { stop: { blockCap: envCap } });
  } else if (config.stop.blockCap > HARNESS_BLOCK_CAP) {
    // The harness honours 8 consecutive blocks (§D4, reconfirmed §Q17 T20) whatever this number
    // says. A project override of 200 — the value this project itself once shipped, still visible
    // in old docs for anyone to copy — re-created §S2 exactly: the soft cap was never reached, no
    // SUSPENDED was recorded, and the harness truncated the turn with nothing to resume.
    // Reproduced against the real controllers. Only the environment variable may raise it,
    // because only a session launched with a higher cap actually has one.
    config = {
      ...config,
      stop: { ...config.stop, blockCap: HARNESS_BLOCK_CAP },
      rejectedOverrides: [
        ...(config.rejectedOverrides ?? []),
        `stop.blockCap (${config.stop.blockCap} exceeds the measured harness ceiling of ` +
          `${HARNESS_BLOCK_CAP}; raising it needs CLAUDE_CODE_STOP_HOOK_BLOCK_CAP in the session, §S2)`,
      ],
    };
  }
  return config;
}

/**
 * The environment contract a run must be launched under: **empty, and that is the design.**
 *
 * `plugin.json` cannot contribute `env` (ledger G4), so this could never be shipped as a plugin
 * setting; §Q16 T16 measured these reaching the harness from a launch command instead, and then that
 * route was retired too, because the director became a subagent whose pins hold on their own.
 *
 * Five variables used to live here, written into the project's `.claude/settings.json` by a
 * mandatory setup step. Each has been retired by a measurement rather than by preference:
 *
 * - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` — actively **harmful** now. §S3 T25: at depth 2 under
 *   a cap of 2 the `Agent` tool is removed from the tool set, so a director subagent's own
 *   coordinators could not dispatch. The harness default of 3 is exactly the tree this needs.
 * - `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=200` — unnecessary. §S3 T27 and two real runs: a long agent
 *   runs its whole workflow inside one dispatch and consumes no continuations. §S2 makes being
 *   wrong survivable by suspending resumably instead of truncating.
 * - `CLAUDE_CODE_DISABLE_WORKFLOWS=1` — redundant twice over. `Workflow` is already absent from
 *   every subagent (§R1), and the `PreToolUse` hook denies it on the main thread (§E1).
 * - `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` — already only recommended (§Q7), never read by any run
 *   mechanism.
 * - `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` — the honest remainder. §Q17 T23 measured that a
 *   subagent *does* carry the built-in commit guidance, so the contradiction with the read-only
 *   policy is real. It is left as a prompt-level contradiction against a hook-level prevention:
 *   `git-policy.mjs` blocks the mutation whatever the system prompt suggests, and the director's
 *   own instructions state the rule. Trading a certain install step for an uncertain prompt
 *   nudge is the right way round.
 *
 * Nothing is written into the user's repository, and no run refuses to start for want of a
 * setting. Keep it that way: an entry here is an install step, and an install step is a thing
 * that can be missing.
 */
export const REQUIRED_ENV = Object.freeze({});

export const RECOMMENDED_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: {
    value: '1',
    why: 'Hyperpowers supplies its own escalation path; a second advisor would arbitrate outside the ledger (spec §17). Optional: no run mechanism reads it.',
  },
});

/**
 * There is no launch command any more.
 *
 * `launchCommand()` built a five-variable `env … claude --agent hyperpowers:hyperpowers-director
 * --effort high "<request>"` line. It was correct and measured, and it was the wrong shape: it
 * moved the requirement from a settings file into a command the user had to paste, which is the
 * same friction wearing different clothes. `/hyperpowers:feature` dispatches the director as a
 * subagent instead, whose `model:` and `effort:` pins hold on their own (§S3 T26), and none of the
 * five variables survived the measurements that retired them — see `REQUIRED_ENV` above.
 */
