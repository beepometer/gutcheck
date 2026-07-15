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
  mutation probe (`node mutation/gutcheck.mjs --json --no-fallback --since=<session-baseline> --max-probes=20 --time-budget=90`,
  self-check included) on the test files the agent changed since the session baseline
  (falling back to `HEAD` when no baseline is recorded), memoized per diff-hash so an
  unchanged diff is not re-probed across Stop turns. It returns `decision: block` with the
  fix guidance on `hookSpecificOutput.additionalContext` on two execution-backed signals: a
  test that is **proven HOLLOW** (stays green when the function it covers is gutted — and again
  under the opposite-signed gut, so the accusation is never a sign accident),
  or a changed test that already fails before any mutation runs. Probing from the baseline
  rather than `HEAD` means work the agent already committed this session is still caught. On
  a clean run that changed probeable functions it emits a one-line, non-blocking
  `systemMessage` (proven / untested / unverifiable counts); if a flagged test is left
  unfixed after the one forced retry, the next finishing turn carries a one-line non-blocking
  residue notice instead of silence. **Loop-safe:** it reads the Stop hook's
  `stop_hook_active` and blocks at most once (one forced attempt), so it can never loop.
  Fail-open (any error, missing tool, or a failed self-check → exit 0), bounded by a 120s
  timeout and a 90s probe wall-clock budget.

## Gates

The verification gate (baseline recording + the Stop-hook probe) is ON by default — it costs
compute only, never context tokens, and a repo the session did not touch costs one git diff. The
Stop-hook probe is capped — 20 functions and a 90-second wall-clock budget, inside the hook's
120-second timeout — and anything the cap cuts off is reported as not probed, never guessed.
Disable the Stop-hook probe per repo with a `.gutcheck-off` file anywhere from the session's
working directory up to the repo root (honored from subdirectories — `check-changed-tests` walks
up to the git toplevel looking for it), or globally with `GUTCHECK_HOOK=off`. `session-start`'s
baseline write checks only the exact session working directory for `.gutcheck-off` (no up-tree
walk), so a repo-root-only marker does not suppress baseline recording from a subdirectory —
harmless, since baseline recording never blocks or injects context.

The context-injecting extras stay opt-in via a `.gutcheck` file's contents, because they spend
your context tokens:
- a line `session-skill` — additionally inject the check skill as session context at
  startup (headless/autonomous runs). Also suppressed by `GUTCHECK_HOOK=off` (`session-start`
  gates both of its duties behind the same check).
- a line `prompt-cue` — additionally ride substantive prompts with the
  foundation-verification cue. Also suppressed by `GUTCHECK_HOOK=off`.

No `.gutcheck` marker → no context injection; the verification gate still runs unless opted out.

All hook files are **static and generic** (no `{{tokens}}`). The build copies them
verbatim into `dist/gutcheck/hooks/`; `test/plugin-dist.test.mjs` pins byte-identity.
