#!/usr/bin/env node
/**
 * PostToolUse Git guard — the detection half of the Git policy.
 *
 * `git-policy.mjs` prevents mutations it can *classify*. It cannot classify what an opaque
 * script does: `npm run release`, `./deploy.sh` and `make publish` are black boxes, and no
 * static analysis of the Bash command reveals whether they call `git commit`.
 *
 * So prevention is paired with detection. After every Bash call this hook compares a cheap
 * fingerprint of the repository — HEAD, the ref set, the index mtime, the stash — against the
 * previous observation. A change means a mutation happened despite the policy, which is
 * recorded as a POLICY_VIOLATION and surfaced immediately rather than being discovered at the
 * completion gate.
 *
 * It reports; it does not attempt to undo anything. Undoing would itself be a Git mutation,
 * and guessing at recovery on a user's repository is far more dangerous than reporting
 * honestly and stopping.
 */

import { runHook, emitContext, emitAllowStop, projectRootFrom } from './lib/hookio.mjs';
import { activeRunId, artifacts } from './lib/paths.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { tryLoadState, mutateState } from './lib/state.mjs';
import { stopAllowed } from './lib/phases.mjs';
import { logEvent } from './lib/telemetry.mjs';
// The producer is shared, not duplicated: `init` and `resume` stamp the same object this guard
// diffs, so the baseline exists *before* the first opaque Bash call instead of being absorbed
// from it. Re-declaring the field set here would let the two drift — `describeDrift` tolerates a
// missing key by design, so a drifted producer silently stops escalating that field.
import { gitFingerprint, fingerprintPath } from './lib/git-fingerprint.mjs';

/**
 * Which fields changed, split by whether the change can only have been a mutation.
 *
 * `escalating` drift fails spec §13 condition 11. `observed` drift is recorded, named to the
 * model and printed in the final report, but never fails the run.
 *
 * **What is not here at all: an index file rewritten with identical staged content.** Ordinary
 * reads refresh the index, *including this guard's own fingerprinting*, so it fires on a run
 * doing nothing but reading — 5 records from 12 read cycles, measured. It is therefore neither
 * escalated nor recorded, and saying so beats the previous arrangement, which computed the line,
 * filtered it out of the only list it wrote, and described that as "recorded but never
 * escalated". A signal a guard generates itself is not evidence about anything.
 */
function describeDrift(before, after) {
  const escalating = [];
  const observed = [];
  if (before.head !== after.head) escalating.push(`HEAD moved ${before.head.slice(0, 8)} → ${after.head.slice(0, 8)} (a commit, reset, checkout or merge occurred)`);
  if (before.branch !== after.branch) escalating.push(`branch changed "${before.branch}" → "${after.branch}"`);
  if (before.refs !== after.refs) escalating.push('the ref set changed (a branch or tag was created, moved or deleted)');
  if (before.stash !== after.stash) escalating.push('the stash changed');
  if (before.staged !== after.staged) escalating.push('the index changed (content was staged or unstaged)');

  // `before.config` is absent on a fingerprint written by an older build; treating that as drift
  // would fail a run for upgrading mid-flight.
  //
  // Observed, never escalating, and that is a measurement rather than a preference: a *cold*
  // `npm install` in any project using husky or lefthook sets `core.hooksPath`, so the very act
  // of preparing a workspace for verification moves this hash. Reproduced. Failing §13.11 there
  // would end a healthy run for a package manager doing precisely what the project asked of it.
  // Unlike an index refresh it is rare and it is meaningful, so it is worth recording.
  //
  // Filtering by key cannot rescue escalation: `core.hooksPath` is simultaneously the benign
  // case and the most direct hijack there is, so no allowlist separates them. What detection can
  // honestly offer is visibility — and prevention keeps its own line, since both `git config`
  // and writes into `.git/` are refused before they execute.
  if (before.config !== undefined && before.config !== after.config) {
    observed.push('the local Git config changed (a remote, hooksPath, identity or similar was rewritten)');
  }
  return { escalating, observed };
}

await runHook(
  'git-guard',
  async (input) => {
    const projectRoot = projectRootFrom(input);
    const runId = input.session_id ? activeRunId(projectRoot, input.session_id) : null;
    const state = runId ? tryLoadState(projectRoot, runId) : null;
    if (!state) return emitAllowStop();

    /**
     * Detection follows prevention out of the room.
     *
     * `git-policy.mjs` deliberately releases Git when the run is suspended or over — the
     * guarantee belongs to a run, not to an installation. This hook did not, so it kept
     * fingerprinting a repository whose Git the policy had just handed back. A user who accepted
     * that invitation and committed during a suspension had it recorded as a `policy_violation`,
     * and telemetry is append-only: condition §13.11 then failed for the rest of the run, for
     * doing the one thing the run had just told them they were free to do. After `COMPLETE` or
     * `ABORTED` the same writes landed in a finished run's record, quietly rewriting its history.
     *
     * The two halves must agree on when the policy is in force, so both read `stopAllowed`. This
     * returns before fingerprinting rather than after, so a session that stays bound to a
     * finished run also stops paying six `git` subprocesses per Bash call. `/hyperpowers:resume`
     * re-stamps a *fresh* snapshot after a suspension, which is what makes an early return safe:
     * the resumed run is measured from the moment it takes Git back, not blamed for what the
     * user legitimately did while it was stopped — and, unlike the deletion this replaces, a
     * mutation inside the first post-resume Bash call is still seen.
     */
    if (stopAllowed(state.phase)) return emitAllowStop();

    const current = gitFingerprint(projectRoot);
    if (!current) return emitAllowStop();

    const a = artifacts(projectRoot, runId);
    const snapshotPath = fingerprintPath(a.base);
    const previous = readJson(snapshotPath, null);
    writeJson(snapshotPath, current);

    if (!previous) return emitAllowStop(); // first observation establishes the baseline
    // A fingerprint from a different producer version cannot be compared field-by-field — every
    // hashed field would read as drift, failing §13.11 for the act of upgrading the plugin
    // mid-run. The new snapshot just written becomes the baseline.
    if (previous.v !== current.v) return emitAllowStop();

    const { escalating, observed } = describeDrift(previous, current);
    if (escalating.length === 0 && observed.length === 0) return emitAllowStop();

    const command = input.tool_input?.command ?? null;
    const all = [...escalating, ...observed];

    // Recorded either way, and flagged with which kind it was. The previous version *claimed*
    // non-escalating drift was "recorded but never escalated" and in fact discarded it: the
    // filtered list was the only thing written, so when nothing survived the filter the hook
    // returned before writing at all. A category that exists only in a comment is not a category.
    mutateState(projectRoot, runId, (s) => {
      s.gitDrift = [...(s.gitDrift ?? []), {
        at: new Date().toISOString(), drift: all, command, escalated: escalating.length > 0,
      }];
    });

    if (escalating.length === 0) {
      // Visible to the model, absent from §13.11. Neither silence nor a failed run.
      logEvent(projectRoot, runId, { type: 'git_drift_observed', command, drift: observed });
      emitContext(
        'PostToolUse',
        `HYPERPOWERS GIT NOTICE — Git state moved in a way that is not, on its own, evidence of a ` +
          `mutation:\n${observed.map((d) => `  - ${d}`).join('\n')}\n\nTriggering command: ` +
          `${command ?? '(unknown)'}\n\nThis is recorded and will appear in the final report; it does ` +
          `not fail the run. Ordinary tooling produces these — a cold \`npm install\` in a project ` +
          `using husky sets \`core.hooksPath\`, and any read can refresh the index. If you did not ` +
          `expect it, say so in the report rather than trying to undo it.`,
      );
      return;
    }

    logEvent(projectRoot, runId, {
      type: 'policy_violation', kind: 'git_mutation_detected', command, drift: escalating,
    });

    emitContext(
      'PostToolUse',
      `HYPERPOWERS GIT POLICY VIOLATION — repository state changed during a run that forbids Git mutation.\n` +
        escalating.map((d) => `  - ${d}`).join('\n') +
        (observed.length ? `\nAlso observed (not escalated): ${observed.join('; ')}\n` : '') +
        `\n\nTriggering command: ${command ?? '(unknown)'}\n\n` +
        `This was almost certainly an indirect mutation from a script or task runner, since direct ` +
        `Git mutations are blocked before they execute. Do NOT attempt to undo it — reverting is ` +
        `itself a Git mutation and is equally forbidden. Record what happened in the run evidence, ` +
        `stop using the command that caused it, and report the drift to the user in the final ` +
        `report. Spec §13 condition 11 will fail this run at the completion gate.`,
    );
  },
  () => emitAllowStop(),
  { budgetMs: 16_000 }, // PostToolUse is declared at 20 s in hooks.json
);
