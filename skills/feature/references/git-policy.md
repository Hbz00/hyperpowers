# Git policy

```
Reading Git is allowed. Mutating Git is forbidden.
```

The user performs every Git operation themselves. This is enforced by a `PreToolUse` hook, not
by prompt discipline — a guarantee that depends on a model remembering it is not a guarantee.

## Scope: a run, not an installation

The policy is in force **while a Hyperpowers run owns the session**, and not otherwise. Install
the plugin and your own Git keeps working; start a run and it goes read-only; abort or finish
the run and it is handed straight back. Set `git: { enforce: "always" }` in `.hyperpowers.json`
if you would rather the project were read-only Git all the time.

## Allowed

`git status`, `git diff` (and `--stat`, `--name-only`, `--cached`), `git log`, `git show`,
`git ls-files`, `git ls-tree`, `git rev-parse`, `git rev-list`, `git merge-base`,
`git cat-file`, `git grep`, `git blame`, `git describe`, `git shortlog`, `git for-each-ref`,
`git diff-tree`/`-index`/`-files`, `git check-ignore`, `git check-attr`, `git count-objects`,
`git show-ref`, `git branch --show-current` / `--list`, `git remote -v` / `show` / `get-url`,
`git stash list` / `show`, `git reflog show`, `git worktree list`, `git submodule status`,
`git ls-remote`, `git symbolic-ref HEAD`, and the listing forms of `git tag` / `git branch` —
including `-l`, `--contains`, `--points-at`, `--merged` and `--no-merged` with their operands.

## Blocked

`add`, `commit`, `checkout`, `switch`, `restore`, `reset`, `merge`, `rebase`, `cherry-pick`,
`revert`, `stash` (except list/show), `clean`, branch creation and deletion, `tag` creation,
`push`, `pull`, `fetch`, `worktree add/remove`, `init`, `clone`, `apply`, `am`, `update-index`,
`update-ref`, `config`, `gc`, `maintenance`, `filter-branch`, `archive`, `bundle`.

`fetch` is blocked even though it does not touch the working tree: it rewrites local refs.

Also blocked: any write into `.git/` (case-insensitively, and through `>` *and* `>>`); `git -C`
pointing outside the project, including via `~`; `--git-dir`, `--work-tree`, `--exec-path`,
`-c`, `--config-env`; `GIT_DIR`, `GIT_WORK_TREE`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*` and similar
environment redirection, whether written as a leading assignment or via `export`/`declare`;
pager and editor variables (`GIT_PAGER`, `PAGER`, `EDITOR`, …) set to anything but `cat`, since
git runs them through a shell; `sudo`/`doas`; mutating `gh` or `jj` subcommands, including
`jj op undo`.

Rebinding a name this policy validates is blocked — `git() { … }`, `function sh { … }`,
`eval() { … }`. A function replaces the name for the rest of the shell, so every later use runs the
body instead of the program that was checked. Helpers under *other* names are fine
(`gate() { npm test; }`), because a function body is decomposed and classified like any other
command; it is only the name that a body check cannot see.

Also blocked, because the mutating command is fully visible in the string and the classifier has
no excuse for missing it: a script assembled by a substitution and then executed
(`eval "$(cat payload)"`, `sh -c "$(… | base64 -d)"`) — the substitution is inspected and found
harmless, and its *output* is what runs; a command hidden behind shell grammar (`! git commit`,
`if …; then git commit; fi`, any loop body), a command registered for later with
`trap '…' EXIT`, and a script fed to a shell on stdin (`bash <<'EOF' … EOF`,
`bash <<< "…"`). A heredoc written to a *file* stays data — `cat <<EOF > release.sh` whose body
mentions `git commit` is a text file, not an execution.

Two further categories are blocked for what they *could* be rather than what they say:

- **A command name produced by a shell expansion** — `$G commit`, `` `echo git` push ``. The
  classifier never evaluates expansions, so it cannot know what will run, and §14.4 says
  what cannot be classified is denied. Write the command out literally.
- **Execution somewhere the classifier cannot follow** that mentions a VCS binary — `ssh`,
  `docker exec`, `kubectl exec`, `tmux send-keys`, `script`. `ssh localhost git commit` reaches
  the very repository the policy protects. Running a test suite in a container is unaffected.

## How it is enforced

The hook decomposes the command rather than pattern-matching it — chains, pipes, subshells,
command substitution, backticks, `eval`, `sh -c` (including clustered flags like `bash -lc`),
`xargs`, `find -exec`, wrapper commands and leading environment assignments are all analysed.
It is an **allowlist**: an unknown git subcommand or an unrecognised option is denied, and a
command that cannot be parsed is denied. See `tests/git-policy.test.mjs` for the full
conformance table — every case there is a claim you can falsify by running it.

## The limit, stated honestly

Static classification cannot see inside an opaque script. `npm run release`, `./deploy.sh` or
`make publish` might call `git commit`, and no analysis of the Bash command reveals it.

So prevention is paired with detection: a `PostToolUse` guard fingerprints HEAD, the current
branch, the ref set, the index (including the *content* staged, not only the paths), the stash
and the local Git config after every Bash call.

Drift comes in two kinds, and the guard says which it saw:

- **Escalating** — HEAD, the branch, the ref set, the stash, or what is staged. Nothing ordinary
  produces these during a read-only run. Recorded as a policy violation, surfaced immediately,
  and fails spec §13 condition 11 at the completion gate.
- **Observed** — the local config. Recorded, named to the model at once, printed in the final
  report, and never used to fail the run. A *cold* `npm install` in any project using husky or
  lefthook sets `core.hooksPath`, so escalating this would end healthy runs for tooling doing its
  job, and a guard that does that is a guard people switch off. Filtering by key would not help:
  `core.hooksPath` is at once the benign case and the most direct hijack there is. What detection
  can honestly offer here is visibility; prevention keeps its own line, since both `git config`
  and writes into `.git/` are refused before they execute.

Detection is scoped exactly like prevention: it watches while a run owns the session and stops
the moment the run suspends or ends. A run that has handed Git back and then records your commit
as a violation is not being careful, it is being wrong — and since the run log is append-only, it
would be wrong for the rest of the run. Resuming re-establishes a fresh baseline rather than
attributing everything that happened while the run was stopped to the run.

Only *detected drift* fails the gate. An attempt this policy refused before it ran is recorded
separately, as a blocked attempt, and never fails the run — the control worked. So a denial is
information, not damage: read it, take the other route, and carry on.

The guard reports; it never tries to undo anything. Reverting would itself be a Git mutation,
and guessing at recovery on someone's repository is more dangerous than reporting clearly.

### What detection cannot see either

Stated for the same reason as the paragraph above — a control that overstates its coverage is
worse than one that states its boundary:

- **A push with no local remote-tracking ref** changes nothing locally, so there is nothing to
  detect. A push to a normally-configured remote *is* caught, because git updates
  `refs/remotes/*` on success and the whole ref set is hashed. This was measured rather than
  reasoned: an adversarial probe pushed to a throwaway ad-hoc remote and confirmed that none of
  HEAD, the ref set, the index or the stash moved, then repeated it against a tracked remote and
  confirmed the ref hash changed. So the uncaught case is exactly the one an exfiltration would
  use — a one-shot push to a literal URL this repository does not track. *Configuring* such a
  remote first is caught, since the local config is hashed; it is the anonymous, single-command
  form that leaves no local trace. Prevention is the only line here, which is why the classifier
  denies `git push` in every form it can decompose, and why the categories above exist.
- **Local config changes** are seen but never escalated, for the reason given above. They are in
  the run record and the final report; they are not in condition 11.
- **An index file rewritten with identical staged content** is not tracked at all. Every read
  refreshes the index, including the guard's own fingerprinting, so recording it would fire
  constantly on a run that only reads and bury a real violation in the noise.

## What this policy does *not* govern

Two of the duties spec §16.5 lists for the PreToolUse hook are not implemented here, and that is
a deliberate boundary rather than an oversight:

- **General destructive-command limits.** `rm -rf` outside `.git/` is not blocked. Hyperpowers
  governs *Git* state; file destruction is what Claude Code's own permission system, and your
  approval of each command, exist for. A second half-built permission layer would mostly create
  the false impression that one is in force.
- **Allowed-path confinement.** Nothing here restricts Bash, Write or Edit to the project root,
  except that writes into any `.git/` directory are refused. Use Claude Code's permission rules
  if you want a hard workspace boundary.

Both are reachable through the same `.claude/settings.json` that `/hyperpowers:setup` writes, so
adding them is a configuration decision you can make deliberately — not something this plugin
quietly claims to have done for you.
