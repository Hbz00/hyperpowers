<!--
Reference shape of final-report.md.

The real report is GENERATED from recorded facts by `scripts/report.mjs final`, not written
from memory. That is deliberate: a report composed by the agent that did the work will be
accurate about what it remembers and silent about what it forgot. Generating it from the
state, the reviews, the adjudication ledger, the evidence matrix and the measured transcript
usage means it cannot flatter the run by omission.

Use this file to understand the shape. Do not hand-write reports in this format.
-->

# Hyperpowers run report — <run-id>

**Outcome:** COMPLETE | BLOCKED | BUDGET_EXCEEDED | POLICY_VIOLATION | ABORTED
**Started / Finished / Duration**

## What was asked for
The user's request, verbatim.

## Acceptance criteria
A row per criterion: id, statement, status, and the concrete evidence. Criteria that are not
`satisfied` are named explicitly rather than averaged away.

## Verification
Every suite-level check with its command and result, plus any residue found (TODOs,
placeholders, mocks, out-of-scope files).

## Adversarial reviews
All six rounds with model, effort, verdict, finding counts, and how many were accepted versus
rejected. A round that did not run shows as **not run** — never as absent.

## Open blockers
Accepted blocking findings that were never proven resolved. If this section has entries, the
run cannot be COMPLETE.

## Residual risks and what was not verified
Including every criterion marked `unverifiable`. "None recorded" on a non-trivial feature
should be read as a warning, not a reassurance.

## Process
Phases, work packages, retries, agents launched, Codex invocations, model fallbacks, and any
Git drift detected during the run.

## Cost and work distribution
Measured from the session transcript — per-model token usage including subagents — not
estimated. The 1–3–9 reference bands are shown as an observation; nothing gates on them.

## Artefacts
Absolute paths to the request, design, plan, tasks, evidence, reviews and state.
