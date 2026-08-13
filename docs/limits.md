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

The probe never runs tests in your working tree. Each run copies the project—minus build output,
caches, and VCS metadata (`build/`, `.gradle/`, `node_modules/`, `.git/`, …)—into a disposable temp
directory, drives every build and test run there, and deletes the copy when the run ends. Your
tree's `build/test-results` and other outputs are never written. The copy does share machine-level
state with concurrent builds—the Gradle daemon registry and `~/.gradle` caches—so a probe running
alongside a real build can contend for daemons and memory, but it cannot collide with your build's
files.

## What the probe can reach

A test is probed only if it pins a concrete value and the tested function can be located from the
test file's imports. Direct calls and constructed instances both resolve inline (`new X().m()` /
`X().m()`) or via a variable across JS/TS, Kotlin/Java, and Python; ambiguous or
mock-constructed receivers are skipped, never guessed. Tests importing build output such as `dist/`
are typically unverifiable—build output is never mutated.

JS/TS imports resolve through declarative path aliases: package.json `imports` (`#src/util`) and
tsconfig/jsconfig `compilerOptions.paths` (`~/util`, `@/util`, with `baseUrl` and one `extends` hop),
with tsc's own precedence (exact over wildcard, longest prefix, first existing target). Aliases
defined in code are out of reach—vitest `resolve.alias`, jest `moduleNameMapper` in a `.js` config,
webpack aliases—a config computed by code cannot be read statically without guessing, so tests
importing through one report `unverifiable`.

A namespace import's member calls resolve the same way: `_.sort(...)` under `import * as _ from '..'`
—or its CJS form, `const R = require('..')`—binds `sort` to the target module's export, through the
same declaration-then-barrel-hop core. Only a true namespace binding credits: a DEFAULT import's
members are properties of one exported value, never resolved; a mock-tainted test file, a shadowed,
re-declared, or monkey-patched receiver, and a CJS module whose `module.exports` is reassigned to a
non-object-literal all refuse. TS NodeNext specifiers (`./struct.js` naming a `.ts` source) resolve
by extension swap only when no literal file exists—an on-disk `.js` always wins first.

A test that reaches its function through a re-export barrel (an `index.ts` aggregating a package's
public surface) resolves through ONE hop of re-export: the probe follows the test file's imports, and
when the imported file only forwards the name—`export { x } from './y.mjs'` same-name, or
`export * from './y.mjs'` with exactly one forwarded file declaring it—it looks for the declaration one
file further. Anything less certain refuses and reports `unverifiable`—never a guessed verdict: an
aliased re-export (`sum as x`—the declared name differs from the tested name), a chain deeper than one
hop, a `export *` fan-out where more than one target declares the name, or a CommonJS barrel
(`module.exports` forwarding). A codebase whose barrels take one of those refused shapes carries that
blind spot across its whole probeable surface, reported as `unverifiable` (tested function not
locatable).

Reach is bimodal: strong on value-pinning pure-logic code, much thinner on DSL-heavy, mock-heavy,
UI, or dependency-injection-heavy code, where few functions can be probed at all. There the
untested and unverifiable columns carry the coverage information instead of the probe.

On a mature, mock/DI-heavy suite the probeable fraction is a structural ceiling, not a budget
artifact: a whole-repo run that completes inside its cap and budget has reached everything the
technique can reach, and the fraction does not grow with more compute. Observed on a large
Android/Kotlin app: ~10% of tests verdict-able at completion. Execution-verifying that slice beats
assuming all of it—but raising `--max-probes`/`--time-budget` past a completed run buys nothing.

Probe cost scales with the runner: a JS/TS probe is roughly a second; a Gradle/Android probe is
~10–15 s even against a warm daemon. Under the Stop hook's default budget (`--max-probes=20
--time-budget=90`) a Gradle host therefore yields single-digit verdicts per run—the hook's useful
output there is the untested/unverifiable denominator, not verdict volume. For verdict coverage on
Gradle/Android, run the CLI pre-merge over scoped `--files` chunks instead.

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
a compile-failing opposite) keeps its single-sentinel verdict—no evidence, no reclassification.

`--deep` extends the same both-sentinel evidence to the proven side: a test red under only one
direction is demoted from proven to one-sided. A plain-run `proven` on threshold logic therefore
means the test detects the positive sentinel's direction of error—weaker evidence than a
`proven` on an equality pin. `--deep` buys evidence quality, not coverage: it re-probes the same
tests with more mutants (roughly double the runs) and cannot make more of the suite probeable.

Relational assertions (`a > b` and friends) are probed asymmetrically: a mutant that goes red proves
the test binds, but a mutant that survives both extreme sentinels reports `relation-unbound` instead
of hollow—a one-sided relation like `assertTrue(score >= 0)` passes extreme sentinels by
construction, so its survival is not evidence the test is hollow.

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
read as no results—an under-reach, never a wrong verdict.

**Not supported:** Kotlin Multiplatform native and JS target test sets (and `commonTest` in a
module with no JVM target), and instrumented Android tests—`androidTest` reports `unverifiable —
needs a device/emulator`. Unsupported Gradle source sets are skipped with an explicit reason before
any test run, never guessed at.

## Platforms

Hooks are bash and run on macOS and Linux. The CLI and the action run anywhere Node 20+ runs.

## Calibration, and what it means each check misses

Each checker kind's thresholds were derived by running it over real repositories and inspecting every
finding. What follows is the record of what those sweeps found and, for each, the blind spot the fix
created. These are limits, not results—no catch rate is claimed anywhere, because none has been
measured.

**`magicLiteralGuard`**—flags a numeric literal in an expected-value assertion that carries no
derivation. On a JavaScript sweep, 5 of 5 findings were one-digit decimals (`0.5`, `1.5`), each the
self-evident result of an input literal in the same call. The `toBe`/`toEqual` threshold was raised to
three or more fractional digits; `toBeCloseTo` stays broad. **Consequence: an uncited integer
expectation is never flagged.** A test that pins `42` where the right answer is `43` reads as `proven`
by the probe and draws no comment from the checker. This is the honest limit of the "wrong pinned
literal" concern—the check closes uncited golden floats, not the vector.

**`derivationCoherence`**—flags an inline arithmetic derivation comment that does not compute the
asserted value. A sweep produced 0 findings across 9 repositories, with four distinct
parser-mechanism causes for the misses. Variables and units are skipped by design, so only
fully-numeric inline derivations are checked.

**`fallbackCollapse`**—flags a compare-to-empty assertion whose actual expression launders an absent
field through a `|| []` / `?? {}` fallback. Restricted to call-derived fallbacks—a fallback over a
static field with no call upstream is not flagged. Promoted to the lint set on a corpus sweep of 16 true
findings and 0 false positives within that restriction.

**`shadowOracleGuard`**—flags an expected value taken from a locally-defined helper that re-derives a
number. Out of reach by design: re-running the imported system under test into a variable
(`const e = sut(); expect(sut()).toBe(e)`), because nothing in the text distinguishes the production
symbol from an independent oracle.

**`selfComparisonOracle`**—flags an assertion whose two sides are textually identical calls. Measured
and **not** shipped in any default configuration: real repositories produce it at a high base rate with
close to zero defect yield, because it usually encodes a deliberate determinism check. The probe owns
the harmful subset, since it can tell a self-comparison that survives gutting from one that doesn't.
The kind remains available to an explicit configuration.

See also: [how it works](how-it-works.md), [CLI reference](cli.md).
