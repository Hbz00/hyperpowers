/**
 * Minimal argv parsing shared by every Hyperpowers script.
 *
 * Deliberately tiny and dependency-free: these scripts run inside hook subprocesses on
 * whatever Node the user has, so a dependency tree is a liability, not a convenience.
 */

import path from 'node:path';
import { activeRunId, listRuns } from './paths.mjs';

export function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

export function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * The grammar a run or session id must satisfy before it may touch a path.
 *
 * `state-machine.mjs init --run '../../../../escaped'` wrote state.json, tasks.json and
 * telemetry outside the data root while reporting success — reproduced — and a session id
 * controls the whole basename of its pointer file, so a traversal there overwrites an arbitrary
 * `.json`. `confined()` was written for agent-supplied report ids in the same file that
 * documents the identical repro, and was never applied to these two ids: the §U pattern, a rule
 * implemented at some of the sites it applies to. The grammar refuses `..`, separators, a
 * leading dot and the empty string (`--run=` planted a directory `listRuns` cannot see).
 */
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Refuse an id that could relocate run data, loudly — silence was the defect.
 *
 * `undefined`/`null` pass through: "the flag was not given" is the caller's case to handle
 * (`init` falls back to the environment, then fails with its own message). Everything else that
 * is not a valid string is refused — the first version returned non-strings unchecked, and the
 * parser represents a valueless `--session` as boolean `true`, which then became a session id of
 * `true`, a pointer named `true.json`, and a schema-invalid state. An explicitly-given flag that
 * carries no usable value must never be treated as "not given": the fallback it would reach
 * targets a *different run* while exiting 0.
 */
export function requireSafeId(kind, value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' && SAFE_ID_RE.test(value)) return value;
  const bare = value === true
    ? ` (a bare --${kind} flag with no value is not a way to say "the current one" — omit the flag entirely for that)`
    : '';
  fail(
    `Invalid ${kind} id ${JSON.stringify(value)}: ids are 1-64 characters of [A-Za-z0-9._-], ` +
      `starting with a letter or digit${bare}. A ${kind} id containing a path separator or '..' ` +
      `would silently relocate the run's records outside the data root.`,
    2,
  );
}

export function ok(message) {
  process.stdout.write(`${message}\n`);
}

export function resolveProjectRoot(flags) {
  return path.resolve(flags.project ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

/**
 * Resolve which run a command targets: explicit `--run`, else the run bound to this session,
 * else the most recent run. Being explicit beats guessing, so the resolution order is
 * reported by callers that print status.
 */
export function resolveRunId(projectRoot, flags) {
  // `!== undefined`, not `typeof === 'string'`: a valueless `--run` parses as boolean `true`, and
  // treating it as "not given" fell through to the bound-or-newest fallback — an explicitly
  // targeted command mutating a *different* run while exiting 0. Explicit beats guessing, so an
  // explicit flag that cannot be used is refused, never reinterpreted.
  if (flags.run !== undefined) return requireSafeId('run', flags.run);
  const sessionId = requireSafeId('session', flags.session) ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId) {
    const bound = activeRunId(projectRoot, sessionId);
    if (bound) return bound;
  }
  const runs = listRuns(projectRoot);
  return runs[0] ?? null;
}

/** Print an object as pretty JSON — the machine-readable contract for agents. */
export function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
