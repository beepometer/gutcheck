# Closed-loop behavior-change pilot — results (run 2026-07-07, registration SIGNED before any data)

50 tasks (25 JS + 25 Python, frozen from MBPP-sanitized with hidden reference oracles), three artifacts
per task branching from one baseline: **B** (build), **P** (placebo retry: "review and strengthen your
tests"), **G** (gutcheck retry: the real report). Agents = sandboxed headless `claude -p`
(writes confined to the pilot workbase; repo + $HOME denied). Sonnet-5 primary (n=40), Opus-4.8
confirmatory (n=10). Zero driver errors. Total agent cost ≈ $80. Every figure below is computed by
`aggregate.mjs` (paired bootstrap, 10k, seed 20260707) and reconciles with the raw rows by direct count.

## Registered figures

| | Sonnet (n=40) | Opus (n=10) |
|---|---|---|
| arm means B / P / G (proven-fraction) | 0.850 / 0.675 / 0.950 | 0.900 / 0.400 / 0.900 |
| **E-PRIMARY** ΔG−P | **+0.275 [0.150, 0.425]** | +0.500 [0.200, 0.800] |
| **E-VALUE** ΔG−P (entry proven∧correct) | **+0.250 [0.125, 0.400]** | +0.500 [0.200, 0.800] |
| E-EFFORT ΔP−B | **−0.175 [−0.300, −0.050]** | **−0.500 [−0.800, −0.200]** |
| E-EFFORT ΔG−B | **+0.100 [0.025, 0.200]** | **0.000 [0.000, 0.000]** |
| E-GAMING (proven-but-wrong) B / P / G | 2.9% / 3.7% / 5.3% | 0 / 0 / 0 |

## Frozen-criteria reading

- **SUCCESS: MET (Sonnet).** E-VALUE ΔG−P = +0.250, ≥ +0.15 with the 95% CI excluding 0; the gaming
  trigger did not fire (G 5.3% vs B 2.9% → 1.8× < 2×, and ≪ 20% absolute). Shelve trigger: NOT fired.
- **The honest decomposition (this is the finding, not a caveat):** the G−P delta is composed of a
  modest genuine lift and a large *prevented degradation*. On Sonnet, G lifts +0.100 [0.025, 0.200]
  over baseline while the placebo DROPS verification −0.175 below baseline; on Opus, G lifts exactly
  0.000 (the predicted frontier null) while the placebo drops −0.500. **A generic "review and
  strengthen your tests" instruction actively degrades verified coverage** — agents rewrite bindable
  tests into fancier shapes (table-driven, dynamic titles, helper indirection) that can no longer be
  mechanically verified. The gutcheck report channels the same second-pass effort into shapes that
  stay proven. So the product claim this pilot supports is precise: **the report protects and modestly
  lifts verified coverage where a generic quality nudge erodes it.**
- Frame note (registered metric, honestly stated): proven-fraction measures *verifiability by the
  probe*, so part of P's drop is legibility loss rather than necessarily quality loss. E-VALUE (which
  requires hidden-oracle correctness as well) moves the same way, so the erosion is not merely
  cosmetic — but the claim above is worded in terms of *verified* coverage, which is what the tool
  governs.

## Gaming audit (every proven-but-wrong instance hand-audited)

4 instances, all one mechanism, and **it appears already in arm B (no gate pressure)**: the agent
misreads an ambiguous spec, implements the wrong semantics, then **pins its own wrong outputs as test
literals** — the test genuinely binds the implementation (gutcheck: proven, correctly) while pinning
the wrong value (oracle: wrong). Specimens: py-83 ("add ASCII values" read as ord() sums; MBPP's
canonical is alphabet positions — agent pinned `get_Char("abc") == "i"` where truth is `"f"`);
py-87 (merge-three-dicts, last-wins vs MBPP's first-wins ChainMap semantics). G added exactly one such
instance over B — under the frozen threshold; the vector is a natural agent failure mode rather than
gate-induced gaming. **This is the concrete demonstration that "proven" ≠ "correct", and why the
report's wording must never claim correctness — only that the tests bind.**

## Context and external validity

- **Ceiling:** B saturated at 1.00 on 34/40 Sonnet tasks — MBPP toys are easy mode. The wild baseline
  is the opposite extreme (field study: 88.2% of changed functions untested, proven 1.9%; trend
  analysis over 17 months and 6 agent families: flat, structural). Headroom for the report in the wild
  is therefore far larger than on these tasks — but wild lift is unmeasured; do not extrapolate the
  +0.10 number.
- The placebo arm receives no definition of the metric while the treatment arm effectively does (the
  report names what counts as verified); part of the P-arm drop is therefore report-vocabulary
  advantage, not report-content advantage. A rubric-only placebo arm is the right next control.
- The tasks are MBPP-derived and in every frontier model's training data; the hidden oracle
  partially tests recall rather than independent derivation, and 34/40 baseline saturation limits
  headroom. Do not extrapolate magnitudes beyond this task class.
- E-VALUE is measured on the entry function only (the oracle's granularity), a narrower denominator
  than E-PRIMARY; and the SUCCESS rule is met while the CI lower bound (0.125) sits below the +0.15
  materiality bar, so the data are also consistent with a sub-material effect.
- The Opus stratum is small (n=10) by design — a confirmatory direction check, not a powered
  estimate; read its rows as raw counts, not intervals.
- Prompts, task list, split, seed, and thresholds were frozen before any row existed; no
  data-dependent stopping occurred; interim numbers were surfaced but never acted on.
