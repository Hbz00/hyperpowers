---
name: status
description: Show the state, progress, evidence and cost of the current or a past Hyperpowers run
argument-hint: "[--run <id>]"
model: inherit
---

# Hyperpowers status

Report on a run without disturbing it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-machine.mjs" show
node "${CLAUDE_PLUGIN_ROOT}/scripts/adjudication-ledger.mjs" status
```

Add `--run <id>` for a specific run. `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" --list`
enumerates every run for this project.

## What to tell the user

Lead with the answer to "where is it and is it healthy?", then the detail:

1. **Phase**, its owner, and what is blocking the exit (`exitRequirements.unmet` is the direct
   answer to "why is it still here?").
2. **Progress** — work packages accepted versus total, findings adjudicated versus raised.
3. **Reviews** — which of the six rounds have run, their verdicts, open blockers.
4. **Evidence** — how many acceptance criteria are proven.
5. **Cost and distribution** — measured from the session transcript, not estimated.
6. **Anything wrong** — stall count, policy violations, model mismatches, recorded fallbacks,
   Git drift.

Present the work distribution as an observation. The 1–3–9 shape is directional; a run outside
those bands that produced a correct feature is a good run, and saying otherwise would be
misleading.

If the run is `SUSPENDED`, say plainly that it is resumable and how. If it is `BLOCKED`, lead
with why — that is the only thing the user needs.

Do not modify state, transition phases, or resume anything from this skill.
