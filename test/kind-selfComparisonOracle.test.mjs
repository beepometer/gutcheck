import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, runEnv } from '../checker/kinds/selfComparisonOracle.mjs';

const jsEnv = runEnv({ params: {
  lang: 'typescript',
  assertionSrcs: [
    'expect\\(\\s*([A-Za-z_$][\\w$.]*\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*\\)\\.toBe\\(\\s*([A-Za-z_$][\\w$.]*\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*\\)',
    'expect\\(\\s*([A-Za-z_$][\\w$.]*\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*\\)\\.toEqual\\(\\s*([A-Za-z_$][\\w$.]*\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*\\)',
  ],
} });

// specimen: a real-repo "determinism" test found by the probe — dedupSlug(email) compared to itself.
test('flags an INLINE self-comparison (two textually identical call expressions)', () => {
  assert.equal(detect('expect(dedupSlug(email)).toBe(dedupSlug(email));', jsEnv).length, 1);
});

test('flags the VARIABLE-derived shape (both sides assigned from the identical call text)', () => {
  const src = 'const a = dedupSlug(email);\nconst b = dedupSlug(email);\nexpect(a).toBe(b);';
  assert.equal(detect(src, jsEnv).length, 1);
});

test('does NOT flag DIFFERENT args (the case-normalization sibling is legitimate)', () => {
  assert.equal(detect("expect(dedupSlug('User@X')).toBe(dedupSlug('user@x'));", jsEnv).length, 0);
});

test('does NOT flag DIFFERENT functions', () => {
  assert.equal(detect('expect(dedupSlug(email)).toBe(otherFn(email));', jsEnv).length, 0);
});

test('does NOT flag a self-comparison where one side is a LITERAL (a real pin)', () => {
  assert.equal(detect("expect(dedupSlug(email)).toBe('abc');", jsEnv).length, 0);
  assert.equal(detect('expect(3).toBe(dedupSlug(email));', jsEnv).length, 0);
});

test('does NOT flag two unrelated bare variables (neither derived from a recorded call)', () => {
  assert.equal(detect('expect(a).toBe(b);', jsEnv).length, 0);
});

// FP hunt (review of 653c479): variable bindings must be SCOPED — a later, unrelated declaration in a
// DIFFERENT test block must never rewrite the binding an earlier assertion resolved against.
test('SCOPE: a later same-named declaration in another test block does NOT poison an earlier legitimate cross-check', () => {
  const src = [
    "test('cross-check against the independent oracle', () => {",
    '  const actual = computeTotal(order);',
    '  const expected = referenceTotal(order);',
    '  expect(actual).toBe(expected);',
    '});',
    "test('total is stable', () => {",
    '  const expected = computeTotal(order);',
    '  expect(expected).toBe(42);',
    '});',
  ].join('\n');
  assert.equal(detect(src, jsEnv).length, 0);
});

test('SCOPE: a binding from a previous test block does not leak forward across the block boundary', () => {
  const src = [
    "test('a', () => {",
    '  const a = computeTotal(order);',
    '  expect(a).toBe(42);',
    '});',
    "test('b', () => {",
    '  const b = computeTotal(order);',
    '  expect(a).toBe(b);', // this `a` is NOT the block-scoped `a` above — must not resolve
    '});',
  ].join('\n');
  assert.equal(detect(src, jsEnv).length, 0);
});

test('SCOPE: the variable shape still flags WITHIN one test block (the reset does not over-clear)', () => {
  const src = [
    "test('determinism', () => {",
    '  const a = dedupSlug(email);',
    '  const b = dedupSlug(email);',
    '  expect(a).toBe(b);',
    '});',
  ].join('\n');
  assert.equal(detect(src, jsEnv).length, 1);
});

// DELIBERATE EXCLUSION (pinned): an idempotence property test compares f(f(x)) to f(x) — a nested call
// vs a single call are DIFFERENT call texts asserting a real property (f∘f = f). Currently unflagged
// only because the call-operand regex is flat (no nested parens); this test locks the exclusion in so
// future nested-call support cannot silently start hard-failing legitimate idempotence tests.
test('does NOT flag an idempotence property test (f(f(x)) vs f(x)) — pinned deliberate exclusion', () => {
  assert.equal(detect('expect(normalize(normalize(x))).toBe(normalize(x));', jsEnv).length, 0);
});

test('whitespace adjacent to the call parens is normalized: f( x ) and f(x) are the same call text', () => {
  assert.equal(detect('expect(dedupSlug( email )).toBe(dedupSlug(email));', jsEnv).length, 1);
});
