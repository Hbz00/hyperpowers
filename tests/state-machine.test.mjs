/**
 * State machine and Stop-controller integration tests.
 *
 * These drive the real scripts as subprocesses with real hook payloads, because that is how
 * the harness invokes them. Testing the exported functions directly would miss exactly the
 * failures that matter here: a script that throws on startup, emits malformed JSON, or exits
 * with the wrong code is a broken hook no matter how correct its internals are.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let TMP;
let PROJECT;
let DATA;

const env = () => ({
  ...process.env,
  HYPERPOWERS_DATA_ROOT: DATA,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '200',
});

function run(script, args = [], { input = null, expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', script), ...args], {
      encoding: 'utf8', env: env(), input: input ?? undefined, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out, stderr: '', code: 0 };
  } catch (err) {
    if (!expectFail) {
      throw new Error(`${script} ${args.join(' ')} failed unexpectedly:\n${err.stderr || err.stdout || err.message}`);
    }
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status };
  }
}

const json = (r) => JSON.parse(r.stdout);
const sm = (args, opts) => run('state-machine.mjs', ['--project', PROJECT, ...args], opts);

let RUN;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-test-'));
  PROJECT = path.join(TMP, 'project');
  DATA = path.join(TMP, 'data');
  fs.mkdirSync(PROJECT, { recursive: true });
  // A stall is rate-limited to one count per `stallMinIntervalMs` in production, so that five
  // "cycles" cannot mean 83 seconds (§P1). These tests fire the controller in a tight loop on
  // purpose, to exercise the ladder rather than the clock, so they turn the gate off explicitly.
  fs.writeFileSync(path.join(PROJECT, '.hyperpowers.json'), JSON.stringify({ stop: { stallMinIntervalMs: 0 } }));
  RUN = json(sm(['init', '--session', 'sess-1', '--description', 'add a widget'])).runId;
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const runDir = () => JSON.parse(fs.readFileSync(path.join(findRunDir(), 'state.json'), 'utf8')) && findRunDir();

function findRunDir() {
  const projects = path.join(DATA, 'projects');
  const project = fs.readdirSync(projects)[0];
  return path.join(projects, project, 'runs', RUN);
}

const writeArtifact = (name, bytes = 400) =>
  fs.writeFileSync(path.join(findRunDir(), name), 'x'.repeat(bytes));

describe('state machine', () => {
  test('init creates a run bound to the session', () => {
    assert.match(RUN, /^\d{8}T\d{6}Z-[a-z0-9]{6}$/);
    assert.ok(fs.existsSync(path.join(findRunDir(), 'state.json')));
    const pointer = path.join(DATA, 'projects', fs.readdirSync(path.join(DATA, 'projects'))[0], 'sessions', 'sess-1.json');
    assert.equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).runId, RUN);
  });

  test('illegal transitions are refused with the allowed set', () => {
    const r = sm(['transition', '--run', RUN, '--to', 'EXECUTION'], { expectFail: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Illegal transition PREFLIGHT -> EXECUTION/);
    assert.match(r.stderr, /Allowed: INTAKE, BLOCKED/);
  });

  test('an unknown phase is rejected', () => {
    const r = sm(['transition', '--run', RUN, '--to', 'NONSENSE'], { expectFail: true });
    assert.match(r.stderr, /Unknown phase/);
  });

  test('exit requirements gate the transition', () => {
    sm(['transition', '--run', RUN, '--to', 'INTAKE', '--actor', 'fable']);
    const blocked = sm(['transition', '--run', RUN, '--to', 'BRAINSTORMING'], { expectFail: true });
    assert.match(blocked.stderr, /unmet exit requirements/);
    assert.match(blocked.stderr, /request/);

    writeArtifact('request.md');
    const okNow = json(sm(['transition', '--run', RUN, '--to', 'BRAINSTORMING', '--actor', 'fable']));
    assert.equal(okNow.to, 'BRAINSTORMING');
  });

  test('terminal transitions bypass exit gates', () => {
    // A run must always be able to reach BLOCKED, even from a phase whose gate is unmet.
    const sideRun = json(sm(['init', '--session', 'sess-blocked', '--description', 'x'])).runId;
    const r = json(sm(['transition', '--run', sideRun, '--to', 'BLOCKED', '--reason', 'codex unavailable']));
    assert.equal(r.to, 'BLOCKED');
  });

  test('history records who, when and what for every transition', () => {
    const state = JSON.parse(fs.readFileSync(path.join(findRunDir(), 'state.json'), 'utf8'));
    assert.ok(state.history.length >= 2);
    for (const h of state.history) {
      assert.ok(h.from && h.to && h.at && h.actor, `incomplete history entry: ${JSON.stringify(h)}`);
    }
  });

  test('check reports unmet requirements and exits 3', () => {
    writeArtifact('brainstorm-summary.md');
    sm(['transition', '--run', RUN, '--to', 'DESIGN_DRAFT', '--actor', 'fable']);
    const r = sm(['check', '--run', RUN], { expectFail: true });
    assert.equal(r.code, 3);
    const out = JSON.parse(r.stdout);
    assert.equal(out.canExit, false);
    assert.match(out.unmet.join(' '), /design/);
  });

  test('the progress signature changes when an artefact changes', () => {
    const before = JSON.parse(sm(['check', '--run', RUN], { expectFail: true }).stdout).signature;
    writeArtifact('design.md', 800);
    const after = JSON.parse(sm(['check', '--run', RUN]).stdout).signature;
    assert.notEqual(before, after, 'writing design.md must change the progress signature');
  });
});

describe('subagent controller — the autonomy loop', () => {
  // The phase machine lives on `SubagentStop` now: blocking `Stop` re-drives the main thread,
  // which directs nothing, while a `SubagentStop` block re-drives the director (§R6). The payload
  // carries `agent_type` and `agent_id`, and the counter is keyed on the latter because
  // `prompt_id` is shared with the main thread (§R5).
  const stopPayload = (overrides = {}) => JSON.stringify({
    session_id: 'sess-1',
    agent_type: 'hyperpowers:hyperpowers-director',
    agent_id: 'agent-1',
    transcript_path: '/nonexistent/transcript.jsonl',
    agent_transcript_path: '/nonexistent/agent.jsonl',
    cwd: PROJECT,
    prompt_id: 'prompt-1',
    permission_mode: 'default',
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    last_assistant_message: 'working',
    ...overrides,
  });

  test('blocks and injects the next action while the run is active', () => {
    const out = JSON.parse(run('subagent-controller.mjs', [], { input: stopPayload() }).stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /HYPERPOWERS/);
    assert.match(out.reason, /Phase: DESIGN_DRAFT/);
    assert.match(out.reason, /Next action:/);
    assert.match(out.reason, /Git is read-only/);
  });

  test('surfaces unmet exit requirements in the injected reason', () => {
    fs.rmSync(path.join(findRunDir(), 'design.md'), { force: true });
    const out = JSON.parse(run('subagent-controller.mjs', [], { input: stopPayload({ agent_id: 'agent-2' }) }).stdout);
    assert.match(out.reason, /cannot be exited yet/);
    assert.match(out.reason, /design/);
  });

  test('escalates when no progress is detected', () => {
    let reason = '';
    // Same payload, unchanged state: each call must register another stall.
    for (let i = 0; i < 3; i += 1) {
      reason = JSON.parse(run('subagent-controller.mjs', [], { input: stopPayload({ agent_id: 'agent-3', stop_hook_active: true }) }).stdout).reason;
    }
    assert.match(reason, /No progress detected/);
    // The ladder's top rung used to read 'Escalate to Fable'. The director is Fable, so it now
    // escalates to its own judgement instead of handing off to itself — the rung is still
    // named, which is what this asserts.
    assert.match(reason, /Escalate to (Opus|your own judgement)/);
  });

  test('blocks the run after persistent stalling and allows the stop', () => {
    for (let i = 0; i < 6; i += 1) {
      run('subagent-controller.mjs', [], { input: stopPayload({ agent_id: 'agent-3', stop_hook_active: true }) });
    }
    const state = JSON.parse(fs.readFileSync(path.join(findRunDir(), 'state.json'), 'utf8'));
    assert.equal(state.phase, 'BLOCKED');
    const out = JSON.parse(run('subagent-controller.mjs', [], { input: stopPayload({ agent_id: 'agent-4' }) }).stdout);
    assert.equal(out.decision, undefined, 'a terminal run must not block the stop');
    assert.match(out.systemMessage, /BLOCKED/);
  });

  test('a returning worker is not a director checkpoint', () => {
    // The whole reason the loop can live here. An implementer's process ends *before* its report
    // lands on disk, so sampling progress on every SubagentStop would read a healthy wave of ten
    // as ten "no progress" cycles and block a run that is working — §L3 with the sign inverted.
    const before = JSON.parse(fs.readFileSync(path.join(findRunDir(), 'state.json'), 'utf8'));
    const out = JSON.parse(run('subagent-controller.mjs', [], {
      input: stopPayload({ agent_type: 'hyperpowers:sonnet-implementer', agent_id: 'w-1' }),
    }).stdout);
    assert.equal(out.decision, undefined, 'a worker finishing must never be blocked by this hook');
    const after = JSON.parse(fs.readFileSync(path.join(findRunDir(), 'state.json'), 'utf8'));
    assert.equal(after.stall.count, before.stall.count, 'and must not move the stall counter');
    assert.deepEqual(after.directorTurn, before.directorTurn, 'nor the director block counter');
  });

  test('stays out of the way when no run is bound to the session', () => {
    const out = run('subagent-controller.mjs', [], { input: stopPayload({ session_id: 'unknown-session' }) });
    assert.deepEqual(JSON.parse(out.stdout), {});
  });

  test('yields to SUSPENDED before the harness block cap', () => {
    const runId = json(sm(['init', '--session', 'sess-cap', '--description', 'cap test'])).runId;
    const payload = JSON.stringify({
      session_id: 'sess-cap', cwd: PROJECT, prompt_id: 'p', hook_event_name: 'Stop',
      stop_hook_active: true, last_assistant_message: 'x',
    });
    // blockCap 6 → soft cap 2 (margin 4), so the third continuation must yield.
    fs.writeFileSync(path.join(PROJECT, '.hyperpowers.json'), JSON.stringify({ stop: { blockCap: 6, softCapMargin: 4 } }));
    const hookEnv = { ...env(), CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '6' };
    const fire = (script, input) => JSON.parse(execFileSync('node', [path.join(ROOT, 'scripts', script)],
      { encoding: 'utf8', env: hookEnv, input }));
    // The main thread's counter advances once per *hand-back* from the director (§S12), so each
    // cycle has to produce one. Driving `Stop` alone would now be allowed every time, which is the
    // whole point of that fix — and a test that skipped the yield would be asserting against a
    // sequence no run can produce.
    const directorStop = JSON.stringify({
      session_id: 'sess-cap', cwd: PROJECT, prompt_id: 'p', hook_event_name: 'SubagentStop',
      agent_type: 'hyperpowers:hyperpowers-director', agent_id: 'dir-cap', stop_hook_active: true,
    });
    let out;
    for (let i = 0; i < 4; i += 1) {
      while (fire('subagent-controller.mjs', directorStop).decision === 'block') { /* to the yield */ }
      out = fire('stop-controller.mjs', payload);
    }
    fs.rmSync(path.join(PROJECT, '.hyperpowers.json'), { force: true });
    assert.match(out.systemMessage ?? '', /suspended/i);
    const dir = path.join(DATA, 'projects', fs.readdirSync(path.join(DATA, 'projects'))[0], 'runs', runId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).phase, 'SUSPENDED');
  });
});

describe('git-policy hook', () => {
  // A dedicated, still-active run: the policy is scoped to one, and the shared `sess-1` run is
  // driven to BLOCKED by the stop-controller suite above.
  let policySession;
  before(() => {
    policySession = 'sess-policy';
    sm(['init', '--session', policySession, '--description', 'git policy scope']);
  });

  const preAs = (sessionId, command, tool = 'Bash') => JSON.parse(run('git-policy.mjs', [], {
    input: JSON.stringify({
      session_id: sessionId, cwd: PROJECT, hook_event_name: 'PreToolUse',
      tool_name: tool, tool_input: tool === 'Bash' ? { command } : { file_path: command },
    }),
  }).stdout || '{}');

  const pre = (command, tool = 'Bash') => preAs(policySession, command, tool);

  test('denies a git mutation with a usable reason', () => {
    const out = pre('git commit -m "wip"');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Hyperpowers Git policy/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /git status/, 'the denial should say what IS available');
  });

  test('stays neutral on an allowed read', () => {
    const out = pre('git status --short');
    assert.deepEqual(out, {}, 'allowed reads must not override the user\'s own permission rules');
  });

  test('denies writes into .git via the Write tool', () => {
    const out = pre('.git/hooks/pre-commit', 'Write');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('stays silent on ordinary file writes', () => {
    // Deliberately silence, not an explicit `allow`. An allow would override a deny rule the
    // user configured for their own reasons (`Write(secrets/**)`, say). This hook's mandate is
    // git internals; every other path stays the user's decision.
    const out = pre('src/app.py', 'Write');
    assert.deepEqual(out, {});
  });

  test('denies the Workflow tool', () => {
    const out = pre('', 'Workflow');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /state machine/);
  });

  test('fails closed on an unparseable payload', () => {
    const out = JSON.parse(run('git-policy.mjs', [], { input: 'not json at all' }).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  });

  // The policy belongs to a run, not to the installation. Before this was scoped, installing
  // the plugin removed `git commit` and the Workflow tool from every session in every project
  // for good — while the denial text claimed a run was in progress.
  test('stays out of a session with no Hyperpowers run', () => {
    assert.deepEqual(preAs('a-session-that-owns-nothing', 'git commit -m "my own work"'), {});
    assert.deepEqual(preAs('a-session-that-owns-nothing', 'git push origin main'), {});
    assert.deepEqual(preAs('a-session-that-owns-nothing', '', 'Workflow'), {});
  });

  test('releases the session once the run reaches a terminal phase', () => {
    const session = 'sess-terminal';
    const runId = json(sm(['init', '--session', session, '--description', 'terminal test'])).runId;
    assert.equal(preAs(session, 'git commit -m x').hookSpecificOutput.permissionDecision, 'deny');
    sm(['abort', '--run', runId, '--reason', 'done testing']);
    assert.deepEqual(preAs(session, 'git commit -m x'), {}, 'an aborted run must hand Git back');
  });

  test('git.enforce="always" restores the unconditional policy', () => {
    const config = path.join(PROJECT, '.hyperpowers.json');
    fs.writeFileSync(config, JSON.stringify({ git: { enforce: 'always' } }));
    try {
      const out = preAs('still-owns-nothing', 'git commit -m x');
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    } finally {
      fs.rmSync(config, { force: true });
    }
  });
});

describe('agent report validation', () => {
  // Its own run, because `submit` writes and a write into a finished run is refused (§S14) — and
  // the shared run above is deliberately driven into BLOCKED by the stall tests.
  let OWN;
  before(() => { OWN = json(sm(['init', '--session', 'sess-reports', '--description', 'report tests'])).runId; });

  const submit = (report, expectFail = false) => {
    const file = path.join(TMP, 'report.json');
    fs.writeFileSync(file, JSON.stringify(report));
    return run('validate-agent-report.mjs', ['submit', '--project', PROJECT, '--run', OWN, '--file', file], { expectFail });
  };

  const valid = {
    work_package_id: 'WP-001', agent: 'hyperpowers-sonnet-implementer', status: 'success',
    files_read: ['src/a.py'], files_modified: ['src/a.py'], commands_run: ['pytest -q'],
    results: [{ check: 'unit tests', expected: '3 passed', observed: '3 passed in 0.42s', passed: true }],
    unverified: ['concurrent access'], risks: [], evidence: ['tests/test_a.py::test_widget PASSED'],
    recommendation: 'Accept and proceed to verification.',
  };

  test('rejects a report that is not evidence-bearing', () => {
    const r = submit({ work_package_id: 'WP-001', agent: 'x', status: 'success' }, true);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /REJECTED/);
    assert.match(r.stderr, /results/);
  });

  test('rejects an assertion masquerading as an observation', () => {
    const r = submit({ ...valid, results: [{ check: 'tests', expected: 'pass', observed: 'ok', passed: true }] }, true);
    assert.match(r.stderr, /assertion, not an observation/);
  });

  test('rejects success contradicted by a failed result', () => {
    const r = submit({ ...valid, results: [{ check: 'tests', expected: '3 passed', observed: '1 failed', passed: false }] }, true);
    assert.match(r.stderr, /status is "success" but at least one result is marked failed/);
  });

  test('accepts and stores a complete report', () => {
    const out = JSON.parse(submit(valid).stdout);
    assert.equal(out.accepted, true);
    assert.ok(fs.existsSync(out.storedAt));
  });
});
