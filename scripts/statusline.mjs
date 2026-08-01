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

import fs from 'node:fs';
import path from 'node:path';
import { activeRunId, artifacts } from './lib/paths.mjs';
import { bareAgentName, isDirectorMeta, loadConfig, quietWarnMs } from './lib/config.mjs';
import { subagentMeta, analyseTranscript, lastWriteAt } from './lib/transcript.mjs';
import { descendantsOf, byDepth, foldKinds } from './lib/agent-tree.mjs';
import { runProgress } from './lib/progress.mjs';
import { pendingErrand } from './lib/state.mjs';

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
  if (!descendants.length) return null;
  const levels = byDepth(descendants)
    .map(({ entries }) => foldKinds(entries.map((e) => shortKind(e.meta))).join(' '));
  return { text: `↳ ${levels.join(' › ')}`, short: `↳${descendants.length}` };
}

/**
 * A Codex round in flight, from the two files the adapter already writes.
 *
 * `<round>.prompt.md` lands when the round starts and `<round>.md.<model>.last.json` when it
 * returns, so a prompt without its answer *is* a round in progress — no new producer, and the
 * prompt's mtime is when it began. Codex runs through Bash rather than as a subagent, so nothing
 * appears in the roster and the row was simply frozen for the duration: 22 minutes across one run's
 * four rounds, and the longest single silence any run has produced (§V22).
 *
 * Bounded by twice the Codex timeout so a prompt orphaned by a crash cannot claim a round is still
 * running hours later — the same reason the child registry expires.
 */
function codexRound(packsDir, timeoutMs, reviewsDir = null) {
  let files;
  try { files = fs.readdirSync(packsDir); } catch { return null; }
  const floor = Date.now() - Math.max(1, timeoutMs) * 2;
  let best = null;
  for (const file of files) {
    if (!file.endsWith('.prompt.md')) continue;
    const round = file.slice(0, -'.prompt.md'.length);
    if (files.some((f) => f.startsWith(`${round}.md.`) && f.endsWith('.last.json'))) continue;
    // A *failed* attempt writes no `.last.json` — the adapter judges success by that file's
    // existence — so the prompt alone would report the round as still running for twice the
    // timeout, on a run that has already gone to BLOCKED. The review record is written on both
    // paths, success and failure, so it is the completion signal that covers both.
    if (reviewsDir && fs.existsSync(path.join(reviewsDir, `${round}.json`))) continue;
    let at;
    try { at = fs.statSync(path.join(packsDir, file)).mtimeMs; } catch { continue; }
    if (at < floor) continue;
    if (!best || at > best.at) best = { round, at };
  }
  if (!best) return null;
  return { text: `⟳ codex ${best.round} ${human(Date.now() - best.at)}`, short: `⟳ ${best.round}`, tint: CYAN };
}

/**
 * One cell answers "what is happening right now", because the four candidates are one question.
 *
 * They are also near-exclusive in practice — Codex runs in Bash so it excludes the roster, and a
 * parked errand means nothing is running at all — so giving each its own cell would spend width on
 * combinations that do not occur, on a row that is already eight cells wide.
 *
 * The order is not a preference, it is what each state costs a human who reads it wrong:
 *
 *  1. **An errand outranks everything and can never be overridden.** Run `vv1ffc` sat **5h14** in
 *     `FINAL_ACCEPTANCE` with a parked Artifact publication and then completed. Every silence-based
 *     rule calls that a stalled run; it was a run waiting for its owner, fifteen seconds of human
 *     action from `COMPLETE`, and a warning saying "abort" would have destroyed it.
 *  2. **Silence overrides the three "something is running" states**, because in the stall §V8
 *     measured the delegates were still *registered* while being dead. What is running is a claim;
 *     what has written is a fact.
 *  3. Then the ordinary answers, most-blocking first: a failing gate stops the phase, a Codex round
 *     is the run's longest legitimate pause, and the roster is the healthy case.
 */
function activityCell({ errand, quietMs, quietLimit, failing, codex, roster }) {
  if (errand) {
    const what = errand.kind === 'question' ? `${errand.questions?.length ?? 1} question(s)` : 'publish';
    return { text: `⏸ waiting for you — ${what}`, short: '⏸ waiting', tint: YELLOW, bold: true };
  }
  if (quietMs !== null && quietMs >= quietLimit) {
    return {
      text: `⚠ nothing has written for ${human(quietMs)} — /hyperpowers:status, or abort`,
      short: `⚠ quiet ${human(quietMs)}`,
      tint: YELLOW,
      bold: true,
    };
  }
  if (failing) {
    return {
      text: `⛔ gate ${failing.name}${failing.ratio ? ` ${failing.ratio}` : ''}`,
      short: `⛔ ${failing.name}`,
      tint: RED,
    };
  }
  return codex ?? roster ?? null;
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
function directorRow(progress, activity, columns, costUsd) {
  const alarming = activity?.tint === YELLOW || activity?.tint === RED;
  const tone = progress.phase === 'COMPLETE' ? GREEN
    : progress.terminal ? RED
      : alarming ? YELLOW : CYAN;

  const cells = [
    { drop: 0, text: `${String(progress.percent).padStart(3)}%`, tint: tone },
    // Position and drop rank are independent, and both are deliberate.
    //
    // It sits **after the phase** and always in the same place: the cell has five states, and one
    // that moved between them would make the row jump as a run changed — a slot that moves is not a
    // slot. Reading "phase, then what is happening inside it" is also the order the facts relate in.
    //
    // It is ranked **above** the phase name it follows, and that came from a measurement rather than
    // a taste: at 40 columns the other order rendered `63%  EXECUTION` and dropped the warning, the
    // one cell on the row a human can act on. A phase name they cannot act on is not worth the width.
    { drop: 2, text: progress.phase },
    { drop: 1, ...(activity ?? {}) },
    { drop: 3, text: progress.retries ? `↻${progress.retries}` : null },
    { drop: 4, text: progress.tasks ? `${progress.tasks.accepted}/${progress.tasks.total} wp` : null },
    { drop: 5, text: progress.ageMs === null ? null : human(progress.ageMs) },
    { drop: 6, text: typeof costUsd === 'number' ? `$${costUsd.toFixed(2)}` : null },
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
  const a = artifacts(projectRoot, runId);
  let costUsd = null;
  try {
    if (payload.transcript_path) {
      const usage = analyseTranscript(payload.transcript_path,
        { since: progress.createdAt, cacheDir: path.join(a.base, '.cache') });
      if (usage?.available) costUsd = usage.totals.costUsd;
    }
  } catch { /* the row renders without the number */ }

  // What is happening right now — one answer, five candidates, resolved by `activityCell`.
  const safely = (fn) => { try { return fn(); } catch { return null; } };

  // The errand is read on its own, outside the block below, because it is the one state that must
  // never be lost: it is documented as un-overridable precisely because a run that is *waiting for
  // its owner* looks identical to a stalled one, and telling somebody to abort it destroys it
  // (§V22). A malformed `.hyperpowers.json` making `loadConfig` throw must not take it down with
  // the rest.
  const errand = safely(() => pendingErrand(projectRoot, runId));

  // Silence is measured as **the most recent write anywhere**, not as `state.updatedAt`. A director
  // inside a synchronous dispatch mutates nothing for as long as the dispatch runs, so the state
  // stamp alone reported 45 minutes of "wedged" while an adjudicator was writing that same second
  // (§V22). Every input is something somebody already writes for another reason.
  const activity = safely(() => {
    const config = loadConfig(projectRoot);
    // `null` from `lastWriteAt` means *we could not check*, never *nothing wrote*. Falling back to
    // `progress.staleMs` here would quietly restore the very definition §V22 removed, on the one
    // path where nobody would notice — so a run whose writes cannot be read is never called quiet.
    const written = lastWriteAt(payload.transcript_path, [directorId, ...ours]);
    const quietMs = written === null || progress.terminal
      ? null
      : Math.min(progress.staleMs ?? Infinity, Date.now() - written);
    return activityCell({
      errand,
      quietMs: Number.isFinite(quietMs) ? quietMs : null,
      quietLimit: quietWarnMs(config),
      failing: progress.failingGate,
      codex: codexRound(a.packsDir, config.codex.timeoutMs, a.reviewsDir),
      roster: rosterText(descendants),
    });
  }) ?? (errand ? activityCell({ errand }) : null);

  const lines = [];
  for (const task of Object.values(payload.tasks ?? {})) {
    if (!task?.id) continue;
    const meta = metas.get(task.id);
    // Rule 1, at the granularity it is actually needed. A live run does not make every agent in the
    // session ours: another plugin's, or an `Explore` the main thread launched alongside, was being
    // stamped `HP·…` and given a description we had no claim over. Omitting the id leaves the
    // harness's own rendering in place, which is the correct answer for somebody else's agent.
    const content = task.id === directorId
      ? directorRow(progress, activity, payload.columns, costUsd)
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
