#!/usr/bin/env node
/**
 * Preflight (spec §12 phase 0).
 *
 * "Aucun fallback implicite n'est autorisé." Every dependency of an autonomous run is checked
 * here, before any model is asked to do anything, and a failure is a hard stop rather than a
 * degraded run. The whole point of the architecture is that quality comes from specific models
 * at specific gates; a run that silently proceeds without Codex, or with the wrong Superpowers
 * contract, is not a cheaper Hyperpowers run — it is a different, unvalidated system.
 *
 * Exit codes: 0 = ready, 1 = usage error, 5 = contract unmet (caller must go to BLOCKED).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, emitJson, resolveProjectRoot, resolveRunId } from './lib/cli.mjs';
import { dataRoot, isDataRootFromHarness, describeDataRoot, dataRootAgreesWithHooks, dataRootIsAmbiguous, artifacts, PLUGIN_ROOT } from './lib/paths.mjs';
import { REQUIRED_ENV, RECOMMENDED_ENV, loadConfig } from './lib/config.mjs';
import { tryLoadState, mutateState } from './lib/state.mjs';
import { logEvent } from './lib/telemetry.mjs';

/** Superpowers contracts Hyperpowers has actually been validated against. */
const SUPERPOWERS_COMPAT = { min: '6.0.0', below: '7.0.0', validatedAgainst: '6.2.0' };
const MIN_CLAUDE_CODE = '2.1.0';
const MIN_NODE = 18;

const { flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const runId = resolveRunId(projectRoot, flags);
const config = loadConfig(projectRoot);

const checks = [];
const add = (id, status, detail, remedy = null) => checks.push({ id, status, detail, remedy });

// ---------------------------------------------------------------- runtime ----
{
  const major = Number(process.versions.node.split('.')[0]);
  add('node-version', major >= MIN_NODE ? 'pass' : 'fail',
    `Node ${process.versions.node} (minimum ${MIN_NODE})`,
    `Install Node ${MIN_NODE}+; Hyperpowers scripts run in hook subprocesses under your Node.`);
}
{
  const version = process.env.CLAUDE_CODE_VERSION ?? tryExec('claude', ['--version'])?.split(' ')[0] ?? null;
  const ok = version ? cmpSemver(version, MIN_CLAUDE_CODE) >= 0 : null;
  add('claude-code-version', ok === null ? 'unverifiable' : ok ? 'pass' : 'fail',
    version ? `Claude Code ${version} (minimum ${MIN_CLAUDE_CODE})` : 'Could not determine the Claude Code version',
    ok === false ? `Update Claude Code to ${MIN_CLAUDE_CODE} or later.` : null);
}

// ------------------------------------------------------ environment contract ----
// `plugin.json` cannot contribute `env` (ledger G4), so this must come from the project's
// .claude/settings.json. Whether that needs a session restart is measured here rather than
// assumed: this process was spawned after setup wrote the file, so unlike setup it can tell.
{
  const missing = [];
  for (const [name, spec] of Object.entries(REQUIRED_ENV)) {
    const actual = process.env[name];
    if (name === 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP') {
      // Any sufficiently large cap is acceptable; the exact number is a preference.
      if (!actual || Number(actual) < 32) missing.push(`${name} (want >= 32, got ${actual ?? 'unset'})`);
      continue;
    }
    if (actual !== spec.value) missing.push(`${name} (want ${spec.value}, got ${actual ?? 'unset'})`);
  }
  // Recommended, not required: reported so the user knows, never a reason to refuse a run.
  const advisory = Object.entries(RECOMMENDED_ENV)
    .filter(([name, spec]) => process.env[name] !== spec.value)
    .map(([name, spec]) => `${name} (${spec.why})`);
  if (advisory.length) {
    add('environment-recommended', 'warn',
      `Not set: ${advisory.join('; ')}`,
      'Optional. Escalation still works; a second advisor simply arbitrates outside this run\'s ledger.');
  }

  add('environment-contract', missing.length === 0 ? 'pass' : 'fail',
    missing.length === 0 ? 'All required environment variables are in force.' : `Unset or wrong: ${missing.join('; ')}`,
    missing.length ? 'Run /hyperpowers:setup. If these are still missing when you re-run preflight, restart the Claude Code session — environment variables may only be read at startup.' : null);
}
{
  const where = describeDataRoot();
  add('plugin-data-dir', isDataRootFromHarness() ? 'pass' : 'fail',
    isDataRootFromHarness()
      ? `Run data at ${where.resolved} (via ${where.source})`
      : `Run artefacts would land in a fallback directory (${where.resolved}).`,
    'Ensure Hyperpowers is loaded as a plugin (not copied into the project).');

  /**
   * The two halves of the plugin must agree on where run data lives, and until this check
   * existed nothing could tell whether they did.
   *
   * The hooks receive `CLAUDE_PLUGIN_DATA` from the harness; the CLI scripts run inside `Bash`
   * tool subprocesses, which in a live session were measured carrying *another plugin's* value.
   * Every script then wrote to one directory while every hook read from another, so no hook ever
   * found the run: Git mutations went unblocked, drift undetected, the Stop controller silent —
   * and nothing anywhere reported a problem. A split like that must be loud, because its
   * signature is a run that looks perfectly healthy.
   *
   * The marker is stamped by the SessionStart hook, so its absence in a session that has started
   * means the halves resolved differently.
   */
  const agreed = dataRootAgreesWithHooks();
  // A hard failure when a session is actually running, because then `SessionStart` has had its
  // chance and the absent marker means the halves disagree — the condition under which every
  // guarantee this plugin offers is quietly absent. Outside a session (preflight run by hand from
  // a terminal) no hook has fired, so there is nothing to conclude and it stays a warning. The
  // first version of this check was a `warn` in both cases, which is the wrong reaction to the
  // most severe defect the run has ever had: a warning is something a user skims past.
  const inSession = Boolean(process.env.CLAUDE_CODE_SESSION_ID);
  // Two installations, neither claiming this one: the resolver has to answer, so it returns the
  // most recently touched directory — a coin flip that decides whether the hooks and these scripts
  // govern the same run. Refusing here is the only place the guess can be turned into a stop.
  const rival = dataRootIsAmbiguous();
  if (rival) {
    add('plugin-data-identity', 'fail',
      `More than one Hyperpowers data directory exists and none of them is marked as belonging to ` +
        `this installation (${PLUGIN_ROOT}): ${rival.join(', ')}. The directory in use was chosen by ` +
        `recency, not identity.`,
      'Restart the session so SessionStart stamps the right one, or remove the installation you are ' +
        'not using (`claude plugin uninstall hyperpowers`, or delete the stale data directory).');
  }

  add('plugin-data-agreement', agreed ? 'pass' : inSession ? 'fail' : 'warn',
    agreed
      ? 'The hooks and the CLI scripts resolve the same data root.'
      : `No SessionStart marker in ${where.resolved}${where.foreign ? ` (CLAUDE_PLUGIN_DATA here names another plugin: ${where.foreign})` : ''}. ` +
        (inSession
          ? 'A session is running, so SessionStart has already had its chance — the hooks and these scripts are resolving different directories.'
          : 'No session is running, so no hook has stamped it yet; this cannot be concluded either way from here.'),
    agreed ? null
      : 'Every hook resolves its run through this directory. If they disagree, Git mutations go unblocked, drift undetected and the Stop controller drives nothing — and the run still looks healthy. Restart the session so SessionStart runs, then re-check.');
  try {
    fs.mkdirSync(dataRoot(), { recursive: true });
    const probe = path.join(dataRoot(), '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    add('plugin-data-writable', 'pass', `${dataRoot()} is writable.`);
  } catch (err) {
    add('plugin-data-writable', 'fail', `Cannot write to ${dataRoot()}: ${err.message}`, 'Fix the permissions on the plugin data directory.');
  }
}

// ------------------------------------------------------------- superpowers ----
{
  const found = findPlugin('superpowers');
  if (!found) {
    add('superpowers', 'fail', 'Superpowers is not installed.',
      'Install it: /plugin marketplace add anthropics/claude-plugins-official && /plugin install superpowers');
  } else {
    const tooOld = cmpSemver(found.version, SUPERPOWERS_COMPAT.min) < 0;
    const tooNew = cmpSemver(found.version, SUPERPOWERS_COMPAT.below) >= 0;
    add('superpowers', tooOld || tooNew ? 'fail' : 'pass',
      `Superpowers ${found.version} at ${found.installPath} ` +
        `(supported >=${SUPERPOWERS_COMPAT.min} <${SUPERPOWERS_COMPAT.below}; validated against ${SUPERPOWERS_COMPAT.validatedAgainst})`,
      tooNew
        ? `Superpowers ${found.version} is newer than the contract Hyperpowers was validated against. ` +
          `Its brainstorming/writing-plans/executing-plans instructions may have changed in ways the ` +
          `Hyperpowers overlay no longer neutralises. Re-validate before raising the bound.`
        : tooOld ? `Upgrade Superpowers to ${SUPERPOWERS_COMPAT.min} or later.` : null);

    // Plugin dependencies are enable-checks with no version constraint (ledger G3b), so the
    // skills the overlay depends on are verified individually rather than assumed.
    const required = ['brainstorming', 'writing-plans', 'executing-plans'];
    const missing = required.filter((s) => !fs.existsSync(path.join(found.installPath, 'skills', s, 'SKILL.md')));
    add('superpowers-skills', missing.length ? 'fail' : 'pass',
      missing.length ? `Missing skills: ${missing.join(', ')}` : `Present: ${required.join(', ')}`,
      missing.length ? 'Reinstall Superpowers.' : null);
  }
}

// -------------------------------------------------------------------- codex ----
{
  const version = tryExec(config.codex.binary, ['--version']);
  add('codex-cli', version ? 'pass' : 'fail',
    version ? version.trim() : `\`${config.codex.binary}\` is not executable.`,
    version ? null
      : 'Install the Codex CLI and ensure it is on PATH — `npm install -g @openai/codex`, then ' +
        '`codex login`. The official Codex plugin (`/plugin install codex@openai-codex`) provides ' +
        'a guided `/codex:setup` if you prefer; it is a convenience, not a dependency — Hyperpowers ' +
        'calls the binary directly and never its commands (ADR-0002). Codex is a hard runtime ' +
        'requirement: it performs all six mandatory adversarial reviews.');

  /**
   * Codex resolves its own state under `$CODEX_HOME`, defaulting to `~/.codex`.
   *
   * Hardcoding the default meant that a user with a custom `CODEX_HOME` was told they were not
   * logged in while Codex worked perfectly — or, worse, was told they *were*, on the strength of
   * stale files in a directory the CLI never reads. The adapter spawns `codex` with the inherited
   * environment, so whatever this shell resolves is what the reviews will use. Confirmed by the
   * CLI's own help for the flag the adapter always passes: `--ignore-user-config` skips
   * `$CODEX_HOME/config.toml` but "auth still uses `CODEX_HOME`" — and empirically, an empty
   * `CODEX_HOME` fails a review with 401 while `~/.codex/auth.json` sits present and valid.
   */
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  const where = process.env.CODEX_HOME ? `$CODEX_HOME (${codexHome})` : codexHome;

  const authPath = path.join(codexHome, 'auth.json');
  add('codex-auth', fs.existsSync(authPath) ? 'pass' : 'fail',
    fs.existsSync(authPath) ? `Codex credentials present in ${where}.` : `No auth.json in ${where}.`,
    `Run \`codex login\`${process.env.CODEX_HOME ? ' with CODEX_HOME set as it is here' : ''}.`);

  // Every round the adapter can run, not only the mandatory six: a §18 extra round is dispatched
  // through the same adapter and would fail at the worst possible moment — mid-remediation, on a
  // new blocker — if its model were unavailable and nothing had checked.
  const { REVIEW_ROUNDS, ALL_ROUNDS } = await import('./lib/phases.mjs');
  const needed = [...new Set(Object.values(ALL_ROUNDS).map((r) => r.model))];
  const mandatory = new Set(Object.values(REVIEW_ROUNDS).map((r) => r.model));
  const cachePath = path.join(codexHome, 'models_cache.json');
  let known = null;
  try {
    known = new Set((JSON.parse(fs.readFileSync(cachePath, 'utf8')).models ?? []).map((m) => m.slug));
  } catch { /* cache absent is not fatal */ }
  const absent = known ? needed.filter((m) => !known.has(m)) : [];
  // A model only an extra round needs is a warning, not a failure: the run can complete without
  // ever using its circuit breaker, and blocking preflight over an unused escape valve would be
  // the same overreach as ignoring it entirely.
  const blocking = absent.filter((m) => mandatory.has(m));
  add('codex-models', known ? (blocking.length ? 'fail' : absent.length ? 'warn' : 'pass') : 'unverifiable',
    known
      ? absent.length ? `Not offered to this account: ${absent.join(', ')}` : `Available: ${needed.join(', ')}`
      : `Could not read the Codex model cache in ${where}; model availability will be discovered at the first review.`,
    blocking.length
      ? 'The six-round matrix requires these models. Adjust REVIEW_ROUNDS or enable them for your account.'
      : absent.length ? 'Only the §18 extra review round needs these; the six mandatory rounds can still run.' : null);
}

// ---------------------------------------------------- Claude model availability ----
// Spec §12 phase 0 items 2–4. The harness exposes no way to ask whether this account may use
// Fable 5, Opus 5 and Sonnet 5 before invoking them, so this cannot be a real precondition.
// Saying so is better than omitting the check (which is what happened) or inventing a green
// tick: the run is genuinely exposed here, and the mitigation is named rather than assumed.
{
  const configured = Object.values(config.models ?? {});
  add('claude-models', 'unverifiable',
    `Availability of ${configured.join(', ')} cannot be checked before use; the harness offers no ` +
      `capability query. The Stop controller reads the transcript on every continuation and raises ` +
      `\`model_mismatch\` if the director tier is not the configured model, so a silent demotion ` +
      `is detected within one turn and fails completion condition 12b.`,
    'If a run reports model_mismatch, stop and check the account\'s model access rather than continuing.');
}

// ---------------------------------------------------------------------- git ----
{
  const inside = tryExec('git', ['rev-parse', '--is-inside-work-tree'], projectRoot)?.trim() === 'true';
  add('git-workspace', inside ? 'pass' : 'warn',
    inside ? `Git work tree at ${tryExec('git', ['rev-parse', '--show-toplevel'], projectRoot)?.trim()}` : 'Not a Git work tree; implementation reviews will have no diff to inspect.',
    inside ? null : 'Hyperpowers never mutates Git, but the implementation review rounds are much weaker without one.');

  if (inside) {
    const gitDir = tryExec('git', ['rev-parse', '--git-dir'], projectRoot)?.trim();
    const inProgress = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']
      .filter((marker) => gitDir && fs.existsSync(path.join(projectRoot, gitDir, marker)));
    add('git-clean-operation', inProgress.length ? 'fail' : 'pass',
      inProgress.length ? `A Git operation is in progress: ${inProgress.join(', ')}` : 'No Git operation in progress.',
      inProgress.length ? 'Finish or abort the in-progress Git operation first. Hyperpowers cannot resolve it — Git mutation is forbidden by policy.' : null);
  }
}

// ------------------------------------------------------------ project shape ----
{
  try {
    const probe = path.join(projectRoot, `.hyperpowers-write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    add('project-writable', 'pass', `${projectRoot} is writable.`);
  } catch (err) {
    add('project-writable', 'fail', `Cannot write to ${projectRoot}: ${err.message}`, 'Hyperpowers must be able to implement in the project directory.');
  }

  const commands = detectVerificationCommands(projectRoot);
  add('verification-commands', commands.length ? 'pass' : 'warn',
    commands.length ? `Detected: ${commands.join(', ')}` : 'No test, lint, typecheck or build command detected.',
    commands.length ? null : 'Without a verification command, acceptance criteria can only be proven by inspection, which weakens every gate. Declare commands in .hyperpowers.json if detection missed them.');
}

// ------------------------------------------------------------------ verdict ----
const failures = checks.filter((c) => c.status === 'fail');
const warnings = checks.filter((c) => c.status === 'warn' || c.status === 'unverifiable');
const ready = failures.length === 0;

if (runId && tryLoadState(projectRoot, runId)) {
  try {
    mutateState(projectRoot, runId, (s) => { s.preflight = { ready, at: new Date().toISOString(), checks }; });
    logEvent(projectRoot, runId, { type: 'preflight', ready, failures: failures.map((f) => f.id) });
    fs.writeFileSync(path.join(artifacts(projectRoot, runId).base, 'preflight.json'), JSON.stringify({ ready, checks }, null, 2));
  } catch { /* preflight can run before a run exists */ }
}

emitJson({
  ready,
  projectRoot,
  runId,
  checks,
  failures: failures.map((f) => ({ id: f.id, detail: f.detail, remedy: f.remedy })),
  warnings: warnings.map((w) => ({ id: w.id, detail: w.detail })),
  verdict: ready
    ? 'Preflight passed. Proceed to INTAKE.'
    : 'Preflight FAILED. Transition the run to BLOCKED with these failures as the reason. Do not substitute models, skip Codex rounds, or continue in a degraded mode (spec §12 phase 0).',
});

process.exit(ready ? 0 : 5);

// ------------------------------------------------------------------ helpers ----

function tryExec(bin, args, cwd = process.cwd()) {
  try {
    return execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Parse the harness's installed-plugin registry rather than guessing at cache paths. */
function findPlugin(name) {
  const registry = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(registry, 'utf8'));
  } catch {
    return null;
  }
  for (const [key, installs] of Object.entries(data.plugins ?? {})) {
    if (key.split('@')[0] !== name) continue;
    const install = installs?.[0];
    if (!install) continue;
    let version = install.version;
    if (!version || version === 'unknown') {
      try {
        version = JSON.parse(fs.readFileSync(path.join(install.installPath, '.claude-plugin', 'plugin.json'), 'utf8')).version;
      } catch { /* leave as-is */ }
    }
    return { key, version: version ?? '0.0.0', installPath: install.installPath };
  }
  return null;
}

function cmpSemver(a, b) {
  const norm = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [norm(a), norm(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

function detectVerificationCommands(root) {
  const found = [];
  const has = (f) => fs.existsSync(path.join(root, f));
  const declared = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, '.hyperpowers.json'), 'utf8'))?.verification?.commands ?? [];
    } catch {
      return [];
    }
  })();
  if (declared.length) return declared;

  if (has('package.json')) {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
      for (const key of ['test', 'lint', 'typecheck', 'build', 'check']) {
        if (scripts[key]) found.push(`npm run ${key}`);
      }
    } catch { /* malformed package.json is the project's problem, not preflight's */ }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini') || has('setup.cfg')) found.push('pytest');
  if (has('Makefile')) found.push('make');
  if (has('Cargo.toml')) found.push('cargo test');
  if (has('go.mod')) found.push('go test ./...');
  if (has('pom.xml')) found.push('mvn test');
  if (has('build.gradle') || has('build.gradle.kts')) found.push('gradle test');
  if (has('composer.json')) found.push('composer test');
  if (has('Gemfile')) found.push('bundle exec rspec');
  return found;
}
