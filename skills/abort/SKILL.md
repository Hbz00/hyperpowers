---
name: abort
description: Stop a running Hyperpowers run and release the session
disable-model-invocation: true
model: inherit
---

# Abort a Hyperpowers run

While a run is active its Stop hook blocks every attempt to end the turn, and a new session
re-binds an unfinished run. This is the way out.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-machine.mjs" abort --reason "<why the user is stopping it>"
```

Add `--run <id>` to target a specific run; otherwise the run bound to this session is used.

## What aborting does and does not do

It marks the run `ABORTED` and releases the session. The Stop hook stops blocking immediately.

It does **not** undo anything. Two separate reasons:

- Hyperpowers never mutated the repository — Git is read-only for the whole run — so there is
  nothing to revert there.
- Files written into the working tree by implementers stay exactly as they are. Deciding what to
  keep is the user's call, not a cleanup step, and the user has Git available to inspect and
  discard as they see fit.

Every artefact stays on disk: the design, the plan, the reviews, the adjudications and the
evidence. `/hyperpowers:status --run <id>` still works afterwards, so an aborted run remains
useful — often the design and the review findings are the most valuable part.

## Before aborting

Tell the user what they are giving up, in one line: which phase it reached, how many of the six
reviews completed, and whether any work packages were accepted. If the run is close to a gate,
say so — resuming may be cheaper than restarting.

If they want to pause rather than stop, that is different: leave the run alone and let it
suspend, or point them at `/hyperpowers:resume` later. Aborting is not reversible.
