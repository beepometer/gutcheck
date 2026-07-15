# Changelog

All notable changes to Gutcheck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] — 2026-07-15

- The default diff report renders whole-scope hollow findings: previously the headline could read
  "0 hollow" while the exit code counted a hollow beyond the changed functions (#1).
- Unverifiable reasons state only established facts: a test that pins a value the probe can't tie
  to a called function reports `pin-unresolved`, split from `no-pin`; execution-observed evidence
  outranks static reads on rollup ties (#3).
- Every skip reason is itemized in the banner — the itemized counts always sum to the skipped
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
  exactly one is **one-sided** — a new non-blocking verdict tier for threshold/comparison oracles
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
- The probe is memoized per diff-hash — unchanged diffs are not re-probed within a session.
- `--time-budget=<seconds>` caps wall-clock probe time, returning honest partial results on
  slow-runner repos.
- JVM promoted to a supported surface: Gradle (including Android/Robolectric), Maven (single- and
  multi-module), Kotlin `--explain`.
- A repo-root `.gutcheck-off` is honored from subdirectories.
- CI templates probe with `--no-fallback`; PR annotations carry a coverage-denominator `::notice`.
- Block reasons and `--explain` name the survivor's file (`fn() (src/file.mjs)`); an already-failing
  test's block reason also quotes the runner's own failure text, with TAP bookkeeping filtered out.
- Typed declarations (`const x: T = fn(...)` in TS, `val x: T = fn(...)` in Kotlin) and chai language
  chains (`.to.be.equal(...)`) now credit — these idiomatic pins previously read as no binding test.
- Under a probe cap, test files changed in the diff are probed first — the agent's own new tests get
  verified before the backlog.
- A proven function's evidence states "M via tests changed in this diff" when every binding test
  co-changed with the code (fact-only, never a verdict); capped functions count as "not probed (cap)",
  not "unverifiable".
- Finishing a turn over a still-flagged hollow (or already-failing) test emits a non-blocking
  `systemMessage` naming the unfixed test(s) — memo-backed, never re-probed, silent once the diff
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
