#!/usr/bin/env node
/**
 * `subagentStatusLine` renderer — one line per live subagent, in the agent panel.
 *
 * This is the only rendering surface a plugin can ship: the settings allowlist a plugin may
 * contribute is exactly `["agent", "subagentStatusLine"]` (read from `BIN`). And it only became
 * useful when the director became a subagent — the panel filters to `local_agent` tasks and
 * excludes the main thread, so while the director *was* the main thread it had no row to decorate.
 *
 * Contract, measured (§S9, corrected and extended by §V14): the full payload arrives as JSON on
 * stdin; every 5 s while any subagent is live, never when none is; output is **one JSON object per
 * line**, `{"id","content"}`; unknown ids are dropped; a **non-zero exit discards every decoration
 * for that tick**, not just the offending line; 5 s timeout.
 *
 * `content` does **not** replace the whole row — §S9 said so and it was wrong. It replaces
 * everything right of the gutter; the pointer, tree connector and status glyph survive, and none of
 * them is plugin-influenceable. What it does displace is the harness's own `(+N)` descendant
 * suffix — the only native signal that an agent has work running underneath it. Decorating the
 * director therefore *deleted* the evidence that the run's coordinators and implementers exist,
 * which is what the roster below exists to put back, better.
 *
 * Three rules follow, and are why this file is careful rather than clever:
 *
 *  1. **Silence is the default, per row.** Sessions dispatch agents for all sorts of reasons.
 *     Emitting anything for a session with no Hyperpowers run — or for an agent that is not part of
 *     one — replaces somebody's default row with our opinion of it. Omit the id; never emit an
 *     empty `content`, which *removes* the row from the panel rather than leaving it alone.
 *  2. **Never throw, and never exit non-zero.** A renderer that crashes every 5 s ruins a four-hour
 *     run, and one that exits non-zero blanks every other plugin row with it.
 *  3. **Widths are measured on plain text, colour is applied last.** SGR bytes count in
 *     `String.length` and not on screen; measuring the painted string is the classic way to make a
 *     progress bar vanish. `fitRight()` never sees a colour.
 */

import path from 'node:path';
import { activeRunId, artifacts } from './lib/paths.mjs';
import { bareAgentName, isDirectorMeta } from './lib/config.mjs';
import { subagentMeta, analyseTranscript } from './lib/transcript.mjs';
import { descendantsOf, byDepth, foldKinds } from './lib/agent-tree.mjs';
import { runProgress } from './lib/progress.mjs';
import { readJson } from './lib/io.mjs';

/**
 * Block Elements, and that choice is load-bearing: they are unambiguous-width, so `.length` is
 * their column count in every locale. The roster's `↳` and `›` are East Asian *Ambiguous* and
 * render double-width under a CJK locale, where the arithmetic here under-counts them by one each.
 * The consequence is bounded — `wrap:"truncate"` ellipsises, it does not wrap or corrupt the
 * frame — and both are the first cells dropped under pressure. **Do not add an emoji**: those are
 * unambiguously wide, and one in an undroppable cell would break the fit at every width.
 */
const FILLED = '█';
const EMPTY = '░';

const PREFIX = 'HP·director ';
const SEP = '  ';
/** The bar we want, and the narrowest one still worth drawing. Below `BAR_MIN` it is noise. */
const BAR_MAX = 24;
const BAR_MIN = 8;

/**
 * Warn when the run has mutated nothing for this long. The longest a healthy agent went without
 * writing a message across every recorded run is 17.7 minutes, and state moves more often than
 * transcripts do — so half an hour of silence is not "a long phase", it is the signature of run
 * 9b: a director wedged inside a dispatch no hook will ever sample, on the one surface that keeps
 * ticking. The row cannot fix it; the human it warns can (`/hyperpowers:abort`, or TaskStop).
 */
const IDLE_WARN_MS = 30 * 60 * 1000;

/**
 * Colour marks **state**, never structure.
 *
 * `content` is fed to an ANSI-parsing component that maps escapes onto Ink props — named, 256 and
 * truecolour, bold, dim, underline, hyperlinks (§V14, resolving what §S9 left open). Two
 * consequences shape the palette. Ink, not this script, decides whether the terminal gets colour,
 * so no capability detection belongs here. And the wrapping `<Text dimColor>` means *uncoloured*
 * text renders dim on an ordinary row — which is what every undecorated row already looks like. So
 * the metadata deliberately stays uncoloured and consistent with the panel, and colour is spent
 * only on the two things that change what a human should do: how far along the run is, and whether
 * something is wrong.
 *
 * `NO_COLOR` is honoured and is not an inert knob: the harness builds the child environment from
 * `process.env` (measured, §V14), so the variable really does arrive here.
 */
const COLOUR = !process.env.NO_COLOR;
const CYAN = '36';
const GREEN = '32';
const RED = '31';
const YELLOW = '33';

function paint(code, text, bold = false) {
  if (!COLOUR || !code || !text) return text;
  return `\u001B[${bold ? '1;' : ''}${code}m${text}\u001B[${bold ? '22;' : ''}39m`;
}

/** A bar sized to what is left after the text, or nothing at all when the row is too narrow. */
function bar(percent, width, tone) {
  if (width < BAR_MIN) return '';
  const filled = Math.round((percent / 100) * width);
  return paint(tone, FILLED.repeat(filled)) + EMPTY.repeat(Math.max(0, width - filled));
}

function human(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/** `hyperpowers:opus-execution-coordinator` → `execution-coordinator`. The tier is on its own row. */
const TIER = /^(?:sonnet|opus|fable)-/;
function kindOf(meta, task) {
  return bareAgentName(meta?.agentType ?? task?.label ?? 'agent').replace(TIER, '');
}

/**
 * `execution-coordinator` → `execution`. A rule, not an abbreviation table.
 *
 * The first hyphen segment is the distinguishing one in every agent this plugin ships, checked
 * against `agents/`: the only collision is `implementer` with `implementer-xhigh`, which is a
 * retry of the same role and *should* fold together. A lookup table would drift the first time
 * somebody adds an agent; this cannot.
 */
function shortKind(meta) {
  return kindOf(meta).split('-')[0];
}

/**
 * `↳ execution › 2×implementer` — what is running beneath the director, by level.
 *
 * By level and not by parent, deliberately: with two live coordinators, attributing a grandchild to
 * one of them needs a path the walk does not carry, and a guessed parentage is a confident wrong
 * claim on the surface a human trusts to tell them the run is alive. Levels are what the metas
 * prove. The short form is the count alone, which is also — not by accident — the shape of the
 * `(+N)` suffix this decoration displaces.
 */
function rosterText(descendants) {
  if (!descendants.length) return { text: null, short: null };
  const levels = byDepth(descendants)
    .map(({ entries }) => foldKinds(entries.map((e) => shortKind(e.meta))).join(' '));
  return { text: `↳ ${levels.join(' › ')}`, short: `↳${descendants.length}` };
}

const cellText = (cell, short) => (short && cell.short) || cell.text;

/**
 * Choose what survives, so that the bar is the last thing to go.
 *
 * The defect this exists for shipped: the idle warning is ~57 characters, `directorRow` sized the
 * bar from whatever was left, and `bar()` draws nothing below `BAR_MIN` — so on a 120-column
 * terminal the bar disappeared **exactly when the run was in trouble**, which is the one moment it
 * is worth looking at. Letting `Math.min` decide silently is what made that possible.
 *
 * So the order is explicit and total. Cells carry a `drop` rank; the fitter first tries every cell
 * at full length, then every cell at its short form, then sheds the highest rank one at a time.
 * `drop: 0` is never shed, and the bar is reserved `BAR_MIN` columns before any of this — so no
 * cell is dropped while the bar can merely narrow, and the bar narrows from `BAR_MAX` to `BAR_MIN`
 * before anything is lost at all. Adding a cell means choosing its rank, which is the point.
 */
function fitRight(cells, budget) {
  const live = cells.filter((c) => c.text);
  const width = (list, short) => list.map((c) => cellText(c, short)).join(SEP).length;
  if (width(live, false) <= budget) return { cells: live, short: false };

  const rest = [...live];
  while (width(rest, true) > budget) {
    let worst = -1;
    for (let i = 0; i < rest.length; i += 1) if (worst < 0 || rest[i].drop > rest[worst].drop) worst = i;
    if (worst < 0 || rest[worst].drop === 0) break;
    rest.splice(worst, 1);
  }
  return { cells: rest, short: true };
}

/**
 * The director's row: the run's own progress, and the tree working underneath it.
 *
 * `↻n` is the retreat counter. The fill holds at its high-water mark, because a remediation adds
 * work rather than undoing it — see `lib/progress.mjs`. Showing the retreats separately keeps that
 * honest instead of hiding it.
 */
function directorRow(progress, task, columns, costUsd, descendants) {
  const started = Date.parse(task?.startTime ?? '');
  const idle = progress.staleMs !== null && progress.staleMs >= IDLE_WARN_MS && !progress.terminal;
  const tone = progress.phase === 'COMPLETE' ? GREEN
    : progress.terminal ? RED
      : idle ? YELLOW : CYAN;
  const roster = rosterText(descendants);

  const cells = [
    { drop: 0, text: `${String(progress.percent).padStart(3)}%`, tint: tone },
    // Ranked **above** the phase name, and that ordering was chosen against a measurement rather
    // than a taste: at 40 columns the other way round rendered `63%  EXECUTION` and dropped the
    // warning, which is the one cell on the row a human can act on. A phase name they cannot act on
    // is not worth the width during a wedge.
    {
      drop: 1,
      text: idle ? `⚠ idle ${human(progress.staleMs)} — run may be wedged; /hyperpowers:abort to stop` : null,
      short: idle ? `⚠ idle ${human(progress.staleMs)}` : null,
      tint: YELLOW,
      bold: true,
    },
    { drop: 2, text: progress.phase },
    { drop: 3, text: progress.retries ? `↻${progress.retries}` : null },
    { drop: 4, text: progress.tasks ? `${progress.tasks.accepted}/${progress.tasks.total} wp` : null },
    { drop: 5, text: Number.isFinite(started) ? human(Date.now() - started) : null },
    { drop: 6, text: typeof costUsd === 'number' ? `$${costUsd.toFixed(2)}` : null },
    { drop: 7, text: roster.text, short: roster.short },
  ];

  const usable = columns || 120;
  const fitted = fitRight(cells, Math.max(0, usable - PREFIX.length - 1 - BAR_MIN));
  const chosen = fitted.cells.map((c) => cellText(c, fitted.short));
  const plainWidth = chosen.join(SEP).length;
  const right = fitted.cells.map((c, i) => paint(c.tint, chosen[i], c.bold)).join(SEP);

  const drawn = bar(progress.percent, Math.min(BAR_MAX, usable - PREFIX.length - 1 - plainWidth), tone);
  return `${PREFIX}${drawn}${drawn ? ' ' : ''}${right}`;
}

/**
 * A worker's row: what it is doing, and how close it is to running out of room.
 *
 * `tokenCount / contextWindowSize` costs nothing to read — both are in the payload — and it warns
 * about the failure §Q13 measured: five of six agents ended *exactly* at their turn cap, and the
 * binding constraint was budget, not package size. Nobody asked for this number; it is the most
 * useful one on the row.
 *
 * Not width-fitted, on purpose. A worker's row carries a tree connector when the panel is drilled
 * into its parent, and `columns` is computed once without that term (§V14) — so any arithmetic here
 * would be wrong by an amount this process cannot know. The harness truncates with an ellipsis,
 * which is what an undecorated row does too.
 */
function workerRow(meta, task) {
  const used = task?.contextWindowSize > 0 ? Math.round((task.tokenCount / task.contextWindowSize) * 100) : null;
  const ctx = used === null ? null
    : paint(used >= 95 ? RED : used >= 80 ? YELLOW : null, `${used}% ctx${used >= 80 ? ' ⚠' : ''}`);
  return [`HP·${kindOf(meta, task)}`, meta?.description ?? task?.description, ctx].filter(Boolean).join(' · ');
}

function render(payload) {
  const projectRoot = payload.cwd || process.env.CLAUDE_PROJECT_DIR;
  const sessionId = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID;
  if (!projectRoot || !sessionId) return [];

  const runId = activeRunId(projectRoot, sessionId);
  if (!runId) return [];
  const progress = runProgress(projectRoot, runId);
  if (!progress) return [];

  // One meta read per **live** task, and liveness comes from the payload rather than from the
  // `subagents/` directory: the harness never prunes that directory, so walking it would report a
  // finished run's agents as busy. Parentage is the only thing read from disk, because
  // `spawnDepth` and `parentAgentId` are not among the fields serialised into the payload (§V14).
  const metas = new Map();
  for (const task of Object.values(payload.tasks ?? {})) {
    if (!task?.id) continue;
    metas.set(task.id, payload.transcript_path ? subagentMeta(payload.transcript_path, task.id) : null);
  }

  // Name is not enough — §S13's impostor director sat at depth 3 and reported as the director to
  // every consumer that compared names. Picking it here would put the run's bar on an agent holding
  // none of its context *and* walk a dispatch tree that is not the run's.
  const directorId = [...metas].find(([, meta]) => isDirectorMeta(meta))?.[0] ?? null;
  const descendants = directorId ? descendantsOf(metas, directorId) : [];
  const ours = new Set(descendants.map((d) => d.agentId));

  // Measured spend, on the row a human actually watches. `costNotice` reaches the *director's*
  // stdout and a telemetry event — the person paying saw the number only by polling
  // `/hyperpowers:status`, which was a claim ("the user watches the number and decides") the code
  // did not enforce. Memoised on (size, mtime) with a persisted cache, so the 5 s tick pays the
  // full transcript scan once per change, not once per tick; failure means no cost cell, never a
  // broken row.
  let costUsd = null;
  try {
    if (payload.transcript_path) {
      const a = artifacts(projectRoot, runId);
      const since = readJson(a.state, null)?.createdAt ?? null;
      const usage = analyseTranscript(payload.transcript_path, { since, cacheDir: path.join(a.base, '.cache') });
      if (usage?.available) costUsd = usage.totals.costUsd;
    }
  } catch { /* the row renders without the number */ }

  const lines = [];
  for (const task of Object.values(payload.tasks ?? {})) {
    if (!task?.id) continue;
    const meta = metas.get(task.id);
    // Rule 1, at the granularity it is actually needed. A live run does not make every agent in the
    // session ours: another plugin's, or an `Explore` the main thread launched alongside, was being
    // stamped `HP·…` and given a description we had no claim over. Omitting the id leaves the
    // harness's own rendering in place, which is the correct answer for somebody else's agent.
    const content = task.id === directorId
      ? directorRow(progress, task, payload.columns, costUsd, descendants)
      : ours.has(task.id) ? workerRow(meta, task) : null;
    if (content) lines.push(JSON.stringify({ id: task.id, content }));
  }
  return lines;
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const out = render(JSON.parse(raw));
    if (out.length) process.stdout.write(`${out.join('\n')}\n`);
  } catch {
    /* A row we cannot decorate keeps its default rendering, which is a fine outcome. */
  }
});
