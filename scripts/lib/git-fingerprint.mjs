/**
 * The repository fingerprint the Git guard compares — one producer, three call sites.
 *
 * It lived inside `git-guard.mjs`, which meant the baseline existed only after the first
 * PostToolUse firing: `init` established none, and `resume-run.mjs` *deleted* the stored one, so
 * a mutation performed inside the same Bash invocation that first re-established it was absorbed
 * into the baseline and never reported. Worse, the deletion was unconditional while its
 * justifying comment described only the SUSPENDED case — a resume of a run that never released
 * Git threw away a valid baseline for nothing (reproduced: the tag created before the next Bash
 * call was absorbed silently). Extracting the producer lets `init` and `resume` stamp the exact
 * object the guard reads; re-implementing the field set at a call site is forbidden, because
 * `describeDrift` tolerates missing keys by design ("absent on a fingerprint written by an older
 * build") — a partial stamp would silently stop escalating exactly the fields §13.11 depends on.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJson, sha256 } from './io.mjs';

/**
 * Bumped whenever the field set or the hash changes. The guard compares field-by-field, so a
 * fingerprint written by one hash against a current one from another would read as total drift —
 * a false violation for upgrading mid-run. A version mismatch re-baselines instead of comparing.
 */
export const FINGERPRINT_VERSION = 2;

function git(projectRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function fingerprintHash(text) {
  // sha256, not the 32-bit polynomial this replaces: for an integrity guard, "collisions are
  // irrelevant" was true of accidents and not of an adversary who can choose the colliding
  // content, and the real hash costs nothing here.
  return sha256(text);
}

/**
 * Fingerprint the mutable parts of a repository. Deliberately excludes the working tree:
 * editing files is the whole point of a run. What must not change is *Git* state.
 */
export function gitFingerprint(projectRoot) {
  const gitDir = git(projectRoot, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return null;
  return {
    v: FINGERPRINT_VERSION,
    head: git(projectRoot, ['rev-parse', 'HEAD']) ?? 'unborn',
    branch: git(projectRoot, ['branch', '--show-current']) ?? '',
    refs: fingerprintHash(git(projectRoot, ['for-each-ref', '--format=%(refname) %(objectname)']) ?? ''),
    stash: fingerprintHash(git(projectRoot, ['stash', 'list']) ?? ''),
    // `--raw`, not `--name-status`: the raw form carries the blob SHAs on both sides, so
    // *replacing* the staged content of an already-staged file changes this hash. With the
    // name-and-status form it did not — the path is still there and its status is still `M`, so
    // a script that re-staged different content moved nothing material and the run was told its
    // repository had not changed. Reproduced before fixing.
    staged: fingerprintHash(git(projectRoot, ['diff', '--cached', '--raw']) ?? ''),
    // The local config decides where pushes go, what runs as a hook, and which identity signs.
    // It was omitted because none of HEAD/refs/index/stash moves when it changes — which is
    // exactly the argument for hashing it separately rather than for leaving it unwatched. Only
    // the hash is stored: the raw values include remote URLs and user identity, and this file
    // lives outside the repository the user chose to put them in. Measured stable across
    // `npm install` and a full test run before being added, because a guard that fires on
    // ordinary work is a guard people switch off.
    config: fingerprintHash(git(projectRoot, ['config', '--list', '--local']) ?? ''),
  };
}

export function fingerprintPath(runBase) {
  return path.join(runBase, 'git-fingerprint.json');
}

/**
 * Establish the baseline now, rather than at the next PostToolUse firing.
 *
 * Best-effort by design: a project with no Git has no fingerprint, and a stamp that cannot be
 * written must never fail an `init` or a `resume` — the guard's own first-observation path then
 * applies, which is exactly today's behaviour.
 */
export function stampFingerprint(projectRoot, runBase) {
  try {
    const current = gitFingerprint(projectRoot);
    if (!current) return false;
    writeJson(fingerprintPath(runBase), current);
    return true;
  } catch {
    return false;
  }
}
