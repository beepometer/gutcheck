# Scope and limits

## Running it safely

The probe runs the project's own tests, and therefore its code—point it only at repositories
whose tests you would run anyway.

The same rule decides how you wire the CI action. Run it on `pull_request`, where fork PRs run
without repository secrets. Do **not** wire it to `pull_request_target` with a checkout of the PR
head: that pattern runs untrusted test code with your secrets, and no input to this action needs
them. Pin the action to a tag or a full commit SHA.

One probe per repository at a time: a run that finds another gutcheck probe active on the same
repo refuses with a stated reason instead of driving two test runners into each other (the agent
hook yields to a CLI sweep the same way). A lock left by a dead process clears itself.

## What the probe can reach

A test is probed only if it pins a concrete value and the tested function can be located from the
test file's imports. Direct calls and constructed instances both resolve inline (`new X().m()` /
`X().m()`) or via a variable across JS/TS, Kotlin/Java, and Python; ambiguous or
mock-constructed receivers are skipped, never guessed. Tests importing build output such as `dist/`
are typically unverifiable—build output is never mutated.

Reach is bimodal: strong on value-pinning pure-logic code, much thinner on DSL-heavy, mock-heavy,
UI, or dependency-injection-heavy code, where few functions can be probed at all. There the
untested and unverifiable columns carry the coverage information instead of the probe.

On a mature, mock/DI-heavy suite the probeable fraction is a structural ceiling, not a budget
artifact: a whole-repo run that completes inside its cap and budget has reached everything the
technique can reach, and the fraction does not grow with more compute. Observed on a large
Android/Kotlin app: ~10% of tests verdict-able at completion. Execution-verifying that slice beats
assuming all of it — but raising `--max-probes`/`--time-budget` past a completed run buys nothing.

## Sentinel direction on threshold logic

The gut rewrites a function to return one extreme sentinel (`987654321` and typed variants). On
one-sided comparison logic (thresholds, clamps, pass/fail cutoffs) a single-sentinel verdict is
therefore direction-relative: a test that exercises only one side of a cutoff can read hollow under
the huge sentinel yet would go red under a negative one, and vice versa. A plain-run `proven` on
threshold logic means the test detects the sentinel's direction of error—weaker evidence than a
`proven` on an equality pin.

Every run confirms an accusation before minting it: a test that survives the gut is re-gutted with
the opposite-signed sentinel, and `hollow` is reported only when it stays green under **both**
directions—red under exactly one is **one-sided**, a real verdict (the test binds one direction
of error) that never blocks. Survivors are rare, so the confirmation costs almost nothing: the
extra run is paid exactly when an accusation is at stake. Two complementary one-sided tests, one
per direction, jointly bind the function. A function with no opposite mutant (the string sentinel,
a compile-failing opposite) keeps its single-sentinel verdict — no evidence, no reclassification.

`--deep` extends the same both-sentinel evidence to the proven side: a test red under only one
direction is demoted from proven to one-sided. A plain-run `proven` on threshold logic therefore
means the test detects the positive sentinel's direction of error — weaker evidence than a
`proven` on an equality pin. `--deep` buys evidence quality, not coverage: it re-probes the same
tests with more mutants (roughly double the runs) and cannot make more of the suite probeable.

The hollow catch is the rare, high-severity case. The everyday output is the denominator: which of
the functions you just changed have no binding test at all.

## Languages and runners

| Language | Runners | Notes |
|---|---|---|
| JavaScript / TypeScript | vitest, jest, mocha, ava, node:test | runner auto-detected |
| Python | pytest | ast-based function location |
| Kotlin / Java (Gradle, Maven) + Android (Gradle only) | Gradle + JUnit 4/5, kotlin.test, AssertJ; Maven + JUnit 4/5 (single-module and multi-module reactors) | Android local unit tests via Gradle (`testDebugUnitTest`, incl. Robolectric); Kotlin Multiplatform JVM-target tests (`src/jvmTest`, and `src/commonTest` when the module declares a JVM target) |

Gradle reruns pass `--offline` once the project has been built online. A Maven submodule built in
isolation whose reactor siblings aren't installed to the local repo fails to build there and is
read as no results — an under-reach, never a wrong verdict.

**Not supported:** Kotlin Multiplatform native and JS target test sets (and `commonTest` in a
module with no JVM target), and instrumented Android tests—`androidTest` reports `unverifiable —
needs a device/emulator`. Unsupported Gradle source sets are skipped with an explicit reason before
any test run, never guessed at.

## Platforms

Hooks are bash and run on macOS and Linux. The CLI and the action run anywhere Node 20+ runs.

See also: [how it works](how-it-works.md), [CLI reference](cli.md).
