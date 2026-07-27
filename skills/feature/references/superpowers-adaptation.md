# Superpowers overrides

Hyperpowers uses Superpowers as its method. Superpowers assumes a **human partner in the loop**
at several points; Hyperpowers replaces that human with adversarial review plus a machine gate.
Those points are enumerated here because leaving them implicit is how an autonomous run
deadlocks waiting for an approval nobody will give.

Verified against Superpowers **6.2.0** by reading the installed skills. Preflight refuses to run
against a major version Hyperpowers has not been validated with, because these overrides are
written against specific instructions that could change.

## `superpowers:brainstorming`

| Superpowers says | Hyperpowers does instead | Why |
| --- | --- | --- |
| `<HARD-GATE>`: present a design and get **user approval** before any implementation | The `DESIGN_LOCK` gate: two Codex rounds, full adjudication, no open blocker, then the director's verdict | The gate still exists — it is no longer human. This is the substitution the whole architecture rests on. |
| Step 6: write the design doc **and commit** | Write it to the run directory; never commit | Git is read-only (spec §14). The run directory also keeps orchestration out of the diff Codex reviews (spec §20). |
| Step 8: **user reviews the written spec** | Codex rounds 1–2 review it adversarially | An independent contradictor with clean context finds more than a tired human skimming a document. |
| Ask questions **one at a time** across messages | Batch questions through `AskUserQuestion` inside one turn | Multi-message dialogue ends the turn, which clears the director's model pin (ledger B1). This is a hard harness constraint, not a preference. |

Everything else in the skill is kept: explore context first, propose alternatives with
trade-offs, scale the design to the problem, self-review for placeholders and contradictions.

## `superpowers:writing-plans`

| Superpowers says | Hyperpowers does instead | Why |
| --- | --- | --- |
| "DRY. YAGNI. TDD. **Frequent commits.**" and a `Commit` step per task | Drop every commit step; evidence replaces commits as the unit of progress | Git is read-only. A plan containing steps that cannot execute is a plan that will be half-followed. |
| Assumes an isolated worktree exists | No worktree; explicit file ownership per work package | Worktrees are forbidden (spec §2), so concurrency safety comes from disjoint `owned_files` instead (spec §15). |

Added on top: every task maps to an acceptance criterion id, states its owned files, carries a
verification command that could actually fail, and declares its dependencies. The plan gate
checks all of this mechanically.

## `superpowers:executing-plans`

| Superpowers says | Hyperpowers does instead | Why |
| --- | --- | --- |
| Step 1: create or verify a worktree via `using-git-worktrees` | Skip entirely | Worktrees forbidden. |
| "If subagents are available, use `subagent-driven-development` **instead** of this skill" | Explicitly overridden — keep using `executing-plans` | Spec §2 excludes that workflow. Hyperpowers already has its own dispatch, ownership and reporting discipline; layering a second orchestration model on top would produce two competing loops. |
| Step 3: finish via `finishing-a-development-branch` | `SYSTEM_VERIFICATION` → Codex 5 → remediation → Codex 6 → `FINAL_ACCEPTANCE` | That skill's job is integrating a branch, which is a Git mutation and out of scope. |
| "Ask for clarification rather than guessing" when blocked | Resolve locally (Opus) or escalate by tier; user questions are unavailable after brainstorming | Autonomy is the point. A genuine dead end becomes `BLOCKED`, which is an honest terminal state, not a silent failure. |

Kept: review the plan critically before starting, follow steps exactly, run the stated
verification, do not force through blockers.

## Skills Hyperpowers does not use

- `using-git-worktrees` — forbidden.
- `finishing-a-development-branch` — Git mutation.
- `subagent-driven-development` — excluded by spec §2.

## Skills that remain useful as-is

`test-driven-development`, `systematic-debugging`, `verification-before-completion`,
`requesting-code-review` and `receiving-code-review` are all compatible and worth invoking
inside the relevant phases. `receiving-code-review` in particular pairs well with adjudication:
it exists precisely to prevent performative agreement with a reviewer.
