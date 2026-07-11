# Wild Kotlin/Android hardening pilot — results (2026-07-07)

Purpose: expose the JVM probe to diverse wild Kotlin and Android repos before release, hand-audit
every verdict, and fix any false-positive vector found. Exit gate: zero confirmed false verdicts.

## Protocol

Candidates were found by a two-phase search (find, then independently re-verify every claim against
the GitHub API) across seven diversity slots: MockK-heavy MVVM, Robolectric, coroutine runTest,
Compose, multi-module, plain-JVM libraries, and young AI-built projects. Each buildable repo was
warm-built once online in a write-restricted sandbox, then driven offline with the shipped probe.
Predictions were written down before each drive; every hollow and a sample of caught verdicts were
audited by hand, including manual re-application of the mutation.

## Disposition (13 repos)

| Outcome | Count | Notes |
|---|---|---|
| Driven clean | 10 | ~1,500 test blocks, 32 scored: 30 caught, 2 hollow |
| Build casualties | 3 | Jetifier vs Java-24 dependency bytecode; convention-plugin vs AGP API drift; dependencies shipping Java-21 bytecode on a JDK-17 host |

Both hollow verdicts were audited true by hand-gutting: an echo-oracle-via-fallback
(ProjectPathsTest in heypandax/cc-pocket) and a cross-input echo (RssiDistanceEstimatorTest in
lnxgod/friendorfoe). In each case the flagged test stayed green over the hand-broken function while
a sibling literal-pinning test went red, which is the receipt for both the hollow and the
catchability of the function. No false verdict was found anywhere: exit gate passed.

## What the pilot changed in the tool

- Version-catalog AGP detection: modules declaring Android via `alias(libs.plugins.android.*)` were
  falling through to the aggregate `test` task, which rejects `--tests`; fixed with a
  declaration-style-independent signal, confirmed on two further repos.
- Robolectric under sandboxing needs `~/.robolectric-download-lock` writable, and a persisted Gradle
  daemon keeps the sandbox profile it started with.
- Five of the ten driven repos had failing or non-compiling tests at HEAD; the fail-closed baseline
  gate produced no verdict on any of them. The already-failing report signal came from this
  observation.
- KMP source sets and instrumented androidTest files previously burned a baseline each before
  landing inconclusive; they now resolve to the jvmTest task (when a JVM target exists) or skip with
  an explicit reason. On cc-pocket's protocol module this moved 25 noise rows to 7 scored, 7 caught.

Raw drive outputs are regenerable with the committed probe against the pinned repos named above.
