# CLAUDE.md

Guidance for Claude Code when working **on this repository**. It is contributor documentation, not
plugin content: `claude plugin validate --strict` warns that a root `CLAUDE.md` is not shipped as
project context, which is correct and intended — nothing here is loaded for users of the plugin.
What ships is `skills/`, `agents/`, `hooks/`, `scripts/`, `schemas/`, `prompts/`, `templates/` and
the root `settings.json` — the settings allowlist a plugin may contribute to is exactly
`["agent", "subagentStatusLine"]` (§S9), and that file is how `scripts/statusline.mjs` reaches the
agent panel.

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
npm test               # node --test tests/*.test.mjs — one star, so tests/bench/ stays out
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
(`requires`) and the `next` instruction injected into the director's context. Sixteen scripts import
that one table — `subagent-controller.mjs` is the one that renders `nextAction()` (the Stop
controller reads only the owner and whether a stop is allowed), and `state.mjs`, `verify-completion`,
`codex-adversary`, `progress.mjs` and `docs-gen` all key off it.

**To change the workflow, change that table** — then `npm run docs` and commit the regenerated
`skills/feature/references/workflow.md`. Never edit that file by hand.

### The director is a subagent, and that is why the tier holds

`/hyperpowers:feature` directs nothing. It dispatches `hyperpowers-director` in the background and
then only relays: questions out, answers back, and the one `Artifact` publication. The whole feature
runs inside that dispatch.

The tier is secured by *dispatching*, not by declaring. A **subagent** honours its declared `effort:`
unconditionally (§S3 T26) and its declared `model:` against the session default — which is the
comparison that matters here, since a *skill's* pins do not hold against an interactively chosen
session model (§Q8) and a *main-session* agent's effort does not hold either (§Q16). Two
four-hour runs directed themselves on Opus while `skills/feature/SKILL.md` said Fable. So that file
carries no pins on purpose, `agents/hyperpowers-director.md` carries them, and `DIRECTOR_AGENT` in
`scripts/lib/config.mjs` is the single spelling of the name — compare agent types through
`bareAgentName()`, never directly, since the harness namespaces them.

**The pin is not *unconditional*, and eleven sites said it was** — on T26's authority, in an entry
that measured effort (§V2). Read from the 2.1.220 binary, subagent model resolution is
`CLAUDE_CODE_SUBAGENT_MODEL` > a per-invocation `model` argument > frontmatter > inherit, so
frontmatter is third and nothing in this repository reads that variable. What makes the tier a
guarantee rather than a declaration is the pair of checks around it: `directorTier()` reads the model
the director was *observed* running on, out of its own subagent transcript, so it catches an
inversion whatever produced it; the PREFLIGHT transition refuses to leave on a mismatch, and
condition §13.12b re-asks at the end. Say "declared and verified", never "unconditional".

Plugin agents ignore their own `hooks`, `permissionMode` and `mcpServers` frontmatter (§B3), which
is why every guarantee lives in `hooks/hooks.json`; they do honour `model`, `effort`, `tools` and
`maxTurns` (§B4). A `tools:` list is therefore load-bearing twice over — it is the agent's reach,
and it is measured prefix cost (§T3, exactly additive: `Agent` 2,735 tokens, `Skill` 5,356). Do not
trim `Skill` from the director: the plugin declares a Superpowers dependency it has to invoke.

### The two halves, and the data root they must agree on

```
hooks (hooks/hooks.json)                       CLI scripts (invoked via Bash by agents)
  git-policy.mjs         PreToolUse    15s       state-machine.mjs   phases, tasks, risks, errands
  git-guard.mjs          PostToolUse   20s       preflight.mjs       environment contract
  stop-controller.mjs    Stop          30s       codex-adversary.mjs the six review rounds
  subagent-controller    SubagentStart 30s       verify-completion   design | plan | completion gates
  subagent-controller    SubagentStop  30s       adjudication-ledger findings → decisions
  validate-agent-report  SubagentStop  20s       report.mjs, resume-run.mjs, docs-gen.mjs
  session-context.mjs    SessionStart  15s
```

**Two loops, not one.** `subagent-controller.mjs` is the phase machine: a `SubagentStop` block
re-drives the *director* (§R6), which is what advances a run. `stop-controller.mjs` only stops the
main thread abandoning a live run, and it acts on `directorTurn.yielded` — written solely by the
subagent controller, `true` where it allowed the director's stop. Inferring "the director is idle"
any other way produced §S12's nag loop. The same hook keeps `state.children`, the live-subagent
registry that tells a director *waiting* on a delegate from one that has stalled (§S15).

**Everything in that first loop samples only when the director stops.** `recordStall` and
`liveChildren` have one call site each, both below every early return in the hook, so a director
wedged inside a synchronous dispatch is governed by nothing: run 9b emitted **one** director
`SubagentStop` in 8h59m and `state.stall` never sampled once (§V8). There is no wall-clock deadline
anywhere, deliberately — §S1 removed the last mechanism that ended a run on a measurement — and no
plugin surface can cancel an `Agent` call in flight (§S14). So the ceiling is detection: the
statusline tick is the only surface that runs during a wedge, and `state.updatedAt` is the only
staleness input nobody has to remember to write.

Both halves must resolve the **same run-data directory** or the plugin governs nothing while
looking perfectly healthy — measured, ledger §O1. Hooks receive `CLAUDE_PLUGIN_DATA` from the
harness; a Bash-tool subprocess was observed carrying *another plugin's* value. So
`scripts/lib/paths.mjs` self-locates via `import.meta.url`, accepts `CLAUDE_PLUGIN_DATA` only
when the directory belongs to this plugin, and otherwise finds our sibling beside it.
`SessionStart` stamps `.data-root.json` and preflight fails when the marker is absent inside a
live session. **Do not "simplify" `dataRoot()` back to reading the environment variable.**

Run data never enters the working tree (spec §20): the reviewer must see the user's diff, not
Hyperpowers' logs. Hyperpowers writes **nothing** into a project and requires nothing of the
session — `REQUIRED_ENV` is empty, and `config.mjs` records how each of its five variables was
retired by a measurement. Keep it empty: an entry there is an install step, and an install step is a
thing that can be missing. `HYPERPOWERS_OWN_FILES` in `scripts/lib/workspace.mjs` is the one list of
paths that are Hyperpowers' concern rather than the feature's (`.claude/settings.json`, its `.local`
variant, the user's `.hyperpowers.json`); the review pack and the scope check both read it, because
a round-5 reviewer once spent a mandatory round raising a blocking finding against the plugin's own
output. `misplacedOrchestrationFile()` guards every CLI verb that takes a path from an agent.

`scripts/statusline.mjs` belongs to neither column: the root `settings.json` runs it per live
subagent on a 5 s tick, and it is the only surface a plugin can draw on. The bar itself is computed
elsewhere — `scripts/lib/progress.mjs` derives it from facts the machine already proves (gates,
stored review rounds, `tasks[].status === 'accepted'`), under the rule that **nothing there may read
a field somebody has to remember to update**. It renders silence when no run exists, and now also
per row: a live run does not make every agent in the session ours, and to say nothing about a row you
must **omit its id** — `content:""` deletes the row from the panel (§V14).

Two rendering facts govern any change to that file. `content` replaces everything right of the
gutter, **including the harness's own `(+N)` descendant suffix**, and the panel draws only *roots* —
so an agent nested under a live director can never be a row of its own. The roster
(`scripts/lib/agent-tree.mjs`) is what puts that information back, and it is the one place taking
**liveness from the payload and parentage from disk**: the task map is ground truth about what is
running, `subagents/` is never pruned, and `spawnDepth`/`parentAgentId` are not serialised into the
payload. Widths are fitted on plain text with an explicit drop rank before colour is applied — the
idle warning silently ate the progress bar until it was (§V14).

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
- **Nothing ends a run for spend, deliberately.** `budgetOverrun()` is gone. It moved a run to
  `BUDGET_EXCEEDED`, which is terminal and which `resume-run.mjs` refuses — so a run that crossed
  the line three quarters of the way through became unfinishable, while the Stop controller printed
  a remedy ("raise it and resume") the resume path rejects (§S1). `costNotice()` in
  `scripts/lib/config.mjs` replaces it and only *reports*, at every transition. Do not reinstate a
  ceiling; `/hyperpowers:abort` is the honest version. What remains are bounds on the *shape* of the
  work, and `describeBounds()` labels each with what actually enforces it — a bound that is neither
  enforced nor named is indistinguishable from one that does not exist.
- A gate verdict is bound to the state it judged. `gateInputDigest()` hashes, **per gate**, the
  artefacts that gate reads plus its rounds, adjudications and blockers; the effective config for the
  two gates that read a bound from it; and the working tree for completion, which is the only gate
  that reads it. A stored `passed` whose inputs have moved is refused, which turns "re-run the
  verifier first" from an instruction into an invariant. Per gate on purpose: one digest over
  everything refused a legal `DESIGN_LOCK → PLAN_DRAFT`. **Everything a gate reads must be in its
  digest** — the plan gate read `maxFilesPerWorkPackage` and hashed no config, and the tree snapshot
  covered untracked *paths* and not their bytes, which in this workflow is the whole deliverable
  (§S30, §S31).
- **A forward edge proves the phase it leaves; a backward edge is the redoing.** `transition()` skips
  the exit gate for any successor earlier in `PHASE_ORDER`, derived rather than declared. Gating the
  recovery edges made a failing completion gate refuse both REMEDIATE answers and leave only BLOCKED,
  which is terminal (§S29).
- Two things only the main thread can do, and one predicate for both. `pendingErrand()` covers
  asking the user (§R1 — `AskUserQuestion` is removed from every subagent) and publishing an
  Artifact (§S21 — a subagent's publication opens on nobody's screen). `SubagentStop` must **allow**
  the director's stop so the errand can leave it; `Stop` must **block** the main thread until it is
  run. Both read the same function, because either polarity backwards strands the run.
- `.hyperpowers.json` is deep-merged over the defaults, so `IMMUTABLE_PATHS` excludes
  `codex.sandbox`, `codex.binary` and `git.mode` — a project could otherwise give the independent
  read-only contradictor write access, or replace it, invisibly, since those files are excluded from
  the review pack. A non-numeric override of a numeric bound is dropped and reported too: `9 >
  "seven"` is `false`, so a mistyped bound deletes itself silently.
- Cost is computed in exactly one place: `scripts/lib/transcript.mjs`, from the session
  transcript (including subagent transcripts, which live in `<session>/subagents/` and not in the
  session file), with Anthropic cache multipliers applied. An unknown model family is priced at the
  *most expensive* tier, never zero. Group by request, never by transcript row — one row per content
  block bills the prompt once per block, which overstated every published figure by ~2× (§P7).
- `verify-completion.mjs` calls `main()` at the very bottom of the file on purpose — a `const`
  declared below the dispatch sat in its temporal dead zone and crashed only inside a real Git
  repository, invisible to the whole suite. Do not move it, and do not declare anything after it.

### The recurring defect class

Most defects recorded in `docs/validation-ledger.md` §K onwards share one shape: **a claim the code
does not enforce** — usually a field one half reads and nothing writes — `state.artifacts.diagramUrl`, task status `accepted`, `residualRisks`,
the §18 extra review round, the `maxSubagents` counter, and `observedUsage` read by two consumers
but stamped by a hook that fired once in 86 minutes. Each made a gate unreachable or a breaker inert
while every test stayed green. When you add a field, a status or a bound, find its producer before
you trust its consumer — and prefer deriving the fact on demand over stamping it.

§U is the same class read from the other end: a guarantee stated in a comment and implemented in some
of the places it names. `refuseIfEnded` was documented as "every verb that writes" and applied to
three of eleven; `may_read` named a schema field that has never existed, in the commit that fixed the
identical defect one field over; two block counters shared one harness ceiling that neither modelled.
**When a comment claims a rule, count the sites** — and where the count is the point, make the count
a test (`NOT_REVIEWED`, the write-verb table, the settable counters derived from the schema).

## Testing conventions

Three genres, each catching what the others cannot:

- **Conformance table** — `tests/git-policy.test.mjs`. 306 cases; extend the policy by adding
  rows. Four files quote that number, **this one included**, and a test fails if any of them drifts
  — plus a sweep for stray counts near the word "case". CLAUDE.md was once the file left out of that
  list, and it was the one that drifted. If you change the table size, update the prose those tests
  point at. `tests/validate.test.mjs` is the same genre for the hand-rolled validator: every shipped
  schema must stay inside the supported keyword subset, and that subset must contain no inert entry.
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

The architecture has a **floor**, best stated in time: everything before the first line of code —
brainstorm, design, two reviews, remediation, plan, two more reviews — has taken on the order of an
hour on a five-line utility and on a 200k-line Django codebase alike. Cost does not track feature
size; it tracks findings to adjudicate and packages to build. Read the figures in
`docs/cost-model.md` and ledger §P3–§P9, §Q11 and §V4–§V10 rather than quoting them here — this file
has already drifted once against a number a test now guards, and `cost-model.md` currently predates
the production run.

Three conclusions are durable, and they govern any change that claims to save money. All three were
re-measured in §V4–§V7 and two of them came back narrower than they had been written.

- **Context, not generation, is the bill** — 65–82% of it across four runs, against 18–35% for
  output tokens (§P8, §Q11, §V6). Output-token share is the thing §6.2 measures, and it is the
  smaller term. But *context* is two terms with two different remedies, and the shipped phrasing
  collapsed them: **cache read** is re-reading what you carry, **cache write** is re-establishing a
  cache that expired, and on the two most recent runs the write term is the larger (46.9% and 42.3%
  against 26.5% and 34.1%). Carrying less context addresses the first; crossing fewer expiry
  windows, or crossing them at a cheaper tier, addresses the second. A subagent's cache expires at
  ~5 minutes and nothing can change that (§T2).
- **Batching independent tool calls is right, and its old sizing was not.** "Tool calls per turn was
  1.00" divided content blocks by tool-bearing transcript rows, and a row never carries two
  `tool_use` blocks — so 1.00 was an identity, not an observation (§V4). Per API request the same
  transcripts measure 1.15–1.26, and 47 of run #1's 321 requests already issued two or more calls.
  Keep the rule in every agent; drop "the largest saving still on the table" and "roughly a quarter
  of the bill", which were computed against a baseline that never existed. This is §P7's
  row-versus-request defect surviving in a second metric — when you fix an accounting bug, count the
  metrics it fed.
- **The dearest thing is a role's total turns across dispatches, not an agent's lifetime.** §Q11's
  execution coordinator outspent all six implementers; on runs 8 and 9 it cost $2.57 against $3.97
  and $6.71 against $6.88, so that one does not generalise (§V5). What does: the director half
  ($19.78–$27.10, 30–40% of a run), and the unnamed centre — the review **adjudicator** role summed
  over its dispatches, $33.55 and 36.7% of run 9, above the director, though no single instance of it
  exceeds $7.51. Production work — implementers, test engineers, the verifier — is 15–19% of spend
  (§V7), which is why §6.2's output-token band regulates about a quarter of the bill and presumes the
  wrong quarter. Tier shares also vary more between two identical runs than any routing prompt has
  moved them, so a routing change validated on one run has proved nothing; turn count survives that
  noise and token share does not.

§S24 records three plausible optimisations that measurement refused — bounding what coordinators
return, compact implementer receipts, forcing parallel work packages. Read it before proposing a
fourth.

So the value proposition is **quality, not price**, and the metric is cost per *correctly
finished* feature. Changes that add orchestration to small work make the tool worse; changes that
make a gate genuinely falsifiable, or remove agent turns, make it better.

## Repository state

`main` carries the history; the working tree normally has staged changes on top of it. `package.json`
is private and versioned separately from the published plugin version in
`.claude-plugin/plugin.json`.

Two things about working here that a live run makes consequential. Hooks execute from
`CLAUDE_PLUGIN_ROOT`, which during development *is* this working tree — so editing a hook or a
controller while a run is in flight invalidates that run's evidence about hook behaviour (§S19 bounds
exactly that). And run data lives in `~/.claude/plugins/data/hyperpowers-*/`, which
`claude plugin uninstall` deletes wholesale, taking a finished run's state, telemetry and artefacts
with it (§S25) — archive the run directory before reinstalling. A `--plugin-dir` development copy and
a marketplace install produce two such directories; `dataRoot()` picks between them by the identity
stamped in `.data-root.json`, falls back to recency only as a flagged tiebreak, and preflight refuses
to start a run on a guess (`dataRootIsAmbiguous()`). Recency is never an identity claim: choosing by
mtime once let an empty directory created by a `plugin install` outrank the one holding every run.
