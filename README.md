# Gutcheck

[![CI](https://github.com/beepometer/gutcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/beepometer/gutcheck/actions/workflows/ci.yml)

![gutcheck catching a hollow test and printing the receipt](docs/assets/demo.gif)

Gutcheck is a gate for AI-written changes: it checks whether the tests covering the functions an
agent changed can actually fail, and blocks or reports when they cannot. For each changed function
it guts the body — rewrites it to return a wrong constant — reruns just the test that covers it,
and records whether anything failed.

It is built for AI-generated changes, where the tests come from the same model as the code and can
look like verification without being able to fail: a test whose expected value is derived from the
function it covers stays green no matter what the function returns. A green suite alone does not
tell you whether any test in it can fail.

It runs wherever agents write code: a CI action that gates pull requests from any agent — Cursor,
Codex, Devin, aider, whatever opens the PR; in-loop gates for Claude Code, Codex, Cursor, Copilot's
coding agent, and Antigravity (Claude Code ships as a default-on plugin; the rest as integration
templates — see the gate section); and a CLI (`gutcheck`) for receipts on demand on any diff
(`--explain`, `--demo`).

Two rules hold throughout. Fail closed: what the tool cannot verify is reported as unverifiable
or skipped with a reason, never guessed. And proven means the tests bind the function, not that
the code is correct — a test can pin a wrong value and still bind.

```console
$ npx gutcheck --since origin/main

gutcheck self-check ✓ — caught its planted fake test, passed its planted real test
probing #1: test/cart.test.mjs :: 'counts items'
probing #2: test/cart.test.mjs :: 'computes the total'
gutcheck: 3 functions in this diff — 1 proven, 1 HOLLOW, 1 with no binding test.

hollow — the test passes even when the function is gutted; fix the test (receipt: gutcheck --explain <file:line>) (1):
  ✗ test/cart.test.mjs:9  'computes the total'  — survives gutting computeTotal()

no binding test — no test names it (1):
  applyDiscount

  (probed 2 fns · 1/2 bound · 0 skipped · runner node)
```

The diff added three functions and two tests, all green in CI. countItems is proven — gutting it
made its test fail. computeTotal's test computes its expected value from computeTotal itself, so
it survives gutting: hollow, with a receipt. applyDiscount has no test at all.

## Gate pull requests (any agent)

Whatever wrote the code — Cursor, Codex, Devin, aider, a human — the probe checks the PR diff.
One step in a workflow:

```yaml
permissions: { contents: read, pull-requests: write }
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }
  - uses: beepometer/gutcheck@v0   # or pin a full commit SHA
```

The action probes the PR diff (with `--no-fallback`, so it never silently widens to a full-suite
scan), annotates hollow and already-failing tests inline, writes the job summary, and keeps a
sticky PR comment with the verification table. By default it fails the job when a hollow test is
proven (`fail-on-hollow: false` reports without failing). Inputs: `path`, `since`, `max-probes`
(the action defaults it to 40), `comment`, `sarif-file`, `fail-on-hollow`, `node-version` — see
[action.yml](action.yml). For full control, copy [`ci/gutcheck.yml`](ci/gutcheck.yml) into
`.github/workflows/`.

The probe executes your project's own test suite. Run it on `pull_request` (as above), where fork
PRs run without repository secrets. Do not wire it to `pull_request_target` with a checkout of
the PR head — that pattern executes untrusted test code with your secrets, and no input of this
action needs them. Pin the action to a tag or commit SHA.

## Gate the agent loop

One shared gate (`mutation/gate.mjs`, exposed as `gutcheck gate --harness=<name>`) drives the
done-claim check inside the agent's own loop. Claude Code ships it as a default-on plugin — the
live, full-treatment integration below. Codex, Cursor, Copilot's coding agent, and Antigravity get
it as an integration template you register yourself; aider gets a recipe over its own reflection
loop. All five are listed after the Claude Code section, with what's shipped and what's still
pilot-pending.

### Claude Code

```
/plugin marketplace add beepometer/gutcheck
/plugin install gutcheck@gutcheck
```

The Stop hook re-probes the tests the agent changed since session start (the plugin records HEAD
at startup, so committed work is still covered) and blocks the done-claim once on two
execution-backed signals: a hollow test, or a changed test that already fails before any mutation
runs. Each is named with its receipt — the gutted function and its file, and for a failing test
the runner's own failure text. For a hollow test the block reads:

```
gutcheck: 1 test(s) you just changed are HOLLOW — they pass even when the function is gutted, so they don't actually test it. Fix them (receipt: gutcheck --explain <file:line>): assert the real expected value (not one re-derived from the function under test), then finish:
  - test/cart.test.mjs:9 'computes the total' — stays green even when computeTotal() (src/cart.mjs) returns a wrong value.
```

Untested or unverifiable functions never block. On a clean run that changed probeable functions
it prints one line — `gutcheck: of N function(s) you changed — X proven, Z with no binding test`
— and stays silent when the diff has nothing probeable. If a flagged test is left unfixed, the
finishing turn carries a one-line non-blocking notice instead of silence.

Cost: diff-scoped. A repo the agent did not touch costs one git diff (about half a second), runs
none of your tests, and never falls back to a full-suite scan. Probes are capped — 20 functions,
a 90-second wall-clock budget — inside the hook's 120-second timeout, and anything the cap cuts
off is reported as not probed, never guessed. Results are memoized per diff, so an unchanged diff
is not re-probed across turns. Opt out per repo with a `.gutcheck-off` file (honored from
subdirectories) or globally with `GUTCHECK_HOOK=off`.

The plugin also adds:

- `/gutcheck:check` — runs the probe and the lint and walks through repairing what they find.
- Two opt-in context hooks, activated only by a `.gutcheck` file in the session's working
  directory (they spend context tokens): a `session-skill` line injects the check skill at
  startup, a `prompt-cue` line adds a short verification cue to substantive prompts. Details in
  [hooks/README.md](hooks/README.md).
- An opt-in, read-only citation-verifier agent that checks one citation at a time — papers,
  patents, standards sections — against the source.

To use a clone without installing: `claude --plugin-dir <repo>/dist/gutcheck`. The verdicts are
the same on every surface; an agent and a reviewer read the same report.

### Other harnesses

Each of these installs the same shared gate (`gutcheck gate --harness=<name>`) as a template you
register yourself — none is a plugin, so none is installed by default. Install steps, exact
protocol mapping, and honest boundaries live in each harness's own README.

| Harness | Mechanism | Install | Verification level |
| --- | --- | --- | --- |
| Codex CLI | `Stop` hook, `{decision:'block',reason}` — protocol twin of Claude Code's, same `stop_hook_active` loop guard; clean-run and residue voice off (unconfirmed channel) | [integrations/codex/README.md](integrations/codex/README.md) | Protocol adapter, tested against the documented Codex hooks contract; live pilot pending |
| Cursor | `stop` hook, `{followup_message}` re-prompt (Cursor auto-submits it as the next user message) — gated on `status:'completed'`, `loop_count` plus a diff-hash one-shot guard cap the retry; no SessionStart, baseline falls back to `HEAD` | [integrations/cursor/README.md](integrations/cursor/README.md) | Protocol adapter, tested against the documented Cursor hooks contract; live pilot pending |
| Copilot coding agent | `.github/hooks/` `agentStop` (aliased `Stop`), `{decision:'block',reason}` — no loop-guard flag from Copilot itself, so the memo one-shot guard is the only thing preventing a re-block; runs in the agent's cloud VM, CI stays the outer backstop | [integrations/copilot/README.md](integrations/copilot/README.md) | Protocol adapter, tested against the documented contract; live pilot pending |
| Antigravity | `Stop` hook, `{decision:'continue',reason}` — gates only a clean, fully-idle stop (`model_stop` + `fullyIdle`); no loop-guard flag, so the memo one-shot guard is mandatory; template timeout raised to 120s | [integrations/antigravity/README.md](integrations/antigravity/README.md) | Protocol adapter, tested against the documented contract; live pilot pending |
| aider | No hook system — a recipe pointing `--auto-test`/`--test-cmd` at gutcheck's exit code; `--no-auto-commits` recommended so `--since HEAD` scopes to the current edit | [integrations/aider/README.md](integrations/aider/README.md) | Recipe verified against the CLI's exit-code contract; live aider pilot pending |

Opt-outs are shared across every harness above, because they live in the gate core, not any one
adapter: a `.gutcheck-off` file (honored from subdirectories) or `GUTCHECK_HOOK=off` disables the
gate the same way for all of them.

## Run it by hand (CLI)

Node 20 or newer:

```bash
npx gutcheck --since origin/main
```

`npx gutcheck --demo` plants a two-test example and demonstrates a catch in seconds, no project
needed.

```
gutcheck [path] [--since=<ref>]   probe the diff, print the verification report
gutcheck lint [path]              static checks (derivation, fallback, assertion, shape)
gutcheck --explain <file:line>    the evidence for one verdict: mutation applied, before/after
gutcheck [path] --json            machine-readable result (CI, the agent hook)
gutcheck [path] --format=sarif    SARIF 2.1.0 for code-scanning upload
gutcheck [path] --format=github   GitHub inline annotations for PRs
gutcheck [path] --since=<ref> --format=markdown   report table for PR bodies and sticky comments
gutcheck --demo                   planted two-test example, demonstrates a catch in seconds
gutcheck [path] --files=a,b       probe only these test files
gutcheck [path] --runner=<r>      override the detected runner (vitest jest mocha ava pytest node gradle maven)
gutcheck [path] --max-probes=<n>  cap probed functions (bounds latency on a big diff; default 40)
gutcheck [path] --time-budget=<s> wall-clock cap for the probe pass (capped blocks report as unverifiable (probe-cap), never guessed)
```

## How it works

Mutation testing restricted to one mutant per function (a wrong constant return) and one test
rerun per mutant — fast enough to run on every change.

- `--since=<ref>` scopes the probe to functions and tests touched since that ref; without it,
  every eligible test in the project is probed. A ref git can't resolve — an unfetched
  `origin/main`, say — retries against the merge-base with the local upstream branch, `main`,
  `master`, or `HEAD~1` in turn, naming the substitute. When the diff touches no probeable test,
  the CLI falls back to a full-suite scan with a notice; `--no-fallback` disables that, and the
  agent hook and CI templates always pass it.
- Under a probe cap, test files changed in the diff are probed first, so the newest tests are
  verified before the backlog.
- Verdicts come from parsed runner summaries and JUnit XML, never from exit codes.
- Fail-closed throughout: a changed test that already fails is reported separately (it verifies
  nothing until it passes); a test that never ran — skipped, zero-match selection, timeout — is
  did-not-run, never an accusation; a mutant survival triggers a flake re-check — the test is
  rerun with the function restored — before any hollow verdict; an ambiguous test title is
  inconclusive and a dynamic one is skipped,
  always with the reason stated. On JVM projects the mutant is a type-compatible constant, and a
  mutant the type system rejects is never counted. None of these paths can produce a false hollow
  or a false proven.
- Before reporting anything, gutcheck runs a self-check in a scratch directory: it plants one
  fake test and one real test, and refuses to run unless it catches the fake and clears the real
  one.

## The four verdicts

Proven, hollow, and unverifiable carry a replayable receipt; untested is a reference scan that
found nothing to cite.

| Verdict | Meaning | How it is established |
|---|---|---|
| proven | a test fails when this function breaks | the function was gutted, its test was rerun, the test failed |
| hollow | a test covers it but passes when it is destroyed | same probe; the test passed over the gutted function |
| unverifiable | tests reference it, but the probe could not verify any of them — a limit of the probe, not proof the tests are weak | no value-pinning assertion, the function cannot be located from the test's imports, or the referencing test is itself inconclusive; each test's reason is in the JSON, the dominant one in the report |
| untested | no test mentions it | reference scan over the test files in scope |

## Supported languages and runners

| Language | Runners | Notes |
|---|---|---|
| JavaScript / TypeScript | vitest, jest, mocha, ava, node:test | runner auto-detected |
| Python | pytest | ast-based function location |
| Kotlin / Java (Gradle, Maven) + Android (Gradle only) | Gradle + JUnit 4/5, kotlin.test, AssertJ; Maven + JUnit 4/5 (single-module and multi-module reactors) | Android local unit tests via Gradle (`testDebugUnitTest`, incl. Robolectric); Kotlin Multiplatform JVM-target tests (src/jvmTest, and src/commonTest when the module declares a JVM target) |

Gradle reruns pass `--offline` once the project has been built online. A Maven submodule built in
isolation whose reactor siblings aren't installed to the local repo fails to build there and is
read as no results — an under-reach, never a wrong verdict.

Not supported: Kotlin Multiplatform native and JS target test sets (and commonTest in a module
with no JVM target), and instrumented Android tests — androidTest reports `unverifiable — needs a
device/emulator`. Unsupported Gradle source sets are skipped with an explicit reason before any
test run, never guessed at.

## Speed

One baseline run per probed test, one mutant rerun per gutted function, and one extra flake-guard
rerun before anything is called hollow — the cost is dominated by your own test runner's startup,
typically around a second per probe on fast JS runners and a few seconds per probe on warm Gradle
and Android builds. Each individual test run is bounded by a 60-second timeout, configurable with
`GUTCHECK_PROBE_TIMEOUT_MS`; the `--max-probes` and `--time-budget` caps that bound a whole pass
are in the CLI table above. The startup self-check adds a fraction of a second (`--no-self-check`
skips it).

## Receipts

`--explain` prints the evidence behind any single verdict:

```console
$ gutcheck --explain test/cart.test.mjs:9
test/cart.test.mjs:9 'computes the total'
  → HOLLOW. gutcheck replaced computeTotal()'s body with `return 987654321` and reran only this test.
  before: PASS   after gutting computeTotal(): PASS  ← the test can't tell the function is broken.
  Fix: assert the real expected value, not one re-derived from the function under test.
```

## gutcheck lint

Four static checks in under a second on JavaScript/TypeScript test files (Python gets three —
fallback collapse is JS/TS-only): derivation coherence (a comment deriving an expected value
disagrees with the value the assertion pins), fallback collapse (a compare-to-empty assertion
whose actual value passes through `|| []` or `?? {}`), assertion consistency (assertions within
one test that contradict each other), and test-shape guards (length tautologies and time/random
leaks). Each check validates itself against planted fixtures on every run; precision-tuned, so
zero findings is the normal result on a healthy repo. The lint flags badly shaped tests; it does
not find bugs in code and is not a substitute for the probe.

## Scope and limits

- The probe runs the project's own tests, and therefore its code — point it only at repositories
  whose tests you would run anyway.
- A test is probed only if it pins a concrete value and the tested function can be located from
  the test file's imports. Direct calls and constructed instances both resolve — inline
  (`new X().m()` / `X().m()`) or via a variable — across JS/TS, Kotlin/Java, and Python;
  ambiguous or mock-constructed receivers are skipped, never guessed. Tests importing build
  output such as dist/ are typically unverifiable — build output is never mutated.
- Reach is bimodal: strong on value-pinning pure-logic code, much thinner on DSL-heavy,
  mock-heavy, UI, or dependency-injection-heavy code, where few functions can be probed at all —
  there the untested and unverifiable columns carry the coverage information instead of the
  probe.
- The hollow catch is the rare, high-severity case. The everyday output is the denominator:
  which of the functions you just changed have no binding test at all.
- Hooks are bash and run on macOS and Linux. The CLI and the action run anywhere Node 20+ runs.

## Prior art and license

Mutation testing is old and good; PIT, Stryker, and mutmut are full-strength implementations. The
one-mutant-per-function restriction is 'extreme mutation', published as pseudo-tested methods
(Niedermayr et al., 2016) and shipped for the JVM as PIT's Descartes plugin. What Gutcheck adds
is the per-diff verdict report with fail-closed discipline, per-test targeted reruns, replayable
receipts, and the agent-loop and CI integrations. If you need full mutant coverage (boundary and
condition mutants), use the full-strength tools; Gutcheck answers a narrower question fast. MIT
license.
