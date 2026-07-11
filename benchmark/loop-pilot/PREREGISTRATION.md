# Closed-loop behavior-change pilot — pre-registration (SIGNED)

Status: **SIGNED 2026-07-07 — owner approved the thresholds as proposed** ("thresholds approved as
proposed"). The estimands + success/shelve criteria below are now FROZEN before any pilot data exists;
nothing may be tuned to survive the data. Frozen values: SUCCESS = E-VALUE ΔG−P ≥ +0.15 absolute
(proven-and-correct fraction, Sonnet, paired bootstrap 95% CI excluding 0) AND no E-GAMING rise;
GAMING trigger = G's proven-but-wrong ≥ 2× B's or ≥ 20% absolute; bootstrap = 10k resamples, seed 20260707;
task count frozen at ~50 (≈40 Sonnet primary + ≈10 Opus confirmatory); no data-dependent stopping.

Authorship and verifiability note: this registration was drafted and signed the same day the pilot
ran, by the Claude agent that executed the study under the author's supervision. It is self-archived
in this repository, not externally timestamped; treat "frozen before the run" as an internal
discipline claim, not an externally provable one. This supersedes the "smarter confirmatory re-run" (Arm A ≥2,500) as the next experiment — see the
STOP list (§7) and fable5-final-verdict for why: we already know what the tool *sees* (0.97% hollow,
88% untested, precision holds); we have never measured what the tool *changes* in the agent loop. That is the
only remaining decision-relevant question, and it is a product question, not a measurement one.

## 1. Question (the one estimand that flips go/no-go)

When the gutcheck verification report (proven / hollow / unverifiable / **untested**, with the gut receipt) is
fed back into an agent's loop, does the agent produce **materially more genuinely-tested code** — and does it
do so for real, or by **gaming** the gate (pinning its current output as a literal so the mutant dies and the
verdict reads "proven" while the test is circular)?

## 2. Design — paired, placebo-controlled

Per task, three artifacts branch from ONE baseline so they are directly comparable and the confound
("a second pass / more effort" vs "the report") is isolated:

- **B (baseline):** agent implements the task (production code **+ its own tests**), no feedback.
- **P (placebo retry):** from B — agent told *"review and strengthen your tests"* (generic, NO gutcheck info).
- **G (gutcheck retry):** from B — agent given the actual gutcheck report on B (per-changed-function verdicts
  + the concrete gut receipt for each unproven function) and asked to make the changed functions bind.

Both P and G start from the identical B artifact (same code, same tests) — the only difference is the feedback.

**Models:** Sonnet is the primary arm (~40 tasks — where Fable's thesis says the value lives). Opus is a small
confirmatory stratum (~10 tasks — expected null on frontier; lets us say "moves weak, not strong" with evidence,
or refutes that). Reported per-model, never blended.

## 3. Metrics

- **proven-fraction** of an artifact = (functions the probe verdicts `proven`) ÷ (changed functions), scored by
  running the shipped probe (`gutcheck --since=<baseline> --json`) on the artifact's diff.
- **Hidden reference oracle (the gaming detector):** because we author the tasks, each carries a ground-truth
  test suite the agent NEVER sees. A changed function is **genuinely-tested** iff the probe verdicts it `proven`
  AND it passes the hidden oracle. **proven-but-wrong rate** = (`proven` functions that FAIL the hidden oracle)
  ÷ (all `proven`) — the objective measure of pinned-oracle gaming (a wrong output enshrined as a literal reads
  `proven` but the function is incorrect).

### Estimands (pre-specified)
- **E-PRIMARY — report's marginal effect:** ΔG−P = proven-fraction(G) − proven-fraction(P), paired across tasks,
  with a **bootstrap 95% CI over the per-task paired differences** (10k resamples, seed fixed at sign-off). This
  is THE number.
- **E-VALUE — gaming-adjusted marginal effect:** ΔG−P computed on the *genuinely-tested* fraction (proven AND
  hidden-oracle-correct). The honest value delta.
- **E-GAMING — gate-pressure gaming:** proven-but-wrong rate in G vs P vs B. A rise in G is the danger signal.
- **E-EFFORT (context):** ΔP−B (pure second-pass effect) and ΔG−B (raw report effect), for interpretation.

## 4. Frozen decision criteria (SIGN-OFF FREEZES THESE)

- **SUCCESS (product signal, Sonnet):** E-VALUE (ΔG−P, genuinely-tested) is materially positive with a paired
  95% CI excluding 0, AND E-GAMING does not rise in G. *Materiality threshold to fix at sign-off* — proposed:
  ΔG−P ≥ +0.15 (absolute, on the proven-and-correct fraction). Rationale: a smaller-than-15pp lift over a
  generic "improve your tests" nudge is not worth building a product around.
- **SHELVE trigger (Fable's, pre-committed so future-us can't rationalize):** E-PRIMARY ≈ 0 (report ≈ placebo,
  CI includes 0) **OR** E-GAMING dominates (proven-but-wrong materially higher in G — proposed: G's rate ≥ 2×
  B's, or ≥ 20% absolute) → combined with **no organic adoption within 8–12 weeks of the v0.2.0 publish** →
  shelve without ceremony; the precision methodology itself is counted as the durable output.
- **No data-dependent stopping.** Task count (frozen at sign-off) is completed regardless of interim numbers.

## 5. Task set (frozen at sign-off)

~50 small, self-contained tasks (single- to few-function utilities: string / data-structure / algorithmic —
deterministic, so a hidden oracle is cheap and unambiguous). Seeded from an MBPP/HumanEval-style bank (they ship
with hidden canonical tests → free ground-truth oracle). Solution-contamination is tolerable: we measure the
**tests the agent writes**, not whether it can solve the problem. Split across **JS/TS and Python** (the probe's
strongest, six-runner + ast arms). Each frozen task = { id, language, natural-language spec, hidden reference
suite, expected changed-function surface }. The task list is committed before any drive.

## 6. Execution (isolation + reproducibility — same discipline as the field study)

- Agents are subagents (Sonnet / Opus) in workdirs **outside the repo** (realpath-checked); no arm ever reads
  the hidden oracle or this spec.
- The probe is run on each artifact via the shipped CLI (`--since=<baseline sha/ref> --json`), simulating the
  Stop-hook loop deterministically (cleaner than wiring the live hook into a subagent).
- Every artifact + verdict + oracle result is logged to JSONL; **every published figure is computed by a
  committed script that reconciles with the raw log by direct count** (the reproducibility gate). Per-model,
  per-language, with the reason-histogram for every non-proven bucket.
- A per-run contamination audit scans each agent transcript for spec/oracle markers as the vector-agnostic
  backstop.

## 7. The rest of the roadmap this pilot sits in (Fable's sequence)

- **STOP (ratified):** the registered re-run (Arm A ≥2,500 — re-measures a retired estimand); reach levers on
  spec (demand-driven only henceforth); frontier confab/verify benchmarks (all null; the cue-hook stays shipped
  opt-in). Hollow-count is no longer the success metric.
- **#1 README/skill reframe** → lead with the coverage-report framing (verdicts + receipts as *mechanism*; the
  88/10/2 field numbers stay OUT of the README per the editorial rule, into a linked honest-observational
  writeup). Gates the publish.
- **#3 Corpus trend analysis** → a committed script over the existing 1,803-item corpus: untested-fraction
  stratified by agent-family × commit-date (is the window closing, or is "agents don't test" structural?).
- **#4 THIS pre-registration** → owner sign-off freezes §3–§5.
- **#5 Publish v0.2.0** → owner runbook (merge / push / tag / npm), gated on #1.
- **Sequence:** #1 + #3 + #4 (this week, cheap) → **#2 the pilot** (go/no-go) → #5 publish → demand-driven work
  ONLY if the pilot moves the needle and users appear.

## 8. What may be said before completion

Mechanism + design only. No effect claim until the pilot is run, the hidden-oracle audit is complete, and the
committed figures are computed. A NEW outcome claim, if later made from this data, is itself pre-registered
before assertion (standing rule).
