/**
 * The Hyperpowers state machine (spec §11, §12).
 *
 * This module is the single source of truth. The Stop controller, the status skill, the
 * completion verifier and the feature skill all read the same table, so there is exactly one
 * place where "what happens next" is defined.
 *
 * Two deliberate departures from spec §11, both forced by measured harness behaviour:
 *
 *  1. `WAITING_FOR_USER` is removed as a mid-run state. Ledger B1/B2 show a skill's `model:`
 *     pin is cleared when the user sends a new message but survives Stop-hook continuations.
 *     A mid-run stop-and-wait would therefore silently demote Fable to the session default
 *     model. All user interaction happens inside the opening turn via `AskUserQuestion`,
 *     which is a tool call and does not end the turn. See ADR-0001.
 *
 *  2. `SUSPENDED` is added. The harness caps consecutive Stop-hook blocks (ledger D4). Rather
 *     than being cut off mid-flight when the cap is reached, the controller voluntarily
 *     yields just below it and records a resumable state.
 */

export const TERMINAL_PHASES = Object.freeze([
  'COMPLETE',
  'BLOCKED',
  'ABORTED',
  'BUDGET_EXCEEDED',
  'POLICY_VIOLATION',
]);

/** Phases where the turn may end without the run having failed. */
export const STOP_ALLOWED_PHASES = Object.freeze([...TERMINAL_PHASES, 'SUSPENDED']);

/**
 * `requires` lists artefact keys (from `paths.artifacts`) that must exist and be non-empty
 * before the phase may be exited. They are the "preuve de transition" of spec §11 — a gate
 * that cannot be satisfied by an agent merely asserting it is done.
 */
export const PHASES = Object.freeze({
  PREFLIGHT: {
    owner: 'system',
    summary: 'Verify the environment contract before any model work.',
    successors: ['INTAKE', 'BLOCKED'],
    requires: [],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --run <RUN_ID>`. ' +
      'If it exits non-zero, transition to BLOCKED with its report as the reason. ' +
      'Never continue past a failed preflight and never substitute a different model.',
  },

  INTAKE: {
    owner: 'fable',
    summary: 'Record the raw user request, expected outcome, constraints and exclusions.',
    successors: ['BRAINSTORMING', 'ABORTED', 'BLOCKED'],
    requires: ['request'],
    next:
      'Write `request.md` capturing intent, expected outcome, stated constraints, explicit ' +
      'exclusions and initial context (spec §10.1), then transition to BRAINSTORMING.',
  },

  BRAINSTORMING: {
    owner: 'fable',
    summary:
      'The only interactive phase. Clarify the need with AskUserQuestion inside this turn, ' +
      'delegating exploration to Sonnet.',
    successors: ['DESIGN_DRAFT', 'ABORTED', 'BLOCKED'],
    requires: ['brainstorm'],
    next:
      'Continue `superpowers:brainstorming` under the Hyperpowers overrides. Use ' +
      '`AskUserQuestion` for every user-facing question — it is a tool call and keeps the ' +
      'turn (and the Fable model pin) alive. Delegate repository exploration to ' +
      '`hyperpowers:sonnet-researcher`. When the need is consolidated, write ' +
      '`brainstorm-summary.md` and transition to DESIGN_DRAFT. From that point on, no user ' +
      'validation may be requested.',
  },

  DESIGN_DRAFT: {
    owner: 'opus',
    summary: 'Opus consolidates research and produces the design plus acceptance criteria.',
    successors: ['DESIGN_REVIEW_1', 'BLOCKED'],
    requires: ['design'],
    next:
      'Delegate to `hyperpowers:opus-design-coordinator` with the brief from ' +
      '`brainstorm-summary.md`. It must produce `design.md` containing numbered acceptance ' +
      'criteria, the data model, interfaces, failure modes, risks and explicit non-goals. ' +
      'Then transition to DESIGN_REVIEW_1.',
  },

  DESIGN_REVIEW_1: {
    owner: 'codex',
    summary: 'Codex round 1 — general adversarial review of the design (Sol, high).',
    successors: ['DESIGN_REMEDIATION', 'BLOCKED'],
    requires: ['review:design-1'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> ' +
      '--round design-1`. Do not paraphrase or pre-filter the findings. Then transition to ' +
      'DESIGN_REMEDIATION.',
  },

  DESIGN_REMEDIATION: {
    owner: 'opus',
    summary: 'Opus adjudicates every round-1 finding and applies accepted corrections.',
    successors: ['DESIGN_REVIEW_2', 'BLOCKED'],
    requires: ['adjudicated:design-1'],
    next:
      'Delegate to `hyperpowers:opus-review-adjudicator`. Every finding needs a decision from ' +
      'the spec §9 vocabulary with a rationale; accepted findings must be applied to ' +
      '`design.md`. Escalate to Fable only for product intent or structurally irreversible ' +
      'trade-offs. Then transition to DESIGN_REVIEW_2.',
  },

  DESIGN_REVIEW_2: {
    owner: 'codex',
    summary: 'Codex round 2 — targeted verification of the corrections (Luna, xhigh).',
    // Back to remediation when round 2 raises a *new* blocker. That is the §18 case, and
    // without this edge its circuit breaker was unreachable: `design-extra` is hosted in
    // DESIGN_REMEDIATION, which was not a successor of the only phase that can discover the need
    // for it. The run's sole route was DESIGN_LOCK → DESIGN_DRAFT — a full redesign plus both
    // mandatory rounds again, which is more expensive than the bounded extra review §18 exists to
    // substitute for. A breaker that costs more than the fault is not a breaker.
    successors: ['DESIGN_LOCK', 'DESIGN_REMEDIATION', 'BLOCKED'],
    requires: ['review:design-2'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> ' +
      '--round design-2`. The reviewer receives the corrected design, the round-1 findings ' +
      'and the adjudication record, and must verify each accepted correction landed, that ' +
      'rejections were justified, and that no regression was introduced. Then transition to ' +
      'DESIGN_LOCK.',
  },

  DESIGN_LOCK: {
    owner: 'fable',
    summary: 'Fable gate: APPROVE_DESIGN or REDIRECT_DESIGN on a bounded decision packet.',
    successors: ['PLAN_DRAFT', 'DESIGN_DRAFT', 'BLOCKED'],
    requires: ['gate:design'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-completion.mjs" --run <RUN_ID> ' +
      '--gate design` to confirm no accepted blocker is open. Read the decision packet only ' +
      '— not the raw reviews — and answer APPROVE_DESIGN or REDIRECT_DESIGN. On approval ' +
      'transition to PLAN_DRAFT; on redirect, back to DESIGN_DRAFT with an explicit ' +
      'direction change.',
  },

  PLAN_DRAFT: {
    owner: 'opus',
    summary: 'Opus turns the locked design into a plan and then into Sonnet work packages.',
    successors: ['PLAN_REVIEW_1', 'BLOCKED'],
    requires: ['plan', 'tasks'],
    next:
      'Delegate to `hyperpowers:opus-plan-coordinator`. It applies `superpowers:writing-plans` ' +
      'with the permanent Hyperpowers overlay (spec §12 phase 3), writes `plan.md`, and ' +
      'emits `tasks.json` — one eight-part delegation contract per task (spec §3.2), each ' +
      'mapped to an acceptance criterion, with file ownership and dependencies. Then ' +
      'transition to PLAN_REVIEW_1.',
  },

  PLAN_REVIEW_1: {
    owner: 'codex',
    summary: 'Codex round 3 — general adversarial review of the plan (Luna, xhigh).',
    successors: ['PLAN_REMEDIATION', 'BLOCKED'],
    requires: ['review:plan-1'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> ' +
      '--round plan-1`, then transition to PLAN_REMEDIATION.',
  },

  PLAN_REMEDIATION: {
    owner: 'opus',
    summary: 'Opus adjudicates plan findings and corrects the plan and work packages.',
    successors: ['PLAN_REVIEW_2', 'BLOCKED'],
    requires: ['adjudicated:plan-1'],
    next:
      'Delegate to `hyperpowers:opus-review-adjudicator` for `plan-1`, apply accepted ' +
      'corrections to `plan.md` and `tasks.json`, then transition to PLAN_REVIEW_2.',
  },

  PLAN_REVIEW_2: {
    owner: 'codex',
    summary: 'Codex round 4 — targeted verification of the plan corrections (Luna, xhigh).',
    // See DESIGN_REVIEW_2: this edge is what makes the §18 extra round reachable.
    successors: ['PLAN_LOCK', 'PLAN_REMEDIATION', 'BLOCKED'],
    requires: ['review:plan-2'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> ' +
      '--round plan-2`, then transition to PLAN_LOCK.',
  },

  PLAN_LOCK: {
    owner: 'opus',
    summary:
      'Machine gate: every acceptance criterion covered, every task has a proof, dependencies ' +
      'coherent, no accepted blocker open.',
    successors: ['EXECUTION', 'PLAN_DRAFT', 'BLOCKED'],
    requires: ['gate:plan'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-completion.mjs" --run <RUN_ID> ' +
      '--gate plan`. If it passes, transition to EXECUTION. If a criterion is uncovered or a ' +
      'task lacks a verification method, return to PLAN_DRAFT — do not proceed on intent.',
  },

  EXECUTION: {
    owner: 'opus',
    summary: 'Sonnet implements the work packages in waves; Opus checks each report.',
    successors: ['SYSTEM_VERIFICATION', 'BLOCKED', 'BUDGET_EXCEEDED'],
    requires: ['tasks:all-accepted'],
    next:
      'Delegate to `hyperpowers:opus-execution-coordinator`. It applies ' +
      '`superpowers:executing-plans` (never `subagent-driven-development`), dispatching one ' +
      '`hyperpowers:sonnet-implementer` per pending work package. Parallel writes are ' +
      'allowed only across disjoint, explicitly owned file sets (spec §15); otherwise run ' +
      'sequentially. Every task walks LOAD_CONTRACT → DISCOVER → IMPLEMENT → SELF_VERIFY → ' +
      'REPORT → OPUS_CHECK → ACCEPT|REMEDIATE, and each of those outcomes is *recorded*:\n' +
      '  `node "${CLAUDE_PLUGIN_ROOT}/scripts/state-machine.mjs" task --run <RUN_ID> --id <WP> ' +
      '--status in_progress|reported|accepted|remediating|failed`\n' +
      'A package cannot be accepted until its implementer has submitted a report. When every ' +
      'package is `accepted` (check with `task --list`), transition to SYSTEM_VERIFICATION.',
  },

  SYSTEM_VERIFICATION: {
    owner: 'sonnet',
    summary: 'Whole-system evidence: tests, lint, typecheck, build, criteria, no residue.',
    successors: ['IMPLEMENTATION_REVIEW_1', 'EXECUTION', 'BLOCKED'],
    requires: ['evidence'],
    next:
      'Delegate to `hyperpowers:sonnet-verifier`. It runs the full suite plus lint, typecheck ' +
      'and build where they exist, checks every acceptance criterion, and confirms the ' +
      'absence of stray TODOs, placeholders, mocks and out-of-scope edits (spec §12 phase 5). ' +
      'It writes `evidence.json`. Opus then checks the evidence dossier is coherent. If a ' +
      'criterion has no proof, return to EXECUTION; otherwise transition to ' +
      'IMPLEMENTATION_REVIEW_1.',
  },

  IMPLEMENTATION_REVIEW_1: {
    owner: 'codex',
    summary: 'Codex round 5 — general adversarial review of the working tree (Luna, xhigh).',
    successors: ['IMPLEMENTATION_REMEDIATION', 'BLOCKED'],
    requires: ['review:implementation-1'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> ' +
      '--round implementation-1`, then transition to IMPLEMENTATION_REMEDIATION.',
  },

  IMPLEMENTATION_REMEDIATION: {
    owner: 'opus',
    summary: 'Opus adjudicates; Sonnet fixes accepted findings.',
    successors: ['IMPLEMENTATION_REVIEW_2', 'BLOCKED'],
    requires: ['adjudicated:implementation-1'],
    next:
      'Delegate to `hyperpowers:opus-review-adjudicator` for `implementation-1`. Reuse the ' +
      'original implementer when the finding concerns its own code (local context is ' +
      'valuable); dispatch a fresh Sonnet when the finding reveals a biased assumption ' +
      '(spec §12 phase 7). Re-run the affected verification, then transition to ' +
      'IMPLEMENTATION_REVIEW_2.',
  },

  IMPLEMENTATION_REVIEW_2: {
    owner: 'codex',
    summary: 'Codex round 6 — final targeted review (Sol, high) closing the cycle.',
    // See DESIGN_REVIEW_2: this edge is what makes the §18 extra round reachable.
    successors: ['FINAL_ACCEPTANCE', 'IMPLEMENTATION_REMEDIATION', 'BLOCKED'],
    requires: ['review:implementation-2'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adversary.mjs" --run <RUN_ID> ' +
      '--round implementation-2`, then transition to FINAL_ACCEPTANCE.',
  },

  FINAL_ACCEPTANCE: {
    owner: 'fable',
    summary: 'Fable decides COMPLETE, REMEDIATE or BLOCKED on the evidence summary alone.',
    // SYSTEM_VERIFICATION is a successor because the completion gate has two distinct failure
    // modes and only one of them is a code problem. A gate that fails on a *reviewer finding*
    // goes to remediation; a gate that fails because the evidence dossier is incomplete needs
    // the evidence regenerated, and nothing on the remediation path writes evidence.json. Without
    // this edge such a run could only loop through remediation until the stall detector gave up
    // and blocked it — an unprovable feature reported as an impasse.
    successors: ['COMPLETE', 'IMPLEMENTATION_REMEDIATION', 'SYSTEM_VERIFICATION', 'BLOCKED'],
    requires: ['gate:completion', 'finalReport'],
    next:
      'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-completion.mjs" --run <RUN_ID> ' +
      '--gate completion`. It enforces the fourteen conditions of spec §13 mechanically. ' +
      'Read only the summary it prints — need, criteria and their status, tests, open ' +
      'findings, residual risks, Opus recommendation, Codex verdict. Publish the product Mermaid ' +
      'diagram (condition 14) — an Artifact when this session has one, otherwise a disclosed ' +
      'fallback rendering — and record it with `state-machine.mjs artifact --name diagramUrl ' +
      '--value <url> --source "<mermaid>"`. Then *generate* the report with ' +
      '`node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" final --run <RUN_ID>` — writing it by hand ' +
      'silently drops the evidence matrix, the review trail, the measured cost and the inline ' +
      'diagram. Finally answer COMPLETE, REMEDIATE or BLOCKED.',
  },

  SUSPENDED: {
    owner: 'system',
    summary: 'Turn yielded below the Stop-hook block cap. Resumable, not failed.',
    successors: [],
    requires: [],
    next: 'Run `/hyperpowers:resume` to continue this run in a fresh turn.',
  },

  COMPLETE: { owner: 'system', summary: 'Feature accepted on evidence.', successors: [], requires: [], next: '' },
  BLOCKED: { owner: 'system', summary: 'Insoluble failure; human decision required.', successors: [], requires: [], next: '' },
  ABORTED: { owner: 'system', summary: 'Run abandoned deliberately.', successors: [], requires: [], next: '' },
  BUDGET_EXCEEDED: { owner: 'system', summary: 'A configured bound was hit.', successors: [], requires: [], next: '' },
  POLICY_VIOLATION: { owner: 'system', summary: 'A hard policy was breached.', successors: [], requires: [], next: '' },
});

export const PHASE_ORDER = Object.freeze([
  'PREFLIGHT',
  'INTAKE',
  'BRAINSTORMING',
  'DESIGN_DRAFT',
  'DESIGN_REVIEW_1',
  'DESIGN_REMEDIATION',
  'DESIGN_REVIEW_2',
  'DESIGN_LOCK',
  'PLAN_DRAFT',
  'PLAN_REVIEW_1',
  'PLAN_REMEDIATION',
  'PLAN_REVIEW_2',
  'PLAN_LOCK',
  'EXECUTION',
  'SYSTEM_VERIFICATION',
  'IMPLEMENTATION_REVIEW_1',
  'IMPLEMENTATION_REMEDIATION',
  'IMPLEMENTATION_REVIEW_2',
  'FINAL_ACCEPTANCE',
  'COMPLETE',
]);

/** The six mandatory Codex rounds (spec §8.5), including their model and effort routing. */
export const REVIEW_ROUNDS = Object.freeze({
  'design-1': { artifact: 'design', kind: 'general', model: 'gpt-5.6-sol', effort: 'high', phase: 'DESIGN_REVIEW_1' },
  'design-2': { artifact: 'design', kind: 'targeted', model: 'gpt-5.6-luna', effort: 'xhigh', phase: 'DESIGN_REVIEW_2' },
  'plan-1': { artifact: 'plan', kind: 'general', model: 'gpt-5.6-luna', effort: 'xhigh', phase: 'PLAN_REVIEW_1' },
  'plan-2': { artifact: 'plan', kind: 'targeted', model: 'gpt-5.6-luna', effort: 'xhigh', phase: 'PLAN_REVIEW_2' },
  'implementation-1': { artifact: 'implementation', kind: 'general', model: 'gpt-5.6-luna', effort: 'xhigh', phase: 'IMPLEMENTATION_REVIEW_1' },
  'implementation-2': { artifact: 'implementation', kind: 'targeted', model: 'gpt-5.6-sol', effort: 'high', phase: 'IMPLEMENTATION_REVIEW_2' },
});

/**
 * The bounded extra round of spec §18.
 *
 * "Si le deuxième round d'un artefact découvre un nouveau blocker : correction → une review
 * ciblée supplémentaire maximum." That escape valve had no implementation: `REVIEW_ROUNDS` held
 * exactly six entries and the adapter rejected every other name, so a coordinator instructed by
 * its own routing policy to run one could not. A rule that cannot be obeyed is not a bound.
 *
 * An extra round is targeted, reviews the same artefact, and inherits the routing of that
 * artefact's round 2 — it verifies a correction, which is what round 2 does. It does not gate a
 * phase: the six mandatory rounds still do that. `maxExtraReviewsPerArtifact` caps it.
 */
export const EXTRA_ROUNDS = Object.freeze({
  'design-extra': { artifact: 'design', kind: 'targeted', model: 'gpt-5.6-luna', effort: 'xhigh', phase: 'DESIGN_REMEDIATION', verifies: 'design-2' },
  'plan-extra': { artifact: 'plan', kind: 'targeted', model: 'gpt-5.6-luna', effort: 'xhigh', phase: 'PLAN_REMEDIATION', verifies: 'plan-2' },
  'implementation-extra': { artifact: 'implementation', kind: 'targeted', model: 'gpt-5.6-sol', effort: 'high', phase: 'IMPLEMENTATION_REMEDIATION', verifies: 'implementation-2' },
});

/** Every round the adapter will run: the six mandatory gates plus the bounded extra. */
export const ALL_ROUNDS = Object.freeze({ ...REVIEW_ROUNDS, ...EXTRA_ROUNDS });

export function isTerminal(phase) {
  return TERMINAL_PHASES.includes(phase);
}

export function stopAllowed(phase) {
  return STOP_ALLOWED_PHASES.includes(phase);
}

export function isKnownPhase(phase) {
  return Object.prototype.hasOwnProperty.call(PHASES, phase);
}

/**
 * Transitions are validated rather than trusted. An agent that writes an arbitrary phase into
 * `state.json` would otherwise be able to skip a Codex gate simply by claiming to be past it.
 */
export function canTransition(from, to) {
  if (!isKnownPhase(from) || !isKnownPhase(to)) return false;
  if (to === 'BLOCKED' || to === 'ABORTED' || to === 'POLICY_VIOLATION' || to === 'BUDGET_EXCEEDED') return true;
  if (to === 'SUSPENDED') return !isTerminal(from);
  return PHASES[from].successors.includes(to);
}

export function nextAction(phase) {
  return PHASES[phase]?.next ?? '';
}

export function phaseIndex(phase) {
  const i = PHASE_ORDER.indexOf(phase);
  return i === -1 ? null : i;
}
