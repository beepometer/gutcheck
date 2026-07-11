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
