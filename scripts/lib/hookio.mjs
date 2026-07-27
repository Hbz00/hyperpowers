/**
 * Hook transport: stdin payload in, JSON decision out.
 *
 * Payload shapes below are the ones observed on Claude Code 2.1.220 (validation ledger D2/D5),
 * not guesses. Every field is read defensively anyway, because a hook that throws on an
 * unexpected payload would take the whole session down with it.
 */

export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: true, __raw: raw };
  }
}

/** PreToolUse: allow / deny / ask. `reason` is shown to the model verbatim. */
export function emitPreToolUse(decision, reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

/** Stop / SubagentStop: block forces another turn, with `reason` injected as the instruction. */
export function emitBlock(reason) {
  emit({ decision: 'block', reason });
}

export function emitAllowStop(systemMessage) {
  emit(systemMessage ? { systemMessage } : {});
}

/** SessionStart / UserPromptSubmit: inject context without changing control flow. */
export function emitContext(hookEventName, additionalContext) {
  emit({ hookSpecificOutput: { hookEventName, additionalContext } });
}

export function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

/**
 * Run a hook body with a hard guarantee that it terminates and produces valid output.
 *
 * `onError` decides the fail direction per hook: the Git policy fails *closed* (an
 * unclassifiable command is denied), while advisory hooks fail *open* so an internal bug
 * cannot wedge a session.
 */
export async function runHook(name, body, onError, { budgetMs } = {}) {
  // This MUST fire before the timeout declared for this hook in hooks/hooks.json, or the
  // harness kills the process first and `onError` never runs — which, for the fail-closed Git
  // policy, silently turns a deny into an allow. A single shared 25 s default exceeded the
  // 15 s and 20 s declarations, so the guarantee was false as written; each caller now passes
  // its own budget and the default is small enough to be safe if one forgets.
  const limit = Number(process.env.HYPERPOWERS_HOOK_TIMEOUT_MS ?? budgetMs ?? 10_000);
  const timeout = setTimeout(() => {
    try {
      onError(new Error(`${name} hook exceeded its ${limit} ms budget`));
    } finally {
      process.exit(0);
    }
  }, limit);
  timeout.unref?.();

  try {
    const input = await readHookInput();
    await body(input);
  } catch (err) {
    try {
      onError(err);
    } catch {
      /* last resort: stay silent rather than crash the session */
    }
  } finally {
    clearTimeout(timeout);
    process.exit(0);
  }
}

/** Resolve the project root a hook is acting on. */
export function projectRootFrom(input) {
  return input?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}
