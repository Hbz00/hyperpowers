#!/usr/bin/env node
/**
 * PreToolUse hook — spec §14 (Git policy) and §16.5 (tool guardrails).
 *
 * Fails **closed**: any Bash command that cannot be classified as read-only is denied. That
 * is the whole point of spec §14.4 — the guarantee must not depend on a model respecting a
 * prompt.
 *
 * The hook also enforces the other deterministic rules the spec asks for: no writes into `.git/`,
 * no use of the Claude Code Workflow tool (§17), which would spawn an orchestration tree outside
 * the Hyperpowers state machine and outside its accounting, and no second director (§S13).
 *
 * **The fail directions differ, deliberately.** Git classification fails closed because that is the
 * guarantee. The dispatch rule below fails *open*, because a transient unreadable `state.json`
 * denying an `Agent` call would brick `/hyperpowers:feature` itself — and the cost of missing an
 * impostor is one wasted agent that the `SubagentStop` depth guard then ignores, while the cost of a
 * false deny is a plugin that cannot start.
 */

import path from 'node:path';
import fs from 'node:fs';
import { runHook, emitPreToolUse, projectRootFrom } from './lib/hookio.mjs';
import { classifyCommand, touchesGitInternals } from './lib/git-policy.mjs';
import { activeRunId, artifacts } from './lib/paths.mjs';
import { tryLoadState, directorIsDriving } from './lib/state.mjs';
import { DIRECTOR_AGENT, bareAgentName } from './lib/config.mjs';
import { stopAllowed } from './lib/phases.mjs';
import { loadConfig } from './lib/config.mjs';
import { logEvent } from './lib/telemetry.mjs';

/**
 * `MultiEdit` is kept although this Claude Code build does not expose it: the binary's
 * permission-rule normaliser still recognises the name, so it may return or exist in other
 * builds. Listing a tool that never fires costs nothing; omitting one that does is an unguarded
 * write into `.git/`. The matcher in `hooks/hooks.json` carries it for the same reason.
 */
const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Tools disabled outright during a run.
 *
 * `Workflow` would spawn an orchestration tree outside the state machine and its accounting
 * (spec §17). The worktree tools are the native equivalent of `git worktree`, which the Bash
 * classifier already denies — blocking one spelling and not the other left "Worktrees: interdits"
 * (spec §2) enforced by prompt alone for the one participant with no tool restrictions at all,
 * the main-thread director.
 */
const FORBIDDEN_TOOLS = new Set(['Workflow', 'EnterWorktree', 'ExitWorktree']);

/**
 * Is a Hyperpowers run actually driving this session?
 *
 * The policy used to apply unconditionally, which meant that *installing* the plugin removed
 * `git commit` and the Workflow tool from every session in every project, permanently — while
 * the denial text said "during a Hyperpowers run" when there was none. The guarantee belongs to
 * a run, not to the installation.
 *
 * `git.enforce: "always"` in `.hyperpowers.json` restores the unconditional behaviour for anyone
 * who wants a read-only-Git workspace as a standing rule.
 */
function policyApplies(input, projectRoot) {
  let config;
  try {
    config = loadConfig(projectRoot);
  } catch {
    config = null;
  }
  if (config?.git?.enforce === 'always') return { active: true, runId: null };

  const runId = input.session_id ? activeRunId(projectRoot, input.session_id) : null;
  if (!runId) return { active: false, runId: null };
  const state = tryLoadState(projectRoot, runId);

  // Corrupt is not the same as absent, and only one of them means "nothing to govern".
  //
  // Any unreadable state released the policy — a truncated write, an unsupported `schemaVersion` — so
  // `git commit`, a `.git/` write and the Workflow tool all became available in the one hook whose
  // contract is that anything it cannot classify is denied. A bound run whose phase is unknown is
  // exactly the unclassifiable case, and the fail-closed answer to it is to keep governing.
  //
  // Absent state is the other half and is not symmetric: `claude plugin uninstall` deletes the whole
  // data directory (§S25) while the session binding survives, and denying Git for ever on the strength
  // of a run that no longer exists would hold the user's repository hostage to a reinstall.
  if (!state) {
    const present = fs.existsSync(artifacts(projectRoot, runId).state);
    return { active: present, runId };
  }
  // A finished, aborted or suspended run no longer owns the session's Git.
  if (stopAllowed(state.phase)) return { active: false, runId };
  return { active: true, runId };
}

/** Path-bearing fields across the file-mutating tools. */
function pathsFrom(toolInput) {
  const out = [];
  for (const key of ['file_path', 'path', 'notebook_path', 'filePath']) {
    if (typeof toolInput?.[key] === 'string') out.push(toolInput[key]);
  }
  if (Array.isArray(toolInput?.edits)) {
    for (const e of toolInput.edits) if (typeof e?.file_path === 'string') out.push(e.file_path);
  }
  return out;
}

/**
 * Record a *blocked attempt*.
 *
 * This is `policy_blocked`, not `policy_violation`, and the distinction is load-bearing.
 * Prevention working is not a violation: the mutation never happened. Emitting
 * `policy_violation` here meant that a single blocked `git commit` — and even a blocked
 * `Workflow` call, which has nothing to do with Git — permanently failed completion condition
 * §13.11 ("no Git mutation was executed"). Telemetry is append-only, so the run could never
 * recover. `policy_violation` is now reserved for `git-guard.mjs`, which detects mutations that
 * actually occurred.
 */
function record(input, projectRoot, runId, detail) {
  if (!runId) return;
  try {
    logEvent(projectRoot, runId, {
      type: 'policy_blocked',
      tool: input.tool_name,
      decision: 'deny',
      detail,
    });
  } catch {
    /* telemetry is best-effort and must never influence the decision */
  }
}

await runHook(
  'git-policy',
  async (input) => {
    if (input.__parseError) {
      emitPreToolUse('deny', 'Hyperpowers Git policy: the hook payload could not be parsed, so the tool call cannot be verified.');
      return;
    }

    const tool = input.tool_name;
    const toolInput = input.tool_input ?? {};
    const projectRoot = projectRootFrom(input);

    // Outside a live run this plugin has no business governing the user's tools.
    const { active, runId } = policyApplies(input, projectRoot);
    if (!active) return;

    // --- one run, one director (§S13) ---------------------------------------------
    // Prevention to pair with the `SubagentStop` depth guard's detection, which is how this
    // codebase treats every rule it cannot express in one place (ADR 0003). The legitimate first
    // dispatch is never seen here: `/hyperpowers:feature` dispatches the director, and the director
    // creates the run — so there is no bound run to be active, and this hook has already returned.
    //
    // Wrapped and neutral on any error: see the fail-direction note in the file header.
    if (tool === 'Agent') {
      // --- no subagent may background a dispatch --------------------------------
      // The rule was prose in two agent files and absent from three, and the prose claimed an
      // enforcement that did not exist ("run_in_background is not available to you"): it is a
      // *parameter* of the Agent tool, which a `tools:` list cannot remove — run 9b's director
      // passed it and entered a six-hour wedge, because a backgrounded child's result never
      // returns to its dispatcher and no subagent has `TaskOutput` to collect it. Measured (§V3):
      // this payload carries `agent_id` exactly when the caller is a subagent, so the main
      // thread's own background dispatch of the director — the one legitimate case — is never
      // seen by this predicate. Fail-open on anything else, per the header: `agent_id` absent, or
      // any error, allows.
      try {
        if (input.agent_id && toolInput?.run_in_background === true) {
          const reason =
            `Hyperpowers: a subagent must not dispatch with \`run_in_background: true\`. The `
            + `result of a backgrounded child never returns to you, and you have no TaskOutput to `
            + `collect it — a child you cannot collect is a child you wait on forever (run 9b `
            + `spent six hours exactly there). To run work concurrently, issue several Agent `
            + `calls in one message; they run in parallel and each returns to you.`;
          record(input, projectRoot, runId, { tool, subagent_type: toolInput.subagent_type, background: true });
          emitPreToolUse('deny', reason);
          return;
        }
      } catch { /* fail open: never let this rule stop a dispatch it cannot classify */ }
      try {
        // `transcript_path` is on the PreToolUse payload (§D5), and it is what lets this rule work
        // during phase one: state does not learn the director's id until its first stop (§S40).
        //
        // The `replaceable` reservation is deliberately NOT consumed here. PreToolUse fires
        // before permission handling and before the tool runs, so consuming at this point spent
        // the one authorisation on dispatches that never started — a permission refusal or a
        // failed launch left `replaceable: false` with a dead director recorded, every retry
        // denied, and the Stop hook's `yielded !== true` branch allowing silently: a wedge with
        // no recovery instruction, reproduced. The reservation is committed only when the
        // replacement demonstrably exists — the director `SubagentStart`/`SubagentStop` id write
        // in `subagent-controller.mjs` clears the marker — so a failed dispatch leaves it open
        // and a retry just works. The price is that between a `SendMessage` revival (which no
        // hook can see) and that director's next stop, a duplicate dispatch would be allowed;
        // that needs the main thread to disobey its instruction, and the depth guard plus the id
        // flip detection bound the damage. A wedge on an ordinary failure is worse than a
        // misuse window on a double disobedience — run 9b is what a wedge costs.
        const st = tryLoadState(projectRoot, runId);
        if (bareAgentName(toolInput.subagent_type) === DIRECTOR_AGENT
            && directorIsDriving(st, input.transcript_path)) {
          const reason =
            `Hyperpowers: run ${runId} already has a director and it is driving. A second one holds `
            + `none of the run's context, and at depth 3 it cannot dispatch anything at all — a live `
            + `run grew both, and they took turns writing to the same state.\n\n`
            + `If you are the main thread and the director owes you a turn, resume it by id with `
            + `\`SendMessage\`. If you are a coordinator, you were never meant to dispatch the `
            + `director: write your decision packet and return it — the director is waiting for it. `
            + `A genuinely dead director is released by \`/hyperpowers:resume\`.`;
          record(input, projectRoot, runId, { tool, subagent_type: toolInput.subagent_type });
          emitPreToolUse('deny', reason);
          return;
        }
      } catch { /* fail open: never let this rule stop a dispatch it cannot classify */ }
      return;
    }

    if (FORBIDDEN_TOOLS.has(tool)) {
      const reason = tool.endsWith('Worktree')
        ? `Hyperpowers policy: worktrees are forbidden for the whole run (spec §2, §15). All work ` +
          `happens in the one working tree the user is watching, which is also the tree Codex ` +
          `reviews; parallel writers must own disjoint files instead. Git state is read-only, so ` +
          `there is nothing to isolate from.`
        : `Hyperpowers policy: the ${tool} tool is disabled during a Hyperpowers run. ` +
          `Orchestration happens through the Hyperpowers state machine and its agents so that ` +
          `every model invocation is bounded, attributed and recorded. Delegate with the Agent ` +
          `tool to a hyperpowers-* agent instead.`;
      record(input, projectRoot, runId, { tool });
      emitPreToolUse('deny', reason);
      return;
    }

    if (FILE_MUTATING_TOOLS.has(tool)) {
      const offending = pathsFrom(toolInput).find((p) => touchesGitInternals(p));
      if (offending) {
        const reason =
          `Hyperpowers Git policy: writing inside a .git directory is forbidden (${offending}). ` +
          `Git state is read-only for the duration of a run.`;
        record(input, projectRoot, runId, { tool, path: offending });
        emitPreToolUse('deny', reason);
        return;
      }
      // Stay silent rather than returning an explicit `allow`. An allow here would override a
      // deny rule the user configured for their own reasons (`Write(secrets/**)`, say). This
      // hook's mandate is git internals; everything else remains the user's decision.
      return;
    }

    if (tool !== 'Bash' && tool !== 'BashOutput' && tool !== 'KillShell') {
      // Not a tool this policy governs. Stay neutral so other permission rules still apply.
      return;
    }

    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return;

    const verdict = classifyCommand(command, {
      cwd: input.cwd ?? projectRoot,
      projectRoot: process.env.CLAUDE_PROJECT_DIR
        ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
        : projectRoot,
    });

    if (verdict.decision === 'deny') {
      const reason =
        `Hyperpowers Git policy — DENIED.\n${verdict.reason}\n\n` +
        `Git is read-only for the whole run (spec §14). Reads such as \`git status\`, ` +
        `\`git diff\`, \`git log\` and \`git show\` are available. Record what you would have ` +
        `committed in the run's evidence instead; the user performs all Git mutations.`;
      record(input, projectRoot, runId, { command, reason: verdict.reason });
      emitPreToolUse('deny', reason);
      return;
    }

    // Staying silent lets the user's own permission rules decide; an explicit allow here
    // would override deny rules the user configured for unrelated reasons.
  },
  (err) => {
    emitPreToolUse(
      'deny',
      `Hyperpowers Git policy could not evaluate this command and therefore denied it ` +
        `(fail-closed): ${err?.message ?? err}`,
    );
  },
  // PreToolUse is declared at 15 s in hooks.json; stay well inside it so the fail-closed deny
  // is actually emitted rather than the process being killed first.
  { budgetMs: 12_000 },
);
