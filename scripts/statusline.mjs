#!/usr/bin/env node
/**
 * `subagentStatusLine` renderer — one line per live subagent, in the agent panel.
 *
 * This is the only rendering surface a plugin can ship: the settings allowlist a plugin may
 * contribute is exactly `["agent", "subagentStatusLine"]` (read from `BIN`). And it only became
 * useful when the director became a subagent — the panel filters to `local_agent` tasks and
 * excludes the main thread, so while the director *was* the main thread it had no row to decorate.
 *
 * Contract, measured: the full payload arrives as JSON on stdin; every 5 s while any subagent is
 * live, never when none is; output is **one JSON object per line**, `{"id","content"}`; `content`
 * replaces the whole row, so omitting an id keeps that row's default rendering; unknown ids are
 * dropped; 5 s timeout.
 *
 * Two rules follow from that and are why this file is careful rather than clever:
 *
 *  1. **Silence is the default.** Sessions dispatch agents for all sorts of reasons. Emitting
 *     anything for a session with no Hyperpowers run would replace somebody's default row with our
 *     opinion of it. No run, no output, no exit code.
 *  2. **Never throw.** A renderer that crashes every 5 s is a renderer that ruins a four-hour run.
 *     Everything is wrapped; the failure mode is a plain row, which is what the user had anyway.
 */

import path from 'node:path';
import { activeRunId, artifacts } from './lib/paths.mjs';
import { DIRECTOR_AGENT, bareAgentName } from './lib/config.mjs';
import { subagentMeta, analyseTranscript } from './lib/transcript.mjs';
import { runProgress } from './lib/progress.mjs';
import { readJson } from './lib/io.mjs';

const FILLED = '█';
const EMPTY = '░';

/** A bar sized to what is left after the text, or nothing at all when the row is too narrow. */
function bar(percent, width) {
  if (width < 8) return '';
  const filled = Math.round((percent / 100) * width);
  return FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, width - filled));
}

function human(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/**
 * The director's row: the run's own progress.
 *
 * `↻n` is the retreat counter. The fill holds at its high-water mark, because a remediation adds
 * work rather than undoing it — see `lib/progress.mjs`. Showing the retreats separately keeps that
 * honest instead of hiding it.
 */
/**
 * Warn when the run has mutated nothing for this long. The longest a healthy agent went without
 * writing a message across every recorded run is 17.7 minutes, and state moves more often than
 * transcripts do — so half an hour of silence is not "a long phase", it is the signature of run
 * 9b: a director wedged inside a dispatch no hook will ever sample, on the one surface that keeps
 * ticking. The row cannot fix it; the human it warns can (`/hyperpowers:abort`, or TaskStop).
 */
const IDLE_WARN_MS = 30 * 60 * 1000;

function directorRow(progress, task, columns, costUsd) {
  const started = Date.parse(task?.startTime ?? '');
  const idle = progress.staleMs !== null && progress.staleMs >= IDLE_WARN_MS && !progress.terminal;
  const right = [
    `${String(progress.percent).padStart(3)}%`,
    progress.phase,
    progress.retries ? `↻${progress.retries}` : null,
    progress.tasks ? `${progress.tasks.accepted}/${progress.tasks.total} wp` : null,
    Number.isFinite(started) ? human(Date.now() - started) : null,
    typeof costUsd === 'number' ? `$${costUsd.toFixed(2)}` : null,
    idle ? `⚠ idle ${human(progress.staleMs)} — run may be wedged; /hyperpowers:abort to stop` : null,
  ].filter(Boolean).join('  ');

  const prefix = 'HP·director ';
  const room = Math.max(0, (columns || 120) - prefix.length - right.length - 2);
  const drawn = bar(progress.percent, Math.min(24, room));
  return `${prefix}${drawn}${drawn ? ' ' : ''}${right}`;
}

/**
 * A worker's row: what it is doing, and how close it is to running out of room.
 *
 * `tokenCount / contextWindowSize` costs nothing to read — both are in the payload — and it warns
 * about the failure §Q13 measured: five of six agents ended *exactly* at their turn cap, and the
 * binding constraint was budget, not package size. Nobody asked for this number; it is the most
 * useful one on the row.
 */
function workerRow(meta, task) {
  const kind = bareAgentName(meta?.agentType ?? task?.label ?? 'agent').replace(/^(sonnet|opus|fable)-/, '');
  const used = task?.contextWindowSize > 0 ? Math.round((task.tokenCount / task.contextWindowSize) * 100) : null;
  return [
    `HP·${kind}`,
    meta?.description ?? task?.description,
    used === null ? null : `${used}% ctx${used >= 80 ? ' ⚠' : ''}`,
  ].filter(Boolean).join(' · ');
}

function render(payload) {
  const projectRoot = payload.cwd || process.env.CLAUDE_PROJECT_DIR;
  const sessionId = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID;
  if (!projectRoot || !sessionId) return [];

  const runId = activeRunId(projectRoot, sessionId);
  if (!runId) return [];
  const progress = runProgress(projectRoot, runId);
  if (!progress) return [];

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
    const meta = payload.transcript_path ? subagentMeta(payload.transcript_path, task.id) : null;
    const isDirector = bareAgentName(meta?.agentType) === DIRECTOR_AGENT;
    const content = isDirector ? directorRow(progress, task, payload.columns, costUsd) : workerRow(meta, task);
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
