# Changelog

All notable changes to Gutcheck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- The Stop-hook gate is extracted into `mutation/gate.mjs` (`gutcheck gate --harness=<name>`)
  behind a harness-adapter interface; the Claude Code plugin's bash hook is now a thin caller over
  it — behavior-neutral for Claude Code, byte-identical block/voice/residue messages.
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

- README audited end-to-end (seven-agent claim review, launch pre-mortem, blunder pass): the
  flagship example, the plugin section, and the opening now match the tool as shipped.
- Reader-facing output surfaces use single quotes consistently.
- Maven repos fail closed at the probe entry point instead of falling through to the node runner
  and drowning the report in inconclusive noise.
- Kotlin Multiplatform (`jvmTest` + clean skips for unsupported source sets) reaches npm.

## [0.2.0] — 2026-07-08

First release.
