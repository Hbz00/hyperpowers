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

/** Anthropic cache multipliers: reads are cheap, writes carry a premium. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

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
  const input = usage.inputTokens + usage.cacheReadTokens * CACHE_READ_MULTIPLIER + usage.cacheWriteTokens * CACHE_WRITE_MULTIPLIER;
  return (input / 1e6) * p.input + (usage.outputTokens / 1e6) * p.output;
}

function emptyUsage() {
  return { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

/**
 * Aggregate a transcript by model family, separating main-thread work from subagent work.
 *
 * @param {string} transcriptPath
 * @param {{since?: string}} options `since` is an ISO timestamp; earlier messages are ignored,
 *        which is what makes per-run accounting possible inside a long-lived session.
 */
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
  const cacheKey = `v2:${fingerprint}:${since ?? ''}`;
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
 * The architecture's central premise is that product authority sits with the strongest tier. A
 * skill declares `model: fable` to secure that — and the pin does **not** always take. Measured on
 * this machine, same account, same plugin build, same `/hyperpowers:feature` invocation:
 *
 *   `claude -p "/pintest"`            skill pinning fable → **claude-fable-5**   the pin wins
 *   interactive session opened on Opus → **claude-opus-5**    the session model wins
 *
 * Two real runs on a 200k-line project directed themselves with Opus before anyone noticed, one of
 * them for $4.19. Nothing was broken — every gate, every dispatch, every hook behaved — the run was
 * simply not the system it claimed to be.
 *
 * `ok: null` means the question could not be asked yet: no transcript, or no assistant message in
 * it. That is not the same as agreement and callers must not treat it as one.
 */
export function directorTier(state) {
  const expected = state?.config?.models?.director ?? 'fable';
  const transcript = transcriptPathFor(state);
  if (!transcript) return { expected, observed: null, family: null, ok: null };
  const observed = currentMainThreadModel(transcript);
  if (!observed) return { expected, observed: null, family: null, ok: null };
  const family = familyOf(observed);
  return { expected, observed, family, ok: family === expected };
}

/**
 * The model that produced the most recent main-thread message.
 * Used to verify that the director tier is actually the model the run believes it is.
 */
export function currentMainThreadModel(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row.type === 'assistant' && !row.isSidechain && row.message?.model) return row.message.model;
  }
  return null;
}
