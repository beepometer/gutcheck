# Reach re-measure + zero-FP audit — the "make-first-run-land" milestone

Local dev artifact (benchmark/ is gitignored). Baseline = unpatched probe (Task 1); After =
patched probe after Tasks 2–7. Corpus = `benchmark/reach/repos.json` (7 pinned real repos).
`after.json` / `baseline.json` are local, uncommitted; only this file is committed.

## Headline

| metric | baseline | after | delta |
|---|---|---|---|
| **scored (execution-proven functions)** | 77 | **133** | **+56 (+73%)** |
| probedFraction (scored / (scored+skipped)) | 0.190 | 0.183 | −0.007 |
| skipped (parsed but not value-pinning) | 328 | 592 | +264 |
| hollow (across the whole corpus) | 0 | **0** | 0 |

## The honest reach read — two metrics, they diverge

**Absolute reach ROSE: 77 → 133 execution-proven functions (+73%).** This is the real win —
the number of tests gutcheck actually broke-and-reran to prove they bite. Sources: the widened
value-pin matcher gate lifted `ms` (jest) 77→103 (+26), and the parser/`node --test` path lifted
`classnames` 0→30.

**The scored/total RATIO SLIPPED: 0.190 → 0.183.** This is NOT a precision regression. Task 5's
widened parser now SURFACES many test blocks that were previously invisible (`function()`
callbacks, `.only`/`.skip`/`.concurrent`), the large majority of which are correctly SKIPPED as
non-value-pinning. That inflates the denominator (skipped 328→592) faster than scored grew, so
the ratio dips. `yargs-parser` alone went 50→369 skipped — 319 newly-parsed blocks, all correctly
skipped, none of them scoreable (see runner-detection below).

**So the literal "probed fraction rises" acceptance criterion is met by ABSOLUTE scored
(77→133), NOT by the ratio (0.190→0.183).** Stated plainly, no spin.

## Per-repo (scored / skipped, before → after)

| repo | runner | scored b→a | skipped b→a | hollow | note |
|---|---|---|---|---|---|
| ms | jest | 77 → **103** | 90 → 64 | 0 | matcher-gate win (+26) |
| classnames | node | 0 → **30** | 63 → 33 | 0 | parser/node-test win (+30) |
| slugify | node | 0 → 0 | 44 → 45 | 0 | **runner-detection gap** (mocha/tape → node fallback) |
| mitt | node | 0 → 0 | 19 → 19 | 0 | **runner-detection gap** |
| yargs-parser | node | 0 → 0 | 50 → **369** | 0 | **runner-detection gap**; parser surfaced +319 blocks (all skipped) |
| python-slugify | pytest | 0 → 0 | 0 → 0 | 0 | no probeable pinned blocks |
| humanize | pytest | 0 → 0 | 62 → 62 | 0 | pytest; 0 value-pinned SUT calls resolved |

## FP audit (THE HARD GATE) — corpus reported 0 HOLLOW → zero false positives

The corpus produced **hollow = 0 in every one of the 7 repos**, so there was nothing to hand-verify:
zero HOLLOW means zero FALSE HOLLOW. (It also means zero TRUE hollow — mature, curated OSS has no
hollow tests, exactly as in the baseline. Consistent with the whole-project experience that hollow
tests are rare in reviewed code.) **The hard gate — zero false HOLLOW across the corpus — PASSES.**

## Runner-detection gap — the #1 reach fast-follow (out of scope for this milestone)

`slugify`, `mitt`, `yargs-parser` stay at scored=0 because `detectRunner` only recognizes
vitest/jest/pytest and falls back to `node` for everything else. Those three ship mocha/ava/tape
suites that `node --test` won't execute, so their (now correctly-parsed) blocks can't be probed
regardless of the matcher/parser fixes. This is a detection gap, not a precision failure, and is
the clearest next lever for reach. It bounds how much the corpus fraction can move this milestone.

## Home-repo demonstration — the join() false positives are FIXED

`node mutation/gutcheck.mjs .` from the repo root:

- **Before this milestone:** 8 hollow reported, **4 of them FALSE POSITIVES** (`survives gutting
  join()` — incidental `node:path` `join` mis-bound to a same-named local helper).
- **After:** 2 hollow reported; **0 `survives gutting join()` lines** — the 4 join() false
  positives are GONE (import-aware SUT binding + outermost-call attribution, Tasks 2/3). Confirmed.

Surviving hollow list (after):

```
2 test(s) pass even when their function is gutted — they don't actually test it:
  ✗ test/probe.test.mjs:96      "passthroughBreak: body becomes `return <firstParam>`; …"  — survives gutting passthroughBreak()
  ✗ test/standalone.test.mjs:59 "a clean project yields zero offenders (…independent oracle)" — survives gutting runChecker()
```

Both were hand-audited (see the FP note below). One is genuine; one is itself a false positive
from a pre-existing, out-of-milestone shell-quoting bug.

## CONCERN — one surviving home-repo hollow is a FALSE POSITIVE (pre-existing, needs a targeted product fix)

- `test/standalone.test.mjs:59` (**runChecker**) — **GENUINE hollow.** Gutting `runChecker` to
  `return 987654321` makes `res.offenders` `undefined`; the test's `(res.offenders || [])` defaults
  to `[]`, so `assert.deepEqual([], [])` passes trivially. A real hollow test.

- `test/probe.test.mjs:96` (**passthroughBreak**) — **FALSE POSITIVE.** Root cause is a
  shell-quoting bug in `mutation/prove.mjs` `runOne`/`testCmdFor`, NOT a resolver/pin gap and NOT
  related to the join work. `testCmdFor` builds a shell command string and quotes the test name with
  `JSON.stringify(...)`, which is not shell-safe. This test's NAME contains a backtick
  (`` `return <firstParam>` ``). Under `/bin/sh -c`, the backticks are command substitution, so the
  `--test-name-pattern` value is corrupted and matches **0** subtests — yet Node's runner still
  prints the file-level wrapper `# pass 1 # fail 0`, which `parseRun` reads as a green pass for BOTH
  the unmutated baseline AND the gutted mutant → misclassified HOLLOW.

  Ground-truth repro (correctly single-quoted isolation command, so the shell does not corrupt it):
  gutting `passthroughBreak` and running its real test makes it **FAIL** (`# pass 0 # fail 1`) — i.e.
  the test is actually **SOUND**. Confirmed by hand.

  This is a pre-existing bug (in the base `runOne`, predating Tasks 2–8) that this milestone neither
  introduced nor was scoped to fix, surfaced only because a home-repo test name contains a backtick.
  It requires a product-code fix (shell-safe quoting — single-quote the arg or use `execFileSync`
  with an argv array). Per the task constraint, product code was NOT changed here; flagged for a
  targeted fix. It did not affect the corpus (no corpus test name contains a backtick), so the
  corpus zero-FP hard gate is unaffected.

## Final gate

- `npm test` — **207 pass / 0 fail / 2 skipped** (the 2 skips are the pre-existing optional
  fidelity checks that need an absent source repo).
- `npm run build:plugin` — rebuilt `dist/gutcheck`, `dist/gutcheck-agents`, `dist/gutcheck-gemini`;
  **no drift** (git working tree clean after build).
- `bash scripts/gate.sh` — **PASS (coherence check)**.

No product code (`mutation/`, `checker/`, `dist/`) was modified in this measurement task.

---

## mocha/ava runner support

Re-measure after Tasks 2–5 added mocha + ava to the probe (`detectRunner` / `testCmdFor` /
`parseRun`). Corpus = the same 7 pinned repos. New artifact: `benchmark/reach/after-runners.json`.
Compared against `baseline.json` (unpatched: scored 77) and `after.json` (prior milestone: scored 133).

### Headline — detection landed, corpus reach is FLAT

| metric | after.json (prior) | after-runners.json | delta |
|---|---|---|---|
| scored | 133 | **133** | **0** |
| probedFraction | 0.183 | 0.183 | 0 |
| skipped | 592 | 592 | 0 |
| hollow | 0 | **0** | 0 |

The summary is byte-for-byte identical to the prior milestone. **No net reach gain on this corpus.**
Runner *detection* now works — `slugify`, `mitt`, `yargs-parser` are correctly identified as `mocha`
instead of falling back to `node` — but all three still score **0**. Detection was necessary but **not
sufficient**. Reported straight, no spin: the mocha/ava milestone delivered correct detection + a
validated command/parse path, and it did **not** move the corpus reach number.

### Per-repo before → after (runner + scored)

| repo | runner base → now | scored base → now | bucket now | note |
|---|---|---|---|---|
| ms | jest → jest | 103 → 103 | scored | unchanged (jest, not a runner-milestone target) |
| classnames | node → node | 30 → 30 | scored | unchanged (`node --test`) |
| slugify | **node → mocha** | 0 → **0** | 45 skipped | detected mocha; falls out at the value-pin gate (see root cause) |
| mitt | **node → mocha** | 0 → **0** | 19 skipped | detected mocha; falls out at SUT-eligibility (see root cause) |
| yargs-parser | **node → mocha** | 0 → **0** | 369 skipped | detected mocha; falls out at SUT-resolution / pin-vocab (see root cause) |
| python-slugify | pytest → pytest | 0 → 0 | 0 blocks | unchanged (out of scope) |
| humanize | pytest → pytest | 0 → 0 | 62 skipped | unchanged (out of scope) |

None of the three previously-stuck JS repos uses **tape** — all three declare **mocha** in
`devDependencies` (`slugify` mocha ^7, `mitt` mocha ^8, `yargs-parser` mocha ^11). So "tape stays
deferred" is not what happened here: the milestone's target runner (mocha) *was* the right runner, it
detected correctly, and the repos still didn't score. Tape is not implicated in this corpus.

### Root cause — the blocks are SKIPPED, not INCONCLUSIVE (so it is NOT a runner/config failure)

The decisive signal from `after-runners.json`: for all three repos `probes = 0`,
`inconclusive = 0`, `outOfScope = 0` — every block is in **skipped**. Skipped happens **before any
test is executed**: the block never reached the mutation/re-run stage. Had the mocha command failed
(bad config, TS not compiled, `--reporter tap` not applying) the blocks would be **inconclusive**
(baseline test not green), not skipped. They are skipped, so the mocha command path was never even
exercised for these blocks. The blocker is the **value-pin / SUT-eligibility gate**, one stage *after*
detection — it is assertion-vocabulary- and SUT-shape-bound, not runner-bound. Each repo fails it for
a different, repo-specific reason (all hand-verified with the exported `pinnedFragments` / `importMap`
gate functions against the real cloned test files):

- **slugify — aliased assertion library.** Tests do `var t = require('assert')` then
  `t.equal(slugify('foo bar baz'), 'foo-bar-baz')`. The pin gate recognizes literal `assert` /
  `assert.equal` / `expect(...)` / chai `.to.equal`, but **not an aliased-assert local** (`t.equal`).
  `pinnedFragments(slugify test file)` = **0** → 0 eligible → all 45 blocks skipped
  ("no value-pinning assertion"). Nothing to do with mocha.

- **mitt — value-pins exist but pin the wrong callee.** Chai `expect(...).to.deep.equal([...])`
  assertions ARE present (`pinnedFragments` = 19), but they pin **emitter-method results**
  (`events.get('foo')`, `events.has('foo')`, `inst.on(...)`), not a call to the imported SUT factory
  `mitt(...)` (verified: no pinned fragment calls `mitt(`). The probe's model — gut a *named top-level
  SUT function* and re-run — doesn't bind mitt's closure/factory-method API, so no eligible fn → all 19
  skipped. A structural limitation of the named-SUT model, correctly a skip (not a false HOLLOW).

- **yargs-parser — SUT imported from build output + chai `should` BDD chains.** SUT is
  `import parser from '../build/lib/index.js'` and `import { camelCase, … } from '../build/lib/…'` —
  the **build output**, which is in `SKIP_DIRS` (`build/`) *and* was never generated (`npm i` doesn't
  run the TS build), so the SUT can't resolve to a walkable source file. On top of that the big suite
  uses chai `should`-style chains (`parse.should.have.property('_').and.deep.equal([...])`) that
  `pinnedFragments` (which parses `expect(...)` / `assert(...)`, not `x.should.<chain>`) doesn't
  capture; and `string-utils.mjs` uses bare destructured `strictEqual(...)` (`pinnedFragments` = 0,
  same alias/destructure gap as slugify). Net: 0 eligible → all 369 blocks skipped.

### FP audit (THE HARD GATE) — zero false HOLLOW

Corpus-wide `hollow = 0` in every one of the 7 repos (`after-runners.json`), so there was nothing to
`--explain`: zero HOLLOW ⇒ zero FALSE HOLLOW. The hard gate PASSES. (Consistent with every prior
corpus run — mature OSS carries no hollow tests.)

### Honest read + the next lever

Detection delivered and is validated (Task 2 real-TAP fixtures for parseRun, Task 4 runner-completeness
meta-test guaranteeing every `RUNNERS` entry has a command + parse branch, Task 5 gated mocha/ava e2e
that both caught a planted hollow and produced no false HOLLOW). But **corpus reach is flat (0 gain)**
because these three repos fall out one gate later, at assertion-eligibility, for reasons the mocha
milestone was never scoped to fix. Converting them to scored reach is a *separate eligibility/resolver*
effort, not runner work:
1. Recognize **aliased / destructured assert** — track `importMap` bindings of `assert` and its named
   members so a local `t.equal(...)` or bare `strictEqual(...)` is treated as value-pinning (fixes
   slugify + `string-utils.mjs`).
2. Parse chai **`should` BDD chains** (`x.should.(deep.)equal(...)`) in `pinnedFragments` (fixes the
   bulk of `yargs-parser.mjs`).
3. Resolve SUTs imported from **build output** (build the repo, or map `../build/lib/x` back to
   `src/x`) — currently `build/` is skipped and unbuilt (fixes yargs-parser's SUT binding).
4. mitt's factory/closure-method shape is a deeper model question (probing methods on a returned object),
   likely lower priority.

No product code (`mutation/`, `checker/`, `dist/`) was modified in this measurement task.

---

## eligibility widening (aliased assert + chai should)

Re-measure after the eligibility cycle (Tasks 1–3) widened the **pin gate** to recognize aliased /
destructured `assert`, a guarded 2-arg hybrid fallback, and standalone chai `should` chains (plus a
string/comment-masking precision fix). New artifact: `benchmark/reach/after-eligibility.json`, compared
against `after-runners.json` (prior: scored 133). Same 7 pinned repos.

### Headline — recognition landed, corpus reach is FLAT AGAIN (second consecutive null cycle)

| metric | after-runners.json (prior) | after-eligibility.json | delta |
|---|---|---|---|
| scored | 133 | **133** | **0** |
| probedFraction | 0.183 | 0.183 | 0 |
| skipped | 592 | 592 | 0 |
| hollow | 0 | **0** | 0 |

The summary is **byte-for-byte identical** to the prior milestone — not just scored, but skipped too, at
every repo. **No net reach gain on this corpus.** Stated plainly, no spin: this is the **second
consecutive reach cycle with zero corpus movement** (the mocha/ava cycle was the first). The eligibility
recognition is real and unit-test-validated (Tasks 1–3 negative tests + adversarial review), and it did
**not** move the corpus reach number.

### Per-repo scored / skipped, before → after (byte-identical)

| repo | runner | scored b→a | skipped b→a | hollow | note |
|---|---|---|---|---|---|
| ms | jest | 103 → 103 | 64 → 64 | 0 | unchanged (not a target this cycle) |
| classnames | node | 30 → 30 | 33 → 33 | 0 | unchanged |
| slugify | mocha | 0 → **0** | 45 → 45 | 0 | **pin gate now PASSES; falls out one gate later at SUT resolution** (root cause below) |
| mitt | mocha | 0 → 0 | 19 → 19 | 0 | still 0 — factory/method-shape SUT, **out of scope** (different reason) |
| yargs-parser | mocha | 0 → 0 | 369 → 369 | 0 | still 0 — SUT in unbuilt `build/`, **out of scope** (different reason) |
| python-slugify | pytest | 0 → 0 | 0 → 0 | 0 | unchanged (out of scope) |
| humanize | pytest | 0 → 0 | 62 → 62 | 0 | unchanged (out of scope) |

### slugify — ROOT-CAUSED with ground-truth evidence (the widening worked; a SECOND gate blocks it)

slugify was the predicted win: it aliases `assert`, exactly what Task 1 targeted. **The eligibility
widening did exactly its job** — but slugify still scores 0 because it falls out at an **independent,
downstream gate** the cycle never touched: SUT resolution.

Ground truth, from the freshly-cloned `test/slugify.js` (quoted verbatim):

```js
var t = require('assert')      // line 1 — aliased node:assert
var slugify = require('../')    // line 2 — SUT via a BARE DIRECTORY import
...
it('replace whitespaces with replacement', () => {
  t.equal(slugify('foo bar baz'), 'foo-bar-baz')   // aliased-assert value-pin
  t.equal(slugify('foo bar baz', '_'), 'foo_bar_baz')
})
```

Traced with the **real** exported gate functions (`mutation/prove.mjs`, `mutation/confirm.mjs`), not
assumptions:

- `importMap` → `{ t: 'assert', slugify: '../' }` — the aliased `t` **is** bound to node:assert (Task 1).
- `sutFnsIn(body)` → `['slugify']`; `pinnedFragments(body, imports)` → non-empty (the `t.equal(slugify(…), …)`
  is now recognized as value-pinning); **`eligibleFns(body, ['slugify'], imports)` → `['slugify']`.**
  **The pin gate PASSES and `slugify` is eligible.** This is the widening working.
- **The block is still SKIPPED** because the SUT does not RESOLVE. `slugify` is imported as
  `require('../')` — a bare **directory** import that Node resolves through `package.json`
  `"main": "./slugify.js"`. `resolveRelative` in `prove.mjs` generates candidates for the directory
  itself and `/index.{mjs,js,ts}` only — it **never reads the `main` field** — so `../` never maps to the
  real SUT file `slugify.js`. `resolveSut` returns `null`, the eligible fn is filtered out
  (`prove.mjs` L383 `.filter((x) => x.sutRel)`), `eligible.length` becomes 0, and the block is pushed to
  **skipped** (L385).

Airtight proof it is the SUT gate (not the pin gate): the real run reports `probes = 0` for slugify, so
**no block reached the execution stage** (`runOne`, L388). The only skip path reachable with `probes = 0`
is L385 (`!eligible.length`). Since `eligibleFns` is non-empty here, the emptiness comes solely from the
`resolveSut` filter. Net effect: the widening moved slugify's blocks from "skipped at the pin gate"
(prior cycle: `pinnedFragments = 0`) to "skipped at the SUT gate" — **same bucket, same count (45→45)**,
so the reach number is unchanged even though the internal disposition improved.

**This is NOT a reach win. slugify's real blocker is the directory-import-via-`package.json`-`main` SUT
resolution gap — out of scope for the eligibility cycle, and the clear next lever.**

### mitt / yargs-parser — still 0 for a DIFFERENT, out-of-scope reason (unchanged)

Both stayed byte-identical (mitt 19 skipped, yargs-parser 369 skipped). This cycle did **not** cover them;
their blockers are unrelated to assertion recognition:

- **mitt** (`import mitt, { Emitter } from '..'`): assertions type-check or pin emitter internals
  (`expect(mitt).to.be.a('function')`, `expect(a).to.have.been.calledOnce`), not a value-pinned `mitt()`
  factory return — the named-SUT probe model doesn't bind a factory/closure-method API. Structural, out
  of scope.
- **yargs-parser** (`import parser from '../build/lib/index.js'`): SUT is the **build output** — in
  `SKIP_DIRS` (`build/`) and never generated (`npm i` runs no TS build), so it can't resolve to a
  walkable source; the big suite also uses chai `should()` BDD chains. Out of scope this cycle.

### FP audit (THE HARD GATE) — zero false HOLLOW

Corpus-wide `hollow = 0` in every one of the 7 repos (`after-eligibility.json`), so there was nothing to
`--explain`: **zero HOLLOW ⇒ zero FALSE HOLLOW. The hard gate PASSES.** (The eligibility widening
introduced no misrecognition-driven false positive on the corpus — consistent with the Task 1–3 negative
tests and the masking precision fix.)

### Honest read + the next lever

The eligibility recognition is genuine and validated at the unit level, but corpus reach is **flat (0
gain) for the second cycle running**. slugify — the one repo this cycle was predicted to unblock — now
passes the pin gate yet still scores 0, blocked one gate later at SUT resolution (directory import via
`package.json` `main`). The next lever for reach is the **SUT resolver**, not assertion vocabulary:
resolve a bare directory import through its `package.json` `main` (fixes slugify), and map `../build/lib/x`
back to source (fixes yargs-parser). mitt's factory-shape remains a deeper, lower-priority model question.

No product code (`mutation/`, `checker/`, `dist/`) was modified in this measurement task.
