# GitHub Copilot coding agent integration

A protocol adapter over the shared gate (`mutation/gate.mjs`'s `copilot` harness entry, exposed as
`gutcheck gate --harness=copilot`), wired to the Copilot coding agent's `agentStop` hook (aliased
`Stop`) — the same diff-scoped mutation probe Claude Code's plugin runs on `Stop`.

## Install

1. Install `gutcheck` as a dev dependency of the target repo (`npm install --save-dev gutcheck`) so it
   is present in the agent's cloud VM without a network fetch on every stop; a plain `npx --yes gutcheck`
   also works but pays a cold-start download cost on each invocation (see below).
2. Copy `hooks/gutcheck.json` from this directory into `.github/hooks/` in the target repo (create the
   directory if it doesn't exist). Merge it into an existing file rather than overwriting if you already
   have other hooks registered there. If Copilot's hooks schema wraps events under an outer key, nest
   these entries under it — the template uses top-level event keys, the minimal reading of the
   documented contract, and a hook registered in the wrong shape fails silently (it never fires; you get
   zero coverage with no error).
3. **This file must live on the repo's DEFAULT branch.** The Copilot coding agent reads hook
   registrations from the default branch, not from the branch or PR it is currently working on — a hook
   added only on a feature branch never fires for that same branch's session.

## What fires when

- `agentStop` (aliased `Stop`) fires when the main agent finishes a turn, running inside the agent's own
  cloud VM — not on your machine.
- The stdin payload carries no loop-guard flag of any kind (unlike Claude Code's `stop_hook_active` or
  Codex's twin). The memo-backed one-shot guard is therefore the ONLY thing preventing a re-block on the
  same unfixed diff: a block is recorded in the gate's memo the moment it fires, keyed to the current
  diff-hash, and refused a second time until that diff actually changes.
- On a proven-hollow test, or a changed test that already fails before any mutation runs, it prints
  `{"decision":"block","reason":"..."}` — Copilot uses `reason` as the next turn's prompt, the same shape
  Codex CLI's adapter uses.
- Clean runs stay silent: voice and residue channels are both off for this harness (a clean-run message
  is not part of the documented `agentStop` contract, and this harness's memo one-shot guard depends on
  those channels staying off — see `mutation/gate.mjs`'s `copilot` entry).

## Honest boundaries

- **The agent VM needs Node 20+ and this repo's own test toolchain already installed** (whatever test
  runner your `test/` directory depends on) — the gate shells out to the same `gutcheck` CLI a local
  install would, and that CLI in turn shells out to your repo's test runner. If the VM's image doesn't
  have your test dependencies available, the probe fails closed (silent, not a false block) rather than
  erroring the turn, but you also lose the gate's coverage entirely.
- **`npx gutcheck` cold-start cost**: unless `gutcheck` is a dev dependency already present in the VM's
  `node_modules`, every `agentStop` pays npm's package-resolution and download latency before the probe
  itself even starts. Installing it as a dev dependency (step 1 above) avoids this on every turn but the
  first.
- **CI remains the outer gate.** This hook runs inside the agent's own turn loop and can ask for one more
  attempt; it is not a substitute for your repository's CI checks on the resulting PR — a network
  failure, a VM image without your toolchain, or the one-shot guard having already fired once are all
  ways a hollow test can still reach a PR unblocked.

## Opt-outs

Same switches as every other surface, because they live in the shared gate core, not this adapter: a
`.gutcheck-off` file anywhere from the working directory up to the repo root disables the `agentStop`
gate for that repo; `GUTCHECK_HOOK=off` in the environment disables it everywhere.

## Verification level

Protocol adapter, tested against the documented contract; live pilot pending.
