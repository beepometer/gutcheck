# CLI reference

Node 20 or newer. No install needed:

```bash
npx gutcheck --since origin/main
```

## Commands and flags

```
gutcheck [path] [--since=<ref>]   probe the diff, print the verification report
gutcheck lint [path]              static checks (derivation, fallback, assertion, shape)
gutcheck --explain <file:line>    the evidence for one verdict: mutation applied, before/after
gutcheck [path] --json            machine-readable result (CI, the agent hook)
gutcheck [path] --format=sarif    SARIF 2.1.0 for code-scanning upload
gutcheck [path] --format=github   GitHub inline annotations for PRs
gutcheck [path] --since=<ref> --format=markdown   report table for PR bodies and sticky comments
gutcheck --demo                   planted two-test example, demonstrates a catch in seconds, no project needed
gutcheck [path] --files=a,b       probe only these test files
gutcheck [path] --runner=<r>      override the detected runner (vitest jest mocha ava pytest node gradle maven)
gutcheck [path] --max-probes=<n>  cap probed functions (bounds latency on a big diff; default 40)
gutcheck [path] --no-fallback     never widen an empty --since scope to a full-suite scan (the agent hook, CI)
gutcheck --no-self-check          skip the startup self-check (probe mode only; not recommended)
gutcheck [path] --time-budget=<s> wall-clock cap for the whole probe pass — analysis and probing; blocks past the budget report as unverifiable (probe-cap), never guessed
gutcheck [path] --deep            costlier evidence, same coverage — roughly double the mutant runs on the same probeable tests.
                                  By default only a candidate hollow is confirmed against the opposite-signed sentinel (hollow =
                                  green under BOTH directions; red under exactly one = one-sided, a verdict that never blocks).
                                  --deep extends both-sentinel evidence to the proven side, demoting one-direction-only proofs to
                                  one-sided, and adds the identity-stub advisory (a test the gut breaks but a passthrough does not
                                  covered only a fixed point; suppressed for functions with a production identity branch).
```

`--json` field units—four counters share the payload and denominate different things: `capped` counts
test **blocks** over the whole scanned scope that hit `--max-probes`/`--time-budget`; `changedFileCount`
counts every **file** git reports changed (any type); `changeSummary.files` counts only changed non-test
**source files**; `changeSummary.notProbed` counts changed **functions** the run never probed.

## Exit codes

`0` on a clean run—no hollow test proven, including a run the environment aborted (a broken build
or wrong runner shows up as a stated reason in the report, not a failure code). `1` when at least
one hollow test is proven. `2` on a scope or usage error (bad path, unknown flag, an unresolved
`--since` with nothing to fall back to).

`gutcheck lint` shares the same 0/1/2 shape: clean, findings, error.

## Receipts (`--explain`)

`--explain` prints the evidence behind any single verdict:

```console
$ gutcheck --explain test/cart.test.mjs:9
test/cart.test.mjs:9 'computes the total'
  → HOLLOW. gutcheck replaced computeTotal() (src/cart.mjs)'s body with `return 987654321` and reran only this test.
  before: PASS   after gutting computeTotal() (src/cart.mjs): PASS  ← the test can't tell the function is broken.
  Fix: assert the real expected value, not one re-derived from the function under test.
```

## `gutcheck lint`

Four static checks in under a second on JavaScript/TypeScript test files (Python gets three —
fallback collapse is JS/TS-only):

- **derivation coherence**—a comment deriving an expected value disagrees with the value the
  assertion pins.
- **fallback collapse**—a compare-to-empty assertion whose actual value passes through `|| []`
  or `?? {}`.
- **assertion consistency**—assertions within one test that contradict each other.
- **test-shape guards**—length tautologies and time/random leaks.

Each check validates itself against planted fixtures on every run; precision-tuned, so zero
findings is the normal result on a healthy repo. The lint flags badly shaped tests; it does not
find bugs in code and is not a substitute for the probe.

See also: [how it works](how-it-works.md), [scope and limits](limits.md).
