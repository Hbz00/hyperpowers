# ADR-0003 — Pair Git prevention with detection, and say what neither can do

**Status:** accepted · **Date:** 2026-07-26

## Context

Spec §14 requires reads allowed, mutations forbidden, and §14.4 is explicit that a regex is
insufficient: the hook must decompose commands and refuse anything it cannot classify safely.

## Decision

**Prevention** — an allowlist classifier over a real shell splitter. It handles chains, pipes,
subshells, command substitution, backticks, `eval`, `sh -c` (including clustered flags like
`bash -lc`), `xargs`, `find -exec`, wrapper commands, leading environment assignments and
redirection targets. Unknown git subcommands, unrecognised options and unparseable input are
all denied.

**Detection** — a `PostToolUse` guard fingerprints HEAD, the branch, the ref set, the staged
*content*, the stash and the local config after every Bash call, and records any drift as a
policy violation that fails spec §13 condition 11.

Two of those fields were added after the fact and are worth naming, because their absence was
invisible in exactly the way this ADR warns about. The index was hashed by path and status, so
re-staging different content under an unchanged path moved nothing. The local config was not
watched at all, so a repointed remote or a rewritten `hooksPath` — neither of which moves HEAD,
refs, index or stash — passed unseen. Both are content the guard claimed to be watching.

**Not all drift escalates, and the split is measured rather than preferred.** Config drift is
recorded and reported but never fails condition 11: a *cold* `npm install` in any project using
husky or lefthook sets `core.hooksPath`, which would have ended healthy runs for a package manager
doing its job. Narrowing the hashed keys is not an escape — `core.hooksPath` is simultaneously the
benign case and the most direct hijack — so the honest position is visibility here and prevention
as the enforcing line.

A third category exists and is worth naming because it was mishandled twice in opposite
directions. An index file rewritten with identical staged content is now **not tracked at all**.
The original code computed it, filtered it out of the only list it wrote, and described that as
"recorded but never escalated" — recording it nowhere. Correcting that literally, by recording it,
turned out to be worse: ordinary reads refresh the index, the guard's own fingerprinting among
them, so twelve read cycles produced five records. A signal a guard generates itself is not
evidence about anything, and burying a real violation under it is the same failure as missing one.

**Detection is scoped exactly like prevention.** Both read `stopAllowed`, so a suspended or
finished run stops fingerprinting at the same moment it stops denying. They disagreed once, and
the asymmetry was worse than either behaviour alone: the policy invited the user to use Git, and
the guard recorded them doing it as a violation that the append-only run log could never retract.

**Honesty** — the limit is documented rather than papered over.

## Why both

Static classification cannot see inside `npm run release`, `./deploy.sh` or `make publish`. No
analysis of the Bash command reveals whether the script calls `git commit`. Claiming prevention
covers this would be false, and a security control that overstates its coverage is worse than
one that states its boundary.

Detection cannot prevent, but it makes the violation visible immediately and consequential at
the gate.

## Why the guard does not revert

Reverting is itself a Git mutation, and guessing at recovery on someone's repository is more
dangerous than reporting clearly. The guard reports and lets the run fail its gate.

## What testing changed

The conformance table (`tests/git-policy.test.mjs`) was written first — 171 cases at the time —
then probed with adversarial inputs *outside* the table. It now holds **293** cases, having grown
by exactly the defects five successive probe rounds found. That first probe found three real
holes:

1. `bash -lc "git push"` was **allowed** — the handler matched an exact `-c` and missed
   clustered short flags.
2. `GIT_SSH_COMMAND="ssh -i k" git fetch` was **allowed** — the parser marked any partially
   quoted word as "quoted" and therefore not an assignment, so the whole command was read as one
   opaque word and the `git fetch` behind it was never classified. This was the most serious of
   the three.
3. `nice -n 10 git push` was **allowed** — wrapper flag-stripping did not know `-n` takes a
   value, leaving `10` in the command position.

All three are now permanent regression cases, and wrappers gained a backstop that classifies any
bare `git` token appearing later in their arguments.

The lesson is recorded because it generalises: a passing conformance table proves the cases you
thought of. Adversarial probing outside the table is what finds the rest.

## What a second probe changed

A later audit ran the same exercise again, from scratch, against the enlarged table. It found
**26 more bypasses and three false positives** — which is the strongest possible confirmation of
the lesson above, and a caution against reading a green table as coverage.

The bypasses fell into six kinds, and the kinds matter more than the instances:

1. **Execution the classifier cannot follow.** `ssh localhost git commit` reaches the same
   repository over loopback; so do `docker exec`, `kubectl exec`, `tmux send-keys` and `script`.
   Unlike an opaque `./deploy.sh`, the payload *is* visible — it was simply never inspected.
2. **The command name itself was unclassifiable.** `G=git; $G commit` worked because unknown
   command names fell through to ALLOW. That inverted the policy's stated invariant precisely
   where it mattered most: `git` is denied, but *anything the classifier does not recognise* was
   permitted. Expansion in command position is now a denial.
3. **A whitelisted variable that executes code.** `GIT_PAGER` was on the allowlist, and git runs
   its pager through a shell — so `GIT_PAGER="touch /tmp/x" git -p log` was arbitrary code
   execution reached through a command classified as a *read*. `PAGER` was not checked at all.
4. **Assignments that were not leading assignments.** `export GIT_DIR=…; git status` — the
   parser only recognised `NAME=VALUE` before a command word, and `export` is a command word.
5. **Case.** The default macOS filesystem is case-insensitive, so `Git commit` and `.GIT/config`
   were the same binary and the same file as the forms being denied.
6. **A redirect operator in the wrong list.** `>>` sat in the command-separator list, so the
   append target became a command name: `echo x >> .git/config` was allowed while
   `echo x > .git/config` was denied.

The false positives are worth as much as the bypasses, because a control that refuses real work
gets disabled. A heredoc body was tokenized as code, so writing a release script whose text
merely *mentions* `git commit` was refused — and a body containing an apostrophe made the whole
command "unparseable", which fails closed. `git ls-remote` and `git symbolic-ref HEAD` are pure
reads and were refused too.

All 29 are now permanent cases in the table.

## What a third probe changed — and the assumption underneath all of them

A third independent round found three more, and unlike the earlier batches these shared a single
root cause worth naming, because it was an assumption the design never stated: **the classifier
treated the word in command position as the identity of the program.** Nothing verified that the
name resolved to the binary it had just validated.

1. **A shell function rebinds a name.** `git() { command git push --force; }; git status` was
   allowed. The splitter flattens a function body into ordinary commands, which is safe for
   chains but loses the thing that matters here — the definition binds a *name* for the rest of
   the shell, so every later `git` runs the body. The payload need not even be literal: built at
   runtime from `base64 -d`, no `git push` token exists for any scanner to find.
2. **`PATH=` chooses the binary.** `PATH=/tmp/evil:$PATH git status` was allowed. This is the
   `GIT_DIR` failure one level down — not "which repository" but "which program" — and writing
   the shadow binary is unrestricted, since the file guard defends only `.git/`.
3. **A path-qualified impostor.** `/tmp/evil/git status` was allowed on the strength of its
   basename.

Function definitions are now denied outright, `PATH` and its loader cousins join the forbidden
environment variables, and a VCS binary named by a path outside standard install locations is
refused.

The distinction that makes these worth fixing rather than filing under the documented
opaque-script limit: an unknown script falls through **unclassified**, and this policy says so.
These returned a confident `allow`. A control may decline to see something; it must not report
having checked what it did not check.

The honest reading is still not "the policy is complete now" — three rounds of probing have each
found holes the previous round's fixes did not generalise to, which is the strongest available
evidence that a fourth would too. Static classification of a shell is an open-ended problem. That
is exactly why prevention is paired with detection, why the limits are stated rather than papered
over, and why a green table is evidence about the cases someone thought of and nothing more.

## The fourth probe, which proved that prediction the same day

It found the worst set yet, and they rhyme with the third: where round three's bypasses assumed
the first word *was* the program, round four's assume the first word is *a* program at all.

1. **Shell reserved words are grammar, not commands.** `then`, `do`, `!`, `while`, `for` and
   friends were classified as unknown *programs*; matching no category, they fell through to
   `ALLOW`, and everything after them — the actual command — was never looked at. `! git commit`
   is a one-token defeat of the entire policy. `if true; then rm -rf .git; fi` also slipped the
   `.git` file-writer guard, which is keyed on the same first word.
2. **`trap 'git push' EXIT`** registers a command string the shell runs later — for `EXIT`, often
   before the same Bash call returns. The payload is an *argument*, so nothing that inspects
   command position saw it.
3. **A shell reading a script from stdin.** `bash <<'EOF' … git push … EOF` and
   `bash <<< "git push"` were allowed, because a shell without `-c` was treated as running an
   opaque script. This one is a direct side effect of the previous round's fix: making heredoc
   bodies *data* is right for `cat <<EOF > file` and wrong for `bash <<EOF`, and the fix did not
   distinguish them.

Reserved words are now stripped and what follows is classified; `trap`'s argument is classified
like `eval`'s; and stdin text reaching a shell binary is classified as the script it is.

The same probe found the largest false-positive cluster to date, which matters as much: the
`branch`/`tag` listing rule matched the literal `--list` and fired on *any* positional, so
`git tag -l 'v1.*'`, `git branch --contains HEAD` and `git branch --merged main` were all denied
— everyday reads, and the rule contradicted its own `requireAnyFlag` list. Every positional-
bearing row in the table happened to use `--list`, which is exactly why four rounds missed it.

**Four rounds, four sets of holes, each invisible to the round before it.** The table has grown
from 171 cases to 293, and every case added after the first draft is a defect that shipped. The
useful conclusion is not about shells: it is that *the fixes are the least-reviewed code here*,
written after each round's scrutiny is spent and shipped without passing through the process that
found what they fix. Round four's third bypass was created by round three's fix. Probe the fixes
first.
