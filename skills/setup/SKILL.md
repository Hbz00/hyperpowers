---
name: setup
description: Configure a project for Hyperpowers — writes the required environment contract into .claude/settings.json
model: inherit
---

# Hyperpowers setup

Run this once per project, before the first `/hyperpowers:feature`.

## Why it is necessary

Hyperpowers cannot configure itself. A plugin manifest may contribute a small allowlist of
settings, and `env` is not among them (measured — `docs/validation-ledger.md` §G4). The runtime
contract therefore has to live in the project's own `.claude/settings.json`.

Claude Code reloads most settings without a restart, but does not document whether `env` is
among them — so this skill does not guess. It reports `restartRequired` by checking whether the
variables are live in the running process, and preflight applies the same test before a run
starts. If it says a restart is needed, it measured that; if it does not, none is needed.

## Do it

Dry run first — it changes nothing and prints the exact diff:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
```

Show the user what will change and why, then apply:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --apply
```

Existing settings are preserved and backed up. Use `--scope local` to write
`.claude/settings.local.json` instead when the project's settings file is checked in and shared.

## What it configures, and why each one matters

| Key | Value | Why |
| --- | --- | --- |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | `2` | Caps delegation at Fable → Opus → Sonnet. The harness default is 3, so this genuinely tightens it, and makes deeper spawning a hard error rather than a request the model can talk past. |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | `200` | A whole feature runs inside one turn, so the consecutive-block cap must cover the run. The default of 8 would truncate almost immediately. |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` | `1` | Hyperpowers has its own escalation ladder; a second advisor would arbitrate outside the ledger. **This one applies to every session in the project, not only to Hyperpowers runs** — tell the user, and drop this key if they would rather keep the advisor. |
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | `1` | Removes the built-in commit and PR guidance, which contradicts the read-only Git policy. |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | `1` | Workflow orchestration would run outside the state machine and outside its accounting. |
| `disableWorkflows` | `true` | The documented settings-level equivalent. |
| `includeGitInstructions` | `false` | The documented settings-level equivalent of the Git-instructions variable. |

## After the restart

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"
```

Preflight verifies the contract is actually in force — it reads the variables from its own
process rather than trusting that setup ran — and also checks Superpowers' version, the Codex
CLI, its credentials, the availability of the review models, the Git workspace, and whether the
project has any detectable verification commands.

If preflight still reports the environment as unmet after a restart, the most likely causes are:
settings written to the wrong scope for how this project is opened, or a managed settings policy
overriding them. Report what preflight says rather than guessing.

Optional per-project tuning (budgets, timeouts, concurrency, verification commands) goes in
`.hyperpowers.json` at the project root — see `scripts/lib/config.mjs` for the defaults.
