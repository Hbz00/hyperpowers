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
/hyperpowers:setup          # writes the environment contract, then tells you to confirm it with preflight
/hyperpowers:feature <what you want built>
```

Requires the [Superpowers](https://github.com/obra/superpowers) plugin (≥6.0, validated against
6.2.0) and an authenticated [Codex CLI](https://github.com/openai/codex). Preflight checks both and
refuses to start without them — there are no silent fallbacks.
Start your Claude Session on Fable model.

## Why it is shaped this way

**Judgement is expensive; volume is cheap.** The strongest model decides what to build and whether
it is done. A coordinator turns that into architecture and executable contracts. Workers read,
write, test and measure. Each tier sees only what it needs.

**An author cannot review their own work.** Six mandatory reviews come from Codex — a different
model, from a different lab, with clean context and instructions to break confidence rather than
confirm it. It is a contradictor, not an authority: every finding is adjudicated with a recorded
decision, and the *next* round is asked whether the rejections hold.

**Green tests are not proof.** They can mean the missing behaviour is untested. Completion demands
evidence per acceptance criterion plus fourteen mechanical conditions — including that added tests
demonstrably failed beforehand, that no file outside the plan changed, and that the director
really ran on the model it thought it did.

**Autonomy needs brakes, not just a throttle.** A state machine with enforced gates, stall
detection, circuit breakers and budget bounds. A run that cannot proceed stops in `BLOCKED` with a
reason — a better outcome than a confident `COMPLETE` on unproven work.

## What it will not do

- **Mutate Git while a run is active.** No commits, branches, stashes or worktrees. A `PreToolUse`
  hook blocks them before they execute; a `PostToolUse` guard catches what slips through an opaque
  script and fails the completion gate. The moment a run ends, your Git works as it always did.
- **Ask you anything after intake.** Local ambiguity is the coordinator's to resolve, product
  ambiguity the director's; a genuine external impossibility becomes `BLOCKED`.
- **Degrade silently.** An unavailable model either falls back along one documented path, recorded,
  or stops the run.

`/hyperpowers:setup` disables Claude Code's advisor tool for the project so escalation goes up this
plugin's ladder. That applies to every session in the project, not just Hyperpowers runs — it is
written but not required, so delete it from `.claude/settings.json` if you would rather keep the
advisor.

## When not to use it

The architecture has a floor, best stated in time. Across four runs, reaching a locked plan —
everything before the first line of code — took **54 minutes to 1 h 40**, on a five-line utility
and on a production Django codebase alike. Cost does not track feature size: a `truncate()` helper
reached `COMPLETE` at **$22**, a CSV codec five times its size at **$14**, the 200k-line feature at
**$73**. What it tracks is findings to adjudicate and packages to build.

A run owns its session for those hours, so to have several going at once give each one its own
**clone** rather than a `git worktree` — worktrees share a single ref set and stash, which the
drift guard reads globally, so one run's new branch or commit fails every other run's completion
gate.

So use it where correctness is worth arguing about: real failure modes, several interacting pieces,
a specification you are not yet sure is coherent. For a small, well-understood change, one
competent agent finishes sooner and cheaper, and six rounds of review have nothing to disagree
about.

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

Every phase has an owner, exit requirements that must exist on disk, and one legal set of
successors. Transitions go through a single verb and are refused — with the reason — when a
requirement is unmet.

The whole run happens in **one turn**, driven by a Stop hook. That is not stylistic: a skill's
model pin survives hook-forced continuations but is cleared the moment you send a message, so any
mid-run pause would silently demote the director. See
[ADR-0001](docs/adr/0001-single-turn-user-contract.md).

All state lives in `$CLAUDE_PLUGIN_DATA`, so a run survives compaction, session loss and restarts.

`COMPLETE` leaves you three things: the diff in your working tree, uncommitted; a generated report
with every acceptance criterion, its evidence, the six review rounds and the measured per-tier
cost; and a **product diagram published as an artifact** — a Mermaid view of what was built,
shareable, and required by the completion gate rather than offered by it.

## Nothing here is assumed

[`docs/validation-ledger.md`](docs/validation-ledger.md) records every load-bearing claim with its
evidence and verdict, **including the ones that turned out to be wrong**:

- Plugin manifests cannot contribute `env` — so `/hyperpowers:setup` is mandatory.
- Plugin dependency **strings** silently strip a semver range (`"name@^6.2.0"` does nothing); two
  reviewers concluded otherwise from the schema before someone read the consumer.
- A skill's `model:` pin is turn-scoped, which reshaped the entire interaction contract — and does
  not take at all against an interactively chosen session model, which cost two aborted runs.

```
npm test          # the whole suite
npm run check     # tests + a check that generated docs are in sync
```

The Git policy carries a 306-case conformance table (`tests/git-policy.test.mjs`). Every case added
after the first draft is a real defect found by adversarial probing *outside* the table — five
rounds of it, each finding holes the previous round's fixes did not generalise to. The fourth found
a one-token defeat of the whole policy, and one of its bypasses was created by the third round's own
fix. The fifth came from a live run rather than a probe: chasing a *false positive* led to
`eval "$(…)"`, where the substitution is inspected, found harmless, and its output is what actually
runs. See [ADR-0003](docs/adr/0003-git-prevention-and-detection.md).

`tests/run-lifecycle.test.mjs` walks a whole run from `PREFLIGHT` to `COMPLETE` using only commands
an agent is actually told to run, with no hand-written state. Gates that are checkable but
unreachable are the failure mode it exists to catch, and it has caught two.

## Configuration

An optional `.hyperpowers.json` at your project root overrides budgets, timeouts, review models,
concurrency and verification commands. It is re-read at every checkpoint, so raising a budget
mid-run takes effect immediately. Defaults and the reasoning behind each:
[`scripts/lib/config.mjs`](scripts/lib/config.mjs).

## Documentation

| | |
| --- | --- |
| [Validation ledger](docs/validation-ledger.md) | Every claim, its evidence, its verdict — and the corrections |
| [Cost model](docs/cost-model.md) | Independently recomputed economics, and the measured runs |
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
