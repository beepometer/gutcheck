# Changelog

All notable changes to Gutcheck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-08-13

- Workspace monorepos (pnpm/npm/yarn) now probe on the first run: the work copy re-links every
  `node_modules` it stripped—the root's AND each package's own nested one—at its same relative
  path. Previously only the root's was re-linked, so a dep installed into a package's nested
  `node_modules` (pnpm's default layout) was unresolvable in the copy, every baseline failed, and
  a fully sound suite read as all-inconclusive. A `node_modules` that is itself a symlink (linked
  installs) is re-linked too; a link that cannot be made degrades to the existing missing-deps
  `inconclusive`, never a wrong verdict.
- A changed function exercised only through a dynamic-titled characterization loop (the fn's name
  appears at module scope—an import and a case table—but in no test-block body) now classifies
  `unverifiable (test name is computed at runtime)` instead of the false "no binding test — no test
  names them". Gated to files containing dynamic-title blocks, so a static-titled file's bare
  import can never mask a genuinely untested function.
- Full-scan hollow rows carry sibling-binding context from the same run's verdicts:
  `total() is bound by 2 other proven tests` (an equivalence companion of proven value-pins) vs
  `no other probed test binds dup()` (the fn's only probed coverage). Zero extra probes; facts
  only, never a fix-now/by-design verdict.
- The `--since` full-suite fallback banner ("touched no probeable tests — scanning the full suite
  instead") prints before the fallback scan's probe lines, not after them.

## [0.6.0] — 2026-07-29

- JS/TS SUT resolution reads through the import shapes real repos actually use, each with the same
  refuse-when-unsure moats as the direct path:
  - one hop of re-export barrel—`export { fn } from './impl.mjs'` (same-name only) and
    `export * from` with exactly one declaring target; an explicit named re-export outranks stars,
    matching ESM precedence. Aliased re-exports, deeper chains, and ambiguous star fan-outs still
    report `unverifiable`.
  - declarative path aliases—package.json `imports` (`#src/util`) and tsconfig/jsconfig
    `compilerOptions.paths` (`~/util`, with `baseUrl`, one `extends` hop, JSONC tolerated)—with
    tsc's own precedence: exact over wildcard, longest prefix, first existing target consumed with
    no fallthrough (a later target would gut a file the runtime never loads). Aliases defined in
    code (vitest `resolve.alias`, jest `moduleNameMapper`) cannot be read statically and report
    `unverifiable`.
  - namespace members—`_.sort(...)` under `import * as _ from '..'`, or the CJS form
    `const R = require('..')`—bind the target module's export through the same core. Only true
    namespace bindings credit (a default import's members are properties of one exported value);
    mock-tainted files, shadowed/re-declared/monkey-patched receivers, and a CJS `module.exports`
    reassigned to a non-object-literal all refuse.
  - a bare dotted specifier (`from '..'`) resolves as the directory import it is, and TS NodeNext
    `.js` specifiers over `.ts` sources resolve by extension swap—a literal on-disk file always
    wins first.
  Each shape was validated A/B against the prior engine on a wild-repo corpus (two rounds, twelve
  repo runs): no false verdict introduced anywhere; namespace-import and NodeNext suites that
  previously reported only `unverifiable`/`pin-unresolved` gain execution-backed verdicts.
- A non-blocking checker advisory at the agent done-claim: one line over the diff's changed test
  files from the deterministic checker (the four lint kinds plus two runway kinds field-measured
  before any promotion). It never blocks and never mints a verdict; the probe keeps ownership of
  blocking.
- `magicLiteralGuard` gains the node:assert dialect—(actual, expected) argument order with an
  optional trailing message; expected-first is a deliberate miss; the ≥3-fractional-digit floor
  carries over. Calibration record (a 6-repo, ~19,300-assert sweep with a planted-specimen firing
  check) in the module header. Fixed: a relative import path's dots no longer read as a value
  derivation, which had silently exempted every literal within the window below a file's opening
  imports.
- Overclaim copy closed on every shipped surface—`--help`, the CI template, the check skill—and the
  editorial enforcement test now scans all of them, not four JSON fields.
- `prove.mjs` decomposed into five modules (`parse-utils`, `jvm`, `runners`, `python-resolve`,
  `report`) with the public export surface pinned by test; a genuinely new export is a deliberate,
  commented addition.
- Dogfood honesty: the dist-sync tests self-skip with a stated reason inside the probe's sandbox
  copy (which excludes build output), removing three permanent false "already failing" rows from
  every self-run.
- docs: `limits.md`'s reach section rewritten for the resolution shapes above and their residual
  refusals.

## [0.5.0] — 2026-07-22

- `proven[]` in every mode—each caught block now emits a machine-readable row (`file`, `line`, test
  `name`, bound `fns`, `(fn, sutRel)` pairs) alongside the existing scalar count, omitted when no
  block is caught. `--files`-scoped chunk runs (the documented big-repo mode) previously recorded
  proven tests only as a number; `--explain` on a proven block now names the gutted function and its
  source file instead of a generic PROVEN line (field report 2026-07-22).
- Kotlin reach: a destructuring declaration is a val-hop—`val (scale, offset) = fitTransform(...)`
  credits `fitTransform` when any component is pinned (`_` placeholders and higher arities
  included), through the same head-anchored, import-gated moats as the single-var hop. On
  destructurable return types (`Pair`/`Triple`/data classes) this converts the misleading
  `pin-unresolved` skip reason into the honest `ungutable`—reporting precision today, verdicts only
  if those types ever gain a compiling sentinel.
- A scan root that contains test files but zero non-test sources now states the scope problem once,
  up front—`scopeWarning` in `--json`, first line of the human report—instead of letting one scope
  mistake masquerade as per-test `sut-unresolved` failures (field report 2026-07-22).
- The four `--json` denominators (`capped`, `changedFileCount`, `changeSummary.files`,
  `changeSummary.notProbed`) are documented in the CLI reference, and the `ungutable` reason copy
  now says what it means—no compiling wrong-value sentinel for the function's return type or body
  form.
- Fixed: a SIGKILL'd run (a harness or CI timeout) leaked its temp work copy (~1.3 GB per orphan on
  a Gradle host). Each copy now carries a `{pid, started}` ownership marker; the first probe of a
  process reaps copies whose owning pid is dead, and markerless dirs only past a 24-hour age guard
  (post-fix validation report 2026-07-22).
- Android/AGP e2e coverage: a vendored minimal AGP fixture and a weekly/opt-in `android-e2e`
  workflow run the three env-gated Android legs—task resolution, mutant-caught, and the
  compile-fail→`ungutable` leg on AGP's variant-qualified compile naming, the branch where two
  prior field defects lived.
- docs: `limits.md` documents the work-copy isolation architecture (the probe never runs tests in
  your working tree; the residual is shared Gradle daemon/cache contention, never file collision)
  and Gradle-host Stop-hook economics; CONTRIBUTING notes that `npm install -g .` symlinks the
  checkout—validate releases from the `npm pack` tarball.

## [0.4.0] — 2026-07-21

- Relational assertions are probe-eligible with asymmetric verdicting—`assert.ok(a > b)`,
  jest/vitest `toBeGreaterThan`-family, chai `.above`/`.least`-family, JUnit/kotlin.test
  `assertTrue(a > b)` (paren and trailing-lambda forms), AssertJ `isGreaterThan`-family, pytest
  `assert a > b`, and unittest `assertGreater`-family. A red mutant proves the test binds; a mutant
  that survives both extremes reports the new `relation-unbound` unverifiable reason—a relational
  test can be proven or one-sided but can never be accused of being hollow, and exit codes never
  change on runs without relational asserts.
- Kotlin reach: a receiver'd object/singleton call at the head of a test expression now credits its
  method—`val x = Modes.speedOfSound(...)` binds `speedOfSound`. Import-gated (the capitalized
  receiver must be imported by the test) and head-anchored.
- Boundary-blind-spot aggregate: the one-sided tier now leads with a summary of which direction
  each threshold test binds—split counts on the diff report and PR comment, a per-direction file
  breakdown on the full-scan report (field feedback). Report-only; verdicts, exit codes, and
  `--json` are unchanged.
- Under a probe cap, blocks with value-pinning assertions are probed before relational-only blocks,
  so stronger evidence is never displaced by direction-only evidence.
- Fixed: on Node 23+ the probe read every `node --test` run as 0 passed/0 failed—Node flipped the default
  test reporter from tap to spec (`ℹ pass 1` rather than `# pass 1`), which the count parser couldn't read,
  so the startup self-check failed and gutcheck refused to run (the Stop-hook gate then fell silently open).
  The node runner now pins `--test-reporter=tap`, matching the mocha/ava branches; a Node 24 CI leg guards
  the reporter format (#4).
- Fixed: Gradle false-hollow hardening (field report 2026-07-18). A daemon vfs-watch race could miss the
  probe's out-of-band mutant write, leaving the main compile up-to-date so the test reran against stale
  classes—a fresh-green read then minted a false `hollow`; the gradle probe now runs
  `-Dorg.gradle.vfs.watch=false` and trusts a survivor as evidence only when the mutant was actually
  compiled in that run (last-compiled content match). Compile-task detection also scopes its `test`-name
  exclusion to the segment after the last colon, so a module path with a `test`-shaped segment no longer
  hides the real compile task.

## [0.3.2] — 2026-07-15

- The CI markdown surface (sticky PR comment, job summary) carries the probe mechanics—probed
  functions, bound ratio, tests skipped, runner—under the verdict summary, so a reader deciding
  how much to trust the gate as coverage sees the denominator at a glance.
- The README's verdict flow chart ships as committed light/dark SVGs—the GitHub mobile app
  renders no mermaid.

## [0.3.1] — 2026-07-15

- The default diff report renders whole-scope hollow findings: previously the headline could read
  "0 hollow" while the exit code counted a hollow beyond the changed functions (#1).
- Unverifiable reasons state only established facts: a test that pins a value the probe can't tie
  to a called function reports `pin-unresolved`, split from `no-pin`; execution-observed evidence
  outranks static reads on rollup ties (#3).
- Every skip reason is itemized in the banner—the itemized counts always sum to the skipped
  total, and an unrecognized reason code renders verbatim instead of being dropped.
- The full-scan headline leads with the coverage denominator ("verdicts on X of Y tests") whenever
  tests were skipped or inconclusive, so the one-line summary can never read as a whole-suite claim.
- `--time-budget` now bounds the analysis phase too, not just probing; a whole-repo scan can no
  longer run unbounded before the first probe.
- One probe per repository at a time: a run that finds another gutcheck probe active on the same
  repo refuses with a stated reason (the agent hook yields silently and never memoizes the
  refusal); a lock left by a dead process clears itself.
- Hollow is confirmed before it is reported: a test that survives the gut is re-gutted with the
  opposite-signed sentinel, and `hollow` now means green under **both** directions. Red under
  exactly one is **one-sided**—a new non-blocking verdict tier for threshold/comparison oracles
  (two complementary one-sided tests jointly bind the function). Survivors are rare, so the
  confirmation is near-free; an accusation can never be a sentinel-sign accident.
- `--deep` extends both-sentinel evidence to the proven side (a one-direction-only proof demotes
  to one-sided) and adds the identity-stub advisory, now suppressed for functions with a
  production identity branch, where surviving the stub is expected. `--deep` and the
  sentinel-direction limit are now documented.
- The probe fail-fasts on a broken environment: once the first 10 baseline runs in a pass have all
  failed with none passing, the rest are recorded as not-probed (`env-abort`) instead of run one by
  one to a guaranteed-inconclusive result; the report states the abort and the remaining count.
- A `--json`/`--format` report larger than the 64KB pipe buffer no longer reaches machine consumers
  truncated with exit 0 (process.exit discarded undrained stdout; the agent hook and CI read through
  pipes and would have failed open on a parse error).
- Root-module Kotlin Multiplatform repos (tests at `src/jvmTest/` with no module prefix) now select
  the `jvmTest` task; the unanchored path match previously fell through to the nonexistent `test`
  task and read the whole repo as did-not-run.

## [0.3.0] — 2026-07-10

- A skipped or never-ran test no longer reads as "already failing" and can no longer block a diff
  (did-not-run split from ran-and-failed).
- A wrong-language test file skips fail-closed instead of being read as already-failing
  (runner-mismatch gate).
- Capped functions report "not probed (cap)", never "untested".
- The clean-run coverage line reaches the user via the stdout JSON `systemMessage` (previously
  written to a discarded stderr channel).
- The probe is memoized per diff-hash—unchanged diffs are not re-probed within a session.
- `--time-budget=<seconds>` caps wall-clock probe time, returning honest partial results on
  slow-runner repos.
- JVM promoted to a supported surface: Gradle (including Android/Robolectric), Maven (single- and
  multi-module), Kotlin `--explain`.
- A repo-root `.gutcheck-off` is honored from subdirectories.
- CI templates probe with `--no-fallback`; PR annotations carry a coverage-denominator `::notice`.
- Block reasons and `--explain` name the survivor's file (`fn() (src/file.mjs)`); an already-failing
  test's block reason also quotes the runner's own failure text, with TAP bookkeeping filtered out.
- Typed declarations (`const x: T = fn(...)` in TS, `val x: T = fn(...)` in Kotlin) and chai language
  chains (`.to.be.equal(...)`) now credit—these idiomatic pins previously read as no binding test.
- Under a probe cap, test files changed in the diff are probed first—the agent's own new tests get
  verified before the backlog.
- A proven function's evidence states "M via tests changed in this diff" when every binding test
  co-changed with the code (fact-only, never a verdict); capped functions count as "not probed (cap)",
  not "unverifiable".
- Finishing a turn over a still-flagged hollow (or already-failing) test emits a non-blocking
  `systemMessage` naming the unfixed test(s)—memo-backed, never re-probed, silent once the diff
  changes.
- The Stop-hook gate is a CLI surface (`gutcheck gate --harness=<name>`) behind a harness-adapter
  interface, so any agent harness can call the same gate the Claude Code plugin uses.
- Codex CLI gets an in-loop gate: a protocol-twin `Stop` hook (`{decision:"block",reason}`, the
  same `stop_hook_active` loop guard as Claude Code), shipped as an integration template
  (`integrations/codex/`).
- Cursor gets an in-loop gate: its `stop` hook can't block a turn, so the adapter re-prompts via
  `{followup_message}` (Cursor auto-submits it as the next user message), guarded by `loop_count`
  plus a diff-hash one-shot guard (`integrations/cursor/`).
- GitHub Copilot's coding agent gets an in-loop gate: a `.github/hooks/` `agentStop` hook
  (`{decision:"block",reason}`); Copilot's protocol carries no loop-guard flag, so a memo one-shot
  guard is the sole re-block guard (`integrations/copilot/`).
- Google Antigravity gets an in-loop gate: a `Stop` hook (`{decision:"continue",reason}`) that
  gates only a clean, fully-idle stop (`model_stop` + `fullyIdle`); memo one-shot guard, template
  timeout raised to 120s (`integrations/antigravity/`).
- aider gets a documented recipe pointing its own `--auto-test`/`--test-cmd` reflection loop at
  gutcheck's exit code, with the `--no-auto-commits` configuration verified live
  (`integrations/aider/`).

## [0.2.1] — 2026-07-08

- README corrected end-to-end: the flagship example, the plugin section, and the opening now match
  the tool as shipped.
- Reader-facing output surfaces use single quotes consistently.
- Maven repos fail closed at the probe entry point instead of falling through to the node runner
  and drowning the report in inconclusive noise.
- Kotlin Multiplatform (`jvmTest` + clean skips for unsupported source sets) reaches npm.

## [0.2.0] — 2026-07-08

First release.
