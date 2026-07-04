# Changelog

All notable changes to Gutcheck are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **`prove()`'s result field `changedCount` is renamed `changedFileCount`** — it counts changed *files*,
  not the functions the report refers to; the old name read as if it counted functions. `--json`
  consumers are pre-publish, so this is a clean rename, not a compat-aliased one.

## [0.2.0] — 2026-07-03

First published release: the probe is the product.

### Renamed
- **Skeptic is now Gutcheck.** The package, plugin, marketplace, command slug (`/gutcheck:check`), and
  config files (`gutcheck.config.json`, `configure/gutcheck.default.json`) all use the new name.
  Ships as a **single** plugin bundle, `dist/gutcheck` — there is no `dist/gutcheck-agents` or
  `dist/gutcheck-gemini`.

### Added
- **`gutcheck` CLI** (`mutation/gutcheck.mjs`) — the front door. Default `gutcheck [path] [--since=<ref>]`
  runs the mutation probe over your tests and reports the hollow ones, fronted by a self-check that must
  catch its own planted fake test before it reports. Plus `gutcheck lint` (sub-second static triage),
  `gutcheck --explain <file:line>` (the proof for one verdict), and `--json` / `--format=sarif` /
  `--format=github` for CI.
- **Probe-driven agent loop** — the opt-in `Stop` hook (`hooks/check-changed-tests`) now drives the
  execution-proven probe over the tests an agent just changed, blocking only on a proven HOLLOW verdict;
  opt-in via a `.gutcheck` marker.
- **CI gate** — `ci/gutcheck.yml`: a copy-paste workflow that runs the probe on the PR diff and uploads
  SARIF (code-scanning) or emits inline `::error` annotations.
- **Probe reliability** — a flaky test is reported `INCONCLUSIVE`, never a false `HOLLOW`; a bounded,
  logged probe cap (`--max-probes`); an ambiguous-SUT guard; and a `--since` symlink-scope fix so a changed
  test is never silently dropped.

### Changed
- **The mutation probe is the front door**, the static checker the secondary triage. The deterministic
  checker floor is now five source-discipline checks (test shapes, uncited expected floats, derivation
  coherence, assertion consistency, citation-needs-url).
- **Hooks are fully opt-in**, gated by `.gutcheck` flags: an empty marker enables the `Stop` hook alone;
  `session-skill` additionally injects the check skill at startup; `prompt-cue` additionally rides
  substantive prompts with the foundation-verification cue.
- **The `Stop` hook probes from the session baseline**, not just `HEAD` — work an agent already
  committed this session is still caught — driven entirely through the `gutcheck` front door
  (`gutcheck --json --no-fallback --max-probes=20`).
- **`selfcheck` now fronts the machine-readable modes too** (`--json`, `--format=sarif`,
  `--format=github`), not just the human-readable report — a failed self-check fails closed everywhere.

### Removed
- **The classic textual mutation tester** (whole-suite mutant runs in a git worktree) — superseded by the
  diff-scoped probe.
- **The markdown-harness check kinds and the SI-constants catalogue** — orphaned from an after-AI
  test-quality tool; the FP-heavy shadow / weak / assertion-free guards are demoted out of the default floor.
- **The legacy `skeptic` / `skeptic-check` bins and `skeptic init`** — cut pre-publish, not deprecated:
  the package has never shipped under the `skeptic` name, so there was no installed compatibility surface
  to preserve. `gutcheck` (the probe CLI) and `gutcheck lint` (the embedded static checker, via
  `checker/standalone.mjs`) are the only entry points now.
- **The template/render machinery** (`configure/render.mjs`, `packs/`, per-adopter goldens) — skills and
  agents are now plain markdown, maintained in place and copied verbatim into `dist/gutcheck` by
  `npm run build:plugin`; there is nothing left to render.
- **Eleven non-probe checksets** (cpp, csharp, fortran, go, haskell, jvm, julia, php, ruby, rust, swift) —
  `configure/checksets/` now registers only `python`; JS/TS's floor lives directly in
  `configure/gutcheck.default.json`. `detect.mjs` still names the other eleven build systems so
  `gutcheck lint` can report on them, but they carry no check set until calibrated in.
- **The config JSON Schema and eight dead config fields** (`docs.findingIdScheme`, `docs.backlogFile`,
  `identity.agentFamilyRule`, `identity.legacySlugs`, `commands.buildPassLine`, `commands.resultsDir`,
  `commands.longRunningCmd`, `commands.testSingleSelector`) — no product code read them. `ajv` is no
  longer a dependency.

### Fixed
- `--since` now accepts the space form (`--since <ref>`), not only `--since=<ref>`.
- Path errors (a bad `--explain` target, an unresolvable directory) report a friendly message instead of
  a raw stack trace.
- `--max-probes` is honored on the `Stop`-hook path too, bounding latency on a large agent-driven diff.
- Skipped tests are labeled by reason (`no-pin`, `sut-unresolved`, `ungutable`, …) instead of one
  undifferentiated "skipped" bucket.
- A failed baseline probe (bad `--since` ref, no git repo) reports what went wrong instead of silently
  scoring zero.
- **The de-hollowed own-suite test** — a test in Gutcheck's own suite that passed even when its subject
  was gutted is now a real, mutation-surviving assertion.

## [0.1.0] — 2026-06-26

First public release.

### Added
- **Verification disciplines** — skills and agents for citation verification (fetch, classify, quote),
  sound test oracles (the oracle-construction ladder), a test reviewer with a planted-defect catch-trial,
  debugging, TDD, brainstorming, and planning. These are prose disciplines, not machine-enforced.
- **Deterministic coherence checker** (`checker/`) — config-driven structural checks that refuse to
  run unless each passes its own must-flag / must-not-flag self-test (the meta-guard).
- **Mutation-testing harness** (`mutation/`) — fault-detection scoring with a self-test gate and
  git-worktree-isolated runs.
- **Per-adopter calibration** (`configure/`) — `detect.mjs` drafts a `skeptic.config.json`; the
  templates render from it, validated against a published JSON Schema.
- **Three install profiles** — a Claude Code plugin (`dist/skeptic`), an `AGENTS.md`-native bundle
  (`dist/skeptic-agents`), and a Gemini CLI extension (`dist/skeptic-gemini`).
- **Opt-in mechanical enforcement** — a config-driven pre-push gate (`scripts/gate.sh`) and a CI
  template (`ci/github-actions.yml`).

[Unreleased]: https://github.com/beepometer/gutcheck/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/beepometer/gutcheck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/beepometer/gutcheck/releases/tag/v0.1.0
