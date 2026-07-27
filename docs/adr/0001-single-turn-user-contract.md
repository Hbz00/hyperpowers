# ADR-0001 — The whole run happens inside one turn

**Status:** accepted · **Date:** 2026-07-26

## Context

The spec (§10, §11) has the director stop at `WAITING_FOR_USER` during brainstorming, take the
user's replies over several messages, and then proceed autonomously. The director's model is
pinned by the `/hyperpowers:feature` skill's `model: fable` frontmatter.

Measurement showed that pin does not survive what the spec assumes. Running a project skill that
pins `model: haiku` in a session defaulting to Sonnet, in one continuous process:

```
assistant model = claude-sonnet-5   'T1'            <- plain message
assistant model = claude-haiku-4-5  'PROBE_TURN_1'  <- the skill turn
assistant model = claude-sonnet-5   'T3'            <- next plain message: REVERTED
```

The pin is cleared when the user sends a message — the same lifetime the harness documents for
`disallowed-tools` ("Cleared when the user sends the next message").

A second measurement changed the picture. With a Stop hook returning
`{"decision":"block","reason":…}`:

```
assistant model = claude-haiku-4-5  'PROBE_TURN_1'
assistant model = claude-haiku-4-5  'SKILLCONT_1'   <- forced continuation
assistant model = claude-haiku-4-5  'SKILLCONT_2'   <- forced continuation
```

A Stop-hook-forced continuation is **not** "the user sending a message". The pin survives it.

So the spec's `WAITING_FOR_USER` state is a latent model-inversion bug: any free-text reply
mid-run silently demotes the director from Fable to the session default, and the run would
continue producing plausible output from the wrong tier — the failure would not announce
itself.

## Decision

The entire run occupies **one turn**.

1. `WAITING_FOR_USER` is removed. All user interaction uses `AskUserQuestion`, which is a tool
   call and therefore keeps the turn — and the pin — alive. It supports multiple calls and
   free-text "Other", so a real dialogue is still possible.
2. The Stop hook drives every phase transition by blocking with the next action.
3. `SUSPENDED` is added. The harness caps consecutive Stop-hook blocks (measured: 8 by default,
   raised by `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). The controller yields a few blocks *below* the
   cap, recording a resumable state, rather than being truncated mid-phase.
4. `/hyperpowers:resume` is a separate skill that also pins `model: fable`, re-establishing
   director authority in a fresh turn.

## Consequences

**Good.** The director provably stays Fable for the whole run. There is exactly one user
message per run, so the pin cannot be cleared accidentally. Recovery after a suspension is
explicit and re-pins correctly. The run is verifiable: the transcript records the model of every
message, so the Stop controller checks the observed director model against the configured one
and reports a mismatch.

**Costs.** Brainstorming loses free-form multi-message conversation; it becomes structured
questions with free-text escape hatches. For a workflow whose entire premise is autonomy after
intake, this is a small loss — arguably an improvement, since it forces the questions to be
specific.

The block cap must be large (default 200). That is not the real safety mechanism and is not
treated as one: progress detection, circuit breakers and budget bounds are, exactly as spec
§16.2 itself argues ("Il ne suffira pas d'augmenter le plafond").

## Alternatives rejected

**Main-thread agent** (settings `agent:` key + `initialPrompt`) would make Fable durable across
user messages. Rejected for v1: it requires a session restart, replaces the system prompt and
tool set wholesale, and makes Hyperpowers a session mode rather than a command. Worth
revisiting if multi-message dialogue proves necessary.

**Accept the demotion and re-pin on resume.** Rejected: the demotion is silent, and the run
would have continued through design decisions on the wrong tier before anyone noticed.
