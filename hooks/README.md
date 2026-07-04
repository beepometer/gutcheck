# Gutcheck plugin hooks

Activation for the Claude Code plugin (`dist/gutcheck`).

- `hooks.json` — registers a `SessionStart` hook (matcher `startup|clear|compact`)
  that runs `bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-start"`, a `UserPromptSubmit`
  hook that runs `bash "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit"`, and a `Stop`
  hook (`timeout: 120`) that runs `bash "${CLAUDE_PLUGIN_ROOT}/hooks/check-changed-tests"`.
- `session-start` — records the session-start `HEAD` to `<git-dir>/gutcheck-baseline`
  (skipped on `compact`, which fires mid-task) so the Stop hook can probe everything the
  agent touched this session, committed or not. When the `.gutcheck` marker also contains
  a `session-skill` line, it additionally reads `skills/check/SKILL.md` from
  the plugin and injects it as `hookSpecificOutput.additionalContext`, so the discipline
  self-activates in headless / autonomous runs. Fail-open (never blocks a session).
- `user-prompt-submit` — when the `.gutcheck` marker contains a `prompt-cue` line,
  injects the foundation-verification cue as `hookSpecificOutput.additionalContext` on
  **substantive** prompts (short pleasantries and one-word follow-ups are skipped, gated
  in-script), so the no-trust discipline surfaces at decision time rather than only as
  loaded skill prose the model may decline to apply. Fail-open (never blocks a prompt).
- `check-changed-tests` — the verify-as-you-write loop: a `Stop` hook that runs the
  full checker (`node mutation/gutcheck.mjs --json --no-fallback --max-probes=20`,
  self-check included) on the test files the agent changed since the session baseline
  (falling back to `HEAD` when no baseline is recorded) and, when one is **proven HOLLOW**
  (stays green even when the function it covers is gutted), returns `decision: block`
  with the fix guidance on `hookSpecificOutput.additionalContext`, so the agent rewrites
  the test before finishing. Probing from the baseline rather than `HEAD` means work the
  agent already committed this session is still caught. **Loop-safe:** it reads the Stop
  hook's `stop_hook_active` and blocks at most once — one forced attempt — so it can never
  loop. Fail-open (any error, missing tool, or a failed self-check → exit 0), bounded by a
  120s timeout.

## The `.gutcheck` marker

All hooks are opt-in per repo via a `.gutcheck` file at the repo root (the legacy
`.skeptic-baseline` marker name is still accepted by the Stop hook):

- **empty file** — Stop hook only: when the agent claims done, the tests it touched this
  session (committed or not) are re-probed; proven-HOLLOW tests block with a fix request.
  Nothing is injected into your context, ever.
- a line `session-skill` — additionally inject the check skill as session context at
  startup (headless/autonomous runs).
- a line `prompt-cue` — additionally ride substantive prompts with the
  foundation-verification cue.

No marker → the plugin does nothing.

All hook files are **static and generic** (no `{{tokens}}`). The build copies them
verbatim into `dist/gutcheck/hooks/`; `test/plugin-dist.test.mjs` pins byte-identity.
