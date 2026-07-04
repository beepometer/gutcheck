import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect as weak } from '../checker/kinds/weakOracleGuard.mjs';
import { detect as free } from '../checker/kinds/assertionFreeTest.mjs';

const env = { lang: 'typescript' };
const flagged = (fn, src) => fn(src, env).length > 0;

// Real-world dialects the checker flooded false positives on before this fix: destructured node:assert
// (nanoid: `import { equal } from 'node:assert'`), uvu (`assert.is`), ava (`t.is`).
test('weakOracleGuard: destructured node:assert / uvu / ava value pins are NOT weak', () => {
  for (const src of [
    "it('x', () => { equal(compute(5), 25); });",
    "it('x', () => { deepStrictEqual(parse(s), out); });",
    "it('x', () => { strictEqual(f(1), 2); });",
    "it('x', () => { notEqual(f(1), 9); });",
    "it('x', () => { assert.is(compute(5), 25); });",
    "it('x', () => { t.is(compute(5), 25); });",
    "it('x', () => { t.deepEqual(parse(s), out); });",
  ]) assert.equal(flagged(weak, src), false, `value pin wrongly flagged weak: ${src}`);
});

test('weakOracleGuard: genuinely weak oracles still flag (no over-correction)', () => {
  for (const src of [
    "it('x', () => { const r = compute(5); expect(r).toBeDefined(); });",
    "test('runs', () => { doThing(1); });",
    "it('x', () => { ok(isReady(5)); });", // bare truthy is not a value pin
  ]) assert.equal(flagged(weak, src), true, `weak oracle missed: ${src}`);
});

test('assertionFreeTest: destructured node:assert counts as an assertion (not assertion-free)', () => {
  for (const src of [
    "it('a', () => { equal(compute(5), 25); });",
    "it('a', () => { deepStrictEqual(parse(s), out); });",
    "it('a', () => { ok(run()); });",
  ]) assert.equal(flagged(free, src), false, `assertion wrongly called assertion-free: ${src}`);
  // still flags a genuinely assertion-free test
  assert.equal(flagged(free, "it('a', () => { setup(); compute(5); });"), true, 'assertion-free test missed');
});
