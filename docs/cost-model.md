# Cost model — recomputing spec §7.2 independently

The spec's economic argument rests on CursorBench 3.2 deltas and a worked example. The
benchmark numbers cannot be verified from here, and the spec says as much. The *conclusion*,
however, can be recomputed from the harness's own model registry, which is what this document
does.

## Prices (verified — list prices as of 2026-07-30)

From the Claude Code binary's model registry (validation ledger A4), USD per million tokens:

| Model | Tier | Input | Output |
| --- | --- | --- | --- |
| Fable 5 | `tier_10_50` | 10 | 50 |
| Opus 5 | `tier_5_25` | 5 | 25 |
| Sonnet 5 | `tier_3_15` | 3 | 15 |

Cross-checked against the published API pricing reference: identical on all three rows. Two
independent sources agreeing is worth stating, because every conclusion below is a ratio of these
six numbers — if they were wrong, nothing else here would survive. The table carries a date because
it is a snapshot: A4 validated these tiers and nothing else, and prices move.

**One divergence from list, deliberate and recorded in ledger §V10.** Cache *writes* are 1.25×
for a five-minute TTL and **2× for a one-hour one**, and `transcript.mjs` now bills both: the full
write total at 1.25× plus a **+0.75× premium on the one-hour share** — a premium added to the
existing term, never a `5m×1.25 + 1h×2` replacement, because §V10 records rows where the two TTL
fields under-sum the total they split, and a replacement would silently drop the difference. (The
uniform-1.25× under-report this paragraph used to describe was fixed with that change; it was
worth +0.17% and +0.36% on the two most recent runs.) And Sonnet 5 carries an introductory $2/$10 through
2026-08-31 which is **not applied**: applying it would move every figure here down ~5.5%, which is
the one direction a cost figure must never fail in, and would make an archived run reprice itself the
day the promotion ends. Cache *reads* are 0.1× with no TTL split, so that half is right as written.

**What "measured" means in every dollar figure below.** These are subscription-billed sessions, not
API traffic. **Token counts are measured** — per model, per request, including subagents, from the
session transcripts. **Dollars are derived**: the counts multiplied by the list-price table above.
They are an API-price equivalent, not an invoice.

A model family this table does not recognise is priced at the **Fable** rate, not zero. Pricing an
unknown model at zero would make its spend invisible in every figure below, and in the notice that
tells a running feature what it has cost so far — under-reporting is the one direction a cost
figure must never fail in.

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
- **Prompt caching.** Cache reads bill at 0.1×; cache writes at 1.25× for a five-minute TTL and 2×
  for a one-hour one — and `scripts/lib/transcript.mjs` applies all three (the one-hour share as a
  +0.75× premium on top of the base write term, §V10). Long-lived director context benefits
  disproportionately *while the cache holds* — but a subagent's expires at ~5 minutes (ledger
  §T2), so a long run pays to re-establish it repeatedly, and on the two most recent runs the
  write term is larger than the read term (§V6). So this is not the unambiguous saving it was
  written as.
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
real distribution against the reference bands. The **token counts** are what is measured there; the
dollars beside them are those counts priced at the list table above, which is an equivalent rather
than a bill (§V10).

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
rule optimises output-token share, and output tokens are a third of the cost. That holds on every
run measured since — 65% to 82% context — but "context" is **two** terms with two different
remedies, and this table's own rows are the split: cache *read* is re-reading what an agent carries,
cache *write* is re-establishing a cache that expired. On the two most recent runs the write term is
the larger of the two (46.9% and 42.3% against 26.5% and 34.1%; ledger §V6), which points at how
many idle windows a run crosses rather than at how much it carries.

Cost per turn, measured: **director $0.130 · Opus $0.071 · Sonnet $0.031.** A turn is one API
round-trip, and a round-trip re-reads the whole context. So the unit of spend is *the turn*, and
the price of a turn is set by whose context it re-reads.

Then the number that was supposed to decide where to spend engineering effort — across 1,415
assistant messages in two complete runs:

> **Tool calls per turn: 1.00. Every agent, every phase, zero exceptions.**

**That figure was an artefact, and it is withdrawn (ledger §V4).** It divided `tool_use` blocks by
the transcript rows carrying one, and the transcript never writes two such blocks into a single row
— so 1.00 was an identity that any transcript would produce, and "zero exceptions" was the tell. The
1,415 is the giveaway too: it is 655 + 760, the two runs' assistant *row* counts. This is the same
row-versus-request confusion as the §P7 correction above, surviving in a second metric.

Recomputed per API request, which is the unit the paragraph above defines:

| run #1 | run #2 | run #3 | production run | run 8 | run 9 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.153 | 1.183 | 1.208 | 1.242 | 1.259 | 1.243 |

Run #1 issued two or more calls on 47 of its 321 requests; run #2 has one request carrying eight.
Agents were batching on the very transcripts this document called unbatched. Batching independent
calls is still right, still cheap and still instructed in every agent — but "roughly a quarter of
the bill" was measured against a baseline that never existed, and no claim about the size of the
remaining headroom is supported by anything here.

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

**And the band measures the wrong quarter.** Decomposed by *function* rather than by tier across
three complete runs (ledger §V7), production work — implementers, test engineers, the verifier — is
**15–19% of spend**. Adjudication is 17.7 / 28.9 / 36.7%, direction 27.5 / 40.2 / 30.2%. Output
tokens themselves are 23.6–26.6% of cost. So a band expressed as *shares of output tokens*, aimed at
pushing production onto Sonnet, regulates about a quarter of the bill and presumes that quarter is
where the bill is. Nothing in those runs is misrouted: every Opus dispatch is a role the spec's own
table assigns to Opus. The inversion is the arithmetic consequence of a six-round review
architecture whose judgment volume outgrows its production volume — the band is the wrong instrument
for it, which is why nothing gates on it.

**The economic conclusion, restated.** The pyramid is not where the money is. The money is in
context — carried across turns and re-established after it expires — and it concentrates in whichever
**role** accumulates the most turns across all its dispatches. On the production run that was the
execution coordinator; on run 9 it was the review adjudicator at 36.7%, above the director (§V5).
Look for the role with the turns, not for the agent with the longest life.
