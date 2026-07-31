/**
 * Canonical location of every Hyperpowers artefact.
 *
 * Spec §20: orchestration data must never enter the working tree, because Codex reviews the
 * real project diff and must not see Hyperpowers' own logs. Everything therefore lives under
 * `$CLAUDE_PLUGIN_DATA`, which the harness guarantees is stable across plugin upgrades.
 *
 * Verified (ledger G2): `CLAUDE_PLUGIN_DATA` is a real environment variable inside hook
 * subprocesses. Its leaf directory is `<plugin-name>-<source>` where source is the marketplace
 * name, or `inline` when loaded via `--plugin-dir`.
 *
 * That was read for years as "so it must be taken from the environment and never reconstructed",
 * and the second half is what §O1 disproved: a `Bash` tool subprocess sees whatever value happens
 * to be exported, which in a live session was another plugin's directory. The variable is
 * authoritative about *where plugin data lives*; it is not authoritative about *whose* it is. See
 * `dataRoot` below.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, ensureDir, readJson, writeJson } from './io.mjs';

const PLUGIN_NAME = 'hyperpowers';

/** A directory is this plugin's root when it carries this plugin's manifest. */
function isOurPluginRoot(dir) {
  try {
    return readJson(path.join(dir, '.claude-plugin', 'plugin.json'), null)?.name === PLUGIN_NAME;
  } catch {
    return false;
  }
}

/**
 * Where this plugin lives on disk.
 *
 * Self-location first, environment second — the reverse of what shipped, and for the same reason
 * `dataRoot` no longer trusts `CLAUDE_PLUGIN_DATA`: a variable naming *a* plugin is not a
 * variable naming *this* plugin. `import.meta.url` is this file's real path, so `../..` is our
 * root by construction, in a hook subprocess and a Bash subprocess alike. It cannot name someone
 * else's plugin, which is the only failure mode the environment variable has.
 *
 * This resolves the schema and prompt paths that `codex-adversary.mjs` and `verify-completion.mjs`
 * load, so getting it wrong would have meant reviews running against another plugin's files, or
 * not running at all.
 */
export const PLUGIN_ROOT = (() => {
  // `fileURLToPath`, never `.pathname`: a file URL percent-encodes, so an install path containing
  // a space self-located to `.../hyperpowers%20stage/...`, the manifest check failed, and the
  // whole point of self-location — surviving a wrong or foreign environment — failed exactly when
  // the path was unusual. `fileURLToPath` also carries Windows drive-letter semantics.
  const selfLocated = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  if (isOurPluginRoot(selfLocated)) return selfLocated;
  // Only if this file is somewhere unexpected does the environment get a say — and even then
  // only when it points at a directory carrying our manifest.
  const declared = process.env.CLAUDE_PLUGIN_ROOT ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT) : null;
  if (declared && isOurPluginRoot(declared)) return declared;
  return declared ?? selfLocated;
})();

/** Does this directory belong to *this* plugin? Its leaf is `<plugin-name>-<source>` (G2). */
function ownsDataDir(dir) {
  const base = path.basename(dir);
  return base === PLUGIN_NAME || base.startsWith(`${PLUGIN_NAME}-`);
}

/** This plugin installation's stable identity, used to tell our data directory from another's. */
function pluginIdentity() {
  try { return fs.realpathSync(PLUGIN_ROOT); } catch { return PLUGIN_ROOT; }
}

/** The `pluginRoot` a directory's SessionStart marker claims, or `null` when it makes no claim. */
function markedPluginRoot(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.data-root.json'), 'utf8'));
    return typeof marker?.pluginRoot === 'string' ? marker.pluginRoot : null;
  } catch {
    return null;
  }
}

/**
 * Every `hyperpowers-*` data directory beside some other plugin's, most recently touched first.
 *
 * Recency is a tiebreak, never an identity. A machine carrying both a marketplace install and a
 * `--plugin-dir` development copy has `hyperpowers-hyperpowers` *and* `hyperpowers-inline`, and
 * choosing by mtime picked whichever was touched last — reproduced here, where an empty directory
 * created minutes earlier by a `plugin install` outranked the one holding every run, and
 * `describeDataRoot()` reported it as trusted. §O1's failure through a second door: the CLI writes
 * into one directory while the hooks read the other, and the run still looks healthy.
 *
 * `-fallback` is excluded: it is what we resolve to when nothing else is found, so letting it win
 * here would make the degraded path sticky.
 */
function siblingCandidates(parent) {
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ownsDataDir(e.name) && e.name !== `${PLUGIN_NAME}-fallback`)
      .map((e) => {
        const full = path.join(parent, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* unreadable sorts last */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
  return entries.map((e) => e.full);
}

/**
 * Our data directory beside `parent`, and whether the answer was actually knowable.
 *
 * `matched` is true only when a directory's marker names this plugin installation. With one
 * candidate the answer is unambiguous without a marker. With several and no match, a directory is
 * still returned so nothing crashes — but `ambiguous` says the choice was a guess, and preflight
 * refuses to start a run on a guess.
 */
function resolveSibling(parent) {
  const candidates = siblingCandidates(parent);
  if (candidates.length === 0) return { dir: null, ambiguous: false, matched: false, candidates };
  const me = pluginIdentity();
  const mine = candidates.find((dir) => markedPluginRoot(dir) === me);
  if (mine) return { dir: mine, ambiguous: false, matched: true, candidates };
  if (candidates.length === 1) return { dir: candidates[0], ambiguous: false, matched: false, candidates };
  return { dir: candidates[0], ambiguous: true, matched: false, candidates };
}

function siblingDataDir(parent) {
  return resolveSibling(parent).dir;
}

/**
 * Resolve the data root — and do not believe `CLAUDE_PLUGIN_DATA` without checking whose it is.
 *
 * The harness sets that variable correctly inside *this plugin's hook* subprocesses (ledger G2).
 * It does **not** follow that a `Bash` tool subprocess sees the same value: measured in a live
 * session, a Bash call from a Hyperpowers skill saw
 * `…/plugins/data/codex-openai-codex` — another plugin's directory entirely — while the hooks in
 * that same session resolved `…/plugins/data/hyperpowers-inline`.
 *
 * Trusting it therefore split the run in two. `state-machine.mjs`, `preflight.mjs` and every
 * other CLI script write through the Bash path; `git-policy.mjs`, `git-guard.mjs` and
 * `stop-controller.mjs` read through the hook path. The session pointer written by one was
 * invisible to the others, so `activeRunId()` returned `null` in every hook and the entire
 * governance layer went quiet: no Git denial, no drift detection, no Stop-driven continuation,
 * no stall or budget breaker. The evidence is the run's own record: after a full design phase of
 * Bash calls, no `git-fingerprint.json` existed and the telemetry held only events the CLI scripts
 * emit — not one from any hook.
 *
 * Nothing failed. That is what made it dangerous: the run proceeded, wrote its artefacts and
 * looked healthy, while the guarantee the plugin exists to provide was not in force.
 *
 * So the value is accepted only when it names this plugin. A foreign value is still *useful* —
 * it tells us where plugin data lives — so we take its parent and find our own directory beside
 * it, which is what makes both contexts converge on the same root.
 */
export function dataRoot() {
  if (process.env.HYPERPOWERS_DATA_ROOT) return path.resolve(process.env.HYPERPOWERS_DATA_ROOT);

  const declared = process.env.CLAUDE_PLUGIN_DATA ? path.resolve(process.env.CLAUDE_PLUGIN_DATA) : null;
  if (declared && ownsDataDir(declared)) return declared;
  if (declared) {
    const beside = siblingDataDir(path.dirname(declared));
    if (beside) return beside;
  }

  const home = path.join(os.homedir(), '.claude', 'plugins', 'data');
  return siblingDataDir(home) ?? path.join(home, `${PLUGIN_NAME}-fallback`);
}

/**
 * More than one installation's data directory is present and none of them claims to be ours.
 *
 * Returned separately from `dataRoot()` because that function has no way to fail: it is called
 * from hooks that must not crash. Preflight is where a guess becomes a refusal.
 */
export function dataRootIsAmbiguous() {
  if (process.env.HYPERPOWERS_DATA_ROOT) return null;
  const declared = process.env.CLAUDE_PLUGIN_DATA ? path.resolve(process.env.CLAUDE_PLUGIN_DATA) : null;
  if (declared && ownsDataDir(declared)) return null;
  const parent = declared ? path.dirname(declared) : path.join(os.homedir(), '.claude', 'plugins', 'data');
  const sibling = resolveSibling(parent);
  return sibling.ambiguous ? sibling.candidates : null;
}

/** How the root above was arrived at, so `preflight` and `status` can show it rather than assume it. */
export function describeDataRoot() {
  const resolved = dataRoot();
  if (process.env.HYPERPOWERS_DATA_ROOT) return { resolved, source: 'HYPERPOWERS_DATA_ROOT', trusted: true };
  const declared = process.env.CLAUDE_PLUGIN_DATA ? path.resolve(process.env.CLAUDE_PLUGIN_DATA) : null;
  if (declared && ownsDataDir(declared)) return { resolved, source: 'CLAUDE_PLUGIN_DATA', trusted: true };
  if (declared) {
    const sibling = resolveSibling(path.dirname(declared));
    if (sibling.ambiguous) {
      return {
        resolved,
        source: 'resolved beside a foreign CLAUDE_PLUGIN_DATA',
        trusted: false,
        ambiguous: true,
        candidates: sibling.candidates,
        foreign: declared,
      };
    }
    return {
      resolved,
      source: 'resolved beside a foreign CLAUDE_PLUGIN_DATA',
      trusted: ownsDataDir(resolved),
      foreign: declared,
    };
  }
  return { resolved, source: 'homedir search', trusted: ownsDataDir(resolved) && !resolved.endsWith('-fallback') };
}

export function isDataRootFromHarness() {
  // Resolved once: `dataRoot()` may scan a directory to find our sibling, and calling it twice
  // does that twice for one question.
  const root = dataRoot();
  return ownsDataDir(root) && !root.endsWith(`${PLUGIN_NAME}-fallback`);
}

/**
 * Stamped by the SessionStart hook, which is the one context whose `CLAUDE_PLUGIN_DATA` the
 * harness sets itself. A CLI script that resolves a root carrying this marker is provably
 * looking at the same directory the hooks use; one that does not is the split described above,
 * and preflight says so instead of letting the run proceed ungoverned.
 */
export function markDataRootAuthoritative() {
  try {
    // Never stamp a guess. `dataRoot()` always answers, because hooks cannot crash — but on a
    // machine carrying two installations the answer may be the newest directory rather than ours,
    // and stamping it would turn a coin flip into a permanent identity claim. Observed while
    // testing this very fix: a bare CLI invocation stamped the empty marketplace directory, after
    // which the ambiguity check reported everything in order. In the real path SessionStart runs
    // as a hook, where `CLAUDE_PLUGIN_DATA` names this plugin's own directory, so the stamp is
    // certain by construction; anywhere else, staying silent leaves preflight free to refuse.
    if (!describeDataRoot().trusted) return;
    const root = dataRoot();
    ensureDir(root);
    // `resolved` alone is self-referential: it only says a directory resolved to itself, which is
    // true of every directory that ever stamped one. `pluginRoot` is what makes the marker an
    // identity claim, so two installations on one machine can be told apart.
    writeJson(path.join(root, '.data-root.json'), {
      resolved: root,
      pluginRoot: pluginIdentity(),
      pluginVersion: readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {})?.version ?? null,
      stampedAt: new Date().toISOString(),
    });
  } catch {
    /* best effort: a marker we could not write must never stop a session from starting */
  }
}

export function dataRootAgreesWithHooks() {
  const { resolved } = describeDataRoot();
  try {
    const marker = readJson(path.join(resolved, '.data-root.json'), null);
    if (marker?.resolved !== resolved) return false;
    // A marker without `pluginRoot` predates identity stamping. It cannot distinguish this
    // installation from another one on the same machine, so it does not count as agreement —
    // the next SessionStart re-stamps it and the run proceeds.
    return marker.pluginRoot === pluginIdentity();
  } catch {
    return false;
  }
}

/**
 * Stable identifier for a project. The realpath is hashed so that symlinked checkouts of the
 * same tree share a run history, and a short slug is prefixed purely for human readability
 * when browsing the data directory.
 */
export function projectId(projectRoot) {
  let resolved = path.resolve(projectRoot);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* path may not exist yet in tests */
  }
  const slug = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'project';
  return `${slug}-${sha256(resolved).slice(0, 12)}`;
}

export function projectDir(projectRoot) {
  return path.join(dataRoot(), 'projects', projectId(projectRoot));
}

export function runsDir(projectRoot) {
  return path.join(projectDir(projectRoot), 'runs');
}

/**
 * The last line of defence for an id that reaches a path.
 *
 * The CLI already refuses malformed ids loudly (`requireSafeId`); this quarantines whatever
 * slips past a future call site. It must **never throw**: `activeRunId()` is on `git-policy`'s
 * fail-closed path, and one unreadable pointer file once made that hook deny every Bash, Write
 * and Edit call in the project (see `activeRunId`) — a thrown id would do the same. A
 * quarantined name resolves inside the intended directory and matches no real run, so a bad id
 * degrades to "no run found" instead of to relocated records or a denied session.
 */
function safePathId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(value ?? '')) ? String(value) : '_invalid';
}

export function runDir(projectRoot, runId) {
  return path.join(runsDir(projectRoot), safePathId(runId));
}

export function sessionPointerPath(projectRoot, sessionId) {
  return path.join(projectDir(projectRoot), 'sessions', `${safePathId(sessionId)}.json`);
}

/**
 * Bind a session to a run. Hooks receive `session_id` and `cwd` only (ledger D2/D5), so this
 * pointer is the sole mechanism by which the Stop controller discovers which run it is
 * driving. Without it a hook cannot act, which is why the feature skill writes it first.
 */
export function bindSession(projectRoot, sessionId, runId) {
  const p = sessionPointerPath(projectRoot, sessionId);
  ensureDir(path.dirname(p));
  // Binding is exclusive, and enforced here rather than remembered at each call site. A run
  // driven by two sessions means two Stop controllers advancing one state machine and two Git
  // guards sharing one fingerprint — so any other pointer naming this run is stale by
  // definition. `resume` used to leave the previous one in place; putting the sweep in the one
  // function that establishes ownership means the next caller cannot reintroduce that.
  const displaced = sessionsBoundTo(projectRoot, runId).filter((id) => id !== sessionId);
  for (const stale of displaced) unbindSession(projectRoot, stale);
  writeJson(p, { runId, projectRoot: path.resolve(projectRoot), boundAt: new Date().toISOString() });
  return { path: p, displaced };
}

/**
 * The run bound to a session, or `null`.
 *
 * A corrupt pointer must read as "no run", never as an error. `readJson` throws on malformed
 * JSON — deliberately, so a half-written *state* file cannot be mistaken for a fresh run — but
 * propagating that here was catastrophic in a way the fail-closed Git hook amplified: a single
 * truncated pointer file (a crash mid-write) made every classifier call throw, and the hook's
 * fail-closed handler then denied *every* Bash, Write and Edit call in that project, in every
 * session, until the user found and deleted the file by hand. The pointer is a lookup, not
 * evidence; an unreadable one means the session simply owns nothing.
 */
export function activeRunId(projectRoot, sessionId) {
  let pointer;
  try {
    pointer = readJson(sessionPointerPath(projectRoot, sessionId), null);
  } catch {
    return null;
  }
  return pointer?.runId ?? null;
}

export function unbindSession(projectRoot, sessionId) {
  try {
    fs.rmSync(sessionPointerPath(projectRoot, sessionId), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Every session id whose pointer names this run.
 *
 * Ownership is expressed twice — `state.sessionId` says who the run thinks owns it, and the
 * pointer files say who the *hooks* will act for — and only the second one is consulted at
 * runtime. Re-reading `state.sessionId` to find the previous owner therefore misses any session
 * that was displaced earlier without being unbound, which `--force` makes reachable in a single
 * hop. Enumerating the pointers asks the question the hooks actually ask.
 */
function sessionsBoundTo(projectRoot, runId) {
  const dir = path.join(projectDir(projectRoot), 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return entries
    .filter((file) => {
      try {
        return readJson(path.join(dir, file), null)?.runId === runId;
      } catch {
        return false;
      }
    })
    .map((file) => file.slice(0, -'.json'.length));
}

/** Paths of the artefacts described in spec §20. Single source of truth for every script. */
export function artifacts(projectRoot, runId) {
  const base = runDir(projectRoot, runId);
  return {
    base,
    state: path.join(base, 'state.json'),
    lock: path.join(base, '.state.lock'),
    request: path.join(base, 'request.md'),
    brainstorm: path.join(base, 'brainstorm-summary.md'),
    design: path.join(base, 'design.md'),
    plan: path.join(base, 'plan.md'),
    tasks: path.join(base, 'tasks.json'),
    evidence: path.join(base, 'evidence.json'),
    // Park-and-relay (§S6): the director cannot call `AskUserQuestion` (§R1), so it writes the
    // question here and stops. The main thread renders it and writes the answer back into the same
    // file. One file, two writers, so a question and its answer can never drift apart.
    question: path.join(base, 'question.json'),
    publish: path.join(base, 'publish.json'),
    locks: path.join(base, 'locks.json'),
    telemetry: path.join(base, 'telemetry.jsonl'),
    reviewsDir: path.join(base, 'reviews'),
    reportsDir: path.join(base, 'reports'),
    packsDir: path.join(base, 'review-packs'),
    finalReport: path.join(base, 'final-report.md'),
    review: (name) => path.join(base, 'reviews', `${name}.json`),
    report: (id) => path.join(base, 'reports', `${id}.json`),
  };
}

/** Newest-first list of run ids for a project, used by `/hyperpowers:resume` and `:status`. */
export function listRuns(projectRoot) {
  const dir = runsDir(projectRoot);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  return entries
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * Run ids sort lexicographically into chronological order, which is what `listRuns` relies on.
 * The random suffix prevents collisions when two runs start in the same second.
 */
export function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}
