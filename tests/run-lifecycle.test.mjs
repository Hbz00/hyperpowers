/**
 * End-to-end reachability: PREFLIGHT → COMPLETE using only the documented CLI surface.
 *
 * This exists because `tests/completion.test.mjs` could not have caught the bug it was written
 * to prevent a second time. That suite proves each gate is *checkable*, but it hand-writes
 * `status: "accepted"` into its `tasks.json` fixture — so it never asks the question that
 * matters: is there anything in the shipped system that can put a task into that state?
 *
 * There was not. `EXECUTION` required `tasks:all-accepted`, `validate-agent-report submit` only
 * reached `reported`, and no verb went further. Every real run would have stalled in EXECUTION
 * until the progress detector transitioned it to BLOCKED — the same class of defect as the
 * `diagramUrl` one, surviving in a second place because the test that found the first one wrote
 * around it.
 *
 * The rule here: **state is only ever moved through a command an agent is actually told to
 * run.** Files may be written (agents and the Codex adapter genuinely produce files), but no
 * test may reach into `state.json` or edit a task's status directly. If reaching `COMPLETE`
 * requires something this file cannot do with a documented verb, the run cannot do it either.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
let TMP, PROJECT, DATA, RUN, RUNDIR;

const env = () => ({ ...process.env, HYPERPOWERS_DATA_ROOT: DATA, CLAUDE_PLUGIN_ROOT: ROOT });

function run(script, args, { expectFail = false } = {}) {
  try {
    return { ok: true, stdout: execFileSync('node', [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', env: env() }), code: 0 };
  } catch (err) {
    if (!expectFail) throw new Error(`${script} ${args.join(' ')} failed:\n${err.stderr || err.stdout}`);
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status };
  }
}

const sm = (args, opts) => run('state-machine.mjs', ['--project', PROJECT, '--run', RUN, ...args], opts);
const ledger = (args, opts) => run('adjudication-ledger.mjs', [...args, '--project', PROJECT, '--run', RUN], opts);
const gate = (name, opts) => run('verify-completion.mjs', ['--project', PROJECT, '--run', RUN, '--gate', name], opts);
const go = (phase) => JSON.parse(sm(['transition', '--to', phase, '--actor', 'test']).stdout).to;
const phase = () => JSON.parse(sm(['show']).stdout).phase;
const write = (name, content) => {
  const file = path.join(RUNDIR, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};

const review = (round, model, effort, findings = []) => ({
  round, status: 'completed', artifact: round.split('-')[0], kind: round.endsWith('-2') ? 'targeted' : 'general',
  model, effort, at: new Date().toISOString(), verdict: findings.length ? 'concerns' : 'clean',
  summary: 'Round output.', residual_risks: [], coverage_notes: '', findings, attempts: [],
});

const DESIGN = [
  '# Design — per-tenant rate limiting', '',
  'Approach: a sliding-window counter in the shared cache, checked by API middleware.',
  'Rejected alternative: an in-process counter, which cannot hold across worker processes.', '',
  '## Acceptance criteria',
  '- AC-1: a tenant exceeding 100 requests in any rolling 60-second window receives HTTP 429',
  '- AC-2: the same budget is enforced identically across all worker processes', '',
  '## Non-goals', '- Cross-region coordination',
].join('\n');

const PLAN = 'Implementation plan. WP-001 adds the sliding-window limiter and its unit tests. '
  + 'WP-002 wires it into the middleware and adds the cross-worker consistency test. Each task '
  + 'names a verification command that can actually fail.';

const task = (id, criteria, owned) => ({
  id, objective: `Implement ${id} exactly as the plan states.`,
  scope: { files: owned, owned_files: owned }, interfaces: 'x', constraints: 'y',
  verification: { method: 'pytest', commands: ['pytest -q'] },
  acceptance_criteria: criteria, out_of_scope: [], report_format: 'agent-report.schema.json',
  // Exactly what the plan coordinator writes: nothing is accepted yet.
  status: 'pending', depends_on: [], parallel_safe: true,
});

const report = (id, files) => ({
  work_package_id: id, agent: 'hyperpowers:sonnet-implementer', model: 'claude-sonnet-5', status: 'success',
  files_read: files, files_modified: files, commands_run: ['pytest -q'],
  results: [{ check: 'pytest -q', expected: '2 passed', observed: '2 passed in 0.31s', passed: true }],
  unverified: ['behaviour under cache eviction'], risks: [], evidence: ['tests/test_limit.py::test_429 PASSED'],
  recommendation: 'Accept; the criterion it owns is demonstrated by a named test.',
});

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-life-'));
  PROJECT = path.join(TMP, 'project');
  DATA = path.join(TMP, 'data');
  fs.mkdirSync(PROJECT, { recursive: true });
  const init = JSON.parse(run('state-machine.mjs', ['--project', PROJECT, 'init', '--session', 'lifecycle', '--description', 'rate limiting']).stdout);
  RUN = init.runId;
  RUNDIR = path.join(DATA, 'projects', fs.readdirSync(path.join(DATA, 'projects'))[0], 'runs', RUN);
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a run reaches COMPLETE through documented commands only', () => {
  test('intake and brainstorming', () => {
    assert.equal(phase(), 'PREFLIGHT');
    assert.equal(go('INTAKE'), 'INTAKE');
    write('request.md', 'Add per-tenant rate limiting to the public API so that one tenant cannot '
      + 'degrade service for everyone else. Constraints stated by the user: no new infrastructure '
      + 'may be introduced, and the limit must hold when the service is scaled horizontally across '
      + 'many worker processes. Explicitly excluded: cross-region coordination, and any change to '
      + 'the existing authentication flow.');
    assert.equal(go('BRAINSTORMING'), 'BRAINSTORMING');
    write('brainstorm-summary.md', 'Consolidated need: per-tenant limits enforced consistently across '
      + 'every worker process, returning HTTP 429 with a Retry-After header once a tenant exceeds '
      + 'its budget, reusing the shared cache the project already runs. Open questions resolved with '
      + 'the user: the budget is per tenant rather than per API key, and exceeding it rejects rather '
      + 'than queues.');
    assert.equal(go('DESIGN_DRAFT'), 'DESIGN_DRAFT');
  });

  test('design review, adjudication and lock', () => {
    write('design.md', DESIGN);
    assert.equal(go('DESIGN_REVIEW_1'), 'DESIGN_REVIEW_1');

    write('reviews/design-1.json', review('design-1', 'gpt-5.6-sol', 'high', [{
      id: 'DESIGN-001', severity: 'high', category: 'architecture', artifact: 'design', round: 'design-1',
      location: 'Approach', claim: 'The window boundary is not specified as rolling.',
      evidence: ['design.md "sliding-window counter"'], recommendation: 'State the window semantics.',
      blocking: true, confidence: 0.8,
    }]));
    assert.equal(go('DESIGN_REMEDIATION'), 'DESIGN_REMEDIATION');

    // A blocking finding cannot be left behind: the phase will not exit until it is decided…
    // Into the run directory: an adjudication record is orchestration data, and `record` now
    // refuses a path inside the repository under review (spec §20). The fixture used to write into
    // the project, which is the behaviour the guard exists to stop.
    const decisions = path.join(RUNDIR, 'reports', 'decisions.json');
    fs.mkdirSync(path.dirname(decisions), { recursive: true });
    fs.writeFileSync(decisions, JSON.stringify([{
      finding_id: 'DESIGN-001', decision: 'accepted',
      rationale: 'The claim is correct: the design says sliding-window without defining the boundary.',
      correction_owner: 'opus', required_change: 'Define the window as rolling over the last 60 seconds.',
      verification: 'The design states the rolling boundary explicitly.', escalate_to_fable: false,
    }]));
    ledger(['record', '--round', 'design-1', '--file', decisions]);

    // …nor until the accepted correction is *proven* applied.
    const blocked = JSON.parse(gate('design', { expectFail: true }).stdout);
    assert.equal(blocked.complete, false);
    assert.ok(blocked.conditions.some((c) => c.id === 'resolved-design-1' && c.status === 'fail'));

    ledger(['resolve', '--round', 'design-1', '--finding', 'DESIGN-001', '--evidence', 'design.md now states the rolling 60-second boundary.']);
    write('reviews/design-2.json', review('design-2', 'gpt-5.6-luna', 'xhigh'));
    assert.equal(go('DESIGN_REVIEW_2'), 'DESIGN_REVIEW_2');

    assert.equal(JSON.parse(gate('design').stdout).complete, true);
    assert.equal(go('DESIGN_LOCK'), 'DESIGN_LOCK');
  });

  test('an escalated blocking finding stays open until Fable answers', () => {
    // Escalating is not deciding. Before this was fixed, `escalated_to_fable` defaulted to
    // resolved and the finding vanished from openBlockers without any product verdict.
    const decisions = path.join(RUNDIR, 'reports', 'escalated.json');
    fs.mkdirSync(path.dirname(decisions), { recursive: true });
    fs.writeFileSync(decisions, JSON.stringify([{
      finding_id: 'DESIGN-001', decision: 'escalated_to_fable',
      rationale: 'This changes what the product promises about burst traffic; it is not mine to decide.',
      correction_owner: 'fable', escalate_to_fable: true,
    }]));
    ledger(['record', '--round', 'design-1', '--file', decisions]);
    const open = JSON.parse(ledger(['status', '--round', 'design-1']).stdout).openBlockers;
    assert.equal(open.length, 1, 'an escalated blocking finding must remain open');
    assert.match(open[0].reason, /awaiting a product verdict/);

    // Restore the resolved state so the run can proceed.
    const resolved = path.join(RUNDIR, 'reports', 'resolved.json');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify([{
      finding_id: 'DESIGN-001', decision: 'accepted',
      rationale: 'Fable approved tightening the boundary; the change is now applied.',
      correction_owner: 'opus', required_change: 'Define the window as rolling over the last 60 seconds.',
      verification: 'The design states the rolling boundary explicitly.', escalate_to_fable: false,
    }]));
    ledger(['record', '--round', 'design-1', '--file', resolved]);
    ledger(['resolve', '--round', 'design-1', '--finding', 'DESIGN-001', '--evidence', 'design.md states the rolling 60-second boundary.']);
  });

  test('plan review and lock', () => {
    assert.equal(go('PLAN_DRAFT'), 'PLAN_DRAFT');
    write('plan.md', PLAN);
    write('tasks.json', { tasks: [task('WP-001', ['AC-1'], ['src/limiter.py']), task('WP-002', ['AC-2'], ['src/middleware.py'])] });
    assert.equal(go('PLAN_REVIEW_1'), 'PLAN_REVIEW_1');
    write('reviews/plan-1.json', review('plan-1', 'gpt-5.6-luna', 'xhigh'));
    assert.equal(go('PLAN_REMEDIATION'), 'PLAN_REMEDIATION');
    assert.equal(go('PLAN_REVIEW_2'), 'PLAN_REVIEW_2');
    write('reviews/plan-2.json', review('plan-2', 'gpt-5.6-luna', 'xhigh'));
    assert.equal(JSON.parse(gate('plan').stdout).complete, true);
    assert.equal(go('PLAN_LOCK'), 'PLAN_LOCK');
  });

  test('EXECUTION is exitable — every package can actually reach "accepted"', () => {
    assert.equal(go('EXECUTION'), 'EXECUTION');

    // The defect this whole file exists for: without a verb that sets `accepted`, this phase is
    // a dead end no matter how correct everything upstream is.
    const stuck = sm(['transition', '--to', 'SYSTEM_VERIFICATION', '--actor', 'opus'], { expectFail: true });
    assert.match(stuck.stderr, /tasks not accepted: WP-001, WP-002/);

    for (const [id, files] of [['WP-001', ['src/limiter.py']], ['WP-002', ['src/middleware.py']]]) {
      sm(['task', '--id', id, '--status', 'in_progress']);

      // Acceptance requires evidence: a package with no submitted report cannot be accepted.
      const premature = sm(['task', '--id', id, '--status', 'accepted'], { expectFail: true });
      assert.match(premature.stderr, /no submitted report/);

      // Into the run directory, as spec §20 requires and as `submit` now enforces. The fixture
      // used to write into the project, which is exactly how a live run left an orchestration
      // artefact in the repository under review — the test was modelling the defect.
      const file = path.join(RUNDIR, 'reports', `${id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report(id, files)));
      run('validate-agent-report.mjs', ['submit', '--project', PROJECT, '--run', RUN, '--file', file]);
      sm(['task', '--id', id, '--status', 'accepted']);
    }

    const tasks = JSON.parse(sm(['task', '--list']).stdout);
    assert.deepEqual(tasks.byStatus, { accepted: 2 });
    assert.equal(go('SYSTEM_VERIFICATION'), 'SYSTEM_VERIFICATION');
  });

  test('verification, final reviews and COMPLETE', () => {
    write('evidence.json', {
      generatedAt: new Date().toISOString(),
      criteria: [
        { id: 'AC-1', statement: 'a tenant over 100 requests in any rolling 60s window receives HTTP 429', status: 'satisfied', evidence: ['tests/test_limit.py::test_429 PASSED'], work_packages: ['WP-001'] },
        { id: 'AC-2', statement: 'the same budget is enforced identically across all worker processes', status: 'satisfied', evidence: ['tests/test_limit.py::test_shared_across_workers PASSED'], work_packages: ['WP-002'] },
      ],
      checks: [
        { name: 'unit-tests', command: 'pytest -q', status: 'pass', output: '2 passed in 0.31s' },
        { name: 'lint', command: 'ruff check .', status: 'pass', output: 'All checks passed!' },
        { name: 'typecheck', command: 'mypy .', status: 'absent', output: '' },
        { name: 'build', command: '', status: 'absent', output: '' },
      ],
      failing_before_fix: ['tests/test_limit.py::test_429 — AssertionError: assert 200 == 429'],
      residue: { todos: [], placeholders: [], mocks: [] },
    });
    assert.equal(go('IMPLEMENTATION_REVIEW_1'), 'IMPLEMENTATION_REVIEW_1');
    write('reviews/implementation-1.json', review('implementation-1', 'gpt-5.6-luna', 'xhigh'));
    assert.equal(go('IMPLEMENTATION_REMEDIATION'), 'IMPLEMENTATION_REMEDIATION');
    assert.equal(go('IMPLEMENTATION_REVIEW_2'), 'IMPLEMENTATION_REVIEW_2');
    write('reviews/implementation-2.json', review('implementation-2', 'gpt-5.6-sol', 'high'));
    assert.equal(go('FINAL_ACCEPTANCE'), 'FINAL_ACCEPTANCE');

    // Condition 14 has to be reachable too, and only `artifact` can satisfy it.
    const withoutDiagram = JSON.parse(gate('completion', { expectFail: true }).stdout);
    assert.ok(withoutDiagram.conditions.some((c) => c.id === '13.14-product-diagram' && c.status === 'fail'));
    sm(['artifact', '--name', 'diagramUrl', '--value', 'https://claude.ai/public/artifacts/example']);

    const final = JSON.parse(gate('completion').stdout);
    assert.equal(final.complete, true, JSON.stringify(final.conditions.filter((c) => c.status === 'fail'), null, 2));

    run('report.mjs', ['final', '--project', PROJECT, '--run', RUN]);
    assert.equal(go('COMPLETE'), 'COMPLETE');
    assert.equal(phase(), 'COMPLETE');
  });

  test('a blocked policy attempt does not make COMPLETE unreachable', () => {
    // Prevention working is not a breach. Emitting `policy_violation` on every denial meant one
    // blocked `git commit` — or even a blocked `Workflow` call — permanently failed condition
    // §13.11, and telemetry is append-only, so the run could never recover.
    fs.appendFileSync(path.join(RUNDIR, 'telemetry.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), runId: RUN, type: 'policy_blocked', tool: 'Bash', decision: 'deny' })}\n`);
    const out = JSON.parse(gate('completion').stdout);
    const condition = out.conditions.find((c) => c.id === '13.11-no-git-mutation');
    assert.equal(condition.status, 'pass');
    assert.match(condition.detail, /blocked before execution/);
    assert.equal(out.complete, true);
  });

  test('COMPLETE cannot be reached while the completion gate is failing', () => {
    // The gate was computed but not binding: `COMPLETE` is terminal, and terminal targets
    // skipped their exit requirements so that BLOCKED is always reachable. That exemption made
    // all fourteen §13 conditions advisory at the only moment they decide anything — a run
    // could declare success with nothing proven. Success is the one terminal state that is earned.
    const statePath = path.join(RUNDIR, 'state.json');
    const saved = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(saved);
    state.phase = 'FINAL_ACCEPTANCE';
    state.gates.completion = { passed: false, at: new Date().toISOString(), reason: 'forced failure' };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const refused = sm(['transition', '--to', 'COMPLETE', '--actor', 'fable'], { expectFail: true });
    assert.equal(refused.ok, false, 'COMPLETE must refuse a failing completion gate');
    assert.match(refused.stderr + refused.stdout, /gate completion failed|unmet exit requirements/i);
    assert.equal(phase(), 'FINAL_ACCEPTANCE');

    fs.writeFileSync(statePath, saved);
  });

  test('BLOCKED remains reachable unconditionally', () => {
    // The counterpart the exemption existed for: a machine you cannot stop is worse than one
    // you cannot finish, so every *failure* terminal must stay reachable with gates unmet.
    const statePath = path.join(RUNDIR, 'state.json');
    const saved = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(saved);
    state.phase = 'EXECUTION';
    state.gates = {};
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    assert.equal(go('BLOCKED'), 'BLOCKED');

    fs.writeFileSync(statePath, saved);
  });

  test('there is no CLI verb that can forge a gate verdict', () => {
    // `gate --name completion --pass` wrote `gates.completion.passed = true` straight from a
    // flag, with no cross-check against verify-completion.mjs — a second, simpler way to reach
    // COMPLETE unproven. Gate verdicts are now written only by the verifier that computes them.
    const forged = sm(['gate', '--name', 'completion', '--pass'], { expectFail: true });
    assert.equal(forged.ok, false, 'the `gate` verb must not exist');
    assert.match(forged.stderr + forged.stdout, /Unknown command/i);
  });

  test('a detected mutation still fails the gate', () => {
    fs.appendFileSync(path.join(RUNDIR, 'telemetry.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), runId: RUN, type: 'policy_violation', kind: 'git_mutation_detected', drift: ['HEAD moved'] })}\n`);
    const out = JSON.parse(gate('completion', { expectFail: true }).stdout);
    assert.equal(out.conditions.find((c) => c.id === '13.11-no-git-mutation').status, 'fail');
    assert.equal(out.complete, false);
  });
});
