#!/usr/bin/env node
/**
 * PreToolUse hook — spec §14 (Git policy) and §16.5 (tool guardrails).
 *
 * Fails **closed**: any Bash command that cannot be classified as read-only is denied. That
 * is the whole point of spec §14.4 — the guarantee must not depend on a model respecting a
 * prompt.
 *
 * The hook also enforces the two other deterministic rules the spec asks for: no writes into
 * `.git/`, and no use of the Claude Code Workflow tool (§17), which would spawn an
 * orchestration tree outside the Hyperpowers state machine and outside its accounting.
 */

import path from 'node:path';
import { runHook, emitPreToolUse, projectRootFrom } from './lib/hookio.mjs';
import { classifyCommand, touchesGitInternals } from './lib/git-policy.mjs';
import { activeRunId } from './lib/paths.mjs';
import { tryLoadState } from './lib/state.mjs';
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
  // A finished, aborted or suspended run no longer owns the session's Git.
  if (!state || stopAllowed(state.phase)) return { active: false, runId };
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
