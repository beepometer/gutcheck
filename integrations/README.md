# Integrations

These directories are registration templates for the shared Stop-hook gate (`mutation/gate.mjs`,
exposed as `gutcheck gate --harness=<name>`) on agent CLIs other than Claude Code — copy the
relevant `<harness>/hooks.json` into that harness's hook-registration location and adjust the
paths for your install, per that harness's own `README.md` in this tree. Claude Code ships the
gate as a default-on plugin (`dist/gutcheck`, see the repo root `README.md`); everything under
`integrations/` is a template you install yourself.

| Harness | Mechanism | Install | Verification level |
| --- | --- | --- | --- |
| Codex CLI | `Stop` hook, `{decision:'block',reason}` — protocol twin of Claude Code's, same `stop_hook_active` loop guard; clean-run and residue voice off (unconfirmed channel) | [codex/README.md](codex/README.md) | Protocol adapter, tested against the documented Codex hooks contract; live pilot pending |
| Cursor | `stop` hook, `{followup_message}` re-prompt (Cursor auto-submits it as the next user message) — gated on `status:'completed'`, `loop_count` plus a diff-hash one-shot guard cap the retry; no SessionStart, baseline falls back to `HEAD` | [cursor/README.md](cursor/README.md) | Protocol adapter, tested against the documented Cursor hooks contract; live pilot pending |
| Copilot coding agent | `.github/hooks/` `agentStop` (aliased `Stop`), `{decision:'block',reason}` — no loop-guard flag from Copilot itself, so the memo one-shot guard is the only thing preventing a re-block; runs in the agent's cloud VM, CI stays the outer backstop | [copilot/README.md](copilot/README.md) | Protocol adapter, tested against the documented contract; live pilot pending |
| Antigravity | `Stop` hook, `{decision:'continue',reason}` — gates only a clean, fully-idle stop (`model_stop` + `fullyIdle`); no loop-guard flag, so the memo one-shot guard is mandatory; template timeout raised to 120s | [antigravity/README.md](antigravity/README.md) | Protocol adapter, tested against the documented contract; live pilot pending |
| aider | No hook system — a recipe pointing `--auto-test`/`--test-cmd` at gutcheck's exit code; `--no-auto-commits` recommended so `--since HEAD` scopes to the current edit | [aider/README.md](aider/README.md) | Recipe verified against the CLI's exit-code contract; live aider pilot pending |

Opt-outs are shared across every harness above, because they live in the gate core, not any one
adapter: a `.gutcheck-off` file (honored from subdirectories) or `GUTCHECK_HOOK=off` disables the
gate the same way for all of them.
