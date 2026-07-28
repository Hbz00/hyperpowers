/**
 * Git policy classifier (spec §14).
 *
 *   Reading Git is allowed. Mutating Git is forbidden.
 *
 * The policy is an **allowlist**: a git invocation is permitted only when its subcommand and
 * every one of its options are known to be read-only. Anything else — an unknown subcommand,
 * an unrecognised option, a construct the parser could not decompose — is denied. Spec §14.4
 * demands exactly this ("refusera toute commande qu'il ne peut pas classer de manière sûre").
 *
 * Scope of the guarantee, stated honestly:
 *   - Direct invocations, chains, pipes, subshells, command substitution, `eval`, `sh -c`,
 *     `xargs`, `find -exec` and environment-variable redirection are all classified here.
 *   - A command that runs an opaque script (`./deploy.sh`, `npm run release`) cannot be
 *     classified statically. Prevention is impossible in that case; it is covered instead by
 *     detection — `scripts/git-guard.mjs` snapshots the repository before and after every
 *     Bash call and raises POLICY_VIOLATION on any observed mutation.
 */

import path from 'node:path';
import { splitCommands, tokenize } from './shell-parse.mjs';

/** Subcommands that are read-only with any combination of their own options. */
const READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'merge-base', 'cat-file', 'grep', 'blame', 'annotate', 'describe', 'shortlog',
  'name-rev', 'for-each-ref', 'diff-tree', 'diff-index', 'diff-files', 'check-ignore',
  'check-attr', 'check-mailmap', 'count-objects', 'whatchanged', 'version', 'verify-commit',
  'verify-tag', 'show-ref', 'show-branch', 'cherry', 'range-diff', 'help',
  // Queries a remote's refs and writes nothing locally — unlike `fetch`, which updates them.
  'ls-remote',
]);

/**
 * Subcommands that are read-only only in specific forms. `allowedFirstArgs` is checked
 * against the first non-option argument; `requireAnyFlag` demands at least one listed flag.
 */
const CONDITIONAL_SUBCOMMANDS = {
  branch: {
    // `git branch` / `git branch -v` list; `git branch <name>` creates.
    readOnlyFlags: new Set([
      '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-l', '--list',
      '--show-current', '--contains', '--no-contains', '--merged', '--no-merged',
      '--format', '--points-at', '--sort', '--color', '--no-color', '--column', '--no-column',
      '-i', '--ignore-case', '--omit-empty',
    ]),
    positionalsRequire: '--list',
    listSynonyms: ['-l'],
    valueFlags: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--color', '--column'],
    reason: 'git branch may only list; creating or deleting a branch is a mutation',
  },
  remote: {
    allowedFirstArgs: new Set(['show', 'get-url', '-v', '--verbose']),
    allowEmpty: true,
    reason: 'git remote may only show or get-url',
  },
  tag: {
    readOnlyFlags: new Set(['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '-n', '--column', '--no-column', '-i', '--ignore-case']),
    positionalsRequire: '--list',
    listSynonyms: ['-l'],
    valueFlags: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column'],
    requireAnyFlag: ['-l', '--list', '--points-at', '--contains', '--merged', '--no-merged'],
    allowEmpty: true,
    reason: 'git tag may only list; creating or deleting a tag is a mutation',
  },
  reflog: {
    allowedFirstArgs: new Set(['show', 'exists']),
    allowEmpty: true,
    reason: 'git reflog may only show; expire and delete are mutations',
  },
  stash: {
    allowedFirstArgs: new Set(['list', 'show']),
    allowEmpty: false,
    reason: 'git stash may only list or show; push, pop, apply and drop are mutations',
  },
  notes: {
    allowedFirstArgs: new Set(['list', 'show']),
    allowEmpty: true,
    reason: 'git notes may only list or show',
  },
  submodule: {
    allowedFirstArgs: new Set(['status', 'summary']),
    allowEmpty: true,
    reason: 'git submodule may only report status or summary',
  },
  bisect: {
    allowedFirstArgs: new Set(['log', 'visualize', 'view']),
    allowEmpty: false,
    reason: 'git bisect moves HEAD; only log and view are read-only',
  },
  worktree: {
    allowedFirstArgs: new Set(['list']),
    allowEmpty: false,
    reason: 'worktrees are forbidden by policy (spec §2); only `git worktree list` is readable',
  },
  'symbolic-ref': {
    // `git symbolic-ref HEAD` reads; `git symbolic-ref HEAD refs/heads/x` writes. The
    // distinction is the number of operands, not the presence of `-q`/`--short` — requiring
    // those refused the ordinary read form.
    readOnlyFlags: new Set(['-q', '--quiet', '--short']),
    maxPositionals: 1,
    allowEmpty: true,
    reason: 'git symbolic-ref writes when given a value; only reading a ref is allowed',
  },
};

/** Explicitly named in spec §14.3. Listed so denials can cite the policy rather than guess. */
const FORBIDDEN_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase',
  'cherry-pick', 'revert', 'clean', 'push', 'pull', 'fetch', 'init', 'clone',
  'apply', 'am', 'update-index', 'update-ref', 'config', 'gc', 'maintenance', 'mv', 'rm',
  'filter-branch', 'replace', 'prune', 'repack', 'fsck', 'commit-tree', 'hash-object',
  'write-tree', 'read-tree', 'mktag', 'mktree', 'send-email', 'format-patch', 'request-pull',
  'daemon', 'credential', 'hook', 'sparse-checkout', 'archive', 'bundle', 'gui', 'citool',
]);

/**
 * Global git options that must never appear: each one either escapes the project, injects
 * configuration (which can register hooks or aliases that execute arbitrary code), or
 * relocates the binary that runs.
 */
const FORBIDDEN_GLOBAL_OPTIONS = [
  '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--bare',
];

/**
 * Environment variables that redirect git at another repository or change how it executes.
 *
 * `GIT_PAGER` is deliberately NOT here. Git runs its pager through a shell, so
 * `GIT_PAGER="touch /tmp/x" git -p log` executes an arbitrary command through a command the
 * policy otherwise classifies as a read. `PAGER` has the same effect without a `GIT_` prefix,
 * so it is named explicitly below.
 */
const ALLOWED_GIT_ENV = new Set(['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS']);

/** Non-`GIT_` variables that still name a program git will execute. */
const SUBPROCESS_ENV = new Set(['PAGER', 'GIT_PAGER', 'LESSOPEN', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']);

/**
 * Pager values that cannot execute anything else. `GIT_PAGER=cat` is a common, harmless idiom
 * and stays allowed; anything else in a pager variable is an arbitrary command.
 */
const INERT_PAGERS = new Set(['', 'cat', '/bin/cat', '/usr/bin/cat']);

/**
 * Variables that decide *which binary* a bare command name resolves to.
 *
 * The classifier's whole model is "the word in command position names the program". `PATH=` (and
 * its loader cousins) breaks that model without any expansion for
 * `isUnclassifiableCommandWord` to catch: `PATH=/tmp/evil:$PATH git status` was confidently
 * classified as a validated read of real git while running an attacker-controlled `git`. Writing
 * that file is unrestricted — the file-mutation guard only defends `.git/` — so this is the one
 * step that has to be denied. It is the same failure mode as `GIT_DIR`, one level down: not
 * "which repository" but "which program".
 */
const BINARY_RESOLUTION_ENV = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'SHELL',
]);

function checkEnvAssignments(assignments) {
  for (const [name, value] of Object.entries(assignments ?? {})) {
    if (BINARY_RESOLUTION_ENV.has(name)) {
      return deny(
        `Environment variable ${name} changes which binary a command name resolves to, so a ` +
          `command this policy classified as a read could run an entirely different program. ` +
          `Run tools by their real path instead of re-pointing ${name}.`,
        { name, value },
      );
    }
    if (SUBPROCESS_ENV.has(name)) {
      if (INERT_PAGERS.has(String(value ?? '').trim())) continue;
      return deny(
        `Environment variable ${name} names a program git runs through a shell, so it can ` +
          `execute anything. Only \`cat\` is permitted; use \`git --no-pager\` instead.`,
        { name, value },
      );
    }
    if (name.startsWith('GIT_') && !ALLOWED_GIT_ENV.has(name)) {
      return deny(`Environment variable ${name} redirects or reconfigures git and is forbidden.`, { name, value });
    }
  }
  return null;
}

/** Wrappers whose trailing words are themselves a command. */
const TRANSPARENT_WRAPPERS = new Set([
  'time', 'nohup', 'nice', 'ionice', 'chrt', 'stdbuf', 'command', 'builtin', 'exec',
  'setsid', 'unbuffer', 'watch', 'parallel', 'xargs', 'timeout',
]);

const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox']);

/**
 * Shell reserved words, which are grammar rather than programs.
 *
 * This classifier's model is "the first word names the command". A reserved word breaks that
 * model in the most direct way possible: what follows it is not an argument list, it is another
 * command the shell's own grammar runs. `then git commit -m x` classified as an invocation of a
 * program called `then`, which matched nothing and fell through to ALLOW — so `! git commit`,
 * `if true; then git commit; fi` and every loop body were confidently permitted, with the whole
 * mutating command sitting in plain, unquoted text.
 *
 * `if true; then rm -rf .git; fi` slipped the file-writer guard for the same reason: that check
 * is keyed on `words[0]`, which was `then`.
 *
 * Stripping them and re-classifying the remainder is exact rather than heuristic: the splitter
 * has already cut on `;`, `&&`, `|` and newlines, so a reserved word can only appear at the head
 * of a fragment, and what follows it in that fragment is precisely one simple command.
 */
const RESERVED_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'while', 'until', 'for', 'do', 'done', 'select',
  'case', 'esac', 'in',
  '!', '{', '}', '[[', ']]',
]);

const PRIVILEGE_ESCALATION = new Set(['sudo', 'doas', 'pkexec', 'su']);

/**
 * Wrappers that execute a command somewhere this classifier cannot follow — another host,
 * another container, another terminal. Unlike `TRANSPARENT_WRAPPERS`, the trailing argv is not
 * reliably a plain command line (`kubectl exec pod -- cmd`, `tmux send-keys "cmd" Enter`), and
 * the execution context may be a different checkout of the same repository. `ssh localhost git
 * commit` reached the very repository the policy protects.
 *
 * They are denied outright when any git-ish token appears in their arguments, and otherwise
 * allowed — running tests in a container is legitimate work.
 */
const REMOTE_EXECUTORS = new Set([
  'ssh', 'docker', 'podman', 'kubectl', 'nerdctl', 'lima', 'colima',
  'tmux', 'screen', 'script', 'expect', 'osascript', 'open',
]);

/** Builtins that set environment variables for the rest of the command line. */
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local', 'setenv']);

/**
 * A command word the shell would expand before running. The classifier never evaluates
 * expansions, so `G=git; $G commit` used to read as an unknown command — and unknown *command
 * names* fell through to ALLOW. Spec §14.4 requires the opposite: what cannot be classified is
 * denied. This is narrow on purpose: only the word in command position matters, so ordinary
 * arguments like `grep "$pattern"` are unaffected.
 */
function isUnclassifiableCommandWord(word) {
  return typeof word === 'string' && /[$`]/.test(word);
}

/** Non-git tools that can mutate repository or remote state. */
const EXTERNAL_VCS_MUTATORS = {
  gh: {
    readOnlyFirstArgs: new Set(['pr', 'issue', 'repo', 'run', 'release', 'api', 'search', 'label', 'status', 'browse', 'auth', 'workflow', 'cache', 'gist', 'ruleset']),
    readOnlySecondArgs: new Set(['view', 'list', 'diff', 'checks', 'status', 'download']),
    reason: 'gh may only read; creating, editing, merging or pushing is a mutation',
  },
  // `jj op` is a family, not a leaf: `op log`/`op show` read, `op undo`/`op restore` rewrite
  // the repository. A first-arg allowlist alone would let the mutating members through.
  jj: {
    readOnlyFirstArgs: new Set(['log', 'show', 'diff', 'status', 'st', 'files', 'cat', 'evolog', 'op']),
    readOnlySecondArgs: new Set([]),
    subcommandGroups: { op: new Set(['log', 'show', 'diff']) },
    reason: 'jj mutates the repository',
  },
  hub: { readOnlyFirstArgs: new Set([]), readOnlySecondArgs: new Set([]), reason: 'hub wraps git mutations' },
};

/** Commands that write to whatever path they are given. */
const FILE_WRITERS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'tee', 'truncate', 'dd', 'chmod', 'chown', 'ln', 'touch',
  'install', 'shred', 'unlink', 'mkdir', 'patch', 'rsync',
]);

export const Decision = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });

function deny(reason, detail) {
  return { decision: Decision.DENY, reason, detail: detail ?? null };
}
const ALLOW = { decision: Decision.ALLOW, reason: null, detail: null };

/**
 * True when `p` names, or lives inside, a `.git` directory.
 *
 * The match is case-insensitive: the default macOS filesystem is case-insensitive, so
 * `.GIT/config` and `.git/config` are the same file.
 */
export function touchesGitInternals(p) {
  if (typeof p !== 'string' || p === '') return false;
  const normalised = p.replace(/\\/g, '/');
  return /(^|\/)\.git(\/|$)/i.test(normalised);
}

/**
 * Classify one Bash command string.
 *
 * @param {string} command
 * @param {{cwd?: string, projectRoot?: string}} context
 * @returns {{decision: 'allow'|'deny', reason: string|null, detail: any}}
 */
export function classifyCommand(command, context = {}) {
  const seen = new Set();
  return classifyRecursive(String(command ?? ''), context, seen, 0);
}

function classifyRecursive(command, context, seen, depth) {
  if (depth > 8) return deny('Command nesting is too deep to classify safely.', { depth });
  if (seen.has(command)) return ALLOW; // already analysed this exact fragment
  seen.add(command);

  const rebinding = resolverRebindingIn(command);
  if (rebinding) {
    return deny(
      `\`${rebinding}\` rebinds a name this policy validates, so a later use of that name would ` +
        `run something other than the program that was checked — measured: \`hash -p /usr/bin/touch ` +
        `git; git status\` runs touch and this classifier reported it as an approved read. Bind a ` +
        `different name, or call the program by its path.`,
      { rebinding },
    );
  }

  const definition = functionDefinitionIn(command);
  if (definition) {
    return deny(
      `Defining a shell function named \`${definition}\` is forbidden: that name is one this ` +
        `policy validates, and a function rebinds it for the rest of the shell — so every later ` +
        `use runs the body instead of the program that was checked. Call the program directly, ` +
        `or name the helper something else.`,
      { function: definition },
    );
  }

  const { commands, nested, unparseable } = splitCommandsSafe(command);
  if (unparseable) {
    return deny(
      `Command could not be parsed safely (${unparseable}). Hyperpowers denies what it cannot classify.`,
      { command },
    );
  }

  // Anything produced by a substitution is itself a command line.
  for (const inner of nested) {
    const verdict = classifyRecursive(inner, context, seen, depth + 1);
    if (verdict.decision === Decision.DENY) return verdict;
  }

  for (const simple of commands) {
    const verdict = classifySimple(simple, context, seen, depth);
    if (verdict.decision === Decision.DENY) return verdict;
  }
  return ALLOW;
}

/**
 * Names whose meaning this policy depends on, and which therefore may not be rebound.
 *
 * The ban used to cover *every* function definition, and that cost real work: in a single live run
 * it refused `gate()` and `run_mut()` — two ordinary helpers an agent wrote in a scratch directory
 * while running the mutation tests its own work package demanded. A control that refuses everyday
 * shell idiom is a control people turn off, which is the argument §N2b already made about drift.
 *
 * Narrowing is only safe because the body of a function is flattened and classified like any other
 * command. That was **not** sufficient when the blanket ban was written: a body of
 * `eval "$(base64 -d …)"` passed, so a benign-looking name could still smuggle a mutation. Closing
 * that hole (§O9) is what makes this change possible, and the order matters — narrowing first would
 * have opened a bypass. Re-measured before changing anything: with §O9 in place, every non-name
 * attack (`git push`, `$G push`, `/tmp/evil/git push`, `bash <<< …`, `command git push`,
 * `sh -c "$(…)"`, `eval "$(…)"`) is denied on the body alone.
 *
 * What the body cannot cover is the *name*: `git() { ./deploy.sh; }; git status` has an opaque body
 * that is allowed on its own terms, and then `git status` runs it. So rebinding a validated name
 * stays forbidden, and everything else is ordinary work.
 */
const UNREBINDABLE = new Set([
  'git', 'jj', 'gh', 'hg', 'svn', 'bzr',
  ...SHELL_BINARIES,
  ...REMOTE_EXECUTORS,
  'eval', 'exec', 'command', 'builtin', 'env', 'xargs', 'find', 'sudo', 'doas',
  'nice', 'nohup', 'timeout', 'time', 'stdbuf', 'setsid', 'chroot',
]);

/**
 * Name bound by a function definition anywhere in the command, or `null` when nothing protected
 * is rebound.
 *
 * The splitter flattens a function body into ordinary top-level commands, which is safe for
 * chains but wrong here in a specific way: it analyses the body as if it ran once, and loses the
 * fact that the definition *rebinds a name*. `git() { …; }; git status` therefore classified as
 * a plain `git status` read while every subsequent `git` in that shell ran attacker-chosen code.
 * Both POSIX forms are recognised: `name()` and `function name`.
 */
/**
 * Builtins that can make a name resolve to something other than the program on `PATH`.
 *
 * The whole allowlist rests on one unstated assumption: that the word `git` still denotes Git when
 * the shell runs it. A function definition was the first way found to break that (§O9's sibling);
 * these are the rest, and each one below was *executed* rather than reasoned about:
 *
 *   hash -p /usr/bin/touch git ; git status     bash — ran touch, created a file named `status`
 *   hash git=/usr/bin/touch ; git status        zsh  — same, and zsh is this harness's shell
 *   autoload -Uz git ; git status               zsh  — ran a function loaded from `fpath`
 *   alias git=… <newline> git status            bash with `expand_aliases` — ran the alias
 *   alias git=… ; eval "git status"             zsh  — `eval` re-parses, so the alias applies
 *   enable -f loadable.so git                   bash — documented; not executed here, no loadable
 *
 * Two forms were tried and do **not** work, so they are deliberately not denied: a single-line
 * `alias git=… ; git status` in either shell, because aliases are expanded when the line is
 * parsed and the alias does not exist yet. They are covered anyway, because the two forms that do
 * work differ only in whitespace and would otherwise be a distinction the caller controls.
 *
 * This matters more than the opaque-script limit ADR-0003 already documents: there the policy says
 * it cannot see inside; here it reported that it had successfully classified `git status`. And a
 * rebound `git` that runs `/usr/bin/git push` leaves no local drift, so `git-guard.mjs` cannot
 * compensate for it afterwards.
 */
const RESOLVER_BUILTINS = new Set(['hash', 'enable', 'alias', 'autoload']);

/**
 * Protected name rebound by a resolver builtin anywhere in the command, or `null`.
 *
 * Quoting is not consulted for the builtin's own name: `"hash" -p /usr/bin/touch git` runs the
 * builtin exactly as the bare form does, which is the same reasoning `scriptBuiltByExpansion`
 * records for `eval`.
 */
function resolverRebindingIn(command) {
  let tokens;
  try {
    ({ tokens } = tokenize(String(command ?? '')));
  } catch {
    return null; // an unparseable command is denied by the caller's own fail-closed path
  }
  const protectedName = (name) => UNREBINDABLE.has(String(name ?? '').toLowerCase());

  // Command position only. Scanning for the word anywhere denied `echo hash -p /usr/bin/touch git`,
  // and a false positive is not a harmless over-denial here: §O9 records that chasing one is how
  // four real bypasses were found, so the cheap precision is worth taking.
  const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
  let atCommandStart = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== 'word') { atCommandStart = true; continue; }
    const text = String(t.value.text ?? '');
    const inCommandPosition = atCommandStart;
    const bare = basenameOf(text).toLowerCase();
    // Three things do not consume command position, so what follows them is still a command name:
    // a leading assignment (`FOO=1 hash …`), a transparent wrapper, and that wrapper's own flags.
    //
    // The wrapper case was a live bypass: `builtin hash -p /usr/bin/touch git; git status` and the
    // `command` form both put `hash` at argument position, sailed past a scan that only looked at
    // the root, and **were executed in bash** — `git status` ran `touch` and created a file called
    // `status`. Verified in both shells: bash rebinds through `builtin` and `command`, zsh does
    // not, and `env hash` rebinds in neither because `env` looks for an executable and the shell
    // builtin is not one. The classifier already treats these wrappers as transparent when
    // deciding *what runs*; treating them transparently here too is what keeps the two views of
    // the same command from disagreeing.
    const isWrapper = TRANSPARENT_WRAPPERS.has(bare);
    const isWrapperFlag = inCommandPosition && text.startsWith('-');
    if (!ASSIGNMENT.test(text) && !isWrapper && !isWrapperFlag) atCommandStart = false;
    if (!inCommandPosition) continue;
    if (!RESOLVER_BUILTINS.has(bare)) continue;

    // Arguments of *this* command only — an operator ends it, so `hash -r; touch git` is not a
    // rebinding and stays allowed.
    const args = [];
    for (let j = i + 1; j < tokens.length && tokens[j].type === 'word'; j += 1) {
      args.push(String(tokens[j].value.text ?? ''));
    }

    // A bare name binds for `autoload` only; elsewhere it is a query, and denying those refused
    // `alias docker` in a live environment probe. What binds, checked one form at a time:
    //
    //   alias git=…   hash -p /bin/touch git   hash git=…   enable -f lib.so git   autoload -Uz git
    //
    // and what does not: `alias git` prints the alias, `hash git` caches the PATH lookup of the
    // real git, `enable git` enables a builtin of that name and there is no `git` builtin.
    const builtin = basenameOf(text).toLowerCase();
    const bareBinds = builtin === 'autoload'
      || (builtin === 'hash' && args.some((w) => /^-[A-Za-z]*p/.test(w)))
      || (builtin === 'enable' && args.some((w) => /^-[A-Za-z]*f/.test(w)));

    for (const word of args) {
      let candidate;
      if (word.includes('=')) candidate = word.slice(0, word.indexOf('='));
      else if (word.includes('/')) continue; // a path argument is the target, never the bound name
      else if (word.startsWith('-')) continue; // a flag
      else if (!bareBinds) continue; // a query, not a binding
      else candidate = word;
      if (protectedName(candidate)) {
        return `${t.value.text} ${word}`;
      }
    }
  }
  return null;
}

function functionDefinitionIn(command) {
  let tokens;
  try {
    ({ tokens } = tokenize(String(command ?? '')));
  } catch {
    return null; // an unparseable command is denied by the caller's own fail-closed path
  }
  const forbidden = (name) => UNREBINDABLE.has(basenameOf(String(name ?? '')).toLowerCase());
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'word' && t.value.text === 'function' && !t.value.startedQuoted) {
      const name = tokens[i + 1];
      if (name?.type === 'word' && forbidden(name.value.text)) return `function ${name.value.text}`;
    }
    // `name ( )` — the tokenizer emits `(` and `)` as separate operators.
    if (t.type === 'word' && tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === ')' && forbidden(t.value.text)) {
      return `${t.value.text}()`;
    }
  }
  return null;
}

function splitCommandsSafe(command) {
  try {
    return splitCommands(command);
  } catch (err) {
    // A parser crash is itself an unclassifiable command, so it must fail closed.
    return { commands: [], nested: [], unparseable: `parser error: ${err.message}` };
  }
}

/**
 * A script string assembled by a substitution, handed to something that will execute it.
 *
 * `$G push` is denied because the *command name* comes from an expansion. `eval "$(…)"` is the
 * same failure one level in: the substitution is extracted from the word at tokenize time, so the
 * word's remaining text is empty, `eval` was handed `""`, and an empty script classified as
 * harmless. Meanwhile the substitution itself — `echo Z2l0IHB1c2g= | base64 -d` — was classified
 * separately and is genuinely benign. Everything the classifier looked at was safe; the thing
 * that would actually run was never looked at.
 *
 * Found while investigating why a legitimate `gate()` helper was refused during a live run, which
 * is a fair summary of how this whole area behaves: the false positive and the bypass were two
 * ends of the same question about what the classifier can see.
 *
 * `eval $VAR` was already denied, so the hole was specifically *command* substitution, and only
 * where the result is executed rather than passed as data.
 */
function scriptBuiltByExpansion(argv) {
  // Quoting is deliberately *not* consulted here. The neighbouring `functionDefinitionIn` skips
  // quoted words because quoting genuinely disables the `function` **keyword** — but a command
  // *name* is unaffected by it: `"eval" "$(cat p)"` and `'sh' -c "$(cat p)"` execute exactly as
  // the bare forms do. Copying that guard across reintroduced the bypass this rule was written to
  // close, in the rule itself, and only re-reading it caught that.
  const isExecutor = (w) => {
    const base = basenameOf(String(w?.text ?? '')).toLowerCase();
    return base === 'eval' || SHELL_BINARIES.has(base);
  };
  const executor = argv.findIndex((w) => w && isExecutor(w));
  if (executor === -1) return null;
  // Only what the executor could receive as its script. Keyed on *any* executor word rather than
  // the first, because `xargs sh -c "$(…)"` and `nice bash -lc "$(…)"` put a wrapper in front —
  // the same wrapper-shaped miss that defeated the first version of the stdin-as-script rule.
  //
  // The cost is a known over-deny: `echo eval "$(date)"` mentions an executor as an *argument* and
  // is refused, though it executes nothing. Contrived commands, and the trade is deliberate —
  // every precise rule in this file has eventually been defeated by a wrapper nobody enumerated,
  // and a denial here is a message telling the author to write the command out literally.
  const built = argv.slice(executor + 1).find((w) => w?.hadSubstitution);
  if (!built) return null;
  return deny(
    'The script to execute is assembled by a shell substitution, so what will actually run ' +
      'cannot be classified before it runs — the substitution itself is not the code, its output ' +
      'is. Hyperpowers denies what it cannot classify (spec §14.4). Write the command out literally.',
    { word: built.text },
  );
}

function classifySimple(simple, context, seen, depth) {
  const argv = simple.argv.filter((w) => w.text !== '' || w.hadSubstitution);
  const words = argv.map((w) => w.text).filter((t) => t.trim() !== '');
  const redirects = (simple.redirects ?? []).map((w) => w.text);

  for (const target of redirects) {
    if (touchesGitInternals(target)) {
      return deny('Writing into a .git directory is forbidden.', { target });
    }
  }

  const envVerdict = checkEnvAssignments(simple.assignments);
  if (envVerdict) return envVerdict;

  // The word in command position decides everything downstream, so it is the one place where
  // an unevaluated expansion cannot be tolerated.
  const head = argv[0];
  if (head && (head.hadSubstitution || isUnclassifiableCommandWord(head.text))) {
    return deny(
      'The command name is produced by a shell expansion, so it cannot be classified before it ' +
        'runs. Hyperpowers denies what it cannot classify (spec §14.4). Write the command out ' +
        'literally.',
      { word: head.text },
    );
  }

  const impostor = head ? vcsImpostorPath(head.text) : null;
  if (impostor) {
    return deny(
      `\`${head.text}\` names a VCS binary by path, but not at any standard install location. ` +
        `This policy classifies commands by the name in command position, so it cannot tell a ` +
        `real ${impostor} from a file that merely shares its name — and would otherwise report ` +
        `an unvetted program as a validated read. Invoke ${impostor} by its bare name.`,
      { word: head.text, tool: impostor },
    );
  }

  // Text this command receives on stdin. For an interpreter it is a script, and one written out
  // in full inside the very string being classified — not the opaque file this policy documents
  // as unclassifiable. `bash <<'EOF' … git push … EOF` and `bash <<< "git push"` were both
  // allowed on the strength of "a shell with no -c is running some script we cannot see".
  //
  // Keyed on *any* word rather than the first, for the same reason the wrapper backstop below
  // scans every token: the first version of this check looked only at `words[0]`, so
  // `nice bash <<< "git push"` walked straight past it. A fix that a single wrapper defeats is
  // the bug it was fixing, one level out.
  //
  // It deliberately runs even when `-c` is present. `bash -c 'wc -l' <<< "git push"` is then
  // denied although that text really is just input — an over-denial with a self-explaining
  // message. Skipping the check when `-c` appears would restore the bypass via
  // `bash -c 'bash' <<< "git push"`, and the safe direction here is obvious.
  const stdin = simple.stdin ?? [];
  if (stdin.length && words.some((w) => SHELL_BINARIES.has(basenameOf(w).toLowerCase()))) {
    for (const script of stdin) {
      const verdict = classifyRecursive(script, context, seen, depth + 1);
      if (verdict.decision === Decision.DENY) return verdict;
    }
  }

  const assembled = scriptBuiltByExpansion(argv);
  if (assembled) return assembled;

  if (words.length === 0) return ALLOW;
  return classifyArgv(words, simple.assignments ?? {}, context, seen, depth);
}

function classifyArgv(words, assignments, context, seen, depth) {
  if (depth > 8) return deny('Command nesting is too deep to classify safely.', { words });
  if (words.length === 0) return ALLOW;

  // Shell grammar is not a program. Drop any leading reserved words and classify what they
  // introduce — that is the actual command.
  let head = 0;
  while (head < words.length && RESERVED_WORDS.has(words[head])) head += 1;
  if (head > 0) {
    return head >= words.length ? ALLOW : classifyArgv(words.slice(head), assignments, context, seen, depth + 1);
  }

  // Command lookup is case-insensitive on the default macOS filesystem, so `Git commit` runs
  // the same binary as `git commit`.
  const name = basenameOf(words[0]).toLowerCase();
  const rest = words.slice(1);

  // `trap 'git push' EXIT` registers a command string the shell runs later — often before this
  // very Bash call returns. The payload sits in an *argument*, so neither the wrapper logic nor
  // the command-position expansion check ever looked at it.
  if (name === 'trap') {
    for (const arg of rest) {
      if (arg.startsWith('-') || /^[A-Z][A-Z0-9]*$/.test(arg) || /^\d+$/.test(arg)) continue; // flags and signal names
      const verdict = classifyRecursive(arg, context, seen, depth + 1);
      if (verdict.decision === Decision.DENY) return verdict;
    }
    return ALLOW;
  }

  if (PRIVILEGE_ESCALATION.has(name)) {
    return deny(`Privilege escalation (${name}) is forbidden.`, { words });
  }

  // `export GIT_DIR=…; git status` — the builtin sets the variable for everything that follows,
  // and it is a command word, not a leading assignment, so the parser never saw it as one.
  if (ENV_SETTERS.has(name)) {
    const assigned = {};
    for (const word of rest) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
      if (m) assigned[m[1]] = m[2];
    }
    const verdict = checkEnvAssignments(assigned);
    if (verdict) return verdict;
    return ALLOW;
  }

  // `env [-i] [-S "cmd"] [NAME=VALUE ...] command ...`
  if (name === 'env') {
    let i = 0;
    const envAssigns = { ...assignments };
    while (i < rest.length) {
      const w = rest[i];
      if (w === '-i' || w === '--ignore-environment' || w === '-') { i += 1; continue; }
      if (w === '-u' || w === '--unset') { i += 2; continue; }
      // `-S`/`--split-string` makes env parse and execute a whole command line.
      if (w === '-S' || w === '--split-string') {
        return classifyRecursive(rest[i + 1] ?? '', context, seen, depth + 1);
      }
      if (w.startsWith('--split-string=')) {
        return classifyRecursive(w.slice('--split-string='.length), context, seen, depth + 1);
      }
      if (/^-S./.test(w)) return classifyRecursive(w.slice(2), context, seen, depth + 1);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
      if (m) { envAssigns[m[1]] = m[2]; i += 1; continue; }
      break;
    }
    const verdict = checkEnvAssignments(envAssigns);
    if (verdict) return verdict;
    return classifyArgv(rest.slice(i), envAssigns, context, seen, depth + 1);
  }

  // Execution somewhere this classifier cannot follow. Denied only when the payload mentions a
  // VCS binary — running a test suite in a container stays allowed.
  if (REMOTE_EXECUTORS.has(name)) {
    const mentionsVcs = rest.some((word) =>
      /(^|[\s'"/;&|(])(git|jj|hub)([\s'";&|)]|$)/i.test(word) || basenameOf(word).toLowerCase() === 'git');
    if (mentionsVcs) {
      return deny(
        `\`${name}\` executes commands in a context this policy cannot inspect, and this ` +
          `invocation references a version-control binary. Run Git operations yourself instead.`,
        { words },
      );
    }
    return ALLOW;
  }

  // `eval '<command string>'` — only classifiable when the string is literal. A string assembled
  // by a substitution is refused earlier, in `classifySimple`, where the word objects still exist.
  if (name === 'eval') {
    if (rest.length === 0) return ALLOW;
    return classifyRecursive(rest.join(' '), context, seen, depth + 1);
  }

  // `sh -c '<command string>'`, including clustered short flags such as `bash -lc`, `sh -xec`.
  if (SHELL_BINARIES.has(name)) {
    const cIndex = rest.findIndex(
      (w) => w === '-c' || w === '--command' || (/^-[a-zA-Z]+$/.test(w) && w.endsWith('c')),
    );
    if (cIndex !== -1 && rest[cIndex + 1] !== undefined) {
      return classifyRecursive(rest[cIndex + 1], context, seen, depth + 1);
    }
    // `bash script.sh` is opaque; prevention is impossible, detection covers it.
    return ALLOW;
  }

  // `find … -exec <cmd> … ;`
  if (name === 'find') {
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '-exec' || rest[i] === '-execdir' || rest[i] === '-ok' || rest[i] === '-okdir') {
        const segment = [];
        for (let j = i + 1; j < rest.length && rest[j] !== ';' && rest[j] !== '+'; j += 1) {
          segment.push(rest[j] === '{}' ? 'PLACEHOLDER' : rest[j]);
        }
        const verdict = classifyArgv(segment, assignments, context, seen, depth + 1);
        if (verdict.decision === Decision.DENY) return verdict;
      }
    }
    return ALLOW;
  }

  if (TRANSPARENT_WRAPPERS.has(name)) {
    const inner = stripWrapperFlags(name, rest);
    if (inner.length > 0) {
      const verdict = classifyArgv(inner, assignments, context, seen, depth + 1);
      if (verdict.decision === Decision.DENY) return verdict;
    }
    // Backstop: flag-stripping heuristics are the weakest part of this classifier, and a
    // wrapper is precisely where a missed value-taking option would hide a real command
    // (`nice -n 10 git push` once slipped through). Any bare `git`/VCS token appearing later
    // in a wrapper's argument list is therefore classified from that point as well.
    for (let i = 0; i < rest.length; i += 1) {
      const token = basenameOf(rest[i]);
      if (token !== 'git' && !Object.prototype.hasOwnProperty.call(EXTERNAL_VCS_MUTATORS, token)) continue;
      const verdict = classifyArgv(rest.slice(i), assignments, context, seen, depth + 1);
      if (verdict.decision === Decision.DENY) return verdict;
    }
    return ALLOW;
  }

  if (name === 'git') return classifyGit(rest, context);

  if (Object.prototype.hasOwnProperty.call(EXTERNAL_VCS_MUTATORS, name)) {
    return classifyExternalVcs(name, rest);
  }

  if (FILE_WRITERS.has(name)) {
    for (const arg of rest) {
      if (touchesGitInternals(arg)) {
        return deny(`\`${name}\` targets a .git directory; mutating git internals is forbidden.`, { arg });
      }
    }
    return ALLOW;
  }

  // In-place editors are file writers whose target is positional. The flags may be clustered
  // (`perl -pi -e`) or separate (`perl -i -pe`), so look across all of them rather than for a
  // single token carrying both letters.
  const shortFlagLetters = rest
    .filter((a) => /^-[A-Za-z]/.test(a))
    .map((a) => a.slice(1).split('=')[0])
    .join('');
  if ((name === 'sed' && shortFlagLetters.includes('i')) ||
      (name === 'perl' && shortFlagLetters.includes('i'))) {
    for (const arg of rest) {
      if (touchesGitInternals(arg)) {
        return deny(`In-place edit of a .git path is forbidden.`, { arg });
      }
    }
  }

  return ALLOW;
}

function stripWrapperFlags(name, rest) {
  let i = 0;
  if (name === 'timeout') {
    while (i < rest.length && rest[i].startsWith('-')) {
      if (rest[i] === '-s' || rest[i] === '--signal' || rest[i] === '-k' || rest[i] === '--kill-after') i += 2;
      else i += 1;
    }
    if (i < rest.length && /^[0-9]/.test(rest[i])) i += 1; // the duration
    return rest.slice(i);
  }
  if (name === 'xargs') {
    while (i < rest.length && rest[i].startsWith('-')) {
      if (['-I', '-i', '-n', '-P', '-d', '-E', '-L', '-s', '--replace', '--max-args', '--max-procs', '--delimiter'].includes(rest[i])) i += 2;
      else i += 1;
    }
    return rest.slice(i);
  }
  // Generic wrappers: skip options, then any purely numeric operand (`nice -n 10 cmd`,
  // `nice 10 cmd`, `watch -n 2 cmd`) that would otherwise be mistaken for the command name.
  const VALUE_FLAGS = new Set(['-n', '--adjustment', '-c', '--class', '-p', '--pid', '-i', '-o', '-e', '--input', '--output', '--error']);
  while (i < rest.length && rest[i].startsWith('-')) {
    if (VALUE_FLAGS.has(rest[i]) && rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) i += 2;
    else i += 1;
  }
  while (i < rest.length && /^[0-9]+(\.[0-9]+)?[smhd]?$/.test(rest[i])) i += 1;
  return rest.slice(i);
}

function classifyGit(args, context) {
  let i = 0;
  // --- global options, before the subcommand ---------------------------------
  while (i < args.length && args[i].startsWith('-')) {
    const arg = args[i];
    const bare = arg.split('=')[0];

    if (FORBIDDEN_GLOBAL_OPTIONS.includes(bare)) {
      return deny(
        `Global git option \`${bare}\` is forbidden: it can relocate the repository or inject configuration that executes code.`,
        { arg },
      );
    }
    if (bare === '-C') {
      const target = arg.includes('=') ? arg.split('=').slice(1).join('=') : args[i + 1];
      const verdict = checkDirectoryEscape(target, context);
      if (verdict) return verdict;
      i += arg.includes('=') ? 1 : 2;
      continue;
    }
    if (['-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--literal-pathspecs',
         '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks',
         '--html-path', '--man-path', '--info-path', '--version', '--help', '-v', '-h'].includes(bare)) {
      i += 1;
      continue;
    }
    return deny(`Unrecognised global git option \`${arg}\`; Hyperpowers denies what it cannot classify.`, { arg });
  }

  if (i >= args.length) return ALLOW; // bare `git` prints usage

  const sub = args[i];
  const subArgs = args.slice(i + 1);

  if (FORBIDDEN_SUBCOMMANDS.has(sub)) {
    return deny(`\`git ${sub}\` mutates repository state and is forbidden by the Hyperpowers Git policy (spec §14.3).`, { sub });
  }

  // A `.git` path is only dangerous for subcommands that can write. `git log -- .git` and
  // `git cat-file -p .git/HEAD` are ordinary reads, so the check runs after the read-only
  // allowlist rather than before it.
  if (!READ_ONLY_SUBCOMMANDS.has(sub)) {
    for (const arg of [sub, ...subArgs]) {
      if (touchesGitInternals(arg)) {
        return deny('Referring to a .git internal path in a non-read-only git command is forbidden.', { arg });
      }
    }
  }

  if (READ_ONLY_SUBCOMMANDS.has(sub)) {
    const bad = subArgs.find((a) => a === '--output' || a.startsWith('--output=') || a === '-o');
    if (bad) return deny(`\`git ${sub} ${bad}\` writes a file; output redirection options are forbidden.`, { sub, arg: bad });
    if (sub === 'grep' && subArgs.some((a) => a === '-O' || a.startsWith('--open-files-in-pager'))) {
      return deny('`git grep -O` launches an external program; it is forbidden.', { sub });
    }
    return ALLOW;
  }

  const rule = CONDITIONAL_SUBCOMMANDS[sub];
  if (rule) return classifyConditional(sub, subArgs, rule);

  return deny(
    `\`git ${sub}\` is not on the Hyperpowers read-only allowlist. Unknown git subcommands are denied by design (spec §14.4).`,
    { sub },
  );
}

function classifyConditional(sub, args, rule) {
  const flags = args.filter((a) => a.startsWith('-'));
  const positionals = args.filter((a) => !a.startsWith('-'));

  if (rule.readOnlyFlags) {
    const unknown = flags.find((f) => !rule.readOnlyFlags.has(f.split('=')[0]));
    if (unknown) {
      return deny(`\`git ${sub} ${unknown}\` is not a read-only form. ${rule.reason}.`, { sub, arg: unknown });
    }
  }

  if (rule.allowedFirstArgs) {
    if (positionals.length === 0 && flags.length === 0) {
      return rule.allowEmpty ? ALLOW : deny(`\`git ${sub}\` without a read-only subcommand is forbidden. ${rule.reason}.`, { sub });
    }
    const first = positionals[0] ?? flags[0];
    if (!rule.allowedFirstArgs.has(first)) {
      return deny(`\`git ${sub} ${first}\` is not a read-only form. ${rule.reason}.`, { sub, arg: first });
    }
    return ALLOW;
  }

  if (rule.requireAnyFlag && !rule.requireAnyFlag.some((f) => flags.includes(f))) {
    if (!(positionals.length === 0 && rule.allowEmpty)) {
      return deny(
        `\`git ${sub}\` requires one of ${rule.requireAnyFlag.join(', ')} to be read-only. ${rule.reason}.`,
        { sub },
      );
    }
  }

  if (rule.positionalsRequire) {
    // Two separate defects lived in the old form of this check, and both denied everyday reads.
    //
    // It matched the literal `--list` only, so the `-l` short form — itself listed in
    // `readOnlyFlags` — was refused: `git tag -l 'v1.*'` denied, `git tag --list 'v1.*'` allowed.
    //
    // Worse, it fired on *any* positional, including the operand a read-only flag requires. The
    // rule contradicted itself: `requireAnyFlag` names `--contains`, `--points-at` and `--merged`
    // as read-only forms, and this then denied the command the moment it was given the argument
    // that makes it useful. `git branch --contains HEAD` and `git branch --merged main` — "which
    // branches contain this commit", the most ordinary read there is — were both blocked. Every
    // positional-bearing row in the conformance table happened to use the literal `--list`, which
    // is exactly why it survived four rounds of testing.
    const listing = [rule.positionalsRequire, ...(rule.listSynonyms ?? [])].some((f) => flags.includes(f));
    const consumed = countOperands(args, rule.valueFlags ?? []);
    const unexplained = positionals.length - consumed;
    if (!listing && unexplained > 0) {
      return deny(
        `\`git ${sub} ${positionals[positionals.length - 1]}\` would create or modify a ref. ${rule.reason}.`,
        { sub, arg: positionals[positionals.length - 1] },
      );
    }
  }

  if (rule.maxPositionals !== undefined && positionals.length > rule.maxPositionals) {
    return deny(`\`git ${sub}\` with ${positionals.length} arguments writes. ${rule.reason}.`, { sub });
  }

  return ALLOW;
}

/**
 * How many positionals are the required operand of a read-only flag rather than a ref name.
 *
 * `--contains HEAD` is one flag and its argument; `--contains=HEAD` is one token and consumes
 * nothing. Counting them is what separates "listing branches that contain a commit" from
 * "creating a branch called HEAD".
 */
function countOperands(args, valueFlags) {
  let consumed = 0;
  for (let i = 0; i < args.length; i += 1) {
    if (!valueFlags.includes(args[i])) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) consumed += 1;
  }
  return consumed;
}

function classifyExternalVcs(name, args) {
  const rule = EXTERNAL_VCS_MUTATORS[name];
  const positionals = args.filter((a) => !a.startsWith('-'));
  if (positionals.length === 0) return ALLOW;

  if (name === 'gh') {
    const [first, second] = positionals;
    if (first === 'api') {
      const methodIdx = args.findIndex((a) => a === '-X' || a === '--method');
      const method = methodIdx !== -1 ? String(args[methodIdx + 1] ?? '').toUpperCase() : 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        return deny(`\`gh api -X ${method}\` mutates remote state and is forbidden.`, { name, method });
      }
      return ALLOW;
    }
    if (first === 'auth' && second !== 'status') {
      return deny('`gh auth` may only report status.', { name });
    }
    if (!rule.readOnlyFirstArgs.has(first)) {
      return deny(`\`gh ${first}\` is not on the read-only allowlist. ${rule.reason}.`, { name, arg: first });
    }
    if (second && !rule.readOnlySecondArgs.has(second)) {
      return deny(`\`gh ${first} ${second}\` mutates state. ${rule.reason}.`, { name, arg: second });
    }
    return ALLOW;
  }

  if (!rule.readOnlyFirstArgs.has(positionals[0])) {
    return deny(`\`${name} ${positionals[0]}\` is not on the read-only allowlist. ${rule.reason}.`, { name });
  }
  const group = rule.subcommandGroups?.[positionals[0]];
  if (group && !group.has(positionals[1] ?? '')) {
    return deny(
      `\`${[name, positionals[0], positionals[1]].filter(Boolean).join(' ')}\` is not a read-only form. ${rule.reason}.`,
      { name, arg: positionals[1] ?? null },
    );
  }
  return ALLOW;
}

function checkDirectoryEscape(target, context) {
  if (target === undefined) return deny('`git -C` without a directory is not classifiable.', {});
  const root = context.projectRoot ? path.resolve(context.projectRoot) : null;
  const cwd = context.cwd ? path.resolve(context.cwd) : root;
  if (!root) return null; // no root known: nothing to compare against
  if (/[$`]/.test(target)) {
    return deny('`git -C` with an expanded path cannot be classified safely.', { target });
  }
  // `~` is expanded by the shell, not by path.resolve, so a lexical check would read `git -C ~`
  // as an in-project relative directory while git actually operates on the home directory.
  if (target === '~' || target.startsWith('~/') || target.startsWith('~')) {
    return deny(
      '`git -C ~…` is expanded by the shell to a path outside the project; operating on another ' +
        'repository is forbidden.',
      { target },
    );
  }
  const resolved = path.resolve(cwd ?? root, target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return deny(`\`git -C ${target}\` points outside the project; operating on another repository is forbidden.`, { target, resolved });
  }
  return null;
}

/**
 * Directories a real VCS binary is plausibly installed in.
 *
 * Deliberately generous — the goal is not to enumerate every valid install, it is to refuse the
 * case where a path points somewhere a package manager never writes.
 */
const STANDARD_BIN_DIRS = [
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin',
  '/opt/homebrew/bin', '/opt/homebrew/sbin', '/opt/local/bin', '/home/linuxbrew/.linuxbrew/bin',
  '/usr/libexec/git-core', '/Library/Developer/CommandLineTools/usr/bin',
  '/Applications/Xcode.app/Contents/Developer/usr/bin', '/nix/store', '/snap/bin', '/usr/share/git-core',
];

/**
 * The VCS tool a path-qualified command word claims to be, when that path is not a standard
 * install location — otherwise `null`.
 *
 * Classification here is by *name*, and a name is not an identity: `/tmp/evil/git status` was
 * classified as a validated read of git while running whatever that file happens to be. Planting
 * the file is unrestricted (the file guard defends only `.git/`), so the exploit power is the
 * same as an opaque `./deploy.sh` — but the failure differs in kind. An unknown script falls
 * through *unclassified*; this returned a confident `allow`. A control may decline to see
 * something; it must not report having checked what it did not check.
 */
function vcsImpostorPath(word) {
  if (typeof word !== 'string' || !word.includes('/')) return null;
  const name = path.basename(word).toLowerCase();
  if (!['git', 'jj', 'hg', 'svn'].includes(name)) return null;
  const dir = path.dirname(path.resolve(word));
  return STANDARD_BIN_DIRS.some((base) => dir === base || dir.startsWith(`${base}/`)) ? null : name;
}

function basenameOf(word) {
  if (typeof word !== 'string') return '';
  const trimmed = word.trim();
  if (trimmed === '') return '';
  return path.basename(trimmed);
}
