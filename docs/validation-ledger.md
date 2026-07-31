# Hyperpowers — Spec Validation Ledger

Every load-bearing assumption in `hyperpowers-claude-plugin.md` (in this directory) is recorded here with its
verification method, evidence, and verdict. Nothing in the implementation may depend on a
row marked `UNVERIFIED` without an explicit mitigation.

**Environment under test**

| Component | Version |
| --- | --- |
| Claude Code | 2.1.220 (`~/.local/share/claude/versions/2.1.220`, Mach-O arm64) |
| Node | v26.5.0 |
| Codex CLI | codex-cli 0.145.0 (`/opt/homebrew/bin/codex`) |
| Superpowers plugin | 6.2.0 (`claude-plugins-official`) |
| Codex plugin | 1.0.0 (`openai-codex`) |
| Platform | darwin 25.5.0 |

Evidence sources:
- `BIN` = strings extracted from the Claude Code binary (`strings -a 2.1.220`).
- `EXP` = black-box experiment run against the real CLI.
- `CLI` = command help / live output.

---

## A. Model routing and effort

### A1. `fable` is a valid model alias — **VALIDATED**
`BIN`: frontmatter schema description — *"Model override (`haiku`, `sonnet`, `opus`, `fable`,
or a full ID). Use `inherit` to match the parent conversation."*

Model registry entries confirm `claude-fable-5` (family `fable`, display "Fable 5"),
`claude-opus-5` (family `opus`), `claude-sonnet-5` (family `sonnet`).

### A2. `effort: xhigh` is valid in skill *and* plugin-agent frontmatter — **VALIDATED**
The human-readable description string is **stale** (it says *"`low`, `medium`, `high`, `max`,
or an integer"*), but the actual validator enum is:

```js
VN_ = ["low","medium","high","xhigh","max"]
```

and plugin-agent loading calls the same normaliser:

```js
let H = c.effort, L = H !== undefined ? bq(H) : undefined;
if (H !== undefined && L === undefined)
  warn(`Plugin agent file ${e} has invalid effort '${H}'. Valid options: ${vO.join(", ")} or an integer`);
```

`vO` is the same five-value list. Spec §7.4 profile is implementable as written.

### A3. Effort silently downgrades when unsupported — **VALIDATED (spec gap)**
`BIN`:
```js
if (s === "max"  && !t8e(e)) s = "high";
if (s === "xhigh" && !Pye(e)) s = "high";
```
An `xhigh` request against a model without the `xhigh_effort` capability degrades to `high`
**silently**. Spec §3.2 demands that model/effort degradation be visible. Hyperpowers must
therefore record the *requested* effort and verify the *observed* effort rather than assume.
Observed effort is available: the Stop hook payload carries `effort: {level: "high"}` (see D2).

### A4. Model pricing tiers — **VALIDATED**
`BIN` model registry: Fable 5 `pricing: "tier_10_50"`, Opus 5 `tier_5_25`, Sonnet 5
`tier_3_15` (USD per 1M input/output tokens). Used to recompute §7.2 economics — see §F1.
*(scope: see §V10 — this row validates the per-token tiers and **nothing about cache multipliers**,
which were asserted rather than measured. It is also a list price: Sonnet 5's introductory $2/$10
runs to 2026-08-31 and is deliberately not applied.)*

### A5. Default effort per model — **VALIDATED**
All three of Fable 5 / Opus 5 / Sonnet 5 declare `default_effort: "high"`. Spec §7.4's
"High by default" agrees with the harness default, so the profile is a no-op restatement
rather than an override. Escalation to `xhigh` is the only part that changes behaviour.

---

## B. Skill / agent frontmatter mechanics — the load-bearing experiment

### B1. Skill `model:` is TURN-scoped, not session-scoped — **VALIDATED (spec gap)**
`EXP` — single continuous process, three user messages, `--model sonnet`, project skill
`probe-model` pinning `model: haiku`:

```
init model = claude-sonnet-5
assistant model = claude-sonnet-5   | 'T1'            <- plain message
init model = claude-haiku-4-5       | ''              <- /probe-model
assistant model = claude-haiku-4-5  | 'PROBE_TURN_1'
init model = claude-sonnet-5        | ''              <- plain message
assistant model = claude-sonnet-5   | 'T3'            <- REVERTED
```

The pin is cleared when the user sends the next message — the same lifetime the harness
documents for `disallowed-tools` (*"Cleared when the user sends the next message"*).

> **Caveat on a misleading result.** The same probe run as `claude -p --resume` showed haiku
> persisting into turn 3. That is an artefact of print/resume mode: each `-p` invocation
> persists the live model as the session model on exit. The single-process result above is
> the faithful one for interactive and hook-driven runs.

### B2. The pin SURVIVES Stop-hook continuations — **VALIDATED (architecture-critical)**
`EXP` — same setup plus a project Stop hook returning
`{"decision":"block","reason":"..."}` twice on the skill-pinned turn:

```
assistant model = claude-haiku-4-5 | 'PROBE_TURN_1'
assistant model = claude-haiku-4-5 | 'SKILLCONT_1'   <- forced continuation
assistant model = claude-haiku-4-5 | 'SKILLCONT_2'   <- forced continuation
```

A Stop-hook-forced continuation is **not** "the user sending the next message". The pin
holds for the entire hook-driven autonomous run.

**Consequence for the architecture (spec §10.2 / §11).** The spec's `WAITING_FOR_USER` state
is a latent model-inversion bug: any free-text user reply mid-run clears the Fable pin and
silently drops the director to the session default. The mitigation adopted is recorded in
`docs/adr/0001-single-turn-user-contract.md`.

### B3. Plugin agents ignore `permissionMode`, `hooks`, `mcpServers` — **VALIDATED**
`BIN`, verbatim:
```js
for (let W of ["permissionMode","hooks","mcpServers"])
  if (c[W] !== undefined)
    warn(`Plugin agent file ${e} sets ${W}, which is ignored for plugin agents. `
       + `Use .claude/agents/ for this level of control.`);
```
Confirms spec §21. All cross-cutting guarantees must live in plugin `hooks/hooks.json`
or session settings, never in agent frontmatter.

### B4. Plugin agents DO honour `model`, `effort`, `tools`, `disallowedTools`, `maxTurns` — **VALIDATED**
`BIN`: each is parsed and validated during plugin agent load; `maxTurns` must be a positive
integer. Note `disallowedTools` is documented as *"Ignored if `tools` is set."* — so the
spec's `sonnet-implementer` example (which sets both) relies on `tools` alone to exclude
`Agent`. Hyperpowers omits the redundant `disallowedTools` where `tools` is explicit.

### B5. `disable-model-invocation` blocks the Skill tool — **VALIDATED**
`BIN`: `Skill ${r} cannot be used with ${Hh} tool due to disable-model-invocation`.
Confirms both the spec's entry-point design (§21) and the analysis of
`/codex:adversarial-review` (§8.2 — its command file does set this flag; verified by reading
`commands/adversarial-review.md` directly).

**Consequence:** the Stop controller can never re-enter `/hyperpowers:feature` by name.
Continuation must be driven entirely by on-disk state plus the hook's injected reason text.

---

## C. Subagent nesting

### C1. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` exists; default is 3, not 2 — **VALIDATED**
`BIN`:
```js
function bee() {
  let e = Z.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  if (e !== undefined) return e;
  ... return Ous;                      // feature-gated, defaults to aHu
}
var aHu = 3;
```
Enforcement in the Agent tool:
```js
let m = HI(l.agentContext), g = bee();
if (m >= g) throw new AIe(`Subagent nesting limit reached (depth ${m} of ${g}). ...
  If the user explicitly requested deeper nesting, ask them to raise CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH.`);
```

Setting it to `2` yields exactly the spec's §4.3 tree and is a genuine *tightening* of the
default:

| Depth | Actor | May spawn? |
| --- | --- | --- |
| 0 | Fable (main loop) | yes (`0 >= 2` false) |
| 1 | Opus / direct Sonnet | yes (`1 >= 2` false) |
| 2 | Sonnet under Opus | **no** (`2 >= 2` true) |

So depth-3 delegation is blocked by the harness, not merely by prompt. Spec §4.3 **confirmed**.

### C2. Related caps exist — **VALIDATED**
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` and `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` are real
env vars. Useful as circuit breakers for §18 and not mentioned by the spec.

---

## D. Hooks

### D1. Stop hook `decision: "block"` drives continuation — **VALIDATED**
`EXP`: a Stop hook printing `{"decision":"block","reason":"..."}` on stdout with exit 0
causes the main loop to continue in the same turn, and the injected `reason` reaches the
model (it obeyed "Reply with exactly: SKILLCONT_1"). This is the mechanism that replaces
`/goal` per spec §16.

### D2. Stop hook payload schema — **VALIDATED (observed)**
Observed keys, Claude Code 2.1.220:
```
session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
hook_event_name, stop_hook_active, last_assistant_message,
background_tasks, session_crons
```
- `stop_hook_active` is `false` on the first Stop of a turn and `true` on every subsequent
  one — exactly the loop guard the spec §16.2 requires.
- `effort` is `{level: "<level>"}` when the active model supports effort and **absent**
  otherwise (absent for Haiku 4.5). This gives Hyperpowers a free, authoritative observation
  channel for A3's silent-downgrade problem.
- `last_assistant_message` lets the controller inspect the turn's final output without
  parsing the transcript.

### D3. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` exists — **VALIDATED (name)**
`BIN` help text: *"For Stop/SubagentStop hooks, check `stop_hook_active` in the input and
return success while it's true. Set `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to raise this limit."*
Numeric behaviour measured separately — see D4.

### D4. Block-cap default is 8; the env var raises it — **VALIDATED**
`EXP` — a Stop hook that blocks unconditionally, counting its own invocations:

| Configuration | Hook invocations | Blocks honoured |
| --- | --- | --- |
| default | 9 | 8 |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=3` (process env) | 4 | 3 |
| `env` in project `.claude/settings.json` = 3 | 4 | 3 |
| `settings.env` in `plugin.json` = 3 | 9 | 8 (**ignored**) |

The cap counts *consecutive* blocks within a single turn. Because Hyperpowers runs an entire
feature inside one turn (see B2 / ADR-0001), the cap must cover the whole run — spec §16.2's
suggested `32` is too low for a non-trivial feature. Hyperpowers defaults to `200` and relies
on its own progress detection and circuit breakers for real safety, exactly as §16.2 itself
argues ("Il ne suffira pas d'augmenter le plafond").

### D5. PreToolUse `permissionDecision: "deny"` blocks the tool — **VALIDATED**
`EXP` — hook returning
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny","permissionDecisionReason":"HYPERPOWERS_GIT_POLICY: ..."}}
```
`git status --short` ran; `git commit -m test` was blocked and the model reported the reason
text verbatim. Spec §14.4's deterministic Git policy is implementable.

Observed PreToolUse payload keys:
`session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, tool_name,
tool_input, tool_use_id`.
*(corrected: see §V3 — that key set is a **main-thread** caller's. A call issued from inside a
subagent also carries `agent_id` and `agent_type`.)*

### D6. Hook subprocesses inherit project `settings.json` `env` — **VALIDATED**
`EXP` — with `env: {CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "11", HP_SETTINGS_ENV_PROBE: "..."}` in
project settings, the PreToolUse hook subprocess observed both values in `process.env`.
This gives preflight an authoritative self-check: the hooks can verify their own runtime
contract rather than trusting that setup ran.

### D7. Full hook event list — **VALIDATED**
```
PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification
UserPromptSubmit UserPromptExpansion SessionStart SessionEnd Stop StopFailure
SubagentStart SubagentStop PreCompact PostCompact PermissionRequest
PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted Elicitation
ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded
CwdChanged FileChanged DirectoryAdded MessageDisplay
```
Events the spec does not use but Hyperpowers does: `SessionStart` (rebind the active run),
`PreCompact`/`PostCompact` (spec §23 Risk 7 — durable-artefact reminder across compaction),
`SubagentStart` (stamp the work-package contract), `StopFailure`.

---

## E. Workflows / advisor / bundled skills

### E1. `CLAUDE_CODE_DISABLE_WORKFLOWS` exists and IS documented — **SPEC CLAIM INVALIDATED**
Spec §17 states: *"Hyperpowers ne doit pas dépendre d'une variable non documentée telle que
`CLAUDE_CODE_DISABLE_WORKFLOWS`."*

`BIN` shows the variable is real **and** referenced in the settings-schema description of the
public `disableWorkflows` setting:

> *"Disable the Workflows feature (also via `CLAUDE_CODE_DISABLE_WORKFLOWS`)."*

Moreover `disableWorkflows` is an ordinary settings key, not a managed-settings-only key
(contrast `allowManagedHooksOnly`, whose description explicitly says *"and set in managed
settings"*). The spec's fallback ("bloquer l'outil `Workflow` par permission") is therefore
unnecessary complexity. Hyperpowers uses `disableWorkflows: true` in settings plus the env
var, and keeps a permission deny only as defence in depth.

### E2. `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` exists — **VALIDATED**
Present in the binary's env-var registry. Spec §17 confirmed.

### E3. `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` exists — **VALIDATED**
Present, and the settings schema exposes the equivalent key `includeGitInstructions`
(*"Include built-in commit and PR workflow instructions in Claude's system prompt (default:
true)"*). Setting `includeGitInstructions: false` is the supported, non-env route.

### E4. `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` exists — **VALIDATED**
Settings equivalent `disableBundledSkills`: *"Disable the skills and workflows that ship with
Claude Code... Plugins, `.claude/skills/`, and `.claude/commands/` are unaffected."*
Confirms spec §17's claim that plugin-provided skills survive.

---

## F. Codex

### F1. Model ids `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` are real — **VALIDATED**
`CLI` — `~/.codex/models_cache.json` lists exactly seven models; the three named in spec §8.4
are present with those slugs.

### F2. Supported reasoning efforts — **CORRECTED on re-verification**
The original entry generalised from one model. Re-read from `~/.codex/models_cache.json`:

| Model | `supported_reasoning_levels` | `default_reasoning_level` |
| --- | --- | --- |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, **ultra** | `low` |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, **ultra** | `medium` |
| `gpt-5.6-luna` | low, medium, high, xhigh, max — **no `ultra`** | `medium` |

The first version of this row claimed all three offered `ultra` and all three defaulted to
`low`. Both are true only of Sol. The conclusion is unchanged and, if anything, stronger: the
default differs *per model*, so an invocation that does not pass an explicit effort gets
something unpredictable. Every Hyperpowers round passes both explicitly.

Every effort Hyperpowers actually requests (`high` for Sol, `xhigh` for Luna, including after
the §8.6 fallback) is supported by the model it is sent to.

### F3. `codex exec` supports deterministic, structured, sandboxed invocation — **VALIDATED, better than spec assumed**
`CLI` — `codex exec --help`:

| Flag | Use for Hyperpowers |
| --- | --- |
| `-m, --model <MODEL>` | explicit model, no config dependence |
| `-c, --config <key=value>` | `model_reasoning_effort="high"` per invocation |
| `-s, --sandbox read-only` | enforces the reviewer's read-only contract |
| `--output-schema <FILE>` | **forces the finding JSON shape** — spec §8.3 wanted this |
| `-o, --output-last-message <FILE>` | final message to a file, no stdout scraping |
| `--json` | JSONL event stream for progress/timeout detection |
| `--ignore-user-config` | **fully bypasses `~/.codex/config.toml`** |
| `--skip-git-repo-check` | review of non-repo dirs |
| `-C, --cd <DIR>` | pin the working root |

`--ignore-user-config` resolves spec §8.4 more cleanly than the spec proposes: Hyperpowers
never needs to read, write, or reason about the user's Codex config or project trust level.

### F4. Codex is authenticated locally — **VALIDATED (the config half is a snapshot, not a fact)**
`~/.codex/auth.json` present.

`~/.codex/config.toml` was recorded here as `model = "gpt-5.6-luna"`, `model_reasoning_effort =
"xhigh"`. On re-verification the same file read `gpt-5.6-sol` / `high` — the user edited it in
between, which is exactly the point. A user's Codex config is mutable state outside this
plugin's control, so no row here may depend on its contents. What matters is the invariant:
without `--ignore-user-config` the adapter inherits *whatever that file says today*, and
reviews stop being reproducible. The adapter passes that flag on every invocation.

---

## G. Storage and plugin manifest

### G1. `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_ROOT` exist — **VALIDATED (names)**
Both appear in the binary. Availability *inside spawned hook processes* measured
separately — see G2.

### G2. `${CLAUDE_PLUGIN_DATA}` is a real env var in hook subprocesses — **VALIDATED**
`EXP` — a SessionStart hook from a `--plugin-dir`-loaded plugin dumped its own environment:
```json
{ "CLAUDE_PLUGIN_ROOT": "<plugin dir>",
  "CLAUDE_PLUGIN_DATA": "~/.claude/plugins/data/hptest-inline",
  "CLAUDE_CODE_SESSION_ID": "fb4f3e9e-…" }
```
Spec §20 is implementable as written. Note the leaf directory name is
`<plugin-name>-<source>`, where source is the marketplace name or `inline` for `--plugin-dir`
— so the path differs between a dev run and an installed run. Always resolve it from the env
var, never reconstruct it.

`CLAUDE_CODE_SESSION_ID` is also present, which is what lets a hook map a session to its
active run without any handshake.

### G3. `plugin.json` accepts `dependencies` and `settings` — **VALIDATED (corrected key list)**
The list first recorded here was taken from a string-intern table that mixes agent-frontmatter
and manifest key names together, so it was wrong in both directions. Re-derived by following
the manifest schema itself (`loadPluginManifest` → the merged Zod shapes) the real top-level
keys are:

```
$schema name displayName version description author homepage repository license keywords
defaultEnabled dependencies hooks commands agents skills outputStyles themes workflows
channels mcpServers lspServers monitors settings userConfig binaries experimental
```

Removed as not being manifest fields at all: `compatibility` (an MCPB/DXT manifest error
message), `metadata` (a `marketplace.json` field), `fallback` (does not exist). Added:
`$schema`, `binaries`.

Nothing downstream changes — Hyperpowers only uses `dependencies` and, indirectly, `settings`,
both of which are confirmed below — but a ledger whose evidence is wrong is a ledger that
cannot be trusted on the rows nobody re-checks.
### G3b. Plugin dependencies: the *string* form strips semver — **SPEC PARTIALLY CONFIRMED (row corrected)**
Spec §22 states: *"Claude Code permet aux plugins de déclarer des dépendances accompagnées de
contraintes semver."*

**This row previously read "SPEC CLAIM INVALIDATED" and was wrong in the general case.** The
evidence below is accurate but covers only the string form. Independently re-derived from the
2.1.220 binary, twice, with the decisive detail that two earlier passes missed: the Zod object
branch declares only `{ name, marketplace }` and `.transform()`s the object down to a bare
string, which is why reading the schema alone says "no version support". A *separate* raw-JSON
reader runs beside it:

```js
let i = "version" in n && typeof n.version === "string" ? n.version : void 0,
    s = "sha"     in n && typeof n.sha     === "string" ? n.sha     : void 0;
if (i === void 0 && s === void 0) continue;
r.set(l, { version: i, sha: s });           // → the plugin record's depConstraints
```

and the resolver enforces it with the bundled `semver`:

```js
let g = c.depConstraints?.get(u)?.version;
if (g !== void 0 && !b_o(y, g))
  m = { type: "dependency-version-unsatisfied", required: g, installed: y };
```
`b_o` is `semver.satisfies`. So the range is real, at ordinary load time, with a human-readable
diagnostic (*"Requires X ^6.2.0, installed 6.1.0"* / *"Update X to satisfy ^6.2.0, or uninstall
Y"*).

**Two caveats the correction should carry.** The version check only runs on the branch where the
dependency id is marketplace-qualified, so a `--plugin-dir` development load skips it entirely —
the constraint is silently absent exactly where a developer is most likely to be testing it. And
`version` is honoured by a reader that no schema, on disk or in `.describe()` text, documents:
the field is invisible to anything that inspects the manifest schema, which is how three separate
verification passes read it as unsupported.

**Method note, because it generalises.** Two independent reviewers concluded "no semver support"
from the Zod definition and were both wrong, because the enforcement does not live where the
validation lives. Reading a schema tells you what is *accepted*; only reading the consumer tells
you what is *used*.

So the accurate statement is narrower: a semver range appended to the **string** form
(`"superpowers@^6.2.0"`) is silently stripped, which is what the evidence below shows. The spec's
claim that plugins may declare semver-constrained dependencies is correct; the mechanism is the
object form.

**What this changes in the implementation: nothing, deliberately — but for a narrower reason than
first written.** An earlier version of this paragraph said the object form was "worth adopting
the day the harness surfaces a diagnosable failure for it". That day has already passed: the
`dependency-version-unsatisfied` message quoted above is diagnosable, and saying otherwise
overstated the case for the status quo.

The reasons that do survive: a manifest constraint disables the plugin, and J2 measured that a
disabled Hyperpowers is *invisible* in the session that needed it — `/hyperpowers:status` returns
"Unknown command" and no agents appear, whatever diagnostic the plugin subsystem produced
elsewhere. Preflight instead names the installed version, the supported range and the remedy, in
the place the user is already looking. And the manifest check is skipped for `--plugin-dir` loads,
so it would not hold during development anyway.

Adopting the object form *in addition* is worth doing once someone has confirmed where the
harness surfaces that message to an ordinary user. Belt and braces is fine; replacing the
braces with a belt that may be behind a wall is not.

The original evidence, which stands for the string form:
```js
dependencies: E.array(Yxh()).optional()
  .describe(`Plugins that must be enabled for this plugin to function. `
          + `Bare names (no "@marketplace") are resolved against the declaring plugin's own marketplace.`)

Yxh = E.union([
  E.string().regex(Kxh, "Dependency must be a plugin name, optionally qualified with @marketplace")
            .transform(e => e.replace(/@\^[^@]*$/, "")),      // <-- semver range discarded
  E.object({ name: …, marketplace: … }).transform(e => e.marketplace ? `${e.name}@${e.marketplace}` : e.name)
])
```

In the string form a dependency is an **enable-check only**. Writing
`"superpowers@claude-plugins-official@^6.2.0"` does not constrain anything — the `@^6.2.0` is
stripped before use. (The object form is where a `version` range is honoured; see the correction
above.)

**Consequence.** Spec §22's requirement to "vérifier une version compatible … refuser de
démarrer si une version inconnue modifie substantiellement les contrats attendus" is implemented
**in preflight code**, by reading the installed Superpowers `plugin.json` version and checking it
against a compatibility range Hyperpowers owns. That is what `scripts/preflight.mjs` does, and it
remains the right place even now that the manifest can express a range, because a manifest-level
failure disables the plugin without saying why (J2).

Whether `settings` can contribute `env` is measured separately — see G4.

### G4. `plugin.json` `settings` CANNOT contribute `env` — **INVALIDATED (design-forcing)**
Schema in `BIN`:
```js
settings: E.record(E.string(), E.unknown()).optional()
  .describe("Settings to merge into the user settings while this plugin is enabled. "
          + "Only the documented allowlisted keys are applied.")
```
`EXP` (see D4 table): `settings.env` in `plugin.json` had **no effect** on
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, while the identical `env` block in project
`.claude/settings.json` did. `env` is not on the allowlist.

**Consequence.** Hyperpowers cannot self-configure its runtime environment. `/hyperpowers:setup`
is **mandatory** and must write project `.claude/settings.json`. Whether a restart is then
required is *not* documented — the settings file is hot-reloaded for most keys and `env` is not
named in the read-once list — so neither setup nor this ledger asserts one. Both check whether
the variables are live in the running process and report the answer. Preflight refuses to run (state `BLOCKED`) when the
environment contract is unmet, using D6 to check it authoritatively.

---

## H. Superpowers 6.2.0 contract conflicts — **VALIDATED by reading the installed skills**

The spec (§12, §22) assumes Superpowers skills can be invoked with an override layer. Reading
the installed 6.2.0 skills confirms this is necessary and identifies the exact conflicts:

| Skill | Conflicting instruction | Hyperpowers override |
| --- | --- | --- |
| `brainstorming` | `<HARD-GATE>` requires **user approval** of the design before any implementation | Replaced by the autonomous `DESIGN_LOCK` gate (spec §10.4) |
| `brainstorming` | Step 6 "Write design doc … **and commit**" | Commit forbidden (§14); artefact written to the run dir |
| `brainstorming` | Step 8 "**User reviews written spec**" | Replaced by Codex rounds 1–2 + Fable gate |
| `brainstorming` | "ask questions **one at a time**" across messages | Single-turn `AskUserQuestion` batches (ADR-0001) |
| `writing-plans` | "DRY. YAGNI. TDD. **Frequent commits.**" and a `Commit` step | Commit steps removed; evidence replaces commits |
| `writing-plans` | Assumes an isolated worktree | Worktrees forbidden (§2); file-ownership locks instead (§15) |
| `executing-plans` | Step 1 requires `superpowers:using-git-worktrees` | Forbidden; replaced by the Hyperpowers workspace check |
| `executing-plans` | "If subagents are available, use `subagent-driven-development` **instead**" | Explicitly overridden — spec §2 forbids that skill |
| `executing-plans` | Step 3 requires `finishing-a-development-branch` | Replaced by `SYSTEM_VERIFICATION` → Codex 5/6 → `FINAL_ACCEPTANCE` |

These nine conflicts are the concrete content of the "surcouche" the spec calls for; they are
enumerated in `skills/feature/references/superpowers-adaptation.md`.

---

## J. End-to-end verification of the built plugin

All of the following were run against the real CLI with `--plugin-dir`, not simulated.

### J1. The plugin loads and registers — **VERIFIED (re-run at 11 agents)**
Eleven agents register, namespaced by the harness. Re-verified live after each agent was added,
because "the plugin loads" is a claim about a specific set of files and stops being evidence the
moment that set changes:
```
hyperpowers:fable-gate-reviewer         hyperpowers:opus-review-adjudicator
hyperpowers:opus-adjudicator-xhigh      hyperpowers:sonnet-implementer
hyperpowers:opus-design-coordinator     hyperpowers:sonnet-implementer-xhigh
hyperpowers:opus-execution-coordinator  hyperpowers:sonnet-researcher
hyperpowers:opus-plan-coordinator       hyperpowers:sonnet-test-engineer
                                        hyperpowers:sonnet-verifier
```
The plugin prefix is added automatically, so agent `name:` fields must **not** repeat it — the
first build produced `hyperpowers:hyperpowers-sonnet-researcher` and was corrected.

**Delegation depth is part of what "registers correctly" means.** With
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` the harness refuses a dispatch from depth 2 (C1), so an
agent's `tools:` list has to match where it sits in the tree. Every agent holding `Agent` is
dispatched by the director and therefore at depth 1; every agent at depth 2 has no `Agent` tool.
The `-xhigh` agents are dispatched by a coordinator, which is why neither carries one — a tool an
agent can never successfully use is a runtime error waiting for the escalation path that needs
it most.

### J2. `dependencies` is enforced as a silent load gate — **VERIFIED (useful behaviour)**
With Superpowers not enabled, the plugin does not load at all: `/hyperpowers:status` returns
*"Unknown command"*, and no agents appear. Enabling Superpowers makes everything appear.

This is the desired contract (spec §22 — refuse to start without the method dependency), but it
fails **silently**: there is no message explaining why the plugin is absent. Documented in the
README so the failure is diagnosable.

### J3. The Git policy hook fires in a live session — **VERIFIED**
Asked to run `git commit -m probe` in a real session with the plugin loaded, the model reported:

> *"The Hyperpowers Git policy blocks `git commit` commands — git is read-only for this run;
> you'll need to perform any commits yourself."*

The `PreToolUse` deny reached the model with the intended reason text.

### J4. The Codex adapter completes a real review — **VERIFIED**
A live `design-1` round (Sol, high) against a deliberately flawed design returned
schema-conforming JSON on the first attempt, verdict `blocker`, five findings, four blocking:
process-local counters behind a load balancer; a fixed-window reset that does not enforce a
rolling minute; the GIL not making a compound read-increment-check atomic; an undefined
`client_id` trust model; and — notably — that two of the acceptance criteria were not
falsifiable. `coverage_notes` correctly reported that the repository was empty.

Finding ids were normalised to `DESIGN-001…005`, which is what lets round 2 verify round 1 by id.

### J5. Review latency — **MEASURED**
`tests/bench/review-latency.mjs`, gpt-5.6-luna, small pack (~1.4 KB):

| Effort | Seconds | Findings | Tokens |
| --- | ---: | ---: | ---: |
| low | 21.4 | 5 | 14,372 |
| high | 41.7 | 4 | 16,973 |

A separate Sol/high round on the same size of pack took **178 s**.

Two consequences:

- Latency is dominated by reasoning effort and model, **not** pack size — a 1.4 KB pack still
  took three minutes on Sol/high. Shrinking the pack is therefore a defence against the
  non-return failure mode (spec §23 Risk 5), not a speed optimisation.
- Six rounds cost roughly 3–18 minutes of critical path depending on routing. The 15-minute
  per-invocation timeout is appropriately sized; a much shorter one would produce spurious
  failures on Sol.

### J6. The shipped configuration pins Fable across plugin-hook continuations — **VERIFIED**

B1/B2 were measured with a *project* skill pinning *haiku* and a *project-settings* Stop hook.
The shipped system differs on four axes, so the experiment was repeated on the real thing: a
**plugin** skill with `model: fable`, `effort: high`, `disable-model-invocation: true`, invoked
as `/fp:run`, with that **plugin's own** `hooks/hooks.json` Stop hook blocking twice.

Transcript, per assistant message:

```
claude-fable-5 | 'FABLE_TURN_1'
claude-fable-5 | 'FABLE_CONT_1'   <- plugin-hook forced continuation
claude-fable-5 | 'FABLE_CONT_2'   <- plugin-hook forced continuation
```

Hook payload on all three: `effort: {level: "high"}` — the skill's pinned effort, **not** the
session default of `xhigh`. So a plugin skill's `model:` *and* `effort:` both take effect and
both survive hook-forced continuations.

This matters because plugin-sourced files do have fields stripped elsewhere: plugin *agents*
ignore `permissionMode`, `hooks` and `mcpServers` (B3). `model` on a plugin *skill* is not
subject to that, and is now observed rather than assumed.

**No Fable consent or credits gate fired.** The binary contains
`fableCreditsRequired`, `fableConsentSessionFallback`, `fableConsentDialogInteracted` and
`CLAUDE_CODE_FABLE_BRIDGE_DIALOG_TIMEOUT_MS`, which suggested a possible interactive gate with a
fallback path — exactly the silent downgrade spec §3.2 forbids. It did not trigger on this
account in a non-interactive run. It is not proven absent for all accounts, which is precisely
why the Stop controller reads the transcript every continuation and raises `model_mismatch` if
the director tier is not the configured model.

ADR-0001 now rests on the shipped configuration, not an analogue.

### J7. Test suite — **all passing**
`npm test`: 306 Git-policy conformance cases, state-machine and hook integration tests (driving
the real scripts as subprocesses with real hook payloads), gate-reachability tests, an
end-to-end run-lifecycle walk, and schema/validator tests. `npm run docs:check` verifies the
generated workflow reference matches the state machine.

The gate-reachability suite was added after review and immediately earned its place: it caught
that **`COMPLETE` was unreachable**. `verify-completion.mjs` read `state.artifacts.diagramUrl`
for spec §13 condition 14, but nothing in the system could ever write it — so the completion
gate always failed, `FINAL_ACCEPTANCE` could never be exited, and every run would have ended
`BLOCKED` after the stall detector fired. Fixed by adding `state-machine.mjs artifact`.

It also caught a second defect: a failing `git diff --name-only` returns multi-line usage text,
which the scope-drift check was parsing as filenames and reporting as out-of-scope changes.
`gitTry`/`gitLines` now return `null` on failure, so "could not determine" is distinguishable
from "nothing changed".

---

## K. Post-build audit — defects found after the ledger was first written

An independent audit re-derived every row above from the binary and re-probed the Git policy
outside its own conformance table. Sections A–E and G3b/G4 held verbatim; F2, F4 and G3 were
corrected in place above. The audit also found nine defects in the *implementation*, of which
three would have stopped any real run:

| # | Defect | Consequence | Fix |
| --- | --- | --- | --- |
| K1 | The PreToolUse policy was unscoped | Installing the plugin removed `git commit` and the `Workflow` tool from **every session in every project**, permanently, while the denial text claimed a run was in progress | Scoped to a bound, non-terminal run; `git.enforce: "always"` restores the old behaviour deliberately |
| K2 | Every blocked attempt was logged `policy_violation` | One blocked `git commit` — or a blocked `Workflow` call — permanently failed §13.11, and telemetry is append-only, so the run could never recover. Prevention working read as a breach | Denials emit `policy_blocked`; `policy_violation` is reserved for drift the PostToolUse guard actually detected |
| K3 | Nothing could set a task to `accepted` | `EXECUTION` was unexitable. Every run would have stalled there until the progress detector transitioned it to `BLOCKED` — the same defect class as the `diagramUrl` one below, in a second place | `state-machine.mjs task`, which also revives the SubagentStop report check by giving `in_progress` a producer |
| K4 | 26 Git-policy bypasses | `ssh`/`docker exec`/`kubectl exec` reaching the same repo; `$G commit` after `G=git`; `GIT_PAGER="…" git -p log` as arbitrary code execution; `export GIT_DIR=…`; `Git commit` and `.GIT/config` on a case-insensitive volume; `>> .git/config`; `env -S`; `jj op undo`; `git -C ~` | All 26 denied and added to the conformance table |
| K5 | Three Git-policy false positives | `git ls-remote` and `git symbolic-ref HEAD` refused; any heredoc whose *body text* mentions a git command refused, and a body containing a stray quote made the whole command "unparseable" | Heredoc bodies are parsed as data; both reads allowed |
| K6 | `maxCostUsd`, `maxWorkPackages`, `maxAgentsPerRun` could never fire | No `usage` event is emitted anywhere, and the two counters were never incremented. Three of four circuit breakers were inert; only the duration bound worked | Cost read from the measured transcript; real counters; advisory-only bounds labelled as such rather than pretending to be mechanical |
| K7 | `escalated_to_fable` / `needs_evidence` auto-resolved | A **blocking** finding could be closed by escalating it, and Fable never had to decide — the exact move the ledger exists to prevent | Both now require an explicit resolution |
| K8 | SessionStart auto-bound any session to an unfinished run | A run interrupted with Escape captured the next unrelated session in that project and blocked every turn-end until the user found `/hyperpowers:abort` | SessionStart reports; only `/hyperpowers:resume` adopts |
| K9 | `runHook`'s 25 s internal timeout exceeded the 15 s and 20 s declared in `hooks.json` | The harness would kill the fail-closed Git hook before it could emit its deny — failing *open* | Per-hook budgets, each inside its declaration |

Two smaller ones: `13.12` ("no fallback concealed") was a hardcoded pass and is now falsifiable
against the review record; and the `criteria-falsifiable` heuristic was anchored to the end of
the statement, so "the limiter works correctly under concurrent load" passed it.

`tests/run-lifecycle.test.mjs` now walks `PREFLIGHT → COMPLETE` using only commands an agent is
told to run, with no hand-written state. That is what K3 needed and what the existing gate suite
structurally could not provide: it hand-writes `status: "accepted"` into its fixture, so it
proves the gates are *checkable* while assuming away the question of whether they are reachable.

---

## L. Second independent audit — defects found after the build was declared complete

A full re-audit ran against the finished plugin: six parallel reviews (spec conformance, Git
policy, state machine, Codex adapter, markdown surface, plus a documentation fact-check against
the published Claude Code docs), each re-deriving its conclusions from the code rather than from
this ledger. Sections A–H held, with three corrections made in place (G3b above, and the two
documentation claims in L10/L11 below).

**Two defects would have let a run declare success it had not earned.** Both were present in the
original build, not introduced by section K — the `isTerminal(to)` gate exemption and the
`gate --pass` verb are in the first version of `state.mjs` and `state-machine.mjs`. What section
K changed is that they became *reachable*: until `EXECUTION` could be exited, no run could arrive
at `FINAL_ACCEPTANCE` at all, so an unbinding completion gate had nothing to fail to bind.

That distinction is the part worth remembering, and it cuts against the reviewer as much as the
author. Making a path reachable does not create the defects along it, but it is the moment they
start mattering — and section K's own reachability test walked `PREFLIGHT → COMPLETE` calling the
gate *explicitly* and asserting it passed, which is exactly the shape that cannot notice the
transition never consulted it. A test that performs the check it is verifying will always find
the check performed.

| # | Defect | Consequence | Fix |
| --- | --- | --- | --- |
| L1 | **The completion gate was not binding.** Terminal phases skip their exit requirements so `BLOCKED` is always reachable — and `COMPLETE` is terminal | `FINAL_ACCEPTANCE → COMPLETE` never checked `gate:completion`. All fourteen §13 conditions were computed and then ignored at the only moment they decide anything | `COMPLETE` is excluded from the exemption; failure terminals keep it. Two regression tests: success refused on a failing gate, `BLOCKED` still unconditional |
| L2 | **A second path to an unearned `COMPLETE`**: `state-machine.mjs gate --name completion --pass` wrote the verdict from a flag | Gate passage forgeable without ever running the verifier | Verb deleted; gate verdicts are written only by `verify-completion.mjs`, which computes them |
| L3 | **Stall detection still defeatable** — `attempts` was in the progress signature, and re-declaring a package `in_progress` increments it | A coordinator looping on the same failing package minted a fresh signature every cycle and never escalated. Same class as the `revision` defect in K, one field over | Signature keyed on submitted reports, not attempts. Attempting is not progress |
| L4 | **A corrupt session pointer bricked the project.** `activeRunId` propagated a JSON parse error into the fail-closed Git hook | One truncated file denied *every* Bash, Write and Edit call in that project, in every session, until deleted by hand | An unreadable pointer means "no run bound", never an error |
| L5 | **Targeted review packs dropped their own subject.** Truncation zeroed the budget after the first oversized section; stable sort placed the round-1 findings and adjudication record last | A round-2 reviewer could verify corrections without ever seeing the findings it was verifying — announced only in a coverage note | Mandatory context is priority `-1`; truncation debits actual cost; a targeted round whose §8.7 context was dropped now fails loudly |
| L6 | **Three Git-policy bypasses sharing one root cause**: the classifier trusted the *name* in command position as the program's identity | `git() { … }` rebinding, `PATH=` poisoning, and `/tmp/evil/git` each returned a confident `allow` for a validated "read" that ran something else | Function definitions denied; `PATH` and loader variables join the forbidden set; path-qualified VCS binaries outside standard locations refused. All in the table, and re-verified live |
| L7 | **`SubagentStop` fired for every subagent** and never read `agent_type` | An unrelated agent finishing during `EXECUTION` consumed the one-shot report reminder, disarming §16.4 for the package that needed it | Filtered to implementers; the correction budget is shared with the submit validator, which also now *counts* rejections instead of only claiming to |
| L8 | **The schema validator advertised keywords it did not implement** (`propertyNames`, `prefixItems`), and its support scan never entered `$defs` | A constraint that silently did nothing, with green tests either side of it | Both removed from the supported set; traversal reaches `$defs` and object-form `additionalProperties`; a new test proves every advertised keyword actually rejects something |
| L9 | **`residualRisks` had three readers and no writer** | An out-of-scope finding "recorded as a residual risk" vanished from the final report and the gate summary. Same shape as K3 and the `diagramUrl` defect | `state-machine.mjs risk --add`, wired into the adjudicator's own instructions |
| L10 | **The §18 extra review round could not be run.** `REVIEW_ROUNDS` held six fixed entries and the adapter rejected every other name | The one circuit breaker the routing policy tells the coordinator to use did not exist. A rule that cannot be obeyed is not a bound | `<artifact>-extra` rounds, verifying round 2 as round 2 verifies round 1, capped by `maxExtraReviewsPerArtifact` and enforced by the adapter |
| L11 | **Per-task effort escalation was unreachable.** A plugin agent's `effort` is fixed in frontmatter, so "retry at xhigh" had no mechanism | Step two of the §18 ladder was decorative text | `hyperpowers:sonnet-implementer-xhigh`, with a diagnostic obligation before it writes anything |

Also fixed: `EnterWorktree`/`ExitWorktree` bypassed the worktree ban entirely (Bash `git worktree`
was denied, the native tools were not); work-package telemetry triple-counted every package and
hardcoded `tier: 'sonnet'`, so the §6.2 distribution could not show Opus's real share — the one
measurement the 1–3–9 claim rests on; adjudications could arrive pre-`resolved`, skipping the
evidence step the ledger exists to impose; the stale-lock threshold (30 s) exceeded the retry
budget (5 s), so a lock left by a killed process was never reclaimed and the Stop hook failed
*open* during recovery; a corrupt `state.json` silently un-governed a run; `resume` bound the
newest run rather than the suspended one and could give two sessions the same run; the review
prompt frame was forgeable from reviewed content; timeouts killed only the immediate child;
`FINAL_ACCEPTANCE` had no path back to `SYSTEM_VERIFICATION` when the *evidence* rather than the
code was deficient; presence-only exit gates let an empty `tasks.json` burn two mandatory Codex
rounds; and unknown model families were priced at $0, making their tokens invisible to the cost
breaker.

### L12. `PreCompact` cannot inject context — **IMPLEMENTATION CLAIM INVALIDATED**
The hook was registered on `PreCompact` with `additionalContext`, but that event only decides
whether compaction proceeds. The "persist before you lose this" reminder was written into a
channel nothing reads. `SessionStart` fires *after* compaction (source `compact`) with the empty
matcher already in use, so the working channel was always there. The dead registration is
removed rather than left as reassuring decoration.

### L13. Two §16.5 duties are not implemented — **now disclosed rather than silent**
General destructive-command limits and allowed-path confinement are absent. They were the only
limits in this codebase that were neither implemented nor stated, which for a project whose whole
argument is "state the boundary" is the defect. `references/git-policy.md` now says so, and says
where to configure them if you want them.

---

## M. Third audit — reviewing the review

The section L work was itself re-audited: every claim re-derived from the code, the Git policy
probed a fourth time, and the two headline fixes confirmed by driving the real CLI — a forced
`FINAL_ACCEPTANCE → COMPLETE` is refused with both unmet requirements named, `BLOCKED` still
transitions unconditionally, and the `gate` verb is gone. G3b was re-verified from the binary a
third time and the L correction to it was upheld (see the method note there). Sections A–L
otherwise hold. Three corrections and three defects:

| # | Finding | Status |
| --- | --- | --- |
| M1 | **A `<artifact>-extra` round's findings could be dropped entirely.** `checkReviewCycle` scoped its adjudication loop to the six mandatory rounds, so an extra round could raise a *critical blocking* finding, have it decided by nobody, and the completion gate still passed — reproduced against the real verifier | Fixed. Any extra round that ran is now accounted for exactly like a mandatory one. Regression test added |
| M2 | **L1/L2 were not "introduced by the fixes in section K".** Both are in the original build; K made them *reachable* by making `EXECUTION` exitable | Corrected in place above |
| M3 | **Opus `xhigh` became unreachable.** L's fix dropped the adjudicator from `xhigh` to `high` — correct on cost — but pointed its escalation at `opus-execution-coordinator`, which is also `high`. No Opus agent ran at `xhigh`, so spec §7.3's Opus escalation was decorative text: the same defect L11 had just fixed one tier down | Fixed: `hyperpowers:opus-adjudicator-xhigh`, scoped to a single finding |
| M4 | **`13.4c-runtime` was a gate check with no producer.** `sonnet-verifier` was never told to record a `runtime` check, so the condition could only ever report `unverifiable` | Fixed: the verifier now owes a `runtime` result or an explicit `absent` with a reason. Spec §12 phase 5 asked for it all along |
| M5 | **A fourth Git-policy probe found the worst set yet.** Shell reserved words are grammar, not programs: `then`, `do` and `!` were classified as unknown *programs*, fell through to `ALLOW`, and what followed them — the actual command — was never inspected. `! git commit` defeated the whole policy in one token; `if true; then rm -rf .git; fi` also slipped the `.git` file-writer guard, keyed on the same first word. Plus `trap 'git push' EXIT` (payload in an argument) and `bash <<'EOF' … git push … EOF` / `bash <<< "git push"` — the last one created by L5's own fix, which correctly made heredoc bodies *data* without distinguishing `cat <<EOF > file` from `bash <<EOF` | All fixed and in the table. Reserved words stripped and the remainder classified; `trap`'s argument classified like `eval`'s; stdin text reaching a shell binary classified as the script it is |
| M6 | **The largest false-positive cluster to date.** The `branch`/`tag` listing rule matched the literal `--list` and fired on *any* positional, so `git tag -l 'v1.*'`, `git branch --contains HEAD` and `git branch --merged main` were denied — everyday reads, and the rule contradicted its own `requireAnyFlag` list. Every positional-bearing row in the table used `--list`, which is why four rounds missed it | Fixed: `-l` accepted as a synonym, and positionals consumed by a read-only value flag no longer count as ref names |

Smaller: `MultiEdit` was dropped from the PreToolUse matcher — this build does not expose it, but
the binary's permission normaliser still recognises the name, and listing a tool that never fires
costs nothing while omitting one that does is an unguarded write into `.git/`; restored. The
conformance-table size, quoted in three documents, had gone stale in all three across three
rounds — the table now checks its own documented count, because a number nobody verifies is a
number that drifts.

**The pattern across L and M is the same one, at a different level.** L found that section K's
fixes had not been checked for what they made reachable. M found that L's fixes had not been
either: the extra round was implemented without extending the gate that governs rounds, and the
effort escalation was fixed for Sonnet in the same breath as it was removed for Opus. Every round
of fixes has introduced the defect class it had just finished fixing. That is not a criticism of
any round — it is the argument for the adversarial structure the plugin is built around,
observed on the plugin itself.

The corollary for anyone auditing this next: **the fixes are the least-reviewed code in the
repository.** Each round's changes are written after the round's own scrutiny has been spent, and
they ship without passing through the process that found what they are fixing. Read them first.

---

## N. Fourth audit — an external reviewer, and the defect underneath all of them

Codex reviewed the section-M work independently and raised nine findings. **All nine were real**;
every one was reproduced against the code before anything was changed. Two carried nuance rather
than error: `.git/config` being unfingerprinted was already *disclosed* as a boundary rather than
missed, and the deliberate refusal to escalate index-mtime-only drift is a documented
anti-cry-wolf decision, not an oversight. Its suggested alternative for N5 — reject dirty
workspaces — was declined; most repositories people work in are dirty, and refusing to start is a
worse trade than measuring correctly.

| # | Finding | Status |
| --- | --- | --- |
| N1 | **Detection outlived prevention.** `git-policy.mjs` releases Git in a stop-allowed phase; `git-guard.mjs` checked only that a run existed, so it kept fingerprinting after the policy had handed Git back. A user who committed during a suspension — which the policy explicitly permits — had it recorded as `policy_violation`, and telemetry is append-only, so §13.11 failed for the rest of the run. After `COMPLETE` or `ABORTED` the writes landed in a finished run's record | Fixed: both halves read `stopAllowed`. The snapshot is still refreshed while released, and resume clears it so the first observation after a resume is a fresh baseline rather than an indictment |
| N2 | **The index fingerprint could not see content.** `git diff --name-status --cached` reports `M f.txt` before *and* after a script replaces the staged blob, so re-staging different content under the same path moved nothing material. Reproduced | Fixed: `--raw`, which carries both blob SHAs. The local config is now hashed too, as **observed** drift — see N2b |
| N2b | **Config drift must be seen and must not escalate.** The first version of the N2 fix escalated it, on the strength of a stability measurement taken in *this* repository — which has no Git hook manager. A cold `npm install` in any project using husky or lefthook sets `core.hooksPath`: measured, and it moves the hash on the first install only. Escalating would have ended a healthy run at §13.11, unretractably, for a package manager doing exactly what the project asked | Fixed before shipping: drift is split into `escalating` and `observed`. Config drift is recorded in `state.gitDrift`, named to the model immediately and printed in the final report, but never fails condition 11. A key allowlist cannot rescue escalation — `core.hooksPath` is at once the benign case and the most direct hijack |
| N2c | **The fix to N2b was itself wrong, and measuring caught it.** Making the non-escalating category real meant recording index-refresh drift — which the original code had *claimed* to record and in fact discarded. Recording it produced 5 entries from 12 ordinary read cycles, because every read refreshes the index and the guard's own fingerprinting is a read | Index-refresh drift is now tracked nowhere, and the code and docs say so. The original behaviour was right and only its comment was wrong; correcting the comment to match the code would have been the one-word fix, and correcting the code to match the comment made a guard that reports on itself. Both the field and its `statSync` are gone |
| N3 | **The targeted-round context guard read the wrong branch, twice.** Mandatory sections sit at priority -1 *so that they are truncated rather than dropped* — and the guard checked only `droppedMandatory`. Worse, the half-size retry pack was not checked at all, on the path where losing context is most likely | Fixed: truncation of a mandatory section is a failure like dropping it, and the retry is refused rather than sent blind |
| N4 | **Resume forked a run instead of moving it.** Hooks resolve their run through the session pointer and never consult `state.sessionId`, so writing a new pointer without removing the old left two sessions driving one state machine | Fixed by sweeping every pointer naming the run, not just the one the state file remembers — `--force` already made multi-hop orphans reachable. The sweep lives in `bindSession` itself rather than in `resume`, so exclusivity is a property of establishing ownership and not a rule the next caller has to remember. `unbindSession` had existed, exported, with zero callers |
| N5 | **A dirty working tree made completion unreachable.** §13.10 compared *every* modified and untracked file against work-package ownership, so any pre-existing edit read as scope drift and no run started in a normal repository could pass its own gate | Fixed: `init` records a content fingerprint of the already-dirty files; unchanged ones are excused *and the exclusion is disclosed in the condition*, while one the run later edits still fails. Hashes rather than a name list, or the files easiest to hide drift in would become the ones nothing looks at |
| N6 | **`work-package.schema.json` had no consumer.** The plan gate checked coverage, verifiability, dependencies and ownership — the properties it needed for its own reasoning — and never whether the contract a Sonnet would actually receive was complete. A package with an id, one criterion and a command passed while lacking objective, interfaces, constraints and exclusions | Fixed at the gate, and in the producer prompt in the same change: enforcing a contract whose author was never told to satisfy it would have been this project's recurring defect inverted |
| N7 | **The pack cap counted bytes and truncated code units.** A 10,000-byte cap produced 17,772 bytes of accented text and 26,397 of CJK — measured. The §23 Risk 5 mitigation was defeated on precisely the projects whose artefacts are not in English | Fixed with a UTF-8-boundary-safe cut; the coverage notice is now clamped to its own allowance too, so the banner announcing the cap cannot break it |
| N8 | **Codex state was read from the wrong directory.** Preflight hardcoded `~/.codex` while the CLI resolves `$CODEX_HOME` | Fixed. The CLI's own help for the flag the adapter always passes says it: `--ignore-user-config` skips `$CODEX_HOME/config.toml` but "auth still uses `CODEX_HOME`". Confirmed empirically — an empty `CODEX_HOME` fails a review with 401 while `~/.codex/auth.json` sits valid |
| N9 | **Extra rounds were missing from the final report.** M1 taught the completion gate about `<artifact>-extra`; nothing taught the report | Fixed there and in preflight's model check. The class was swept rather than the instance: every reader of `REVIEW_ROUNDS` was audited and decided individually |

### N10. The defect none of the four rounds found — **the completion gate could not run**

Reproducing N5 surfaced something no reviewer had reported, in code that predates every round of
this audit:

```
ReferenceError: Cannot access 'HYPERPOWERS_OWN_FILES' before initialization
    at changedFiles (verify-completion.mjs:415)
    at completionGate (verify-completion.mjs:255)
```

The module dispatched its gates at line 38 and declared that constant at line 409. A `const` is in
its temporal dead zone until execution reaches it, so `changedFiles()` threw the moment it got as
far as consulting the set — **which happened only when Git answered**. Every fixture in the suite
is a plain temporary directory, so `changedFiles()` returned `null` early and the crash was
invisible to 358 passing tests, to three internal audit rounds, and to an external reviewer.

The consequence was total: `verify-completion.mjs` is the only writer of the completion verdict,
`FINAL_ACCEPTANCE` cannot be left without one, so **no run could ever have reached `COMPLETE` in
the environment Hyperpowers is built for.** Verified against the staged tree, not merely the
edited one.

Hoisting the constant would have fixed the instance; the dispatch was moved to the bottom of the
module instead, so every declaration is initialised before any of it runs and the next constant
someone adds below cannot resurrect it. The durable fix is the test: the suite now drives the
gates **inside a real Git repository**, and those tests fail against the pre-fix tree with
"the gate produced no JSON — it crashed".

**The lesson is not about temporal dead zones.** Every round of this audit — including the
external one — read code and reasoned about it. The environment the code runs in was never part
of the fixture, so a defect that lives entirely in that difference was unreachable by any amount
of reading. A test suite that never constructs the conditions of production is measuring
something other than production, however green it is.

---

## O. The first pilot run — the plugin was governing nothing

Every verification before this one exercised a component. This one started a real feature run in a
real repository with the real CLI, and measured what the *assembled* system did. It found, within
minutes, that the central guarantee was not in force — and that nothing anywhere reported a
problem.

### O1. The CLI half and the hook half resolved different data roots — **CRITICAL**

`CLAUDE_PLUGIN_DATA` is set by the harness inside **this plugin's hook** subprocesses. That is
what G2 measured, and it is true. What does not follow — and what nobody checked — is that a
`Bash` *tool* subprocess sees the same value. Measured in one live session:

| Context | Resolved |
| --- | --- |
| hook subprocess | `~/.claude/plugins/data/hyperpowers-inline` |
| Bash tool subprocess | `~/.claude/plugins/data/`**`codex-openai-codex`** |

An unrelated installed plugin's data directory, inherited as an ordinary environment variable.

So `state-machine.mjs`, `preflight.mjs` and every other CLI script wrote the run — state, session
pointer, telemetry — into one directory, while `git-policy.mjs`, `git-guard.mjs`,
`stop-controller.mjs` and `session-context.mjs` read from another. `activeRunId()` returned `null`
in every hook, and each hook did exactly what it is designed to do when no run is bound: nothing.

**Consequences, all of them silent:**

- No hook could find the run, so none of them acted. The evidence is the run's own record: after
  a full design phase of Bash calls, `git-fingerprint.json` did not exist and the telemetry
  contained **only** events emitted by the CLI scripts — `run_started`, `preflight`, `transition` —
  and not one from any hook. After the fix, in an otherwise identical run, the fingerprint appears
  and updates, `SubagentStop` increments `subagentsCompleted`, and the Stop controller emits
  `continuation`.
- That means the Git policy did not apply, the PostToolUse guard could not detect drift, and the
  Stop controller drove nothing — no continuation, no stall detection, no budget breaker. 258
  conformance cases and four adversarial probe rounds, out of circuit.

> **A correction, because the first version of this row cited bad evidence.** It claimed
> `git tag hp-policy-probe` succeeding "during an active run" as proof. That probe ran in a
> *separate* `claude -p` session, which owned no run — and the policy is deliberately scoped to a
> session that owns one (§K1). The tag was therefore allowed **by design**, and would have been
> allowed with or without this defect. The correct test creates the run and attempts the mutation
> in the *same* session; run that way against the fixed build, `git tag` is denied by the hook, no
> tag is created, and the run records `policy_blocked` — the event §K2 introduced. The defect is
> real and the fingerprint/telemetry evidence above is decisive; the headline demonstration was
> not, and citing a correct-by-design outcome as proof of a bug is exactly the error this ledger
> exists to catch in other people's work.
- With no controller pushing phase instructions, the director stopped delegating: the run spent
  **100% of its output tokens on Fable, dispatched zero subagents and made zero Codex calls** —
  $3.58 to reach `DESIGN_DRAFT`, which inverts the §6.2 pyramid completely. The cost was not a
  side effect of the bug; it was its most expensive symptom.

The run wrote its artefacts, advanced its phases and looked healthy throughout. That is the part
worth keeping: **a governance layer that is absent behaves exactly like one that is working**,
right up until someone checks a mutation actually got blocked.

**Fixed** by not believing the variable. `dataRoot()` accepts `CLAUDE_PLUGIN_DATA` only when the
directory it names belongs to this plugin; a foreign value is still useful, because it says where
plugin data lives, so we take its parent and find our own directory beside it. Both contexts then
converge. Verified live afterwards — `plugin-data-dir: Run data at …/hyperpowers-inline (via
resolved beside a foreign CLAUDE_PLUGIN_DATA)`, the guard's fingerprint appeared, and
`SubagentStop` began firing.

**And made detectable**, because it was not. The `SessionStart` hook — the one context whose
`CLAUDE_PLUGIN_DATA` the harness sets itself — now stamps the authoritative root, and preflight
checks for that stamp instead of assuming agreement:
`plugin-data-agreement: pass — The hooks and the CLI scripts resolve the same data root.`

### O2. `PLUGIN_ROOT` had the identical structure, and worse blast radius

Swept immediately rather than waiting for it to fire. `PLUGIN_ROOT` preferred
`CLAUDE_PLUGIN_ROOT` and fell back to self-location, so a variable naming another plugin would
have redirected the review prompt templates, the Codex output schema and the work-package schema.
The priority is now reversed: `import.meta.url` gives this file's real path, so `../..` is our root
by construction in every context, and the environment gets a say only if the self-located directory
does not carry our manifest — and then only if the variable's target does.

### O3. Subagent cost was invisible to the thing that meters cost — **CRITICAL**

Found by watching the same run closely: `counters.subagentsCompleted` climbed while the transcript
analysis kept reporting zero subagent messages. Subagent transcripts are not appended to the
session transcript. They are written to `<project>/<session-id>/subagents/agent-*.jsonl`, one file
per dispatch, and `isSidechain: true` appears **inside those files** — so the split
`analyseTranscript` performs on `row.isSidechain` never had anything to split.

Measured on the live run at the moment of discovery:

| | before the fix | after |
| --- | ---: | ---: |
| fable | $2.567 (100%) | $2.567 (70.5%) |
| opus | **invisible** | $0.775 (21.3%) |
| sonnet | **invisible** | $0.300 (8.2%) |
| total | **$2.567** | **$3.642** |

Two things rested on this. `maxCostUsd` reads spend from here — §K6 replaced an inert breaker with
a measured one, and the measurement was blind to the two tiers that do most of the work, so the
breaker undercounted by exactly the amount a healthy run spends. And §6.2's distribution, the
entire empirical basis of the 1–3–9 argument, could only ever report the director; the shape it
displayed (100% Fable) was not merely wrong, it was the opposite of what the run was doing.

Fixed by reading the subagent directory alongside the transcript, taking provenance from the file
rather than the row, and keying the memo on every contributing file — a subagent finishing does not
grow the parent transcript, which is the whole of `EXECUTION`, so the previous key would have
frozen the cost at its first reading.

### O4. The design gate could not read what the design coordinator writes

The coordinator produced sixteen acceptance criteria. The gate extracted **zero**:

```
criteria the gate can extract: NONE
criteria actually written:     AC1, AC2, … AC16
```

The design wrote `- **AC1 — Hard length invariant.** …`; the extractor required a literal
`AC-1:`. Three gate conditions and the entire evidence matrix key off these ids, so a run would
have been decided by which dash an agent reached for.

This is the project's signature defect class once more, and in its purest form: a mechanical
checker with a strict format, and a producer told only *"numbered acceptance criteria"* in prose.
Every previous instance was a check with no producer; this is a check whose producer was never
given the contract — the same shape as §N6, found the same way, one artefact earlier.

Fixed on both sides, and symmetrically. The extractor accepts `AC1`, `AC-1`, `AC 1`, bold markers
and any of the dashes, and canonicalises to `AC-<n>`; the *comparisons* canonicalise too, because
the design, `tasks.json` and `evidence.json` are written by three different agents and loosening
only the reading side would have broken coverage matching in the other direction. The coordinator's
prompt now shows the exact line rather than describing it.

### O5. The schema sweep O4 provoked

Having found one contract whose producer was never given it, every shipped schema was checked for
a code consumer rather than waiting for the next instance:

| Schema | Consumer |
| --- | --- |
| `adjudication` · `agent-report` · `codex-review-output` · `work-package` | enforced |
| `evidence-matrix` | **none** — now enforced |
| `completion` · `finding` · `state` | none, and none needed |

`evidence-matrix` was the one that mattered. Six §13 conditions look up `unit-tests`, `lint`,
`typecheck`, `build` and `runtime` **by exact name**, and the schema pins that vocabulary with an
enum that nothing checked. A verifier writing `tests` would have produced a file that looked
complete while leaving every one of those conditions `unverifiable` — and the run would have spent
two mandatory Codex rounds before the completion gate mentioned it. It is now validated at the
`SYSTEM_VERIFICATION` exit, which is the same argument that stopped an empty `tasks.json` burning
the plan rounds.

The other three are documentation of shapes this codebase writes itself rather than contracts
between agents, so enforcing them would add ceremony without closing a gap. Saying which is which,
in a table, is the point — an unenforced schema is only a hazard when something downstream depends
on it being obeyed.

### O6. The §18 circuit breaker was unreachable in the phase graph — **third fix, first reachability check**

The pilot walked straight into the situation §18 is written for: round 2 verified both accepted
corrections had landed *and* raised a **new** blocking finding. §18's answer is "correct it, then
at most one extra targeted review". The state machine could not do that:

```
design-extra: runs in DESIGN_REMEDIATION, verifies design-2
  phase producing design-2 = DESIGN_REVIEW_2, successors = [DESIGN_LOCK, BLOCKED]
  can reach DESIGN_REMEDIATION? NO
```

Identical for `plan-extra` and `implementation-extra`. The only route from a round-2 blocker was
`*_LOCK → *_DRAFT`: a full restart of the artefact **plus both mandatory rounds again** — strictly
more expensive than the bounded review the breaker exists to substitute for. A circuit breaker that
costs more than the fault is not a circuit breaker.

This is the third fix to the same rule, and the first one to check the thing that was actually
broken. §L10 made the extra round runnable by the adapter. §M1 made its findings count at the gate.
Neither asked whether a run could *arrive* at it — and the answer was no, the whole time, including
after both fixes were declared complete.

Fixed by adding the missing edge for all three artefacts, and — the part that matters — by a test
that derives the requirement from `EXTRA_ROUNDS` itself rather than restating it: every extra
round's host phase must be a successor of the phase that produces the round it verifies, and must
be able to return. A fourth artefact added later cannot reintroduce this.

**What the run did instead is the reason this survived three fixes.** Watched live: rather than
stalling on the missing edge, the director dispatched an adjudicator *from inside*
`DESIGN_REVIEW_2`, accepted DESIGN-003, applied the correction to `design.md` and recorded the
resolution — all without changing phase. The run continued and its record shows three findings
raised, three adjudicated, three resolved. Nothing looks wrong anywhere.

But the correction to a blocking finding was then **verified by nobody**. §18's extra round is not
a formality; it is the step that checks a fix made under pressure at the end of a review cycle.
Skipping it produced a design whose last correction has no reviewer, and the artefact went to its
lock gate in that state.

That is the general hazard of an LLM-driven state machine, and it is worth stating plainly: a model
routes around a structural gap instead of hitting it, so the gap costs a *guarantee* rather than a
*failure*. Nothing stalls, nothing errors, and the ledger records success. Only a graph check — or
watching a run closely enough to notice a remediation that happened in the wrong phase — can see it.

### O8. Template substitution corrupted the artefact under review — **caught mid-run**

Codex round 3 returned a **critical blocking** finding: the plan's verification command was
malformed, with literal `</review_pack>` lines embedded in it. The plan did not contain them —
`grep -c review_pack` on `plan.md` and `tasks.json` returns 0, and on the assembled pack returns 0.
The *prompt* contained six: one opening delimiter and **five** closings.

The plan's command ended `grep -Eq '^(ℹ|#) fail 0$'`. `String.replaceAll` honours `$$`, `$&`,
`` $` `` and `$'` inside a **string** replacement even when the pattern is a plain string, and `$'`
means *"insert everything after the match"*. Substituting the pack as a string therefore spliced
the remainder of the template — including its closing delimiter — into the middle of the reviewed
content, once per occurrence:

```
grep -Eq '^(ℹ|#) fail 0
</review_pack>
 && echo "$out" | grep -Eq '^(ℹ|#) skipped 0
</review_pack>
```

**A mandatory review round, an adjudication cycle and a correction were spent on a defect
Hyperpowers had introduced.** Codex was right about what it saw; what it saw was not the plan.

The security reading is worse than the correctness one. `` $` `` splices the text *before* the
match — the prompt's own instructions — into the material being judged. Any artefact containing it
could relocate part of the frame into the reviewed content, which is precisely what
`neutraliseFrame` was written to prevent, arriving through the substitution mechanism rather than
through the delimiters it guards. The defence and the hole were three lines apart.

Fixed by substituting through replacer functions, whose return value is used verbatim. Swept to
the two other call sites — `stop-controller.mjs` and `session-context.mjs` both interpolate
`PLUGIN_ROOT` into *commands an agent is told to run*, and a plugin installed under a path
containing `$'` (legal on any Unix) would corrupt them the same way. The regression test asserts
the hazard is real, that every dollar pattern is inert under a function, and that the shipped call
sites still use one.

### O9. A false positive led to four Git-policy bypasses — **fifth probe, first one from a live run**

The Git policy blocked the adjudicator mid-run, correctly by its own rules and wrongly in effect:
it had written an ordinary shell helper, `gate() { … }`, and §L6 denies *all* function definitions
because a function rebinds a name.

Before loosening a security control on the strength of one friction event, the assumption that
would justify narrowing it — *"function bodies are classified anyway, so only the name matters"* —
was tested. Bodies **are** flattened, with full text. But the test that was meant to confirm the
narrowing was safe returned something else:

```
eval "$(echo Z2l0IHB1c2g= | base64 -d)"   →  ALLOW
```

That bypass needed no function at all. Probing the class found four:

| | before | after |
| --- | --- | --- |
| `eval "$(echo … \| base64 -d)"` | ALLOW | DENY |
| `eval "$(cat payload.txt)"` | ALLOW | DENY |
| `sh -c "$(echo … \| base64 -d)"` | ALLOW | DENY |
| `xargs sh -c "$(cat p)"` | ALLOW | DENY |

The mechanism is worth stating exactly, because it is subtle and it defeated four probe rounds and
the whole conformance table as it then stood. The tokenizer **lifts** a command substitution out of its word, into the
`nested` list. So `eval "$(…)"` left `eval` holding an *empty string*, and an empty script
classifies as harmless. Meanwhile the substitution itself — `echo … | base64 -d` — was classified
separately, on its own, and is entirely benign.

**Every part the classifier looked at was safe. The part that would run was never looked at.**
`$G push` was already denied because the *command name* came from an expansion; this is the same
defect one level in, where the *script* comes from one.

Fixed by refusing a substitution only where its **output becomes code** — an argument to `eval`, or
the `-c` script of a shell binary, keyed on *any* executor word so `xargs sh -c` and
`nice bash -lc` are covered (the wrapper-shaped miss that defeated the first version of the
stdin-as-script rule). Used as data it stays ordinary work: `echo "$(date)"`,
`cat "$(ls -t | head -1)"`, `node -e "$(cat s.js)"` and `FOO=$(date) npm test` all still pass.
Seven denials and seven controls added; the table stood at **278** cases (§Q1 later took it to 293).

**The function-definition ban was left in place.** The argument for narrowing it depended on body
classification being sufficient, and the finding above is the counterexample: a body containing
`eval "$(…)"` passed. The `gate()` false positive therefore stands as a known cost, recorded rather
than traded away on an argument that had just been refuted.

The generalisable part: **a false positive and a bypass are the same question asked from opposite
sides** — *what can this control actually see?* Four rounds of asking it adversarially missed this;
one legitimate command, refused during real work, found it.

### O10. §20 was prose, and an agent wrote its report into the repository

Watched live during `EXECUTION`: the implementer produced `tests/wp-001-report.json` — **in the
working tree**. Five agent prompts say `--file <report.json>` and none of them says *where*, so an
agent writes wherever it happens to be.

Two consequences, neither visible at the time:

- Rounds 5 and 6 review the **real diff and untracked inventory**. The reviewer would have been
  handed Hyperpowers' own orchestration logs as part of the change it was judging.
- §13.10 fails on any file no work package owns — **the run refused by an artefact the run itself
  created**, the same shape `HYPERPOWERS_OWN_FILES` exists to handle for `/hyperpowers:setup`.

In this instance the file disappeared again a minute later. That is luck, not design, and luck is
not a property a completion gate can rely on.

Fixed on both sides, as every producer/checker mismatch in this ledger has had to be: the five
prompts now name `<RUN_DIR>/reports/<id>.json`, and `submit` **refuses** a file inside the working
tree, naming the correct path so the next attempt succeeds instead of guessing. Refused rather than
exempted — adding it to the scope-check allowlist would have left the §20 breach in place and
hidden only the symptom.

**Three existing tests failed when the guard went in**, because their fixtures wrote reports into
the project. They were modelling the defect: a suite can encode the very behaviour it is supposed
to catch, and the only thing that exposed it was a guard written for an unrelated reason.

### O11. The proof §13.5 wants was produced, and never reached the matrix

The evidence matrix came back schema-valid, 16/16 criteria satisfied with proof attached, every
check name from the enum, `runtime` genuinely exercised, residue clean — and
`failing_before_fix: 0`.

Yet WP-001's report says, verbatim: *"node --test tests/truncate.test.mjs raw output — **before this
file existed as a runnable suite**"*. The run had written its tests before its implementation, so
the before-state existed, in the run's own `reports/` directory.

The verifier runs at `SYSTEM_VERIFICATION`, after everything passes: it **cannot** observe the
before-state itself. Its prompt asked for `failing_before_fix[]` without saying where to find it.
Condition §13.5 — the one that exists to catch *"a test that never failed may not test anything"* —
therefore reports `unverifiable` on a run that had generated exactly the proof it wants.

Same family as §N6 and §O4: a field the gate reads, whose only possible source is another agent's
artefact, with nobody told to go and get it. Fixed in the verifier's prompt.

### O12. The gate and the reviewer disagreed about what "the change" was

Round 5 returned **blocker**, and one of its two findings was against Hyperpowers itself:

> IMPL-001 (high, blocking) — "The working tree contains a fourth, unowned file that violates the
> plan's exact three-file additive scope and contains settings disabling workflows and related
> safeguards." — `.claude/settings.json`

That is `/hyperpowers:setup`'s own output. The reviewer observed correctly; it was shown the wrong
thing. `HYPERPOWERS_OWN_FILES` existed **only** in `verify-completion.mjs`, so the completion gate
excused these files while `collectSections` handed them to Codex in `CHANGED FILES`, the diff and
the untracked inventory. Two definitions of "the change" inside one system.

```
before                              after
  M  README.md                        M  README.md
  ?? .claude/settings.json    ←       ?? src/truncate.mjs
  ?? src/truncate.mjs                 ?? tests/truncate.test.mjs
  ?? tests/truncate.test.mjs
```

Cost on this run: a mandatory review round and an adjudication cycle spent on our own config file.
Fixed with one list in `workspace.mjs`, consumed by the gate and by the pack through git
pathspecs.

It is the **third** orchestration artefact to leak into review in a single run — after the
work-package report (§O10) and the template splice (§O8). Three different doors into the same
room, and §20 had a guard on none of them.

The other finding was legitimate and worth recording as evidence the layer works: the plan demanded
a mutation audit naming which test rejects each mutant, the implementer ran the mutants (observed
live) and did not record the mapping, and Codex refused the dossier for it.

### O13. The implementation reviewer was shown the plan's demands and not the evidence

Found by an *adjudicator*, which is worth noting on its own. Accepting IMPL-002, it wrote:

> "The M1-M6 audit was in fact performed — `reports/WP-002-attempt1.json:72-111` carries a mutation
> table naming the failing tests per mutant and a restoration diff — but that report was **NOT in
> the review pack**."

Verified: the implementation pack had eight sections and none of them were the work-package
reports. Its seven mentions of "mutant" all came from the **locked plan** — so the reviewer was
shown what the plan demanded, and the diff, and asked whether the work was finished, without the
evidence that answers the question. It blocked, correctly, on what it could see.

This is §O12 inverted. There the pack showed something that was not the change; here it omitted
what the change was proven by. Both times the reviewer's reasoning was sound and its input was
wrong, which is the failure mode an adversarial layer cannot detect for itself: a contradictor can
only be as good as its pack.

Fixed by adding `WORK PACKAGE REPORTS` at priority 1, formatted as **evidence rather than
narrative** — commands run, expected, observed, plus `unverified` and `risks`. That last part is
deliberate: an implementer stating what it did *not* check is the most useful line in the file, and
omitting it would make every dossier read stronger than it is. Verified against the run's own data:
the section renders at 27,908 bytes and contains the mutation table whose absence caused the
blocker.

### O14. The cost breaker was consulted once in 86 minutes — **the mirror of §K6**

The run reached `COMPLETE` and `BUDGET_EXCEEDED` never fired.

*(This section originally read "$41.29 against a `maxCostUsd` of $40". **That figure was wrong** —
§P7 shows the accounting overstated cost by ~2×, so the run finished near $22 and never approached
its bound. The defect below is unaffected and is if anything worse than it looked: the breaker was
not merely late, it was comparing an inflated number it had computed once.)*

The logic was correct. It simply lived only in the Stop controller, which is invoked when the turn
tries to end — and a healthy run spends its entire turn dispatching subagents and running commands.
Measured: **one continuation in 86 minutes**, across nineteen phase transitions. The bound was
therefore evaluated once, at roughly $2, and never again.

§K6 found `maxCostUsd` inert because nothing produced a cost figure and fixed the producer. This is
the same sentence with one word changed: a budget nobody *checks* is not a budget either. The two
halves of "enforced" are production and consultation, and fixing one made it easy to believe both
were done.

Fixed by moving the bound test into one shared `budgetOverrun()` and asking it at every phase
transition as well — nineteen checkpoints instead of one. Terminal targets are exempt on purpose: a
run already over budget must still reach `BLOCKED`, `ABORTED`, or `COMPLETE` when the work is
finished and proven. Stopping a completed run at its last step would spend the entire budget and
then discard the result, which is the only outcome worse than overspending.

The measurement also says something about the default. `maxCostUsd: 40` was a round number chosen
without evidence; one five-line utility spends 103% of it. Either the default is too low for real
work or the scaffolding is disproportionate for small work — §O7's cost table argues the second —
but nobody could have known before a run was measured.

Raised to **100** once four runs had been measured: $14, $22, $23 on toy benches and **$73.20** on
the production feature (§Q11). A default that halts the only run shape the tool is *for* is not a
circuit breaker, it is a defect with a configuration key.

### O15. Why Opus cost four times Sonnet — diagnosed, and fixed where it was decidable

The measured inversion, with the intent beside it:

*(Shares corrected per §P7; the originals over-credited Fable, whose replies carry the most
transcript rows.)*

| Tier | output tokens | cost | §6.2 intent |
| --- | ---: | ---: | ---: |
| Opus | **63.9%** | 58.0% | ~25% |
| Sonnet | 24.1% | 12.6% | ~65% |
| Fable | 12.0% | 29.4% | ≤10% |

No agent made a bad decision. Every dispatch was competent and several were better than the
contract asked for. The eleven dispatches locate the cause precisely:

| Cause | Cost | What it should have been |
| --- | ---: | --- |
| Three adjudications applying their own corrections | **97,219 tok** — half of Opus, 29% of the run | `sonnet-implementer` for code; the adjudicator keeps the documents |
| The plan coordinator writing a reference implementation and a fuzz over 50,000 inputs | **53,624 tok** | `sonnet-test-engineer`, which exists for exactly this |
| Research discarded between phases | 6,122 tok of Sonnet work thrown away, then ~17,000 tok of Opus rediscovery | the findings carried forward |

The mechanism is one sentence: **every Opus agent holds `Write`, `Edit` and `Bash`, and the
prompts offered delegation rather than expecting it.** `Apply them — or dispatch a Sonnet to` is a
coin flip, and an agent that already holds the context always calls it the same way. A tier
boundary that costs nothing to cross will be crossed.

Fixed where the choice was decidable, and left alone where it is not:

- The adjudicator now **owns `design.md` and `plan.md` and delegates source files**, with one
  narrow, on-the-record exception for a few lines whose whole justification is the reasoning it
  has just done. It still verifies every correction: delegating the edit does not delegate the
  judgement.
- The plan coordinator **dispatches the validation prototype** instead of writing it. Proving a
  design is buildable before decomposing it was excellent engineering; doing it at coordinator
  rates was not.
- The brainstorm now **carries research findings forward verbatim**, with their `path:line`
  evidence, because a researcher has no `Write` tool and every later agent starts fresh — so the
  compression at that boundary was silently discarding the cheapest work in the run.
- `routing-policy.md` carries the measurement and the rule; two regression tests assert the
  wording survives, because prompts drift without failing anything.

**Not** fixed: removing `Write`/`Edit` from Opus agents. They legitimately author the design and
the plan, and a coordinator that cannot correct a document it just reasoned about would trade one
inefficiency for a worse one. The honest position is an expectation with a reason, not a tool ban.

### O16. The measurement meant to reveal the inversion was reading a snapshot

`summarise()` — which feeds the §6.2 distribution table in the final report and
`/hyperpowers:status` — read `state.observedUsage`, written only by the Stop controller. That hook
ran **once** in 86 minutes, so the table describing where the run's money went was a picture of its
first minutes. On this run the gap was small by luck (the last continuation happened near the end);
on a run whose only continuation is early, the report would have described almost nothing.

One measurement now serves the budget check, the report and the status view — `measuredUsageFor`,
from the transcript, with the stored snapshot as the fallback for a run whose transcript has been
rotated away. The same fix, made once, closes §O14's second half: the breaker was reading the same
stale field.

### O17. The Mermaid was not an Artifact, and the run kept only a link

Condition 14 asks for a product diagram published as an Artifact. The run produced a genuinely
good one — user-facing language, no implementation detail — and published it to `mermaid.live`.
No claude.ai page ever opened, and the completion gate passed because it checked that *a non-empty
string* had been recorded while claiming to have verified publication as an Artifact.

Three things were wrong and each has a different fix:

1. **The check claimed more than it verified.** It now accepts either route and **says which**, so
   a fallback is disclosed rather than silent. Enforcing a `claude.ai` URL was rejected: Artifact
   publishing may be unavailable in a headless session, and failing a finished run over the
   rendering host punishes the environment rather than the work.
2. **The deliverable was a link.** `state-machine.mjs artifact` now takes `--source`, stores
   `diagram.mmd` with the run, and the final report renders it inline. The URL is the publication;
   the source is the artefact, and it survives the renderer going away.
3. **The instruction did not say so.** The skill now requires both, and explains that the one
   artefact aimed at a reader who will not read the rest should not require a click.

### O18. Three divergences from the spec's file tree, all deliberate

Checked because a future reader will diff the tree against §19 and file them as bugs:
`agents/fable-director.md` does not exist because the director **is** the skill — a Fable subagent
would not be the main thread and would break the model pin (ADR-0001) — and `build-review-pack.mjs`
and `telemetry.mjs` became `scripts/lib/` modules because nothing invokes them as commands.

The §27 prompt drafts were mined for what the agent prompts lacked. Almost everything in them was
already enforced mechanically — premise-mismatch reporting, no-git, no-over-engineering,
verify-before-marking-done. Exactly one was missing and is now in `sonnet-implementer`: **never
reference the plan from the code**. The plan lives in the run directory and is deleted when the run
is archived; a comment pointing at something the reader cannot open is worse than no comment.

### O7. The fixes, checked against the run rather than against their own tests

Every fix in §N and §O ships with a test that fails on the pre-fix tree. That proves the fix does
what its author intended; it does not prove the intention matched what agents actually produce.
The pilot supplies the second half:

| Fix | Production evidence |
| --- | --- |
| §N6 work-package contract | The coordinator, given the explicit JSON shape, wrote **2/2 schema-valid packages** — including `status: "pending"`, the field the old prompt never mentioned and whose absence would have failed the gate |
| §O4 criterion ids | The coordinator wrote `AC-1 … AC-16` canonically, and the plan's coverage claims matched the design's ids on both sides |
| §O1 data root | `git-fingerprint.json` written and updating; `SubagentStop` and `continuation` events present — the hooks find the run |
| §O3 subagent accounting | Opus and Sonnet appear in the cost table at all, and the totals moved from $2.57 to $3.64 at the moment of the fix |
| §N2b/N2c drift categories | **Zero** `gitDrift` records across a 40-minute run doing constant Git reads — the anti-cry-wolf decision holds under load |
| Accounting performance | The Stop hook reads every subagent transcript on each continuation: measured **5 ms cold** over 1.2 MB in 6 files, against a 16 s budget |

Two alarms were raised and dismissed by measurement rather than intuition, which is worth
recording because the reflex to report them was strong. An agent appearing to exceed `maxTurns: 50`
was an artefact of counting transcript *rows* rather than unique message ids — 36/50 in fact; and
the adjudicator that did reach exactly 50 ended on `stop_reason=end_turn` with a complete summary,
so it finished rather than being truncated.

### What the run showed about quality, separately from correctness

Worth recording because it is the only evidence anyone has about whether the pipeline produces
good work rather than merely completing:

- The Opus design coordinator stated the problem falsifiably, rejected three named alternatives
  with reasons, recorded them as non-goals, and flagged one deliberate departure from the
  repository's existing precedent as a decision rather than an accident.
- Codex round 1 (Sol, high, 165 s) returned a **blocker** verdict on a five-line utility and was
  right to: it found that the design's own policy for non-positive `max` cannot satisfy the hard
  length invariant and the ellipsis contract simultaneously — an internal contradiction between
  two sections written by the same agent — plus a boundary rule that discards all visible content
  when the budget could retain some.

The adversarial layer is doing the job it is there for. That was not previously demonstrable.

### A method note: watching a live run invents findings if you let it

Two of this section's near-misses were the observer's fault, not the system's, and both are worth
recording because the reflex to publish was strong in each.

The first was citing `git tag` succeeding in a *separate* session as proof that the Git policy was
inert (see the correction in §O1). The policy is session-scoped by design; the observation was
correct and meant nothing.

The second was worse. `src/truncate.mjs` was read with `cat`, its word-boundary loop scanned
*forward* — taking the first whitespace rather than the last — and that is precisely the defect
Codex had predicted at plan stage in PLAN-003. A finding was half-written before the numbers on the
monitor showed the file had changed between the read and the test: what had been photographed was a
**deliberate mutant**, mid-way through the mutation-testing step the plan itself requires. The real
implementation scans backward and is correct.

Nothing but the discipline of re-checking caught it. **Measuring a moving target manufactures
defects**, and an agent under review is always a moving target. The judgement script now hashes the
file before and after and discards its own result if it moved:

```
independent fuzz over 20,000 random inputs (length + well-formed UTF-16): 0 violation(s)
file unchanged during the test: yes (4e914f0479ed)
```

That is the same failure as the first one at a different level — a true observation attached to the
wrong claim — and the only defence against both is to state what was measured, under what
conditions, before deciding what it means.

### The lesson, which is not about environment variables

Three internal audit rounds and one external reviewer read this code closely. All four missed
this, because it is not visible in any file. G2 measured the variable in a hook and recorded a true
fact; every reader then generalised it to *every* subprocess, and the generalisation was where the
defect lived. **A verified fact about one execution context is not a fact about another**, and the
only thing that distinguishes them is running the assembled system where it is meant to run.

The count is worth stating plainly: the two most severe defects in this codebase — a completion
gate that could not execute, and a policy layer that was not connected — were both found by
running it, and neither was findable by reading it.

---

## P. The second pilot run — a harder bench, a frozen build, and a stall detector that blocked a
healthy run

Run #1 proved defects exist. It could not prove the build is stable, because the plugin was
hot-patched seven times while it ran. Run #2 answered a different question, on a deliberately
harder bench (`datakit`: four modules, a barrel, documented conventions, an RFC 4180 CSV codec with
a round-trip invariant — roughly five times the payload of run #1's five-line `truncate`) in an
otherwise identical environment.

Predictions were written before launch. The plugin was frozen and hashed before and after: **85
files, tree `e2414bf6872c5f96`, unchanged at the end.** Zero interventions.

**Result: `BLOCKED` at 62.5 min, $40.90, four Codex rounds, 11 subagents, `src/csv.mjs` 209 lines on
disk.** The run was killed by its own stall detector while two implementers were writing files
correctly.

### P1. A stall cycle was a Stop-hook firing, not a unit of work — **the run-ending defect**

| time | event |
| --- | --- |
| 10:56:43 | director dispatches `opus-execution-coordinator`, synchronously |
| 10:58:57 / 10:59:11 | the coordinator dispatches both wave-1 implementers with **`run_in_background: true`** |
| 10:59:34 | the coordinator **returns**: *"Wave 1 dispatched. Waiting for both reports."* |
| 10:59:46 → 11:01:09 | the director resumes it, polls task statuses, arms a `Monitor`, verifies the implementers' transcripts are growing — **five turn-ends in 83 seconds**, stall 0→4, ladder escalates sonnet→opus→fable |
| 11:01:40 | **stall 5 → `BLOCKED`**, "no measurable progress across 5 continuations" |
| 11:02:15 | **WP-004 submits a successful report**, 35 s after the impasse was declared |

The director's last message before the block, cut off by it:

> *"Diagnosis complete — no redirect needed: the two wave-1 implementers are alive and actively
> writing (transcripts growing; `src/csv.mjs` on disk is their work). The stall detector only re…"*

Two independent defects, each survivable alone:

1. **A dispatch that returns before the work exists.** `run_in_background: true` was passed
   deliberately, to parallelise two packages. The architecture assumes a dispatch is synchronous —
   "the coordinator returned" means "check its report" — and the harness already offers the safe
   form: several `Agent` calls in one message run concurrently *and* hold the turn. Nothing in the
   prompts said which to use.
2. **A bound whose clock is unrelated to the work it bounds.** `progressSignature` hashes phase,
   work-package counter, task statuses, review keys, adjudication counts, evidence statuses and four
   file mtimes. **None can change while an implementer runs.** `recordStall` counted once per Stop
   firing, and Stop fires whenever the director yields. §16.3's ladder is written in *cycles*; those
   cycles were 15 seconds apart.

Fixed in three places: the execution coordinator's scheduling rule (parallel = one message, never
background), a standing constraint in the feature skill (no `run_in_background`, no `Monitor` — its
notification arrives as a **new turn**, which clears the director's `model:` pin), and
`stop.stallMinIntervalMs = 60_000`, so five consecutive stalls take at least five minutes — longer
than any work package measured in either run (2.9–16 min).

**Rejected alternative**, recorded because it reads better than it is: folding the newest subagent
transcript mtime into `progressSignature`, so "a subagent is writing" counts as progress. It makes
the signature depend on *when* the hook happens to run, which is the defect being fixed wearing a
second clock, and a subagent spinning forever would keep the signature moving so the detector would
never fire at all.

**Why run #1 hid it.** Two work packages, dispatched synchronously in one wave: the director's turn
never ended with work in flight, so the Stop hook fired **once in 86 minutes**. The same property
hid the O14 budget defect. *A healthy synchronous run barely exercises the Stop controller at all* —
which means the Stop controller is the part of this system least covered by a successful run, and
should be treated as such.

### P2. The model pin is cleared by any notification, from any source

The director ran as `claude-fable-5` from 09:59:04 to 11:02:23, then became `claude-sonnet-5` — one
turn after the `Monitor` it had armed delivered its first event. ADR-0001 confirmed from an
unexpected direction: the pin survives Stop continuations and dies at a new turn, and a background
watcher armed *inside* the run is a way to start one from the inside.

### P3. What the run measured before it died — the floor is real

Phase-boundary figures, which are the only ones comparable across feature sizes. Costs here are
**corrected per §P7** and a third run is included; the versions first written into this section were
overstated by ~2× along with everything else this project measured.

| at `PLAN_LOCK` | run #1 (`truncate`) | run #2 (CSV) | run #3 (CSV) |
| --- | ---: | ---: | ---: |
| elapsed | 57.2 min | 57.1 min | **54.3 min** |
| cost | $13.26 | $12.83 | **$7.79** |
| output tokens | 169,732 | 202,371 | 98,183 |
| Fable | 11.6% | 11.4% | 20.7% |
| Opus | 84.8% | 74.5% | 77.5% |
| Sonnet | 3.6% | 14.1% | 1.8% |

**Everything before a line of code exists takes 54–57 minutes, on both feature sizes, in all three
runs.** `docs/cost-model.md` argued the scaffolding is a fixed floor; it is, and **the floor is
better stated in time than in money** — cost ranged $7.79 to $13.26 for the same milestone while the
clock varied by 5%. The corollary stands: below some feature size the floor dominates.

The tier rows are the counter-lesson. Sonnet at 3.6% / 14.1% / 1.8% for the same milestone, twice on
the identical request, is not a signal — see §P8.

The design artefact is itself a constant — `design.md` was 29,483 bytes in run #1 and 29,286 in run
#2 — with 16 acceptance criteria for a five-line utility against 43 for a codec.

### P4. What else the run confirmed, and what it falsified

| Prediction | Verdict |
| --- | --- |
| a `sonnet-test-engineer` dispatch before `PLAN_LOCK` | **confirmed** — 12,072 tok / $0.71, against run #1's plan coordinator writing its own reference implementation and a fuzz harness of fifty thousand inputs (53,624 tok / $5.93, the largest dispatch of that run) |
| `## Research findings` with `path:line` evidence | **confirmed** — 58 citations; the researcher produced 7,786 output tokens against run #1's 1,337 |
| Sonnet's share at `DESIGN_LOCK` above 6.3% | **confirmed** — 14.7% |
| design/plan cost rises sub-linearly | **confirmed** — +4.4% and +7.7% |
| the plugin is byte-identical after the run | **confirmed** |
| no orchestration artefact in the project tree | **confirmed** — only `.claude/` and `.hyperpowers.json`, both own-files |
| zero `policy_violation` | **confirmed** — one `policy_blocked` (below) |
| the run reaches `COMPLETE` unaided | **falsified** — P1 |
| mean tokens per adjudication dispatch below 32,406 | **falsified so far** — design 30,185 (−22%) but plan 46,750 (+32%), mean 38,468 over two |

Two findings do not fit a table. **Codex earned its cost twice.** `design-1` returned one finding at
`confidence: 1`: permitting `U+FEFF` as the delimiter breaks the round-trip invariant, because the
serializer emits a leading delimiter the parser strips as a BOM. The adjudicator did not take its
word for it — it built an executable model of the design, reproduced the failure, and found the
defect *broader* than reported (any row with an empty first field, not just the degenerate case),
then wrote down why the design's own sufficiency proof missed it. `plan-1` returned three blocking
findings, including a verification command that chained a `grep` for a *forbidden* pattern with
`&&` — a check that fails exactly when its criterion is satisfied.

And **`residualRisks` has a producer now**: four entries recorded, against zero in run #1. Codex had
returned residual risks in run #1 too (2+2+2+1 across the four rounds) and every one was dropped.
That was never a missing producer — the producer was Codex, the consumer was `state.residualRisks`
and the final report, and the wire between them did not exist.

### P5. The Git policy denied an agent's own tooling, correctly

One `policy_blocked`. The adjudicator was extracting every verification command from `tasks.json`
and syntax-checking each with `bash -n -c "$cmd"` — to test Codex's claims rather than accept them.
Denied: *"the command name is produced by a shell expansion, so it cannot be classified before it
runs"*. The policy is right and the command was harmless; `bash -c "$cmd"` is exactly the construct
§O9 closed. An exception for `-n` is not as simple as it looks — `bash -c "$cmd" -n` puts `-n` in
`$0` and *does* execute — and §O9 records four bypasses found by chasing a single false positive.
Cost: one denied command, no lost work. Recorded rather than fixed.

### P7. Every cost this project ever reported was ~2× too high — **the accounting itself**

Found while decomposing spend for run #3. The transcript writes **one row per content block**, not
one per API response: a reply that thinks and then calls a tool is two rows; add visible text and it
is three. All of them carry the same `requestId`, and across them the prompt counters
(`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) are **identical** —
the same prompt, reported again — while `output_tokens` grows as the response streams, so the last
row holds the total.

`analyseTranscript` summed rows. It therefore billed the prompt once per block.

| run | reported | measured, one request counted once |
| --- | ---: | ---: |
| #1 `truncate`, COMPLETE | $41.13 | **$22.12** |
| #2 CSV, blocked | $46.98 | **$23.62** |
| #3 CSV, at `PLAN_REVIEW_2` | $14.98 | **$7.67** |

Overstated by **1.86–1.99×**, and not uniformly: the director's replies carry the most blocks, so
Fable was inflated hardest — a reported 24.7% of output tokens against a real **12.0%**, while Opus
rose from 54.7% to **63.9%**.

What that invalidates:

- **`docs/cost-model.md`**, entirely, and it has been rewritten from the corrected figures.
- **§O14's illustration.** "The run finished at $41.29 against a $40 limit" is false: it finished at
  **$22 and never approached the bound.** The *defect* §O14 records — the breaker evaluated once in
  86 minutes — was real and is fixed; the story told about it was not.
- **The `maxCostUsd` breaker itself**, which over-counted by 2× and would have aborted a healthy run
  at half its budget. §K6 said a budget that silently stops counting is worse than one that
  overestimates. Both are bad; this was the second kind, and it was invisible for the same reason
  the first kind was — nothing compared the number against ground truth.

Fixed in `scripts/lib/transcript.mjs`: group by `requestId`, take the prompt once, take the largest
`output_tokens`. **No existing test caught it**, because every fixture wrote one row per response —
which is what a hand-written fixture looks like and what a real transcript never looks like. The
regression test now uses a multi-block response.

This is the §K–§O class in its purest form yet. Not a field nobody writes, not a bound nobody
checks: **a measurement nobody compared to the thing it measures.** It was internally consistent,
so every derived figure agreed with every other, and agreement read as correctness.

### P8. The money is in turns, not tiers

With the accounting fixed, the decomposition changes what "reduce cost" means.

| term | run #1 | run #2 |
| --- | ---: | ---: |
| context re-read (cache read) | 42.3% | 41.6% |
| cache write | 22.7% | 25.1% |
| **generation (output tokens)** | **34.9%** | **33.3%** |
| fresh input | 0.0% | 0.0% |

**Two thirds of the bill is context.** §6.2 measures output-token share; every routing rule
optimises output-token share; output tokens are a third of the cost.

Cost per turn, measured: **director $0.130 · Opus $0.071 · Sonnet $0.031.** A turn is one API
round-trip and a round-trip re-reads everything. Then, across **1,415 assistant messages in two
complete runs**:

> **Tool calls per turn: 1.00. Every agent, every phase, no exceptions.**

*(corrected: see §V4 — 1.00 is an identity. The denominator was transcript rows, which never hold two
`tool_use` blocks; per API request the same two runs measure 1.153 and 1.183, and 47 of run #1's 321
requests issued two or more calls. The sizing below is withdrawn with it.)*

The harness supports issuing independent calls together in one message. No agent ever did. Batching
even two at a time removes on the order of 80 Opus turns and 25 director turns from run #1 —
**roughly a quarter of the bill, with no task removed and no decision moved to a weaker tier.**

Acted on: every dispatched agent and the director now carry a three-line batching rule, locked by a
test. Deliberately *not* acted on: tier-share tuning. Sonnet's share of output tokens at
`DESIGN_LOCK` across three runs of the *same request on the same bench* was 8.1%, 20.0%, 4.4% —
run-to-run variance larger than any effect §O15's prompts produced, which means those prompt changes
were validated on noise. Turn count is measurable per agent and per dispatch, so it survives the
variance that share-of-a-varying-whole does not.

### P9. Run #3 — the frozen build reaches `COMPLETE`, and finds one more unreachable fix

Same bench rebuilt, same request, three plugin changes (synchronous dispatch, no background watcher,
`stallMinIntervalMs`). **`COMPLETE` in 81.7 minutes at $14.10, zero interventions, plugin manifest
byte-identical before and after.** `stall` never left 0; 9 `Agent` dispatches, none backgrounded.
Both halves of the §P1 diagnosis and both halves of the fix hold.

| | run #1 (`truncate`, 5 lines) | run #3 (CSV codec, ~200 lines) |
| --- | ---: | ---: |
| wall clock | 85.7 min | **81.7 min** |
| cost | $22.12 | **$14.10** |
| API responses | 321 | **231** |
| work packages | 2 | 2 |
| Fable / Opus / Sonnet | 12.0 / 63.9 / 24.1 | 17.8 / 55.5 / 26.7 |

**The larger feature cost 36% less than the toy.** Not because anything improved — because cost
tracks how many turns the agents happened to take (§P8), and this run took 90 fewer. That is the
same conclusion the tier shares reached, arriving from the cost side.

The six rounds converged cleanly: `design-1` blocker → `design-2` clean; `plan-1` three blockers →
`plan-2` clean; `implementation-1` concerns → `implementation-2` clean. The implementation finding is
the one worth quoting, because it is what §13 exists for and no mechanical gate could have produced
it:

> AC-2 is marked satisfied although its test covers CRLF only, leaving the required mixed LF/CRLF
> case untested. The evidence matrix overstates test coverage.

The code was correct and all tests passed; the *evidence* claimed more than it showed. Round 6 then
verified the repair **under a negative control** — it checked the new assertion fails when the
behaviour is broken.

Independent judgement of the product (`judge2.mjs`, written before the run and never shown its
tests): 31 of its 32 hard assertions passed, a round-trip fuzz over twenty thousand random matrices
found nothing, a further five thousand degenerate ones found nothing, every pre-existing module was
untouched and the suite was green at 41 tests. The one failure was a surviving mutant — and
**probing it showed the mutant is behaviourally equivalent**, so it is a false positive of the audit
rather than a hole in the suite.

### P10. `report.mjs` existed, worked, and was optional — so two earlier fixes were unreachable

Run #3's `final-report.md` has no `## Product view` and no cost table. The director wrote the report
by hand, because the skill said *"write `final-report.md`"*. `scripts/report.mjs` assembles the
evidence matrix, the six-round trail, the measured per-tier distribution (§O16) and the diagram
rendered inline from `diagram.mmd` (§O17) — and nothing required calling it. Run #1 happened to call
it; run #3 happened not to.

So both §O16 and §O17 shipped, were tested, and were **reachable only through a path the workflow
did not mandate**. The §K–§O class again, one level up: not a field nobody writes, but a *producer
nobody is told to run*.

Fixed by making the skill give the command and say what a hand-written report silently drops.

### P6. Method, since two of run #2's own measurements were wrong before they were right

- The baseline was reconstructed at **phase boundaries** from run #1's telemetry and transcripts, not
  taken from the whole-run figures, for the reason in P3. Its dispatches are *named*: the harness
  writes an `agent-*.meta.json` beside every subagent transcript with `agentType`, `description` and
  `spawnDepth`. "The plan coordinator prototyped it itself" stopped being an inference.
- Run #1's own record is contaminated by post-hoc probes — `state.json.artifacts.diagramUrl` reads
  `https://mermaid.live/view#x` and a `diagram.mmd` sits in a run that predates §O17. Telemetry and
  transcripts are clean; that field is not.
- Three costs circulated for run #1 — $39.42 (cost-model, a mid-run snapshot), $41.29 (§O14), $41.13
  (whole session) — and reconciling them produced a fourth, $40.76 at the `COMPLETE` transition.
  **All four are wrong**: §P7 found the accounting itself overstated cost by ~2×, and the figure is
  **$21.93**. Worth keeping as a cautionary entry — four numbers were carefully reconciled against
  each other and none of them was checked against the thing they measured.
- Condition 13.5 was recorded here as `unverifiable` in run #1. Replaying the gate against a
  sandboxed copy shows **`pass`** — it was `unverifiable` until §O11 was hot-patched mid-run. Replay
  technique: copy the data root, point `HYPERPOWERS_DATA_ROOT` at the copy, re-run the verifier.
  Nothing measured is touched by being measured.
- A dispatch's token count was read **mid-flight** and reported as final, understating the design
  coordinator by half. Live counters are comparable only at a dispatch boundary — the same error
  `judge2.mjs` hashes files to prevent, committed by its author.

---

### Q1–Q7. The pre-release audit, minus the two that needed their own entry

Six fixes shipped with only a regression test to their name — the tests cite `§Qn`, the ledger
never carried the row. Recorded here from those tests, so every claim below is falsifiable by
reading the file named beside it. `§Q5` and `§Q8` have their own entries, below.

| | Defect | Fix | Pinned by |
| --- | --- | --- | --- |
| Q1 | The classifier trusted a name in command position even when a shell builtin had just rebound it: `hash -p /usr/bin/touch git; git status` ran `touch` and was reported as an approved read | `hash`, `enable`, `alias` and `autoload` deny a rebinding of any validated name — see §Q10 for the false positive this produced and the per-builtin rule that replaced it | `tests/git-policy.test.mjs` |
| Q2 | Two installations coexisting on one machine (`hyperpowers-hyperpowers`, `hyperpowers-inline`), resolved by **recency**: an empty directory created minutes earlier by `claude plugin install` outranked the one holding every run, and `describeDataRoot()` called it trusted. §O1's failure through a second door | The data root is chosen by installation identity; the marker records which plugin root stamped it, and an ambiguous resolution fails preflight instead of guessing | `tests/regression.test.mjs` |
| Q3 | `.hyperpowers.json` is deep-merged over the defaults, so a project could set `codex.sandbox: danger-full-access` — turning the independent read-only reviewer into a writer — or repoint `codex.binary`, in a file the review pack excludes as Hyperpowers' own | `codex.sandbox`, `codex.binary` and `git.mode` are immutable; an attempted override is stripped and recorded in `config.rejectedOverrides` | `tests/regression.test.mjs` |
| Q4 | A passing gate verdict satisfied a transition **after** the run had changed: record a passing completion gate, insert a critical open blocker, and `COMPLETE` was still reachable. "Re-run the verifier first" was a prompt instruction, and an instruction is not an invariant | Each verdict stores a digest of the inputs it judged; a transition rejects a verdict whose digest no longer matches the state | `tests/regression.test.mjs` |
| Q6 | A gate may pass with an `unverifiable` condition, but stored only a pass/fail — so the toleration existed solely in whatever the director happened to write | The ids are persisted on the gate record and the final report renders them under residual risks | `tests/regression.test.mjs` |
| Q7 | `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` was required, so preflight refused a run over a setting no run mechanism reads; and `setup.mjs` answered the restart question by guessing | The key is recommended, not required; setup reports `unknown_until_preflight` rather than asserting | `tests/regression.test.mjs` |

### Q5. The Opus coordinators never invoked a Superpowers skill — measured

Both `opus-plan-coordinator` and `opus-execution-coordinator` said *"Apply `superpowers:writing-plans`"*
and *"Apply `superpowers:executing-plans`"*. Neither declares the `Skill` tool. Tool-call census of a
complete run (`20260727T112013Z-uzte5d`):

| agent | tools actually called | `Skill` attempts |
| --- | --- | ---: |
| `opus-plan-coordinator` | Read ×6, Bash ×15, Write ×3 | **0** |
| `opus-execution-coordinator` | Read ×4, Bash ×15, Agent ×2 | **0** |

The plan and the execution both succeeded — plan gate 15/15, every package accepted — because the
method is reproduced in the agent prompts. So the claim was inaccurate, not the behaviour.

Resolved by owning the adaptation: both prompts now say the method is Superpowers' *adapted and
reproduced here*, and say why invoking it would be wrong — it would import the very instructions
`superpowers-adaptation.md` overrides. Superpowers remains a genuine runtime dependency at the one
place it is genuinely invoked: the **director** calls `superpowers:brainstorming`, and it holds the
`Skill` tool. The preflight version gate therefore stays.

---

### Q8. A skill's `model:` pin does not survive an interactive session model — **and it cost real money to learn**

The architecture rests on Fable holding product authority. `skills/feature/SKILL.md` declares
`model: fable` to secure it, and ADR-0001 explains why the whole run must stay in one turn: the pin
is turn-scoped. Neither document establishes that the pin **takes** in the first place.

Measured, one machine, one account, one plugin build, one `/hyperpowers:feature` invocation:

| how the session was opened | director observed |
| --- | --- |
| `claude -p "…"` — headless, three pilot runs | `claude-fable-5` ✔ |
| `claude -p "/pintest"` — throwaway skill pinning fable, probed today | `claude-fable-5` ✔ |
| interactive session opened on Opus, twice | **`claude-opus-5`** ✘ |

The user's `~/.claude/settings.json` carries `"model": "opus[1m]"`, and the headless probe still
resolved Fable — so a persisted preference is not the cause. **An interactively selected session
model outranks a skill's declared model; a headless one does not.** Subagent pins are unaffected:
in both failed runs the researchers ran `claude-sonnet-5` correctly while the director did not.

Nothing broke. Every gate, dispatch and hook behaved. The run was simply not the system it claimed
to be, and the existing detection said so only when the director first tried to end its turn —
which a healthy run does once in 86 minutes (§O14). The first of the two runs reached $4.19 and 180
messages of real research before anyone looked at the model field.

Fixed at the two moments it is still cheap:

- **`transition()` refuses to leave `PREFLIGHT`** on a confirmed mismatch, naming both ways out —
  open the session on the tier, or declare the change with `{"models":{"director":"opus"}}`.
  Terminal targets stay exempt, so a run that cannot start can still reach `BLOCKED`.
- **Preflight's `claude-models` check stops being a disclaimer.** Availability still cannot be
  queried ahead of use, but by the time preflight runs the director has already written messages,
  so the tier that is actually directing is readable. `unverifiable` now means only "no message yet".

One shared reader, `directorTier()`, answers for both — and returns `ok: null` rather than `true`
when the question could not be asked, because "unobservable" and "agreed" are the distinction this
whole class of defect keeps blurring.

### Q9. The bootstrap threw away the artefact paths, so the director guessed one — observed live

Observed in the first production run, 2026-07-27, at INTAKE. The director wrote `request.md` to
`<data-root>/runs/<runId>/request.md`, which does not exist: the real layout is
`<data-root>/projects/<slug>/runs/<runId>/`. The exit gate refused the transition, the refusal
named the absolute path it had looked for, and the director recovered with one `mv`. Cost: two
turns. Nothing was lost, and the gate is the reason.

The cause was in `skills/feature/SKILL.md`, not in the model. `init` emits `runDir` **and the
absolute path of every artefact the run will write** — precisely so no one has to reconstruct one.
The documented bootstrap piped that output into `python3` to extract `runId` and discarded the
rest, so the only layout string left in the director's context came from the preflight check
`plugin-data-dir`: *"Run data at `<data-root>`"*. It appended the obvious suffix and was wrong.

A field the system writes and nobody reads — the mirror image of §K–§O's recurring defect, and it
fails the same way: quietly, with a plausible-looking artefact in the wrong place.

Fixed by printing the init payload instead of swallowing it, and by stating in the skill that
artefact paths are given, never derived. The same edit removed a second, unobserved problem: five
agent prompts and the bootstrap shelled out to **`python3`** to read one JSON field, in a plugin
whose stated constraint is zero runtime dependencies. Where `python3` is absent the substitution
yields an empty string and the agent writes to a path with a hole in it — silent, and untested
because this machine has `python3`. All six now use `node -pe`, which is guaranteed present:
the scripts being invoked are Node.

`$RUN` was also a fiction. Shell state does not survive between Bash tool calls, so the `"$RUN"`
in every later command block would have expanded to nothing; it worked only because agents
substituted the literal run id. The placeholders now say `<RUN_ID>`, which is what actually happens.

### Q10. The resolver-rebinding guard denied a query — my own regression, found by a production run

Same run, 16:19:46. A researcher probing the environment ran

```
which docker; docker --version; alias docker 2>/dev/null; type docker
```

and the `PreToolUse` hook denied it: *"`alias docker` rebinds a name this policy validates"*.

It does not. `alias NAME` with no `=` **prints** the current alias; it cannot bind anything. The
guard added earlier in this session (§Q1) treated any bare word after a resolver builtin as the
bound name, which is right for `autoload -Uz git` — where the bare name *is* the attack — and
wrong for the query forms of the other three. `docker` is protected because it is a remote
executor (`docker run … git push`), so the denial landed on the most ordinary environment probe
there is.

The forms were re-checked one at a time, and only some of them bind:

| form | binds? | why |
| --- | --- | --- |
| `alias git` | no | prints the alias |
| `alias git=/usr/bin/touch` | **yes** | measured, §Q1 |
| `hash git` | no | caches the PATH lookup of the real git |
| `hash -p /bin/touch git` · `hash git=…` | **yes** | measured, bash and zsh |
| `enable git` | no | enables a builtin of that name, and there is no `git` builtin |
| `enable -f lib.so git` | **yes** | documented |
| `autoload -Uz git` | **yes** | measured — the bare name is the whole attack |

So the rule is per-builtin, not per-token: a bare word binds only for `autoload`, for `hash` with
`-p`, and for `enable` with `-f`. Combined flags (`hash -lp`, `enable -af`) are matched, and both
have conformance rows so the exemption cannot be reached by rewriting the flag.

Table: **293 → 300 cases**. Five of the seven are the allowed query forms, including the exact
command the run was refused; two pin the combined-flag denials.

Two things worth keeping from this. The guard failed in the **safe** direction — a denied probe
costs a turn, an allowed rebinding costs the repository — and that is why the fail-closed choice
is right even when it is wrong. And the false positive was found by neither the 293-case table
nor six rounds of adversarial review, but by an agent doing something mundane on somebody's real
project. Ordinary use is a test genre the suite cannot imitate.

### Q11. The first production run — four hours, `COMPLETE`, and five defects only real work could find

`radiance`, 200k lines, Django + Docker. Feature: turn `decision_duration_seconds` from a
simulator-only constant into a measured, GDPR Art. 22-defensible duration.

| | |
| --- | --- |
| Outcome | `COMPLETE`, 2026-07-27, **4 h 12 min**, **$73.20** measured |
| Work | 6 work packages, 14 subagents, 6 Codex rounds, 0 fallbacks, 1 retry |
| Findings | 12 raised, **10 accepted, 2 rejected** — both rejections upheld by the next round |
| Gate | 19/24 conditions passed, 0 failed, 2 unverifiable |
| Diff | 26 files, none outside a work package's declared ownership |

The architecture did what it claims. Round 1 killed a design that promised an Art. 22 attestation
on a timer between two HTTP requests. Round 3 found that every verification command would have run
against image-baked code, because `django` has no bind mount and the plan routed `migrate` through
it. Round 5 found that a re-run guard skips a legitimate row — and Opus rejected the recommended
fix **by executing it**, showing it fabricates a three-day review window on a row that legitimately
arrived NULL, which `reporting.py` then averages into handling time. The contradictor's remedy
would have manufactured exactly the fake metric the feature exists to remove.

Five defects in *this* plugin surfaced, none of which 464 tests or six rounds of self-review had
found, because each needs an agent doing real work rather than a fixture:

1. **§Q9** — the bootstrap discarded the artefact-path map, so the director guessed a path.
2. **§Q10** — the resolver-rebinding guard denied `alias docker`, an environment probe.
3. **Criterion ids in test docstrings.** The prompt forbids plan references in shipped code; the
   work-package contract enumerates required cases *by criterion id*, and the implementer copied
   that shape into `"""AC-11: …"""`. Two instructions pulled opposite ways and the more specific
   one won. Fixed by saying where the id belongs — the contract and the report, never the file.
4. **Report field shapes were named but not shown.** `evidence` is a string array; the prompt said
   only that it was required, the implementer sent an object, and the rejected report was **not
   stored** — the work survived, its account of itself did not. Both WP-001 and WP-005 lost their
   narrative this way, and the coordinator re-ran the verification to rebuild it.
5. **Two consumers of a field only a rare hook stamps.** `13.12b-director-model` reported "not
   observed" and the final report printed "transcript measurement unavailable" — both because
   `observedUsage` / `observedDirectorModel` are written by the Stop controller, which fired once
   in an 86-minute run (§O14) and not at all before the gate in a four-hour one. The transcript
   answers both on demand. Fixed at both sites by asking the shared reader when the stamp is
   missing.

   The damage was not the total. The fallback estimate read **$70.46** and the transcript at that
   instant read **$70.461** — the event telemetry was exact. What vanished was the per-tier table,
   under a heading that still announced *"measured from the session transcript, not estimated"*.
   A first draft of this entry claimed the estimate was 4% low, by comparing it against a
   measurement taken after `COMPLETE` and several further director turns. The run trace settled
   it: at 20:12:30 the two figures agreed to the cent.

Defect 5 is §O14's lesson resurfacing one level up: *a fact checked only where a once-firing hook
stamps it is not a fact the system knows.* It was already fixed for budgets and for the tier
invariant; two other consumers still read the stamp.

Two weaknesses recorded and not fixed:

- **The review pack evicts `LOCKED PLAN` and `LOCKED DESIGN` first.** They are priority 3, so on a
  large diff — exactly when fidelity to the locked plan matters most — the diff crowds out the
  specification it should be checked against. Honest truncation worked (the omission is announced
  in the pack, and both implementation reviewers reported reduced coverage), so this cost a clean
  verdict rather than a silent one. The priority order is still wrong.
- **RED-phase evidence exists only inside an agent's final report**, and two independent mechanisms
  destroy that report. Condition §13.5 was therefore `unverifiable`: this run cannot prove its
  tests failed before the fix. A post-hoc reconstruction cannot recover output nobody captured —
  the failing run has to be recorded when it happens.

Cost, against the three pilots ($14–$22, 54–57 min to `PLAN_LOCK`): **$73.20 and 4 h 12**, with
`PLAN_LOCK` at 99 min. Cost still does not track feature size — it tracks findings to adjudicate
and packages to build.

Measured from the transcript, 656 messages and 574k output tokens against **71.9M cache reads**:

| tier | messages | output | cost | share of cost | design band (output) |
| --- | ---: | ---: | ---: | ---: | --- |
| fable | 65 | 54,143 | $19.52 | 26.7% | 0–10% — **9.4%**, within |
| opus | 255 | 283,418 | $36.62 | 50.0% | 20–25% — **49.4%**, double |
| sonnet | 334 | 236,507 | $17.06 | 23.3% | 65–100% — **41.2%**, under |

Three things follow, and none of them is a routing problem.

**Context is 81.8% of the bill** — 50.0% cache read, 31.8% cache write, 18.2% generation. §P8 put
it at two thirds on a shorter run; the longer the run, the harder that ratio tilts, because every
turn re-reads a context that only grows.
*(corrected: see §V6 — the total recomputes to 81.9% and the split to 49.4 / 32.5 / 18.1, so the
number stands; the causal clause does not. Cache write is not a re-read, and on the two runs after
this one it is the largest term of the four.)*

**The two most expensive agents are the two longest-lived.** The director cost **$20.36** for 9.4%
of the output at a 243:1 read-to-output ratio — the price of holding four hours in one turn — and
the execution coordinator **$17.02** across 92 turns, which is *more than all six implementers
combined* ($12.05). The orchestrator outspent the work it orchestrated.
*(corrected: see §V5 — true here, and true only here. On runs 8 and 9 the execution coordinator cost
$2.57 against $3.97 and $6.71 against $6.88. Only the director half generalises, and the largest line
in run 9 is the adjudicator **role** summed across dispatches, at 36.7%.)*

**Adjudication cost twice the drafting it judged.** Three adjudicator instances, 130 turns,
**$13.11**, against $3.82 for the design coordinator and $2.66 for the plan coordinator. Twelve
findings are more expensive to decide than a design and a plan are to write.

So the bands describe a run whose cost is dominated by production. This one's is dominated by
turns and by context, both concentrated in two Opus-tier agents that never end. Moving work to
Sonnet would not have touched it.

### Q12. The review pack dropped its own subject — found by asking what happens at ten times the size

§Q11 recorded that the implementation pack omitted the locked plan and design, and proposed
promoting the plan. Simulating that fix first showed it does nothing: at equal priority the stable
sort places the plan behind the diff and the reports, and 7 293 bytes remain. At the 180 kB cap the
choice looked like plan **xor** reports.

It was neither. `formatReports` rendered `reports/` verbatim, and that directory holds three
unrelated things — the file an agent writes at the path its prompt gives it (`WP-001.json`), the
copy the validator stores (`WP-001-attempt1.json`, `validate-agent-report.mjs:115`), and the
adjudication ledgers. Measured on the production pack: **13 blocks for 6 work packages**, three of
them duplicates and three empty ledger headers, **24 143 of 71 888 bytes**. The duplication is what
evicted the plan. Deduplicating frees more than the plan costs, and nothing else moves.

Then the same question at the size the tool is actually used at. A 120-file change, simulated:

```
diff 600 kB · reports 200 kB · plan 40 kB · design 120 kB · cap 180 kB
dropped: WORKING TREE DIFF, WORK PACKAGE REPORTS, LOCKED DESIGN
droppedMandatory: []          ← nothing failed
bytes: 123 362                ← the budget was not even filled
```

**The artefact under review was dropped, not truncated** — `renderPack` truncates priority ≤ 0 and
the diff sat at 1 — and `mandatoryGaps` ran for targeted rounds only, so a general implementation
round would have returned a verdict having seen the file list, the statistics and the evidence
matrix, and no code. The greedy loop skips an oversized section and moves on, which is why 57 kB
of budget went unused while the subject of the review was absent.

Two capabilities were measured rather than assumed, because the remedy rests on them:

| probe | result |
| --- | --- |
| `codex exec --sandbox read-only -C <proj>` reading an absolute path outside the project | **works**, unprompted — it ran `/bin/cat` itself |
| the same, running `git diff HEAD` in the project | **works** — full diff returned |

So the pack can stop pretending it will ever carry 600 kB. It carries what fits and states where
the rest is. Fixed together:

- the diff is **priority 0 and mandatory**, cut only on a `diff --git` boundary so no reviewer ever
  reads half a hunk, and carrying the exact command that yields the rest — **with the same
  `:(exclude)` pathspecs**, or the recovery instruction would reintroduce the false positive those
  exclusions exist to stop;
- explicit priorities, because a stable sort within one level meant array order silently decided
  what survived: diff `0`, **locked plan `1`**, work-package reports `2`, untracked `3`, design
  `4`, request `5`. The plan outranks the producers' own reports — it is the contract the code is
  checked against;
- a **share cap** on the diff (half the budget). Promoting it to priority 0 without one merely
  moved the starvation: rebuilt against the real run — the user had since staged the untracked
  files, taking `git diff HEAD` from 75 kB to **145 kB** — the diff alone consumed everything and
  the plan, the reports *and* the evidence matrix were all dropped;
- **truncate whatever can be cut on a safe boundary and says where the rest is; drop only what can
  be neither.** Tying "may be truncated" to priority left 47 kB of budget unspent while dropping a
  48 kB section whole. A prose plan has no honest half, so it is still all-or-nothing;
- the coverage warning lists each missing section *with where to read it*, and says the reviewer
  has read-only filesystem access;
- `mandatoryGaps` applies to every round, and distinguishes **dropped** (always a gap) from
  **truncated with a stated source** (not a gap — otherwise every large feature would block).

Rebuilt against the production run at its current 29-file, 145 kB diff:

```
before   dropped: LOCKED PLAN, LOCKED DESIGN          13 report blocks for 6 packages
after    177 930 / 180 000 bytes · dropped: LOCKED DESIGN (path given)
         diff 15/29 files · plan whole · reports 5/6 · evidence matrix whole · no gap
```

Four sections that could not coexist now all do, two of them partial and both saying where the
rest is. The budget goes from 73 % used with the subject absent to 99 % used with nothing silently
missing.

At the size that motivated all this — a 600 kB diff — the share cap shows roughly **15 % of the
files** and names the command for the other 85 %. That is the honest ceiling of a 180 kB pack, and
it is why the recovery instruction is load-bearing rather than decorative.

Two further defects surfaced when this fix was itself reviewed:

- **Deduplicating on the id alone kept the wrong record.** `sort()` orders
  `WP-001-attempt1.json` before `WP-001.json` (`-` is 0x2D, `.` is 0x2E), so with `>=` the
  *unvalidated draft* an agent left at the path its prompt named overwrote the copy the validator
  stored. Verified against the production pack: the surviving block read `WP-001 — complete
  (implementer)` instead of the stored record that disclosed its own report had been
  reconstructed. Now keyed on `storedAt`, stamped by the one code path that accepts a report —
  which is the difference between what the run stands behind and what an agent happened to write.
- **A mandatory section can be satisfied by a placeholder.** `gitRead` returns "(git diff HEAD
  unavailable)" when git fails — about forty bytes, so it fits any budget, the section is
  "present", and the round proceeds having seen no code. The size path was closed while the
  failure path stayed open. A mandatory section whose source could not be read is now its own
  category of gap.

The targeted rounds are deliberately **not** given recovery paths. A findings list and an
adjudication record are small and bounded: one that does not fit means something is badly wrong,
not merely large, so truncation there still fails the round — which is the §8.7 guarantee.

The general lesson is not about bytes. A bound chosen for one failure mode — spec §23 Risk 5, the
review that never returns — silently became the definition of what "adversarial review" covers.
Nothing in the system noticed, because the pack reported reduced coverage and the round ran anyway.

### Q13. The turn budget, not the package size, was the binding constraint — and the reverse was assumed

§Q11 blamed a 9-file work package for two agents being "truncated by the harness". Two of those
three words were wrong.

**Truncated by what.** The two `Connection closed mid-response` errors in the run hit the *Opus
execution coordinator*, not the implementers, while it was emitting the WP-005 dispatch prompt at
155 kB of context. The director recovered by resuming it twice, the second time asking for a
leaner prompt — visible in its own words at 19:10:01. Anthropic transport, handled.

**What actually cut the implementers.** Their turn counts:

| package | owned files | turns | cap |
| --- | ---: | ---: | ---: |
| WP-003 | 3 | 37 | 40 |
| WP-002 | 4 | **40** | 40 |
| WP-001 | 5 | **40** | 40 |
| WP-004 | 5 | **40** | 40 |
| WP-005 | 9 | **40** then **50** (xhigh) | 40 / 50 |

Five of six ended *exactly* at their declared `maxTurns`. A three-file package spent 37 of 40. So
package size was not the discriminator: **the cap was binding at every size**, and the largest
package was merely the first to be visibly killed by it. Bounding size alone would have left every
package still finishing on its last turn.

The cap is real and the number in the frontmatter is the number the harness uses. Every agent of
the run, against its declared limit:

| | declared | used |
| --- | ---: | ---: |
| `sonnet-implementer` ×4 | 40 | **40** |
| `sonnet-implementer` | 40 | 37 |
| `sonnet-implementer-xhigh` | 50 | **50** |
| `sonnet-verifier` | 40 | 37 |
| `sonnet-researcher` ×4 | 30 | 4–23 |
| `opus-design-coordinator` / `opus-plan-coordinator` | 50 | 18 / 17 |
| `opus-review-adjudicator` ×2 | 60 | 29, 23 |
| `opus-review-adjudicator` | 60 | **78** |
| `opus-execution-coordinator` | 80 | **92** |

Two exceedances, and both are the same thing: they are **exactly the two agents the director
resumed with `SendMessage`** — the adjudicator at 16:56:05, the coordinator at 19:01:13 and again
at 19:10:09. Every agent never resumed stayed at or under its limit. So a continuation grants a
fresh budget, and two distinct declared caps (40 and 50) were each landed on to the turn, which is
what establishes that the harness reads the declared number rather than applying a hidden ceiling.

What that does **not** establish is that 60 and 80 are honoured above the 50 observed. They are an
extrapolation of the same mechanism, and the falsifiable prediction is plain: the next run's
implementers should be able to pass 40. If they stop there anyway, this fix is inert and the entry
is wrong.

It also explains §Q11's report losses mechanically. WP-001's implementer finished at turn 40, its
report was rejected on a schema error, and it had **no turn left to use the correction the prompt
promises it**. "One correction per package" was structurally unavailable to every agent in the run.

Tool calls per turn, measured: **1.00 to 1.22, mean 1.18**. §P8 found 1.00 on two earlier runs, so
batching moved — a little. *(corrected: see §V4 — it did not move; the metric changed. §P8's 1.00 was
an identity, and the earlier runs measure 1.153 and 1.183 on this run's own denominator.)* That is the real economy: 47 calls spread over 40 turns is 40 whole
context re-reads, and at two calls per turn the same work costs half of them.

Fixed on all three fronts, in the order the evidence supports rather than the order first proposed:

- **Turn budgets raised** where they were binding: implementer 40 → 60, its xhigh retry 50 → 80,
  test engineer 40 → 60. Not generosity — room for the verification loop *and* for the one
  correction the report contract already promises.
- **`budgets.maxFilesPerWorkPackage: 7`**, refused by the plan gate with the package named and the
  way out stated. Above every size observed to succeed, below the one observed to fail. The plan
  review prompt already said *"a task too large to review as one unit will be accepted without
  being understood"* and did not catch it, which is this project's recurring lesson in its own
  mirror: an instruction is not an invariant.
- **The batching instruction carries its measurement now**, because "batch your calls" is advice
  and "you are at 1.18, two per turn halves the cost" is a target.

`describeBounds` grew a third answer for this. It replied "mechanical — the Stop hook transitions
the run to BUDGET_EXCEEDED" for every non-advisory bound, which would have been a lie about the
first bound a *gate* enforces; naming the enforcer is the entire point of that distinction.

### Q14. The report validator crashed on the one shape it exists to refuse

`semanticChecks` opens by stating its own invariant:

> Every field is read defensively: this function runs on reports that have already failed schema
> validation, so nothing about their shape can be assumed. Crashing here would turn a clean
> rejection into an opaque exit-1, which is exactly what an agent cannot act on.

Four lines below it calls `.some` on `report.evidence`. `x ?? []` defends against `null` and
`undefined`, not against an object — and an object is exactly what a live implementer submitted.
Reproduced: `TypeError: (intermediate value).some is not a function`, **exit 1**, no rejection
message, no schema errors, nothing the agent could act on. Five sites had the same hole, four of
them in `ownershipChecks`, all reachable only from a report that had *already* failed the schema.

So §Q11's account was too kind to the system. The implementer did not receive "evidence must be an
array"; it received a Node stack trace. The message quoted in the coordinator's report was the
coordinator's own reading of the schema, after the fact.

Two fixes, and the second matters more than the first:

- **`arr()`, used at all five sites.** A `function`, not a `const` arrow — a `const` down there is
  in its temporal dead zone when the checks run, which is the failure `verify-completion.mjs`
  already records and which I reproduced while fixing this one. Nine tests now submit an object in
  place of each array field and assert a clean exit 7 with no `TypeError` in stderr.
- **A refused report is kept**, in `reports/rejected/`, with the errors beside it. Discarding it
  was the real cost: the agent had spent its turn budget (§Q13) and could not rewrite what it had
  observed, so the coordinator re-ran the entire verification to reconstruct it, and §13.5 —
  *tests demonstrably failing before the fix* — became unverifiable for the whole run. A
  subdirectory rather than a suffix, because the review pack globs `*.json` in `reports/`: a
  sibling file would be handed to the contradictor as though the run stood behind a report it had
  refused. The rejection message now names the path, so the coordinator reads rather than re-runs.

The pattern, for the third time in this section: **the invariant was written as prose and not as
mechanism.** §Q12's pack announced coverage it did not enforce, §Q13's plan prompt named a risk it
did not catch, and here a comment described a defence four lines above code that lacked it.

**And this is where the execution coordinator's $17.02 went.** The plan had been to "reduce what
returns to the coordinator". Measuring what actually entered its context killed that idea:

| share | source |
| ---: | --- |
| 65% | its own command output — pytest, ruff, docker |
| 29% | its own file reads |
| 4% | run state, gates, tasks |
| **1%** | **everything returned by the six implementers** |

Reducing the reports would have optimised one percent. The coordinator was re-running every
implementer's verification itself — because the reports were gone. Its 92 turns and 218 kB of
context are a *consequence* of this section, not a separate problem, and both connection failures
struck while it was emitting a dispatch from that context. Its prompt now says to check a report
rather than re-run it, and to look in `reports/rejected/` before re-running anything — an
instruction that was not worth giving while refused reports were being thrown away.

### Q15. An external review of the fixes — one real bypass, one blind verdict, and two claims that did not survive

Codex reviewed the staged work as a whole. Eleven findings; each was reproduced or refuted before
anything was changed.

**Confirmed, and serious.**

*The Git policy was still bypassable.* `resolverRebindingIn` scanned the root command word only,
so a transparent wrapper hid the builtin from it. Executed, not argued:

| form | bash | zsh |
| --- | --- | --- |
| `builtin hash -p /usr/bin/touch git; git status` | **ran `touch`** | no-op |
| `command hash -p /usr/bin/touch git; git status` | **ran `touch`** | no-op |
| `builtin alias git=…; eval "git status"` | no-op | **ran `touch`** |
| `env hash -p /usr/bin/touch git` | no-op | no-op |

Every one was classified ALLOW. The classifier already treats these wrappers as transparent when
deciding *what runs*; it did not when deciding *what rebinds*, and two views of the same command
that disagree is the whole bug. A wrapper — and its own flags — no longer consumes command
position. `env` is correctly untouched: it looks for an executable, and a shell builtin is not one.
Six rows added, table at **306**.

*A completion verdict was not about anything.* The digest hashed identifiers and statuses, so
rewriting the implementation to broken code, replacing an evidence proof with a fabrication,
swapping the command that proof claims to have run, and editing the budget all left it
byte-identical — reproduced, four for four. It now hashes contents: adjudications, reviews, the
artefacts each gate reads, the working tree, and the effective configuration. **Per gate**, because
a single digest over everything refused a legitimate `DESIGN_LOCK → PLAN_DRAFT` — writing
`tasks.json` invalidated a design verdict that had never read it, and a gate that refuses on inputs
it never read is one people learn to route around.

The lifecycle test proved the old blindness on itself. It escalates a finding, decides it
differently with a new rationale, and then transitioned out of `DESIGN_LOCK` on the *original*
verdict, because `finding_id:decision:resolved` came back to the same triple. It now re-runs the
gate, which is what the refusal message tells a director to do.

*The large-diff path was unreachable.* `gitTry` defaults to a 400 kB `maxBuffer` and the diff
collector used it: in a real repository a 561 kB diff came back `null`, the section was marked
unavailable and the round hard-failed. Everything §Q12 built for that size sat behind a door that
never opened, and the 600 kB test injected its diff straight into the renderer, so it proved
nothing about collection. Collection now has a 16 MB budget — deliberately unrelated to the pack's
cap, because "too large to show" and "too large to read" are different facts — with a real
repository test above the old limit.

*The delivered report described a run that had not finished.* The phase table requires the final
report before the run may leave `FINAL_ACCEPTANCE`, so the production artefact opens **"Outcome:
FINAL_ACCEPTANCE (not terminal yet — regenerate this report after the final transition)"** for a
run that reached `COMPLETE`. The instruction existed and nobody ran it. A terminal transition now
regenerates it, best-effort, so a regeneration that cannot run leaves a stale document rather than
refusing a legitimate ending.

*A report id was a path.* `work_package_id` was validated as "a string" and interpolated into a
filename: `../../../../escaped` wrote outside the run directory entirely — including through the
rejected-report preservation added the same day. Constrained by pattern *and* confined by resolved
path, because the schema is a claim about data and the confinement is a fact about the file. Codex
also proposed requiring the id to name an existing task; that would have refused
`SYSTEM-VERIFICATION`, which is a real report and not a task.

*A mistyped bound deletes itself.* `9 > "seven"` is `false`, so a non-numeric override does not
raise a limit — it silently removes it. True of every numeric budget, not only the new one.
Non-numeric overrides now fall back to the default and are reported through the channel that
already exists for a refused override.

*Two smaller ones, both mine.* The report preferred a stored usage stamp over the live transcript,
so a Stop hook firing *early* pinned a figure for ever — reproduced with a $1 stamp; the transcript
is now the measurement and the stamp the fallback. And `describeBounds` claimed the Stop hook
enforces `maxExtraReviewsPerArtifact`, which the Codex adapter enforces.

**Refuted or reduced.**

The recommendation to make `maxFilesPerWorkPackage` advisory was not taken. This project's own
record is that an advisory bound is a bound nobody obeys — §Q13's plan-review prompt named the
risk in words and did not catch it. The threshold is provisional and the ledger says so; the type
check is the part that was genuinely missing. Codex's reading that "the ledger says size was not a
discriminator" is half the sentence: size was not the *only* discriminator, and nine files
exhausted both a 40-turn implementer and a 50-turn retry.

**Left open deliberately.** Publishing needs a version bump: the staged runtime differs materially
from the installed `0.6.2`, and two different implementations must not share one identity. That is
a release step, not a defect in the code.

### Q16. `--agent` pins the main session's model durably — and does **not** pin its effort

Measured on `claude 2.1.220`, headless (`-p`), against a user default of `model: opus[1m]`,
`effortLevel: high`. Probe agents in `.claude/agents/`, observation from the session transcript
(`message.model`, `"effort"`) and from hook environments.

**The mechanism exists and is first class.** `BIN` describes `initialPrompt` as the
*"Auto-submitted first message when this agent runs as the main session (via `--agent` or
settings). Not read when spawned as a subagent."* `--agent <name>` is a documented CLI flag:
*"Agent for the current session. Overrides the 'agent' setting."*

| # | Probe | Result |
| --- | --- | --- |
| T0 | control, no `--agent` | `claude-opus-5`, effort `high` — the user default |
| T1 | `--agent` pins `model: haiku` | `claude-haiku-4-5-20251001` — **model pin holds** |
| T1b | `--agent` pins `model: sonnet, effort: low` | model `claude-sonnet-5`; effort **`high`** — effort ignored |
| T3 | `--agent` pins `effort: xhigh` (opposite direction) | effort **`high`** again — confirms the pin is ignored, not clamped |
| T2 | `--model opus --effort xhigh` + `--agent` | `claude-opus-5` / `xhigh` — **CLI beats the agent definition** |
| T4 | `--resume` T1b's session with a second **user message**, no `--agent` | still `claude-sonnet-5` — **the pin survives a user message** |
| T5 | `effortLevel: "xhigh"` via `--settings` | effort `xhigh` — effort *is* pinnable, just not from agent frontmatter |
| T6b | `effortLevel: "xhigh"` in the project's `.claude/settings.json` | effort `xhigh` — **the file `/hyperpowers:setup` already writes** |
| T8 | `--agent` main session spawns a subagent | `Agent` tool present, subagent ran — depth budget unchanged |
| T9 | `env` read from a **Bash-tool** subprocess inside an `--agent` session | `CLAUDE_CODE_AGENT=probe2`, `CLAUDE_EFFORT=xhigh` — both inherited |

**T4 is the load-bearing one.** A skill's `model:` pin is cleared by a user message (Q8, ADR-0001);
a main-session agent's is not. That is the difference between a contract the harness enforces and
one the interaction style has to protect.

**Hooks are unaffected.** `SessionStart`, `PreToolUse` and `Stop` all fire from an `--agent`
session, and a plugin's own hook received the correct `CLAUDE_PLUGIN_ROOT` and
`CLAUDE_PLUGIN_DATA` for *its* plugin (probed with `--plugin-dir`). Omitting `tools:` inherits the
full toolset — `Read` and `Agent` were both usable.

**Two new observables.** Hook environments carry:

```
CLAUDE_CODE_AGENT=probe2      # absent entirely in a control session — an exact discriminator
CLAUDE_EFFORT=xhigh           # the session's effort, directly
```

T9 checked the half that matters for `verify-completion.mjs`, which runs as a **Bash subprocess**
and not as a hook: both variables are present there too. That distinction was worth measuring —
§O1 is the record of a Bash subprocess inheriting *another plugin's* `CLAUDE_PLUGIN_DATA`. These
two are session-scoped rather than plugin-scoped, so that contamination mode does not apply, but
the §O1 discipline still holds: the transcript check stays as the cross-check, because an
environment variable proves what the process was *told*, not what the API was *asked for*.

So *which director agent* and *at what effort* are readable directly, without inferring from
`message.model`.

**Resolved precedence:** CLI `--model` / `--effort` > agent definition (`model:` only) > settings
`effortLevel` > user default.

**Correction, recorded because it nearly became a finding.** A first pass concluded that project
`.claude/settings.json` hooks do not fire without workspace trust. They fire; the probe's
`settings.json` had been written by a shell heredoc that produced invalid JSON. The lesson is the
older one from §O1 — an inert config file and a disabled feature look identical from the outside.

**The shipped director, end to end.** With the working tree loaded via `--plugin-dir`:

```
--agent '__nope__' not found. Available agents: … hyperpowers:hyperpowers-director …

claude -p "…" --agent hyperpowers:hyperpowers-director --effort high
  models : ['claude-fable-5']        session default was opus[1m]
  effort : ['high']
```

An unknown agent name is a **hard error that lists the available agents** — the launch cannot be
mistyped into a silently wrong tier, which is precisely how the old arrangement failed.

**One thing `--agent` does not fix.** Effort is not pinned by *main-session* agent frontmatter, so
it rides on the launch flag and is verified rather than declared.

**Corrected by T29 — the claim below was wrong.** This entry originally stated that
`CLAUDE_CODE_AGENT` read from inside a subagent "names that agent, not the session", and that
`CLAUDE_EFFORT` there was unmeasured. Both were generalisations from a `--agent` **main session**,
which is the one place the variable is set. Measured directly:

| Process | `CLAUDE_CODE_AGENT` | `CLAUDE_EFFORT` |
| --- | --- | --- |
| main session launched with `--agent X` | `X` | the session's |
| main session, no `--agent` | **absent** | the session's |
| dispatched subagent declaring `effort: low` | **absent** | **`low`** — its own |
| dispatched subagent declaring `effort: xhigh` | **absent** | **`xhigh`** — its own |

So `CLAUDE_CODE_AGENT` discriminates *only* a main-session agent, and `CLAUDE_EFFORT` names the
effort of whichever process reads it. The shipped `launchContext()` therefore classified a
subagent's call as `launch: 'session'` and then compared that subagent's own effort against the
director's — `opus-adjudicator-xhigh` running a gate verifier would have reported a divergence that
does not exist. A live false-positive path, found by measuring a claim this ledger had already
recorded as fact.

**Scope of this measurement.** All of it is headless (`-p`), invoked from inside another Claude
session (`CLAUDE_CODE_CHILD_SESSION=1`). The interactive path is *not* covered and is what a real
terminal run must confirm. ADR-0001 carries the amendment this measurement forced.

### Q17. The environment contract travels on the launch command, so nothing is installed

**T16 — the decisive one.** A Stop hook that blocks unconditionally and counts its own
invocations, in a session launched with `--agent`:

| Launch | Hook invocations |
| --- | ---: |
| no cap set (harness default) | **9** |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=3` prefixed to the command | **4** |

Identical to D4's result for an ordinary session. The launch command reaches the harness, so the
one variable with no alternative mechanism does not need a settings file.

**T14 — and it reaches the scripts too.** `env` read from a Bash-tool subprocess inside the
launched session shows the prefixed variables verbatim, which is how `preflight.mjs` verifies the
contract from the process it was actually spawned under.

**What this removed.** `/hyperpowers:setup` no longer writes anything; `REQUIRED_SETTINGS`
(`disableWorkflows`, `includeGitInstructions`) is deleted rather than left unused. Writing the
project's `.claude/settings.json` had two measured costs, not one:

- It is **project-scoped**, so it changed every *ordinary* session in the repository. That is the
  whole reason §Q7 demoted `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` to recommended — and why it is back
  in the launch command now, where its cost lasts exactly as long as the run.
- It landed **in the working tree**, where a live run's round-5 reviewer raised a *blocking*
  finding against it, correctly observing an unowned file that "disables workflows and related
  safeguards". A mandatory review round and an adjudication cycle were spent on our own output.

The own-files exemption in `workspace.mjs` stays, and is now purely a **compatibility** measure:
nothing writes those files, but repositories configured by an earlier version still contain them
and no work package will ever own them.

**T17 — the whole chain, with the shipped plugin.** Launched with the real command and
`--plugin-dir`, the director ran `preflight.mjs` itself and reported `environment-contract: pass`.
Launch env → harness → Bash subprocess → the script that verifies the contract, end to end.

**`--effort` is load-bearing, not decorative.** That probe omitted `--effort`, and preflight's own
`director-launch` check — reading `CLAUDE_EFFORT`, not asking the model — reported the run at
**`medium`** against the configured `high`. So a user who copies the launch command and drops that
flag gets measurably weaker reasoning at every gate, with only a warning. Observed once and the
mechanism is *not* established (an earlier probe without `--effort` inherited the session's `high`),
so this is recorded as a reason to keep the flag and keep checking it, not as a rule about defaults.

It is also the first live firing of the effort guard, and it fired on a divergence nobody planted.

**A false conclusion caught in passing.** `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=0` on the launch
command did *not* block a dispatch, and the variable was visibly present in the process. The
tempting reading — "launch env is ignored" — would have killed this design. T16 falsifies it; `0`
is almost certainly read as absent by a `value || default` coercion. **Recorded because `=0` is
not a usable probe for this variable**, and the next person to reach for it deserves to know.

### Q18. `--agent` does not close the tier question — `--model` still overrides it

§Q16 T2 measured `--model opus --effort xhigh --agent probe2` → `claude-opus-5`. Precedence is
CLI > agent definition > settings > user default, so `claude --model opus --agent
hyperpowers:hyperpowers-director` produces an Opus director and the launch mechanism says nothing.

This is why the PREFLIGHT transition guard and completion condition §13.12b **are not redundant**
now that the launch is enforced. Two ways remain for a run to direct itself with the wrong model:
an explicit `--model`, and the legacy `/hyperpowers:feature` path. The guard is the only thing that
sees either, and it costs one transcript read against the four hours and $73 that the failure cost
twice before it was noticed.

---

## R. Subagent interactivity, and `SubagentStop` as a controller

Measured against `claude 2.1.220`. `BIN` = JS extracted from the Bun-compiled binary, `EXP` =
black-box run. Two design questions, asked before writing code; both answers moved a decision.

### R1. `AskUserQuestion` is unavailable inside **every** subagent — **VALIDATED**

`BIN` — one set decides, consulted before anything that could relax it:

```js
zGe = St_("external")   // TaskOutput, ExitPlanMode, EnterPlanMode, AskUserQuestion, ConnectGitHub,
                        // propose_skills, WaitForMcpServers, RefreshMcpTools, Workflow,
                        // ScheduleWakeup, EndConversation
function B2_({tools:e,isBuiltIn:t,…}){ return e.filter((a)=>{
  if(WO(a))return!0;                        // MCP tools — R3
  if(Ga(a,jH)&&o==="plan")return!0;
  if(zGe.has(a.name))return!1;              // ← unconditional
  if(!t&&Gpo.has(a.name))return!1;          // ← dead: Gpo = new Set([...zGe])
```

Every spawn funnels through `hte(agentDef, tools, isAsync, false, …) → B2_`; the fourth argument
is the only bypass and is `false` on that path. So no frontmatter, no `tools:["*"]`, no permission
rule restores it — the tool is **removed from the API tool list**, not denied at permission time.
Built-in agents get no wider access than plugin ones: `Gpo` is a copy of `zGe`, so its line is
unreachable.

`EXP` — interactive session, where the main thread *does* have the tool. Verbatim:

> `Error: No such tool available: AskUserQuestion. AskUserQuestion is not available inside
> subagents. Complete the task with the tools provided and return findings to the orchestrator.`

`Gks()` emits that string from exactly `isSubagent && zGe.has(name)`, so it is authoritative.
`Workflow`, `TaskOutput`, `ScheduleWakeup` and `EndConversation` were then measured the same way
and returned the identical string — five of the eleven members measured, the rest read from `St_`.

**Consequence here:** `Workflow` is *already* absent from every subagent, so §E1's deny and its
test only ever needed to cover the main thread.

### R2. `fork` is flag-gated and absent by default — **VALIDATED**

```js
Eee={agentType:"fork",tools:["*"],maxTurns:200,model:"inherit",permissionMode:"bubble",source:"built-in"}
function Mt_(){ if(tse())return"disabled";
  if(Yt(Z.CLAUDE_CODE_FORK_SUBAGENT))return"env"; if(su(…))return"disabled";
  if(_n())return"disabled"; if(Ke("tengu_copper_fox",!1))return"gb_rollout"; return"disabled" }
```

`EXP` — a normal session answers **`Agent type 'fork' not found`** while the Agent tool's own
description still mentions forking. Forced with `CLAUDE_CODE_FORK_SUBAGENT=1` it spawns, and
returns the *same* refusal: `tools:["*"]` resolves to the already-filtered pool.

Two traps for anyone repeating this. A fork inherits the parent's context, so its **self-reported**
tool list is the parent's `<system-reminder>` listing, not its own (mine claimed
`Workflow=PRESENT` — false). And the fork run is necessarily headless, where `_n() && !Sue()`
disables `AskUserQuestion` for every caller; it still discriminates because `Gks` tests the
subagent branch *before* the not-enabled branch, which would have said `exists but is not enabled
in this context`.

### R3. MCP tools bypass the subagent exclusion — **VALIDATED**

`WO(e){return e.name?.startsWith("mcp__")||e.isMcp===!0}` returns `true` on `B2_`'s first line.
`EXP` — a throwaway stdio MCP server via `--mcp-config --strict-mcp-config`: a subagent called
`mcp__ask__probe_ping` and got `pong`, in the run where `AskUserQuestion` was absent. **The only
sanctioned route to user interaction from inside a subagent.**

### R4. MCP `elicitation` works from a subagent, with a worse UI — **VALIDATED**

`EXP` — the `initialize` handshake: `{"roots":{"listChanged":true},"elicitation":{}}`,
`{"name":"claude-code","version":"2.1.220"}`. A tool call answered by a server→client
`elicitation/create` with an `enum` schema round-trips. Headless it degrades to
`{"action":"cancel"}`. Interactive, with a **subagent** as caller, the dialog renders:

```json
{"action":"accept","content":{"choice":"Yes it rendered"}}
{"action":"accept","content":{"choice":"Trois — celle-ci incluse"}}
```

The proof is structural: a client that cannot show a dialog answers `decline` with no content, so
an `accept` carrying a valid enum member implies a rendered UI and a human selection. The second
run is self-verifying (the third option could not be picked if only two rendered) and shows UTF-8
surviving. The `enum` comes straight from the caller's array, so `AskUserQuestion`'s 4-option
ceiling does not apply.

**But the UI is poorer**: elicitation renders one `message` plus a bare enum, where
`AskUserQuestion` carries up to four questions per call with a header, a per-option `description`
and `preview`. That is the real cost of this route.

**Two objections withdrawn.** A bundled server does not breach zero-dependency (`node:fs`,
`node:path`, no install), and it is not a workspace side-effect: the plugin manifest accepts
`mcpServers` — *"MCP servers to include in the plugin"* — so installing the plugin is enough and
nothing is written into the user's project. Nor is `requiresUserInteraction: true` needed;
elicitation is server-driven. What stands is §B3: plugin agents ignore `mcpServers` frontmatter,
so the server is **session-wide**, visible to the main thread too. Cosmetic, not a correctness
cost.

### R5. `SubagentStop` / `SubagentStart` payload — **VALIDATED**

```
SubagentStart: agent_id, agent_type, cwd, hook_event_name, prompt_id, session_id, transcript_path
SubagentStop : … + agent_transcript_path, background_tasks, effort, last_assistant_message,
               permission_mode, session_crons, stop_hook_active
```

`agent_type` is present and reliable (§L7's filter is sound). Beyond §L7: `agent_id` is stable and
on **both** events, so start/stop pairing is possible; `transcript_path` stays the **main**
transcript while `agent_transcript_path` is the subagent's; `session_id` equals the main
session's, so delegation does not endanger §O1; and `prompt_id` is **identical** across `Stop`,
`SubagentStart` and `SubagentStop` — which matters in R6.

### R6. A `SubagentStop` block re-drives the subagent, not the run — **VALIDATED**

`EXP` — a hook blocking every `SubagentStop`, counting itself, against a subagent told to say
`READY`:

| Observation | Result |
| --- | --- |
| Invocations / blocks honoured | **9 / 8** at harness default — as `Stop` (§D4), on its own counter |
| With `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=3` | **4 / 3** — the cap env governs `SubagentStop` too |
| What is re-driven | the **subagent** (`READY → BANANA1 → … → BANANA8`) |
| Main-thread `Stop` meanwhile | **1** firing, `stop_hook_active=false` |
| Value returned to the parent | `BANANA8` — the hook's text, not the agent's report |

The two loops are independent: a `SubagentStop` block cannot hold the turn, reach `SUSPENDED` or
stop the run. Coverage would also shrink — the event fires only when a subagent *ends*, never
during a long one, never on main-thread-only stretches, and §P3–P9 measured `PLAN_LOCK` at 54–57
min with `Stop` as the only heartbeat. On the corrupted return value: checked, not assumed —
`submit` stores the report under `reports/` and the gate tests `task.reports.length`, so §16.4's
evidence survives on disk; what is destroyed is the coordinator's narrative view.

**Verdict, per mechanism** — the three parts do not port alike, and answering them as one question
hides the only real defect in the proposal.

- **Budget bounds — portable, and a net gain as an *addition*.** Enforcement does not need
  blocking: `budgetOverrun()` writes a `BUDGET_EXCEEDED` transition and the next main-thread
  `Stop` sees `stopAllowed(...)` and ends. The input is there — R5 shows `SubagentStop` carries
  the **main** `transcript_path`, so `analyseTranscript` computes the same cost. §O14 already
  forced this check into `transition` because `Stop` fired once in 86 minutes; this is a third
  sampling point, firing exactly during the long executions where `Stop` does not.
- **Stall detection — do not port.** `progressSignature` is run-level and keyed on *submitted
  reports* (§L3). A subagent's process ends before its report is stored, so a healthy wave of *N*
  agents yields *N* "no new signature" samples: §L3's defect with the sign flipped —
  there attempting counted as progress, here finishing would count as stalling.
- **`SUSPENDED` — do not port; the naive port has a bug.** The counter is keyed on `prompt_id`
  (`if (s.turn.promptId !== promptId) s.turn = {promptId, blocks: 0}`), and R5 measured
  `prompt_id` identical across all three events. A `SubagentStop` copy would increment the *same*
  `state.turn.blocks` and trip `softCap` early — suspending a healthy run because subagents
  finished. It would be watching the wrong cap anyway: the two block counters are independent.

Whatever is added spends the headroom that keeps the report check alive — 20 s declared in
`hooks.json`, 16 s budgeted, and a hook the harness kills never runs `onError`.

### R7. Park-and-relay: a subagent reaches the user with no MCP — **VALIDATED**

`EXP`, interactive, a level-1 agent standing in for the director: it emitted a question packet and
ended its turn **with zero tool calls**; the main thread put the questions through
`AskUserQuestion`; the human answered (free text, over both offered options); `SendMessage`
resumed it — *"had no active task; resumed from transcript"* — and it returned naming the
feature and every question id unprompted, reporting the free text as unresolved rather than
coercing it onto a label. Because the relay is one `AskUserQuestion` tool call, **the turn never
ends and the B1/B2 model pin holds**. The park is an ordinary subagent stop, so `SubagentStop`
fires; `validate-agent-report.mjs` does not mistake a parked director for a finished implementer,
being filtered on `agent_type`.

That run only proved recall of the agent's *own prompt*, which is trivially in the transcript it
resumes from. A second run tested **discovered** state: three unguessable nonces on disk, two
fetched by level-2 children (one behind a 40 s `sleep`) and never read by the parent. After the
park and resume it returned both verbatim and produced the third by spawning a *new* child.
Transcript audit of the post-resume segment: exactly one tool call, that spawn. So state
discovered through delegation survives a park, and so does the ability to delegate.

### R7b. A parked agent is re-driven by every child that finishes — **VALIDATED**

Same run, from the level-1 agent's transcript:

| t | event |
| --- | --- |
| +4.5s / +6.1s | both children launched |
| **+10.8s** | park packet emitted — it parked at once |
| +12.5s | fast child delivered → **parent woken, turn resumed** |
| +20.4s | packet re-emitted |
| +71.2s | slow child delivered → woken again |
| +73.6s | packet re-emitted — the one the parent session received |

The completion notification fires only when an agent stops with **no live background children**,
so the main thread saw nothing for 73 s although the question existed at 11 s. Hence: park-and-relay
**cannot overlap with in-flight delegation** — a director that dispatched a wave cannot ask until
the wave lands; it costs **one parent turn per child** (the packet was generated three times), a
cost mechanism §P8 does not cover; and this is the one thing the MCP door does better, since an
MCP question is asked *inside* the parent's turn. R4's worse UI against R7b's concurrency is the
real trade. Untested mitigation: awaiting children synchronously would collapse the re-drives into
one turn, losing parallel dispatch.

### R8. The two questions are one decision — **ANALYSIS**

With the director on the main thread, R1–R4 say keep the interactive phases there and leave the
loop on `Stop`. Move the director into a level-1 subagent and three measured facts flip together:

- **The loop must move, and R6's objection dissolves.** A `SubagentStop` block re-drives the
  subagent — exactly what a subagent-director needs. R6's verdict holds only while the director is
  the main thread.
- **The model pin gets stronger.** §B1 makes a skill's `model:` turn-scoped and fragile; §B4 says
  plugin agents *do* honour `model` and `effort`. A director defined as an agent has a durable pin.
  This is the strongest argument for the move, and it has nothing to do with interactivity.
- **The depth cap becomes binding.** §C1: default 3, harness-enforced. Today
  main(0) → coordinator(1) → implementer(2) fits; with a director at depth 1 the tree becomes
  main(0) → director(1) → coordinator(2) → implementer(3) and depth 3 is refused. The move
  *requires* `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=4` — raising a harness safety limit, in the
  opposite direction from §4.3's deliberate tightening to 2.

Scope note: after `DESIGN_DRAFT` no user validation is permitted (ADR-0001), so the MCP door would
only ever serve `BRAINSTORMING` — which is also the one interactive phase that delegates, and
therefore the only place R7b's constraint bites.

### R9. Rejected third channel: `SendUserMessage` — **VALIDATED (unusable)**

`BIN` — the tool exists (alias `Brief`, *"Send a message the user will read"*) but is gated behind
the CLI flag `--brief` and is one-way: it could announce a question, never receive its answer.
Recorded so it is not re-derived.

### R2b. Correction — the skill-level `context: fork` is a different path from the `fork` agent type

§R2 measured the **built-in `fork` agent type** (`agentType:"fork"`, `Mt_()`, answering
`Agent type 'fork' not found` unless `CLAUDE_CODE_FORK_SUBAGENT` or `tengu_copper_fox`). That
result is correct and stands.

It does **not** cover the other thing called fork. A *skill* may declare:

```js
context: E.enum(["inline","fork"])  "inline expands into the current conversation; fork spawns a subagent."
agent:   "Agent type to spawn when `context: fork`."
```

`EXP` — a project skill with `context: fork` and `agent: probe-fable` (`model: haiku`), invoked as
`claude -p "/forkprobe"` in a session defaulting to `opus[1m]`, **with no flag set**:

```
subagents/agent-acf78….jsonl → models: ['claude-haiku-4-5-20251001']
meta.json                    → {"agentType": "probe-fable"}
```

The skill spawned the named agent and the agent's `model:` pin won. A `SubagentStop` hook then
fired for it carrying `agent_type: probe-fable`, and a `{"decision":"block"}` re-drove it
(`stop_hook_active` true on the second firing).

Recorded because §R2 reads as though one experiment settles both, and someone will otherwise
conclude skill-level fork is unavailable when it was measured working. **It changes nothing about
the decision**: §R1 removes `AskUserQuestion` from the API tool list of *every* subagent with no
frontmatter bypass, so a forked director still cannot run `INTAKE` or `BRAINSTORMING` without
park-and-relay (§R7, priced at +1 parent turn per returning child in §R7b) or MCP elicitation
(§R4). The flag was never the constraint; the tool filter is. Whether skill-level `context: fork`
is itself gated on other accounts is **unverified**.

---

## S. Budget bounds removed — the cap destroyed runs instead of capping them

### S1. `BUDGET_EXCEEDED` was unreachable-from, and its printed remedy did not exist

The five bounds evaluated by `budgetOverrun()` — `maxCostUsd`, `maxDurationMs`, `maxWorkPackages`,
`maxSubagents`, `maxFallbacks` — all had one consequence: `transition(… 'BUDGET_EXCEEDED')`.

```js
// phases.mjs      BUDGET_EXCEEDED: { …, successors: [], requires: [], next: '' }   ← terminal
// resume-run.mjs  if (isTerminal(state.phase)) fail('A terminal run is not resumable.', 8)
// stop-controller `Raise it in .hyperpowers.json and \`/hyperpowers:resume\``       ← cannot work
```

So the bound did not cap a run, it **ended** one permanently. Three quarters through a feature —
design locked, plan locked, packages built, reviews adjudicated — crossing a number made the run
unfinishable at any price, and the message it printed told the user to do the one thing the resume
path refuses. `state-machine.mjs` was honest about it (*"start a new run"*); the hook was not.

**Removed**, on the user's instruction and with no counter-argument worth making. What replaces it
is `costNotice()`: the measured spend is reported on every transition once it passes
`budgets.costNoticeUsd` (default 75), and nothing stops. `/hyperpowers:abort` was always the
honest form of this feature — it is the user's decision, taken with the number in front of them.

**Kept deliberately**, because none of these ever went through `BUDGET_EXCEEDED` and each acts at a
point where the run can still respond: `maxAttemptsPerTask` and `maxExtraReviewsPerArtifact` (retry
breakers) and `maxFilesPerWorkPackage` (the plan gate's `tasks-sized` condition, carrying the
measurement that nine owned files exhausted both a 40-turn implementer and a 50-turn retry).

**The phase is deleted, not merely unreachable** — from `PHASES`, `TERMINAL_PHASES`, `EXECUTION`'s
successors and `canTransition`'s exemption list. A field the system reads and nothing writes is
this codebase's signature defect; leaving a terminal phase nothing can enter would have been the
same shape. `schemas/` never enumerated it, so no schema change was needed. The regression test was
inverted rather than deleted: it now asserts the transition *happens*, that the notice names the
figure, and that the phase and `budgetOverrun` are both gone.

**What this does not remove.** Stall detection, the retry breakers, gate refusals and
`/hyperpowers:abort` are untouched. A run that makes no progress is still escalated and finally
blocked; what can no longer happen is a run being ended for succeeding expensively.

### S2. The soft cap described a harness nobody was running in

`stop.blockCap` defaulted to **200** — the number `/hyperpowers:setup` used to write into the
project as `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. The harness's own default is **8** (§D4, reconfirmed
on `SubagentStop` in §Q17 T20). The controller yields `softCapMargin` blocks early:

```js
const softCap = Math.max(1, config.stop.blockCap - config.stop.softCapMargin);   // 200 - 4 = 196
if (blocks >= softCap) { …transition to SUSPENDED… }
```

So whenever that variable was **not** in force, the controller waited for a 196th block that could
never arrive, never yielded, and the harness truncated the turn at 8 — no `SUSPENDED` state, no
resumable phase, the turn simply gone. The mechanism built to make truncation graceful was inert in
exactly the sessions that needed it. After §S1 removed the settings file, that is *every* session.

**Fixed** to `blockCap: 8`, the measured reality, still raised by the env var when one is set. The
margin went `4 → 2` in the same edit: harmless against 200, it would have surrendered half the
budget against 8, suspending on the fourth block instead of the sixth.

The regression test drives the real controller with **no** `.hyperpowers.json` and the variable
deleted from the environment, and asserts the run reaches `SUSPENDED` in fewer than 8 blocks. On
the old default it loops 8 times and never suspends.

### S3. Prerequisites for a level-1 subagent director — four measurements

Taken before writing any of it, because each one could have changed the shape of the code.

**T24 — two `SubagentStop` hooks compose, and a block wins.** `validate-agent-report.mjs` already
occupies that event; a phase controller would join it. Two hooks registered, one returning `{}` and
one blocking twice:

```
blocker#1 active=false    allower#1 active=false
blocker#2 active=true     allower#2 active=true      ← the subagent was re-driven
blocker#3 active=true     allower#3 active=true
```

Both ran on every firing, in **both** orderings of the settings file, and the `{}` did not cancel
the `block`. So the controller does not have to be merged into the report validator. They run
concurrently, so neither may assume it is alone in `state.json` — both already write under
`withLock`, which is what makes that safe.

**T25 — depth 3 works on the harness default, and the variable Hyperpowers used to install breaks
it.** `main(0) → lvl1(1) → lvl2(2) → lvl3(3)`, evidenced by the subagent transcripts rather than by
what the agents said about themselves:

| Launch | Subagent transcripts written |
| --- | --- |
| no variable (harness default 3) | `lvl1`, `lvl2`, **`lvl3`** |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` | `lvl1`, `lvl2` — and `lvl2` reported the `Agent` tool *absent from its tool set* |

At depth 2 under a cap of 2 the tool is **removed**, not denied — so the refusal is not something a
prompt can work around. The director-as-subagent tree therefore needs the default and nothing else,
which is the same direction as removing the settings file: one fewer thing to install, and the one
value we used to install would have made the new architecture impossible.

**T26 — a subagent's `effort:` pin holds.** *(read the title literally: this measures effort, and
§V2 records the eleven sites that cited it for an unconditional **model** pin.)* Three agents
dispatched in one message. The session
default was `xhigh` at this measurement; §Q16's effort entries were taken when it was `high`, so a
reader re-running either probe should read the control column, not the absolute value:

| Agent declares | Observed |
| --- | --- |
| `effort: low` | **`low`** |
| `effort: xhigh` | `xhigh` |
| nothing | `xhigh` (session default — the control) |

This is the opposite of a skill's `effort:` and of a *main-session* agent's, both of which were
measured not to hold (§Q16 T1b/T3). Under a subagent director the effort is pinned by frontmatter,
so no `--effort` flag and no settings key is needed to secure it.

**T27 — a long subagent does not stop between phases.** A six-phase agent (`maxTurns: 40`), each
phase a real tool call, under a counting `SubagentStop`:

```
phases recorded: 6/6
SubagentStop invocations: 1     stop#1 phases_done=6 agent=phaser
```

**One firing, zero blocks.** The agent ran the whole workflow inside a single dispatch. That
matches the two independent real-world figures: the main-thread Stop hook fired once in an
86-minute run (§O14), and the four-hour production run reached `COMPLETE` with `turn.blocks = 0`
and no `continuation` event at all.

*Honest limit:* this is a six-phase proxy with trivial per-phase work, not nineteen phases with
subagent waves, Codex rounds and gate refusals — a real director has more occasions to believe it
is finished. The direction is consistent across three measurements, and §S2 is what makes being
wrong survivable: the run suspends resumably at six blocks instead of being truncated at eight.

### S4. The director is a subagent — what that changed, and the defect it exposed

`/hyperpowers:feature` now dispatches `hyperpowers-director` instead of directing from the main
thread. The tier stops depending on the model the user's session happens to be on, with no launch
flag and no settings file, because a subagent honours its declared `model:` **and** `effort:`
unconditionally (T26).
*(corrected: see §V2 — T26 measured **effort**. The model pin holds against the session default, which
is what this architecture needs, but a per-invocation `model` argument and `CLAUDE_CODE_SUBAGENT_MODEL`
both outrank it.)*

**Sizing `maxTurns`.** The production run's main-thread director produced **155** assistant
messages across 4h12 and nineteen phases, with 67 tool calls: `Bash` 28, `TaskOutput` 13, `Agent` 9,
`SendMessage` 4. 400 is the declared cap. It is *not* 2.6× headroom: `TaskOutput` is removed from
every subagent (§R1), so those 13 calls become synchronous dispatches, and the same work may cost
more turns rather than fewer. Caps bind exactly (§Q13) and a truncated director leaves no
diagnostic, so it is sized to be wrong in the safe direction.

**Three constraints became mechanical.** `Workflow`, `TaskOutput` and `ScheduleWakeup` are all in
the set the harness strips from subagents (§R1). The director's standing rules against workflow
orchestration, background dispatch and scheduled wake-ups are now enforced by the tool filter
rather than by its own prompt — and the production run's 13 `TaskOutput` calls are evidence the
prompt alone was not enough.
*(corrected: see §V1 — background dispatch is **not** among them. `run_in_background` is a parameter
of a tool the director keeps, and run 9b's director used it.)*

**The check had to move, or it would have measured nothing.** `directorTier()` read
`currentMainThreadModel()`. Under this architecture the main thread is whatever the user is on, so
the check would have compared the wrong process and failed every run at the first transition. It
now reads the director's own subagent transcript, located from the main one:
`<transcript minus .jsonl>/subagents/agent-<id>.{meta.json,jsonl}`, the meta carrying
`{agentType, description, toolUseId, spawnDepth}`.

**T28 — and that is readable while the agent is still running.** A subagent probing its own session
directory found its own pair already written (`agentType`, `spawnDepth: 1`, four lines of
transcript). So the tier is checkable at the first transition rather than only after the fact.
`spawnDepth` is checked too: a director at any depth but 1 would have coordinators that cannot
dispatch (T25).

**T29 — a claim this ledger had already recorded as fact was wrong.** §Q16 stated that
`CLAUDE_CODE_AGENT` read inside a subagent "names that agent", and that `CLAUDE_EFFORT` there was
unmeasured. Both were generalisations from a `--agent` main session:

| Process | `CLAUDE_CODE_AGENT` | `CLAUDE_EFFORT` |
| --- | --- | --- |
| main session with `--agent X` | `X` | the session's |
| main session, no `--agent` | **absent** | the session's |
| subagent declaring `effort: low` | **absent** | **`low`** — its own |
| subagent declaring `effort: xhigh` | **absent** | **`xhigh`** — its own |

The shipped `launchContext()` therefore classified a subagent's call as `launch: 'session'` and
compared that subagent's own effort against the director's — `opus-adjudicator-xhigh` running a
gate verifier would have reported a divergence that does not exist. A live false-positive path,
found only by measuring something already written down as measured. Identity now comes from
`agentType` in the meta file, and the env-based inference is gone.

**Not yet wired.** The Stop controller still lives on the main thread's `Stop` event, so nothing
injects phase instructions or detects stalls for a director that is now a subagent. That is Phase 2
(`SubagentStop`, filtered on `agent_type`, which T24 shows can coexist with the existing report
validator). Until then the tree is mid-refactor: the pieces below are correct in isolation and no
end-to-end run is claimed.

### S5. The autonomy loop moved to `SubagentStop`, and the filter is what makes it safe

Blocking `Stop` re-drives the **main thread**, which under §S4 directs nothing. Blocking
`SubagentStop` re-drives **that subagent** (§R6). So the phase machine moved to
`scripts/subagent-controller.mjs`, and `stop-controller.mjs` kept one job: while a run is
non-terminal and the director has returned unfinished, block the main thread with "relay the
question packet or re-dispatch the director" — so a run cannot be silently abandoned.

**The earlier analysis said not to port two of the three responsibilities. Both objections were
conditional on the director being the main thread, and both dissolve behind one filter:**
`agent_type === hyperpowers-director` (§R5: present and reliable).

| Responsibility | Objection under a main-thread director | Under a subagent director |
| --- | --- | --- |
| Stall detection | a healthy wave of ten implementers samples as ten "no progress" cycles, because a worker's process ends before its report lands | only the *director* stopping is sampled — the same checkpoint ending a turn used to be |
| `SUSPENDED` / block counting | `prompt_id` is identical across `Stop` and `SubagentStop`, so a copy would increment the main thread's counter and suspend a healthy run | counted on `agent_id` in `state.directorTurn`, a separate field from `state.turn`; two loops, two counters, 8 blocks each |
| Cost and tier observation | portable, and wanted | `transcript_path` is still the main transcript, so accounting is unchanged — and this hook fires whenever the director pauses, where `Stop` fired **once** in 86 minutes (§O14) |

Both hooks now on `SubagentStop` coexist: §S3 T24 measured that both run and a block wins over an
allow, so the controller did not have to be merged into the report validator. They execute
concurrently and both write state under `withLock`.

**One rung of §16.3 changed meaning.** Its top was "escalate to Fable". The director *is* Fable, so
escalating is no longer a hand-off: it now tells the director to stop delegating and decide itself.
The ladder is still named in the injected message, which is what the regression test pins.

**Regression coverage.** A returning `sonnet-implementer` must move neither the stall counter nor
the director's block counter — the single test that would fail if the filter were dropped, and the
one defect this move could plausibly have introduced.

### S6. Park-and-relay — the director asks by stopping

`AskUserQuestion` is removed from every subagent's tool list (§R1), so the director writes a packet
and ends its dispatch. The main thread — which still has the tool — renders it and answers.

**The mechanic that makes it work is a hook that declines to do its job.** The `SubagentStop`
controller exists to re-drive the director; if it blocked here, the director would go straight back
into its own turn and the question would never reach the only process able to render one. So a
pending question is the one case where it **allows** the stop. The main thread's `Stop` hook then
blocks with the file path and the instruction. Measured end to end:

```
1. ask                → asked: 1
2. SubagentStop       → <allow>   "waiting on 1 question(s) from phase INTAKE"
3. Stop               → block     names AskUserQuestion, and "verbatim"
4. answer             → answered: 1
5. SubagentStop       → block     the phase machine resumes
   Stop               → block     "re-dispatch the director"
```

**The packet mirrors `AskUserQuestion`'s own input** — 1–4 questions, a `header` of at most 12
characters, 2–4 options each with a label and a description — and is validated on write against
`schemas/question-packet.schema.json`. A relay that has to translate is a relay that can quietly
reword the question; this way the main thread renders rather than interprets.

Three refusals, each measured:

| Attempt | Result |
| --- | --- |
| a second question while one is open | refused — *"One question at a time: the answer has to come back before the next is asked."* |
| 2 answers to 1 question | refused — *"A missing answer becomes an assumption the director did not make."* |
| an option list of one | refused at write time — `(root).questions[0].options: needs at least 2 item(s), got 1` |

**Truth is the file, not a flag.** `askedAt` without `answeredAt` *is* the pending state. A separate
state field would be a second thing to keep in step with the packet, which is this codebase's
recurring defect — one half writes it, the other half forgets.

**Not made mechanical: the wave rule.** §R7b prices parking with children in flight at one director
turn per returning child, and it stays a prompt rule in both files. The controller cannot see
in-flight dispatches reliably, and inventing a check it cannot ground would be worse than naming
the constraint honestly.

### S7. Final sweep before the sandbox run — what the refactor left behind

Removals, each because the thing had stopped having a consumer rather than because it looked untidy:

- **`/hyperpowers:setup` and `scripts/setup.mjs`** — a whole skill and script surviving to print a
  one-time migration note. The note moved to the README; the plugin now ships four commands.
- **`currentMainThreadModel()`** — zero consumers since §S4 moved the tier check to the director's
  own transcript. Exported and dead is the same defect class as read-but-never-written.
- **`REQUIRED_SETTINGS`, `budgetOverrun()`, `launchCommand()`, `BUDGET_EXCEEDED`** — deleted in
  §S1/§S4 rather than left unreachable.

Two rules had been copied into two files during the refactor and were extracted before the run:
`bareAgentName()` (agent names arrive namespaced, must be compared bare) and `softBlockCap()` (when
a controller yields to `SUSPENDED`). The two loops legitimately have separate *counters*; they do
not have separate *rules*, and §S2 is what a number that drifts out of step with reality costs.

**One live defect fixed in the sweep.** `report.mjs` read the director's model from
`state.observedDirectorModel`, a field the `SubagentStop` controller stamps. A director that
finishes inside a single dispatch never fires that hook, so the final report would have said
*"not observed"* about a tier the transcripts answer on demand — §O14's "checked once" defect, one
surface over. It now measures fresh and falls back to the stored value.

**Coverage.** 522 tests. What cannot be covered without a real terminal: that the three phases
compose — `/hyperpowers:feature` dispatching a Fable director, the `SubagentStop` loop driving it
through nineteen phases, and a park round-tripping through a human. Every piece is exercised in
isolation and the seams are tested with real hook payloads; the composition is the sandbox run's
job, and nothing here claims otherwise.

### S8. An independent review of the 38 staged files — two real defects, both of one kind

Both are the shape this ledger exists to catch, and both were introduced *by* the refactor.

**The phase table still ordered the director to use a tool it does not have.**
`BRAINSTORMING.next` read *"Use `AskUserQuestion` for every user-facing question — it is a tool
call and keeps the turn (and the Fable model pin) alive."* That text is not documentation:
`subagent-controller.mjs` injects `nextAction(phase)` **verbatim** at every yield. So at the one
interactive phase of the run, the single source of truth contradicted §S6's park-and-relay and
cited a justification the architecture had abandoned two amendments earlier.

The prompts were updated and the table was not — the exact failure CLAUDE.md warns about ("to
change the workflow, change that table"). `docs:check` cannot see it: it proves `workflow.md` was
regenerated, not that it is *true*. §S8's test closes that gap by asserting no phase's injected
text names any of §R1's eleven stripped tools except to forbid it.

**`ask` shipped without the §20 confinement its two siblings have.** `validate-agent-report` and
`adjudication-ledger` both guard an agent-supplied path with `misplacedOrchestrationFile`, added
after a live run wrote `tests/wp-001-report.json` into the working tree. `cmdAsk` accepted
`--file` unguarded, and the director's prompt said `--file <packet.json>` with no directory — a
packet left in the project would reach the reviewer as an unowned file and fail the completion
gate. Guarded, and the prompt now names the run directory.

**Four smaller corrections from the same review.** `skills/resume/SKILL.md` opened by claiming the
reader *was* the director and denied it two lines later; `fable-gate-reviewer`'s description
justified itself by "the main-thread director normally decides inline", a director that no longer
exists; one comment in `verify-completion.mjs` still spoke of a launch command in the present
tense; and `phases.mjs`'s own header still explained `WAITING_FOR_USER`'s removal by the model pin.

**Two of the reviewer's other points, assessed rather than accepted.** That
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is "the only lever" is not right — `stop.blockCap` in
`.hyperpowers.json` is the documented lever and `loadConfig()` honours both. The underlying product
concern is real and stands recorded: with the cap at 8 and the margin at 2, a director needing more
than six continuations suspends and needs a manual `/hyperpowers:resume`. §S3 T27 measured one
firing for a six-phase agent, but says plainly that its proxy is not nineteen phases with waves and
Codex rounds. That is the sandbox run's first question.

### S9. A progress bar, on the one rendering surface a plugin owns

**The refactor is what made this possible.** The agent panel decorates only `local_agent` tasks and
explicitly excludes the main thread (`Lj`/`hc` in `BIN`). While the director *was* the main thread
it had no row — the question could not even be asked. Since §S4 it has one, and that row lives for
the whole run.

**The surface.** The settings allowlist a plugin may contribute is exactly
`["agent", "subagentStatusLine"]`, verified in `BIN`. `subagentStatusLine` is therefore the only
place a plugin can draw. Its schema is `{type:"command", command:string}`, described as *"Custom
per-subagent status line shown in the agent panel; receives row context as JSON on stdin"*. An
independent probe captured **133 task objects over 77 ticks**: cadence 5 s, no execution at all when
no subagent is live, `tasks[].id` identical to the agent id in `subagents/agent-<id>.meta.json`, and
`columns` supplied at the payload root.

**The design problem was bootstrap, not rendering.** Plugin-delivered settings get **no**
`${CLAUDE_PLUGIN_ROOT}` expansion, and the real cache path carries a version or sha nobody can
predict. The command therefore finds itself: it globs `~/.claude/plugins/data/hyperpowers-*/`,
reads `.data-root.json`, and imports `<pluginRoot>/scripts/statusline.mjs`. That marker is **not a
new producer** — `SessionStart` has stamped it since §O1, and it already carries `pluginRoot` and
`stampedAt`, so two installations resolve to the freshest one that actually has the script.

**Milestones, not a clock.** `DESIGN_LOCK` is measured at 24–26 min and `PLAN_LOCK` at 54–57 min
across three runs, but exactly **one** run has ever been timed to `COMPLETE`. A percentage built on
that denominator would give an n=1 guess the authority of a measurement, so the bar is a weighted
walk over milestones each of which the state machine already proves — gates, stored review rounds,
and `tasks[].status === 'accepted'`, the one field an agent's report cannot assert for itself.
Elapsed time and spend ride beside it as text, never as the fill.

**It does not go backwards.** `PHASES` has real back edges. The fill holds at its high-water mark
and retreats show as `↻n`, because a remediation *adds* work rather than undoing what was proven —
and a bar that slides backwards reads as a bug. The counter is what keeps that honest.

**Two things it renders that nobody asked for.** Worker rows show
`tokenCount / contextWindowSize`, both already in the payload: that is the constraint §Q13 measured,
where five of six agents ended *exactly* at their turn cap. And silence is the default — the setting
is global to the plugin, so a session with no Hyperpowers run must be decorated with nothing rather
than have its default row replaced by our opinion of a run it is not having.

**Rejected, recorded.** Writing `statusLine` into the user's settings (§S1/§S7 just removed the last
thing that wrote there); a pre-rendered file in `$TMPDIR` read by a dumb renderer (one half writes,
the other reads — the signature defect, and it would freeze during the longest phase, since hooks
fire minutes apart against a 5 s tick); decorating a monitor's row (`Lj` keeps only `local_agent`,
measured); and writing to the TTY from a hook (Ink reclaims the frame and the display corrupts).

**Left unverified deliberately.** Whether ANSI colour survives into `content`, and whether `effort`
appears for an agent that declares one — it was absent from all 133 probed objects. The bar uses
Unicode blocks only and does not depend on either.

**Superseded on the rendering side by §V14**, which read `$qf`, `$PS` and `Ac` out of the binary
rather than probing the payload. ANSI is resolved (fully parsed, mapped onto Ink props). Three
statements above are corrected there: `content` replaces everything **right of the gutter** and not
the whole row; what it displaces includes the harness's own `(+N)` descendant suffix; and the panel
draws only *roots*, so an agent nested under a live director can never be a top-level row.

### S10. The first live run of the subagent architecture — what it proved, and the defect it caught

Run `20260728T232620Z-tttpzq`, `pilot2`, the same CSV request as run 3 so the two are comparable.

**What it proved, in the first 20 minutes.** Read from the subagent transcripts while it ran:

```
hyperpowers:hyperpowers-director        depth=1   claude-fable-5
hyperpowers:opus-design-coordinator     depth=2   claude-opus-5
hyperpowers:sonnet-researcher           depth=2   claude-sonnet-5
```

`/hyperpowers:feature`, invoked from an ordinary session, produced a **Fable director at depth 1**
with Opus coordinators beneath it — the pyramid the retired `MAX_SUBAGENT_SPAWN_DEPTH=2` would have
made impossible. The Codex adapter ran from two levels down and returned a `blocker` verdict that
was adjudicated and resolved. `observedEffort` came back `high`, from the agent's own frontmatter.

**The defect.** At +46 min the run suspended. `subagent-controller.mjs` opened `SUSPENDED` when the
director exhausted its block budget — but `SUSPENDED` is in `STOP_ALLOWED_PHASES`, so the main
thread's Stop hook then saw a stoppable phase and returned immediately, **never reaching the
re-dispatch branch written for exactly this moment**. The counters are the proof:
`directorTurn.blocks = 6` saturated against `turn.blocks = 0` never incremented, and zero
`redispatch_required` events against five `continuation`s.

**Two more defects the same event exposed.**

The message it emitted was *"Run `/hyperpowers:resume`"* — a slash command **no model can execute**,
delivered to a model. The run survived anyway because the main thread improvised: it resumed the
director by `agent_id` with `SendMessage`, on its own initiative. A success that depends on a model
inventing the recovery is the kind that hides the defect rather than revealing it.

And the main thread had dispatched with `run_in_background: true` — its own choice, unaddressed by
any instruction. That invalidated an assumption stated in the controller's own comment: that a
synchronous dispatch means the main thread cannot end its turn while the director works. It can,
and its Stop hook fires throughout.

**The correction, in three parts.**

1. Exhausting a dispatch no longer opens `SUSPENDED`. The controller yields the *dispatch*, logs
   `dispatch_exhausted`, and leaves the run in its phase — so the main thread's Stop hook finds a
   live run with no director attached, which is its job to fix.
2. The instruction names the **agent id** and asks for `SendMessage`, because a fresh `Agent` call
   starts cold and re-reads the request, design and plan to rebuild context the live agent already
   holds. That is what the main thread worked out for itself; encoding it removes the luck.
3. `SUSPENDED` now means only that the **main thread** is out of blocks — the one case where a
   human genuinely is the next step, and the only place `/hyperpowers:resume` is now printed.

Background dispatch is now prescribed rather than left to chance: it keeps the main thread free to
render a parked question instead of being blocked inside the call for hours, and it makes the Stop
hook path load-bearing rather than a fallback.

**Wrongly generalised, and recorded as such.** §S3 T27 measured *one* `SubagentStop` firing for a
six-phase agent and I extrapolated that a director would rarely need continuations. Its proxy made
trivial `Bash` calls and dispatched nothing. A real director yields **every time a child returns** —
six times before `DESIGN_LOCK` alone. The entry said the proxy was not nineteen phases with waves
and Codex rounds; it was right to, and the extrapolation was still wrong.

### S11. A resume that leaves the counters saturated is not a resume

Observed live: the run suspended at its soft cap, was resumed, and suspended again **90 seconds
later**. Neither block counter resets on its own — `state.turn` resets on a new `prompt_id`,
`state.directorTurn` on a new `agent_id` — and a resume changes neither. So a run came back over
its cap and yielded on the very next hook firing.

`resume-run.mjs` cleared `turn` and **not** `directorTurn`: an omission from the day that field was
added in §S5, and this codebase's signature defect committed by the same hand that documents it.
Fixing it there would have fixed one door — a run also leaves `SUSPENDED` by an ordinary transition,
which skips that script entirely. My first fix put the reset in `transition()` under
`from === 'SUSPENDED'` — **unreachable code**: `SUSPENDED.successors` is empty, so no legal
transition leaves it and `resume-run.mjs` writes the state directly. A guard guarding nothing, in
the same edit that documents that defect class. It lives in `resume-run.mjs`, the only route out.

**A correction to how this was diagnosed.** Three suspensions and a 90-second cycle led me to
report an autonomous livelock burning money. It was not: every resume was the user's. The
underlying defect is real and unchanged, but "I cannot distinguish an autonomous loop from a series
of manual resumes" was the honest statement available at the time, and I asserted the first instead.
Recorded because the cost of that error is a user acting on an urgency that did not exist.

### S12. The Stop hook nagged a director that had never stopped — and two retractions

**Corrected by the §S13 audit — read that first.** This entry originally blamed the nag loop on a
background dispatch alone. The timeline shows the main thread's blocks *interleaved* with director
`continuation` events (02:23:46–02:24:02), so the director was not reliably in flight during those
nags, and §S13's impostor is the better-supported cause. The in-flight guard below is kept as a
correct principle — a backgrounded dispatch really does let the main thread end its turn while the
director works — but it is **not** what the nag loop measured.

**The mechanism as first described.** The main thread dispatches the director with
`run_in_background: true`, so its turn ends while the director is still working.
`stop-controller.mjs` inferred: main thread stopping + live run ⇒ director idle. The hook blocked with
*"The director has stopped but the run has not reached a terminal phase"* — it had not — and the
main thread dutifully answered `Message queued for delivery to a0c5476641d99d3ae at its next tool
round`, which is the harness saying the agent is mid-flight. Six of those, then `SUSPENDED`, with
`plan.md` never written across 162 state revisions.

**The fix costs nothing to discover.** §R5 already recorded that `agent_id` is present on **both**
`SubagentStart` and `SubagentStop`, so the pair can be tracked: `directorTurn.inFlight` is set on
start, cleared on stop, and the main thread's Stop hook allows the stop while it is true.

**Retraction 1 — "the main thread redispatches cold instead of resuming".** It did not. The
transcript shows `SendMessage` to the same `a0c5476641d99d3ae` throughout; it followed the hook's
instruction. The three director transcripts were one abandoned duplicate the model caught and
stopped itself, plus the real one. The claim was inferred from file counts, not read from the
transcript that was available.

**Retraction 2 — "$2.52 per cold restart".** That figure was two cost stamps either side of a
resume, attributed to a cold-restart mechanism that did not exist. What the interval actually
contains is the nag loop above: main-thread turns re-reading their own context to send a message
nobody was waiting for. The cost is real and the explanation was wrong.

**Also measured, and better than expected.** The §S9 status line rendered in the live agent panel:

```
◯ HP·director ███████░░░░░░░░░░░░░░░░░  30%  ABORTED  ↻1
```

Bar, percentage, phase and the retreat counter, from a plugin-delivered `subagentStatusLine` that
found its own script through `.data-root.json`. §S9 no longer needs the caveat that it has never run.

### S13. The impostor director — a full audit of run `20260729T012818Z-i07o3k`

Done properly this time: timeline first, then a subagent inventory with ids and depths, then a
parent lookup. Three tool calls, and they overturned the two fixes written before them.

**The subagent inventory is the whole finding.**

| window | agent | id | depth | lines |
| --- | --- | --- | ---: | ---: |
| 01:28–02:26 | `hyperpowers-director` | `a0c5476641d99d3ae` | 1 | 206 |
| 01:33:33–01:33:42 | `hyperpowers-director` | `aff603ff8af9a46ac` | 1 | 7 |
| **02:09:30–02:27:27** | **`hyperpowers-director`** | **`ac42a950912929640`** | **3** | **124** |

The 7-line one is the duplicate the main thread created and stopped itself. The third is the
finding: `parentAgentId: a1888aa3cf697f04f` — the **`opus-review-adjudicator`**, at depth 2, with
`description: "Reply to director with design-2 packet"`.

**The cause is a sentence I wrote.** Four coordinator prompts said *"put the verdict on record by
dispatching the director:"* above a code block naming `hyperpowers:fable-gate-reviewer`. The prose
and the example contradicted each other and the model followed the prose. Before §S4, "the
director" named nothing dispatchable and the sentence was harmless; creating `hyperpowers-director`
turned it into a live, wrong instruction — a defect introduced by a rename, in text nobody re-read.

**The consequences, measured.** A director at depth 3 cannot dispatch at all (`3 >= 3`), so it held
none of the run's context and could delegate nothing. But it reported as the director to every
hook: `subagent-controller.mjs` counted its blocks and wrote its id into `directorTurn`. **3 of 23
recorded `agentId` events belonged to it**, and the id flip-flopped between the two agents for the
rest of the run — so the Stop hook repeatedly told the main thread to resume the wrong agent.
`PLAN_DRAFT` never produced `plan.md` across 162 state revisions, and `stallCount` climbed to 3.

**Two fixes, one mechanical.** The prose is corrected in all four coordinators, and
`subagent-controller.mjs` now requires `spawnDepth === 1` — read from the meta file the harness
writes live beside the transcript (§S4 T28), since `spawnDepth` is not in the payload (§R5). The
mechanical guard is what makes the prompt fix non-load-bearing.

**A separate defect, now bounded — see §S14: agents outlive `ABORTED`.** The run was aborted at
02:26:58; the plan coordinator's transcript runs to 02:36:11 and three `gate=plan passed=False`
events land at 02:33–02:35. Abort stops the run's *state*, not its subagents — they keep working,
and keep spending, for minutes afterwards.

**Method note.** The three fixes before this one were each written from a terminal transcript, then
contradicted by run data. This audit cost three tool calls and would have prevented all three. The
order is: timeline, inventory, parentage — *then* a mechanism.

### S14. Agents outlive `ABORTED` — what can and cannot be done about it

**What cannot.** Ending a run ends its *state*, not its subagents. The harness keeps them working,
and `PreToolUse` carries no `agent_id` (§D5) — so no hook can tell a subagent's tool call from the
user's own, and none can stop them selectively.
*(corrected: see §V3 — it does carry `agent_id` when the caller is a subagent, so the calls **are**
distinguishable. The conclusion survives: naming the caller of a tool call still cannot cancel an
`Agent` call in flight.)* A blanket deny after an abort would take the
session away from the person who asked for the abort. There is no mechanism here, and pretending
otherwise would be worse than the leak.

**What can: make them accomplish nothing, and say so.** Measured on the aborted run, verb by verb:

| verb | before | after |
| --- | --- | --- |
| `transition`, `task`, `count`, `risk` | already refused | unchanged |
| `artifact` | **wrote** | refused |
| `verify-completion` | **evaluated *and recorded*** | evaluates, records nothing |

`verify-completion` is the one that mattered: three `gate=plan passed=False` entries landed seven
to nine minutes after the abort, from a plan coordinator that ran until 02:36:11. The distinction
that fixes it without breaking anything is **reporting versus recording** — re-running a gate to
audit a finished run is legitimate and must keep working; appending to a closed record is not.

The refusal names the end and tells a still-running agent to stop, because the agent reading it is
the only thing that can act on it.

---

## T. Measured directly for the run-6 fixes

### T1. `PreToolUse` fires for the `Agent` tool; `SubagentStart` genuinely fires — **VALIDATED**

`EXP` — a scratch project with three capture hooks (`PreToolUse` matching `Agent|Task`,
`SubagentStart`, `SubagentStop`) and one headless session told to dispatch a `general-purpose`
subagent. All three fired, once each:

| Event | Keys observed |
| --- | --- |
| `PreToolUse` | `cwd, effort, hook_event_name, permission_mode, prompt_id, session_id, tool_input, tool_name, tool_use_id, transcript_path` *(corrected: see §V3 — a subagent-issued call adds `agent_id`, `agent_type`)* |
| `SubagentStart` | `agent_id, agent_type, cwd, hook_event_name, prompt_id, session_id, transcript_path` |
| `SubagentStop` | … + `agent_transcript_path, background_tasks, effort, last_assistant_message, permission_mode, session_crons, stop_hook_active` |

Three facts this settles, each of which a fix now rests on:

- **`tool_name` is `"Agent"` and `tool_input` carries `subagent_type`** — so a dispatch can be
  refused before it happens (§S16). `tool_use_id` is present here and absent from both subagent
  events, which is why the live registry pairs on `agent_id` instead.
- **`SubagentStart` is a real firing, not a payload shape recovered from the binary.** §R5 recorded
  its keys but nothing had ever observed one: run 6 registered the hook at 04:29 local and no
  dispatch followed, so its `state.directorTurn` carries no `inFlight` key at all. The mechanism
  §S12 first shipped had therefore never executed once. It does fire.
- **Neither subagent event carries `parentAgentId`.** The meta file beside the transcript does
  (§S4 T28), so `liveChildren` stores membership only and resolves parentage at read time.

The keys match §R5 exactly, which is now an observation rather than an inference.

### T2. A subagent's prompt cache expires in ~5 minutes; the main session's does not — **VALIDATED**

The dominant cost difference between the two architectures, and nothing in this repository was
looking at it. Mean tokens per request, bucketed by the idle gap *before* that request, across two
complete runs of the **same request** in the same sandbox on the same commit:

| gap before request | run 7 — director as **subagent** | run 3 — director as **main thread** |
| --- | --- | --- |
| < 1 min | write 1.9k · read 63.8k | write 1.7k · read 69.4k |
| 1–5 min | write 3.2k · read 57.5k | write 2.8k · read 72.4k |
| **5–20 min** | **write 62.6k · read 0** | write 2.1k · **read 72.7k** |
| **> 20 min** | **write 67.8k · read 0** | — |

Read falls to **exactly zero** past five minutes for the subagent and stays at ~72k for the main
thread. Two rival explanations were tested and one was refuted **using run 3 as its own control**:

- *"the blocking `Agent` call keeps the parent warm"* — **refuted.** Run 3's main thread stayed warm
  across a 9.5-minute gap with no tool call at all, and across 13.2- and 12.1-minute gaps that did
  sit inside `Agent` calls. Warm either way.
- *"subagent conversations get a short TTL"* — **supported.** Run 3's own `opus-plan-coordinator`, a
  subagent, went **cold at 5.7 minutes**, while its `opus-execution-coordinator` squeaked through at
  5.1. Run 7's director went cold on all six of its gaps, 8.4 to 25.7 minutes.

Cold restarts (`gap ≥ 5 min ∧ cache_read = 0 ∧ cache_write > 10k`): **9 in run 7 against 1 in run
3**, 0.62M tokens rewritten against 0.04M — **$6.14 against $0.27**. That single mechanism is
**43% of the $13.61 gap** between the two runs.

What a restart costs is `context × 1.25 × tier`. The director's prefix at dispatch is **21,471
tokens** (system prompt, tool schemas, its 15 kB definition); by the last restart it was rewriting
77k. So the levers are the number of idle windows and the size of what is carried across them —
**not** the tier split, which is stable at fable 32 / opus 48 / sonnet 20 against 38 / 46 / 16, and
**not** depth, which is not billed: a worker at d3 in run 7 cost $0.028 per request against $0.027
for the same worker at d2 in run 3.

**This is a harness property, not a design error, and most of the gap is not recoverable.** Saying so
is more useful than inventing an optimisation: the measured ceiling on context-slimming is about
$1, and on halving the idle windows about $1.6.
*(stale sizing: see §V9 — the qualitative conclusion holds, but at run-9 scale the same mechanism is
17 windows and 1,469k tokens, a gross term of $18.37 rather than $6.14.)*

### S22. Three defects run 7 found in the tooling

- **`review-<artifact>-1-current` fired on every healthy run.** Round 1 → remediation → round 2 is
  the mandated cycle, so round 1's digest is stale by construction. Both gates duly reported it as
  unverifiable while nothing was wrong. A condition that fires when everything is correct teaches
  people to skim past the ones that are not — the same reasoning that had already excluded the
  `implementation` rounds, simply not applied here first time. Only the **last** round for an
  artefact is now asked whether the text still matches.

- **Six `adjudication_resolved` events for five adjudications.** Re-stating a resolution looked
  identical to closing a new one, so anyone counting the record over-counted the work. Replacing
  evidence is legitimate and stays on the record under its own name, `adjudication_resolution_replaced`
  — the same discipline that keeps `policy_blocked` apart from `policy_violation`.

- **The review pack withheld two clauses of the work-package contract.** Found by run 7 itself and
  recorded as its own residual risk: `summariseTasks` rendered objective, owned files, criteria,
  commands, dependencies and out-of-scope — and dropped `interfaces` and `constraints`, two of the
  seven fields the schema defines as the contract, and precisely where a plan goes wrong. Codex was
  being asked whether a plan was sound with two clauses hidden. The renderer is now driven from a
  field table, so a field added to the schema reaches the reviewer instead of waiting for somebody
  to remember this function.

### S23. Artefact size is not the lever it looked like

Run 7's artefacts are 60–90% larger than run 3's on a byte-identical request — `design.md` 21.3k →
36.3k, `plan.md` 14.5k → 25.3k, review packs +55 to +88%. The first reading was inflation.

Diffing the section structure refutes it. Run 7's design carries sections run 3's does not have at
all: each open product decision resolved by name, a worked table for the trailing-terminator
algorithm, the error shapes, and a test strategy with a justified divergence from repo precedent.
And the reviewer bit *more*, not less — `design-1` raised **3** findings against 36k where run 3
raised **1** against 21k.

**No bound was added.** Capping artefact size would have bought cost by paying quality, and the
claim that it bought nothing was withdrawn rather than shipped.

### S15. The loop punished a director for waiting — the defect that ended run 6

12 of run 6's 20 continuations fall inside **one four-minute window**, 02:22–02:26. What was
happening in it, from the director's own transcript:

> *"The plan coordinator is verified active; a watcher is now armed on `plan.md` + populated
> `tasks.json` so I'm woken the moment the artefacts land."*
> *"Yielding until the artefact notification arrives."*
> *"Coordinator quiet for ~60s — still within normal range for composing the large `plan.md`."*

The director was right every time. It verified the coordinator was alive from its transcript mtime,
armed a watcher, and explicitly refused to duplicate-dispatch. The machinery read each report as a
stall sample and charged it a continuation.

**A synchronous dispatch never reaches the hook at all**: across the design coordinator's nine
minutes the director emitted **zero** continuations, because it was inside a blocking call and never
stopped. The defect is therefore narrower than "waiting is punished", and the precise statement is:

> After an interrupted synchronous dispatch there is no way back into a blocking wait.

At 02:10:06 the director dispatched `opus-plan-coordinator` with `run_in_background: false`; an API
connection error cut the call; the only resume available was `SendMessage`, which is asynchronous.
From there it could only poll, and every poll is a stop.

`stallCount` reached **3 of `stallBlockAt: 5`**, and the ladder was already telling the director to
*"stop delegating… decide whether the approach is wrong"* — to kill a coordinator that was working.

**Fix.** A registry of live subagents, written on `SubagentStart`/`SubagentStop` for every agent
(§T1) before any filter. When the director stops with a live child it is still **blocked** — nothing
else would wake it, since the main thread is notified about its own dispatch and not about a
grandchild — but the block costs no continuation and no stall sample.

Two bounds keep that from becoming a silent hang:

- Entries **expire** after `CHILD_STALE_MS` (1 h). A crash, an API error or an abort leaves no stop
  event, and all three are in run 6's record. The bound is measured: the longest-lived subagent
  observed is 36 min, and the longest a *working* agent went without writing a message is 17.7 min.
- Every path that cannot produce positive, fresh evidence returns **fewer** children — an unreadable
  transcript directory, a missing meta, an expired entry. Fewer children means the director is
  re-driven, which is the behaviour that already existed. Nothing here can invent a wait.

Rejected: allowing the stop. It idles the director with nothing to wake it.

**Waiting needs its own counter, and the first version did not have one.** The harness honours only
8 *consecutive* blocks (§R6: 9 invocations, 8 honoured), and run 6's director polled ~12 times in
four minutes. An uncounted block therefore reaches the ceiling in under three minutes, the harness
truncates the turn, and there is no `dispatch_exhausted`, no `SUSPENDED`, and `yielded` is still
false because the last decision was a block — so the main thread's Stop *allows* and the run goes
silently idle. That is §S2's defect restored, arriving sooner. A long wait now yields **resumably**
at the same soft cap, which restarts the harness's series, while `directorTurn.blocks` — the budget
for doing work — stays untouched. The two counters measure different things and reset each other.

The block message no longer prescribes a shell wait loop. It described one specific command, and an
instruction an agent may be unable to execute is exactly §S18's defect; the mechanism above is what
carries correctness, so the text only states the principle.

### S16. One run, one director — prevention to pair with §S13's detection

Run 6 grew **two** impostors, and the depth guard shipped for §S13 only sees one of them:

| agent | depth | parent | how |
| --- | --- | --- | --- |
| `ac42a950912929640` | 3 | `opus-review-adjudicator` | the adjudicator has `Agent` legitimately, to escalate, and read "reply to the director" as "dispatch the director" — 34 requests, **$4.37**, drove the run's continuations for four minutes |
| `aff603ff8af9a46ac` | 1 | MAIN | the main thread used `Agent` where its own skill says `SendMessage`; self-corrected via `TaskStop` after 10 s |

The second is a *depth-1* director. Depth cannot see it; multiplicity can.

`PreToolUse` carries no `agent_id` (§D5) *(corrected: see §V3 — it does, for a subagent caller)*, so
the hook cannot ask **who** is dispatching — and does
not need to. It asks whether anyone is already driving: `directorIsDriving(state)` is true when an
agent id is recorded and `yielded` is not set. A request for a second director is wrong whoever
makes it.

The legitimate first dispatch is never seen: `/hyperpowers:feature` dispatches the director and the
**director** then creates the run, so no run is bound and the hook has already returned (run 6:
`Agent` at 01:28:03, `run_started` at 01:28:18). `/hyperpowers:resume` sets `yielded`, which is the
documented release valve when a director is genuinely dead.

**This rule fails open**, unlike the Git classifier it shares a hook with. Missing an impostor costs
one wasted agent that the depth guard then ignores; a false deny costs the plugin its only entry
point.

### S17. A review is a verdict on a version, not on a filename

| at | what |
| --- | --- |
| 02:06:45 | design-2 review completes — `gpt-5.6-luna` @ xhigh, *concerns*, DESIGN-003, **0 blocking** |
| 02:08:08 | `design.md` modified — the remediation resolving DESIGN-003 |
| 02:09:27.476 | DESIGN_REMEDIATION → DESIGN_REVIEW_2 |
| 02:09:27.526 | DESIGN_REVIEW_2 → DESIGN_LOCK — **50 ms later**, no pack, no Codex call |
| 02:09:48 | design gate: **11/11 passed** |

The locked design is not the reviewed design. **This is permitted**: §18 mandates a further round
only when round 2 raises a *new blocker*, and DESIGN-003 was non-blocking. The gate was implementing
the contract faithfully.

What was missing is that nobody could see it. `checkReviewCycle()` asserted only that a review
existed, was `completed`, and had its findings adjudicated and resolved — so "a review exists" and
"a review *of this text* exists" were the same check, and the gate could not tell a two-line
correction from a rewrite. `gateInputDigest` does hash `design.md`, but only to invalidate a verdict
between the gate and the transition; it cannot see that the review predates the edit.

**Fix.** `reviewedArtifactDigest()` is recorded in the review when it is written and compared at the
gate. A mismatch is `unverifiable`, not `fail` — the status the gate already tolerates and reports as
stated residual risk, which is exactly §18's semantics. Failing hard would force a Codex round onto
every typo fix. The `implementation` rounds record no digest and report *not applicable*: what they
review is the working tree, which moves between rounds by design, so the check would fire always and
mean nothing.

### S18. The phase table told the director to do the user's job

`SUSPENDED.next` read *"Run `/hyperpowers:resume` to continue this run in a fresh turn."*
`nextAction(phase)` is injected **verbatim into the director's context** on every continuation
(§S8), so that was an instruction to a model. Unable to run a slash command, the director found the
script behind it and called `resume-run.mjs` directly — twice in run 6, **16 and 35 seconds** after
the suspension (02:09:31 → 02:09:47, 02:24:08 → 02:24:43).

So `SUSPENDED` was not a circuit breaker: the state entered to stop a runaway loop was being cleared
by the runaway loop, on the system's own advice. The user never typed `/hyperpowers:resume` — the
main transcript contains exactly two user commands, `/hyperpowers:feature` and `/hyperpowers:abort`.

The text now names the user as the one who resumes and tells any agent reading it that this is not
its job. **What cannot be fixed** stays stated: nothing distinguishes a human's resume from an
agent's, for the same reason as §S14 — no hook sees an `agent_id` on a tool call
*(corrected: see §V3 — a subagent-issued call carries one; a human's `/hyperpowers:resume` still does
not, so this conclusion is unchanged)*. Removing the
instruction removes the *cause*; it does not create an actor check.

### S20. `state.schema.json` described a state that had stopped existing

Found by reading the tree, not a run. The schema carried no `directorTurn` — added with §S5 and
written by every run since — and **nothing validated a state against it**. A schema no code reads is
not a contract; it is a comment that ages, which is this repository's signature defect wearing a
`.json` extension.

It now describes `directorTurn` and `children`, and three tests hold it there: a fresh `newState()`
validates, a *driven* state validates (the accumulating fields are the ones a fresh state cannot
exercise), and every key `newState()` writes must appear in `properties` — so the next field added
to the run fails the suite rather than quietly escaping the contract.

### T3. Tool schemas cost prefix tokens, exactly additive — **MEASURED**

`EXP` — two agent definitions with **byte-identical bodies**, same model, same effort, same
dispatch prompt, differing only in frontmatter, dispatched from one session:

| agent | `tools:` | prefix at first request |
| --- | --- | ---: |
| `bench-all` | *(absent — inherits everything)* | **19,986** |
| `bench-dir` | `Agent, Bash, Read, Write, Skill` | **17,703** |
| `bench-noagent` | `Bash, Read, Write, Skill` | 14,968 |
| `bench-noskill` | `Agent, Bash, Read, Write` | 12,347 |
| `bench-few` | `Read, Write, Bash` | **9,612** |

The attribution is **exactly additive**, which is what validates it: `9,612 + 2,735 (Agent) +
5,356 (Skill) = 17,703`. Those two schemas are catalogues — every dispatchable agent, every
available skill — and they are the two the director genuinely needs.

**The first estimate was wrong by 4.5×.** A three-tool benchmark suggested 10,374 tokens of saving;
the director's real list saves **2,283**, worth ≈$0.25 a run. It ships because it is certain and
riskless, not because it is large. `Skill` was verified still working under an enumerated list
before the change landed — a director that cannot invoke `superpowers:brainstorming` dies at phase
three, which would have cost a run to save a dollar.

Dropping `Skill` (5,356 tokens) was considered and refused: the plugin declares a dependency on
superpowers, and trading a declared contract for $0.40 is the wrong direction.

**The caller count has since fallen from two to one.** `Skill` was kept for
`superpowers:brainstorming` *and* `artifact-design`; §S37 removed the second, because the product
diagram is now a Markdown page with a ` ```mermaid ` fence rather than a hand-designed HTML document.
The conclusion is unchanged — brainstorming is a declared dependency and phase three dies without it —
but anyone re-weighing this trade-off should see one caller, not two.

The objection this overturns was recorded in the file itself: *"an enumerated list would silently
remove a capability the moment a phase needed one nobody thought to write down."* It is answered,
not overruled — `Bash` subsumes `Grep`, `Glob` and `find`, `Write` subsumes `Edit`, and web access
belongs to `sonnet-researcher`. The list removes schemas, not reach. Run 7 used four of the five as
a subagent; `Read` is on the list because run 3's director used it and because it is the natural
fallback, not because run 7 needed it.

### S24. Three optimisations investigated and refuted by measurement

Recorded because the reasoning is the reusable part, and because each looked plausible enough to
ship without checking.

- **Bounding what coordinators return.** Their reports are 3.5–4.3 kB of dense, path-bearing
  evidence. The one outlier is `sonnet-researcher` at 11,845 characters — but the researcher has
  **no `Write` tool**, so its report exists only in the director's context, and the director is
  required to carry it forward verbatim precisely because compressing it once cost *17,000 Opus
  tokens rediscovering 6,000 tokens of Sonnet work*. Refuted by its own history.

- **Compact receipts from implementers to the execution coordinator.** Its two cold restarts cost
  $1.11, so the lever looked worth up to that. Measured: implementer returns across three dispatches
  total **6,971 characters** — ~2k tokens, worth about $0.03. The coordinator's ~89k context is its
  *own verification work*: `Bash`×16 and `Read`×7 reading the diff and running the suite. Shrinking
  it would weaken verification to save nothing.

- **Parallel work packages.** Run 7's three packages ran strictly sequentially, 18.7 min for 16 min
  of work, and both coordinator definitions already carry the instruction to dispatch waves in a
  single message. The chain is real: the coordinator verified and accepted WP-001 before dispatching
  WP-002, which *tests WP-001's code*, and WP-003 exports its module. Run 3 was sequential too, and
  looser — overlap 0.43× against run 7's 0.86×. Forcing a wave would break a dependency the work has.

### S25. Uninstalling the plugin destroys every run's artefacts

`claude plugin uninstall` removed `~/.claude/plugins/data/hyperpowers-hyperpowers/` wholesale,
taking run 7's `state.json`, `telemetry.jsonl`, `design.md`, `plan.md` and `tasks.json` with it —
during a routine version bump. The run's analysis survived only because it had already been
extracted, and because session transcripts live under `~/.claude/projects/`, outside the plugin's
data directory.

The record of the work is the product's memory, and a reinstall erases it silently.

**Decision, not a caution: out of scope, and here is why.** `dataRoot()` resolves beside the
harness's own plugin data precisely so that hooks and Bash-invoked CLI scripts agree on one
directory; §O1 is the run where they did not, and the plugin governed nothing while looking healthy.
Moving run data outside that directory reopens the worst defect this project has had, to protect
against an operation the user performs deliberately. The cheaper half-measures were considered and
rejected too: writing the report into the project violates §20 (run data must never enter the diff
the reviewer sees), and a preflight warning fires *after* the loss. Archive a finished run's
directory before uninstalling; that is the whole mitigation, and it is honest to say so.

### S26. The stateless-director envelope, recomputed

The one lever large enough to matter, still untested, and its numbers move with §T3.

The director's prefix is now **19,188** tokens (21,471 less the 2,283 §T3 removed). Six restarts
writing only that prefix cost `19,188 × 6 × 1.25 × $10/M` = **$1.44**, against the **$4.83**
measured — an envelope of **≈$3.4 gross**, ≈$3.1 net of what §T3 already banked.
*(stale sizing: see §V9 — the prefix is not what a cold turn rewrites. On run 9 the mean rewrite is
~86k tokens across 17 windows, so the envelope is several times this.)*

It is an envelope, not a plan, and two things gate it. First, whether a director whose memory is the
run directory rather than its conversation still *directs* — that is a quality question no
arithmetic settles. Second, the validation an adversarial review proposed for it — replay the
recorded `DESIGN_LOCK` and `FINAL_ACCEPTANCE` decision packets through fresh pinned directors and
compare verdicts before committing to a full trial — **cannot be run against run 7**, because §S25
destroyed those packets. The next run must archive its run directory before any reinstall, or this
stays unmeasurable.

### S21. Publishing is an errand for the main thread, exactly as asking is

Run 7 finished with a product diagram nobody saw. The director called `Artifact` itself at 14:07:11,
got a valid `claude.ai` URL, recorded it as `state.artifacts.diagramUrl`, and condition 14 passed —
while the main thread made **exactly one tool call in the entire run**, the opening dispatch. It
never had anything to present, so no page opened.

This is §R1's shape a second time. The harness removes `AskUserQuestion` from subagents because
reaching the user belongs to the main thread; publishing is the same job under another name, and the
gate could not see the difference because it checks the record, not that a human saw anything.

It cannot be tidied up after the fact either: a finished run refuses further writes (§S14), so the
URL has to be recorded *before* `COMPLETE`. So it parks mid-run exactly as a question parks —
`publish-request` writes the errand, the `SubagentStop` controller **allows** the director's stop,
the `Stop` controller **blocks** the main thread with the file and the title, and `published`
records the URL and releases the run.

Both controllers read one predicate, `pendingErrand`, rather than each testing for its own kind:
getting the allow/block polarity backwards on either side strands the run, and two copies of that
rule is one copy that gets fixed.

## U. Second-pass review of the run-8 change set

Everything in this section was found by re-reading the 53 staged files as a stranger would, plus two
scoped adversarial passes by Codex over the control loops and the gate layer. It is grouped because
the findings share one shape, stated once here: **a guarantee written in a comment and implemented in
some of the places it names.** Every entry below has a regression test; the section numbers are what
those tests cite.

### S27. The review pack withheld a clause three different ways

`interfaces` and `constraints` were simply absent from the work-package rendering — §S22 recorded
that, and run 8 measured the fix working (plan round 1 found 5 findings against run 7's 2, on exactly
those clauses). The fix introduced two more:

| defect | effect |
| --- | --- |
| `t.scope?.may_read` | the schema field is `read_only_context`; `may_read` exists nowhere in the repository, so the row rendered `(none)` for every package in every plan review |
| `scope.files` unrendered | required by the schema and read by *both* `validate-agent-report` and `verify-completion` as part of the ownership set |
| `commands.join(' && ')` | **manufactured** the property the reviewer is asked to check |

The third is the interesting one. Run 8's longest-surviving blocking finding — accepted, remediated,
and still defective when round 2 looked again — was a verification command chained with `;` instead
of `&&`, so it exited successfully after a check failed. This renderer would have shown a reviewer
the fail-closed version of exactly that. Commands now stand one per line, verbatim.

The doc block also claimed the table was "rendered generically from the schema's field list", which
was false. The table is hand-written, because the labels and shaping are editorial; what makes it
trustworthy is a test that fails when a schema property is neither rendered nor named in
`NOT_REVIEWED` with a reason, and when a populated field does not survive rendering.

### S28. `adjudication` double-counted, the same disease as §S22 one verb over

**17 `adjudication` events for 14 distinct findings** in run 8 — recounted from `run8-archive/`, which
is why this number is one higher than the figure quoted while the run was live. Round `plan-2` emitted
6 for 3 — the
same three, recorded twice, two minutes apart. §S22 diagnosed this on `resolve` and fixed that verb
only, without asking whether its neighbour had it too.

The *record* was correct both times: `record` replaces a round's decisions wholesale and `resolve` is
idempotent in state. Only the journal over-counted, and the journal is what anyone measuring the run
reads. `cmdRecord` now distinguishes a first decision from a re-decision and emits
`adjudication_decision_replaced` for the latter — same discipline as `policy_blocked` versus
`policy_violation`, for the same reason: telemetry is append-only, so a conflation cannot be undone.

`summarise()` folds both event names by `round:finding`, last decision winning. Counting entries had
reported a finding accepted *and* rejected when it was reconsidered once, and counted it twice when
it was not.

### S29. A failing gate closed the only road back

`transition()` checks the **source** phase's exit gate before allowing any edge out of it. Every
gated phase also declares a recovery successor, and each exists for exactly one situation — the gate
said no — so in exactly that situation none of them was reachable:

| phase | recovery edge | reachable with the gate failing |
| --- | --- | --- |
| `DESIGN_LOCK` | → `DESIGN_DRAFT` | no |
| `PLAN_LOCK` | → `PLAN_DRAFT` | no |
| `FINAL_ACCEPTANCE` | → `IMPLEMENTATION_REMEDIATION`, `SYSTEM_VERIFICATION` | no |

`FINAL_ACCEPTANCE` is where it bites hardest. The director's three answers are COMPLETE, REMEDIATE
and BLOCKED; a failing completion gate refused COMPLETE (rightly) *and* both REMEDIATE edges, leaving
only BLOCKED — which is terminal. A run one fixable finding from success could only be declared
insoluble.

The rule is derived from `PHASE_ORDER` rather than declared: a forward edge must prove the phase it
leaves, a backward edge **is** the redoing. No gate is escaped, because coming forward again
re-checks every gate on the way; the only thing a backward edge buys is the work. Derived rather than
listed because a second list of "recovery edges" is a second thing to keep in step with `successors`.

### S30. The working-tree fingerprint skipped the files Git is not tracking

`gitSnapshot()` was `git status --short --untracked-files=all` plus `git diff HEAD`. Neither carries
the *contents* of an untracked file: `status` prints its path, `diff HEAD` omits it entirely.

That is the normal case here, not an edge case. The user performs every Git operation themselves, so
a feature's new files stay untracked for the whole run — run 8's entire deliverable was two of them.
So the completion gate's freshness binding did not cover the primary artefact: a passing verdict
survived replacing the whole feature with broken code, as long as the filenames held.

`git hash-object --stdin-paths` now hashes them in one Git process — no argv limit, no file contents
crossing the boundary, and the blob ids move exactly when the bytes do.

The per-call timeout came down from 30 s to 5 s in the same edit. `checkGate` runs inside the
`SubagentStop` controller, budgeted at 20 s and killed by the harness at 30, and `execFileSync` blocks
the event loop — so three calls at 30 s could reach 90 s, `onError` would never run, and a fail-open
hook that cannot reach its own failure path is not fail-open.

### S31. Six checks that could not fail

| condition | claimed | actually tested |
| --- | --- | --- |
| `gate:plan` freshness | bound to what the gate read | `planGate` reads `budgets.maxFilesPerWorkPackage`; the plan digest hashed no config |
| stored verdict binding | "the state it judged" | digest computed from the state `mutateState` *reloaded*, not the one evaluated |
| `13.11-no-git-mutation` | no mutation executed | read only the `policy_violation` event, while `git-guard` also writes `state.gitDrift` durably — and `logEvent` swallows a failed append by design |
| `resolved-<round>` | open obligations discharged | filtered on `accepted` only, while the ledger puts `needs_evidence` and `escalated_to_fable` in `REQUIRES_RESOLUTION` too |
| `13.10-no-out-of-scope-changes` | scope drift | `changedFiles()` returned a partial list when one of two Git queries failed (`&&` where `\|\|` was meant) |
| every package accepted | EXECUTION's exit requirement | checked once on the way out; nothing stopped `task --status pending` afterwards, and completion read `tasks.json` only for ownership |

Two adjacent holes closed with them. `resolve` could close an `escalated_to_fable` finding with any
ten-character string — so the coordinator that escalated a *blocking* finding could close it with
"escalated to the director as agreed", the blocker left `openBlockers`, and the director never
decided; it is now refused, and the message names the replacement decision as the way to close it.
And `count` accepted any counter name: `--counter codexInvocation` reported success, minted a dead
field and left the real counter untouched. The settable names are derived from
`state.schema.json`'s integer counters, and `--by` must be a whole number, because `9 > "seven"` is
`false` and a `NaN` counter is a bound nothing can satisfy.

### S32. An errand is a fact on disk, so it outlives being mentioned once

`Stop` consumed `directorTurn.yielded` **before** checking for a pending errand: it cleared the flag,
blocked once with the relay instruction, and from then on the flag was false, so the very next
attempt to end the turn was allowed. A run with an unanswered question and no running director was
abandoned in silence, with nothing left that could wake it.

"Told once" is the right bound for the *generic* nudge, because "the director is idle" is an inference
and §S12 is what over-trusting it costs. An errand is not an inference: `askedAt` without its
completion stamp is a file saying the run cannot move without this thread. It is checked before the
flag, it keeps blocking while it stands, and it is **counted**.

The counter had the defect §S26b describes below, in the other loop: the errand branches returned
before reaching it, so those blocks spent the harness's ceiling without being counted, and nothing
reset it on an allowed stop — so a thread that alternated block, allow, block accumulated towards
`SUSPENDED` for blocks the harness had already forgotten.

### S26b. Two counters, one harness ceiling — measured at 12 against 8

The `SubagentStop` controller gave waiting its own counter, on the argument that waiting on a delegate
should not spend the dispatch's budget. The harness does not share that view: it honours 8
**consecutive** blocks (§R6) and never asks which branch emitted them. Two counters each yielding at
the soft cap of 6 therefore permitted 2×6 blocks, and alternating the two things a healthy director
does — dispatch, wait for the child, dispatch again — produced exactly **12 consecutive blocks
against a ceiling of 8**, reproduced in the suite before the fix.

The four past the line are dropped. At that point the last decision was a block, so `yielded` is
false, the main thread's `Stop` hook allows, and the run goes idle without a word: §S2's defect,
reached through the branch written to prevent it.

One counter now, resetting on every yield, because that is what the harness models. What waiting is
exempt from is the **stall** budget — run 6 reached 3 of the 5 samples that move a healthy run to
`BLOCKED` by polling a coordinator that was working — and it stays exempt, because that branch returns
before `recordStall`. Cheap and free are different claims and only one of them was ever true; the
director-facing message said both.

### S33. Three guards that could not see what they claimed to

- **The fail-closed hook failed open on a corrupt state.** `policyApplies()` returned inactive for
  *any* unreadable `state.json`, so a truncated write or an unsupported `schemaVersion` released
  `git commit`, `.git/` writes and the `Workflow` tool — in the one hook whose contract is that
  anything unclassifiable is denied. A bound run whose phase is unknown is the unclassifiable case.
  **Absent** state is not symmetric and stays permissive: `claude plugin uninstall` deletes the whole
  data directory (§S25) while the session binding survives, and holding the user's Git hostage to a
  reinstall is the wrong failure.
- **The one-director rule was inert for most of a run.** `directorTurn.agentId` was written only when
  the director *stopped*, so through the whole of phase one — the longest single stretch —
  `directorIsDriving()` read false and a coordinator dispatching a second director was allowed. It is
  now written on the director's `SubagentStart`, which is also where a fresh dispatch's block series
  correctly starts at zero.
- **Two readers of "who is the director" selected differently.** `subagent-controller` ignores any
  candidate not at depth 1; `directorSubagent()` took the newest matching `agentType` at any depth —
  and run 6's impostor at depth 3 was the most recently written meta for four minutes, so the
  completion gate would have reported its depth, model and effort as the run's. Now ranked: depth 1
  first, then no recorded depth (metas predating the field — no evidence either way), then a depth
  known to be wrong. The last rank still *answers* rather than returning `null`, because the gate
  prints the depth and silence would hide the impostor instead of naming it.

### S34. Fourteen doc blocks detached from what they document

Detected mechanically — a `*/` followed by another `/**` with no declaration between — then verified
by hand, across nine files. Two shapes: a doc orphaned above a later insertion, and two stacked docs
for one declaration. `lib/state.mjs` alone had five; it documented `liveChildren` above
`reviewedArtifactDigest`.

Recorded because in this repository the comments *are* the design record, so one attached to the wrong
function is misinformation rather than untidiness. The two remaining adjacent pairs
(`lib/telemetry.mjs`, `lib/validate.mjs`) are module headers followed by a declaration's own doc and
are correct.

### S36. §18's extra round should stay optional. The cheaper branch had no mechanical form.

The open question after run 8 was whether §18's extra review should become **mandatory** once round 2
raises blocking findings. Three artefacts across runs 7 and 8 were locked after their last review,
every gate reported it, every gate passed, and `extraReviews: {}` both times.

Run 8's archive answers it, and not the way the question was framed. The gate's own text offers a
choice — *"State the change as residual risk, or run an extra round"* — and run 8 recorded **four**
residual risks:

| # | source | about |
| --- | --- | --- |
| 1 | `DESIGN-002` | a `Proxy` over an array satisfies §3.4 structurally and can answer differently on two reads |
| 2 | `PLAN-004` | AC-44's interleaving clause has no discriminating test |
| 3 | `PLAN-006` | AC-44's state clause is undecidable by command without an AST |
| 4 | `IMPL-001` | `scratch/verify-wp001.sh` hardcodes a pre-feature test count of 14 |

Every one is a *finding* the director would have recorded anyway. **Not one cites the drift.** So
neither branch of the disjunction was performed: not the extra round, and not the statement either.
The run finished on a claim the contract had already described as needing to be written down
somewhere.

That is not §18 being too permissive. §18's optionality is correct, and §S17 records why: failing on
the drift itself would force a Codex round onto every typo fix, and a check that fires on every
healthy run carries no signal. The defect is that the *cheaper* branch had no mechanical form, so it
read as free — the same shape as everything else in this section, one level up: a guarantee stated in
prose and enforced nowhere.

`risk --add --source` already existed. The gate now raises `unverifiable-stated`, which fails while an
offer stands undischarged and names the exact command. It is scoped to the conditions that *make* the
offer — registered at the line that prints it — because most `unverifiable` statuses mean the
environment could not answer (no runtime check declared, Git unavailable, a review predating the
digest field), and asking for a residual risk about "Git could not be queried" is the noise this
avoided in the first place.

Cost to a healthy run: one command, when an artefact was edited after its last review. Cost to a run
that does neither: it does not pass, which is what the contract said all along.

**Replayed against the run-8 archive** with all of §U's tightenings applied: design 11 pass / 1
unverifiable, plan 16 / 1, completion **22 pass, 0 unverifiable, 0 fail** (21 before — the new
`packages-accepted` is the extra). No condition flipped to a failure, so these closed holes rather
than inventing a gate nobody can pass. Run 8 would now additionally have had to write two residual
risks citing the two drifted artefacts.

### S37. Where run 8's 234 minutes went, and the one phase that is not adversarial work

**Provenance.** Run 8's column is re-derivable: `run8-archive/` preserves `telemetry.jsonl`, so every
figure below is a timestamp difference over 19 `transition` events. Run 7's is **not** — `claude plugin
uninstall` deleted its run directory (§S25), so its numbers are the ones extracted before the deletion
and cannot be recomputed. They are quoted, never used as a denominator.

Run 8, minutes per phase:

| phase | min | | phase | min |
| --- | ---: | --- | --- | ---: |
| INTAKE + BRAINSTORMING | 4.1 | | EXECUTION | 29.1 |
| DESIGN_DRAFT | 9.6 | | SYSTEM_VERIFICATION | 10.2 |
| DESIGN_REVIEW_1 | 3.9 | | IMPLEMENTATION_REVIEW_1 | 4.2 |
| DESIGN_REMEDIATION | 17.3 | | IMPLEMENTATION_REMEDIATION | 18.8 |
| DESIGN_REVIEW_2 | 15.8 | | IMPLEMENTATION_REVIEW_2 | 3.1 |
| PLAN_DRAFT | 17.9 | | **FINAL_ACCEPTANCE** | **50.6** |
| PLAN_REVIEW_1 | 4.8 | | *the two LOCK phases* | *0.5* |
| PLAN_REMEDIATION | 18.2 | | | |
| PLAN_REVIEW_2 | 24.6 | | | |

Grouped: **everything before the first line of code, 117 min (50 %)**; execution and verification 39
min (17 %); post-code adversarial review 26 min (11 %); `FINAL_ACCEPTANCE` 51 min (**22 %**). The
three remediation phases alone are 54 min (23 %) and they track findings, which is the architecture
doing what it is for — the biggest of them follows `plan-1`'s five findings.

The outlier is `FINAL_ACCEPTANCE`, and it is the one phase with no adversarial content at all. The
gate is a script, the report is a script; both run in seconds. Its only *authoring* task is the
product diagram — and run 8 produced **8,609 bytes of hand-designed HTML** (palette, dark-mode media
queries, its own `<!DOCTYPE>`, `<html>` and `<head>`, which the publisher then wraps a second time)
around a **361-byte** Mermaid diagram.

Artifacts render Mermaid natively from a ` ```mermaid ` fence. So both instruction sites now ask for a
short Markdown page — title, fence, two or three sentences of what it means. The diagram is the
deliverable; the chrome is not, and this is the rare saving that costs nothing in quality, because the
artefact that reaches the user is identical.

Attribution bound, stated because §S24 exists: the phase was 51 minutes and the page is its only
authoring work, but nothing measures how much of the 51 the page took. This is a hypothesis with a
mechanism, not a measured saving, and run 9's `FINAL_ACCEPTANCE` duration is the test.

Run 7 versus run 8, quoted:

| | run 7 | run 8 |
| --- | --- | --- |
| duration | 125 min *(quoted)* | **234 min** *(re-derivable)* |
| cost | $27.93 *(quoted)* | **$51.77** *(quoted — the transcripts are outside the archive)* |
| findings / blocking | 5 / 2 *(quoted)* | **17 / 11** *(re-derivable)* |
| rounds returning `blocker` | 2 of 6 *(quoted)* | **4 of 6** *(re-derivable)* |
| director cold restarts | 9 *(quoted)* | 12 *(quoted)* |

Run 8 took 1.9× the time and found 3.4× the defects, 5.5× the blocking ones. The comparison is not a
controlled one — different feature, different codebase — and the honest reading is the one §S24 already
argues: **cost tracks findings to adjudicate, not feature size.** Run 8's four `blocker` verdicts
produced three remediation phases totalling 54 minutes; run 7's two produced far less. That is the
mechanism, and it is the mechanism working.

### S38. The two run-8 events nobody had looked at — both mechanisms working

- **`report_rejected`, 125.6 min, `WP-001`.** An implementer stopped with `WP-001` still
  `in_progress` and no report submitted, so the `SubagentStop` validator blocked it once with §16.4's
  reminder — the **first production firing** of a hook whose counter was declared and never
  incremented for three runs. `WP-001` was subsequently accepted, so the one-shot reminder did exactly
  its job. Not a defect.
- **`redispatch_required`, 232.7 min, `blocks: 1`, `FINAL_ACCEPTANCE`.** The publish relay completed at
  ~231 min; the director was resumed, stopped, and the main thread's Stop hook nudged it once. `COMPLETE`
  landed 18 seconds later. One block, one nudge, one handover — the loop as designed, at the only
  moment in 234 minutes it was needed.

The third event in that window, `awaiting_delegate` at 229.7 min with two live `sonnet-verifier`
children, was §S15's first production firing and is recorded in the run-8 notes.

### S40. No hook observes the director's start — measured on run 9, aborted at 5 minutes

`directorTurn.agentId` was `null` in `DESIGN_DRAFT` while the director was demonstrably alive: `children`
held a depth-2 `sonnet-researcher` whose meta named its parent, and that parent's meta was
`hyperpowers-director` at depth 1. So the registry write worked and the director-specific one had never
run.

**The ordering, which was already written down in this codebase.** `subagent-controller.mjs` opens with
`if (!runId) return emitAllowStop()`. `/hyperpowers:feature` dispatches the director, and *the director*
then runs `state-machine.mjs init` — so at its own `SubagentStart` there is no bound run and the hook
returns before reaching §S33's registration. `git-policy.mjs` states exactly this: *"The legitimate first
dispatch is never seen here: `/hyperpowers:feature` dispatches the director, and the director creates the
run — so there is no bound run to be active, and this hook has already returned."* §S33 was then written
one file over on the opposite assumption. **A director is first observable at its first stop**, and that
is a property of the architecture, not a bug to be fixed by moving the guard: a hook that runs before a
run exists has nothing to write to.

Two consequences, both measured:

- §S13's **prevention** half was inert for the whole of phase one — the longest single stretch of a run.
  The `SubagentStop` depth guard still detected an impostor, which is ADR 0003's other half doing its job.
- Every relay message fell back to `Agent → hyperpowers-director`, a **cold** dispatch, instead of
  `SendMessage → <id>`. Run 8 spent **$15.48 — 30% of the run** — on Fable cache writes across twelve cold
  restarts (§T2), so this is the dearest line in the bill, reached by an instruction.

And a third, which is why the first fix did not hold either: `countBlock` was the only writer of
`agentId`, and **the parked-errand and stop-allowed paths yield without counting**. So a run whose first
stop is a park would never record its director at all — *inferred from the code, not observed*: run 9
aborted in `DESIGN_DRAFT` and its `BRAINSTORMING` completed without parking, so no run has yet exhibited
this. It is covered by a regression test that drives the park directly.

**The fix is in two halves that have to agree.**

1. One stamping site in `subagent-controller`, immediately after the director and depth filters, before
   any branch — so no branch can skip it. A `SubagentStart` reaching there is a *re-dispatch* (the first
   cannot), and a re-dispatch resets the block count because it starts a fresh harness series.
2. `directorIsDriving(state, transcriptPath)` reads three things in a fixed order, and the order is the
   design: **an explicit yield always releases** (`resume-run.mjs` sets `yielded: true`, which is how a
   director that died without stopping stays replaceable — a fallback ignoring it would deny every
   replacement for ever, worse than the hole); then a recorded id; then the meta files, via
   `directorSubagent`, which now returns the `agentId` it always knew from the filename and ranks a wrong
   depth last, so run 6's depth-3 impostor is not mistaken for the thing it impersonates.

`PreToolUse` carries `transcript_path` (§D5), so `git-policy` can ask the same question during phase one.
`stop-controller` resolves the id the same way, which is what turns the relay from a cold dispatch back
into a resume — and its resolver carries its own `spawnDepth === 1` guard, tested, because naming an
impostor to `SendMessage` would be worse than naming nobody.

**One thing in run 9's final state I cannot account for, recorded rather than explained.** The archived
state ends with `directorTurn.agentId = a28e41392808cb555`, `blocks: 0`, `yielded: true` — the id *is*
there — while `telemetry.jsonl` holds only `run_started`, `preflight` and four `transition` events: no
`continuation`, no `awaiting_delegate`, so `countBlock` (the sole writer in that build) never completed a
call it logged. `observedDirectorModel` and `observedEffort` are set, so the director's `SubagentStop` was
processed past the filters. There is exactly one director meta, written at 01:16:29 — nine seconds before
`init` created the run — so there was no re-dispatch whose start could have registered it.

The candidate explanations (a hook killed between its `mutateState` write and its `logEvent`; a start
nobody observed) are speculation and are not recorded as findings. What *is* established is the direct
observation this entry rests on: at `DESIGN_DRAFT`, read live, `agentId` was `null` while the director was
running and had already dispatched two delegates. The restart will settle the rest — the monitor watches
that field, and with the fix the id must appear at the first stop with a journal entry beside it.

**One boundary left unverified, deliberately.** State's recorded id is preferred over the disk, so between
a cold re-dispatch and that new director's `SubagentStart` the record names the *previous* agent. Whether
`SendMessage` to an agent that has already returned fails loudly or silently does nothing is **not
measured** — §S2 measured resuming a *parked* agent, which is the case the relay actually hits, and that
works. Changing the resolution order on the strength of a guess is what §S24 records three refusals of, so
the order stands and the gap is written down instead.

**What run 9 did and did not establish.** It ran 4 minutes of phase one and aborted in `DESIGN_DRAFT`, so
it validated §S19 (the harness loads the reviewed build) and found §S40. **Nothing downstream of phase one
was exercised** — not §S26b's merged counter, §S29's recovery edges, §S30's untracked hashing, §S31's six
conditions, §S36's discharge, nor §S27's review pack. Those remain tested by the suite alone, and the
restart is their first real exposure, not a re-confirmation.

**The monitor found this in two minutes, and also caught itself.** It had printed
`PHASE PREFLIGHT → BRAINSTORMING` — an edge `canTransition` forbids and the machine never made; the record
said `PREFLIGHT → INTAKE → BRAINSTORMING`. It was comparing what it happened to see between 30-second
ticks. It now reads `state.history`, because a monitor that invents an illegal transition costs more than
one that misses a legal one.

### S39. Six defects found reviewing §U's own changes

The third pass over the same code, with the diff read as a stranger's. Recorded because the pattern is
now the point: **every one of these was introduced by a fix, and two of them are the very class that fix
was closing.**

- **A discharge with no version behind it lasted for ever.** §S36's citation was a token: state the
  risk once, keep editing the artefact, and the gate stayed satisfied by a sentence describing a version
  two edits ago. That is `gateInputDigest`'s invariant — a claim does not carry over to a state it was
  not made about — missing from the mechanism written to enforce a claim. Now the statement's timestamp
  is compared against the artefact's, from fields that already existed, and a stale one reads as
  undischarged.
- **The errand block instructed an action the Git policy denies.** Moving the errand check above the
  `yielded` flag (§S32) made the message reachable while a director is still driving — and §S13's
  prevention denies a second director dispatch in exactly that state. Blocked, obedient, denied, nowhere
  to go. The last line is now conditional on `directorIsDriving`.
- **The main thread's counter did not reset on the path a healthy run takes.** `countTurnBlock`'s own
  doc said "reset on every allowed stop"; the *most-travelled* allow — every time the turn ends while
  the director works — still used `emitAllowStop`. So the counter accumulated across separated series
  and would have suspended a working run for blocks the harness had already forgotten. Caught by
  reading the exits against the comment that described them.
- **A suspension caused by an unrun errand did not name it.** Resuming clears the block count and not
  the errand, so the user would have resumed straight back into the same wall.
- **`packages-accepted` decided its status from its own message text**, after a first attempt that
  wrote the same predicate three times. One predicate, named once.
- **`asLines` joined with `'; '`.** Harmless until §S27 put `asBlock` beside it, at which point the
  helper called "lines" was the one that did not produce any. Renamed `asJoined`.

Checked and **not** defects, recorded so the next reader does not re-check them: `git hash-object
--stdin-paths` un-quotes `core.quotePath` output, so §S30's untracked hashing is correct for paths with
spaces and non-ASCII (verified against a `café file.mjs` fixture, identical blob ids either way); and
`scripts/lib/git-policy.mjs`'s 20-line diff is comment relocation only, with no change to the
classifier.

### S35. Rejected after investigation

- **"The added tests failed before the change" cannot fail.** True, and deliberate: absence of red
  evidence is `unverifiable`, which the gate tolerates and stores by id for the director to state as
  residual risk. Making it fail would block a run for evidence that is often genuinely unobtainable.
- **The final report's regeneration is best-effort after a terminal transition.** The comment already
  says so, and gives the reason: a stale document is better than refusing a legitimate terminal
  transition.
- **A second `SubagentStop` hook could consume the director's ceiling.** `validate-agent-report`
  filters to agent types matching `/implementer/i` and returns an allow for everything else, so it
  never blocks the director.
- **Fallbacks counted from two sources.** `summarise()` reads both `fallback` events and the
  `fallbacks` array on a transition. Only `codex-adversary` produces the event automatically, so a
  double count needs an agent to also pass `--fallback` for the same occurrence. Left alone rather
  than changing an accounting rule on an unmeasured producer.

### S19. Run 6's economics, and where the money actually went

$30.95 over 68 minutes, reaching `PLAN_DRAFT` with no plan review. Per agent, deduplicated by
request (§P7):

| agent | d | type | reqs | out-tok | $ | % |
| --- | --- | --- | --- | --- | --- | --- |
| `a0c5476…` | 1 | director | 75 | 27 696 | 13.37 | 42.4 |
| `a724d17…` | 2 | opus-plan-coordinator | 43 | 73 259 | 4.86 | 15.4 |
| `ac42a95…` | 3 | **impostor director** | 34 | 21 547 | 4.37 | 13.9 |
| `a1888aa…` | 2 | opus-review-adjudicator | 40 | 46 327 | 3.92 | 12.4 |
| MAIN | 0 | session relay | 81 | 23 644 | 3.54 | 11.2 |
| `aa4229b…` | 2 | opus-design-coordinator | 8 | 28 357 | 1.12 | 3.5 |
| `a6923ac…` | 2 | sonnet-researcher | 6 | 7 973 | 0.24 | 0.8 |
| `aff603f…` | 1 | duplicate director | 1 | 152 | 0.10 | 0.3 |

By family: **fable 56.6 %, opus 31.4 %, sonnet 12.0 %**. Fable takes 57 % of the bill for 21 % of
the output tokens — it is the dearest tier and the loop made it take the most turns, which is §P8
restated: the bill is context re-read, not generation.

Roughly **$9 (30 %)** is attributable to the four control defects, and the direction of each bound
differs: the impostor's $4.37 is a **ceiling** (some of it was legitimate adjudicator work routed
through the wrong agent type), while the main-thread nag (~$3.2) and the post-abort work (~$1.6)
are floors.

**Evidence hygiene bound.** `hooks/hooks.json` and `stop-controller.mjs` were edited at 04:29 local
while two agents were still alive (run ended 04:36), and hooks execute from `CLAUDE_PLUGIN_ROOT`,
which was the working tree. Nothing about hook behaviour in the last seven minutes of run 6 is clean
evidence. §S14 survives that bound — `verify-completion.mjs` was untouched until 04:54, well after
the post-abort gate writes at 04:34 and 04:35.


## I. Accepted without independent verification

| Claim | Spec ref | Why accepted / mitigation |
| --- | --- | --- |
| `allowedAgentTypes` is ignored for nested subagents | §4.4 | Not verified. Mitigated exactly as the spec argues: Sonnet agents have no `Agent` tool (enforced by `tools:`, C1 caps depth anyway), all Git mutation is hook-blocked, and the ledger records every agent actually launched. Treated as telemetry, not a security boundary. |
| CursorBench 3.2 score deltas | §7.2 | Unfalsifiable from here. The *economic* conclusion is independently recomputed in `docs/cost-model.md` from the harness's own pricing tiers (A4). |

---

## V. The adversarial verification campaign — 2026-07-30

Twenty-two agents re-derived the release candidate's load-bearing claims from the archived runs and
from the live binary, each rebuilding the arithmetic out of this repository's own
`scripts/lib/transcript.mjs` so that grouping and pricing are the ones the plugin ships. The method
check matters more than any total: recomputing §Q11 reproduces it to the cent — director $20.36,
execution coordinator $17.02 over 92 turns, adjudicators $13.12 against the recorded $13.11,
implementers $12.05, 71.9M cache reads, context 81.9% against the recorded 81.8%. Per-file sums
equal `analyseTranscript`'s totals exactly, with zero cross-file `requestId` collisions, in every
run. What follows is what did **not** reproduce.

Nothing above this section is rewritten. Each falsified sentence carries a pointer to the entry that
corrects it, because a measured row that quietly changes its mind is worth less than a wrong one
somebody can still find.

Read-only sources: runs #1/#2 `453e250d…`/`9c7f397b…`, run 3 `f4570451…`, §Q11's production run
`22ac056c…`, run 8 `8e4ebe99…`, run 9 `d71c12b0…` (reached `COMPLETE`), run 9b `91004d07…` (wedged,
aborted by hand), plus their archived run directories and the live binary at
`~/.local/share/claude/versions/2.1.220`.

### V1. Background dispatch was never enforced by the tool filter — **§S4 REFUTED**

At 04:26:12.540Z run 9b's `hyperpowers-director` — `spawnDepth 1`, `callerModel claude-fable-5` —
issued `Agent{subagent_type: hyperpowers:opus-review-adjudicator, run_in_background: true}`, and the
harness answered at 04:26:16.512Z with **"Async agent launched successfully."** §R1's filter removes
whole *tools*: `Workflow`, `TaskOutput`, `ScheduleWakeup`. `run_in_background` is a **parameter** of
a tool the director must keep, and a `tools:` list cannot remove a parameter. Prevention that reads
as mechanical because it is written next to something mechanical is exactly the recurring defect §U
names.

Run 9 — the run that reached `COMPLETE` — made 34 `Agent` calls, three of them backgrounded: the
main thread's opening director dispatch, which is by design, and two at 13:08:43 and 13:57:23 from
`opus-review-adjudicator` (depth 2) to `sonnet-implementer`. The consequence is visible in the same
transcript. The only `tool_result` either backgrounded child ever returned to its dispatcher is
"Async agent launched successfully"; the synchronous dispatch at 13:21:34 returned finished work at
13:29:53. Both children did real work — 15 and 13 `Write`/`Edit` calls — and submitted no report
through the state machine, and the parent executed a file its child was still writing (parent ran
`tools/test-inventory.mjs` at 13:17:28 and 13:19:45; the child wrote fixtures through 13:18:52). No
corruption or lost update was observed. The harness's own stated continuation path — "Use
SendMessage with to: `<id>`" — is a tool no Hyperpowers agent has, and `TaskOutput` is stripped from
every subagent, so a backgrounded child is unreachable by construction.

Of the five agents whose `tools:` include `Agent`, three — `opus-review-adjudicator`,
`opus-design-coordinator`, `opus-plan-coordinator` — carry no rule against backgrounding at all. The
agent that broke the rule in the only completed run is one of them. Counting the sites is the fix
that generalises; a fourth per-file regex is not.

The enforcement surface exists and is unused: `PreToolUse` already matches `Agent`, and per §V3 the
payload carries both `tool_input.run_in_background` and a caller discriminator.

### V2. A subagent's model pin is third in precedence, not unconditional — **§S3 T26 mis-cited**

Re-extracted from the live 2.1.220 binary, the subagent model resolver, verbatim:

```
l&&l!=="inherit"?[l,"env"]:r?r==="inherit"?[t,"inherit"]:[r,"tool"]:e&&e!=="inherit"?[e,"frontmatter"]:[t,"inherit"]
```

The labels `"env"`, `"tool"` and `"frontmatter"` are the harness's own. The resolver reads
`CLAUDE_CODE_SUBAGENT_MODEL` first, then the per-invocation `model` argument, then the agent's
frontmatter, then inherits. A second copy on the teammate-spawn path has the same order. So the
precedence is **env > per-invocation > frontmatter > session default**: frontmatter holds against
the *session default* only, which is the thing §S4 needed and all any run has ever exercised.

T26 is titled "a subagent's `effort:` pin holds" and its table has three effort rows and no model
row; §B4 is a load-time parse claim, not a precedence measurement. Eleven sites across docs,
prompts, scripts and tests assert an unconditional **model** pin on T26's authority (§V11).

*What is not shown.* No archived run demonstrates a per-invocation `model` beating frontmatter. Run
9 carries exactly three `Agent` calls with a `model` argument — 15:26:06.157Z, 15:30:45.709Z,
15:36:57.627Z, all from `opus-review-adjudicator`, all saying `"sonnet"` to agents that already
declare Sonnet. Accepted, and non-divergent. The precedence is therefore a binary-read fact, not an
observed inversion. The experiment that would settle it is one headless dispatch of a `model: haiku`
plugin agent with `model: "opus"` passed per-invocation, reading `message.model` out of the
resulting subagent transcript.

*What actually holds the tier.* `directorTier()` reads the **observed** model from the director's own
subagent transcript, so it detects an inversion whatever its source — frontmatter, `--model`, a
per-invocation argument or the env var — and the PREFLIGHT transition guard plus completion condition
§13.12b are the mechanical guarantee. Both archived runs recorded `claude-fable-5` against a
configured `fable`. The honest statement is: **declared, and mismatch-detected before the first
transition and again at the end**; not unconditional.

`CLAUDE_CODE_SUBAGENT_MODEL` appears nowhere in this repository and `REQUIRED_ENV` is empty by
design. Set in a user's shell it retiers every Hyperpowers agent, and only the director's model is
ever observed. That is a documentation fact, not a reason to add an install step.

### V3. `PreToolUse` fires inside a subagent, and the payload names the caller — **NEW, single configuration**

`EXP` — a scratch project with `.claude/settings.json` registering a `PreToolUse` capture on
`Agent|Task`, a `probe-parent` agent holding `Agent`, and one headless session told to dispatch it;
the parent then dispatched `probe-child` with `run_in_background: true`. Capture 2, verbatim minus
the prompt:

```json
{"session_id":"98977af8-…","transcript_path":"…/98977af8-….jsonl","permission_mode":"auto",
 "agent_id":"a1cc388aa32480136","agent_type":"probe-parent","effort":{"level":"xhigh"},
 "hook_event_name":"PreToolUse","tool_name":"Agent",
 "tool_input":{"description":"Probe child ping test","subagent_type":"probe-child",
 "run_in_background":true},"tool_use_id":"toolu_019d…"}
```

Three facts, each of which a rule can now rest on:

- **`PreToolUse` fires for an `Agent` call issued from inside a subagent.** Corroborated in
  production: run 9's director transcript (depth 1) and a `sonnet-implementer` transcript (depth 3)
  each contain a `tool_result` beginning "Hyperpowers Git policy — DENIED."
- **`tool_input.run_in_background` is present and readable**, which is what makes §V1's invariant
  mechanical rather than asked for.
- **`agent_id` and `agent_type` are present when the caller is a subagent and absent when it is the
  main thread.** Capture 1 — the main thread dispatching `probe-parent` — reproduces §T1's key set
  exactly, neither more nor less, which is what makes capture 2 a difference rather than a version
  drift. `transcript_path` is the *main session* transcript in both, which is what makes
  `directorIsDriving(state, transcript_path)` correct.

*Scope, and it is narrow.* One probe: headless `-p`, project `.claude/agents` rather than plugin
agents, depth 1→2, `permission_mode: auto`. **Not** measured for interactive sessions, for plugin
agents, or for depth 2→3. §D5, §T1, §S14 and §S16 all state that `PreToolUse` carries no `agent_id`;
that is now true of a *main-thread* caller and false of a subagent one. If the discriminator turns
out not to generalise, a rule needing no caller identity is available and weaker: refuse
`run_in_background: true` for any `subagent_type` that is not the director.

§S14's larger conclusion survives untouched: knowing who issued a *tool call* still does not let any
hook cancel an `Agent` call already in flight.

### V4. "Tool calls per turn: 1.00" was an identity, not an observation — **§P8 and §Q13 corrected**

`maxToolUseBlocksInOneRow` is **1** in all five runs examined: the transcript never writes two
`tool_use` blocks into one row. So *blocks ÷ rows-containing-a-`tool_use`* is exactly 1.0000 for any
transcript, forever. "No exceptions" was the tell. The provenance is confirmable arithmetically —
run #1 holds 655 assistant rows and run #2 holds 760, and 655 + 760 = **1,415**, the denominator §P8
states. This is §P7's row-versus-request defect, fixed for cost accounting and left standing in turn
accounting, one metric over.

Recomputed per API **request**, which is §P8's own stated unit ("a turn is one API round-trip"):

| run #1 | run #2 | run #3 | §Q11 | run 8 | run 9 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.153 | 1.183 | 1.208 | 1.242 | 1.259 | 1.243 |

Run #1 issued two or more tool calls on **47 of 321 requests** (37 × 2, 3 × 3, 7 × 4); run #2 has one
request carrying eight. Agents batched on the very transcripts §P8 called unbatched. §Q13's follow-on
— "1.00 to 1.22, mean 1.18 … so batching moved — a little" — inherits the same false baseline:
nothing moved, the metric changed.

**What survives:** batching independent calls is still right, still cheap, and still the thing every
agent is told to do; the rule and its test stay. **What is withdrawn:** the sizing. "The largest
saving still on the table" and "roughly a quarter of the bill" were computed against a baseline that
never existed. The measured headroom is the distance from ~1.2 to whatever an agent can actually
reach, and nobody has measured that.

### V5. The dearest thing is a role's total turns across dispatches — **§Q11's agent-lifetime claim scoped to §Q11**

| | execution coordinator | all implementers | director | adjudicator **role** |
| --- | ---: | ---: | ---: | ---: |
| §Q11 | $17.02 | $12.05 (6) | $20.36 | $13.12 (3 dispatches) |
| run 8 | **$2.57** (24 turns) | **$3.97** (4) | $19.78 | $14.86 (5) |
| run 9 | **$6.71** (39 turns) | **$6.88** (8) | $27.10 | **$33.55** (8) |

§Q11 reproduces to the cent and does not replicate. In run 8 the coordinator cost 65% of the
implementers it coordinated; in run 9 they are effectively tied. Only the **director** half
generalises — $19.78 (38.5%) and $27.10 (29.6%) of those runs.

The framing itself now misdirects. The largest line in run 9 is `opus-review-adjudicator` summed over
its eight dispatches and 377 turns: **$33.55, 36.7%**, above the director — while no single
adjudicator instance exceeds $7.51. "The longest-lived agent" points at a lifetime; the measured
target is a **role's total turn count across dispatches**, which is a different optimisation and
lands on a different agent.

### V6. "Context re-read" is two terms, and the re-write is now the larger — **§P8 and §Q11 phrasing corrected**

| | fresh input | cache **read** | cache **write** | generation | context |
| --- | ---: | ---: | ---: | ---: | ---: |
| §Q11 | 0.0% | 49.4% | 32.5% | 18.1% | **81.9%** |
| run 3 | 0.0% | 37.5% | 27.9% | 34.6% | 65.4% |
| run 8 | 0.1% | **26.5%** | **46.9%** | 26.6% | 73.4% |
| run 9 | 0.0% | **34.1%** | **42.3%** | 23.6% | 76.4% |

"Context, not generation, is the bill" holds everywhere — 65–82% against 18–35% — and §Q11's number
confirms on recomputation (81.9% against the recorded 81.8%). The **causal clause** is what is
wrong. 81.8% is cache read *plus* cache write, and a cache write is not a re-read: it is paying
1.25× to establish a cache after the previous one expired. On the two most recent runs cache write
is the single largest term of four.

The distinction picks the remedy, which is the only reason it matters. "Carry less context forward"
addresses the read term. The write term is addressed by crossing fewer expiry windows, or crossing
them at a cheaper tier — and §T2 already measured that the ~5-minute subagent expiry is a harness
property nobody can remove.

Where the write term comes from, measured on run 9's director and bucketed by the idle gap *before*
each request: `< 1 min` read 3,205k · write 68k; `1–5 min` read 461k · write 144k; `5–15 min` read
**0** · write 770k; `> 15 min` read **0** · write 699k. The boundary is sharp — a 293 s gap read
27,718 tokens, a 356 s gap read zero and wrote 59,573. Exactly one `hyperpowers-director` meta file
exists in run 8's and in run 9's `subagents/` directory, so the director was never redispatched; it
was **resumed into an expired cache**. Control, and it is §T2's: §Q11's *main-thread* director held
cache across 23 gaps of 5–15 minutes and one of 955 s, a write/read ratio of 0.03 against the
subagent director's 0.46–0.64.

### V7. Cost by function — production is a sixth of the bill, and the output-token band regulates a quarter of it

| cost by function | §Q11 | run 8 | run 9 |
| --- | ---: | ---: | ---: |
| production — implementer, xhigh retry, test engineer, verifier | $14.16 **19.1%** | $7.75 **15.1%** | $15.91 **17.4%** |
| adjudication | $13.12 17.7% | $14.86 28.9% | $33.55 36.7% |
| coordination | $23.50 31.7% | $7.90 15.4% | $14.02 15.3% |
| direction | $20.36 27.5% | $20.63 40.2% | $27.62 30.2% |

Production is **15–19% of spend across three runs**. Output tokens are 23.6% (run 9) and 26.6%
(run 8) of cost. So spec §6.2's band — Fable ≤ 10 / Opus 20–25 / Sonnet ≥ 65 percent of *output
tokens* — regulates about a quarter of the bill, and it presumes that quarter is production work.

Nothing is misrouted: every Opus dispatch is a role the spec's own table assigns to Opus. The pyramid
inverted because judgment volume outgrew production volume — run 9 adjudicated 13 findings over 5
rounds in 8 dispatches and 377 turns, against 8 work packages built. **The Opus-heavy split is
neither an optimum nor an accident: it is the arithmetic consequence of pairing the spec's role
assignment with a six-round review architecture.** The band is the wrong instrument for this shape,
which is why `report.mjs` already renders it as orientation and why §Q11 reached the same conclusion
from a single run.

Retiering at observed token counts, run 9: the Opus roles moved to Sonnet save $19.02 (20.8%), of
which the adjudicator is $13.42. **Not recommended on that arithmetic.** It holds token counts
constant — the assumption `docs/cost-model.md` names as most likely wrong in the flattering
direction — §S24 records three of three plausible savings dying on measurement, and the capability at
risk is documented twice: §P4's adjudicator refusing to take Codex's word, reproducing the failure
and finding it *broader*, and §Q11's rejecting a recommended fix **by executing it**.

Two things measured alongside, both larger than the tier question and neither carrying a quality
risk. Run 9's director spent **28 of 62 turns** invoking `state-machine.mjs` or `report.mjs` —
$11.13, 40.7% of the director, 12.2% of the run, 8 of them cold at $8.13; run 8, 21 of 45 turns,
$9.55, 47.7% of the director. Model judgment contributes nothing on those turns and each pays a full
context re-establishment. And run 9 ran 13 gate events for 3 gates (the plan gate 9 attempts, 7 of
them failing, three on the same condition within 14 seconds) and spent $10.14 (11.1%) on three
adjudicator dispatches re-establishing verdicts a first dispatch had not recorded durably.

### V8. Run 9b, minute by minute — every liveness protection is reachable only from a director's stop

Measured from the archived run directory rather than from any report of it. Run start
**01:37:47.760**; last forward transition `DESIGN_REVIEW_1 → DESIGN_REMEDIATION` at **01:53:26.107**,
so the wedge begins at minute 16; `awaiting_delegate` at **04:26:18.985** (`DESIGN_REMEDIATION`,
`blocks: 1`, children two `opus-review-adjudicator`); user `ABORTED` at **10:36:42.003**. Total
**8h58m55s**, on ten lines of telemetry.

Two circulating descriptions are imprecise, and both are corrected here rather than repeated. "No
`SubagentStop` for ~4.5 h" is wrong twice over: **three `SubagentStart` hooks did fire during the
wedge** — the children registered at 02:11:06, 03:54:08 and 04:26:16 prove `mutateState` ran — and
the director emitted **exactly one `SubagentStop` in 8h59m**, at 04:26:18. The developer state
report's "~460 min" is wrong too; measured elapsed is **538.9 min**.

The two silent windows have different mechanisms, which is why one fix would not have covered both:

- **01:37 → 04:26 (2h48m).** The director sat inside synchronous `Agent` dispatches, which produce no
  stop at all. The hooks that did fire were children's, and they return immediately after the
  registry write — before any liveness logic — so a live process holding the run at 03:54, with the
  phase two hours old, computed nothing.
- **04:26 → 10:36 (6h10m).** The director *did* stop; the controller saw two live children and
  blocked it back into its own turn to wait. That window was entered by the director's **own**
  `run_in_background` dispatch at 04:26:12 (§V1) — a claim the code did not enforce, sitting causally
  upstream of the wedge.

`state.stall` stayed `{signature: null, count: 0}` for nine hours: the detector never sampled once.
`recordStall` and `liveChildren` have exactly one call site each, both below every early return in
the director branch of the `SubagentStop` hook, and child-registry expiry is consulted only at a
director stop — so all three entries expiring changed nothing, as the run's own findings file already
recorded.

**The honest ceiling.** No plugin surface can cancel or interrupt an `Agent` call in flight (§S14),
and the settings allowlist a plugin may contribute is exactly `["agent", "subagentStatusLine"]`
(§S9). **Automatic recovery from a wedged synchronous dispatch is not achievable by any measured
mechanism in this repository.** What is achievable is detection plus a visible warning:
`subagentStatusLine` ticks every 5 s whenever any subagent is live (§S9) — through run 9b's wedge,
on the order of 4,400 ticks nobody was shown — and `state.updatedAt` is stamped by `saveState` on
every mutation, so staleness is derivable without anyone remembering to write a heartbeat, which is
the rule `progress.mjs` holds itself to. §S16 records the main thread stopping a stray agent with
`TaskStop` after 10 s: the stop capability exists once somebody is told. The missing link is
notification, not capability.

Two bounds on that. `statusline.mjs` did not exist in the build that ran run 9b, so nothing here is a
claim about a run it governed. And a clock-driven watchdog that *transitions* a run is the shape §S1
already removed and must not be reinstated — reporting is the sanctioned form.

### V9. Two sizings that measurement outgrew — **§T2 and §S26 stale**

§T2 sized cold restarts from run 7 — 9 windows, 0.62M tokens, **$6.14** — and capped the recoverable
part at "about $1.6". The same mechanism on run 9 is **17 windows and 1,469k tokens: $18.37** gross
at 1.25 × $10/M, against $1.47 had those turns hit cache; run 8 is 12 windows, 867k tokens, $10.84
against $0.87. §T2's *qualitative* conclusion is unchallenged and is precisely why the gross term is
not the recoverable one: the expiry is a harness property, so the addressable fractions are the
tier, the context carried across a window, and the number of windows crossed — 1 (run 3), 9 (run 7),
12 (run 8), 17 (run 9).

§S26 computed the stateless-director envelope from a **19,188-token prefix** and six restarts,
≈$3.4 gross. The measured mean rewrite at a cold turn on run 9 is **~86k tokens**, with the last ones
at 116–124k against 16k at dispatch. The envelope is larger than §S26 states, its two gates still
stand, and one of them — replaying recorded decision packets through fresh pinned directors before
committing to a trial — is now **runnable**, because run 9's directory was archived before any
reinstall (§S25).

### V10. What a dollar figure in this repository actually is — **§A4 does not cover the cache multipliers**

All 2,178 assistant rows across run 9's session and its 34 subagent transcripts carry
`usage.cache_creation`, whose only subfields are `ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens`; some requests are 100% 1-hour (`cache_creation_input_tokens: 52237`
against `ephemeral_1h_input_tokens: 52237`). Published pricing is **1.25× for a 5-minute write and
2× for a 1-hour one**; reads are 0.1× with no TTL split, so the read half of the code's assumption
is right as written. `transcript.mjs` reads only `cache_creation_input_tokens` and bills the
undifferentiated total at 1.25×, so 1-hour writes are **under**-billed — the one direction §K6 says a
cost figure must never fail in. The string `ephemeral` occurs nowhere in `scripts/` or `tests/`.

Size of the error, recomputed with the repository's own grouping: run 9 $91.4410 → **$91.5975**
(+0.171%), run 8 $51.3520 → **$51.5351** (+0.357%). 1-hour writes are 1.38% and 2.84% of cache-write
tokens and belonged entirely to Sonnet, the cheapest tier in play, in both runs. Nothing gates on the
figure; the only consumer is the $75 notice, whose crossing point moves by ~0.3%. Two things the
correction must not do: implement it as `5m × 1.25 + 1h × 2.0` — 30 rows in run 9 carry a
`cache_creation_input_tokens` **larger** than the sum of its two subfields, so that form silently
loses tokens, and a premium added to the existing base is the safe shape — and leave the memo key at
`v2:`, which would keep serving the pre-correction figure for exactly the two finished runs this
project quotes its economics from.

**The labelling matters more than the arithmetic.** These are subscription-billed sessions: **token
counts are measured; dollars are derived** at API list price. §A4 validated the per-token tiers from
the binary and says nothing about cache multipliers — those were asserted, in a document that called
them "the real multipliers".

Sonnet 5 carries an introductory price of **$2/$10 through 2026-08-31** against the $3/$15 list the
table uses. It is **deliberately not applied**, and the reason is worth recording so nobody
"corrects" it later: applying it moves run 9 to $85.99 and run 8 to $48.54, ~5.5% *down*, which is
the direction §K6 forbids and 15–30× the size of the tier error it would sit beside; and an
archived, digest-bound figure that reprices itself on 2026-09-01 is not a record.

### V11. Outstanding retractions — closed

This table listed the falsified claims the documentation pass could not itself edit. The
remediation that followed closed every row, and per this section's own rule — delete a row when
its claim is gone — the rows are gone: the director and all three ruleless coordinators now carry
the corrected backgrounding rule (with a count test over every dispatch-capable agent); the
`stop-controller.mjs` comment now reasons from `yielded`, not from a synchronous premise; every
unconditional-model-pin site (agents, skills, preflight, the state.mjs refusal string, config,
transcript, the regression docstring) states the §V2 precedence; and the `§P8` docstring carries
the per-request figures from §V4. The fail-open-on-unknown row (`directorTier()` returning
`ok: null` passing the PREFLIGHT guard while `unverifiable` never fails the completion gate) was
acted on rather than retracted: condition 13.12b now registers an unobserved tier in
`mustBeStated`, so silence owes a written residual-risk statement instead of passing for free.
What remains authoritative about each claim is its correction row: §V1, §V2, §V4.

### V12. The second adversarial pass — five of its findings reproduced, and what each fix became

A second external review of the first remediation round was itself verified the same way, and it
was substantially accurate: of its two criticals and four highs, all six reproduced (three by
direct reading of code the first round had written, three in sandboxes). Recorded because two of
them were defects *in the first round's own fixes* — the class CLAUDE.md warns about, introduced
while fixing the class CLAUDE.md warns about.

- **The eternal waiver.** The first round anchored the implementation-drift discharge to the
  review's timestamp, so one risk statement made after the review stayed valid through every
  later rewrite — reproduced end-to-end with the implementation replaced by broken code. Risks
  now carry the implementation digest they were stated about (`risk --add` stamps it), and the
  `review-implementation-N-current` discharge requires a statement about the *current* tree. A
  waiver is a claim about one state; the timestamp form let it be a claim about all future ones.
- **First-run phase pinning.** The first round rejected `state.phase === spec.phase` because run
  9's legitimate re-review ran from `DESIGN_LOCK` — and over-generalised the rejection to no
  phase rule at all, leaving a mandatory round runnable from `PREFLIGHT` whose file later
  satisfies a gate it never ran in (reproduced). The rule now: a round's **first** execution must
  happen in its declared phase; a replay or `*-extra` may run anywhere in the artefact's segment
  (round-1 phase through its lock), which is where a gate can legitimately order one. Derived
  from the phase tables, not declared.
- **`core.quotePath`.** Every consumer that newline-split git path output received C-quoted
  names for non-ASCII paths — `café.mjs` — so the review pack shipped a "could not be read"
  placeholder instead of the feature's bytes with nothing failing, and the workspace baseline
  stored the quoted name with fingerprint `absent`, which the scope check later matched and used
  to classify a changed file as pre-existing. All path-identity sites now use `-z`
  (NUL-delimited, never quoted): the pack's untracked list, the baseline, `changedFiles`, and
  `gitSnapshot`'s `hash-object --stdin-paths`.
- **Failed replays reset the cap.** Replay detection read only the canonical review file; the
  archive-on-rerun fix moved the completed attempt aside, so a failed replay left a `failed`
  record canonical and the next success counted as a free first run — failure→success cycles
  walked around the §18 allowance. Replay is now "a completed attempt ever existed", archives
  included; failed attempts also count into `codexInvocations` (they spent real quota).
- **Non-string ids.** The first round's `requireSafeId` returned every non-string unchecked, and
  the parser represents a valueless `--session` as boolean `true` — so `--session` with no value
  minted a run owned by session `true`, and a valueless `--run` fell through to the
  bound-or-newest fallback and mutated a *different* run while exiting 0. Non-strings are now
  refused (undefined/null pass through to the callers' own missing-flag handling), and an
  explicit-but-unusable flag is never reinterpreted as "not given".
- **Acceptance evidence.** "Latest report must be success" skipped itself when every listed
  report file was unreadable; `--override-reason ""` satisfied the string check; and the error
  message promised the override reached telemetry while the event carried only `note`. All three
  closed: unreadable evidence refuses, the reason needs ten characters, the event carries it.

Two of the second pass's findings were policy, not defects, and stay open as owner decisions,
recorded here so nobody mistakes silence for closure: whether spend/duration should gain a
resumable pause (the ledger's own data says the shipped $75 notice would have fired at transition
18 of 19 on the only run that crossed it — any pause needs a threshold calibrated to be useful),
and whether a post-BRAINSTORMING `ask` should be refused rather than warned-and-recorded. One
residual mechanical window is accepted and documented, and its shape was revised by a further
audit: consuming `replaceable` at PreToolUse — tried first — spent the one authorisation on
dispatches that never started, since PreToolUse precedes permission handling and execution; a
refused or failed dispatch then left a wedge with no recovery instruction (the Stop hook's
`yielded !== true` branch allows silently). Reverted: the reservation is committed only by the
director `SubagentStart`/`SubagentStop` id write, i.e. when the replacement demonstrably exists,
so failed dispatches retry freely. The accepted residue: between a `SendMessage` revival (which
no hook can see) and that director's next stop, duplicate director dispatches are not denied;
bounded by the double-disobedience required, the depth guard, and the id-flip detection. Closing
it fully needs a measured `SendMessage` PreToolUse payload, which no ledger row yet provides.

The §V5/§V7 dollar figures above were computed with the pre-§V10 cache arithmetic (uniform 1.25×
writes); the corrected basis moves each by well under half a percent (§V10) and changes no
conclusion drawn from them.

### V13. The third adversarial pass — four more findings survived verification, one revert among the fixes

A third external audit of the staged tree. Its two H-findings against this section's own previous
fixes both held; two more were environmental facts nobody had validated. What shipped:

- **The `replaceable` consumption reverted** — recorded in §V12's revised text. PreToolUse
  precedes permission handling and execution, so consuming there spent the one replacement
  authorisation on dispatches that never started, and the Stop hook's `yielded !== true` branch
  then allowed silently: a wedge with no recovery instruction. Commitment moved to the event that
  proves a replacement exists (the director SubagentStart/Stop id write); failed dispatches retry
  freely; the SendMessage-revival residue stands as §V12 records it.
- **The newest referenced report is authoritative.** Acceptance sorted the *readable* reports, so
  a missing or corrupt attempt 2 quietly reinstated attempt 1's old success — acceptance got
  easier the more evidence had been lost. Resolved from the id list now, and refused when that
  file cannot be read. Completion also re-verifies each accepted package's newest report at the
  gate and binds every stored report file into the completion digest — deleting a report after
  acceptance invalidated nothing before this, reproduced.
- **Compatibility floor and delegation depth.** `MIN_CLAUDE_CODE` was 2.1.0, a range nobody had
  validated: every ledger measurement is from the 2.1.219/2.1.220 generation, and older versions
  in the advertised range could not run the three-level delegation tree at all. Floor raised to
  2.1.220. Preflight also fails on an inherited `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` below 3 —
  the exact value (=2) older Hyperpowers setup wrote into projects, at which §S3 T25 measured the
  Agent tool removed from the coordinator level, so preflight had said "ready" about an
  environment the first EXECUTION dispatch would die in.
- **`codexInvocations` counts invocations again.** A declined retry (half-pack lost mandatory
  context) pushed a synthetic attempt that the counter then billed as a launch; synthetic entries
  are marked `skipped` and excluded, on both the success and failure accounting paths.
- **Self-location survives a spaced path.** `new URL(...).pathname` percent-encodes, so an
  install under a directory with a space resolved to `%20` and the manifest check failed —
  defeating self-location exactly where it was needed. `fileURLToPath` everywhere; verified
  against a copied tree under a spaced directory.
- **Documentation reconciled**: cost-model no longer describes the pre-§V10 accounting as
  current; the director prompt no longer claims a waiting stop spends no continuation (it spends
  one — that is the whole argument for one long bounded wait); README claims one director
  *authority* rather than one uninterrupted dispatch. One validation nuance recorded for release
  reports: marketplace strict validation passes; explicit `plugin.json` strict validation carries
  the one documented warning about the root `CLAUDE.md` (contributor doc, intentionally not
  shipped as plugin context — its own header says so).

### V14. The agent panel, read from the binary — **§S9's rendering contract corrected in three claims**

§S9 shipped a progress bar from a probe of the payload. It never read the *rendering* side, and
three of its statements about it were wrong or incomplete. Read from the bundled JS in 2.1.220
(`$qf`, `$PS`/`BHe`, `RX`, `T8f`, `Ac`/`s4u`, `MO`), with the plugin's own live run directories as
the empirical check on the meta files.

**Correction 1 — `content` does not replace the whole row.** It replaces everything right of the
gutter. The decorated branch of `$qf` keeps `KDn` (pointer, tree connector, status glyph) in a
fixed-width box and puts `content` in `flexGrow:1,width:0` with `wrap:"truncate"`:

```js
Mvt = jsx(k,{width:YDn, flexShrink:0, children:KDn})
Hjt = jsx(Ac,{children:HQa.content})
Nvt = jsx(k,{flexGrow:1,width:0,children:jsx(h,{dimColor:AX,bold:n5,wrap:"truncate",children:Hjt})})
```

What it *does* displace is `descendantSuffix` — the harness's own `(+N)` count of an agent's
descendants. **So decorating the director deleted the only native signal that the run had
coordinators and implementers working underneath it.** That is not a cosmetic loss, because of:

**Correction 2 — the panel draws only roots.** `$PS` keeps a task only when it has no *live
registered* parent:

```js
function BHe(e,t){ if(t.type==="in_process_teammate"||!t.parentAgentId)return;
                   let r=e[t.parentAgentId]; return Lj(r)&&r.evictAfter!==0?t.parentAgentId:void 0 }
```

With nothing drilled into, a depth-2 coordinator whose director is alive is filtered out. Drilling
in (`viewingAgentTaskId`) admits exactly the viewed agent's children, its siblings and its ancestor
chain — not the whole subtree. So **level 2 and level 3 can never be top-level rows while the
director lives**, and the `(+N)` we overwrite was the only thing that said they existed.

**Correction 3 — the payload carries every depth, but not the fields that would tell you so.**
There is one task store; `createSubagentContext` hands a child the parent's registry object
(`taskRegistry:e.taskRegistry`), and the tick's filter has no depth predicate
(`Rel(e)=Object.values(e).filter((t)=>Lj(t)&&t.evictAfter!==0)`). A nested dispatch therefore does
appear in `tasks`. But `T8f` serialises only
`id,name,type,status,description,label,startTime,model,effort,contextWindowSize,tokenCount,tokenSamples,cwd`
— **no `spawnDepth`, no `parentAgentId`**. Liveness is the payload's to give; parentage has to come
from `subagents/agent-<id>.meta.json`, which carries both and is written at dispatch (§S4 T28,
re-verified against six metas of a real run spanning depths 1, 2 and 3).

That pair is the whole design of the roster: **liveness from the payload, parentage from disk.** A
directory walk cannot substitute — `subagents/` is never pruned, so it reports a finished run's
agents as busy.

**ANSI: resolved, and §S9's "left unverified" is closed.** `content` goes to `Ac`, an ANSI-parsing
component, not a raw `<Text>`: `s4u` feeds it through a parser and `bd_`/`a4u` map runs onto Ink
props — named 8/16, `ansi256(N)`, `rgb(r,g,b)`, foreground and background, bold, dim, italic,
underline, strikethrough, inverse, OSC-8 hyperlinks. Two consequences: **Ink decides whether the
terminal gets colour**, so no capability detection belongs in a renderer; and the wrapping
`<Text dimColor={AX}>` (`AX = !selected && !viewed`) means *uncoloured* text renders dim — which is
what every undecorated row already looks like, so uncoloured metadata is the consistent choice and
colour is worth spending only on state.

**`NO_COLOR` is a real knob, not an inert one.** The child environment is `{...MO(), ...KDt(...),
CLAUDE_PROJECT_DIR:...}`, and `MO()` returns `process.env` (or a copy with credentials and OTEL
variables deleted). The user's environment reaches the renderer.

**Four operational facts that change how a renderer must be written.**

| Fact | Code | Consequence |
| --- | --- | --- |
| A non-zero exit discards **every** decoration that tick | `if(f.code!==0)return{}` | one bad row blanks all of them; never exit non-zero |
| The schema is exactly `{id, content}`, non-strict | `E.object({id:E.string(),content:E.string()})` | extra keys (`color`, `icon`) parse and are silently dropped — there is no second channel |
| `content:""` **removes** the row | `$PS(...).filter((u)=>t[u.id]?.content!=="")` | to say nothing about a row, omit its id; an empty string is not silence |
| `columns` is `max(0, terminal - $He())` | `T8f(m, Math.max(0,i-$He()), ...)` | already gutter-adjusted for a **root** row; a nested row's gutter is `$He()+width(treeConnector)`, which `columns` does not know |

**Not plugin-influenceable:** the `◯`/`⏺` glyph (`Tqf=n5?Za:qe.circle` — the filled one means
"drilled into", not "busy"), its colour (`cZa(status)`: green completed, red failed/killed,
undefined while running), and the selection pointer. There is no spinner on these rows.

**Multi-line `content` renders as multiple terminal rows and must not be used.** Yoga's text
measure splits on `\n` and returns a line count as height, and `wrap:"truncate"` truncates by
visible width without touching newlines — so it does not corrupt the frame. But lines 2..N get no
gutter, so a hand-drawn tree lands misaligned against the panel's own connectors, and the scroll
window slices *tasks* rather than lines. One line per row.

**What shipped against all of this.** A roster of the director's live descendants, by relative
depth, folded (`↳ execution › 2×implementer test`) — levels rather than parents, because
attributing a grandchild to one of two live coordinators needs a path the walk does not carry, and
a guessed parentage is a confident wrong claim on the surface a human trusts to tell them the run is
alive. Rows for agents that are *not* descendants of the run's director are no longer decorated at
all: a live run does not make every agent in the session ours, and `HP·…` was being stamped on other
people's. Colour marks state only — bar and percent tinted by phase (cyan working, yellow idle, red
terminal failure, green `COMPLETE`), the idle warning bold yellow, worker context pressure yellow at
80% and red at 95%.

**And one defect this found in the shipped bar.** The idle warning added in §V8's wake is ~57
characters; `directorRow` sized the bar from whatever was left and `bar()` draws nothing below 8
columns — so **on a 120-column terminal the bar disappeared exactly when the run was in trouble**.
Widths are now fitted explicitly: cells carry a drop rank, the fitter tries full text, then short
forms, then sheds the highest rank one at a time, and the bar is reserved its minimum before any of
it — so no cell is dropped while the bar can merely narrow. Measured across 200/116/76/56/40
columns with the warning present — **against the test fixture, not a live run**: the rendering side
of §V14 is read from the binary and exercised by driving the real script on a synthetic payload, and
no run has yet been watched with the roster on screen. The bar and the warning survive all five
widths, and the roster is what pays. The warning outranks the phase name deliberately — at 40
columns the other order rendered `63%  EXECUTION` and dropped the one cell a human can act on.

Colour is applied **after** fitting, because SGR bytes count in `String.length` and not on screen;
the test asserts both that the row is really coloured and that its visible width fits, since
"everything was dropped" would satisfy a width bound on its own.

**One guard that was missing here and exists everywhere else.** The status line identified the
director by name alone, so §S13's depth-3 impostor would have taken the run's progress bar — and,
now, rooted the roster on an agent with no descendants. `isDirectorMeta()` in `config.mjs` is the
one spelling of *name and depth 1*, used by `subagent-controller.mjs` and `statusline.mjs`, which is
§U's "count the sites" applied before the second site could drift.
