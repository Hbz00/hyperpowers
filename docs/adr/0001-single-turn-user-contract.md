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
treated as one: progress detection and the circuit breakers are, exactly as spec §16.2 itself
argues ("Il ne suffira pas d'augmenter le plafond"). Budget bounds were on that list until they
were removed — see ledger §S1: the phase they transitioned to was terminal and unresumable, so
they ended runs rather than bounding them.

## Alternatives rejected

**Main-thread agent** (`--agent`, or the settings `agent:` key) would make Fable durable across
user messages. Rejected for v1: it requires a session restart, replaces the system prompt and
tool set wholesale, and makes Hyperpowers a session mode rather than a command. Worth
revisiting if multi-message dialogue proves necessary.

## Amendment — 2026-07-28: the rejected alternative is now the supported path

The rejection above was made before anyone had measured it, and two of its three reasons did not
survive contact (§Q16):

- The tool set is **not** replaced wholesale. Omitting `tools:` inherits the full session toolset.
- "A session mode rather than a command" was the real objection, and its cost had already been
  paid: the README told the user to start their session on the Fable model. `--agent` replaces a
  launch requirement that was *unverifiable and silently violated* with one the harness enforces —
  a mistyped agent name refuses to start.

What decided it was T4. A main-session agent's `model:` pin **survives a user message**, where a
skill's is cleared. The measured cost of the old arrangement was two four-hour runs directed by
Opus while every gate, dispatch and hook behaved perfectly.

So `claude --agent hyperpowers:hyperpowers-director --effort high "<request>"` is now the
supported entry point, and `/hyperpowers:feature` is the legacy one, still checked after the fact.

**The decision above is unchanged.** The run still happens in one turn — but its justification has
shifted, and the document should not pretend otherwise. Single-turn was a *defence* against silent
demotion; on the agent path that hazard is gone. It remains because the Stop hook is what advances
the phases and every new turn re-reads the entire context, which is two thirds of a run's cost.
Whether multi-message dialogue is now worth reopening is a genuinely open question, and one this
ADR no longer forecloses on model-pin grounds.

Two things `--agent` does **not** fix, both measured rather than assumed:

- **Effort is not pinned by agent frontmatter**, in either direction. It comes from the launch
  flag, and is verified from `CLAUDE_EFFORT` rather than declared.
- The **legacy skill path** is unchanged and still needs every rule in this ADR.

**Accept the demotion and re-pin on resume.** Rejected: the demotion is silent, and the run
would have continued through design decisions on the wrong tier before anyone noticed.

## Amendment II — 2026-07-28: the director is a subagent, and the turn is a dispatch

The first amendment made `--agent` the supported entry point. That lasted one measurement cycle.
`--agent` secures the tier but only by moving the requirement into a command the user must paste —
the same friction the settings file had, in different clothes. A **subagent** honours its declared
`effort:` unconditionally (§S3 T26) and its declared `model:` against the session default — which is
the comparison this decision turns on — so `/hyperpowers:feature` dispatches one and
requires nothing of the session at all. *(corrected: not unconditional. T26 measured effort only;
frontmatter is third in the model precedence, behind `CLAUDE_CODE_SUBAGENT_MODEL` and a
per-invocation `model` argument, and the tier is secured in practice by observing the model the
director actually ran on — §V2.)*

What this ADR called "one turn" is now **one dispatch of the director**. The mechanism moved with
it: blocking `Stop` re-drives the main thread, which directs nothing; blocking `SubagentStop`
re-drives the director (§R6). The autonomy loop lives in `scripts/subagent-controller.mjs`,
filtered on `agent_type`.

The user contract changed shape, not intent. `AskUserQuestion` is removed from every subagent's
tool list (§R1) — no frontmatter restores it — so the director asks by **writing a question packet
and stopping**, and the main thread renders it (§S6). The rule that made this ADR necessary in the
first place is therefore no longer a rule about pins: it is that a parked director costs a round
trip, and one taken with a wave of subagents in flight costs a turn per returning child (§R7b).

**Superseded:** the launch command of Amendment I. **Unchanged:** the run is still one continuous
piece of work with no mid-run user message required, and the Stop-hook-driven progression is still
what advances it — one level down.
