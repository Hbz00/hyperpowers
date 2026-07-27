# CLAUDE.md

Guidance for Claude Code when working **on this repository**. It is contributor documentation, not
plugin content: `claude plugin validate --strict` warns that a root `CLAUDE.md` is not shipped as
project context, which is correct and intended — nothing here is loaded for users of the plugin.
What ships is `skills/`, `agents/`, `hooks/`, `scripts/`, `schemas/`, `prompts/` and `templates/`.

## What this repository is

`hyperpowers` is **a Claude Code plugin, not an application**. Its product is orchestration
machinery: hooks, a state machine, gate verifiers and an adapter that drives the Codex CLI. When
you edit it you are editing something that runs *inside* the harness, so most defects here fail
silently rather than crashing — a gate that does not gate, a budget that stops counting, a hook
that never fires. Nearly every source file carries a comment naming the specific defect that
shipped there. Read those comments before changing the code they guard; they are the design
rationale, not decoration.

The plugin's own behaviour is documented for users in `README.md`. Do not re-derive it here.

## Commands

```bash
npm run check          # docs:check && test — this is the real pre-commit gate
npm test               # node --test 'tests/**/*.test.mjs'
npm run test:policy    # the Git-policy conformance table alone
npm run docs           # regenerate skills/feature/references/workflow.md from lib/phases.mjs
npm run docs:check     # fail if that file is stale
npm run bench          # tests/bench/review-latency.mjs — spends real Codex quota, run deliberately

node --test tests/completion.test.mjs                                            # one file
node --test --test-name-pattern 'denies the Workflow tool' tests/state-machine.test.mjs
```

`npm test` does **not** catch a stale `workflow.md` — only `docs:check` does, and it is not a
test file. Use `npm run check`.

Node ≥18, ESM only, **zero runtime dependencies**. That is a hard constraint, not a preference:
the scripts run in hook subprocesses on whatever Node the user has, with no install step, so a
plugin that needed `npm install` would not enforce its own safety invariants on first run. This
is why `scripts/lib/validate.mjs` is a hand-rolled JSON Schema subset validator and
`scripts/lib/shell-parse.mjs` is a hand-rolled POSIX splitter. Do not add a dependency.

## Architecture

### One source of truth for the workflow

`scripts/lib/phases.mjs` defines every phase, its owner, its successors, its exit requirements
(`requires`) and the instruction the Stop hook injects. The Stop controller, the status skill,
the completion verifier, the feature skill and the generated reference all read that one table.

**To change the workflow, change that table** — then `npm run docs` and commit the regenerated
`skills/feature/references/workflow.md`. Never edit that file by hand.

### The two halves, and the data root they must agree on

```
hooks (hooks/hooks.json)                     CLI scripts (invoked via Bash by agents)
  git-policy.mjs        PreToolUse   15s       state-machine.mjs   phases, tasks, risks, artifacts
  git-guard.mjs         PostToolUse  20s       preflight.mjs       environment contract
  stop-controller.mjs   Stop         30s       codex-adversary.mjs the six review rounds
  validate-agent-report SubagentStop 20s       verify-completion   design | plan | completion gates
  session-context.mjs   SessionStart 15s       adjudication-ledger findings → decisions
                                               report.mjs, resume-run.mjs, setup.mjs, docs-gen.mjs
```

Both halves must resolve the **same run-data directory** or the plugin governs nothing while
looking perfectly healthy — measured, ledger §O1. Hooks receive `CLAUDE_PLUGIN_DATA` from the
harness; a Bash-tool subprocess was observed carrying *another plugin's* value. So
`scripts/lib/paths.mjs` self-locates via `import.meta.url`, accepts `CLAUDE_PLUGIN_DATA` only
when the directory belongs to this plugin, and otherwise finds our sibling beside it.
`SessionStart` stamps `.data-root.json` and preflight fails when the marker is absent inside a
live session. **Do not "simplify" `dataRoot()` back to reading the environment variable.**

Run data never enters the working tree (spec §20): the reviewer must see the user's diff, not
Hyperpowers' logs. `scripts/lib/workspace.mjs` holds the one list of files Hyperpowers does write
into a project (`.claude/settings.json`, `.hyperpowers.json`) and both the review pack and the
scope check read it.

### Fail direction is per hook and deliberate

`runHook(name, body, onError, { budgetMs })` in `scripts/lib/hookio.mjs` decides it:

- `git-policy.mjs` fails **closed** — anything unclassifiable is denied (spec §14.4).
- Every other hook fails **open** — an internal bug must never wedge a session.

`budgetMs` must stay comfortably below the timeout declared for that hook in `hooks/hooks.json`.
If the harness kills the process first, `onError` never runs, and for the fail-closed hook that
silently converts a deny into an allow. Changing a timeout in one place means changing it in both.

### Git policy: prevention plus detection

`scripts/lib/git-policy.mjs` is an **allowlist** classifier — a git invocation is permitted only
when its subcommand and every option are known read-only. It follows chains, pipes, subshells,
substitutions, `eval`, `sh -c`, `xargs`, `find -exec`, env assignments, shell reserved words and
function definitions. It cannot follow an opaque script (`./deploy.sh`, `npm run release`), so
`scripts/git-guard.mjs` fingerprints the repository after every Bash call and records a
`policy_violation` on observed drift.

Two distinctions in that code are load-bearing and easy to undo:

- `policy_blocked` (prevention worked) is **not** `policy_violation` (a mutation happened).
  Telemetry is append-only, so conflating them permanently fails completion condition §13.11.
- Escalating drift (HEAD, refs, branch, stash, index content) fails the run; observed drift
  (local config) is recorded and reported but never fails it, because a cold `npm install` in a
  husky project moves it.

The policy applies **only while a run owns the session** (`policyApplies`), unless
`.hyperpowers.json` sets `git.enforce: "always"`. Installing the plugin must not take Git away
from the user. `git-guard.mjs` reads the same `stopAllowed` check so the two halves release Git
at the same moment.

### State, gates and evidence

- Phase changes go through `state-machine.mjs transition` only. `scripts/lib/state.mjs`
  validates legality (`canTransition`) *and* the exit gate before writing. `COMPLETE` is the one
  terminal phase that is **not** gate-exempt — success has to be earned.
- Budget bounds are evaluated in `budgetOverrun()` (`scripts/lib/config.mjs`) and called from
  **both** the Stop controller and every non-terminal transition. The Stop hook alone fired once
  in an 86-minute run, so a bound checked only there is not a bound.
- Cost is computed in exactly one place: `scripts/lib/transcript.mjs`, from the session
  transcript (including subagent transcripts), with Anthropic cache multipliers applied. An
  unknown model family is priced at the *most expensive* tier, never zero.
- `verify-completion.mjs` calls `main()` at the very bottom of the file on purpose — a `const`
  declared below the dispatch sat in its temporal dead zone and crashed only inside a real Git
  repository, invisible to the whole suite. Do not move it, and do not declare anything after it.

### The recurring defect class

Most defects recorded in `docs/validation-ledger.md` §K–§O share one shape: **a field the system
reads and nothing writes** — `state.artifacts.diagramUrl`, task status `accepted`,
`residualRisks`, the §18 extra review round, the `maxSubagents` counter. Each made a gate
unreachable or a circuit breaker inert while every test stayed green. When you add a field, a
status or a bound, find its producer before you trust its consumer.

## Testing conventions

Three genres, each catching what the others cannot:

- **Conformance table** — `tests/git-policy.test.mjs`. 278 cases; extend the policy by adding
  rows. Three docs quote that number and a test fails if any of them drifts, including a sweep
  for stray counts near the word "case". If you change the table size, update the prose those
  tests point at.
- **Reachability** — `tests/run-lifecycle.test.mjs` walks `PREFLIGHT → COMPLETE` using **only
  commands an agent is actually told to run**. No test may hand-write `state.json` or set a task
  status directly. If reaching a phase requires something the test cannot do with a documented
  verb, a real run cannot do it either. This rule has caught two fatal defects; keep it.
- **Regression** — `tests/regression.test.mjs`, `tests/completion.test.mjs`. One test per defect
  that shipped, passed the suite, and failed *quietly*.

Tests drive the real scripts as subprocesses with real hook payloads, sandboxed by two variables:

```js
const env = () => ({ ...process.env, HYPERPOWERS_DATA_ROOT: DATA, CLAUDE_PLUGIN_ROOT: ROOT });
```

`HYPERPOWERS_DATA_ROOT` is the only override `dataRoot()` trusts unconditionally, and exists for
this. Testing exported functions directly misses the failures that matter here — a script that
throws on startup, emits malformed JSON, or exits with the wrong code is a broken hook however
correct its internals are.

## Sources of truth

| For | Read |
| --- | --- |
| What the plugin must do, by § number | `docs/hyperpowers-claude-plugin.md` (French design spec; code cites `spec §N`) |
| What the harness *actually* does | `docs/validation-ledger.md` — measured, with verdicts, including claims that turned out wrong |
| Why the interaction contract is single-turn | `docs/adr/0001-single-turn-user-contract.md` |
| Why Codex is called as a binary, not a slash command | `docs/adr/0002-codex-adapter-over-slash-command.md` |
| What prevention and detection each cannot cover | `docs/adr/0003-git-prevention-and-detection.md` |
| Measured economics | `docs/cost-model.md` |
| Defaults and their rationale | `scripts/lib/config.mjs` |

**Never reason from memory about Claude Code's behaviour** — plugin manifest keys, frontmatter
fields, hook payload shapes, model pins, block caps. Check the ledger. It was written by
extracting strings from the binary and running black-box experiments, and it records several
things two reviewers got wrong from the documentation alone. If you need a fact that is not in
it, measure it and add a row.

## Product framing, when it matters for a change

From `docs/cost-model.md` and ledger §P3–§P9, measured across three runs: the architecture has a
**floor**, and it is best stated in time. Reaching `PLAN_LOCK` took **54–57 minutes in every run**,
on a five-line utility and on a multi-module codec alike. A `truncate()` utility reached `COMPLETE`
at **$22**; a CSV codec five times its size reached it at **$14**. Cost does not track feature size
— it tracks how many turns the agents happen to take.

Two numbers govern any change that claims to save money (§P8). **Two thirds of the bill is context
re-read, not generation**, so output-token share — the thing §6.2 measures — is a third of the cost.
And **tool calls per turn was 1.00** across two complete runs, every agent, so the cheapest large
saving is batching independent calls rather than moving work between tiers. Tier shares vary more
between two identical runs than any routing prompt has moved them.

So the value proposition is **quality, not price**, and the metric is cost per *correctly
finished* feature. Changes that add orchestration to small work make the tool worse; changes that
make a gate genuinely falsifiable, or remove agent turns, make it better.

## Repository state

There are no commits yet — the entire tree is staged for an initial commit. `package.json` is
private and versioned separately from the published plugin version in `.claude-plugin/plugin.json`.
