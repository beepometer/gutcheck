# Cursor integration

A protocol adapter over the shared gate (`mutation/gate.mjs`'s `cursor` harness entry, exposed as
`gutcheck gate --harness=cursor`), wired to Cursor's own `stop` hook. Cursor's `stop` hook cannot block
the turn the way Claude Code's or Codex's can — it can only return `{"followup_message": "..."}`, which
Cursor auto-submits as the NEXT USER message. This adapter uses that channel as a re-prompt gate: on a
proven-hollow test (or a changed test that already fails before any mutation runs), it hands back the
same block text Claude Code/Codex would show, phrased as an instruction, and Cursor resubmits it as if
the user had typed it.

## Install

1. Install `gutcheck` (`npm install --save-dev gutcheck`, or a global install).
2. Copy `hooks.json` from this directory into `.cursor/hooks.json` (this project only) or
   `~/.cursor/hooks.json` (every Cursor session). Merge it into an existing file rather than overwriting
   if you already have other hooks registered.

## What fires when

- `stop` fires whenever a Cursor agent turn ends. The gate reads `{status, loop_count}` from stdin and
  gates ONLY `status === 'completed'` — an aborted or errored turn is not ours to re-prompt.
- On a proven-hollow test, or a changed test that already fails before any mutation runs, it prints
  `{"followup_message": "..."}` — Cursor auto-submits that text as the next user message, continuing the
  turn.
- `loop_count > 0` means Cursor already auto-submitted our own previous `followup_message` once and the
  agent stopped again — the gate treats that exactly like Claude Code's `stop_hook_active` and allows the
  stop (never forces a second retry from this signal alone).
- Belt-and-braces: a memo-backed one-shot guard also records the block against the current diff-hash the
  moment it fires, and refuses to block again while that diff stays unchanged — independent of
  `loop_count`, in case some later, unrelated stop event still carries the same unfixed diff. Cursor's own
  `loop_limit` (default 5 auto-follow-ups) is a second, coarser cap on top of both.
- Clean runs stay silent: unlike Claude Code, there is no clean-run voice channel here — a
  `followup_message` on a clean stop would re-open the turn, which is noise, not signal. There is no
  residue channel either, for the same reason.

## Coverage boundary — no session baseline

Cursor has no SessionStart-equivalent hook, so nothing ever records a `<git-dir>/gutcheck-baseline` file
on Cursor's own behalf. The gate's baseline resolution falls back to `HEAD` unless another gutcheck
integration's SessionStart has already recorded a baseline in this repo (the baseline file lives at the
git-dir level, shared by every harness working in it — Codex's `SessionStart` entry is the one that
writes it today). Where nothing has recorded a baseline, in practice:

- **Covered:** everything currently uncommitted (staged or in the working tree) at the moment `stop`
  fires.
- **Not covered:** anything the agent committed mid-session, before this final stop — those changes are
  already part of `HEAD` and drop out of the diff the gate probes. A long Cursor session that commits
  along the way only gets the last stop's uncommitted tail checked, not the whole session's work.

If you want session-wide coverage, keep everything uncommitted until the session's final `stop` (commit
once, at the end), or run `gutcheck` by hand against the session's actual starting commit.

## Loop behavior

One forced follow-up per unfixed diff, maximum — the memo one-shot guard above enforces that regardless
of `loop_count`. Cursor's own `loop_limit` (default 5) is a second, independent cap on auto-follow-ups.

## Opt-outs

Same switches as every other surface, because they live in the shared gate core, not this adapter: a
`.gutcheck-off` file anywhere from the working directory up to the repo root disables the `stop` gate for
that repo; `GUTCHECK_HOOK=off` in the environment disables it everywhere.

## Verification level

Protocol adapter, tested against the documented Cursor hooks contract; live pilot pending.
