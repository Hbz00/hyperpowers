import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate, assertSupported, SUPPORTED_KEYWORDS } from '../scripts/lib/validate.mjs';

const SCHEMA_DIR = path.resolve(import.meta.dirname, '..', 'schemas');
const load = (name) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));

describe('validator core', () => {
  test('type checking, including integer vs number', () => {
    assert.ok(validate(1, { type: 'integer' }).valid);
    assert.ok(!validate(1.5, { type: 'integer' }).valid);
    assert.ok(validate(1.5, { type: 'number' }).valid);
    assert.ok(validate(null, { type: ['string', 'null'] }).valid);
    assert.ok(!validate([], { type: 'object' }).valid);
  });

  test('required, enum, pattern, bounds', () => {
    const s = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string', enum: ['x', 'y'] },
        b: { type: 'string', pattern: '^WP-[0-9]+$' },
        c: { type: 'number', minimum: 0, maximum: 1 },
      },
    };
    assert.ok(validate({ a: 'x' }, s).valid);
    assert.match(validate({}, s).errors[0], /missing required property 'a'/);
    assert.match(validate({ a: 'z' }, s).errors[0], /must be one of/);
    assert.match(validate({ a: 'x', b: 'nope' }, s).errors[0], /pattern/);
    assert.match(validate({ a: 'x', c: 2 }, s).errors[0], /above maximum/);
  });

  test('additionalProperties false is enforced', () => {
    const s = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
    assert.ok(validate({ a: 'ok' }, s).valid);
    assert.match(validate({ a: 'ok', extra: 1 }, s).errors[0], /unexpected property 'extra'/);
  });

  test('array items and minItems', () => {
    const s = { type: 'array', minItems: 1, items: { type: 'string' } };
    assert.ok(validate(['a'], s).valid);
    assert.match(validate([], s).errors[0], /at least 1 item/);
    assert.match(validate([1], s).errors[0], /expected string/);
  });

  test('if/then conditional', () => {
    const s = {
      type: 'object',
      properties: { kind: { type: 'string' }, detail: { type: 'string' } },
      if: { properties: { kind: { const: 'x' } }, required: ['kind'] },
      then: { required: ['detail'] },
    };
    assert.ok(validate({ kind: 'y' }, s).valid);
    assert.ok(!validate({ kind: 'x' }, s).valid);
    assert.ok(validate({ kind: 'x', detail: 'd' }, s).valid);
  });

  test('nested error paths are reported', () => {
    const s = { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } } };
    const { errors } = validate({ a: [{ b: 1 }] }, s);
    assert.match(errors[0], /\(root\)\.a\[0\]\.b/);
  });
});

describe('shipped schemas', () => {
  const names = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'));

  test('every schema is inside the supported keyword subset', () => {
    const problems = names.flatMap((n) => assertSupported(load(n), `#${n}`));
    assert.deepEqual(problems, [], `unsupported keywords found:\n${problems.join('\n')}`);
  });

  test('the supported-keyword list contains no inert entries', () => {
    // The subset test above can only be trusted if every keyword it blesses actually enforces
    // something. `propertyNames` and `prefixItems` were listed but never implemented, so any
    // schema using them passed both the subset check and validation itself — a constraint that
    // silently did nothing, with green tests either side of it. Each entry is now shown a value
    // it must reject.
    const counterexamples = {
      type: [{ type: 'string' }, 42],
      const: [{ const: 'a' }, 'b'],
      enum: [{ enum: ['a'] }, 'b'],
      required: [{ type: 'object', required: ['a'] }, {}],
      properties: [{ type: 'object', properties: { a: { type: 'string' } } }, { a: 1 }],
      additionalProperties: [{ type: 'object', properties: {}, additionalProperties: false }, { x: 1 }],
      items: [{ type: 'array', items: { type: 'string' } }, [1]],
      minItems: [{ type: 'array', minItems: 2 }, [1]],
      maxItems: [{ type: 'array', maxItems: 1 }, [1, 2]],
      uniqueItems: [{ type: 'array', uniqueItems: true }, [1, 1]],
      minLength: [{ type: 'string', minLength: 3 }, 'ab'],
      maxLength: [{ type: 'string', maxLength: 1 }, 'ab'],
      pattern: [{ type: 'string', pattern: '^a$' }, 'b'],
      minimum: [{ type: 'number', minimum: 5 }, 1],
      maximum: [{ type: 'number', maximum: 5 }, 9],
      exclusiveMinimum: [{ type: 'number', exclusiveMinimum: 5 }, 5],
      exclusiveMaximum: [{ type: 'number', exclusiveMaximum: 5 }, 5],
      allOf: [{ allOf: [{ type: 'string' }] }, 1],
      anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, true],
      oneOf: [{ oneOf: [{ type: 'string' }] }, 1],
      not: [{ not: { type: 'string' } }, 'a'],
      if: [{ if: { const: 'a' }, then: { type: 'number' } }, 'a'],
      then: [{ if: { const: 'a' }, then: { type: 'number' } }, 'a'],
      else: [{ if: { const: 'a' }, else: { type: 'number' } }, 'b'],
      $ref: [{ $defs: { s: { type: 'string' } }, $ref: '#/$defs/s' }, 1],
      $defs: [{ $defs: { s: { type: 'string' } }, $ref: '#/$defs/s' }, 1],
    };
    // Annotations carry no constraint by definition; everything else must bite.
    const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples']);
    const inert = [];
    for (const keyword of SUPPORTED_KEYWORDS) {
      if (ANNOTATIONS.has(keyword)) continue;
      const example = counterexamples[keyword];
      if (!example) { inert.push(`${keyword}: no counterexample — cannot prove it is enforced`); continue; }
      const [schema, value] = example;
      if (validate(value, schema).valid) inert.push(`${keyword}: accepted a value it should reject`);
    }
    assert.deepEqual(inert, [], `keywords advertised as supported but not enforced:\n${inert.join('\n')}`);
  });

  test('an unsupported keyword hidden in $defs is still reported', () => {
    // `validate` resolves `$ref` into `$defs`, so a keyword there is as live as one at the root —
    // but the traversal never looked inside, making the subset check blind exactly where a schema
    // author would put shared definitions.
    const schema = {
      type: 'object',
      $defs: { entry: { type: 'object', patternProperties: { '^x-': { type: 'string' } } } },
      properties: { a: { $ref: '#/$defs/entry' } },
    };
    const problems = assertSupported(schema);
    assert.ok(problems.some((p) => /patternProperties/.test(p)), `expected patternProperties to be reported, got: ${problems.join(', ')}`);
  });

  test('agent-report rejects a bare "Done."', () => {
    const schema = load('agent-report.schema.json');
    const bare = { work_package_id: 'WP-001', agent: 'sonnet-implementer', status: 'success' };
    const { valid, errors } = validate(bare, schema);
    assert.equal(valid, false);
    // Spec §16.4: the report must carry evidence, not an assertion.
    assert.ok(errors.some((e) => /results/.test(e)));
    assert.ok(errors.some((e) => /evidence/.test(e)));
    assert.ok(errors.some((e) => /unverified/.test(e)));
  });

  test('agent-report accepts a complete report', () => {
    const schema = load('agent-report.schema.json');
    const report = {
      work_package_id: 'WP-001',
      agent: 'hyperpowers-sonnet-implementer',
      status: 'success',
      files_read: ['src/a.py'],
      files_modified: ['src/a.py'],
      commands_run: ['pytest -q tests/test_a.py'],
      results: [{ check: 'unit tests', expected: '3 passed', observed: '3 passed', passed: true }],
      unverified: ['behaviour under concurrent writes'],
      risks: ['no integration coverage'],
      evidence: ['tests/test_a.py::test_widget PASSED'],
      recommendation: 'Accept; add an integration test in a follow-up package.',
    };
    const { valid, errors } = validate(report, schema);
    assert.equal(valid, true, errors.join('; '));
  });

  test('adjudication requires a change and a verification when accepted', () => {
    const schema = load('adjudication.schema.json');
    const bad = {
      finding_id: 'DESIGN-001', decision: 'accepted',
      rationale: 'The reviewer is right about the race condition here.',
      correction_owner: 'opus', escalate_to_fable: false,
    };
    assert.equal(validate(bad, schema).valid, false);
    const good = { ...bad, required_change: 'Serialise writes through the queue.', verification: 'Add a concurrency test that fails today.' };
    assert.equal(validate(good, schema).valid, true, validate(good, schema).errors.join('; '));
  });

  test('adjudication requires duplicate_of when marked duplicate', () => {
    const schema = load('adjudication.schema.json');
    const bad = {
      finding_id: 'PLAN-004', decision: 'duplicate',
      rationale: 'Already raised in the first round under another id.',
      correction_owner: 'none', escalate_to_fable: false,
    };
    assert.equal(validate(bad, schema).valid, false);
    assert.equal(validate({ ...bad, duplicate_of: 'PLAN-001' }, schema).valid, true);
  });

  test('work package rejects a contract without acceptance criteria', () => {
    const schema = load('work-package.schema.json');
    const wp = {
      id: 'WP-001', objective: 'Implement the widget counter as specified.',
      scope: { files: ['src/a.py'], owned_files: ['src/a.py'] },
      interfaces: 'count() -> int', constraints: 'No new dependencies.',
      verification: { method: 'pytest', commands: ['pytest -q'] },
      acceptance_criteria: [], out_of_scope: ['UI'], report_format: 'agent-report.schema.json',
      status: 'pending',
    };
    assert.equal(validate(wp, schema).valid, false);
    assert.equal(validate({ ...wp, acceptance_criteria: ['AC-1'] }, schema).valid, true);
  });

  test('codex output schema round-trips a real Codex response', () => {
    const schema = load('codex-review-output.schema.json');
    const real = {
      verdict: 'blocker',
      summary: 'The counter is process-local behind a load balancer.',
      findings: [{
        id: 'DESIGN-001', severity: 'critical', category: 'correctness',
        location: 'counter module', claim: 'A module-level variable is isolated per process.',
        evidence: ['four web server processes behind a load balancer'],
        recommendation: 'Move the counter to shared storage.', blocking: true, confidence: 0.95,
      }],
      residual_risks: [], coverage_notes: '',
    };
    const { valid, errors } = validate(real, schema);
    assert.equal(valid, true, errors.join('; '));
  });

  test('finding ids must follow the stable-identifier pattern', () => {
    const schema = load('finding.schema.json');
    const base = {
      id: 'DESIGN-001', severity: 'high', category: 'architecture', artifact: 'design',
      round: 'design-1', location: 'data-model', claim: 'x', evidence: [], recommendation: 'y',
      blocking: true, confidence: 0.5,
    };
    assert.equal(validate(base, schema).valid, true);
    assert.equal(validate({ ...base, id: 'oops' }, schema).valid, false);
    assert.equal(validate({ ...base, round: 'design-9' }, schema).valid, false);
  });
});
