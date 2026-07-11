# Google Antigravity integration

A protocol adapter over the shared gate (`mutation/gate.mjs`'s `antigravity` harness entry, exposed as
`gutcheck gate --harness=antigravity`), wired to Antigravity's own `Stop` hook — the same diff-scoped
mutation probe Claude Code's plugin runs on `Stop`.

## Install

1. Install `gutcheck` (`npm install --save-dev gutcheck`, or a global install).
2. Copy `hooks.json` from this directory into `.agents/hooks.json` (this workspace only) or
   `~/.gemini/config/hooks.json` (every Antigravity session). Merge it into an existing file rather than
   overwriting if you already have other hooks registered.

## What fires when

- `Stop` fires when an Antigravity agent turn ends. The gate reads `{terminationReason, fullyIdle,
  conversationId, workspacePaths, ...}` from stdin.
- **Gate ONLY a clean, fully-idle stop**: `terminationReason === 'model_stop' && fullyIdle === true`.
  `terminationReason` values of `error` or `max_steps_exceeded` are never gated — re-entering a turn that
  already errored out or already hit its own step ceiling is exactly how a gate turns into a hang instead
  of a fix. If Antigravity is stopping for any reason other than the model itself choosing to finish,
  this hook stays silent and lets that stop through.
- On a proven-hollow test, or a changed test that already fails before any mutation runs, it prints
  `{"decision":"continue","reason":"..."}` — this is Antigravity's own verb for "prevent the stop and
  inject this text as the next turn's input", the same `{decision, reason}` shape Claude Code and Codex
  use with a different verb.
- The stdin payload carries no loop-guard flag of any kind. The memo-backed one-shot guard is therefore
  the ONLY thing preventing a re-block on the same unfixed diff: a block is recorded in the gate's memo
  the moment it fires, keyed to the current diff-hash, and refused a second time until that diff actually
  changes.
- Clean runs stay silent: voice and residue channels are both off for this harness (a clean-run message
  is not part of the documented `Stop` contract, and this harness's memo one-shot guard depends on those
  channels staying off — see `mutation/gate.mjs`'s `antigravity` entry).

## Multi-root workspace limitation

Antigravity's `Stop` payload includes `workspacePaths`, and this adapter reads `workspacePaths[0]` to
resolve the gate directory (overriding the hook process's own cwd when the two differ). Any other shape —
the field absent, an empty array, a non-string first entry, or a non-array value — falls back to cwd
rather than throwing or silently gating nothing. If your Antigravity session has **more than one**
workspace root open, only the first path is probed; changes confined to a second or later root are not
covered by this hook at all. Run `gutcheck` by hand against that root if you need coverage there.

## Timeout

Antigravity's hook default timeout (30s) does not reliably fit a mutation probe — a hollow-test check
guts a function and reruns its test, which on a real test suite can take longer than that. The shipped
template sets `"timeout": 120`. If your repo's test suite is slower still, raise it further; a timed-out
hook fails open (silent), same as every other error path in the gate.

## Opt-outs

Same switches as every other surface, because they live in the shared gate core, not this adapter: a
`.gutcheck-off` file anywhere from the working directory up to the repo root disables the `Stop` gate for
that repo; `GUTCHECK_HOOK=off` in the environment disables it everywhere.

## Verification level

Protocol adapter, tested against the documented contract; live pilot pending.
