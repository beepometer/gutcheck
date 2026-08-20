import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, runEnv } from '../checker/kinds/assertionConsistency.mjs';

// The SHIPPED floor assertion shape (configure/gutcheck.default.json, js-assertion-consistency) —
// tests here must exercise the same regex the product runs, not a test-local approximation.
const env = runEnv({ params: {
  lang: 'typescript',
  assertionSrcs: ['expect\\(\\s*([A-Za-z_][\\w.]*\\([^()]*\\))\\s*\\)\\.(?:toBe|toEqual|toStrictEqual)\\(\\s*([^)]+?)\\s*\\)'],
} });

// The true-positive core, in both distances. NOTE: the ADJACENT contradiction is pinned as mustFlag
// by the shipped selfTest (factorial 120 then 121), so no calibration here may key on adjacency —
// state-progression tests are instead recognized by name (sequence/id generators) or by an
// intervening mutation call.
test('flags a contradiction, adjacent or separated only by other assertions', () => {
  const adjacent = "test('t', () => {\n  expect(factorial(5)).toBe(120);\n  expect(factorial(5)).toBe(121);\n});";
  assert.equal(detect(adjacent, env).length, 1);
  const distant = "test('t', () => {\n  expect(area(5)).toBe(78);\n  expect(perimeter(5)).toBe(31);\n  expect(area(5)).toBe(80);\n});";
  assert.equal(detect(distant, env).length, 1);
});

// FP repros (2026-08-19 lint audit) — ordinary state-transition tests, not contradictions:

// A sequence/id generator demonstrated by progressive assertions: recognized by its NAME (an anchored
// id/seq/counter token — `idFor`, `nextToken`, `sessionCounter`), the same mechanism as the existing
// impure list (env/now/random/…).
test('does NOT flag progressive assertions on a sequence/id-generator-named call', () => {
  const src = "test('idFor increments per call even for the same kind', () => {\n  expect(idFor('session')).toBe(1);\n  expect(idFor('session')).toBe(2);\n});";
  assert.equal(detect(src, env).length, 0);
  const counter = "test('c', () => {\n  expect(pageCounter(1)).toBe(1);\n  expect(pageCounter(1)).toBe(2);\n});";
  assert.equal(detect(counter, env).length, 0);
});

// An anchored token must not over-reach: `gridWidth` contains `id` mid-word and stays checkable.
// (`validate` would not do as the control here — it contains `date`, already exempt under the
// pre-existing substring list.)
test('the generator-name tokens are boundary-anchored — gridWidth() still flags', () => {
  const src = "test('g', () => {\n  expect(gridWidth(5)).toBe(3);\n  expect(gridWidth(5)).toBe(4);\n});";
  assert.equal(detect(src, env).length, 1);
});

// An intervening NON-assertion call statement can mutate state (invalidate a cache, reseed a store):
// the second assertion legitimately observes a different value.
test('does NOT flag a contradiction with intervening mutation calls between the assertions', () => {
  const src = [
    "test('memoized value can be invalidated and reseeded', () => {",
    '  expect(computeExpensiveValue(10)).toBe(100);',
    '  invalidateCache();',
    '  seedValue(10, 999);',
    '  expect(computeExpensiveValue(10)).toBe(999);',
    '});',
  ].join('\n');
  assert.equal(detect(src, env).length, 0);
});

// Intervening ASSERTIONS never suppress — that is exactly the copy-paste-distance class.
test('intervening assertions do not suppress (only non-assertion calls do)', () => {
  const src = "test('t', () => {\n  expect(area(5)).toBe(78);\n  expect(mul(2, 3)).toBe(6);\n  expect(area(5)).toBe(80);\n});";
  assert.equal(detect(src, env).length, 1);
});

// Existing calibrations stay pinned: cross-test-boundary resets never flag.
test('does NOT flag the same call asserted differently across test boundaries', () => {
  const across = "test('a', () => {\n  expect(area(5)).toBe(78);\n});\ntest('b', () => {\n  expect(area(5)).toBe(80);\n});";
  assert.equal(detect(across, env).length, 0);
});

// Review finding (2026-08-19): prefix tokens like `next`/`counter` matched ordinary camelCase English
// compounds (`nextPrime`, `counterClockwiseAngle`) and exempted genuinely pure functions. Generator
// PREFIXES are now id-only; the other tokens exempt as SUFFIXES (`pageCounter`, `nextToken`), where
// the compound reads as "a thing that generates".
test('pure functions merely starting with next/counter stay checkable', () => {
  const prime = "test('t', () => {\n  expect(nextPrime(10)).toBe(11);\n  expect(nextPrime(10)).toBe(13);\n});";
  assert.equal(detect(prime, env).length, 1);
  // (`counterExample`, not `counterClockwiseAngle` — the latter contains `clock`, exempt under the
  // pre-existing substring IMPURE list.)
  const cx = "test('t', () => {\n  expect(counterExample(90)).toBe(270);\n  expect(counterExample(90)).toBe(200);\n});";
  assert.equal(detect(cx, env).length, 1);
  const token = "test('t', () => {\n  expect(nextToken('a')).toBe(1);\n  expect(nextToken('a')).toBe(2);\n});";
  assert.equal(detect(token, env).length, 0, 'nextToken exempts via the Token suffix');
});
