#!/usr/bin/env node
/**
 * Stop hook — the autonomy loop (spec §16).
 *
 * Replaces `/goal`. On every attempt to end the turn it reads the run's persisted state and
 * either allows the stop or blocks it with the next action, computed from the phase table
 * rather than from anything the model said.
 *
 * Two measured behaviours shape this design:
 *
 *  - A blocked Stop continues the *same* turn, which preserves the Fable model pin
 *    (ledger B2). The whole feature therefore runs in one turn.
 *  - Consecutive blocks are capped by the harness (ledger D4). The controller yields a few
 *    blocks early into `SUSPENDED` so a run ends resumable instead of truncated.
 *
 * It also enforces spec §16.3: raising the cap is not enough, the machine must prove progress
 * between continuations. A run that keeps stopping without changing its state signature is
 * escalated and finally blocked.
 */

import fs from 'node:fs';
import { runHook, emitBlock, emitAllowStop, projectRootFrom } from './lib/hookio.mjs';
import { activeRunId, artifacts } from './lib/paths.mjs';
import { tryLoadState, mutateState, transition, pendingErrand } from './lib/state.mjs';
import { PHASES, stopAllowed, isTerminal } from './lib/phases.mjs';
import { loadConfig, softBlockCap } from './lib/config.mjs';
import { logEvent, summarise } from './lib/telemetry.mjs';
import { directorSubagent } from './lib/transcript.mjs';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? '${CLAUDE_PLUGIN_ROOT}';

/**
 * Count this block against the main thread's turn, and reset on the way out.
 *
 * One counter, every block through it — the same correction the subagent controller needed, for the
 * same reason. The harness caps *consecutive* blocks and never asks which branch emitted them, so the
 * errand branches returning before the counter meant those blocks spent the ceiling without being
 * spent here; and nothing reset it on an allowed stop, so a run that alternated block, allow, block
 * accumulated towards `SUSPENDED` for blocks the harness had already forgotten.
 *
 * `promptId` stays as a second reset: a new user message is a new series too.
 */
function countTurnBlock(projectRoot, runId, promptId) {
  return mutateState(projectRoot, runId, (s) => {
    if (s.turn.promptId !== promptId) s.turn = { promptId, blocks: 0 };
    s.turn.blocks += 1;
    return s.turn.blocks;
  });
}

/** Let the turn end, and end the block series with it. */
function allowStop(projectRoot, runId, message) {
  try {
    mutateState(projectRoot, runId, (s) => { s.turn = { ...s.turn, blocks: 0 }; });
  } catch { /* the stop still has to be allowed */ }
  return emitAllowStop(message);
}

/**
 * Yield the *run*, resumably. `SUSPENDED` means only one thing: the **main thread** is out of blocks.
 *
 * Reached from either blocking branch — the errand relay and the generic nudge — because the harness's
 * ceiling belongs to the turn and not to a reason.
 */
function suspend(projectRoot, runId, state, config, blocks, errand = null) {
  transition(projectRoot, runId, 'SUSPENDED', {
    actor: 'system',
    note: `main thread yielded at ${blocks} continuations (cap ${config.stop.blockCap})`
      + `${errand ? `; ${errand.kind} errand still pending` : ''}`,
  });
  logEvent(projectRoot, runId, {
    type: 'suspended', blocks, cap: config.stop.blockCap, thread: 'main',
    ...(errand ? { pending: errand.kind } : {}),
  });
  // Naming the errand matters: resuming clears the block count but not the errand, so a suspension the
  // user cannot see the cause of is one they will resume straight back into.
  return allowStop(projectRoot, runId,
    `Hyperpowers suspended run ${runId}: the main thread was asked ${blocks} times to move it on and `
      + `did not.${errand === null ? '' : errand.kind === 'publish'
        ? ` It still owes the run one thing — publishing \`${errand.title}\` from ${errand.file} with the `
          + `Artifact tool, then \`state-machine.mjs published --run ${runId} --url <url>\`.`
        : ` It still owes the run one thing — rendering ${errand.questions.length} question(s) with `
          + `AskUserQuestion, then \`state-machine.mjs answer --run ${runId} --json '["…"]'\`.`}`
      + ` Phase ${state.phase} is preserved — run \`/hyperpowers:resume\` to continue.`);
}

/**
 * The id of the director to resume, from the record if it has one and from disk if it does not.
 *
 * State is late by construction (§S40): no hook observes the director's start, so until its first stop
 * `directorTurn.agentId` is null — and every relay message then fell back to `Agent →
 * hyperpowers-director`, a **cold** dispatch that re-reads the request, the design and the plan to
 * rebuild what the live agent is already holding. Run 8 spent $15.48 — 30% of the run — on exactly that
 * kind of re-prefill (§T2).
 */
function directorToResume(state, transcriptPath) {
  if (state.directorTurn?.agentId) return state.directorTurn.agentId;
  try {
    const found = transcriptPath ? directorSubagent(transcriptPath) : null;
    return found?.spawnDepth === 1 ? found.agentId : null;
  } catch {
    return null;
  }
}

/**
 * Run 7: the director published an Artifact itself, got a valid URL, recorded it — and no page ever
 * opened, because the surface that opens one belongs to this thread. Publishing has to happen *before*
 * `COMPLETE`, since a finished run refuses further writes (§S14), which is why it parks like a
 * question rather than being tidied up afterwards.
 */
function publishMessage(runId, errand, state, resume) {
  return [
    `HYPERPOWERS — run ${runId}: the director needs you to publish a page.`,
    '',
    `Title: ${errand.title}`,
    `File:  ${errand.file}`,
    '',
    'Publish it with the `Artifact` tool — you are the only participant whose publication the user '
      + 'actually sees. Then record the URL and put the director back to work:',
    '',
    `  node "${PLUGIN_ROOT}/scripts/state-machine.mjs" published --run ${runId} --url "<url>"`,
    resume
      ? `  SendMessage → \`${resume}\`  ("published, continue run ${runId}")`
      : '  (no director agent recorded yet — dispatch `hyperpowers:hyperpowers-director`)',
  ].join('\n');
}

/**
 * The one thing the main thread can do that the director cannot (§R1), named precisely.
 *
 * The last line is conditional because the errand check now runs *before* the `yielded` flag, so this
 * message can reach a thread whose director is still driving — and in that case `git-policy` **denies**
 * a fresh director dispatch (§S13). Telling the main thread to do something the hook will refuse is how
 * a run wedges: it is blocked, it obeys, it is denied, and it has nowhere left to go.
 */
function questionMessage(projectRoot, runId, errand, state, resume) {
  return [
    `HYPERPOWERS — run ${runId}: the director is waiting on the user.`,
    '',
    `It asked ${errand.questions.length} question(s) during ${errand.phase}. They are in:`,
    `  ${artifacts(projectRoot, runId).question}`,
    '',
    'Read that file and render its `questions` with `AskUserQuestion`, **verbatim** — same wording, '
      + 'same options, same order. Do not add options, do not answer on the user\'s behalf, and do '
      + 'not resolve it yourself because it looks obvious.',
    '',
    'Then record the reply:',
    `  node "${PLUGIN_ROOT}/scripts/state-machine.mjs" answer --run ${runId} --json '["…"]'`,
    '',
    ...(state.directorTurn?.yielded !== true && resume
      ? [`The director (\`${resume}\`) is still running and reads the answer from its run directory `
        + 'itself, so do not dispatch another one — a second director is denied, and it would hold none '
        + 'of this run\'s context.']
      : [resume
        ? `  SendMessage → \`${resume}\`  ("answered, continue run ${runId}")`
        : `  Agent → hyperpowers:hyperpowers-director  ("resume run ${runId}")`]),
  ].join('\n');
}

await runHook(
  'stop-controller',
  async (input) => {
    const projectRoot = projectRootFrom(input);
    const sessionId = input.session_id;
    const runId = sessionId ? activeRunId(projectRoot, sessionId) : null;

    // No Hyperpowers run bound to this session: stay out of the way entirely.
    if (!runId) return emitAllowStop();

    const state = tryLoadState(projectRoot, runId);
    if (!state) {
      // "No state" and "unreadable state" are different facts and must not look alike. A run
      // whose state.json is corrupt or on an unsupported schema silently stopped being governed:
      // the hook emitted the same empty payload it uses when no run exists, so the loop
      // disengaged with nothing said to anyone.
      const present = fs.existsSync(artifacts(projectRoot, runId).state);
      return emitAllowStop(
        present
          ? `Hyperpowers run ${runId} has an unreadable state.json, so its autonomy loop is not ` +
            `running. Nothing is governing this session. Inspect it with \`/hyperpowers:status\`, ` +
            `or start a new run — the artefacts of the old one remain on disk.`
          : undefined,
      );
    }

    const config = loadConfig(projectRoot);

    if (stopAllowed(state.phase)) {
      const summary = isTerminal(state.phase) ? summarise(projectRoot, runId) : null;
      return allowStop(projectRoot, runId,
        summary
          ? `Hyperpowers run ${runId} ended in ${state.phase}. ${summary.workPackages} work `
            + `packages, ${summary.codexRounds} Codex rounds. Run \`/hyperpowers:status\` for the `
            + `full breakdown.`
          : `Hyperpowers run ${runId} is suspended and resumable. Run \`/hyperpowers:resume\`.`,
      );
    }

    // --- an errand is waiting for the main thread --------------------------------
    //
    // Checked **before** `yielded`, and deliberately. The flag records an inference — "the director
    // handed control back" — and §S12 is what over-trusting it costs, so the generic nudge below is
    // told once per yield. An errand is not an inference: `askedAt` without its completion stamp is a
    // file saying the run cannot move without this thread. Consuming the flag first meant the relay
    // was mentioned once and then the next attempt to end the turn was allowed, leaving an unanswered
    // question, no running director, and nothing that could ever wake it.
    //
    // Counted, so a main thread that will not run the errand suspends the run resumably rather than
    // being asked for ever.
    const errand = pendingErrand(projectRoot, runId);
    if (errand) {
      const blocks = countTurnBlock(projectRoot, runId, input.prompt_id ?? null);
      if (blocks >= softBlockCap(config)) return suspend(projectRoot, runId, state, config, blocks, errand);
      logEvent(projectRoot, runId, {
        type: 'relay_required', kind: errand.kind, blocks,
        ...(errand.kind === 'question' ? { count: errand.questions.length } : {}),
      });
      const resume = directorToResume(state, input.transcript_path);
      return emitBlock(errand.kind === 'publish'
        ? publishMessage(runId, errand, state, resume)
        : questionMessage(projectRoot, runId, errand, state, resume));
    }

    // --- the director is still working -------------------------------------------
    //
    // A background dispatch means the main thread's turn ends while the director runs. Blocking
    // here told it "the director has stopped" when it had not, and it queued a message for an agent
    // mid-flight — six times per turn, ~2 s apart. Run 6: 20 `redispatch_required`, three of them
    // landing *inside* the design coordinator's nine minutes, during which the director emitted
    // zero continuations because it was inside a blocking dispatch and never stopped at all. That
    // nagging drove both design-side suspensions and ~$3 of an $31 run.
    //
    // `yielded` is written only by `subagent-controller`, which is the loop that actually decides:
    // `true` when it let the director stop, `false` when it blocked and sent it back to work. The
    // flag it replaces was set on `SubagentStart` and cleared on *every* `SubagentStop` before the
    // block decision, so it read false for the whole life of a director after its first stop — and
    // run 6 proved it never even wrote once. Absent or false-because-never-set means "no director
    // has yielded to you", which is the same answer as "it is working": stay out.
    //
    // `allowStop`, not `emitAllowStop`: this is the **most-travelled** allow path in a healthy run —
    // every time the main thread's turn ends while the director works — so a counter that does not
    // reset here does not reset in practice at all. It would accumulate across separated series and
    // suspend a working run for blocks the harness had already forgotten.
    if (state.directorTurn?.yielded !== true) return allowStop(projectRoot, runId);

    // The yield is consumed by being reported. The nudge below *forces* another turn, so it is
    // delivered exactly once per yield instead of once per attempt to end the turn — without this,
    // `yielded` would stay true from the moment the director stopped until it stopped again, and the
    // main thread would be told to "resume the director" five more times after it already had: run 6's
    // nag loop, with a better-founded flag underneath it. Nothing fires when a `SendMessage` revives
    // an agent, so "told once" is the only honest bound available for an *inference*. An errand is not
    // an inference, which is why it is handled above this line.
    mutateState(projectRoot, runId, (s) => {
      // `replaceable: true` rides with the consumed yield, because the block below instructs this
      // thread to resume-or-redispatch the director — and `git-policy`'s one-director rule reads
      // `directorIsDriving`, which would otherwise see `yielded: false` plus a recorded id and
      // DENY the very dispatch this message asks for: the thread is blocked, obeys, and is
      // refused — a wedge, reproduced. Any subsequent director activity clears the marker (the
      // SubagentStart/Stop id write), so the window is exactly the errand it exists for.
      s.directorTurn = { ...(s.directorTurn ?? { agentId: null, blocks: 0 }), yielded: false, replaceable: true };
    });

    // --- the run is active and the director is not running -----------------------
    // Reaching here means the main thread is trying to end its turn while a non-terminal run
    // exists — and `yielded === true`, which only the subagent controller writes where it let the
    // director's stop through. (Not "because the dispatch is synchronous": the main thread's
    // director dispatch is a background one, §V1, and its turn ends while the director works —
    // that case was already allowed above.) So this fires only after the director genuinely
    // stopped without finishing: it parked for a question, exhausted its dispatch, or quit early.
    //
    // The phase machine itself is not here any more. Blocking `Stop` re-drives the main thread,
    // which directs nothing; what advances a phase is a `SubagentStop` block re-driving the
    // director (§R6). So this hook's whole remaining job is to stop the run being abandoned.
    //
    // Its own loop, with its own cap — measured independent of the subagent's (§R6).
    const blocks = countTurnBlock(projectRoot, runId, input.prompt_id ?? null);
    if (blocks >= softBlockCap(config)) return suspend(projectRoot, runId, state, config, blocks);

    logEvent(projectRoot, runId, { type: 'redispatch_required', phase: state.phase, blocks });
    emitBlock(
      [
        `HYPERPOWERS — run ${runId} is not finished. Phase: ${state.phase} `
          + `(owner: ${PHASES[state.phase].owner}).`,
        '',
        'The director has stopped but the run has not reached a terminal phase. You are not the '
          + 'director and must not continue the work yourself.',
        '',
        'Put it back to work — and prefer resuming the agent it already is:',
        directorToResume(state, input.transcript_path)
          ? `  SendMessage → \`${directorToResume(state, input.transcript_path)}\`  ("continue run ${runId}")`
          : '  (no director agent recorded yet)',
        '',
        // A fresh dispatch starts cold: it re-reads the request, the design and the plan to rebuild
        // what the running agent already holds. Resuming by id keeps that context, which is why the
        // instruction names the id rather than the agent type. Only fall back to a new dispatch.
        'A fresh `Agent` call works but starts cold — it re-reads everything the live agent already '
          + 'holds. Use `subagent_type: hyperpowers:hyperpowers-director` only if the resume fails.',
        '',
        `To stop instead: \`node "${PLUGIN_ROOT}/scripts/state-machine.mjs" abort --run ${runId} `
          + '--reason "<why>"\` (or tell the user to run `/hyperpowers:abort`). Nothing is reverted '
          + '— Hyperpowers never mutated the repository — and the artefacts stay on disk.',
      ].join('\n'),
    );
  },
  () => {
    // Advisory failure direction: a controller bug must never make a session unstoppable.
    emitAllowStop(
      'Hyperpowers stop-controller failed and allowed the turn to end. Run `/hyperpowers:status` ' +
        'to inspect the run, then `/hyperpowers:resume`.',
    );
  },
  { budgetMs: 25_000 }, // Stop is declared at 30 s in hooks.json
);
