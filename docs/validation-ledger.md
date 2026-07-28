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

**The two most expensive agents are the two longest-lived.** The director cost **$20.36** for 9.4%
of the output at a 243:1 read-to-output ratio — the price of holding four hours in one turn — and
the execution coordinator **$17.02** across 92 turns, which is *more than all six implementers
combined* ($12.05). The orchestrator outspent the work it orchestrated.

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
batching moved — a little. That is the real economy: 47 calls spread over 40 turns is 40 whole
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

---

## I. Accepted without independent verification

| Claim | Spec ref | Why accepted / mitigation |
| --- | --- | --- |
| `allowedAgentTypes` is ignored for nested subagents | §4.4 | Not verified. Mitigated exactly as the spec argues: Sonnet agents have no `Agent` tool (enforced by `tools:`, C1 caps depth anyway), all Git mutation is hook-blocked, and the ledger records every agent actually launched. Treated as telemetry, not a security boundary. |
| CursorBench 3.2 score deltas | §7.2 | Unfalsifiable from here. The *economic* conclusion is independently recomputed in `docs/cost-model.md` from the harness's own pricing tiers (A4). |
