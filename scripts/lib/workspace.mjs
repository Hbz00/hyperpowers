/**
 * The working tree as it stood before the run touched anything (spec §13 condition 10).
 *
 * Condition 10 asks whether *the run* changed a file no work package owns. The check
 * implementing it compared every modified and untracked file against package ownership, which
 * silently reinterpreted the question as "is anything uncommitted here?" — so a run started in a
 * repository with any pre-existing edit could not pass its own completion gate however well it
 * went. Most repositories people work in are dirty. Requiring a clean tree to start would have
 * been the wrong trade; failing at the end without explaining why was worse.
 *
 * Both halves live here because they must agree exactly: the capture side and the comparison
 * side ran the same fingerprint from two files, under a comment asking future readers to keep
 * them in step. A rule that depends on someone remembering it is the defect class this codebase
 * keeps rediscovering, so there is now one implementation and no rule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, nowIso } from './io.mjs';

/**
 * Above this, hash the metadata instead of the bytes. An enormous dirty file is rare, and
 * reporting drift slightly too eagerly is the safe direction for a scope check.
 */
const HASH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Files Hyperpowers itself writes into the working tree.
 *
 * They are not the feature's changes and no work package will ever own them, so the completion
 * gate excuses them. It lived only there, and the review pack showed them to the reviewer —
 * which produced exactly what it should have: a live run's round-5 reviewer raised a **blocking**
 * finding against `.claude/settings.json`, correctly observing an unowned file in the change and
 * that it "disables workflows and related safeguards". It was right about what it saw; what it
 * saw was `/hyperpowers:setup`'s own output, and a mandatory review round plus an adjudication
 * cycle were spent on it.
 *
 * One list, used by both, or the two halves disagree about what the change even is.
 */
export const HYPERPOWERS_OWN_FILES = Object.freeze([
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.hyperpowers.json',
]);

/** Git pathspecs that exclude the above, for commands that report the change under review. */
export function excludeOwnFiles() {
  return ['--', '.', ...HYPERPOWERS_OWN_FILES.map((f) => `:(exclude)${f}`)];
}

/**
 * Why an orchestration file must not sit where it does, or `null` when the location is fine.
 *
 * Spec §20: run data never enters the repository under review. Two CLI verbs accept a path from an
 * agent — `validate-agent-report submit` and `adjudication-ledger record` — and the first was given
 * this check while the second was not, so the rule held on one door and not the other. That is the
 * defect this codebase keeps producing, introduced here by fixing one caller and not looking for
 * the second.
 *
 * A file *inside the run directory* is fine even though the run directory can, in a degraded
 * fallback, sit under the project: what matters is that it is not part of the change being
 * reviewed.
 */
export function misplacedOrchestrationFile(filePath, projectRoot, runBase) {
  const inside = (parent) => !path.relative(path.resolve(parent), path.resolve(filePath)).startsWith('..');
  if (!inside(projectRoot) || inside(runBase)) return null;
  return (
    `${filePath} is inside the project working tree.\n\n` +
    `Orchestration artefacts never enter the repository under review (spec §20): the ` +
    `implementation review rounds inspect the real diff, and the completion gate fails on any file ` +
    `no work package owns — including this one.\n\n` +
    `Write it inside the run directory instead:\n  ${path.join(runBase, 'reports')}/`
  );
}

function gitLines(root, args) {
  try {
    return execFileSync('git', ['-c', 'core.pager=cat', ...args], {
      cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Content fingerprint of one path.
 *
 * `absent` is a real value, not an error: a file that did not exist at run start and does now is
 * a change, and conflating "missing" with "unreadable" would exempt it.
 */
function fingerprintFile(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return `special:${stat.mode}`;
    if (stat.size > HASH_MAX_BYTES) return `size:${stat.size}:mtime:${Math.floor(stat.mtimeMs)}`;
    return `sha256:${sha256(fs.readFileSync(abs))}`;
  } catch {
    return 'absent';
  }
}

/**
 * Snapshot the already-dirty files, by content.
 *
 * Hashes rather than a name list, because a name list would exempt every already-dirty file for
 * the rest of the run — making the place where scope drift is easiest to hide the one place
 * nothing looks. A baseline file the run later edits still fails condition 10; an untouched one
 * passes.
 */
export function captureWorkspaceBaseline(root) {
  const tracked = gitLines(root, ['diff', '--name-only', 'HEAD']);
  const untracked = gitLines(root, ['ls-files', '--others', '--exclude-standard']);
  if (tracked === null && untracked === null) return { at: nowIso(), available: false, files: {} };

  const files = {};
  for (const rel of new Set([...(tracked ?? []), ...(untracked ?? [])])) {
    files[normalisePath(rel)] = fingerprintFile(path.join(root, rel));
  }
  return { at: nowIso(), available: true, files };
}

export function normalisePath(p) {
  return path.normalize(String(p)).replace(/^\.\//, '');
}

/**
 * Split observed changes into "was already like this" and "this run did it".
 *
 * Runs started before the baseline existed, and repositories where Git could not answer at init,
 * carry none. Those fall back to attributing every change to the run rather than inventing an
 * exemption — the conservative reading, and the one that cannot turn a missing baseline into a
 * pass.
 */
export function splitByBaseline(baseline, changed, root) {
  if (!baseline?.available || !baseline.files) return { preExisting: [], byTheRun: [...changed] };
  const preExisting = [];
  const byTheRun = [];
  for (const rel of changed) {
    const before = baseline.files[normalisePath(rel)];
    if (before !== undefined && before === fingerprintFile(path.join(root, rel))) preExisting.push(rel);
    else byTheRun.push(rel);
  }
  return { preExisting, byTheRun };
}
