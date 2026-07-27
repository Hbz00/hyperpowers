/**
 * Durable, crash-safe filesystem primitives.
 *
 * Every Hyperpowers artefact is written through here so that a run interrupted mid-write
 * (compaction, Ctrl-C, OOM) always leaves a readable file behind. Spec §23 Risk 7 requires
 * durable artefacts; a half-written `state.json` would defeat that.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Write a file atomically: write to a sibling temp file, fsync, then rename. */
export function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

export function writeJson(filePath, value) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Read JSON, returning `fallback` when the file is missing.
 * A corrupt file is a hard error: silently treating it as absent would let the state machine
 * restart a run that is actually mid-flight.
 */
export function readJson(filePath, fallback = undefined) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt JSON at ${filePath}: ${err.message}`);
  }
}

export function readText(filePath, fallback = undefined) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Append one JSON object per line. Append-only, so a torn write costs at most one record. */
export function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

export function readJsonl(filePath) {
  const raw = readText(filePath, '');
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line is expected after a crash; skip it rather than failing the read.
    }
  }
  return out;
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Best-effort exclusive lock via `mkdir` (atomic on POSIX and Windows).
 * Used to serialise state mutations when several agents report at once. Stale locks older
 * than `staleMs` are reclaimed so a killed process cannot wedge a run forever.
 *
 * Two bounds have to stay ordered, and both directions have bitten:
 *
 *  - `staleMs` must be *below* the retry budget (`retries × waitMs`), or reclaim is unreachable.
 *    At 30 s stale against a 5 s budget, a lock left by a killed process could never be
 *    reclaimed — every caller threw first. In the Stop controller that exception is caught by the
 *    fail-open handler, so a crash mid-mutation silently disengaged the autonomy loop for the
 *    whole staleness window, precisely when recovery mattered.
 *  - `staleMs` must also stay comfortably *above* the longest legitimate critical section. The
 *    mtime is stamped once at creation and never refreshed, so a live holder that runs longer
 *    than `staleMs` has its lock reclaimed by a competitor and both processes then read-modify-
 *    write concurrently — a lost update, silent, with no error anywhere. Fixing reachability by
 *    shrinking staleness trades a loud failure for a quiet one.
 *
 * So: 15 s budget over 10 s staleness. **The invariant that keeps the second bound true is a
 * constraint on callers, not on this function: nothing slow may run inside `mutateState`.** Every
 * call site today is a small JSON read-modify-write; transcript analysis and repository
 * fingerprinting deliberately happen outside the lock. Keep it that way.
 */
export function withLock(lockDir, fn, { staleMs = 10_000, retries = 300, waitMs = 50 } = {}) {
  let acquired = false;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        continue; // lock vanished between mkdir and stat; retry immediately
      }
      if (age > staleMs) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* another process reclaimed it first */
        }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  if (!acquired) throw new Error(`Could not acquire lock ${lockDir}`);
  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* nothing useful to do if cleanup fails */
    }
  }
}

export function nowIso() {
  return new Date().toISOString();
}
