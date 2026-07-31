---
name: resume
description: Resume a suspended or interrupted Hyperpowers run in a fresh turn, restoring director authority
disable-model-invocation: true
---

# Resume a Hyperpowers run

You are the **main thread**, not the director. Your whole job here is three steps, in this order:
restore the run, put a director on it, then relay. The order matters — a director dispatched
before the run is rebound to this session is invisible to every hook, so for the whole of that
dispatch nothing governs it (§S40's gap, reopened).

## 1. See what there is to resume

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-machine.mjs" show
```

That reports the phase, its owner, what is blocking the exit, and the next action. Everything the
run needs is on disk — `state.json`, `request.md`, `design.md`, `plan.md`, `tasks.json`,
`evidence.json`, `reviews/` — which is exactly why resuming works at all. A run in `COMPLETE`,
`BLOCKED`, `ABORTED` or `POLICY_VIOLATION` is finished: report its outcome and offer to start a
new run rather than reanimating a terminal one.

## 2. Restore the run — before any dispatch

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/resume-run.mjs" --run <RUN_ID> --session "$CLAUDE_CODE_SESSION_ID"
```

Pass `--session` explicitly. This rebinds the session→run pointer the hooks act on, restores the
phase a `SUSPENDED` run yielded from, re-stamps the Git baseline, and — when the run is being
adopted from a dead session — releases the one-director rule so the dispatch in step 3 is not
refused.

## 3. Put a director on it

One `Agent` call, `subagent_type: hyperpowers:hyperpowers-director`, telling it to resume run
`<RUN_ID>`. Its tier is secured by that dispatch and verified by the machine's own checks, not by
anything this file declares. The director reads its run directory and carries on; you do not do
any of its work yourself.

Then relay, exactly as `/hyperpowers:feature` does: render its question packets with
`AskUserQuestion` and record replies with `state-machine.mjs answer`; publish its
`publish-request` with the `Artifact` tool and record the URL with `state-machine.mjs published`.
When a relay message names a director agent id, prefer resuming it (`SendMessage`) over
dispatching a fresh one — a cold dispatch re-reads everything the live agent already holds, which
is the measured cost driver (§T2).

## Tell the director to check for drift

The world may have changed while the run was stopped. The dispatch prompt should tell the
director to verify, before continuing: the files its work packages own still exist with the shape
the plan assumed; nobody moved the repository underneath the run (`git status`,
`git log --oneline -5` — read-only); the evidence is still valid. If the premises have shifted
materially, the director re-plans rather than continuing on stale assumptions — resuming into a
changed world is the main way a resumed run produces confidently wrong work.
