import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, runEnv } from '../checker/kinds/derivationCoherence.mjs';

// The default config's assertionSrcs (configure/gutcheck.default.json / configure/checksets/python.mjs),
// duplicated here so these unit tests exercise the SAME extraction shapes real projects hit, not a
// simplified stand-in.
const JS_ASSERTION_SRCS = [
  '\\.(?:toBe|toBeCloseTo|toEqual|toStrictEqual)\\(\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
  '==\\s*(-?\\d+\\.\\d+)',
  'assert\\.(?:strictEqual|deepStrictEqual|equal|deepEqual)\\(\\s*(?:[A-Za-z_$][\\w$.]*\\((?:[^()]|\\([^()]*\\))*\\)|[A-Za-z_$][\\w$.]*|-?\\d+(?:\\.\\d+)?)\\s*,\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
];
const PY_ASSERTION_SRCS = [
  '==\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
  '\\bapprox\\(\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
  '\\bassertAlmostEqual\\(\\s*[^,]+,\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
];
const jsEnv = runEnv({ params: { lang: 'typescript', assertionSrcs: JS_ASSERTION_SRCS } });
const pyEnv = runEnv({ params: { lang: 'python', assertionSrcs: PY_ASSERTION_SRCS } });

// --- corpus audit (docs/plans/2026-07-04-pattern-cycle.md Task 3): js/py-derivation-coherence went
// 0/9 TRUE on a wild-corpus sweep, all four reproducible parser-mechanism bugs. RED tests below use the
// audit's EXACT quoted lines (lint-audit-fallback-derivation.md) — none of these is a real bug. ---

// (A) comma-chained two-step derivations truncated at the first `=`
test('mechanism A: a comma-chained two-step derivation is read end-to-end, not truncated at the first "="', () => {
  assert.equal(
    detect('expect(database.getHueBucket(-10)).toBe(35); // -10 + 360 = 350, 350/10 = 35', jsEnv).length, 0,
    'xivdyetools DyeDatabase.test.ts:337 — the FINAL clause (350/10 = 35) matches the assertion',
  );
  assert.equal(
    detect('expect(database.getHueBucket(370)).toBe(1); // 370 % 360 = 10, 10/10 = 1', jsEnv).length, 0,
    'xivdyetools DyeDatabase.test.ts:341 — same mechanism, the final clause (10/10 = 1) matches',
  );
});

// (B) `.toBe(A - B)` unparenthesized expression args — leading-numeral capture bug
test('mechanism B: an unparenthesized expression assertion argument is captured (and evaluated) in full, not just its leading numeral', () => {
  assert.equal(
    detect('expect(balance).toBe(-200 - 100) // -300', jsEnv).length, 0,
    'flowglad ledgerEntryMethods.db.test.ts:1574 — real expected is -300 (-200-100), matching the comment',
  );
  assert.equal(
    detect('expect(balance).toBe(100 - 250) // -150', jsEnv).length, 0,
    'flowglad ledgerEntryMethods.db.test.ts:1666 — real expected is -150 (100-250), matching the comment',
  );
});

// (C) PEMDAS/grouping ambiguity — a percentage comment without an outer grouping paren
test('mechanism C: a comment mixing additive and multiplicative operators at the top level (grouping-ambiguous) is skipped, not force-evaluated under strict PEMDAS', () => {
  assert.equal(
    detect('expect(m.grossRevenueRetention[1]?.value).toBe(93); // 1-(900+150)/15000*100', jsEnv).length, 0,
    'hoaxnerd/burnless revenue-intelligence.test.ts:637 — ambiguous between 1-((900+150)/15000*100)=-6 and the intended (1-(900+150)/15000)*100=93',
  );
});

// (D) count-vs-sum — a `+`-joined component list documenting a COUNT, no stated `=` result
test('mechanism D: an un-anchored "+"-joined descriptive list (no explicit "=" result) is never evaluated as a sum', () => {
  assert.equal(
    detect('assert context.high_priority_count == 2  # 3 + 4', pyEnv).length, 0,
    'JosephOIbrahim/OTTO test_json_task_adapter.py:303 — "3 + 4" names the two qualifying values, is not a sum',
  );
  assert.equal(
    detect('assert row.chunk_count == 3  # 4096 + 4096 + 2048', pyEnv).length, 0,
    'Martossien/transcria test_artifact_store.py:76 — lists 3 chunk sizes; the assertion is on COUNT, not sum',
  );
  assert.equal(
    detect('assert len(book_batches) == 3  # 25 + 25 + 10', pyEnv).length, 0,
    'alexandrosh8/sharp-ev-picks test_betfair_api.py:280 — lists 3 batch sizes; assertion is on COUNT',
  );
  assert.equal(
    detect('assert len(result) == 4  # 30+30+30+10', pyEnv).length, 0,
    'punt-labs/vox test_openai_provider.py:71 — lists 4 chunk lengths; assertion is on COUNT',
  );
});

// --- regression: the hardening must not neuter real mismatch detection ---
test('regression: a genuine chained-derivation mismatch still flags after the mechanism-A fix', () => {
  // final clause (350/10 = 35) computed correctly, but the code asserts 99 -> a real bug, must still flag.
  assert.equal(detect('expect(f(-10)).toBe(99); // -10 + 360 = 350, 350/10 = 35', jsEnv).length, 1);
});

test('regression: a genuine expression-argument mismatch still flags after the mechanism-B fix', () => {
  // expected = evalExpr("-200 - 100") = -300; comment computes -290 -> a real mismatch, must still flag.
  assert.equal(detect('expect(balance).toBe(-200 - 100); // -190 - 100 = -290', jsEnv).length, 1);
});

test('regression: the R3 planted mismatch (single-operator-class comment) still flags', () => {
  assert.equal(detect('expect(area(5)).toBe(80.0); // 3.14159 * 5 * 5 = 78.54', jsEnv).length, 1);
  assert.equal(detect('assert area == 80.0  # 3.14159 * 5 * 5 = 78.54', pyEnv).length, 1);
});

// FP repro (2026-08-19 lint audit): an earlier NAMED `label = value` clause consumed the digits that
// begin the real derivation's left side (`ttl = 300` ate the `300` of `300-60`), truncating the last
// clause's LHS to `-60` — a valid unary-minus atom, so the check computed -60 ≠ 240 and flagged a
// fully coherent comment. A clause's VALUE must end at a clause boundary, never mid-expression.
test('does NOT flag a two-clause comment where a named label precedes the real derivation', () => {
  const src = 'assert.strictEqual(refreshIntervalFor(300), 240); // ttl = 300, refreshInterval = 300-60 = 240';
  assert.equal(detect(src, jsEnv).length, 0);
});
test('still flags a genuinely wrong derivation behind a leading label clause', () => {
  // (`100*3`, not `300-60` — a bare int-int expression hits the pre-existing RANGE skip.)
  const src = 'assert.strictEqual(totalFor(100), 250); // base = 100, total = 100*3 = 300';
  assert.equal(detect(src, jsEnv).length, 1, 'the last clause computes 300, the assertion expects 250');
});

// Review finding (2026-08-19): `%` sat in the value-boundary reject class alongside real operators,
// so a percent-suffixed derivation (`= 6.0206%` — an extremely common form, and the exact shape the
// check's own ×100/÷100 percentage tolerance exists for) never matched a clause at all and the whole
// line went unchecked. A trailing `%` is a percent sign, not a modulo continuation.
test('a percent-suffixed derivation still anchors a clause: mismatches flag, coherent percentages stay quiet', () => {
  const bad = 'assert.strictEqual(gainFor(20), 70); // 20 * 0.30103 = 6.0206%';
  assert.equal(detect(bad, jsEnv).length, 1, '70 is nowhere near 6.02 — must flag');
  const ok = 'assert.strictEqual(rateFor(130), 65); // 130/200 = 65%';
  assert.equal(detect(ok, jsEnv).length, 0, 'the x100 percentage tolerance accepts 0.65 vs 65');
});
