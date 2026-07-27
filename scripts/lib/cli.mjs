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
  if (typeof flags.run === 'string') return flags.run;
  const sessionId = flags.session ?? process.env.CLAUDE_CODE_SESSION_ID;
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
