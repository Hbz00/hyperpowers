# Cost model — recomputing spec §7.2 independently

The spec's economic argument rests on CursorBench 3.2 deltas and a worked example. The
benchmark numbers cannot be verified from here, and the spec says as much. The *conclusion*,
however, can be recomputed from the harness's own model registry, which is what this document
does.

## Prices (verified)

From the Claude Code binary's model registry (validation ledger A4), USD per million tokens:

| Model | Tier | Input | Output |
| --- | --- | --- | --- |
| Fable 5 | `tier_10_50` | 10 | 50 |
| Opus 5 | `tier_5_25` | 5 | 25 |
| Sonnet 5 | `tier_3_15` | 3 | 15 |

Cross-checked against the published API pricing reference: identical on all three rows, as are
the cache multipliers this model applies (reads ×0.1, writes ×1.25). Two independent sources
agreeing is worth stating, because every conclusion below is a ratio of these six numbers — if
they were wrong, nothing else here would survive.

A model family this table does not recognise is priced at the **Fable** rate, not zero. Pricing
an unknown model at zero makes its spend invisible to the `maxCostUsd` breaker, and a budget that
silently stops counting is worse than one that overestimates.

So per token, **Fable = 2 × Opus** and **Sonnet = 0.6 × Opus**. All three declare
`default_effort: "high"`.

## Checking §7.2's arithmetic

The spec's basket is 1 Fable task, 3 Opus tasks, 9 Sonnet tasks, with High→Xhigh cost
multipliers of ×1.338, ×1.880 and ×1.304, and claims all-High ≈ 69% of all-Xhigh.

Its own numbers are internally consistent: 49.21 / 71.22 = 0.691. ✓

Recomputing with the real price ratios and an equal token profile per task:

```
all-High  = 2·C + 3·C + 9·(0.6·C)                       = 10.40 C
all-Xhigh = 1.338·2·C + 1.880·3·C + 1.304·9·(0.6·C)     = 15.36 C
ratio     = 0.677
```

**≈68% versus the spec's 69%.** The conclusion survives independent recomputation: systematic
Xhigh costs roughly a third more and would consume much of the pyramid's benefit.

## The finding the spec misses

§6.2 targets Fable at ≤10% of output tokens. It is easy to read that as "Fable is ~10% of the
cost". It is not, because Fable's output tokens cost 3.33× Sonnet's.

Using the spec's own mid-range targets — Fable 10%, Opus 25%, Sonnet 65% of output tokens:

| Tier | Output-token share | Output price | Cost weight | **Share of cost** |
| --- | ---: | ---: | ---: | ---: |
| Fable | 10% | 50 | 5.00 | **23.8%** |
| Opus | 25% | 25 | 6.25 | **29.8%** |
| Sonnet | 65% | 15 | 9.75 | **46.4%** |
| | | | 21.00 | 100% |

**Fable at a tenth of the tokens is nearly a quarter of the spend.** Any effort to make the
pyramid cheaper should attack Fable's token count first — which is exactly what the decision
packet protocol (§6.3, 500–1000 tokens, no raw logs) is for. That protocol is not a stylistic
preference; it is the single highest-leverage cost control in the design.

## Against the right baseline

Compared with running everything on one model, at the same total output volume:

| Configuration | Relative cost | vs Hyperpowers |
| --- | ---: | --- |
| All Fable | 50.0 | Hyperpowers is **58% cheaper** |
| All Opus | 25.0 | Hyperpowers is **16% cheaper** |
| **Hyperpowers (10/25/65)** | **21.0** | — |
| All Sonnet | 15.0 | Hyperpowers is 40% *more* expensive |

This is the honest picture, and it reframes the value proposition:

- Against a **Fable-only** baseline, the pyramid is a large saving.
- Against an **Opus-only** baseline, it is a *modest* saving (~16%). The pyramid is therefore
  not primarily a cost optimisation over Opus — it is a **quality architecture** whose cost
  happens to be slightly lower. Adversarial review, evidence gates and bounded escalation are
  what justify it, not the 16%.
- Against **Sonnet-only**, it costs more, and must earn that by finishing correctly more often.

This is why spec §24 is right that the metric must be **cost per correctly finished feature**,
and why configuration B (Opus alone + Superpowers) is the baseline that actually matters. A
comparison that omits B would flatter the design.

## The assumption that carries the most weight

Every row in that table holds **total output volume constant**. That is the assumption to
attack, and it is the one most likely to be wrong — in the direction that flatters Hyperpowers.

A pyramid does not do the same work as a single agent, more cheaply. It does *more* work:

- every subagent starts with its own system prompt and its own reconstruction of context;
- the same files are read by a researcher, an implementer and a verifier, each paying for them;
- work packages, agent reports, decision packets and review packs are tokens that exist only
  because the work is delegated;
- six review rounds produce findings, which produce adjudications, which produce corrections.

None of that exists in an all-Opus run. So the honest statement is **not** "Hyperpowers is 16%
cheaper than Opus alone" — it is "at equal output volume the mix is 16% cheaper, and the mix
produces more volume." Plausibly enough more to erase the 16% entirely and cost more.

That does not undermine the architecture; it relocates the argument. The case for Hyperpowers is
that adversarial review, evidence gates and bounded escalation produce a *finished* feature more
often, and §24's metric — cost per correctly finished feature — is the only one that can settle
it. Against a Fable-only baseline the saving is large enough to survive any plausible overhead;
against Opus alone, the claim to make is quality, not price.

## The other axis: latency

Cost is not the only price. The six mandatory rounds sit on the critical path of every run, and
they are serial by construction — round 2 cannot start until round 1 has been adjudicated and
corrected.

Measured against the real CLI on a small pack (`tests/bench/review-latency.mjs`):

| Model / effort | Seconds | Tokens |
| --- | ---: | ---: |
| Luna, low | 21–25 | ~15k |
| Luna, high | 42 | ~17k |
| Sol, high | 178 | — |

Latency tracks **effort and model, not pack size** — a 1.4 KB pack still took three minutes on
Sol/high. So the size cap is a defence against the review that never returns (§23 Risk 5), not a
speed optimisation, and shrinking packs will not buy back wall-clock.

Six rounds is therefore roughly **3–18 minutes of pure review latency** before any remediation.
For an overnight or background run that is irrelevant. For anything a person is waiting on, it is
the dominant cost, and no amount of token efficiency changes it. The 15-minute per-invocation
timeout is sized for the Sol case; a shorter one would manufacture failures.

## What is not modelled here

- **Orchestration overhead.** As above: context duplication across subagents, delegation
  artefacts, and the remediation cycles the review rounds generate. This is the largest
  unmodelled term and it works against the pyramid.
- **Prompt caching.** Cache reads bill at 0.1× and cache writes at 1.25×. Long-lived director
  context benefits disproportionately, so real Fable cost is likely below this model's estimate.
  `scripts/lib/transcript.mjs` applies the real multipliers when measuring. This works in the
  pyramid's favour and partly offsets the previous point.
- **Input-token distribution.** The shares above are output-token shares. Input prices carry the
  same 2 : 1 : 0.6 ratio, so the arithmetic is unchanged *if* input distributes like output —
  but Sonnet reads far more than it writes, so its real share of input is higher, which pushes
  Fable's share of total spend below 23.8%. Treat that figure as an upper bound.
- **Codex.** Billed on the user's OpenAI plan, tracked as invocations rather than dollars. Free
  in this model, and not free in reality.
- **Retries.** A cheaper first attempt that fails twice is not cheaper. Only measurement
  settles this.

The plugin measures the first four of these per run — `state.observedUsage` comes from the
session transcript, including subagents, with cache multipliers applied — so the overhead term
is observable after the fact even though it is not predicted here.

## Measured, not assumed

Every run reads its own transcript and reports actual per-model token usage — including
subagents, whose transcripts live in `<session>/subagents/` rather than in the session file
(ledger O3) — with cache multipliers applied. `/hyperpowers:status` and the final report show the
real distribution against the reference bands.

The bands are orientation, never a gate. A run that sits outside every band and delivers a
correct feature is a good run.

## Three measured runs, after the accounting was fixed

Everything above this line is derivation. Everything below is measurement — and the first thing
measurement produced was a correction to itself.

### The accounting was wrong by a factor of two (ledger §P7)

`analyseTranscript` summed transcript rows. The transcript writes **one row per content block**:
a reply that thinks and then calls a tool is two rows, three with visible text, each carrying the
same `requestId` and repeating the same prompt counters while `output_tokens` grows as the
response streams. Summing rows billed the prompt once per block.

Measured over three runs, that overstated cost by **1.86–1.99×**, and it overstated the *director*
most, because its replies carry the most blocks. Every figure this document previously published
was wrong in the same direction. The numbers below group by request: prompt counted once, output
taken as the largest value seen.

### What a run actually costs

| | run #1 — `truncate`, 5 lines | run #2 — CSV codec | run #3 — CSV codec |
| --- | ---: | ---: | ---: |
| to `DESIGN_LOCK` | $5.92 · 25.6 min | $5.21 · 24.9 min | $3.44 · 24.3 min |
| to `PLAN_LOCK` | $13.26 · 57.2 min | $12.83 · 57.1 min | $7.79 · 54.3 min |
| whole run | **$21.93** · 85.7 min | (blocked, §P1) | — |

Two feature sizes, three runs, and the **wall clock to `PLAN_LOCK` is 54–57 minutes every time.**
The floor is real, and it is better stated in time than in money: roughly **an hour and $8–13 of
scaffolding before the first line of code**, almost independent of what is being built.

Cost varies far more than time — $7.79 to $13.26 for the same milestone — because it depends on
how many turns the agents happen to take. That variance is the finding, not the average.

### Where the money goes, which is not where anyone was looking

| term | run #1 | run #2 |
| --- | ---: | ---: |
| context re-read (cache read) | 42.3% | 41.6% |
| cache write | 22.7% | 25.1% |
| **generation (output tokens)** | **34.9%** | **33.3%** |
| fresh input | 0.0% | 0.0% |

**Two thirds of the bill is context, not text.** §6.2 measures output-token share, every routing
rule optimises output-token share, and output tokens are a third of the cost.

Cost per turn, measured: **director $0.130 · Opus $0.071 · Sonnet $0.031.** A turn is one API
round-trip, and a round-trip re-reads the whole context. So the unit of spend is *the turn*, and
the price of a turn is set by whose context it re-reads.

Then the number that decides where to spend engineering effort — across 1,415 assistant messages
in two complete runs:

> **Tool calls per turn: 1.00. Every agent, every phase, zero exceptions.**

Every tool call is its own API round-trip. The harness supports issuing independent calls together
in one message; no agent ever did. Batching independent calls even two at a time removes on the
order of 80 Opus turns and 25 director turns from run #1 — **roughly a quarter of the bill, with
no task removed and no decision moved to a weaker model.**

### What this says about the pyramid

Corrected tier shares of output tokens:

| at `PLAN_LOCK` | run #1 | run #2 | run #3 | §6.2 target |
| --- | ---: | ---: | ---: | ---: |
| Fable | 11.6% | 11.4% | 20.7% | ≤10% |
| Opus | 84.8% | 74.5% | 77.5% | ~25% |
| Sonnet | 3.6% | 14.1% | 1.8% | ~65% |

Fable is close to target. Opus is three times over it and Sonnet a fraction of it — the inversion
is worse than the pre-correction numbers suggested.

It is also **not worth chasing.** Sonnet's share at `DESIGN_LOCK` across three runs of the same
request on the same bench was 8.1%, 20.0%, 4.4%. Run-to-run variance is larger than any effect the
routing prompts produced, so a prompt change validated on one run has proved nothing. Turn count is
the lever that survives the noise, because it is measurable per agent and per dispatch rather than
as a share of a varying whole.

**The economic conclusion, restated.** The pyramid is not where the money is. The money is in how
many times each agent re-reads its context, and the cheapest large saving available is to stop
paying for the same context twice.
