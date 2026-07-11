# What AI-written tests actually prove: a probe study of 1,654 wild agent diffs

Study completed 2026-07-06. Sampling criteria were registered before harvest; every hollow finding
was audited by hand; every figure below is computed by the scripts in this directory over the
tracked corpus files.

## Question

When an AI coding agent commits code together with tests, what do those tests prove? Two
sub-questions: how often is an agent-written test hollow (green even when the function it targets
is destroyed), and what fraction of agent-changed functions carry any test that bites.

## Method

1. Harvest: GitHub commit search for agent authorship signatures across six agent families (Claude,
   GitHub Copilot, Cursor, Devin, OpenAI Codex, aider), fixed date windows and page budgets,
   round-robin quotas. One mechanical funnel, no human selection: non-fork, size-capped, touches a
   recognizable test file, one commit per repo. 29,796 candidates judged, 1,803 accepted.
2. Drive: each commit cloned at its exact sha, dependencies installed with scripts disabled, then
   probed diff-scoped: every changed, test-referenced function is gutted and only its own tests are
   rerun, under the fail-closed guards the shipped tool uses. 1,654 diffs drove ok (116
   install-failed, 24 probe-error, 8 clone-failed, 1 timeout).
3. Audit: every hollow verdict independently re-derived by hand: re-clone, byte-identical
   reproduction, manual re-application of the mutation, line-by-line reading of the assertion.

## Results

| Measure | Value | 95% CI |
|---|---|---|
| Test blocks scored (gut, rerun own test) | 2,361 | — |
| Hollow blocks (test stays green over the destroyed function) | 23 (0.97%) | 0.65–1.46% |
| Diffs with at least one hollow test | 18/1,654 (1.09%) | 0.69–1.71% |
| Changed functions classified | 13,982 | — |
| untested (no test references them) | 12,325 (88.1%) | 87.6–88.7% |
| unverifiable (referenced, no assertion that can bite) | 1,378 (9.9%) | 9.4–10.4% |
| proven (a test demonstrably fails when they break) | 272 (1.9%) | 1.7–2.2% |
| Probeable diffs (at least one scoreable block) | 162/1,654 (9.8%) | 8.5–11.3% |

What the hollow tests are: about 17 of 23 are echo oracles, where the test compares the function's
output to another invocation of the same function. The rest are derived-emptiness oracles, one
derived type check, and one platform-gated no-op. When an agent test is hollow it is almost always
because the expected value was derived from the code under test instead of stated independently.

The headline is the denominator, not the hollows: on the typical wild agent diff, 88% of changed
functions have no test at all and another 10% have tests whose assertions cannot fail. The untested
fraction is stable across 17 months of commits and across all six families (see
`../loop-pilot/trend.mjs` over this corpus).

Fail-closed volume: 984 blocks were refused because their baseline already failed at the harvested
commit, 201 because the baseline produced no parseable run, 27 for irreducible title ambiguity.

The run was registered with a kill line on one specific claim ("wild hollow base rates alone
justify the probe"); the measured 0.97% fell below it and that claim was retired as the
registration prescribed. The claim the data supports is the one the tool now ships with: on real
agent diffs almost nothing is proven, and a per-diff verification report is informative on
essentially every diff.

Instrument integrity: one full generation of results was discarded and re-driven after a work-dir
bug; generation-one audits found five false-positive hollow verdicts caused by two probe bugs, both
fixed from the wild specimens before the final drive; final reconciliation reproduced 11/11
previously audited true findings, resurrected zero false positives, and audited all 23 final
findings true.

## Limitations

- The confidence intervals treat blocks and functions as independent; they cluster within commits
  and repos, so the stated precision is optimistic. The qualitative findings do not depend on it.
- Post-review survivor bias: mined commits are what survived whatever review the authors did.
- Scored blocks come from the ~10% of diffs with runnable, pinned, unambiguous tests; the hollow
  rate is a rate among scoreable tests.
- The per-function percentages are computed by the committed scripts over the full drive outputs;
  the tracked corpus files carry per-diff summaries (the corpus-level counts recompute from them
  directly).
- Ecosystems: JS/TS and Python; the corpus skews toward small, young, agent-built projects.
- The changed-function denominator predates the class-method enumeration fix, so reach on
  class-method-heavy diffs is undercounted; the reported numbers are unchanged by this.

## Verify it yourself

`corpus/diffs.jsonl` lists all 1,803 sampled commits; `corpus/hollow-findings.jsonl` lists all 23
hollow findings. To reproduce any finding:

```bash
git clone --depth=50 https://github.com/<repo>.git t && cd t
git fetch --depth=50 origin <sha> && git checkout --force <sha>
npm install --ignore-scripts --no-audit
npx gutcheck . --since=<sha>^ --json          # the finding appears in .hollow[]
npx gutcheck --explain <file>:<line>          # the mutation and before/after for that one test
```

Or with no tooling: open the file at the listed line, replace the body of the function it targets
with `return 987654321`, run that one test. It passes.
