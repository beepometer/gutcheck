// Relational-assert vocabulary — spec Feature 2 §1. Oracles hand-derived from the spec.
import { test } from 'node:test';
import assert from 'node:assert';
import { pinnedFragmentsByKind, pinnedFragments, topLevelComparisonSides, eligibleFnsDetail, eligibleFns } from '../mutation/prove.mjs';

test('jest/vitest relational matchers land in relational, both sides pushed', () => {
  const k = pinnedFragmentsByKind(`expect(calc(x)).toBeGreaterThan(limit(y));`);
  assert.deepEqual(k.value, []);
  assert.ok(k.relational.some((f) => f.includes('calc(x)')));
  assert.ok(k.relational.some((f) => f.includes('limit(y)')));
});

test('resolves/rejects prefix works for relational matchers like it does for VALUE_PIN', () => {
  const k = pinnedFragmentsByKind(`expect(fetchScore(a)).resolves.toBeLessThanOrEqual(9);`);
  assert.ok(k.relational.some((f) => f.includes('fetchScore(a)')));
});

test('chai expect relational chains (.to.be.above / .to.be.at.least) are relational', () => {
  const k = pinnedFragmentsByKind(`expect(calc(x)).to.be.above(lo(y)); expect(calc(x)).to.be.at.least(0);`);
  assert.ok(k.relational.some((f) => f.includes('calc(x)')));
  assert.ok(k.relational.some((f) => f.includes('lo(y)')));
  assert.deepEqual(k.value, []);
});

test('chai should relational chain pushes the receiver', () => {
  const k = pinnedFragmentsByKind(`calc(x).should.be.below(9);`);
  assert.ok(k.relational.some((f) => f.includes('calc(x)')));
});

test('bare assert()/assert.ok() with a top-level comparison is relational; plain truthiness stays out', () => {
  const rel = pinnedFragmentsByKind(`assert(calc(x) > floor(y)); assert.ok(scale(z) <= 10);`);
  assert.ok(rel.relational.some((f) => f.includes('calc(x)')));
  assert.ok(rel.relational.some((f) => f.includes('floor(y)')));
  assert.ok(rel.relational.some((f) => f.includes('scale(z)')));
  const truthy = pinnedFragmentsByKind(`assert(calc(x)); assert.ok(ready(y));`);
  assert.deepEqual(truthy.relational, []);
  assert.deepEqual(truthy.value, []);
});

test('boolean-joined and equality args are never relational (fail-closed)', () => {
  const k = pinnedFragmentsByKind(`assert(a(x) > 0 && b(x) > 0); assert.ok(c(x) !== 5); assert.ok(d(x) == 5);`);
  assert.deepEqual(k.relational, []);
});

test('pytest bare relational assert pushes both sides (regex path, chained allowed)', () => {
  const k = pinnedFragmentsByKind(`assert calc(x) >= floor(y)\nassert 0 < mid(z) < 10\n`);
  assert.ok(k.relational.some((f) => f.includes('calc(x)')));
  assert.ok(k.relational.some((f) => f.includes('floor(y)')));
  assert.ok(k.relational.some((f) => f.includes('mid(z)')));
});

test('value vocabulary is untouched: equality forms still land in value, and the flat wrapper is the concatenation', () => {
  const k = pinnedFragmentsByKind(`expect(calc(x)).toBe(4); assert.strictEqual(f(a), 2); assert g(b) == 3\n`);
  assert.ok(k.value.length >= 3);
  assert.deepEqual(k.relational, []);
  assert.deepEqual(pinnedFragments(`expect(calc(x)).toBe(4);`), pinnedFragmentsByKind(`expect(calc(x)).toBe(4);`).value);
});

test('topLevelComparisonSides: single comparator splits; arrows, shifts, second comparator, &&, equality all refuse', () => {
  assert.deepEqual(topLevelComparisonSides('calc(x) > floor(y)'), ['calc(x)', 'floor(y)']);
  assert.deepEqual(topLevelComparisonSides('f(a, g(b) > 1)'), null); // comparator not at depth 0
  assert.equal(topLevelComparisonSides('xs.map(x => x) > 0 && ok'), null);
  assert.equal(topLevelComparisonSides('a << 2'), null);
  assert.equal(topLevelComparisonSides('a > b > c'), null);
  assert.equal(topLevelComparisonSides('a === b'), null);
  assert.deepEqual(topLevelComparisonSides('scale(z) <= 10'), ['scale(z)', '10']);
});

test('eligibleFnsDetail: relational-only credit is flagged; a fn with any value pin is not', () => {
  const body = `expect(calc(x)).toBeGreaterThan(0); expect(scale(y)).toBe(4);`;
  const d = eligibleFnsDetail(body, ['calc', 'scale']);
  assert.deepEqual([...d.eligible].sort(), ['calc', 'scale']);
  assert.deepEqual(d.relationalOnly, ['calc']);
  assert.equal(d.hadPin, true);
  assert.equal(d.hadValuePin, true);
});

test('eligibleFnsDetail: relational-only body — hadValuePin false, all credits flagged', () => {
  const d = eligibleFnsDetail(`assert.ok(calc(x) > 0);`, ['calc']);
  assert.deepEqual(d.eligible, ['calc']);
  assert.deepEqual(d.relationalOnly, ['calc']);
  assert.equal(d.hadValuePin, false);
});

test('eligibleFnsDetail: value-only body is byte-compatible — relationalOnly empty, eligible unchanged', () => {
  const d = eligibleFnsDetail(`expect(scale(y)).toBe(4);`, ['scale', 'other']);
  assert.deepEqual(d.eligible, ['scale']);
  assert.deepEqual(d.relationalOnly, []);
  assert.equal(eligibleFns(`expect(scale(y)).toBe(4);`, ['scale', 'other']).length, 1);
});

test('eligibleFnsDetail: var-hop credit inherits the kind of the fragment that pinned the var', () => {
  const body = `const r = calc(x);\nexpect(r).toBeGreaterThan(0);\nconst v = scale(y);\nexpect(v).toBe(4);`;
  const d = eligibleFnsDetail(body, ['calc', 'scale']);
  assert.deepEqual(d.relationalOnly, ['calc']);
  assert.deepEqual([...d.eligible].sort(), ['calc', 'scale']);
});

test('braceArgFrom: balanced inner text, null on imbalance', async () => {
  const { braceArgFrom } = await import('../mutation/prove.mjs');
  const s = 'assertTrue { a { b } > c }';
  assert.equal(braceArgFrom(s, s.indexOf('{')), ' a { b } > c ');
  assert.equal(braceArgFrom('x { open', 2), null);
});
