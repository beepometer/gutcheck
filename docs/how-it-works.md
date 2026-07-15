# How it works

Mutation testing restricted to one mutant per function (a wrong constant return) and one test
rerun per mutant — fast enough to run on every change. Verdicts come from parsed runner summaries
and JUnit XML, never from exit codes.

## Scoping the probe

`--since=<ref>` scopes the probe to functions and tests touched since that ref; without it, every
eligible test in the project is probed. An unresolvable ref (an unfetched `origin/main`, say)
retries against the merge-base with the local upstream branch, `main`, `master`, or `HEAD~1` in
turn, naming the substitute. A diff touching no probeable test falls back to a full-suite scan
with a notice; `--no-fallback` disables that (the agent hook and CI templates always pass it).
Under a probe cap, test files changed in the diff are probed first.

## Fail-closed throughout

- A changed test that already fails is reported separately — it verifies nothing until it passes.
- A test that never ran (skipped, zero-match selection, timeout) is did-not-run, never an
  accusation.
- A mutant survival triggers a flake re-check — a rerun with the function restored — before any
  hollow verdict.
- A surviving test is also re-gutted with the opposite-signed sentinel before the accusation:
  hollow means green under both directions; red under exactly one reads one-sided (a verdict,
  never a blocker), so a hollow can never be a sentinel-sign accident.
- An ambiguous test title is inconclusive; a dynamic one is skipped. Always with the reason stated.
- When the environment itself is broken, the first several baselines failing with none passing
  aborts the run rather than grinding through a guaranteed-inconclusive rest, and says so.
- On JVM projects the mutant is a type-compatible constant; one the type system rejects is never
  counted.

None of these paths can produce a false hollow or a false proven.

## The self-check

Before reporting anything, gutcheck runs a self-check in a scratch directory: it plants one fake
test and one real test, and refuses to run unless it catches the fake and clears the real one. It
adds a fraction of a second; `--no-self-check` skips it.

## The five verdicts

Proven, hollow, and unverifiable carry a replayable receipt; a one-sided row states both observed
runs inline; untested is a reference scan that found nothing to cite.

| Verdict | Meaning | How it is established |
|---|---|---|
| proven | a test fails when this function breaks | the function was gutted, its test was rerun, the test failed |
| hollow | a test covers it but cannot detect it breaking | same probe, confirmed: the test passed over the gutted function AND over the opposite-signed gut — never a sign accident |
| one-sided | the test binds one direction of error (a threshold-style oracle); never a blocker | the test went red under exactly one of the two opposite-signed guts |
| unverifiable | tests reference it, but the probe could not verify any of them — a limit of the probe, not proof the tests are weak | no value-pinning assertion, the function cannot be located from the test's imports, or the referencing test is itself inconclusive; each test's reason is in the JSON, the dominant one in the report |
| untested | no test mentions it | reference scan over the test files in scope |

`proven` means the tests bind the function, not that the code is correct — a test can pin a wrong
value and still bind.

## Cost

Cost is dominated by your own test runner's startup, not gutcheck itself — typically around a
second per probe on fast JS runners, a few seconds on warm Gradle/Android builds. Each test run is
bounded by a 60-second timeout, configurable with `GUTCHECK_PROBE_TIMEOUT_MS`.

See also: [what the probe can and cannot reach](limits.md), [CLI reference](cli.md).
