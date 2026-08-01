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
```

```
/hyperpowers:feature <what you want built>
```

**No install step, no settings file, no flags.** Hyperpowers writes nothing into your repository
and requires nothing of your session. The command dispatches the director as a subagent, and a
subagent's declared model and effort hold against whatever your session is on — so the run is
directed by Fable however you launched Claude Code. The declaration is not the whole guarantee:
the plugin also reads the model the director was *observed* running on, refuses to leave preflight
on a mismatch, and re-checks it as a completion condition (ledger §V2).

Requires the [Superpowers](https://github.com/obra/superpowers) plugin (≥6.0, validated against
6.2.0) and an authenticated [Codex CLI](https://github.com/openai/codex). Preflight checks both and
refuses to start without them — there are no silent fallbacks.

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
detection and circuit breakers. A run that cannot proceed stops in `BLOCKED` with a
reason — a better outcome than a confident `COMPLETE` on unproven work.

**And one brake it does not have, stated plainly.** No plugin can cancel an agent call already in
flight, so a run can get stuck inside one — nine hours, once (ledger §V8). It is **detected, not
recovered**: the status line says so when nothing has written for twenty minutes. The remedy is
yours, `/hyperpowers:abort`.

## What it will not do

- **Mutate Git while a run is active.** No commits, branches, stashes or worktrees. A `PreToolUse`
  hook blocks them before they execute; a `PostToolUse` guard catches what slips through an opaque
  script and fails the completion gate. The moment a run ends, your Git works as it always did.
- **Ask you anything after intake.** Local ambiguity is the coordinator's to resolve, product
  ambiguity the director's; a genuine external impossibility becomes `BLOCKED`.
- **Degrade silently.** An unavailable model either falls back along one documented path, recorded,
  or stops the run.

Hyperpowers has its own escalation ladder, so a second advisor would arbitrate outside the run's
ledger. It is **not required** and nothing installs it — preflight mentions it and moves on.

While a run is active it puts subagents on the 1-hour prompt cache Claude Code already gives the
main thread — one variable added to `~/.claude/settings.json` at the start and removed at the end,
worth 7–13% of a run. Nothing is written into your project. Because that file is your user config,
the setting applies to **every Claude Code session sharing it** while the run lasts, not only the
one running the feature; for a session whose context is never reused after five minutes that is a
2× cache-write premium instead of 1.25×. `{"cache": {"subagent1h": false}}` in `.hyperpowers.json`
turns it off.

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

The whole run happens under **one director's authority**, driven by a `SubagentStop` hook that
blocks with the next action. One *authority*, not necessarily one uninterrupted dispatch: the
director yields resumably at the harness's block cap and for main-thread errands, and is resumed
or re-dispatched onto the same run. It cannot reach you — the harness removes `AskUserQuestion`
from every subagent — so when it needs an answer it writes a question, stops, and your session
renders it and sends it back in. See
[ADR-0001](docs/adr/0001-single-turn-user-contract.md).

All state lives in `$CLAUDE_PLUGIN_DATA`, so a run survives compaction, session loss and restarts.

### What you watch while it runs

The agent panel gets one line, every five seconds:

```
HP·director ███████░░░░░░░░░░░░░░░░░  30%  EXECUTION  ↳ execution › 2×implementer  1/3 wp  54m  $8.41
```

Milestones, not a clock, and it never goes backwards — `↻n` counts the times the run went back.
`x/y wp` is work packages **accepted**, which an implementer cannot claim for itself. `↳` is what is
running underneath; press `←` for their own rows. That same cell tells you when a gate is failing, a
review is running, the run needs you, or nothing has written for twenty minutes.

`COMPLETE` leaves you three things: the diff in your working tree, uncommitted; a generated report
with every acceptance criterion, its evidence, the six review rounds and the measured per-tier
cost; and a **product diagram published as an artifact** — a Mermaid view of what was built,
shareable, and required by the completion gate rather than offered by it.

## Nothing here is assumed

[`docs/validation-ledger.md`](docs/validation-ledger.md) records every load-bearing claim with its
evidence and verdict, **including the ones that turned out to be wrong**:

- Plugin manifests cannot contribute `env`, which made an install step look unavoidable — until
  every variable in it was retired by a measurement, so there is none.
- Plugin dependency **strings** silently strip a semver range (`"name@^6.2.0"` does nothing); two
  reviewers concluded otherwise from the schema before someone read the consumer.
- A skill's `model:` pin is turn-scoped, which reshaped the entire interaction contract — and does
  not take at all against an interactively chosen session model, which cost two aborted runs. Its
  `effort:` pin does not take either, in **either** direction, and neither does a *main-session
  agent's* — the model pin holds there, the effort one does not.
- A **subagent's** `model:` was documented here as unconditional, on the authority of a measurement
  that had only ever tested `effort:`. Read from the binary, it is third in precedence behind an
  environment variable and a per-invocation argument. It holds against the session default, which is
  what this design needs — but the sentence was stronger than the evidence, in eleven places.

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
concurrency and verification commands. It is re-read at every checkpoint, so a change takes effect
mid-run. Nothing in it can end a run: spend is reported once it passes `costNoticeUsd`, and whether
an expensive run is still worth finishing is your decision, not the plugin's. Defaults and the reasoning behind each:
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
