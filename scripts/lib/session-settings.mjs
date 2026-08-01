/**
 * The 1-hour subagent prompt cache: installed while a run is live, handed back after.
 *
 * A subagent's query source (`agent:custom:<type>`) is not on the harness's 1-hour cache allowlist
 * and the main thread's is, so agents lose their context every five minutes — 7–13% of a run. A
 * plugin cannot ship the variable that fixes it, so the run sets it itself (§V15, §V17).
 *
 * **The scope is a file, not a run.** `~/.claude/settings.json` is read by every Claude Code process
 * sharing that config directory, so while any run is live they all get the 1-hour tier. For an
 * unrelated session that is a bet, not a tax: a prefix never reused past minute five pays 2× against
 * 1.25×; reused once within the hour it pays 2.0 + 0.1 against 1.25 + 1.25 and wins.
 *
 * **Five rules, each measured, each of which a simplification breaks silently (§V17, §V20):**
 *
 *  1. `init` is early enough — a settings write reaches the live session, including a subagent
 *     already mid-conversation, and `process.env` is process-wide. Nothing per dispatch.
 *  2. Release writes `"0"` and must never delete: the harness re-applies with `Object.assign`,
 *     which never unsets, so deleting reverts nothing while reporting that it did.
 *  3. Its two writes cannot share one call — the reload coalesces — so the key is removed later,
 *     by `sweepSubagentCache` at the next session start.
 *  4. The scope is the **user** file. The project one is inert in a repository with no `.claude/`,
 *     and writing there would put the plugin inside a project (spec §20).
 *  5. Nothing here may throw. Two callers are CLI verbs, where an exception is not a degraded run
 *     but no run: an unwritable `~/.claude/` once killed the director's first tool call.
 *
 * The sweep is idempotent because Claude Code can clobber a release as it exits, and a crashed run
 * never releases. Both cost one extra session, not a stuck setting.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from './io.mjs';
import { dataRoot, projectDir } from './paths.mjs';
import { isTerminal } from './phases.mjs';

/** The variable, and the two values this module writes. */
export const CACHE_ENV_VAR = 'ENABLE_PROMPT_CACHING_1H';
const ON = '1';
const OFF = '0';

/**
 * Is the harness reading this value as enabled? Its own parser accepts `1/true/yes/on`.
 *
 * Ownership is decided with this, reclaiming with `=== ON`, and the asymmetry is the point: any
 * spelling the harness honours means **the user turned it on**, so we must not claim it — but we
 * only ever wrote the literal `"1"`, so anything else is somebody else's value and we leave it.
 * Comparing exactly in both directions took a user's `"true"` and released it to `"0"`.
 */
const isOn = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/**
 * The user settings file, and the test seam for it.
 *
 * The seam is derived rather than injected: a sandboxed data root means a sandboxed installation.
 * Patching the ~20 sites that build a test environment would have been §U's defect — a rule
 * implemented in some of the places it names. It exists because the suite wrote the developer's
 * own `~/.claude/settings.json` and stayed green (§V18).
 */
export function userSettingsPath() {
  if (process.env.HYPERPOWERS_SETTINGS_FILE) return path.resolve(process.env.HYPERPOWERS_SETTINGS_FILE);
  if (process.env.HYPERPOWERS_DATA_ROOT) {
    return path.join(path.resolve(process.env.HYPERPOWERS_DATA_ROOT), 'settings.json');
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}

/**
 * What we did and who still needs it.
 *
 * One marker for the whole installation rather than one per project, because the file being
 * changed is shared: two runs in two projects both want the setting, and the first to finish must
 * not take it from the second. `holders` is that refcount, and it stores enough to check each
 * holder's liveness later — a run that crashed cannot remove itself.
 */
function markerPath() {
  return path.join(dataRoot(), 'session-cache.json');
}

/**
 * One writer at a time over the marker and the settings file together.
 *
 * `holders` is a refcount, and a refcount whose read-modify-write can interleave is not one: two
 * runs starting together in one data root both read the same marker, and the second write drops the
 * first's holder — after which the first release takes the setting away from a live run.
 *
 * It does **not** coordinate two *installations*: they have different data roots and therefore
 * different markers while sharing one settings file. That case is bounded (a run silently keeps the
 * 5-minute tier, nothing is corrupted) and closing it needs a versioned schema and an
 * installation-aware identity — refused with its reasoning in §V24.
 *
 * Never fatal: a lock we cannot take degrades the run to the 5-minute tier, which is rule 5.
 */
function locked(what, fn) {
  const lock = `${markerPath()}.lock`;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    return withLock(lock, fn);
  } catch (err) {
    return { changed: false, reason: `${what}: could not take the settings lock (${err.code ?? err.message})` };
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a settings file, distinguishing "absent" from "present but unparseable".
 *
 * `null` settings is not `{}`: a file with a syntax error is one whose meaning we do not know, and
 * rewriting it would destroy whatever the user intended. Every caller declines and says so.
 */
function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Only `ENOENT` means absent. Every other read failure is a file whose contents we do not know
    // — and a file we cannot read is usually still one we can *replace*, because the rename needs
    // the directory, not the file. Treating them alike erased a mode-000 settings.json down to our
    // own key: `model`, `permissions`, everything (reproduced, §V25).
    if (err.code === 'ENOENT') return { exists: false, settings: {} };
    return { exists: true, settings: null };
  }
  try {
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { exists: true, settings: null };
    return { exists: true, settings };
  } catch {
    return { exists: true, settings: null };
  }
}

/**
 * Write atomically, and never throw — rule 5, and the marker goes through the same door because a
 * half-written undo record is one nobody can read. This threw once, and an unwritable `~/.claude/`
 * killed the run rather than the optimisation (§V20).
 */
function tryWrite(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // "Handed back identically" has to include how the file is protected and how it is managed.
    // A bare tmp+rename widened a `0600` settings.json to `0644` and turned a dotfile-manager
    // symlink into a regular file — both reproduced (§V25). So: resolve the link and write its
    // target, and carry the mode across. The tmp lives beside the target so the rename stays on
    // one filesystem.
    let target = file;
    try { target = fs.realpathSync(file); } catch { /* not there yet — write where we were asked */ }
    let mode = null;
    try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file: let the umask decide */ }
    const tmp = `${target}.hyperpowers-${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
    return null;
  } catch (err) {
    return `${file} could not be written (${err.code ?? err.message})`;
  }
}

function envOf(settings) {
  return settings?.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
}

/** Is the 1-hour tier wanted for this run? The opt-out lives with every other project override. */
export function cacheEnabled(config) {
  return config?.cache?.subagent1h !== false;
}

/** Is a holder's run still going? A holder whose run is gone or terminal no longer holds anything. */
function holderLive(holder) {
  if (!holder?.projectRoot || !holder?.runId) return false;
  const state = readJson(path.join(projectDir(holder.projectRoot), 'runs', holder.runId, 'state.json'));
  return Boolean(state?.phase) && !isTerminal(state.phase);
}

/**
 * Put the session on the 1-hour subagent cache, and remember exactly what we changed.
 *
 * Returns a reason in every case, because "nothing happened" has several causes and a run that
 * cannot say which one is a run reporting a number it did not earn.
 */
export function engageSubagentCache(projectRoot, opts = {}) {
  return locked('engage', () => engageLocked(projectRoot, opts));
}

function engageLocked(projectRoot, { config, runId } = {}) {
  if (!cacheEnabled(config)) return { changed: false, reason: 'disabled by .hyperpowers.json cache.subagent1h' };
  // `FORCE_PROMPT_CACHING_5M` is tested before the enable inside the harness, so ours would be
  // inert. Saying so beats writing a file that does nothing.
  if (process.env.FORCE_PROMPT_CACHING_5M) {
    return { changed: false, reason: 'FORCE_PROMPT_CACHING_5M is set in the session and outranks it' };
  }

  const file = userSettingsPath();
  const { exists, settings } = readSettings(file);
  if (settings === null) return { changed: false, reason: `${file} is not valid JSON — left untouched` };

  const env = envOf(settings);
  const prior = Object.prototype.hasOwnProperty.call(env, CACHE_ENV_VAR) ? env[CACHE_ENV_VAR] : undefined;
  const marker = readJson(markerPath());
  const holders = (marker?.holders ?? []).filter((h) => !(h.projectRoot === projectRoot && h.runId === runId));

  // Already on, and not because of us: the user asked for it themselves. Use it, claim nothing, and
  // therefore never take it away. Any spelling the harness honours counts (see `isOn`).
  if (isOn(prior) && !marker) return { changed: false, already: true, reason: 'already set outside this run' };

  const next = { ...marker, file, holders: [...holders, { projectRoot, runId: runId ?? null }], phase: 'engaged' };
  // Snapshot the world before Hyperpowers ever touched it — once, then carried. A second run
  // engaging over our own released `"0"` would otherwise record that as the user's value and
  // restore it forever.
  if (!marker) {
    next.prior = prior ?? null;
    next.priorPresent = prior !== undefined;
    next.createdFile = !exists;
  }

  // Undo recorded before the change it undoes. A crash between the two then leaves a claim with
  // nothing done, which the next sweep drops — the other order leaves `"1"` with no way home.
  const markerErr = tryWrite(markerPath(), { ...next, engagedAt: new Date().toISOString() });
  if (markerErr) return { changed: false, reason: `undo record not written (${markerErr}) — settings left untouched` };

  // `changed` means we hold a claim; `wrote` means the file moved. Callers need both.
  const wrote = env[CACHE_ENV_VAR] !== ON;
  if (wrote) {
    const err = tryWrite(file, { ...settings, env: { ...env, [CACHE_ENV_VAR]: ON } });
    if (err) return { changed: false, reason: `not engaged: ${err}` };
  }
  return { changed: true, wrote, reason: wrote ? 'engaged' : 'engaged (already at the wanted value)', holders: next.holders.length };
}

/** Phase one: revert the live session with `"0"` (rule 2), and only what no other run still needs. */
export function releaseSubagentCache(projectRoot, opts = {}) {
  return locked('release', () => releaseLocked(projectRoot, opts));
}

function releaseLocked(projectRoot, { runId } = {}) {
  const marker = readJson(markerPath());
  if (!marker) return { changed: false, reason: 'nothing to release' };

  const holders = (marker.holders ?? [])
    .filter((h) => !(h.projectRoot === projectRoot && (runId == null || h.runId === runId)))
    .filter(holderLive);
  if (holders.length) {
    tryWrite(markerPath(), { ...marker, holders });
    return { changed: false, reason: `still held by ${holders.length} live run(s)`, holders: holders.length };
  }

  const file = marker.file ?? userSettingsPath();
  const { settings } = readSettings(file);
  if (settings === null) return { changed: false, reason: `${file} is not valid JSON — left untouched` };
  const env = envOf(settings);
  // Someone else owns this value now. Leaving it alone and dropping our claim is the only safe move.
  if (env[CACHE_ENV_VAR] !== ON) {
    try { fs.rmSync(markerPath(), { force: true }); } catch { /* best effort */ }
    return { changed: false, reason: 'the value is no longer the one this run set — left untouched' };
  }

  const err = tryWrite(file, { ...settings, env: { ...env, [CACHE_ENV_VAR]: OFF } });
  // Not released, and the claim stays: the marker is what tells the next sweep there is still
  // something to undo. Dropping it here would strand `"1"` exactly when the write is failing.
  if (err) return { changed: false, reason: `not released: ${err}` };
  tryWrite(markerPath(), { ...marker, holders: [], phase: 'released', releasedAt: new Date().toISOString() });
  return { changed: true, reason: 'reverted for this session; the key is removed at the next session start' };
}

/**
 * Phase two: remove the key, leaving the file as it was found.
 *
 * At `SessionStart`, the one place removal is safe — the process has just read the file. It also
 * covers the release that never happened: a crashed run leaves `"1"` and no live holder, and the
 * next session reverts then cleans. A guarantee resting on one hook firing is not one (§V8).
 */
export function sweepSubagentCache(projectRoot, opts = {}) {
  return locked('sweep', () => sweepLocked(projectRoot, opts));
}

function sweepLocked(projectRoot, { runActive = false } = {}) {
  const marker = readJson(markerPath());
  if (!marker) return { changed: false, reason: 'nothing to sweep' };

  // Liveness is read from each holder's own state file, not from this project's session: a run in
  // another project is exactly the case the refcount exists for.
  const holders = (marker.holders ?? []).filter(holderLive);
  if (runActive || holders.length) {
    if (holders.length !== (marker.holders ?? []).length) tryWrite(markerPath(), { ...marker, holders });
    return { changed: false, reason: 'a run still owns the setting', holders: holders.length };
  }

  const file = marker.file ?? userSettingsPath();
  const { exists, settings } = readSettings(file);
  if (!exists || settings === null) {
    try { fs.rmSync(markerPath(), { force: true }); } catch { /* best effort */ }
    return { changed: false, reason: 'settings file gone or unreadable — claim dropped' };
  }
  const env = envOf(settings);
  if (!Object.prototype.hasOwnProperty.call(env, CACHE_ENV_VAR)) {
    try { fs.rmSync(markerPath(), { force: true }); } catch { /* best effort */ }
    return { changed: false, reason: 'already clean' };
  }
  // Still `"1"` with no live holder: a run died without releasing. Revert now; the *next* session
  // start removes the key, in a process that will have read `"0"`.
  if (env[CACHE_ENV_VAR] === ON) {
    const err = tryWrite(file, { ...settings, env: { ...env, [CACHE_ENV_VAR]: OFF } });
    if (err) return { changed: false, reason: `a run ended without releasing, and the revert failed: ${err}` };
    tryWrite(markerPath(), { ...marker, holders: [], phase: 'released' });
    return { changed: true, reason: 'a run ended without releasing — reverted' };
  }

  const next = { ...settings, env: { ...env } };
  if (marker.priorPresent) next.env[CACHE_ENV_VAR] = marker.prior;
  else delete next.env[CACHE_ENV_VAR];
  if (Object.keys(next.env).length === 0) delete next.env;

  if (marker.createdFile && Object.keys(next).length === 0) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  } else {
    const err = tryWrite(file, next);
    // The claim survives a failed restore, for the same reason it survives a failed release.
    if (err) return { changed: false, reason: `not restored: ${err}` };
  }
  try { fs.rmSync(markerPath(), { force: true }); } catch { /* best effort */ }
  return { changed: true, reason: 'settings restored' };
}

/** What the settings say right now, for preflight and the run report. */
export function subagentCacheState() {
  const file = userSettingsPath();
  const { settings } = readSettings(file);
  const value = settings ? envOf(settings)[CACHE_ENV_VAR] : undefined;
  return {
    file,
    value: value ?? null,
    on: isOn(value),
    marker: readJson(markerPath()),
    forced5m: Boolean(process.env.FORCE_PROMPT_CACHING_5M),
    // The live process is what actually decides the TTL; the file is only how it got there.
    live: ['1', 'true', 'yes', 'on'].includes(String(process.env[CACHE_ENV_VAR] ?? '').toLowerCase()),
  };
}
