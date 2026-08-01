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
 * There is no size cap any more — every regular file is hashed by content.
 *
 * The cap (`size:mtime` above 8 MiB) was justified as "reporting drift slightly too eagerly is
 * the safe direction", and the code did the opposite of the comment: a same-size content swap
 * with the mtime restored compared *equal*, so a large already-dirty file could be rewritten and
 * classified `preExisting` — exempted from §13.10 — reproduced. Hashing a 100 MB file costs
 * ~40 ms, once per run at baseline capture; correctness is affordable here.
 */

/**
 * Files Hyperpowers itself writes into the working tree.
 *
 * They are not the feature's changes and no work package will ever own them, so the completion
 * gate excuses them. It lived only there, and the review pack showed them to the reviewer —
 * which produced exactly what it should have: a live run's round-5 reviewer raised a **blocking**
 * finding against `.claude/settings.json`, correctly observing an unowned file in the change and
 * that it "disables workflows and related safeguards". It was right about what it saw; what it
 * saw was the plugin's own setup output, and a mandatory review round plus an adjudication
 * cycle were spent on it.
 *
 * One list, used by both, or the two halves disagree about what the change even is.
 */
/**
 * The project-scoped Claude settings file, spelled once.
 *
 * Hyperpowers does **not** write here — `session-settings.mjs` deliberately uses the *user*
 * settings file instead, because the settings watch is established on `.claude/` at startup and a
 * repository without that directory would never notice the write (§V17). The path matters anyway:
 * the user may well have one, and it is Hyperpowers' concern rather than the feature's, so it stays
 * excluded from the review pack and from the completion gate's working-tree digest.
 */
export const LOCAL_SETTINGS = '.claude/settings.local.json';

export const HYPERPOWERS_OWN_FILES = Object.freeze([
  '.claude/settings.json',
  LOCAL_SETTINGS,
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
/**
 * Canonical form of a path: symlinks resolved, aliases collapsed. The leaf may not exist yet
 * (`publish-request` checks existence afterwards), so the nearest existing ancestor is
 * canonicalised and the missing tail re-joined. One implementation for both containment checks —
 * it was written twice, in adjacent functions, which is how the two would eventually disagree.
 */
function canonicalPath(p) {
  let head = path.resolve(p);
  const tail = [];
  for (let i = 0; i < 100 && head !== path.dirname(head); i += 1) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      tail.push(path.basename(head));
      head = path.dirname(head);
    }
  }
  return path.resolve(p);
}

export function misplacedOrchestrationFile(filePath, projectRoot, runBase) {
  // Canonical paths on both sides, not lexical ones. `path.resolve` alone let the same file be
  // refused or accepted depending on which alias addressed it — on macOS `/tmp` vs `/private/tmp`
  // makes that disagreement routine, no adversary required.
  const file = canonicalPath(filePath);
  const inside = (parent) => !path.relative(canonicalPath(parent), file).startsWith('..');
  if (!inside(projectRoot) || inside(runBase)) return null;
  return (
    `${filePath} is inside the project working tree.\n\n` +
    `Orchestration artefacts never enter the repository under review (spec §20): the ` +
    `implementation review rounds inspect the real diff, and the completion gate fails on any file ` +
    `no work package owns — including this one.\n\n` +
    `Write it inside the run directory instead:\n  ${path.join(runBase, 'reports')}/`
  );
}

/**
 * Is this path — canonically, symlinks resolved — inside the run directory?
 *
 * `publish-request` hands its file to the main thread, which publishes it to a claude.ai page.
 * The director's contract says the page is written into the run directory (spec §20 keeps it out
 * of the reviewed diff), and the check is canonical rather than lexical so a symlink planted
 * inside the run directory cannot smuggle outside content into the publication.
 */
export function insideRunDir(filePath, runBase) {
  return !path.relative(canonicalPath(runBase), canonicalPath(filePath)).startsWith('..');
}

/** NUL-delimited path list; the caller passes `-z`. Local rather than imported from review-pack,
 * which imports this module — see `gitPathsZ` there for why newline-splitting paths is unsafe. */
function gitPathsZ(root, args) {
  try {
    return execFileSync('git', ['-c', 'core.pager=cat', ...args], {
      cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
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
/** Above this, hash through git instead of a Buffer — same exactness, streamed in C, no
 * multi-gigabyte allocation inside a Node process that also runs inside hook budgets. */
const HASH_EXEC_BYTES = 64 * 1024 * 1024;

function fingerprintFile(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return `special:${stat.mode}`;
    if (stat.size > HASH_EXEC_BYTES) {
      // `git hash-object` works on any file, repository or not, and changes exactly when the
      // bytes do. The metadata shortcut this replaces compared equal across a same-size content
      // swap; a whole-file Buffer read fixed that and traded it for unbounded memory.
      const blob = execFileSync('git', ['hash-object', '--', abs], {
        encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (blob) return `gitblob:${blob}`;
      throw Object.assign(new Error('empty hash-object output'), { code: 'EEMPTYHASH' });
    }
    return `sha256:${sha256(fs.readFileSync(abs))}`;
  } catch (err) {
    // "Missing" and "unreadable" must not share a value: `'absent' === 'absent'` is itself an
    // exemption, so a file too large for a Buffer or unreadable for any other reason would
    // compare equal to its own baseline and be excused. A value that can never compare equal
    // keeps the stated safe direction — an unreadable file is attributed to the run.
    if (err?.code === 'ENOENT') return 'absent';
    return `unreadable:${err?.code ?? 'unknown'}:${Math.random().toString(36).slice(2)}`;
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
  // `-z`: under default `core.quotePath` a non-ASCII path arrives C-quoted, and the baseline then
  // stored the quoted name with fingerprint `absent` — which the scope check later "matched" and
  // used to classify a changed file as pre-existing. Reproduced with `café.mjs`.
  const tracked = gitPathsZ(root, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = gitPathsZ(root, ['ls-files', '--others', '--exclude-standard', '-z']);
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
