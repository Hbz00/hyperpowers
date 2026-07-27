# Hyperpowers

**A Claude Code plugin that builds a feature end to end — and has to prove it finished.**

> Fable directs. Opus orchestrates. Sonnet executes. Codex contradicts. Tests and evidence decide.

You describe what you want and answer a few questions. Hyperpowers designs it, has the design
attacked by an independent reviewer from another lab, plans it, has the plan attacked, builds it,
verifies it, has the implementation attacked — then tells you, with evidence, whether it is
actually done.

It never touches Git. You do all of that yourself.

## Install

```
/plugin marketplace add Hbz00/hyperpowers
/plugin install hyperpowers
/hyperpowers:setup          # writes the environment contract; it says if a restart is needed
/hyperpowers:feature <what you want built>
```

Requires the [Superpowers](https://github.com/obra/superpowers) plugin (≥6.0, validated against
6.2.0) and an authenticated [Codex CLI](https://github.com/openai/codex). Preflight checks both and
refuses to start without them — there are no silent fallbacks.

## Why it is shaped this way

**Judgement is expensive; volume is cheap.** The strongest model decides what to build and whether
it is done. A coordinator turns that into architecture and executable contracts. Workers do the
reading, writing, testing and measuring. Each tier sees only what it needs, so the director's
context never fills with operational detail.

**An author cannot review their own work.** Six mandatory adversarial reviews come from Codex — a
different model, from a different lab, with clean context and instructions to break confidence
rather than confirm it. It is a contradictor, not an authority: every finding is adjudicated with a
recorded, reviewable decision, and the *next* round is asked whether the rejections hold.

**Green tests are not proof.** They can mean the missing behaviour is untested. Completion requires
every acceptance criterion to carry evidence, plus fourteen conditions checked mechanically —
including that added tests demonstrably failed beforehand, that no file outside the plan changed,
and that the director tier really ran on the model it thought it did.

**Autonomy needs brakes, not just a throttle.** A state machine with enforced gates, progress
detection, circuit breakers and budget bounds. A run that cannot proceed stops in `BLOCKED` with a
reason, which is a better outcome than a confident `COMPLETE` on unproven work.

## What it will not do

- **Mutate Git while a run is active.** No commits, branches, stashes or worktrees. A `PreToolUse`
  hook blocks them before they execute; a `PostToolUse` guard detects mutations that slip through an
  opaque script and fails the run's completion gate. Outside a run — and the moment one finishes or
  is aborted — your Git works exactly as it always did. Installing this plugin does not take Git
  away from you.
- **Ask you anything after intake.** Once brainstorming ends the run is autonomous. Local ambiguity
  is the coordinator's to resolve, product ambiguity the director's; a genuine external
  impossibility becomes `BLOCKED`.
- **Degrade silently.** An unavailable model either falls back along one documented path, recorded,
  or stops the run.

## When not to use it

The architecture has a **floor**, and the honest way to state it is in time. Measured across three
runs on two very different features: reaching a locked plan — everything before the first line of
code — took **54 to 57 minutes every single time**. A five-line `truncate()` utility reached
`COMPLETE` at **$22**; a CSV codec five times its size reached it at **$14**. Cost does not track
feature size; it tracks how many turns the agents happen to take.

So use it where *correctness is worth arguing about*: real failure modes, several interacting
pieces, or a specification you are not yet sure is coherent. For a small, well-understood change, a
single competent agent finishes sooner and cheaper, and six rounds of review have nothing to
disagree about.

Full numbers, including what the measurement got wrong before it got it right:
[`docs/cost-model.md`](docs/cost-model.md).

## Commands

| Command | What it does |
| --- | --- |
| `/hyperpowers:setup` | Writes the environment contract into `.claude/settings.json` (dry run by default) |
| `/hyperpowers:feature <description>` | Runs a feature end to end |
| `/hyperpowers:status` | Where a run is, what is blocking it, what it has cost |
| `/hyperpowers:resume` | Continues a suspended or interrupted run |
| `/hyperpowers:abort` | Stops a run and releases the session |

## How a run works

```
PREFLIGHT → INTAKE → BRAINSTORMING
  → DESIGN_DRAFT → codex ×2 → DESIGN_LOCK
  → PLAN_DRAFT   → codex ×2 → PLAN_LOCK
  → EXECUTION → SYSTEM_VERIFICATION → codex ×2 → FINAL_ACCEPTANCE → COMPLETE
```

Every phase has an owner, exit requirements that must exist on disk, and a single legal set of
successors. Transitions go through one verb and are refused — with the reason — when a requirement
is unmet.

The whole run happens in a **single turn**, driven by a Stop hook. That is not a stylistic choice:
a skill's model pin is cleared when the user sends a message but survives hook-forced
continuations, so any mid-run pause would silently demote the director to the session's default
model. See [ADR-0001](docs/adr/0001-single-turn-user-contract.md).

**Your session's model does not matter.** The skill pins the director tier, and it wins: a run
launched from a Sonnet session was measured running the director on Fable from the first message to
the last. It is enforced, not merely intended — the observed model is compared against the
configured tier on every continuation, and a mismatch fails a completion condition. Effort is a
preference rather than a guarantee: the run records the effort it actually ran at and states it in
the final report, so a session-level override is visible rather than silent.

All state lives in `$CLAUDE_PLUGIN_DATA`, never in your working tree — so the reviewer sees your
diff rather than Hyperpowers' logs, and a run survives compaction, session loss and restarts.

## Nothing here is assumed

[`docs/validation-ledger.md`](docs/validation-ledger.md) records every load-bearing claim with its
evidence and verdict, **including the ones that turned out to be wrong**:

- Plugin manifests cannot contribute `env` — so `/hyperpowers:setup` is mandatory. Whether it also
  needs a session restart is measured rather than assumed.
- Plugin dependency **strings** silently strip a semver range (`"name@^6.2.0"` does nothing); the
  object form does honour one, and two reviewers concluded otherwise from the schema before someone
  read the consumer.
- A skill's `model:` pin is turn-scoped, which reshaped the entire interaction contract.

```
npm test          # the whole suite — 427 tests
npm run check     # tests + a check that generated docs are in sync
```

The Git policy carries a 278-case conformance table (`tests/git-policy.test.mjs`). Every case added
after the first draft is a real defect found by adversarial probing *outside* the table — five
separate rounds of it, each finding holes the previous round's fixes did not generalise to. The
fourth found a one-token defeat of the whole policy, and one of its bypasses was created by the
third round's own fix. The fifth came from a live run rather than a probe: chasing a *false
positive* — a legitimate shell helper refused — led to `eval "$(…)"`, where the substitution is
inspected, found harmless, and its output is what actually runs. See
[ADR-0003](docs/adr/0003-git-prevention-and-detection.md), which is also a record of how little a
green table proves on its own.

`tests/run-lifecycle.test.mjs` walks a whole run from `PREFLIGHT` to `COMPLETE` using only commands
an agent is actually told to run, with no hand-written state. Gates that are checkable but
unreachable are the failure mode it exists to catch, and it has caught two.

## Configuration

An optional `.hyperpowers.json` at your project root overrides budgets, timeouts, review models,
concurrency and verification commands. Defaults and the reasoning behind each:
[`scripts/lib/config.mjs`](scripts/lib/config.mjs).

## Documentation

| | |
| --- | --- |
| [Validation ledger](docs/validation-ledger.md) | Every claim, its evidence, its verdict — and the corrections |
| [Cost model](docs/cost-model.md) | Independently recomputed economics, and three measured runs |
| [ADRs](docs/adr/) | The three decisions that shaped the build |
| [Workflow reference](skills/feature/references/workflow.md) | Every phase and its exit requirements, generated from the state machine |
| [Completion contract](skills/feature/references/completion-contract.md) | The fourteen conditions for `COMPLETE` |
| [Git policy](skills/feature/references/git-policy.md) | What is allowed, what is blocked, and what neither prevention nor detection can cover |
| [Superpowers overrides](skills/feature/references/superpowers-adaptation.md) | The nine conflicting instructions, and why each is overridden |
| [Original design spec](docs/hyperpowers-claude-plugin.md) | The document this was built from, in French. Code cites it as `spec §N`; the ledger records where reality disagreed with it |

## Credits

Method from [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent. Delegation and
economic discipline inspired by [fable-advisor](https://github.com/DannyMac180/fable-advisor) —
principles borrowed, no code. Adversarial review framing follows the
[Codex plugin](https://github.com/openai/codex-plugin-cc)'s `adversarial-review`.

Released under the [MIT licence](LICENSE).
