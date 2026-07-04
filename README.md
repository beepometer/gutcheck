# gutcheck

[![CI](https://github.com/beepometer/gutcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/beepometer/gutcheck/actions/workflows/ci.yml)

**Prove your AI-written tests actually test your code.** gutcheck guts each function under test —
replaces its body with a guaranteed-wrong `return 987654321` — and reruns only the test that covers it.
A test that still passes is *hollow*: it doesn't test what it claims to. gutcheck reports it by file, line,
and the function it failed to catch.

```console
$ npx gutcheck --since origin/main          # or, inside Claude Code: /gutcheck:check

probed 1 function · runner=node
gutcheck: 1/1 tests (100%) fail when the function they test is broken.  [1 probes, runner: node]
✓ verified 1 function your tests genuinely catch (broke each, the test went red). 0 test(s) skipped (see banner for reasons).

change verification: 2 functions changed
  proven 1 · hollow 0 · unverifiable 0 · untested 1

untested (no test mentions them): 1
  ghost
```

The PR touched two functions. `dbl` is **proven** — gutcheck broke it and the existing test went red.
`ghost` is **untested** — no test mentions it, so gutcheck has nothing to check it against. That's the
report on every diff-scoped run: not just pass/fail, but what's actually proven versus merely present.

Here's the other half of the same report: a test that looks like it covers a function but doesn't.

```console
$ npx gutcheck --since origin/main

probed 2 functions · runner=node
gutcheck: 0/2 tests (0%) fail when the function they test is broken.  [2 probes, runner: node]

2 test(s) pass even when their function is gutted — they don't actually test it:
  ✗ test/cart.test.mjs:3  "computes the total"  — survives gutting computeTotal()
  ✗ test/cart.test.mjs:4  "applies the discount"  — survives gutting applyDiscount()

change verification: 2 functions changed
  proven 0 · hollow 2 · unverifiable 0 · untested 0

hollow (survives gutting — doesn't test it): 2
  computeTotal, applyDiscount
```

Those two tests are green in CI today. They'd stay green if `computeTotal` returned garbage. gutcheck
shows you which ones, in seconds — and on a diff-scoped run like this one, the change-verification
section says the same thing again from the other direction: of the two functions this PR touched, zero
are proven, both are hollow.

## How it works

For each test, gutcheck finds the function it exercises, swaps that function's body for a wrong return,
and reruns *only that one test*. If the test still passes, the function isn't really under test. That's
the whole idea — a known instance of [mutation testing](https://en.wikipedia.org/wiki/Mutation_testing),
scoped down to something you can run on every change:

- **`--since=<ref>`** (or `--since <ref>` — both forms are accepted) limits the probe to tests touched
  since a ref (e.g. `origin/main`), so it finishes in seconds instead of mutating your whole suite.
- **Runner auto-detected** — vitest, jest, mocha, ava, `node:test`, or pytest. The probe covers JS/TS and Python.
- **Self-checked** — before reporting anything, gutcheck runs a planted fake test and a planted real one;
  it won't trust its own output until it catches the fake and clears the real one.

Every diff-scoped run reports what changed and what's proven: functions whose tests went red when
gutcheck broke them, functions whose tests can't verify them (with reasons), and functions no test
mentions.

Expect only a minority of tests to be probeable on a typical codebase: a test must pin a concrete
value, and the function it tests must be locatable from the test file's own imports. Every run's
banner reports exactly what was skipped and why — the number gutcheck verified is always explicit,
never implied.

## Commands

```
gutcheck [path] [--since=<ref>]   gut each tested function, rerun its test, report the hollow ones
gutcheck lint [path]              sub-second static triage (derivation, assertion, and shape checks)
gutcheck --explain <file:line>    show the proof for one test: the mutation applied + before/after
gutcheck [path] --json            machine-readable result (CI / the agent hook)
gutcheck [path] --format=sarif    SARIF 2.1.0 for code-scanning upload
gutcheck [path] --format=github   GitHub ::error inline PR annotations
gutcheck [path] --format=markdown Markdown diff verification report (for PR bodies / sticky comments)
```

`--explain` is the receipt for any single verdict:

```console
$ gutcheck --explain src/cart.test.ts:14
src/cart.test.ts:14 "computes the total"
  → HOLLOW. gutcheck replaced computeTotal()'s body with `return 987654321` and reran only this test.
  before: PASS   after gutting computeTotal(): PASS  ← the test can't tell the function is broken.
  Fix: assert the real expected value, not one re-derived from the function under test.
```

## Install

Standalone — needs only **Node 20+**, nothing to install:

```bash
npx gutcheck --since origin/main
```

(The agent hook and CI template live in the git repo / plugin bundle, not the npm package.)

New here? `npx gutcheck --demo` plants a tiny two-test example and shows a real catch in seconds — no
project needed.

As a Claude Code plugin (adds the `/gutcheck:check` skill and the opt-in `citation-verifier` agent):

```
/plugin marketplace add beepometer/gutcheck
/plugin install gutcheck@gutcheck
```

Or, from a clone, point Claude Code straight at the bundle without installing:
`claude --plugin-dir <repo>/dist/gutcheck`.

## In your agent loop and CI

**Agent hook.** An opt-in `Stop` hook (`hooks/check-changed-tests`) re-probes the tests an agent just
changed and asks it to fix the hollow ones before claiming done. It runs only when a `.gutcheck` marker
file exists in the repo, so it's off until you opt in.

**CI gate.** Copy [`ci/gutcheck.yml`](ci/gutcheck.yml) to `.github/workflows/`. With `fetch-depth: 0`,
`--since` scopes the probe to the PR's diff. Use `--format sarif` to surface hollow tests as
code-scanning alerts, or `--format github` for failing inline annotations on the PR. The file's commented
Mode C posts `--format=markdown`'s diff verification report as a sticky PR comment instead.

## Scope and limits

- The **probe** covers JS/TS and Python. A test is only probed if it pins a concrete value
  (`toBe`/`toEqual`/`strictEqual`/`===`); tests that assert nothing checkable — or whose tested function
  can't be located — are skipped and counted by reason, not flagged.
- **`gutcheck lint`** is three near-zero-false-positive static checks — derivation coherence, assertion
  consistency, and hollow-test shapes — discipline lints for freshly generated tests, **not a
  bug-finder**: they flag tests shaped wrong, not code that's wrong.
- The magic-literal check is deliberately strict on numeric code and can be noisy; multi-line / fluent
  assertions need a real parser, which gutcheck deliberately doesn't bundle.
- gutcheck tells you a test is weak. Whether the *code* is correct is still your call.
- **Windows:** not currently supported (probe verdicts differ on win32 — under investigation). macOS
  and Linux are CI-tested on Node 20/22.
- gutcheck never fails your CI over its own inability to run: a suite whose baselines fail, or an
  empty `--since` scope, exits 0 with the reason on the banner. Only proven hollow tests exit 1;
  scope/config errors exit 2.

## Prior art and license

The probe is ordinary mutation testing in the spirit of Stryker, PIT, and the "pseudo-tested method"
work — narrowed to a diff so it's cheap enough to run constantly. The agent disciplines credit the
[superpowers](https://github.com/obra/superpowers) project; gutcheck is a standalone tool, not a fork.

Contributing? See [CLAUDE.md](CLAUDE.md). MIT licensed.
