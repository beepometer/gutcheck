# aider recipe

aider has no hook system, so there is no `gate.mjs` harness adapter here — this is a recipe for
aider's own generic test loop: `--test-cmd '<cmd>' --auto-test` runs `<cmd>` after every edit aider
applies; on a non-zero exit, aider feeds the command's output back into the same turn and lets the
model try again, up to `max_reflections` (aider's own setting, default 3). Pointing `--test-cmd` at
gutcheck turns that loop into a hollow-test gate.

## The command

gutcheck's exit codes (verified live against this repo's CLI): 0 when every probed test proved its
function, 1 when at least one probed test is hollow, 2 on a scope or usage error (bad path, unknown
flag, unresolvable `--since`). aider only reacts to zero vs. non-zero, so all of 1 and 2 trigger a
reflection — see Honest boundaries below for what that means for a plain typo.

`--since HEAD` scopes the probe to what changed since `HEAD`, and it does pick up *uncommitted*
working-tree edits, not just committed ones (verified live: an uncommitted, tracked-file edit
introducing a hollow test was correctly reported and exited 1). aider auto-commits every edit by
default, though, and once an edit is committed, `HEAD` **is** that edit — `--since HEAD` then diffs
against itself and reports nothing (verified live: exit 0, `no files changed since HEAD`), a silent
false negative in the loop's most common configuration.

Two supported configurations follow from that:

**Recommended — run aider with `--no-auto-commits`:**

```
aider --no-auto-commits --test-cmd 'npx --yes gutcheck --since HEAD --no-fallback' --auto-test
```

Edits stay uncommitted until you review and commit them yourself; `--since HEAD` then always scopes
to the work aider is currently doing. This is the configuration this recipe is verified against.

**Fallback — default auto-commit sessions:**

```
aider --test-cmd 'npx --yes gutcheck --since HEAD~1 --no-fallback' --auto-test
```

Scoping to `HEAD~1` catches the auto-commit's own diff (verified live: the same hollow-introducing
edit, now auto-committed, was caught with `--since HEAD~1`, exit 1). This is documented as a
fallback, not the recommendation, because of a boundary this recipe cannot close: whether aider
runs `--test-cmd` before or after it creates that auto-commit, and whether exactly one commit is
made per test-cmd invocation, are not established facts here — aider was not available in this
environment to check live, and nothing else in this project's records states the ordering. `HEAD~1`
is also fragile on its own terms regardless of that ordering: it breaks on a repo's very first
commit (no parent to diff against), and it assumes one aider commit per reflection round — a
squashed or multi-file commit changes what it captures. Use `--no-auto-commits` where you can.

`--no-fallback` keeps both commands scoped to the current diff: without it, an edit that touches no
probeable test (docs, config) would widen to a full-suite scan on every reflection — slower, and
liable to surface a pre-existing hollow test the current edit never touched.

## What happens on a hollow

1. aider applies an edit, then runs the `--test-cmd`.
2. gutcheck probes the tests touched by the scoped diff and prints its report to stdout (which test
   is hollow, and which function it fails to catch when gutted).
3. Exit 1 — aider treats this as a failing test command: the printed report is fed back into the
   same turn as the reflection's input, and the model attempts another edit.
4. gutcheck reruns on the next edit. This repeats until the exit is 0 or `max_reflections` (default
   3) is reached — both are aider's own loop mechanics, unchanged by anything gutcheck does.

## Honest boundaries

- This is aider's generic test-command loop, not a purpose-built gate: aider has no notion of
  'hollow' distinct from any other failing command — a non-zero exit is a non-zero exit. A scope or
  usage error (exit 2 — a typo in the `--test-cmd` string, an unresolvable `--since` ref) burns a
  reflection exactly like a real hollow finding does; test the command by hand once before wiring it
  into `--auto-test`.
- No block semantics: there is no structured decision payload the way the Claude Code plugin's Stop
  hook has (block / clean-voice / residue channels) — aider only ever sees exit code plus stdout/stderr
  text.
- No memo or one-shot guard: nothing stops aider from reflecting on the same unresolved hollow finding
  across all of its reflections if the model's fix doesn't change the verdict; the only cap is aider's
  own `max_reflections`.
- No receipts beyond what the report prints: the fed-back text is exactly gutcheck's stdout for that
  run. For the mutation-and-rerun proof behind one specific hollow test, run
  `npx gutcheck --explain <file:line>` yourself — that is not part of the automatic loop.

## Verification level

Recipe verified against the CLI's exit-code contract; live aider pilot pending.
