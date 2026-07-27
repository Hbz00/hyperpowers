/**
 * Git policy conformance table (spec §14).
 *
 * Each row is a command string plus the verdict the policy must return. The table is the
 * specification of the policy's behaviour: adding a case here is how the policy is extended,
 * and every case is a claim that can be falsified by running this file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyCommand, touchesGitInternals } from '../scripts/lib/git-policy.mjs';
import { splitCommands, tokenize } from '../scripts/lib/shell-parse.mjs';

const CTX = { projectRoot: '/work/project', cwd: '/work/project' };

const ALLOWED = [
  // Plain reads named in spec §14.2
  'git status',
  'git status --short --untracked-files=all',
  'git diff',
  'git diff --stat',
  'git diff --name-only',
  'git diff HEAD~3..HEAD -- src/',
  'git log --oneline -20',
  'git show HEAD:src/app.py',
  'git ls-files',
  'git rev-parse --show-toplevel',
  'git merge-base main HEAD',
  'git cat-file -p HEAD',
  'git grep -n "TODO"',
  'git branch --show-current',
  'git branch',
  'git branch -a -v',
  'git branch --list "feature/*"',
  'git remote -v',
  'git remote show origin',
  'git blame src/app.py',
  'git describe --tags',
  'git for-each-ref --format="%(refname)"',
  'git stash list',
  'git reflog show',
  'git worktree list',
  'git submodule status',
  'git tag --list "v1.*"',
  'git rev-list --count HEAD',
  'git check-ignore -v build/',
  // Composition around reads
  'git status && git diff --stat',
  'git log --oneline | head -20',
  'cd src && git diff',
  'echo "$(git rev-parse HEAD)"',
  'BASE=$(git merge-base main HEAD); git diff $BASE',
  'for f in $(git ls-files); do echo $f; done',
  'git -C packages/api status',
  'GIT_PAGER=cat git log -5',
  'timeout 30 git status',
  'xargs -n1 git show < list.txt',
  // Non-git commands are none of the policy's business
  'npm test',
  'pytest -q',
  'ls -la',
  'rm -rf build/',
  'sed -i "s/a/b/" src/app.py',
  'cat .github/workflows/ci.yml',
  'gh pr view 42',
  'gh pr list --state open',
  'gh api /repos/o/r/pulls',
  'gh run view 12345',
];

const DENIED = [
  // Direct mutations, spec §14.3
  ['git add .', /forbidden/i],
  ['git add -A', /forbidden/i],
  ['git commit -m "wip"', /forbidden/i],
  ['git commit --amend --no-edit', /forbidden/i],
  ['git checkout main', /forbidden/i],
  ['git switch -c feature', /forbidden/i],
  ['git restore src/app.py', /forbidden/i],
  ['git reset --hard origin/main', /forbidden/i],
  ['git merge develop', /forbidden/i],
  ['git rebase -i HEAD~3', /forbidden/i],
  ['git cherry-pick abc123', /forbidden/i],
  ['git revert HEAD', /forbidden/i],
  ['git clean -fd', /forbidden/i],
  ['git push origin main', /forbidden/i],
  ['git pull', /forbidden/i],
  ['git fetch origin', /forbidden/i],
  ['git init', /forbidden/i],
  ['git clone https://example.com/r.git', /forbidden/i],
  ['git apply patch.diff', /forbidden/i],
  ['git am < patch.mbox', /forbidden/i],
  ['git update-index --assume-unchanged f', /forbidden/i],
  ['git config user.email a@b.c', /forbidden/i],
  ['git gc --aggressive', /forbidden/i],
  ['git maintenance run', /forbidden/i],
  ['git worktree add ../wt feature', /worktree|read-only|forbidden/i],
  ['git tag v1.0.0', /read-only|forbidden/i],
  ['git branch new-feature', /create|read-only|forbidden/i],
  ['git branch -d old', /read-only|forbidden/i],
  ['git branch -D old', /read-only|forbidden/i],
  ['git stash', /read-only|forbidden/i],
  ['git stash pop', /read-only|forbidden/i],
  ['git remote add up https://x', /read-only|forbidden/i],
  ['git remote set-url origin https://x', /read-only|forbidden/i],
  ['git submodule update --init', /read-only|forbidden/i],
  ['git bisect start', /read-only|forbidden/i],
  ['git symbolic-ref HEAD refs/heads/x', /read-only|forbidden|writes/i],

  // Hidden inside shell composition
  ['git status && git commit -m x', /forbidden/i],
  ['git status; git push', /forbidden/i],
  ['git diff || git reset --hard', /forbidden/i],
  ['true && (cd src && git commit -m x)', /forbidden/i],
  ['echo "$(git commit -m sneaky)"', /forbidden/i],
  ['echo `git push`', /forbidden/i],
  ['bash -c "git commit -m x"', /forbidden/i],
  ["sh -c 'git push --force'", /forbidden/i],
  ['eval "git reset --hard"', /forbidden/i],
  ['xargs git add < files.txt', /forbidden/i],
  ['find . -name "*.py" -exec git add {} \\;', /forbidden/i],
  ['timeout 60 git push', /forbidden/i],
  ['nohup git push &', /forbidden/i],
  ['sudo git commit -m x', /privilege|forbidden/i],
  ['env git commit -m x', /forbidden/i],
  ['{ git commit -m x; }', /forbidden/i],

  // Repository redirection
  ['GIT_DIR=/other/.git git log', /GIT_DIR|forbidden/i],
  ['GIT_WORK_TREE=/tmp git checkout .', /forbidden/i],
  ['env GIT_DIR=/other/.git git status', /GIT_DIR|forbidden/i],
  ['GIT_INDEX_FILE=/tmp/idx git status', /GIT_INDEX_FILE|forbidden/i],
  ['git --git-dir=/other/.git log', /forbidden/i],
  ['git --work-tree=/tmp status', /forbidden/i],
  ['git -C /etc status', /outside the project/i],
  ['git -C ../../other status', /outside the project/i],
  ['git --exec-path=/tmp/evil status', /forbidden/i],
  ['git -c core.hooksPath=/tmp/h status', /forbidden/i],
  ['git -c alias.x="!rm -rf /" x', /forbidden/i],

  // .git internals
  ['rm -rf .git', /\.git/i],
  ['rm .git/index', /\.git/i],
  ['echo x > .git/config', /\.git/i],
  ['tee .git/HEAD', /\.git/i],
  ['cp evil .git/hooks/pre-commit', /\.git/i],
  ['chmod +x .git/hooks/post-checkout', /\.git/i],
  ['mv .git/config /tmp/', /\.git/i],
  ['truncate -s 0 .git/index', /\.git/i],
  ['sed -i "s/a/b/" .git/config', /\.git/i],
  ['ln -s /tmp/evil .git/hooks/pre-push', /\.git/i],

  // Unknown git subcommands fail closed
  ['git frobnicate --all', /not on the Hyperpowers read-only allowlist|denied/i],
  ['git some-plugin-command', /allowlist|denied/i],

  // Read-only subcommands with writing options
  ['git diff --output=patch.txt', /writes a file|forbidden/i],
  ['git grep -O vim TODO', /forbidden/i],

  // External VCS mutators
  ['gh pr create --fill', /mutates|allowlist/i],
  ['gh pr merge 42', /mutates|allowlist/i],
  ['gh repo create x', /mutates|allowlist/i],
  ['gh api -X POST /repos/o/r/issues', /mutates/i],
  ['gh release create v1', /mutates|allowlist/i],
  ['gh auth login', /status|allowlist/i],
  ['jj commit -m x', /allowlist|mutates/i],

  // Unparseable input fails closed
  ["git status '", /could not be parsed|denied/i],
  ['git log "unterminated', /could not be parsed|denied/i],

  // --- regressions found by adversarial probing; each of these once slipped through -------
  // Clustered shell flags: the handler matched only an exact `-c`.
  ['bash -lc "git push"', /forbidden/i],
  ['sh -xec "git commit -m x"', /forbidden/i],
  ['bash --command "git reset --hard"', /forbidden/i],
  // Partially quoted assignment: `quoted` was set for `NAME="value"`, so the assignment was
  // mistaken for the command name and the real command behind it was never classified.
  ['GIT_SSH_COMMAND="ssh -i k" git fetch', /forbidden|GIT_SSH_COMMAND/i],
  ['GIT_CONFIG_GLOBAL="/tmp/c" git status', /GIT_CONFIG_GLOBAL/i],
  ['GIT_DIR="/other/.git" git log', /GIT_DIR/i],
  // Wrapper flags that take a value left a numeric operand in the command position.
  ['nice -n 10 git push', /forbidden/i],
  ['nice -n 10 nohup timeout 5 git push', /forbidden/i],
  ['watch -n 2 git pull', /forbidden/i],
  ['ionice -c 3 git gc', /forbidden/i],
  // Wrapper backstop: a git token anywhere in a wrapper's arguments is classified.
  ['xargs -0 -I % git checkout %', /forbidden/i],

  // --- second adversarial probe; every one of these was ALLOWED before -------------------
  // `>>` sat in the operator list, so the append target became a command name rather than a
  // redirect target. The single-`>` form was denied all along.
  ['echo x >> .git/config', /\.git/i],
  ['cat foo >> .git/HEAD', /\.git/i],
  ['printf y >>.git/config', /\.git/i],
  ['echo x &>> .git/config', /\.git/i],
  // Execution contexts the classifier cannot follow, reaching the same repository.
  ['ssh localhost git commit -m x', /cannot inspect|forbidden/i],
  ['ssh localhost "cd /work/project && git commit -m x"', /cannot inspect|forbidden/i],
  ['docker exec c1 git commit -m x', /cannot inspect|forbidden/i],
  ['podman exec c1 git push', /cannot inspect|forbidden/i],
  ['kubectl exec pod -- git push', /cannot inspect|forbidden/i],
  ['tmux send-keys "git commit -m x" Enter', /cannot inspect|forbidden/i],
  ['script -q /dev/null git commit -m x', /cannot inspect|forbidden/i],
  // A command name produced by an expansion cannot be classified before it runs, and the
  // fall-through for unknown command names is ALLOW — so this was a complete bypass.
  ['G=git; $G commit -m x', /shell expansion|cannot be classified/i],
  ['G=git; ${G} commit -m x', /shell expansion|cannot be classified/i],
  ['$(echo git) commit -m x', /shell expansion|cannot be classified/i],
  ['`echo git` push', /shell expansion|cannot be classified/i],
  ['a=g; b=it; "$a$b" commit -m x', /shell expansion|cannot be classified/i],
  // Git runs its pager through a shell, so a pager variable is arbitrary code execution
  // reached through a command classified as a read.
  ['GIT_PAGER="touch /tmp/pwned" git -p log', /pager|shell/i],
  ['PAGER="touch /tmp/pwned" git -p diff', /pager|shell/i],
  ['GIT_EDITOR="touch /tmp/pwned" git status', /pager|shell/i],
  // The parser only recognised *leading* NAME=VALUE pairs as assignments.
  ['export GIT_CONFIG_GLOBAL=/tmp/evil; git status', /GIT_CONFIG_GLOBAL/i],
  ['export GIT_SSH_COMMAND="ssh -oProxyCommand=evil"; git log', /GIT_SSH_COMMAND/i],
  ['declare -x GIT_DIR=/tmp/other/.git; git status', /GIT_DIR/i],
  // macOS filesystems are case-insensitive by default, so these are the same binary and files.
  ['Git commit -m x', /forbidden/i],
  ['gIt push origin main', /forbidden/i],
  ['echo x > .GIT/config', /\.git/i],
  ['rm -rf .GIT', /\.git/i],
  // `env -S` parses and executes a whole command line.
  ['env -S "git commit -m x"', /forbidden/i],
  ['env --split-string="git push origin main"', /forbidden/i],
  // `jj op` is a family: log/show read, undo/restore rewrite history.
  ['jj op undo', /read-only/i],
  ['jj op restore abc', /read-only/i],
  // In-place edit flags may be separate rather than clustered.
  ['perl -i -pe "s/a/b/" .git/config', /\.git/i],
  // `~` is expanded by the shell, so a lexical containment check sees an in-project path.
  ['git -C ~ status', /outside the project/i],
  ['git -C ~/Desktop diff', /outside the project/i],

  // --- third probe: the classifier trusted the *name* in command position -----------------
  // Three bypasses that shared one root cause — "the word in command position IS the program".
  // Nothing verified that the name resolved to the program the policy had just validated, so
  // each returned a confident `allow` for a command that ran something else entirely. That is
  // worse than the documented opaque-script gap: there the classifier declines to see: here it
  // reported having checked what it had not checked.

  // 1. A function rebinds a name for the rest of the shell. The splitter flattened the body into
  //    ordinary commands and lost the binding, so this read as a plain `git status`.
  ['git() { command git push --force; }; git status', /shell function/i],
  ['function git { command git push; }; git status', /shell function/i],
  ['git ()  { :; }; git status', /shell function/i],
  // The body may be built at runtime, so no literal `git push` token ever appears.
  ['git() { eval "command $(echo Z2l0IHB1c2g= | base64 -d)"; }; git status', /shell function/i],

  // 2. PATH decides which binary a bare name resolves to — the same failure as GIT_DIR, one
  //    level down: not "which repository" but "which program". Planting the file is unrestricted.
  ['PATH=/tmp/evil:$PATH git status', /resolves to/i],
  ['export PATH=/tmp/evil:$PATH; git status', /resolves to/i],
  ['LD_PRELOAD=/tmp/x.so git log', /resolves to/i],
  ['DYLD_INSERT_LIBRARIES=/tmp/x.dylib git diff', /resolves to/i],
  ['BASH_ENV=/tmp/rc bash -c "git status"', /resolves to/i],

  // 3. A path-qualified VCS binary outside every standard install location cannot be the tool
  //    the policy thinks it validated.
  ['/tmp/evil/git status', /not at any standard install location/i],
  ['./git log', /not at any standard install location/i],
  ['../hack/git diff', /not at any standard install location/i],

  // --- fifth probe: the script is not the substitution, it is the substitution's output -----
  // Found during the first real pilot run, by following a *false positive* — a legitimate
  // `gate()` helper refused by the function-definition ban — back to the question underneath it:
  // what can the classifier actually see? `$G push` was already denied because the command *name*
  // came from an expansion. One level in, the same failure was open: the tokenizer lifts a
  // substitution out of its word, so `eval "$(…)"` handed `eval` an empty string, an empty script
  // classified as harmless, and the substitution itself — `echo … | base64 -d` — was inspected
  // separately and is entirely benign. Every part the classifier looked at was safe. The part that
  // would actually run was never looked at.
  ['eval "$(echo Z2l0IHB1c2g= | base64 -d)"', /assembled by a shell substitution/i],
  ['eval "$(cat payload.txt)"', /assembled by a shell substitution/i],
  ['eval `cat payload.txt`', /assembled by a shell substitution/i],
  ['sh -c "$(echo Z2l0IHB1c2g= | base64 -d)"', /assembled by a shell substitution/i],
  ['bash -lc "$(cat payload.txt)"', /assembled by a shell substitution/i],
  // Wrappers again: the first version of the stdin-as-script rule missed exactly this shape.
  ['xargs sh -c "$(cat payload.txt)"', /assembled by a shell substitution/i],
  ['nice bash -lc "$(cat payload.txt)"', /assembled by a shell substitution/i],
  // And the first version of *this* rule skipped quoted words, copying a guard from the
  // function-definition check where quoting genuinely disables the `function` keyword. It does
  // not disable a command name, so the fix reintroduced the bypass it was written to close.
  ['"eval" "$(cat payload.txt)"', /assembled by a shell substitution/i],
  ["'eval' \"$(cat payload.txt)\"", /assembled by a shell substitution/i],
  ['"sh" -c "$(cat payload.txt)"', /assembled by a shell substitution/i],

  // --- fourth probe: the first word is not always a *program* -----------------------------
  // Shell reserved words are grammar. What follows one is another command, not its argument
  // list — so `then`, `do` and `!` were read as unknown programs and fell through to allow,
  // with the entire mutation sitting in plain, unquoted, fully visible text. `! git commit` is
  // a one-token defeat of the whole policy, and the most embarrassing miss in four rounds.
  ['! git commit -m pwned', /forbidden/i],
  ['if true; then git commit -m pwned; fi', /forbidden/i],
  ['while [ -f x ]; do git push; done', /forbidden/i],
  ['until [ -f x ]; do git commit -m p; done', /forbidden/i],
  ['for i in 1; do git push origin main --force; done', /forbidden/i],
  ['for f in $(git diff --name-only); do git add "$f"; done', /forbidden/i],
  ['select x in a; do git push; done', /forbidden/i],
  ['{ git commit -m x; }', /forbidden/i],
  // The `.git` file-writer guard is keyed on the command name too, so it fell to the same gap.
  ['if true; then rm -rf .git; fi', /\.git/i],

  // `trap` registers a command string the shell runs later — for EXIT, often before this same
  // Bash call returns. The payload is an *argument*, so nothing that inspects command position
  // ever looked at it.
  ["trap 'git push origin main' EXIT; true", /forbidden/i],
  ["trap 'git commit -am pwned' DEBUG; echo hi", /forbidden/i],
  ["trap 'git reset --hard' ERR; false", /forbidden/i],

  // A shell invoked without `-c` executes what it reads on stdin. That is not the opaque script
  // this policy documents as unclassifiable — the script is right there in the string being
  // classified. This was a direct side effect of the fix that made heredoc *bodies* data: the
  // correct call for `cat <<EOF > file`, the wrong one for `bash <<EOF`.
  ["bash <<'EOF'\ngit push origin main --force\nEOF", /forbidden/i],
  ["sh <<'EOF'\ngit commit -am pwned\nEOF", /forbidden/i],
  ["bash -s <<'EOF'\ngit push\nEOF", /forbidden/i],
  ['bash <<< "git push origin main --force"', /forbidden/i],
  ['zsh <<< "git commit -am pwned"', /forbidden/i],
  // …and the first version of that fix keyed on `words[0]`, so one wrapper walked past it —
  // the same bug it was fixing, one level out.
  ['nice bash <<< "git push"', /forbidden/i],
  ['env bash <<< "git push"', /forbidden/i],
  ['timeout 5 bash <<< "git push"', /forbidden/i],
  ["nice bash <<'EOF'\ngit push\nEOF", /forbidden/i],
  ['command bash <<< "git commit -m x"', /forbidden/i],
  ['xargs bash <<< "git push"', /forbidden/i],
  // stdin is classified even with `-c` present: skipping it there would reopen the bypass.
  ["bash -c 'bash' <<< \"git push\"", /forbidden/i],
];

/** Reads that must NOT be caught by the `.git` pathspec heuristic. */
const ALLOWED_REGRESSIONS = [
  // Ordinary shell helpers, refused twice in a single live run by a blanket ban on function
  // definitions. `gate()` and `run_mut()` are verbatim what an agent wrote while running the
  // mutation tests its own work package demanded. The ban now covers only names this policy
  // validates — safe *because* the body of a function is classified, which became true only once
  // `eval "$(…)"` was closed. Narrowing before that would have opened a bypass.
  'gate() { npm run test; }; gate',
  'run_mut() { cp a b; npm test; }; run_mut',
  'helper() { echo hi; }; helper',
  // The fifth probe's controls. A substitution is only refused where its *output becomes code*;
  // used as data — an argument, a filename, an assignment — it stays ordinary work, and refusing
  // it would ban most of shell scripting to close one hole.
  'echo "$(date)"',
  'FOO=$(date) npm test',
  'cat "$(ls -t | head -1)"',
  'node -e "$(cat script.js)"',
  'python3 -c "$(cat script.py)"',
  'eval "npm run build"',
  'sh -c "npm test"',
  'git log --format="%H" -- .git',
  'git cat-file -p HEAD:.gitignore',
  'git diff -- .gitignore',
  'nice -n 10 git status',
  'bash -lc "git status"',
  'GIT_PAGER=cat git log -5',

  // Real git at a real install location stays usable — the identity check must not become a ban
  // on absolute paths.
  '/usr/bin/git status',
  '/opt/homebrew/bin/git log -3',
  '/usr/local/bin/git diff --stat',
  // Only the command word is identity-checked; `git` appearing in an argument is just text.
  'node ./tools/git/index.js',
  'ls ./vendor/git',

  // --- false positives found by the same probe, each of which blocked legitimate work ------
  // Reads the remote's refs; unlike `fetch` it writes nothing locally.
  'git ls-remote origin',
  'git ls-remote --heads origin',
  // One operand reads a ref; two would write one, and only that form is denied.
  'git symbolic-ref HEAD',
  'git symbolic-ref -q --short HEAD',
  // A heredoc body is text. Tokenizing it as code refused any script or template whose
  // content merely mentions a git command, and an unmatched quote inside a body made the
  // whole command "unparseable", which fails closed.
  "cat <<'EOF' > release.sh\n#!/bin/bash\ngit commit -m release\ngit push\nEOF",
  'cat <<EOF\nit\'s fine to have an apostrophe here\nEOF',
  'cat <<-EOF > notes.md\n\tgit reset --hard is documented here\n\tEOF',
  // Running a test suite in a container is ordinary work, not a Git operation.
  'docker exec api pytest -q',
  'kubectl exec pod -- ls /app',
  'ssh buildbox "npm test"',
  // Descriptor duplication has no path operand.
  'git status 2>&1',
  'git diff --stat 2>/dev/null',
  // Reads whose command word contains an expansion in an *argument*, not in command position.
  'echo "$(git rev-parse HEAD)"',
  'git diff "$BASE"',

  // --- false positives from the fourth probe, each an everyday read ------------------------
  // `positionalsRequire` matched the literal `--list` only, and fired on *any* positional —
  // including the operand a read-only flag requires. The rule contradicted itself: its own
  // `requireAnyFlag` names `--contains`/`--points-at`/`--merged` as the read-only forms, and it
  // then denied the command the moment it was given the argument that makes it useful. Every
  // positional-bearing row above happened to use the literal `--list`, which is exactly why
  // this survived four rounds.
  "git tag -l 'v1.*'",
  "git branch -l 'feature/*'",
  'git tag --contains HEAD',
  'git tag --points-at HEAD',
  'git tag --merged main',
  'git branch --contains HEAD',
  'git branch --merged main',
  'git branch --no-merged main',
  'git branch -a --contains abc123',
  'git branch --contains=HEAD',
  // Reserved words around ordinary work must stay out of the way.
  'if true; then npm test; fi',
  'for f in src/*.py; do python -m py_compile "$f"; done',
  'while read l; do echo "$l"; done < in.txt',
  'if git diff --quiet; then echo clean; fi',
  // A heredoc written to a *file* is still data, even when its body mentions git.
  "cat <<'EOF' > release.sh\n#!/bin/bash\ngit commit -m release\nEOF",
  // A non-shell command receiving a heredoc is not executing it as a script.
  "python3 - <<'EOF'\nprint('git push')\nEOF",
  // A shell script on stdin that mutates nothing is ordinary work.
  'bash <<< "npm test"',
  'nice bash <<< "pytest -q"',
];

describe('git policy — allowed commands', () => {
  for (const cmd of [...ALLOWED, ...ALLOWED_REGRESSIONS]) {
    test(`allows: ${cmd}`, () => {
      const verdict = classifyCommand(cmd, CTX);
      assert.equal(
        verdict.decision,
        'allow',
        `expected allow but got deny: ${verdict.reason}`,
      );
    });
  }
});

describe('git policy — denied commands', () => {
  for (const [cmd, pattern] of DENIED) {
    test(`denies: ${cmd}`, () => {
      const verdict = classifyCommand(cmd, CTX);
      assert.equal(verdict.decision, 'deny', `expected deny but the command was allowed`);
      assert.match(verdict.reason, pattern);
    });
  }
});

describe('shell parser', () => {
  test('splits on all control operators', () => {
    const { commands } = splitCommands('a; b && c || d | e & f');
    assert.deepEqual(commands.map((c) => c.argv[0].text), ['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('single quotes are literal', () => {
    const { commands } = splitCommands("echo 'git commit -m x'");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].argv[1].text, 'git commit -m x');
    assert.equal(commands[0].argv[1].quoted, true);
  });

  test('command substitution is surfaced separately', () => {
    const { nested } = splitCommands('echo "$(git rev-parse HEAD)"');
    assert.deepEqual(nested, ['git rev-parse HEAD']);
  });

  test('backtick substitution is surfaced', () => {
    const { nested } = splitCommands('echo `git status`');
    assert.deepEqual(nested, ['git status']);
  });

  test('leading assignments are separated from argv', () => {
    const { commands } = splitCommands('FOO=1 BAR=2 git status');
    assert.deepEqual(commands[0].assignments, { FOO: '1', BAR: '2' });
    assert.equal(commands[0].argv[0].text, 'git');
  });

  test('redirect targets are captured, not treated as commands', () => {
    const { commands } = splitCommands('echo hi > out.txt');
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].redirects.map((r) => r.text), ['out.txt']);
  });

  test('unterminated quotes are reported', () => {
    assert.ok(tokenize("echo 'oops").unparseable);
    assert.ok(tokenize('echo "oops').unparseable);
    assert.ok(tokenize('echo $(oops').unparseable);
  });

  test('nested substitution is extracted', () => {
    const { nested } = splitCommands('echo $(echo $(git push))');
    assert.equal(nested.length, 1);
    assert.match(nested[0], /git push/);
  });
});

describe('touchesGitInternals', () => {
  const yes = ['.git', '.git/config', './.git/HEAD', 'a/.git/x', '/abs/.git', 'a\\.git\\x'];
  const no = ['.gitignore', 'src/.gitkeep', 'gitconfig', 'my.git.txt', 'digit/x'];
  for (const p of yes) test(`detects ${p}`, () => assert.equal(touchesGitInternals(p), true));
  for (const p of no) test(`ignores ${p}`, () => assert.equal(touchesGitInternals(p), false));
});

/**
 * The README and the validation ledger both quote the size of this table. That number has now
 * gone stale three times across three rounds of work — each time in the direction that
 * understated the table, which is the harmless direction but still a documented claim that was
 * false. A count nobody checks is a count that drifts, and this file is the only thing that
 * knows the real one.
 *
 * Two checks, because the first one alone already failed once. The anchored patterns prove the
 * documented sentence is still there and still right; they cannot see a *second* mention in the
 * same file, and that is exactly how `249` survived in ADR-0003 while the bolded count beside it
 * was updated. The sweep catches any number near the word "case" that is neither the current
 * count nor one of the historical figures the prose deliberately quotes.
 */
const COUNT_DOCS = ['README.md', 'docs/validation-ledger.md', 'docs/adr/0003-git-prevention-and-detection.md'];

describe('the documented case count matches this table', () => {
  const CASES = ALLOWED.length + ALLOWED_REGRESSIONS.length + DENIED.length;
  const readDoc = (file) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');

  for (const [file, pattern] of [
    ['README.md', /(\d+)-case conformance table/],
    ['docs/validation-ledger.md', /`npm test`: (\d+) Git-policy conformance cases/],
    ['docs/adr/0003-git-prevention-and-detection.md', /It now holds \*\*(\d+)\*\* cases/],
  ]) {
    test(`${file} quotes ${CASES}`, () => {
      const text = readDoc(file);
      const match = pattern.exec(text);
      assert.ok(match, `${file} no longer states the conformance-table size in the expected form`);
      assert.equal(
        Number(match[1]), CASES,
        `${file} says ${match[1]} cases; the table holds ${CASES}. Update the prose, not this test.`,
      );
    });
  }

  // Figures the prose quotes on purpose: the table's first-draft size, and the count of cases the
  // second probe contributed. Anything else near "case"/"cases" is a stale count until proven not.
  const HISTORICAL = new Set([171, 29]);

  for (const file of COUNT_DOCS) {
    test(`${file} states no other case count`, () => {
      const text = readDoc(file);
      const stale = [];
      for (const m of text.matchAll(/(\d{2,4})(?=[^\n]{0,40}?\bcases?\b)/g)) {
        const n = Number(m[1]);
        if (n === CASES || HISTORICAL.has(n)) continue;
        stale.push(`line ${text.slice(0, m.index).split('\n').length}: "${n}"`);
      }
      assert.deepEqual(
        stale, [],
        `${file} states a case count that is neither ${CASES} nor a deliberately historical one `
        + `(${[...HISTORICAL].join(', ')}): ${stale.join('; ')}`,
      );
    });
  }
});
