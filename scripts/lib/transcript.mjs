/**
 * Empirical model accounting, read from the session transcript.
 *
 * Spec §6.2 and §24 ask Hyperpowers to measure how work distributes across the tiers. Asking
 * agents to self-report their token usage would produce numbers that are wrong in the
 * direction that flatters the design. The session transcript records, per assistant message:
 * the model actually used, the real usage counters, and `isSidechain` (true inside a
 * subagent). That is ground truth, and it is free.
 *
 * It is also how Hyperpowers detects the silent effort/model downgrades of ledger A3: if the
 * director tier was pinned to Fable and the transcript shows Opus, the pyramid inverted and
 * the run should say so rather than quietly costing less and reasoning worse.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIRECTOR_AGENT, bareAgentName } from './config.mjs';

/** Anthropic cache multipliers: reads are cheap, writes carry a premium. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;
/**
 * The 1-hour cache tier costs 2× input, not 1.25× — billed as a **differential** on top of the
 * base write premium, never as a replacement split. The transcripts carry both a
 * `cache_creation_input_tokens` total and a `cache_creation.{ephemeral_5m,ephemeral_1h}` split,
 * and 30 rows of run 9 have a total *larger* than the split's sum — so `5m×1.25 + 1h×2.0` would
 * silently lose the unattributed tokens, which is the under-counting direction this file forbids.
 * The base bills every write token at 1.25×; this adds the missing 0.75× on the 1h share only.
 */
const CACHE_WRITE_1H_PREMIUM = 0.75;

/**
 * USD per million tokens, from the harness model registry (ledger A4).
 *
 * `unknown` is priced at the *most expensive* tier, not zero. A model this table does not
 * recognise — a rename, a new tier, anything released after this was written — used to cost
 * nothing, which meant its tokens were invisible to the `maxCostUsd` circuit breaker and to
 * every distribution figure the run reports. A budget that silently stops counting is worse
 * than one that overestimates: overestimating trips a bound early and says so, while
 * undercounting lets a run spend without limit and report that it spent nothing.
 */
const FAMILY_PRICING = {
  fable: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  unknown: { input: 10, output: 50 },
};

export function familyOf(modelId) {
  if (typeof modelId !== 'string') return 'unknown';
  const id = modelId.toLowerCase();
  for (const family of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (id.includes(family)) return family;
  }
  return 'unknown';
}

export function costOf(family, usage) {
  const p = FAMILY_PRICING[family] ?? FAMILY_PRICING.unknown;
  const input = usage.inputTokens
    + usage.cacheReadTokens * CACHE_READ_MULTIPLIER
    + usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER
    + (usage.cacheWrite1hTokens ?? 0) * CACHE_WRITE_1H_PREMIUM;
  return (input / 1e6) * p.input + (usage.outputTokens / 1e6) * p.output;
}

function emptyUsage() {
  return { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, costUsd: 0 };
}

/**
 * Where the harness keeps a session's subagent transcripts.
 *
 * Measured, because assuming cost this: a subagent's messages are **not** appended to the
 * session transcript. They are written to `<project>/<session-id>/subagents/agent-*.jsonl`, one
 * file per dispatch, and it is *inside those files* that `isSidechain: true` appears. Reading
 * only the path the Stop hook hands us therefore saw every subagent as absent — in a live run,
 * 8 Opus messages and 23 Sonnet messages, 11,838 output tokens between them, counted as zero.
 *
 * Two things depended on that being right. The `maxCostUsd` breaker measures spend from here, so
 * it was undercounting by exactly the tiers that do most of the work — the failure §K6 named as
 * worse than overestimating, reintroduced one directory away. And the §6.2 distribution, the
 * whole empirical basis of the 1–3–9 argument, could only ever report the director.
 */
function subagentTranscripts(transcriptPath) {
  const dir = path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath).replace(/\.jsonl$/, ''),
    'subagents',
  );
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Aggregate a transcript by model family, separating main-thread work from subagent work.
 *
 * @param {string} transcriptPath
 * @param {{since?: string}} options `since` is an ISO timestamp; earlier messages are ignored,
 *        which is what makes per-run accounting possible inside a long-lived session.
 */
export function analyseTranscript(transcriptPath, { since = null, cacheDir = null } = {}) {
  // The Stop controller calls this on every continuation — up to ~200 times per run — against a
  // transcript that only grows. Re-parsing it each time is O(n²) over a run and was the largest
  // risk of the hook exceeding its timeout, which would silently end an autonomous run. The
  // result is therefore memoised on (size, mtime): the transcript is append-only, so those two
  // values change if and only if the analysis would.
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { available: false, byFamily: {}, totals: emptyUsage(), mainThreadModels: [], subagentModels: [] };
  }
  // Every file that contributes, so the memo cannot go stale when a subagent finishes without
  // the parent transcript growing — which is most of what happens during EXECUTION.
  const sources = [transcriptPath, ...subagentTranscripts(transcriptPath)];
  const fingerprint = sources.map((p) => {
    try {
      const s = fs.statSync(p);
      return `${path.basename(p)}:${s.size}:${Math.floor(s.mtimeMs)}`;
    } catch {
      return `${path.basename(p)}:gone`;
    }
  }).join('|');
  // The memo is keyed on the transcript's bytes *and* on how they are interpreted. Without the
  // second half, the row-summing results written before §P7 would be served forever to runs whose
  // transcripts had stopped growing — the fix would be invisible on exactly the finished runs whose
  // numbers this project quotes. Bump this whenever the aggregation changes.
  // v3: the 1h cache tier is billed at its real 2× rate. Left at v2, the memo would serve the
  // pre-fix figure forever for exactly the finished runs whose economics this project quotes —
  // §P7's defect, one field over.
  const cacheKey = `v3:${fingerprint}:${since ?? ''}`;
  const cachePath = cacheDir ? path.join(cacheDir, 'transcript-analysis.json') : null;
  if (cachePath) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.key === cacheKey) return cached.value;
    } catch {
      /* a missing or stale cache just means we recompute */
    }
  }

  const chunks = [];
  for (const source of sources) {
    try {
      // A subagent file is a subagent's work whether or not its rows carry the flag, so the
      // provenance is recorded here rather than trusted to the row.
      chunks.push({ text: fs.readFileSync(source, 'utf8'), isSubagentFile: source !== transcriptPath });
    } catch {
      if (source === transcriptPath) {
        return { available: false, byFamily: {}, totals: emptyUsage(), mainThreadModels: [], subagentModels: [] };
      }
    }
  }

  const byFamily = {};
  const totals = emptyUsage();
  const mainThreadModels = new Set();
  const subagentModels = new Set();
  const sinceMs = since ? Date.parse(since) : null;

  // One API response, one charge — the transcript writes one row per *content block*.
  //
  // A reply that thinks and then calls a tool is two rows; add visible text and it is three. Every
  // one of them carries the same `requestId` and repeats the same prompt counters
  // (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), while
  // `output_tokens` grows as the response streams, so the last row holds the total.
  //
  // Summing rows therefore bills the prompt once per block. Measured over three real runs it
  // overstated cost by **1.86–1.99×** and inflated the director's share most, because its replies
  // carry the most blocks: Fable read as 24.7% of output tokens where it is really 12.0%. Every
  // figure this project published — the cost model, the §6.2 distribution, the `maxCostUsd`
  // breaker — was wrong by roughly a factor of two, and consistently enough that nothing looked
  // odd. Group by request, take the prompt once, take the largest output.
  const requests = new Map();
  let rowIndex = 0;
  for (const { text, isSubagentFile } of chunks) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // torn final line after a crash
      }
      if (row.type !== 'assistant') continue;
      if (sinceMs && row.timestamp && Date.parse(row.timestamp) < sinceMs) continue;

      const model = row.message?.model;
      const u = row.message?.usage;
      if (!model || !u) continue;

      // `uuid`, then a row counter, so a row carrying neither still counts exactly once.
      rowIndex += 1;
      const key = `${isSubagentFile ? 'sub' : 'main'}:${row.requestId ?? row.uuid ?? `row-${rowIndex}`}`;
      const outputTokens = u.output_tokens ?? 0;
      const seen = requests.get(key);
      if (seen) {
        seen.usage.outputTokens = Math.max(seen.usage.outputTokens, outputTokens);
        continue;
      }
      requests.set(key, {
        model,
        family: familyOf(model),
        isSubagent: isSubagentFile || row.isSidechain === true,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          // Absent on older transcripts → 0 → the base 1.25× alone, which is yesterday's figure.
          cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        },
      });
    }
  }

  for (const { model, family, isSubagent, usage } of requests.values()) {
    const bucket = (byFamily[family] ??= { ...emptyUsage(), main: emptyUsage(), sidechain: emptyUsage(), models: new Set() });
    const cost = costOf(family, usage);
    for (const target of [bucket, isSubagent ? bucket.sidechain : bucket.main, totals]) {
      target.messages += 1;
      target.inputTokens += usage.inputTokens;
      target.outputTokens += usage.outputTokens;
      target.cacheReadTokens += usage.cacheReadTokens;
      target.cacheWriteTokens += usage.cacheWriteTokens;
      target.cacheWrite1hTokens += usage.cacheWrite1hTokens ?? 0;
      target.costUsd += cost;
    }
    bucket.models.add(model);
    (isSubagent ? subagentModels : mainThreadModels).add(model);
  }

  for (const bucket of Object.values(byFamily)) bucket.models = [...bucket.models];

  const result = {
    available: true,
    byFamily,
    totals,
    mainThreadModels: [...mainThreadModels],
    subagentModels: [...subagentModels],
    shares: shareTable(byFamily, totals),
  };

  if (cachePath) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ key: cacheKey, value: result }));
    } catch {
      // Caching is an optimisation; failing to write it must never fail the analysis.
    }
  }
  return result;
}

function shareTable(byFamily, totals) {
  const pct = (v, t) => (t > 0 ? Number(((v / t) * 100).toFixed(1)) : null);
  const out = {};
  for (const [family, bucket] of Object.entries(byFamily)) {
    out[family] = {
      outputTokens: pct(bucket.outputTokens, totals.outputTokens),
      costUsd: pct(bucket.costUsd, totals.costUsd),
      messages: pct(bucket.messages, totals.messages),
    };
  }
  return out;
}

/**
 * Where Claude Code keeps a session's transcript, derived from the run rather than handed in.
 *
 * Hooks receive `transcript_path` in their payload; CLI verbs do not, and that asymmetry made the
 * §O14 fix nearly useless in its first form: the transition-time budget check fell back to
 * `state.observedUsage`, which only the Stop controller writes — the very hook that runs once per
 * run. It would have compared the bound against a figure minutes or hours stale, which is the same
 * "checked once" failure wearing a different hat.
 *
 * The path is reconstructible: Claude Code slugs the project directory and names the file after
 * the session. Returning `null` when it is not there keeps the caller honest rather than silently
 * substituting zero.
 */
export function transcriptPathFor(state) {
  if (!state?.sessionId || !state?.projectRoot) return null;
  const slug = String(state.projectRoot).replace(/[/.]/g, '-');
  // `HYPERPOWERS_TRANSCRIPT_ROOT` mirrors `HYPERPOWERS_DATA_ROOT`: the one override trusted
  // unconditionally, so a test can place a transcript where the code will look for it without
  // writing into the user's real `~/.claude/projects`.
  const root = process.env.HYPERPOWERS_TRANSCRIPT_ROOT
    ? path.resolve(process.env.HYPERPOWERS_TRANSCRIPT_ROOT)
    : path.join(os.homedir(), '.claude', 'projects');
  const p = path.join(root, slug, `${state.sessionId}.jsonl`);
  try {
    fs.statSync(p);
    return p;
  } catch {
    return null;
  }
}

/**
 * The run's real usage, measured now, or `null` when the transcript cannot be found.
 *
 * `state.observedUsage` is a snapshot the Stop controller writes — and that hook ran **once** in
 * an 86-minute run. Everything that read it therefore described the run's first minutes:
 * `summarise` and the §6.2 distribution table in the final report, whose entire job is to reveal
 * a tier inversion, and the budget check that was supposed to stop one. One measurement, used by
 * all of them, is both the DRY answer and the correct one.
 */
export function measuredUsageFor(state, { cacheDir = null } = {}) {
  const transcript = transcriptPathFor(state);
  if (!transcript) return null;
  const usage = analyseTranscript(transcript, { since: state.createdAt, cacheDir });
  return usage.available ? usage : null;
}

/**
 * Measured spend, or `null` when it cannot be determined.
 *
 * `null` and `0` must not be conflated: a budget check that reads "no transcript" as "$0 spent"
 * never fires, which is exactly the class of defect this exists to close.
 */
export function measuredCostFor(state) {
  return measuredUsageFor(state)?.totals.costUsd ?? null;
}

/**
 * Which model is actually directing this run, against the tier it was configured for.
 *
 * The architecture's central premise is that product authority sits with the strongest tier, and
 * the pin securing it has moved twice. A skill's `model: fable` does not hold against an
 * interactively chosen session model — two real runs on a 200k-line project directed themselves
 * with Opus before anyone noticed, one of them for $4.19, with every gate, dispatch and hook
 * behaving. A *main-session* agent's pin holds but has to be launched (§Q16). A **subagent's**
 * `effort:` holds unconditionally (§S3 T26) and its `model:` holds against the session default —
 * outranked only by a per-invocation argument and `CLAUDE_CODE_SUBAGENT_MODEL` (§V2) — which is
 * why the director is one, and why this function reads what was *observed* rather than declared.
 *
 * So this reads the director's own subagent transcript, not the main thread's. Under the subagent
 * architecture the main thread is whatever model the user happens to be on, and checking it would
 * be checking nothing while reporting a verdict — this codebase's signature defect.
 *
 * `ok: null` means the question could not be asked yet: no transcript, or the director has not been
 * dispatched. That is not agreement and callers must not treat it as one.
 */
export function directorTier(state) {
  const expected = state?.config?.models?.director ?? 'fable';
  const expectedEffort = state?.config?.effort?.default ?? 'high';
  const base = {
    expected, expectedEffort, observed: null, family: null, ok: null,
    agent: null, spawnDepth: null, effort: null, effortOk: null,
  };

  const transcript = transcriptPathFor(state);
  if (!transcript) return base;
  const found = directorSubagent(transcript);
  if (!found?.model) return base;

  const family = familyOf(found.model);
  return {
    ...base,
    agent: found.agentType,
    spawnDepth: found.spawnDepth,
    observed: found.model,
    family,
    ok: family === expected,
    effort: found.effort,
    // A wrong effort is a degradation, not an inversion — callers report it and never fail on it.
    effortOk: found.effort ? found.effort === expectedEffort : null,
  };
}

export function subagentsDir(transcriptPath) {
  return path.join(String(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
}

/**
 * One dispatched agent's meta, by the id the harness uses everywhere.
 *
 * `tasks[].id` in the status-line payload **is** this id — measured, and it is what lets a renderer
 * name a row without any convention anyone has to maintain in a prompt.
 */
export function subagentMeta(transcriptPath, agentId) {
  return readJsonQuiet(path.join(subagentsDir(transcriptPath), `agent-${agentId}.meta.json`));
}

/**
 * A wait long enough to have crossed a subagent's prompt-cache expiry, and what a crossing costs.
 *
 * The expiry is ~5 minutes (§T2) and the mechanism is now read rather than inferred: Claude Code
 * asks for a 1-hour `cache_control` TTL only for query sources on an allowlist — `repl_main_thread*`,
 * `sdk`, `auto_mode`, `memdir_relevance` — and a dispatched subagent's query source is
 * `agent:custom:<type>`, which is on none of them (§V15). So the main thread holds context across
 * an hour and every subagent loses it after five minutes, in the same session, at the same instant.
 *
 * `COLD_WRITE_FLOOR` keeps a trivial re-write from counting as a re-establishment: the signature of
 * a real one is a gap past the expiry, a read of *exactly* zero, and a write of the whole prompt.
 */
const COLD_GAP_MS = 5 * 60 * 1000;
const COLD_WRITE_FLOOR = 10_000;

/**
 * Cost by **role**, with the cost-term split and the wait counters — derived from the transcripts.
 *
 * The tier bands answer "did the pyramid hold?", and measurement showed that question addresses
 * about a quarter of the bill: output tokens are 24–27% of cost, and the largest line of the last
 * production run was not a tier but a *role* — the review adjudicator summed across dispatches,
 * 36.7%, above the director. This table is what would have made that visible on the first run
 * instead of the ninth. Per role and per term (generation / cache write / cache read / fresh
 * input), because the remedy differs: "re-read" wants less carried context, "re-write after a
 * cache expiry" wants fewer windows or a cheaper tier, and they were being summed under one word.
 *
 * `longWaits` and `coldWindows` are here rather than in a reader of their own because they are the
 * same pass over the same files under the same §P7 grouping, and a second walk would be a second
 * place to fix. They are what makes the cache-TTL question falsifiable on a later run: run 10's
 * director paid 74.6% of its cost re-establishing context across 14 long waits, and no figure the
 * plugin produced would have shown that.
 *
 * Derived, never stamped: attributed by each subagent's meta `agentType` (the main thread is its
 * own row), requests deduplicated by requestId within each file.
 */
export function analyseRoles(transcriptPath, { since = null } = {}) {
  const cutoff = since ? Date.parse(since) : null;
  const roles = new Map();
  const add = (role, isSubagent) => {
    if (!roles.has(role)) {
      roles.set(role, {
        role, isSubagent, dispatches: 0, messages: 0, outputTokens: 0,
        generationUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, freshInputUsd: 0, costUsd: 0,
        longWaits: 0, coldWindows: 0, coldWriteTokens: 0,
        cacheWriteTokens: 0, cacheWrite1hTokens: 0,
      });
    }
    const r = roles.get(role);
    r.dispatches += 1;
    return r;
  };

  const tally = (file, role, isSubagent) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const bucket = add(role, isSubagent);
    // Same request rule as `analyseTranscript` (§P7): one entry per requestId, first row's usage,
    // except output tokens which take the max across the request's rows — the final row of a
    // streamed request carries the full count.
    const requests = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = row?.message;
      const u = msg?.usage;
      if (row?.type !== 'assistant' || !u) continue;
      const at = Date.parse(row.timestamp ?? '');
      if (cutoff && Number.isFinite(at) && at < cutoff) continue;
      const key = msg.requestId ?? row.requestId ?? `${file}:${requests.size}`;
      const prior = requests.get(key);
      if (prior) {
        prior.out = Math.max(prior.out, u.output_tokens ?? 0);
        continue;
      }
      requests.set(key, { model: msg.model, u, out: u.output_tokens ?? 0, at });
    }

    // Waits are gaps *inside one dispatch*, so they are counted here and summed into the role —
    // the boundary between two dispatches of the same role is not a wait, it is two conversations.
    const ordered = [...requests.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const [i, { model, u, out, at }] of ordered.entries()) {
      const p = FAMILY_PRICING[familyOf(model)] ?? FAMILY_PRICING.unknown;
      const write = u.cache_creation_input_tokens ?? 0;
      const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      bucket.messages += 1;
      bucket.outputTokens += out;
      bucket.cacheWriteTokens += write;
      bucket.cacheWrite1hTokens += write1h;
      bucket.generationUsd += (out / 1e6) * p.output;
      bucket.cacheReadUsd += ((u.cache_read_input_tokens ?? 0) * CACHE_READ_MULTIPLIER / 1e6) * p.input;
      bucket.cacheWriteUsd += ((write * CACHE_WRITE_MULTIPLIER + write1h * CACHE_WRITE_1H_PREMIUM) / 1e6) * p.input;
      bucket.freshInputUsd += ((u.input_tokens ?? 0) / 1e6) * p.input;

      const prevAt = i > 0 ? ordered[i - 1].at : null;
      if (!Number.isFinite(at) || !Number.isFinite(prevAt) || at - prevAt < COLD_GAP_MS) continue;
      bucket.longWaits += 1;
      // A wait that cost nothing is still a wait; only a zero read *with* a full re-write is a
      // re-establishment. Keeping the two counters apart is what lets a later run show the TTL
      // change worked: the waits stay, the cold windows go.
      if ((u.cache_read_input_tokens ?? 0) === 0 && write > COLD_WRITE_FLOOR) {
        bucket.coldWindows += 1;
        bucket.coldWriteTokens += write;
      }
    }
    bucket.costUsd = bucket.generationUsd + bucket.cacheWriteUsd + bucket.cacheReadUsd + bucket.freshInputUsd;
  };

  tally(transcriptPath, 'main-thread', false);
  for (const file of subagentTranscripts(transcriptPath)) {
    const id = path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const meta = readJsonQuiet(path.join(subagentsDir(transcriptPath), `agent-${id}.meta.json`));
    tally(file, bareAgentName(meta?.agentType) || 'unknown-agent', true);
  }
  return [...roles.values()].sort((x, y) => y.costUsd - x.costUsd);
}

/**
 * Which prompt-cache TTL the **subagents** actually ran on, and what the expiries cost.
 *
 * Read rather than declared, for the reason `directorTier` is: `ENABLE_PROMPT_CACHING_1H` is a
 * session-level setting this plugin cannot install (§S9 — the settings allowlist a plugin may
 * contribute to is exactly `["agent","subagentStatusLine"]`), so whether it was in force is a
 * question about the run, not about the configuration. The transcripts answer it directly: the
 * harness records `cache_creation.ephemeral_1h_input_tokens` beside the write total, so a run
 * where subagents wrote into the 1-hour bucket says so in its own numbers.
 *
 * Reports, never gates. A run on the 5-minute default is more expensive and completely correct.
 */
export function cachePosture(roles) {
  const subagents = roles.filter((r) => r.isSubagent);
  const write = subagents.reduce((s, r) => s + r.cacheWriteTokens, 0);
  const write1h = subagents.reduce((s, r) => s + r.cacheWrite1hTokens, 0);
  const share = write > 0 ? write1h / write : null;
  return {
    ttl: share === null ? 'unknown' : share >= 0.99 ? '1h' : share <= 0.01 ? '5m' : 'mixed',
    share,
    writeTokens: write,
    write1hTokens: write1h,
    longWaits: subagents.reduce((s, r) => s + r.longWaits, 0),
    coldWindows: subagents.reduce((s, r) => s + r.coldWindows, 0),
    coldWriteTokens: subagents.reduce((s, r) => s + r.coldWriteTokens, 0),
  };
}

function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * When any of these agents last wrote to its transcript, in epoch ms — or `null` if none has.
 *
 * The one fact that distinguishes a director *waiting* from a run that has stopped. `state.updatedAt`
 * cannot do it: a director inside a synchronous dispatch mutates nothing for as long as the dispatch
 * takes, so a status line keyed on it warned that a healthy run "may be wedged" and told its owner to
 * abort (§V22). A delegate that is genuinely working writes messages, and the harness stamps the file
 * as it does.
 *
 * `mtime`, not the last message's timestamp: this runs on a 5 s tick and parsing every transcript
 * would cost far more than a `stat`. The two agree to within one write.
 *
 * Unreadable files are skipped rather than counted as silence — the fail-open direction here is
 * "assume something is alive", because the cost of a wrong warning is somebody aborting a live run.
 */
export function lastWriteAt(transcriptPath, agentIds) {
  if (!transcriptPath || !Array.isArray(agentIds) || !agentIds.length) return null;
  const dir = subagentsDir(transcriptPath);
  let newest = null;
  for (const id of agentIds) {
    if (!id) continue;
    try {
      const { mtimeMs } = fs.statSync(path.join(dir, `agent-${id}.jsonl`));
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch { /* an agent whose transcript we cannot read proves nothing either way */ }
  }
  return newest;
}

/**
 * The ids of every subagent dispatched **by** `parentAgentId`, from the meta files on disk.
 *
 * Parentage has to be resolved here rather than recorded when a child starts: `SubagentStart`
 * carries `agent_id` and `agent_type` but **no `parentAgentId`** — measured directly, §T1. The meta
 * file beside the transcript does carry it, and is readable live (§S4 T28), so the registry stores
 * only "which agents are running" and attribution is a read-time lookup. That ordering also makes
 * the hook independent of whether the meta has landed by the time the start event fires.
 *
 * Returns `[]` on any unreadable directory. Callers use this to decide whether an agent is
 * *waiting*, and the fail-open direction for that decision is "assume it is not" — see
 * `liveChildren` in `state.mjs`.
 */
export function childAgents(transcriptPath, parentAgentId) {
  if (!transcriptPath || !parentAgentId) return [];
  const dir = subagentsDir(transcriptPath);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const meta = readJsonQuiet(path.join(dir, file));
    if (meta?.parentAgentId !== parentAgentId) continue;
    out.push({ agentId: file.replace(/^agent-/, '').replace(/\.meta\.json$/, ''), meta });
  }
  return out;
}

/**
 * The director's own subagent transcript, located from the main one.
 *
 * The harness writes each dispatched agent to `<main transcript minus .jsonl>/subagents/`, as a
 * pair: `agent-<id>.meta.json` carrying `{agentType, description, toolUseId, spawnDepth}` and
 * `agent-<id>.jsonl` carrying its messages. Measured (§S3 T28) — and measured **while the agent is
 * still running**, which is what makes this checkable at the first transition rather than only
 * after the fact.
 *
 * Identity deliberately comes from `agentType` here and not from `CLAUDE_CODE_AGENT`: that variable
 * is set only for a `--agent` *main session* and is absent inside every dispatched subagent (§Q16
 * T29). Reading it here would have silently answered "no director".
 */
export function directorSubagent(transcriptPath, agentName = DIRECTOR_AGENT) {
  const dir = subagentsDir(transcriptPath);
  let metas;
  try {
    metas = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return null;
  }

  const candidates = [];
  for (const file of metas) {
    const full = path.join(dir, file);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (bareAgentName(meta?.agentType) !== bareAgentName(agentName)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch { /* ordering only */ }
    candidates.push({
      meta,
      mtime,
      jsonl: full.replace(/\.meta\.json$/, '.jsonl'),
      agentId: file.replace(/^agent-/, '').replace(/\.meta\.json$/, ''),
    });
  }
  if (!candidates.length) return null;

  // Depth first, then recency.
  //
  // Recency alone was wrong for the same reason it is wrong in `dataRoot()`: it is not an identity
  // claim. Run 6 grew a second `hyperpowers-director` at **depth 3** — dispatched by an adjudicator
  // that read "reply to the director" as "dispatch the director" — and for four minutes its meta was
  // the most recently written one. `subagent-controller` ignores anything not at depth 1 (§S13), so
  // this reader disagreed with the other half of the same rule, and the completion gate would have
  // reported the impostor's depth, model and effort as the run's.
  //
  // Preference, not filter, in three ranks: depth 1 is positive identity; no recorded depth is no
  // evidence either way (metas predate the field); a *wrong* recorded depth is evidence against, and
  // comes last — but is still answered rather than refused, because `directorTier` reports the depth
  // and the completion gate prints it. Returning null there would hide the impostor instead of naming
  // it, and would degrade condition 13.12b to `unverifiable` on a session where nothing is wrong.
  const rank = (c) => (c.meta?.spawnDepth === 1 ? 0 : c.meta?.spawnDepth == null ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
  const { meta, jsonl, agentId } = candidates[0];

  let raw;
  try {
    raw = fs.readFileSync(jsonl, 'utf8');
  } catch {
    return null;
  }
  let model = null;
  let effort = null;
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.type !== 'assistant') continue;
    model ??= row.message?.model ?? null;
    effort ??= row.effort ?? row.message?.effort ?? null;
    if (model) break;
  }
  // `agentId` is the id the harness uses everywhere, carried in the filename — the caller that needs
  // to *name* the live director has it here and nowhere else, because no hook observes its start.
  return { agentId, agentType: bareAgentName(meta.agentType), spawnDepth: meta.spawnDepth ?? null, model, effort };
}
