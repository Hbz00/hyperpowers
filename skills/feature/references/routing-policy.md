# Routing and effort policy

## Tiers

| Tier | Model | Does | Never does |
| --- | --- | --- | --- |
| Director | Fable 5 | Product intent, scope, design lock, final acceptance, tie-breaking Opus/Codex disputes | Search files, read logs, write code, run suites, process every finding |
| Coordinator | Opus 5 | Architecture, design, plan, work packages, dispatch, report checking, adjudication | Product decisions; routine implementation |
| Worker | Sonnet 5 | Exploration, implementation, tests, benchmarks, lint/typecheck/build, evidence | Spawn agents; make architectural decisions |
| Contradictor | Codex (Sol / Luna) | Six adversarial reviews | Decide anything — it advises, Opus adjudicates |

## Effort

`high` by default for all three Claude tiers — which is also the harness default, so this is
mostly about *when to escalate* rather than an override.

Escalate to `xhigh` for:

- **Fable** — locking a high-impact design, an ambiguous product call, a serious Opus/Codex
  disagreement, a risky final acceptance.
- **Opus** — cross-cutting architecture, security, concurrency, migrations, data integrity,
  adjudicating a blocking finding, diagnosing after repeated Sonnet failure.
- **Sonnet** — second attempt after a failure, a hard local implementation, complex test
  generation, diagnosing non-deterministic behaviour.

`max` and `medium` are off by default. `max` costs and takes disproportionately more for
problems that are rarely that hard; `medium` measurably degrades Sonnet on exactly the work it
is given here.

Effort is silently downgraded by the harness when a model does not support the requested level
(ledger A3), so Hyperpowers records the effort actually observed in the Stop payload and
compares it with what was requested. A downgrade is reported, never hidden.

## Work distribution

The 1–3–9 idea — one unit of director judgement, three of coordination, nine of execution — is
a statement of intent: push volume down, keep judgement up. It is **orientation, not a quota**.
Nothing in Hyperpowers gates, routes or retries on it. A small feature might be 1 / 1 / 2; a
large one 3 / 10 / 35. What matters is the direction of travel.

Telemetry measures the real distribution from the session transcript (per-model token usage,
including subagents), so the ratio can be observed rather than assumed. It appears in
`/hyperpowers:status` and the final report as information.

The metric that actually matters is **cost per correctly finished feature**, not cost per task.
A cheaper first attempt that causes retries or regressions is not cheaper.

### What the first measured run showed, and what it changed

Orientation is not the same as nothing. The first full run inverted the pyramid, and two later
runs confirmed the inversion while showing the shares are far too noisy to steer by (§P8 — Sonnet
held 8.1%, 20.0% and 4.4% of output tokens at `DESIGN_LOCK` across three runs of the *same request
on the same bench*):

| Tier | output tokens, run #1 | intent |
| --- | ---: | ---: |
| Opus | **63.9%** | ~25% |
| Sonnet | 24.1% | ~65% |
| Fable | 12.0% | ≤10% |

It was not caused by a bad decision anywhere. It was caused by three places where delegation was
*available* rather than *expected*, and every Opus agent holds `Write`, `Edit` and `Bash`, so the
agent that already has the context always does the work itself:

1. **Adjudication applied its own corrections** — 97,000 output tokens across three rounds, half
   of all Opus work and 29% of the run.
2. **The plan coordinator prototyped** — a reference implementation and a 50,000-case fuzz,
   53,600 tokens, which is exactly `sonnet-test-engineer`'s job.
3. **Research was discarded between phases** — the brainstorm compressed it away, so the design
   coordinator rediscovered the repository at coordinator rates.

The rule that follows is narrow and worth stating once: **a tier boundary that costs nothing to
cross will be crossed.** Where the split matters it is now written as an expectation with its
reason, not as an option — see the "Delegate the code, own the documents" rule in
`opus-review-adjudicator`. Where crossing is genuinely cheaper, the agent says so on the record.

Nothing here gates. A run that inverts the pyramid and ships a correct feature is still a good
run; a run that respects it and ships nothing is not.

## The direct-to-Sonnet bypass

The director may dispatch a Sonnet directly when all four hold: the task is completely bounded;
it involves no architectural judgement; its result is objectively checkable; routing through
Opus would not reduce risk.

Examples: locate an API, inventory the tests, confirm a config file exists, list files, run a
suite and summarise the failures.

It must not become the normal implementation path — that would collapse the coordination tier
and put operational detail back into the director's context.

## Circuit breakers (spec §18)

Per work package: attempt 1 `hyperpowers:sonnet-implementer` (`high`); attempt 2
`hyperpowers:sonnet-implementer-xhigh` **with a diagnostic brief**; attempt 3 Opus. Then re-plan
or `BLOCKED`. A retry that repeats the previous prompt is not a retry.

A plugin agent's effort is fixed in its frontmatter and cannot be set per dispatch, so escalating
effort means dispatching the `-xhigh` agent — there is no way to ask the first one to try harder.
That is true at both tiers: `hyperpowers:sonnet-implementer-xhigh` for a failed work package,
`hyperpowers:opus-adjudicator-xhigh` for a single blocking finding that turns on cross-cutting
architecture, security, concurrency or data integrity. Escalate the unit of work, never the whole
phase — running a phase at `xhigh` costs ~88% more for a 2.6-point gain (spec §7.2), which is the
entire reason the escalation is scoped.

Per artefact: the six rounds are mandatory. If round 2 uncovers a *new* blocker, at most one
extra targeted review is allowed, and it is a real round you run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> --round <design|plan|implementation>-extra
```

It verifies round 2 the way round 2 verifies round 1, and the adapter refuses a second one for
the same artefact. If a critical blocker survives it, the run is `BLOCKED`. The director may
accept non-critical residual risk — recorded with `state-machine.mjs risk --add "…"` so it
reaches the final report — but may never declare `COMPLETE` with an accepted critical defect
open.

Per run, in `.hyperpowers.json`. They exist to stop a *failing* loop, not to interrupt a healthy
feature — and **none of them ends a run**. Cost, duration and the counter bounds used to move a run
to `BUDGET_EXCEEDED`, which was terminal and unresumable: crossing a number three quarters of the
way through made a finished-but-for-the-last-step feature unfinishable. Spend is now reported at
every transition once it passes `costNoticeUsd`, and stopping is the user's call —
`/hyperpowers:abort`.

| Bound | Enforced by |
| --- | --- |
| `costNoticeUsd` | nothing — reported at every transition, never enforced |
| `maxExtraReviewsPerArtifact` | the Codex adapter, mechanically — it refuses the round |
| `maxAttemptsPerTask`, `maxParallelWriters`, `maxParallelReaders` | you, the coordinator — no hook sits between you and your own retry or your own scheduling |

Parallel-write safety does have two mechanical parts, just not a scheduler: the plan gate
rejects overlapping `owned_files` among parallel-safe packages, and a report whose
`files_modified` escape its package is rejected at submit.

`/hyperpowers:status` prints which is which. A bound that looks mechanical but is inert is worse
than an honest advisory one, so the two are never presented as the same thing.

Cost is measured from the session transcript — real per-model token usage including subagents,
with cache multipliers — not estimated from self-reported numbers.

## Model fallback

Sol High unavailable → **Luna Xhigh**, recorded as `FALLBACK_REVIEW_MODEL` and stamped on the
review itself. The effort escalation is part of the fallback, not a detail: Luna is not expected
to match Sol's architectural judgement, so it is given more reasoning to compensate. Luna
unavailable → `BLOCKED`.

No silent substitution, ever: an infrastructure that degrades quietly is worse than one that
stops, because nobody learns the quality dropped. Completion condition 12 checks that the model
recorded on each review is the one that actually answered.
