# ADR-0002 — Own the Codex invocation instead of typing the slash command

**Status:** accepted · **Date:** 2026-07-26

## Context

Spec §8 requires six adversarial reviews with a specific model and effort per round. The
obvious implementation is to invoke `/codex:adversarial-review` from the official Codex plugin.

Reading the installed command file (`codex@openai-codex` 1.0.0) confirms three blockers:

1. `disable-model-invocation: true` — verified in the binary as enforced
   (`Skill … cannot be used with … tool due to disable-model-invocation`). Claude cannot invoke
   it from a workflow at all.
2. It selects its target from the Git working tree or a branch diff. It cannot review a design
   or plan document that is not part of the diff — and Hyperpowers deliberately keeps its
   artefacts *out* of the working tree (spec §20).
3. It asks the user via `AskUserQuestion` whether to run in foreground or background, which is
   forbidden after intake.

## Decision

Ship `scripts/codex-adversary.mjs`, calling `codex exec` directly.

**And do not declare `codex@openai-codex` as a plugin dependency**, which is the question this
decision implies and did not answer. Three facts settle it. The plugin does not provide the CLI —
its manifest declares only `name`, `description` and `author`, and its `/codex:setup` command
*asks the user* whether to run `npm install -g @openai/codex`. Its commands are unusable to us for
the three reasons above. And a declared dependency is a **silent load gate**: ledger J2 measured
that without it Hyperpowers does not load at all — `/hyperpowers:status` answers "Unknown command",
no agents appear, and nothing says why. Declaring it would trade no benefit for an unexplained
absence in the setup most likely to hit it: a user who has the CLI but not the plugin.

Superpowers is the opposite case, and the contrast is the point: its skills are genuinely loaded
and overlaid at runtime, so the dependency is real and the load gate is the behaviour we want.

Preflight names the plugin as a convenience for installing the CLI, because "install the Codex CLI"
is true and unhelpful when a guided installer exists.

Kept from `adversarial-review`: the framing (break confidence, don't validate), read-only
operation, structured findings, the reviewer/implementer separation, Sol and Luna, foreground
execution, and a finding bar that rejects style commentary.

Owned by Hyperpowers: the exact document reviewed, the model, the effort, the sandbox, the
timeout, output validation, review-pack size, retries and the fallback policy.

The invocation:

```
codex exec --model <model> -c model_reasoning_effort='"<effort>"' \
           --sandbox read-only --ignore-user-config --skip-git-repo-check \
           -C <projectRoot> --output-schema <schema> -o <last-message> --color never
```

## What measurement changed

Three flags the spec did not anticipate materially improved the design:

- **`--ignore-user-config`** makes spec §8.4 moot. The spec worried at length about mutating
  `.codex/config.toml` between rounds, project trust levels, and proving which effort was
  actually used. This flag bypasses the user's config entirely, so none of that applies. The
  local machine's config sets `gpt-5.6-luna` at `xhigh`; without this flag every review would
  silently inherit it.
- **`--output-schema`** enforces the finding shape rather than requesting it. A live run
  returned schema-conforming JSON on the first attempt, including `coverage_notes` correctly
  reporting that the repository was empty.
- **`-o <file>`** removes stdout scraping. Success is judged by that file existing, parsing, and
  validating — not by the exit code, because a run can exit 0 with a non-conforming message.

Failure modes were measured, not assumed: an unavailable model exits 1 and writes **no** output
file, with `ERROR: {...}` on the stream. That is what the `model_unavailable` classifier keys on
to trigger the Sol → Luna fallback.

## Consequences

Reviews are reproducible and their provenance is provable. Hyperpowers does not depend on the
Codex plugin's UX decisions, and the review pack is bounded so the "long review that never
returns" failure (spec §23 Risk 5) has a real mitigation.

The cost is a second implementation of something the Codex plugin also does. That is accepted:
the plugin's version cannot be invoked by a model, cannot target a document, and cannot be told
what effort to use — three requirements out of three.

Re-evaluate if the Codex plugin gains a model-invocable, document-targeted, effort-honouring
entry point.
