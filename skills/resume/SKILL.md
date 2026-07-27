---
name: resume
description: Resume a suspended or interrupted Hyperpowers run in a fresh turn, restoring director authority
disable-model-invocation: true
model: fable
effort: high
---

# Resume a Hyperpowers run

You are the director again. This skill re-pins your model, which is the actual reason it must be
invoked by the user rather than continued automatically: a skill's model pin is cleared when the
user sends a message, so the run needs a fresh pinned turn to carry on with the right authority
(see `docs/validation-ledger.md` §B1).

## Restore the run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-machine.mjs" show
```

That reports the phase, its owner, what is blocking the exit, and the next action. Everything
the run needs is on disk — `state.json`, `request.md`, `design.md`, `plan.md`, `tasks.json`,
`evidence.json`, `reviews/`. Nothing depends on the previous conversation, which is exactly why
resuming works at all.

Read the artefacts for the phase you are in. Do not re-derive decisions already recorded in
`state.json` history, and do not restart a phase that already satisfies its exit requirements.

If the run is `SUSPENDED`, rebind and continue:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/resume-run.mjs" --run <RUN_ID>
```

Then carry on exactly as `/hyperpowers:feature` describes — same rules, same delegation, same
gates, same single-turn contract. Use `AskUserQuestion` if you genuinely need the user; never
end the turn to wait.

## Before continuing, check for drift

The world may have changed while the run was stopped. Cheap checks that prevent expensive
mistakes:

- Do the files the current work packages own still exist, with the shape the plan assumed?
- Did anyone commit, switch branch or otherwise move the repository underneath the run?
  (`git status`, `git log --oneline -5`, `git branch --show-current` — all read-only.)
- Is the evidence still valid, or do the suites need re-running?

If the premises have shifted materially, say so and re-plan rather than continuing on stale
assumptions. Resuming into a changed world is the main way a resumed run produces confidently
wrong work.

## If the run cannot be resumed

A run in `COMPLETE`, `BLOCKED`, `ABORTED` or `POLICY_VIOLATION` is finished. Report its outcome
and offer to start a new run rather than reanimating a terminal one.
