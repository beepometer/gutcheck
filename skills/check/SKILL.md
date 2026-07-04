---
name: check
description: Use when proving a repo's tests actually catch their code with Gutcheck's mutation probe (`prove`) and deterministic checker, acting on a hollow oracle, an uncited expected value, or a derivation/assertion mismatch it flags, and before any "it passes" claim.
---

# Gutcheck — prove the tests, then repair what's hollow

Gutcheck ships **inside this plugin** — no clone, no install (Node 20+). Two layers run over the
repo: the **mutation probe** (`prove`) breaks each tested function and reports which tests don't notice —
execution-proven, not guessed; and a **deterministic checker** (`check`) that statically lints test soundness.
Report exactly what each printed, then route every finding to its repair. They *locate* a defect; they do not
fix it.

**Core principle:** report the tool's own exit code and lines verbatim — never paraphrase a clean result over a
real finding — then repair each at its source, never by making the number look right.

## 1 — Prove the tests catch their code (the mutation score)

`prove` guts each tested function with a guaranteed-wrong return and runs only that test. A test that still
passes is **hollow** — it does not check the function. This fires where a static read is silent (an expected
value that re-runs the code under test, an assertion dialect a parser can't see), and the verdict is
execution-proven, not a guess.

- **PROVE** — the bundled front door. On Claude Code: `"${CLAUDE_PLUGIN_ROOT}/mutation/prove.mjs"`; else this bundle's own `mutation/prove.mjs` (its absolute path in the installed dir).
- **REPO** — the project under test. On Claude Code: `"${CLAUDE_PROJECT_DIR}"`; else the repo root you were invoked in.

```bash
node "<PROVE>" "<REPO>"                 # a mutation score + the hollow tests, across the repo
node "<PROVE>" "<REPO>" --since=<ref>   # scope to tests touched by changes since <ref> — fast; the after-a-change case
```

It prints `caught/scored (pct%)` and lists each hollow test as `file:line "name" — survives gutting fn()`. Every
hollow line is execution-proven: rebuild its oracle (§4), then re-run `prove` to confirm it now bites. A function
whose result feeds no value-pinning assertion is left unprobed — that is the static weak-oracle advisory's job
(§2), not a hollow verdict. To drill into one assertion, gut a single function directly:
`node "${CLAUDE_PLUGIN_ROOT}/mutation/probe.mjs" <testFile> <srcFile> <functionName>` (`HOLLOW` vs `SOUND`).

## 2 — Run the static checker (the source-discipline floor)

- **CHECKER** — the bundled CLI. On Claude Code: `"${CLAUDE_PLUGIN_ROOT}/checker/cli.mjs"`. On other bundles: this bundle's own `checker/cli.mjs` (its absolute path in the installed dir).
- **CONFIG** — the project's own `gutcheck.config.json` at the REPO root if present; else the bundled floor (`"${CLAUDE_PLUGIN_ROOT}/gutcheck.config.json"`).
- **TESTDIR** — the first of `test/`, `tests/`, `__tests__/`, `spec/` that exists under REPO. If none, drop `--src-test`.

```bash
node "<CHECKER>" --config "<CONFIG>" --repo-root "<REPO>" --src-test "<TESTDIR>"
```

The floor is five deterministic source-discipline checks: hollow/leaky **test shapes**, **uncited expected
floats**, **inline-derivation coherence**, **same-call assertion consistency**, and external **value-citations
missing a URL**. Drop any flag whose input did not resolve, then read the exit code AND the output:

- `META-GUARD FAILED` → **surface it loudly and stop.** The checker refused to run because one of its own guards failed its self-test. Do NOT present any result as clean — report the failing guard verbatim.
- Exit 0 / `OK` → report `OK — N checks passed` (N from the output).
- Exit 1 with offenders → report each as `<check>: <file>:<line>`, grouped by check. Don't soften or summarize away a real offender.

## 3 — Repair each finding at its source

| Flag | What it means | Repair |
|---|---|---|
| hollow test (from `prove`) | the test still passes with its function gutted — it asserts nothing real | rebuild a real oracle (§4), then re-prove |
| shadow oracle | the expected value re-derives the code under test, so drift can't fail it | rebuild a real oracle (§4); `prove` (§1) confirms the rebuild bites |
| weak / assertion-free | a SUT call with no value-pinning assertion (so `prove` cannot even probe it) | add an assertion that pins the contract |
| uncited magic literal | an expected number with no source | source it (§5), label it engineering-judgment, or drop it |
| derivation / consistency | an inline derivation or a sibling assertion disagrees with the asserted value | one of them is wrong — fix the wrong value, never widen a tolerance to hide it |
| external citation (no URL) | a standard/spec citation backing a value carries no source URL | add the URL inline, or verify the citation (§5) |

## 4 — Build a real oracle (never from the code's own output)

```
THE IRON LAW: NO ORACLE FROM THE CODE'S OWN OUTPUT
```

An expected value copied from what the code currently returns is a photograph of today's behaviour, bug and
all. Derive it independently: from a spec / standard / closed-form identity, or a *different* reimplementation,
or a trusted reference tool (assert within a real non-zero residual — an exact `0.0` means one value was stored
twice). When no closed form exists, assert a property (sign / bounds / monotonicity) **plus a non-vacuity floor**
so an all-`null` green can't pass; pin a recorded golden only as a documented refactor-guard,
never as a correctness claim.

## 5 — Source a constant / verify a citation

A computed value or cited number must trace to a source, not a tweak that makes it look right.

- **Concrete** source (a local `file:line`, a commit `sha`, a datasheet on disk) — `grep` / `git show` / read it, then quote the line inline.
- **Abstract** source (a standards section, a patent, a paper) — this is where agents fabricate. Hand it to the opt-in **`citation-verifier`** agent: it fetches the source, confirms it exists, says what is claimed, applies, and is attributed right, and returns a verified-quote-inline form. A paywalled source it can't reach is labelled `unverified-from-public-source`, not asserted.
- A bare magic number with neither a source nor a labelled rationale is a confabulation risk — refuse it.

A provided "validated against X" / "cross-checked" attestation is a claim *about* a check, not the check.
Re-run it yourself, at the precision the claim asserts, before relying on what it defends.

## 6 — Verify before claiming

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

Before claiming work passes: run the verification command (`npm test`) in THIS message, read the full
output — exit code, failure count, the actual numbers — and only then make the claim, *with* the evidence. A
regression test is proven red-green: write → run (pass) → revert the fix → run (MUST fail) → restore → run
(pass). "Should pass", a previous run, or an agent's "DONE" is not evidence — read the diff and re-run.

## Never

Claim a clean run from a `META-GUARD FAILED` output · present a `prove` HOLLOW line as a clean test · invent a
config or path not on disk · pin an expected value from the code's own output · widen a tolerance to make a test
pass · assert an abstract citation without a fetched quote · claim "it passes" without a fresh run in hand.
