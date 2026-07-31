# The completion contract

> A feature is not finished because the existing tests pass.
> Green tests may only mean the missing behaviour is not tested.

Nothing else writes a gate verdict. `verify-completion.mjs` is the only producer, and
`FINAL_ACCEPTANCE → COMPLETE` refuses to move until it has passed — `COMPLETE` is the one
terminal state that does not skip its exit requirements, because it is the one that claims
success rather than reporting failure.

`verify-completion.mjs --gate completion` evaluates every condition below mechanically and
reports `pass`, `fail`, `not_applicable` or `unverifiable`. A condition it cannot evaluate is
reported as `unverifiable` — never silently counted as a pass. The director may accept
`unverifiable` conditions as stated residual risk; it may not accept a `fail`.

| # | Condition | How it is checked |
| --- | --- | --- |
| 1 | Every acceptance criterion has evidence | Each `AC-n` in the design appears in `evidence.json` with status `satisfied` and at least one proof |
| 2 | All required tests pass | **Every** test suite recorded in the evidence matrix — `unit-tests`, `integration-tests`, `e2e-tests`, `regression` — is `pass` or `absent`. Not just the unit suite |
| 3 | The build passes where one exists | Build check is `pass`, or `absent` |
| 4 | Lint and typecheck pass where they exist | Both checks are `pass`, or `absent` |
| 4c | The changed behaviour was actually exercised | The `runtime` check is `pass`, or `absent` with a reason. Tests share the assumptions of the code they test; running the software does not |
| 5 | Added tests failed before the fix, where verifiable | `failing_before_fix` is populated with real captured output |
| 6 | No accepted critical finding is open | Adjudication ledger reports no open critical blocker |
| 7 | No accepted blocking high finding is open | Adjudication ledger reports no open blocker of any severity |
| 8 | The second implementation review completed | `reviews/implementation-2.json` exists with status `completed` |
| 9 | Announced corrections were verified | Every `accepted` decision carries resolution evidence |
| 10 | No out-of-scope file was modified without justification | Changed files ∖ files owned by a work package = ∅ |
| 11 | No Git mutation was executed | The PostToolUse guard saw no repository drift. Attempts the PreToolUse policy *blocked* are counted separately and do not fail this |
| 12 | No model fallback was concealed | Every fallback in the event log is reflected in the model recorded on the review it affected |
| 12b | The director tier ran on the configured model | Observed from the session transcript, not self-reported |
| 13 | The director gives final acceptance | The run reached `FINAL_ACCEPTANCE`, with the arrival recorded and attributed. No mechanism can check that Fable *judged* well; this checks that the decision was actually put to it |
| 14 | A product-oriented Mermaid diagram was published as an Artifact | Its URL is recorded on the run |

## Why the unusual ones are there

**5 — tests that failed before.** A test that passes against both the correct and the broken
implementation proves nothing and creates false confidence. Recording the failing run is the
only cheap way to show a test can actually fail.

**10 — out-of-scope changes.** Scope drift is invisible in a passing test suite. Comparing the
changed-file set against work-package ownership is what makes it visible.

**11 — no Git mutation.** Direct mutations are blocked before they run, but an opaque script can
still call `git commit`. The guard detects that after the fact, and this condition is where
detection becomes consequential.

The distinction between *blocked* and *executed* is the whole condition. An agent trying
`git commit` and being refused is the control working; counting that as a violation made a
single refused attempt — a near-certainty in any real run — permanently unfinishable, because
telemetry is append-only. Blocked attempts are reported here as context, never as failure.

**12b — director model.** The whole architecture assumes product authority sits with the
strongest model. If the run silently demoted to the session default, the pyramid inverted and
its conclusions were reached by a different system than the one described.

**14 — the diagram.** A feature nobody can explain to a non-engineer has not been delivered in
any sense the requester cares about. Load the `artifact-design` skill before building it.

## Terminal states other than COMPLETE

- `BLOCKED` — a real impasse: an unresolvable critical finding, a missing dependency, repeated
  failure with no progress. Honest and useful.
- `POLICY_VIOLATION` — a hard rule was breached.
- `ABORTED` — abandoned deliberately.

None of these is a failure of the run to *report* correctly. Stopping in `BLOCKED` with a clear
reason is a better outcome than declaring `COMPLETE` on unproven work.
