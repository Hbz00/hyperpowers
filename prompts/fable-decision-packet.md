# Decision packet template (spec §6.3)

Opus sends this to Fable and nothing else — no research notes, no raw logs, no reviewer output.
Target size: 500–1000 tokens. If it does not fit, the decision is not yet clear enough to ask.

```text
DECISION PACKET — run <RUN_ID>, phase <PHASE>

Decision required:
<One sentence. A question Fable can answer with a verdict.>

Why now:
<Two or three sentences. What is blocked until this is decided.>

Options:
<At most three. Each: one line of what it is, one line of what it costs.>

Opus recommendation:
<One option, named. Say why in one sentence.>

Evidence:
<Paths and identifiers only. No logs, no diffs, no quotes longer than a line.>

Risk if this is decided wrongly:
<One or two sentences. Be concrete about what breaks and how expensive it is to undo.>

Expected response:
APPROVE | REDIRECT | REQUEST_EVIDENCE
```

## Rules

- Escalate only what genuinely needs product authority: intent, scope, irreversible trade-offs,
  contested critical findings, significant residual risk (spec §9).
- Never escalate a local technical choice. Opus decides those; that is the point of the tier.
- Never send more than three options. More than three means the analysis is not finished.
- `REQUEST_EVIDENCE` is a real answer — if Fable uses it, supply exactly what was asked for and
  nothing more.
