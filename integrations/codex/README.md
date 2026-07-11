# Codex CLI integration

A protocol adapter over the shared gate (`mutation/gate.mjs`'s `codex` harness entry, exposed as
`gutcheck gate --harness=codex`): the same diff-scoped mutation probe Claude Code's plugin runs on
`Stop`, wired to Codex CLI's own hooks contract.

## Install

1. Install `gutcheck` (`npm install --save-dev gutcheck`, or a global install).
2. Copy `hooks.json` from this directory into Codex's hook-registration location: `~/.codex/hooks.json`
   for every session, or a project-local `.codex/hooks.json` for this repo only (also
   registerable as an inline `[hooks]` TOML table in `config.toml` — this template ships the
   `hooks.json` form). Merge it into an existing file rather than overwriting if you already have
   other hooks registered. If Codex's registration file wraps events in an outer key, nest these
   entries under it — the template uses top-level event keys, the minimal reading of the
   documented contract.
3. The `SessionStart` entry's command (`node_modules/gutcheck/hooks/session-start`) assumes a
   local project install; adjust the path if you installed globally (`$(npm root -g)/gutcheck/hooks/session-start`)
   or from a cloned repo. This entry is optional: without it, the `Stop` gate still works, using
   `HEAD` as its baseline (it probes the current uncommitted diff) rather than the exact
   session-start commit — a multi-commit session just loses coverage of commits made mid-session,
   nothing else changes. Note: if the project you run Codex in has a `.gutcheck` file with a
   `session-skill` line (a Claude Code feature) and `session-start` is invoked from a cloned-repo
   install, the script will emit Claude-shaped JSON Codex won't recognize — remove that line from
   the project, or don't wire `SessionStart` from a clone.

## What fires when

- `SessionStart` records the session's starting `HEAD` to `<git-dir>/gutcheck-baseline` so the
  `Stop` gate can probe everything the agent touched this session, committed or not.
- `Stop` re-probes the test files changed since that baseline. On a proven-hollow test, or a
  changed test that already fails before any mutation runs, it prints `{"decision":"block","reason":"..."}`
  — Codex continues the turn using `reason` as the continuation prompt. `stop_hook_active` gates
  the retry the same way Claude Code's Stop hook does: one forced attempt, never a second block on
  the same diff.
- Clean runs and the post-retry residue notice stay silent for Codex: `systemMessage` on a clean
  `Stop` exit is not a confirmed Codex channel, so both are off rather than guessed at.

## Opt-outs

Same switches as every other surface, because they live in the shared gate core, not this
adapter: a `.gutcheck-off` file anywhere from the working directory up to the repo root disables
the `Stop` gate for that repo; `GUTCHECK_HOOK=off` in the environment disables it everywhere.

## Verification level

Protocol adapter, tested against the documented Codex hooks contract; live pilot pending.
