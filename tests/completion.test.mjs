/**
 * Gate reachability tests.
 *
 * The back half of the state machine had no coverage, and it hid a fatal defect: nothing could
 * ever write `state.artifacts.diagramUrl`, so spec §13 condition 14 always failed, the
 * completion gate could never pass, `FINAL_ACCEPTANCE` could never be exited, and **every run
 * would have terminated BLOCKED**.
 *
 * These tests drive a synthetic run all the way to `COMPLETE`. A gate that is checkable but not
 * reachable is worse than no gate, so reachability is asserted explicitly.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const sm = (args, opts) => run('state-machine.mjs', ['--project', PROJECT, ...args], opts);
const gate = (name, opts) => run('verify-completion.mjs', ['--project', PROJECT, '--run', RUN, '--gate', name], opts);
const write = (name, content) => fs.writeFileSync(path.join(RUNDIR, name), content);

/** A completed Codex round with no findings — the simplest artefact that satisfies a review gate. */
const cleanReview = (round, model, effort) => ({
  round, status: 'completed', artifact: round.split('-')[0], kind: round.endsWith('-2') ? 'targeted' : 'general',
  model, effort, at: new Date().toISOString(), verdict: 'clean',
  summary: 'No material findings.', residual_risks: [], coverage_notes: '', findings: [], attempts: [],
});

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-gate-'));
  PROJECT = path.join(TMP, 'project');
  DATA = path.join(TMP, 'data');
  fs.mkdirSync(PROJECT, { recursive: true });
  RUN = JSON.parse(sm(['init', '--session', 's', '--description', 'rate limiting']).stdout).runId;
  RUNDIR = path.join(DATA, 'projects', fs.readdirSync(path.join(DATA, 'projects'))[0], 'runs', RUN);
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('design gate', () => {
  test('fails on a design with unfalsifiable acceptance criteria', () => {
    write('design.md', [
      '# Design', 'Some approach that is described at sufficient length to pass the size check.',
      '## Acceptance criteria',
      '- AC-1: a client over 100 requests in any rolling 60s window receives HTTP 429',
      '- AC-2: it works',
      '## Non-goals', '- Distributed coordination',
    ].join('\n'));
    fs.mkdirSync(path.join(RUNDIR, 'reviews'), { recursive: true });
    write('reviews/design-1.json', JSON.stringify(cleanReview('design-1', 'gpt-5.6-sol', 'high')));
    write('reviews/design-2.json', JSON.stringify(cleanReview('design-2', 'gpt-5.6-luna', 'xhigh')));

    const out = JSON.parse(gate('design', { expectFail: true }).stdout);
    assert.equal(out.complete, false);
    const falsifiable = out.conditions.find((c) => c.id === 'criteria-falsifiable');
    assert.equal(falsifiable.status, 'fail');
    assert.match(falsifiable.detail, /AC-2/);
  });

  test('passes once every criterion is observable', () => {
    write('design.md', [
      '# Design', 'Some approach that is described at sufficient length to pass the size check.',
      '## Acceptance criteria',
      '- AC-1: a client over 100 requests in any rolling 60s window receives HTTP 429',
      '- AC-2: limits are enforced identically across all worker processes',
      '## Non-goals', '- Distributed coordination',
    ].join('\n'));
    const out = JSON.parse(gate('design').stdout);
    assert.equal(out.complete, true, JSON.stringify(out.conditions.filter((c) => c.status === 'fail')));
  });
});

describe('plan gate', () => {
  const task = (id, criteria, owned) => ({
    id, objective: `Implement ${id} exactly as the plan states.`,
    scope: { files: owned, owned_files: owned }, interfaces: 'x', constraints: 'y',
    verification: { method: 'pytest', commands: ['pytest -q'] },
    acceptance_criteria: criteria, out_of_scope: [], report_format: 'agent-report.schema.json',
    status: 'accepted', depends_on: [], parallel_safe: true,
  });

  before(() => {
    sm(['transition', '--run', RUN, '--to', 'INTAKE']);
    write('request.md', 'Add per-client rate limiting to the public API so that abusive clients cannot '
      + 'degrade service for everyone else. It must not require new infrastructure, and it must keep '
      + 'working correctly when the service is scaled horizontally across many worker processes.');
    sm(['transition', '--run', RUN, '--to', 'BRAINSTORMING']);
    write('brainstorm-summary.md', 'Consolidated need: per-client rate limiting enforced consistently '
      + 'across all workers, returning HTTP 429 with Retry-After once a client exceeds its budget. '
      + 'No new infrastructure may be introduced; reuse the existing shared cache.');
    sm(['transition', '--run', RUN, '--to', 'DESIGN_DRAFT']);
    write('plan.md', 'Implementation plan. WP-001 adds the sliding-window limiter backed by the shared '
      + 'cache and its unit tests. WP-002 wires the limiter into the API middleware and adds the '
      + 'cross-worker consistency test. Each task carries its own verification command.');
    write('reviews/plan-1.json', JSON.stringify(cleanReview('plan-1', 'gpt-5.6-luna', 'xhigh')));
    write('reviews/plan-2.json', JSON.stringify(cleanReview('plan-2', 'gpt-5.6-luna', 'xhigh')));
  });

  test('fails when an acceptance criterion has no task', () => {
    write('tasks.json', JSON.stringify({ tasks: [task('WP-001', ['AC-1'], ['src/a.py'])] }));
    const out = JSON.parse(gate('plan', { expectFail: true }).stdout);
    const covered = out.conditions.find((c) => c.id === 'criteria-covered');
    assert.equal(covered.status, 'fail');
    assert.match(covered.detail, /AC-2/);
  });

  test('fails when parallel-safe tasks own the same file', () => {
    write('tasks.json', JSON.stringify({ tasks: [task('WP-001', ['AC-1'], ['src/a.py']), task('WP-002', ['AC-2'], ['src/a.py'])] }));
    const out = JSON.parse(gate('plan', { expectFail: true }).stdout);
    const parallel = out.conditions.find((c) => c.id === 'parallel-safety');
    assert.equal(parallel.status, 'fail');
    assert.match(parallel.detail, /both own src\/a\.py/);
  });

  test('fails on a dependency cycle', () => {
    const a = { ...task('WP-001', ['AC-1'], ['src/a.py']), depends_on: ['WP-002'] };
    const b = { ...task('WP-002', ['AC-2'], ['src/b.py']), depends_on: ['WP-001'] };
    write('tasks.json', JSON.stringify({ tasks: [a, b] }));
    const out = JSON.parse(gate('plan', { expectFail: true }).stdout);
    assert.equal(out.conditions.find((c) => c.id === 'dependencies-acyclic').status, 'fail');
  });

  test('passes on a coherent plan', () => {
    write('tasks.json', JSON.stringify({ tasks: [task('WP-001', ['AC-1'], ['src/a.py']), task('WP-002', ['AC-2'], ['src/b.py'])] }));
    const out = JSON.parse(gate('plan').stdout);
    assert.equal(out.complete, true, JSON.stringify(out.conditions.filter((c) => c.status === 'fail')));
  });

  /**
   * The delegation contract of spec §3.2 is stated in `work-package.schema.json`, which had no
   * code consumer at all — every other check here reads the fields the *gate* needs and none read
   * the fields the *Sonnet* needs. A package could therefore satisfy coverage, verifiability,
   * ownership and dependency checks while giving the implementer nothing to implement against.
   */
  test('rejects a package that is not a self-contained contract', () => {
    const gutted = { ...task('WP-001', ['AC-1'], ['src/a.py']) };
    delete gutted.interfaces;
    delete gutted.out_of_scope;
    write('tasks.json', JSON.stringify({ tasks: [gutted, task('WP-002', ['AC-2'], ['src/b.py'])] }));
    const out = JSON.parse(gate('plan', { expectFail: true }).stdout);
    const wellFormed = out.conditions.find((c) => c.id === 'tasks-well-formed');
    assert.equal(wellFormed.status, 'fail');
    assert.match(wellFormed.detail, /WP-001/);
    assert.match(wellFormed.detail, /interfaces/);
    assert.match(wellFormed.detail, /out_of_scope/);
    // Every other plan condition still passes: this failure is about the contract, not the plan.
    assert.equal(out.conditions.find((c) => c.id === 'criteria-covered').status, 'pass');
  });

  test('rejects a work-package id that does not follow the convention', () => {
    // Ids are how findings, reports, locks and telemetry refer to a package. `WP-1` looks
    // harmless and sorts differently from `WP-001` everywhere it appears.
    write('tasks.json', JSON.stringify({
      tasks: [{ ...task('WP-1', ['AC-1'], ['src/a.py']) }, task('WP-002', ['AC-2'], ['src/b.py'])],
    }));
    const out = JSON.parse(gate('plan', { expectFail: true }).stdout);
    assert.match(out.conditions.find((c) => c.id === 'tasks-well-formed').detail, /WP-1.*pattern/);
  });

  /**
   * The design and the plan are written by different agents at different times, so criterion ids
   * have to survive the trip between them.
   *
   * Measured on the first pilot run: the design coordinator wrote sixteen criteria as
   * `**AC1 — …**`, the extractor demanded a literal `AC-1:`, and the gate found **none of them**
   * in a document that stated sixteen. Two criterion conditions then reported `unverifiable` and
   * a third failed — over a hyphen. Last in this block because it rewrites the shared fixture.
   */
  test('criterion ids are matched across spellings', () => {
    // Snapshot and restore: this run directory is shared with the describe that follows, and a
    // test that leaves the fixture rewritten fails its neighbours instead of itself.
    const snapshot = ['design.md', 'tasks.json'].map((f) => [f, fs.readFileSync(path.join(RUNDIR, f), 'utf8')]);
    try {
    write('design.md', [
      '# Design', '',
      '- **AC1 — Hard length invariant.** `truncate(t, max).length <= max` for every input.',
      '- AC-2: the cut falls on a word boundary when whitespace exists in range',
      '* **AC 3** – a single-character ellipsis marks that it truncated', '',
      '## Non-goals', 'grapheme clustering', 'x'.repeat(300),
    ].join('\n'));
    // The plan claims coverage in yet another spelling, as a different agent naturally would.
    write('tasks.json', JSON.stringify({
      tasks: [task('WP-001', ['AC1', 'ac-2'], ['src/a.py']), task('WP-002', ['AC 3'], ['src/b.py'])],
    }));
    const out = JSON.parse(gate('plan', { expectFail: true }).stdout);
    const covered = out.conditions.find((c) => c.id === 'criteria-covered');
    assert.equal(covered.status, 'pass', `all three criteria must read as covered: ${covered.detail}`);
    assert.match(covered.detail, /3 criteria covered/);
    } finally {
      for (const [f, body] of snapshot) write(f, body);
    }
  });
});

describe('completion gate is reachable', () => {
  before(() => {
    // Condition 13.13 asks whether the run actually reached the director's gate, so this
    // synthetic fixture has to sit where a real run sits when the gate is evaluated. Without
    // this the suite would be asserting that a gate passes from a phase it can never be
    // legitimately evaluated in.
    const statePath = path.join(RUNDIR, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.phase = 'FINAL_ACCEPTANCE';
    state.history = [...(state.history ?? []), { from: 'IMPLEMENTATION_REVIEW_2', to: 'FINAL_ACCEPTANCE', at: new Date().toISOString(), actor: 'fable' }];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    write('reviews/implementation-1.json', JSON.stringify(cleanReview('implementation-1', 'gpt-5.6-luna', 'xhigh')));
    write('reviews/implementation-2.json', JSON.stringify(cleanReview('implementation-2', 'gpt-5.6-sol', 'high')));

    // `packages-accepted` now re-verifies the evidence behind each acceptance: the newest
    // referenced report must exist and say success (or carry a recorded override). The fixture
    // therefore sits where a real accepted run sits — statuses AND the reports that justified them.
    const acceptedTask = (id, criteria) => ({
      id, objective: `Implement ${id} exactly as the plan states.`,
      scope: { files: ['src/a.py'], owned_files: ['src/a.py'] }, interfaces: 'x', constraints: 'y',
      verification: { method: 'pytest', commands: ['pytest -q'] },
      acceptance_criteria: criteria, out_of_scope: [], report_format: 'agent-report.schema.json',
      status: 'accepted', depends_on: [], parallel_safe: true, reports: [`${id}-attempt1`],
    });
    write('tasks.json', JSON.stringify({
      tasks: [acceptedTask('WP-001', ['AC-1']), acceptedTask('WP-002', ['AC-2'])],
    }));
    for (const wp of ['WP-001', 'WP-002']) {
      write(`reports/${wp}-attempt1.json`, JSON.stringify({
        work_package_id: wp, agent: 'sonnet-implementer', status: 'success', attempt: 1,
        storedAt: new Date().toISOString(), commands_run: ['pytest -q'],
        results: [{ check: 'suite', expected: 'pass', observed: 'pass', passed: true }],
        evidence: ['tests pass'], unverified: [], risks: [],
      }));
    }
    write('evidence.json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      criteria: [
        { id: 'AC-1', statement: 'over-budget clients get 429', status: 'satisfied', evidence: ['tests/test_rl.py::test_429 PASSED'] },
        { id: 'AC-2', statement: 'consistent across workers', status: 'satisfied', evidence: ['tests/test_rl.py::test_shared PASSED'] },
      ],
      checks: [
        { name: 'unit-tests', command: 'pytest -q', status: 'pass', output_excerpt: '12 passed' },
        { name: 'lint', command: 'ruff check .', status: 'pass', output_excerpt: 'All checks passed!' },
        { name: 'typecheck', command: 'mypy src', status: 'pass', output_excerpt: 'Success' },
        { name: 'build', command: '', status: 'absent', output_excerpt: 'no build step' },
      ],
      failing_before_fix: ['tests/test_rl.py::test_429 — assert 200 == 429'],
      residue: { todos: [], placeholders: [], mocks: [], out_of_scope_files: [] },
    }));

    // This synthetic run has no session transcript, so the director tier is unobservable — and an
    // unobserved tier now owes a stated decision (13.12b registers in `mustBeStated`). The fixture
    // does what a real degraded run must do: writes the decision down.
    sm(['risk', '--add', 'director tier unobservable in this synthetic fixture: no session transcript exists',
      '--source', '13.12b-director-model']);
  });

  test('fails only on the missing product diagram', () => {
    const out = JSON.parse(gate('completion', { expectFail: true }).stdout);
    const failed = out.conditions.filter((c) => c.status === 'fail').map((c) => c.id);
    assert.deepEqual(failed, ['13.14-product-diagram'],
      `unexpected failures: ${JSON.stringify(out.conditions.filter((c) => c.status === 'fail'), null, 2)}`);
  });

  test('the diagram URL can actually be recorded, by the route a run really takes', () => {
    // Two defects, one test. `state.artifacts` was read by the gate and written by nothing, making
    // COMPLETE unreachable in every run. Then the verb that wrote it — `artifact --name diagramUrl`
    // — required the director to have published the page itself, which returns a URL that opens on
    // nobody's screen (§S21). So the reachable route is the *only* route: park, publish, record.
    const page = path.join(RUNDIR, 'diagram.html');
    fs.writeFileSync(page, '<h1>flow</h1>');
    const parked = JSON.parse(sm(['publish-request', '--run', RUN, '--file', page,
      '--title', 'How it works', '--source', 'flowchart TD\n  a --> b']).stdout);
    assert.equal(parked.parked, 'publish');
    assert.ok(fs.existsSync(path.join(RUNDIR, 'diagram.mmd')),
      'the source travels with the request, so the report can render it inline');

    const out = JSON.parse(sm(['published', '--run', RUN, '--url', 'https://claude.ai/artifact/abc']).stdout);
    assert.equal(out.published, 'https://claude.ai/artifact/abc');
    const state = JSON.parse(fs.readFileSync(path.join(RUNDIR, 'state.json'), 'utf8'));
    assert.equal(state.artifacts.diagramUrl, 'https://claude.ai/artifact/abc');
  });

  test('the completion gate then passes', () => {
    const out = JSON.parse(gate('completion').stdout);
    assert.equal(out.complete, true, JSON.stringify(out.conditions.filter((c) => c.status === 'fail'), null, 2));
    assert.match(out.verdict, /PASSED/);
  });

  /**
   * §Q16 — a wrong effort is a degradation, a wrong model is an inversion.
   *
   * `--agent` pins the director's model but *not* its effort (measured, both directions), so the
   * gate reads `CLAUDE_EFFORT` and reports it. The temptation is to fail on a mismatch. That would
   * turn a finished four-hour run into `BLOCKED` over something that did not change **who** held
   * product authority — so the effort is recorded in the detail and never in the status.
   */
  test('a director effort mismatch is reported, not failed', () => {
    // The tier is read from the director's own subagent transcript (§S4), so the fixture writes
    // one: `<main transcript minus .jsonl>/subagents/agent-<id>.{meta.json,jsonl}`. The main thread
    // is deliberately a different model — nothing may read it for this.
    const state = JSON.parse(fs.readFileSync(path.join(RUNDIR, 'state.json'), 'utf8'));
    const TX = path.join(TMP, 'transcripts');
    const dir = path.join(TX, String(state.projectRoot).replace(/[/.]/g, '-'));
    fs.mkdirSync(path.join(dir, state.sessionId, 'subagents'), { recursive: true });
    const line = (model, effort) => `${JSON.stringify({ type: 'assistant', effort, message: { model } })}\n`;
    fs.writeFileSync(path.join(dir, `${state.sessionId}.jsonl`), line('claude-sonnet-5', 'high'));
    fs.writeFileSync(path.join(dir, state.sessionId, 'subagents', 'a.meta.json'),
      JSON.stringify({ agentType: 'hyperpowers-director', spawnDepth: 1 }));
    fs.writeFileSync(path.join(dir, state.sessionId, 'subagents', 'a.jsonl'),
      line('claude-fable-5', 'low'));

    const out = JSON.parse(execFileSync('node',
      [path.join(ROOT, 'scripts', 'verify-completion.mjs'), '--project', PROJECT, '--run', RUN, '--gate', 'completion'],
      { encoding: 'utf8', env: { ...env(), HYPERPOWERS_TRANSCRIPT_ROOT: TX } }));

    assert.equal(out.complete, true,
      `effort must not fail completion: ${JSON.stringify(out.conditions.filter((c) => c.status === 'fail'), null, 2)}`);
    const tier = out.conditions.find((c) => c.id === '13.12b-director-model');
    assert.notEqual(tier.status, 'fail', 'a degradation is not an inversion');
    assert.match(tier.detail, /claude-fable-5/, 'the director subagent is what was measured');
    assert.match(tier.detail, /low/, 'and its effort is reported');
  });

  test('an open blocking finding fails the gate', () => {
    write('reviews/implementation-1.json', JSON.stringify({
      ...cleanReview('implementation-1', 'gpt-5.6-luna', 'xhigh'),
      verdict: 'blocker',
      findings: [{
        id: 'IMPL-001', severity: 'critical', category: 'correctness', artifact: 'implementation',
        round: 'implementation-1', location: 'src/a.py', claim: 'race condition',
        evidence: ['src/a.py:42'], recommendation: 'serialise', blocking: true, confidence: 0.9,
      }],
    }));
    const out = JSON.parse(gate('completion', { expectFail: true }).stdout);
    assert.equal(out.complete, false);
    // Undecided is itself a failure: silence is not an available answer to a finding.
    assert.ok(out.conditions.some((c) => c.id === 'adjudicated-implementation-1' && c.status === 'fail'));
  });
});

describe('abort', () => {
  test('reaches ABORTED from a mid-run phase', () => {
    const other = JSON.parse(sm(['init', '--session', 's2', '--description', 'x']).stdout).runId;
    sm(['transition', '--run', other, '--to', 'INTAKE']);
    const out = JSON.parse(sm(['abort', '--run', other, '--reason', 'user changed their mind']).stdout);
    assert.equal(out.to, 'ABORTED');
    assert.equal(out.from, 'INTAKE');
  });

  test('is idempotent on an already-terminal run', () => {
    const other = JSON.parse(sm(['init', '--session', 's3', '--description', 'x']).stdout).runId;
    sm(['abort', '--run', other, '--reason', 'first']);
    const out = JSON.parse(sm(['abort', '--run', other, '--reason', 'again']).stdout);
    assert.match(out.note, /already ended/);
  });
});
