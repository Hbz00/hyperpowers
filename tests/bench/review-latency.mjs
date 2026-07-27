#!/usr/bin/env node
/**
 * Codex review latency benchmark.
 *
 * The six mandatory rounds sit on the critical path of every run, so their latency is the
 * dominant fixed cost of the architecture. This measures it against the real CLI rather than
 * estimating it.
 *
 *   node tests/bench/review-latency.mjs [--model gpt-5.6-luna] [--efforts low,high,xhigh] [--runs 1]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from '../../scripts/lib/cli.mjs';

const { flags } = parseArgs();
const model = flags.model ?? 'gpt-5.6-luna';
const efforts = String(flags.efforts ?? 'low,high').split(',');
const runs = Number(flags.runs ?? 1);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const schema = path.join(ROOT, 'schemas', 'codex-review-output.schema.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-bench-'));
const doc = path.join(tmp, 'design.md');
fs.writeFileSync(doc, `# Design — request counter

Each API process keeps an in-memory dict \`counts[client_id]\`. Every request increments it.
A background thread clears the dict every 60 seconds. We run 8 workers behind nginx and
autoscale to 10 machines. No locking is needed because of the GIL.

## Acceptance criteria
- AC-1: a client over 100 requests per minute gets HTTP 429.
- AC-2: it works.
`);

const prompt = `Adversarially review the design below. Report findings against the provided schema.

${fs.readFileSync(doc, 'utf8')}`;

const timeoutMs = Number(flags.timeout ?? 20 * 60 * 1000);

function once(effort) {
  return new Promise((resolve) => {
    const out = path.join(tmp, `out-${effort}-${Date.now()}.json`);
    const started = Date.now();
    // Same invocation the adapter builds. Kept in sync by hand is a known weakness; the fields
    // that matter (model, effort, sandbox, schema, output file) are asserted by the adapter's
    // own tests, and a drift here only mismeasures, never misgoverns.
    const child = spawn('codex', [
      'exec', '--model', model, '-c', `model_reasoning_effort="${effort}"`,
      '--sandbox', 'read-only', '--ignore-user-config', '--skip-git-repo-check',
      '-C', tmp, '--output-schema', schema, '-o', out, '--color', 'never',
    ], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    // A benchmark of the "review that never returns" failure mode must not itself hang forever
    // when it reproduces exactly that.
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      let findings = null;
      let ok = false;
      try {
        const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
        findings = parsed.findings?.length ?? 0;
        ok = true;
      } catch { /* failed run */ }
      const tokens = Number(/tokens used\s+([\d\s]+)/i.exec(log)?.[1]?.replace(/\s/g, '') ?? 0);
      resolve({ effort, ms, ok, findings, tokens });
    });
    child.stdin.end(prompt);
  });
}

const rows = [];
for (const effort of efforts) {
  for (let i = 0; i < runs; i += 1) {
    process.stderr.write(`running ${model} @ ${effort} (${i + 1}/${runs})…\n`);
    rows.push(await once(effort));
  }
}

console.log(`\nCodex review latency — ${model}\n`);
console.log('| effort | ok | seconds | findings | tokens |');
console.log('| --- | --- | ---: | ---: | ---: |');
for (const r of rows) {
  console.log(`| ${r.effort} | ${r.ok ? 'yes' : 'NO'} | ${(r.ms / 1000).toFixed(1)} | ${r.findings ?? '—'} | ${r.tokens || '—'} |`);
}
const okRows = rows.filter((r) => r.ok);
if (okRows.length) {
  const total = okRows.reduce((s, r) => s + r.ms, 0) / okRows.length;
  console.log(`\nMean successful round: ${(total / 1000).toFixed(1)}s.`);
  console.log(`Six rounds at this latency ≈ ${((total * 6) / 60000).toFixed(1)} minutes of critical path.`);
}
fs.rmSync(tmp, { recursive: true, force: true });
