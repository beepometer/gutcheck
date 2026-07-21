# Contributing to Gutcheck

Thanks for your interest in Gutcheck. This is a short public-facing guide; the full contributor
charter lives in [CLAUDE.md](CLAUDE.md). Read it before a non-trivial change.

## Prerequisites

- **Node 20+** (the probe, the checker, the build, and the tests are all Node).
- `npm install`—Gutcheck has zero dependencies, so this is a no-op; run it anyway to get a clean
  `package-lock.json`.

## Keep the gates green

Every change must pass:

- **`npm test`** — the whole suite: the probe, the CLI, the lint kinds, the hooks, and dist-no-drift.
  This is Gutcheck's own self-check and runs in CI on every push.
- **`npm run build:plugin`** — must rebuild `dist/gutcheck` byte-identically (running it twice leaves
  `git status` clean).
- Dogfood the probe: `node mutation/gutcheck.mjs . --max-probes=2000` should report **0 hollow** on this
  repo (the flag overrides the default cap of 40 so every function is covered). If it flags one of our
  tests, fix the test — that is the product working.

## Editing a skill or agent

`skills/` and `agents/` are plain markdown, maintained in place — edit the file directly, no
intermediate build step to keep in sync. Then rebuild the plugin:

1. Edit `skills/check/SKILL.md` or `agents/citation-verifier.md`.
2. Rebuild the plugin: `npm run build:plugin`—it copies the source dirs verbatim into `dist/gutcheck`
   and stamps `.claude-plugin/plugin.json` from `package.json`.

Never hand-edit anything under `dist/` — it is generated. After any edit that renames a heading or
trims a section, grep the repo to confirm no path cross-reference now dangles (the gates do not catch
every dangling reference).

## Editing the probe or checker

Changes to `mutation/`, `checker/`, or `configure/` follow the same rebuild step above. Plan → write a
sound RED test (an independently-derived oracle, never pinned from the code's own output) → implement →
fresh `npm test` + `npm run build:plugin` before claiming done. See [CLAUDE.md](CLAUDE.md) for the full
workflow.
