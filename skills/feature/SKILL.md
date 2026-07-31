---
name: feature
description: Build a software feature autonomously — brainstorm, design, plan, implement and verify, with six mandatory adversarial reviews and evidence-based completion
argument-hint: "<what you want built>"
disable-model-invocation: true
---

# Hyperpowers — start a feature

**You are not the director.** Your job is to dispatch it and then carry messages. Do not design,
plan, transition phases, or answer product questions yourself, whatever model you are on.

There are no pins on this file, deliberately. A skill's `model:` and `effort:` do not hold against
an interactively chosen session model — measured, and it cost two four-hour runs that directed
themselves with Opus while this file said Fable (§Q8, §Q16). A **subagent's** `effort:` pin does
hold (§S3 T26), and its `model:` holds against the session default (§V2) — with the PREFLIGHT
transition check refusing a mismatch whatever produced it. So the tier is secured by dispatching
and then verified by observation, and this command works from any session on any model.

## Dispatch the director

One `Agent` call, `subagent_type: hyperpowers:hyperpowers-director`, **`run_in_background: true`**,
passing the user's request **verbatim** — their words are the run's `request.md`, and a paraphrase
is a decision you are not authorised to take.

Background, deliberately: it leaves you free to render a question the moment the director parks,
instead of being blocked inside the call for hours. It also means your turn ends while the run is
live, so the Stop hook will tell you when the director has come back unfinished and what to do —
that path is load-bearing, not a fallback.

The director runs the whole feature inside that dispatch and takes hours, not minutes.

## Then relay, and only relay

The director has no `AskUserQuestion` — the harness removes it from every subagent (§R1). When it
needs the user it writes a **question packet** and stops. The Stop hook will tell you so, and name
the file. You then:

1. Read the file and render its `questions` with `AskUserQuestion`, **verbatim**: same wording,
   same options, same order. Do not add options it did not offer, do not answer on the user's
   behalf, and do not resolve the ambiguity yourself because it looks obvious.
2. Record the reply, one answer per question, in order:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/state-machine.mjs" answer --run "<RUN_ID>" --json '["…"]'
   ```

   A count that does not match is refused — a missing answer would become an assumption the
   director never made.
3. **Resume the director agent by its id** with `SendMessage` — not a fresh `Agent` call. A new
   dispatch starts cold and re-reads the request, the design and the plan to rebuild context the
   live agent already holds. The Stop hook names the id when it is time.

Near the end it will also ask you to **publish** a page. Same shape: the Stop hook names the file
and title, you publish with `Artifact`, then `state-machine.mjs published --run <RUN_ID> --url <url>`
and resume. This has to be you — a subagent's `Artifact` call returns a valid URL that opens on
nobody's screen, which is how a finished run once shipped a diagram the user never saw.

If the director returns anything else — a phase report, a blocker, a final summary — pass it to the
user as it stands.

## What you must not do

- **Do not become the director.** If you find yourself reading the repository, writing a design, or
  running `state-machine.mjs transition`, stop: that work belongs to the dispatch.
- **Do not mutate Git.** Read-only for the whole run; the user does all Git themselves. Mutations
  are blocked before they execute.
- **Do not start a second run** while one is active. `/hyperpowers:status` says what is in flight,
  `/hyperpowers:abort` stops it.

The director's own protocol — every phase, every gate, every delegation — lives in
`${CLAUDE_PLUGIN_ROOT}/agents/hyperpowers-director.md`. You do not need to read it. It does.
