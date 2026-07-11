# Integrations

These directories are registration templates for the shared Stop-hook gate (`mutation/gate.mjs`,
exposed as `gutcheck gate --harness=<name>`) on agent CLIs other than Claude Code — copy the
relevant `<harness>/hooks.json` into that harness's hook-registration location and adjust the
paths for your install, per that harness's own `README.md` in this tree. Claude Code ships the
gate as a default-on plugin (`dist/gutcheck`, see the repo root `README.md`); everything under
`integrations/` is a template you install yourself.
