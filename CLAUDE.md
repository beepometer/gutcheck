# Developing Gutcheck

Gutcheck is one product: the mutation probe (`mutation/`) with its CLI front door (`gutcheck`), a
sub-second lint (three checker kinds via `checker/`), and the opt-in agent hooks (`hooks/`), shipped
as a CLI (npm) and a Claude Code plugin (`dist/gutcheck`).

## Layout

- `mutation/` — the probe: `prove.mjs` (engine), `gutcheck.mjs` (CLI), `probe.mjs` (gut/stub
  mutations), `confirm.mjs`, `selfcheck.mjs` (fail-closed catch-and-survive trial), `py_blocks.py`.
- `checker/` — the deterministic checker that powers `gutcheck lint` (`standalone.mjs
  configForProject` + `core.mjs` + `kinds/`). `checker/cli.mjs` is the config-driven entry the
  `check` skill runs.
- `configure/` — `detect.mjs` (repo → checker config) + `gutcheck.default.json` (the JS/TS floor) +
  `checksets/python.mjs`.
- `skills/`, `agents/`, `hooks/` — plain markdown/bash, maintained in place (no templating).
- `dist/gutcheck` — the installable plugin bundle. **Generated**: `npm run build:plugin` copies the
  source dirs verbatim and stamps `.claude-plugin/plugin.json` from `package.json`. Never hand-edit;
  `test/plugin-dist.test.mjs` enforces byte-sync + no orphans.

## Gates — keep them green

- `npm test` — the whole suite (probe, CLI, lint kinds, hooks, dist sync). Runs in CI on every push.
- `npm run build:plugin` — must be deterministic (running it twice leaves `git status` clean).
- `bash scripts/gate.sh` — the dogfood gate (reads `gutcheck.config.json`); opt-in pre-push hook via
  `bash scripts/install-hooks.sh`.
- Dogfood the probe: `node mutation/gutcheck.mjs . --max-probes=2000` should report **0 hollow** on
  this repo (the `--max-probes` overrides the user-facing default cap of 40 so the self-check covers
  every function). If it flags one of our tests, fix the test — that is the product working.

## Workflow

Plan → write a sound RED test (an independently-derived oracle, never pinned from the code's own
output; confirm it bites — the probe itself is the check) → implement → fresh `npm test` +
`npm run build:plugin` before any "done" claim. After edits to `mutation/`, `checker/`, `configure/`,
`hooks/`, `skills/`, or `agents/`, rebuild the plugin and commit `dist/` in the same change.

## Editorial rules

- No history/provenance/self-justification narration in skills or agents — instructions, not stories.
- Frontmatter `description:` stays a tight, trigger-only "Use when…" line.
- No effectiveness or outcome claims in README/docs; sell mechanism + receipts (`--explain`) only.
