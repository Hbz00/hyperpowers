#!/usr/bin/env node
/**
 * One-time project setup.
 *
 * `plugin.json`'s `settings` key cannot contribute `env` — only an allowlist of keys is
 * applied, and `env` is not on it (measured; validation ledger G4). So Hyperpowers cannot
 * configure its own runtime, and the environment contract has to be written into the project's
 * `.claude/settings.json`. Whether that needs a session restart is not documented either way,
 * so this does not assert one: it reports `restartRequired` by checking whether the variables
 * are actually live in this process. Preflight applies the same test, so the answer is measured
 * per machine rather than claimed.
 *
 *   setup.mjs [--project <dir>] [--apply] [--scope project|local] [--block-cap <n>]
 *
 * Without `--apply` it prints the exact diff and changes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, emitJson, resolveProjectRoot } from './lib/cli.mjs';
import { REQUIRED_ENV, REQUIRED_SETTINGS, DEFAULTS } from './lib/config.mjs';
import { readJson, writeJson } from './lib/io.mjs';

const { flags } = parseArgs();
const projectRoot = resolveProjectRoot(flags);
const scope = flags.scope === 'local' ? 'settings.local.json' : 'settings.json';
const settingsPath = path.join(projectRoot, '.claude', scope);
const apply = flags.apply === true || flags.apply === 'true';
const blockCap = Number(flags['block-cap'] ?? DEFAULTS.stop.blockCap);

const existing = readJson(settingsPath, null);
const current = existing ?? {};

const desiredEnv = Object.fromEntries(
  Object.entries(REQUIRED_ENV).map(([k, v]) => [
    k,
    k === 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP' ? String(blockCap) : v.value,
  ]),
);

const changes = [];
for (const [key, value] of Object.entries(desiredEnv)) {
  const before = current.env?.[key];
  if (before !== value) changes.push({ kind: 'env', key, before: before ?? null, after: value, why: REQUIRED_ENV[key].why });
}
for (const [key, spec] of Object.entries(REQUIRED_SETTINGS)) {
  const before = current[key];
  if (before !== spec.value) changes.push({ kind: 'setting', key, before: before ?? null, after: spec.value, why: spec.why });
}

const merged = {
  ...current,
  ...Object.fromEntries(Object.entries(REQUIRED_SETTINGS).map(([k, v]) => [k, v.value])),
  env: { ...(current.env ?? {}), ...desiredEnv },
};

// Everything else the user already configured is preserved: setup adds Hyperpowers' contract,
// it does not take over the project's settings file.
if (apply && changes.length) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (existing) {
    const backup = `${settingsPath}.hyperpowers-backup-${Date.now()}`;
    fs.copyFileSync(settingsPath, backup);
    changes.push({ kind: 'backup', key: backup, before: null, after: null, why: 'previous settings preserved' });
  }
  writeJson(settingsPath, merged);
}

const envInForce = Object.entries(desiredEnv).filter(([k, v]) =>
  k === 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP' ? Number(process.env[k]) >= 32 : process.env[k] === v,
).length;
const active = envInForce === Object.keys(desiredEnv).length;

emitJson({
  projectRoot,
  settingsPath,
  applied: apply && changes.filter((c) => c.kind !== 'backup').length > 0,
  alreadyConfigured: changes.length === 0,
  changes,
  environmentActiveInThisSession: active,
  restartRequired: !active,
  next: changes.length === 0 && active
    ? 'Hyperpowers is configured and its environment is in force. Run /hyperpowers:feature.'
    : !apply
      ? 'This was a dry run. Re-run with --apply to write these changes.'
      // `active` is read from *this* subprocess's environment, which was spawned before the file
      // existed — so on a first install it is false whether or not a restart is actually needed,
      // and telling the user to restart is a guess dressed as a measurement. Observed on a
      // third-party machine: setup reported `restartRequired: true`, and preflight — a later
      // subprocess in the same session — measured the contract already in force. Only a process
      // spawned after the write can answer this, so say what to run instead of what to do.
      : 'Settings written. Now run preflight: if it reports the environment contract in force, this session is ready and no restart is needed. If it reports the contract missing, restart Claude Code and run it again.',
  verifyWith: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"',
});

process.exit(0);
