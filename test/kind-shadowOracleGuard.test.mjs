import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, runEnv } from '../checker/kinds/shadowOracleGuard.mjs';

const env = runEnv({ params: {} }); // defaults

test('flags an expected-side bare local call (the shadow-oracle shape)', () => {
  const src = 'function shadowTotal(){ return 142.50; }\nexpect(total).toBeCloseTo(shadowTotal(), 2);';
  assert.equal(detect(src, env).length, 1);
});
test('flags a const-arrow shadow used as the expected value in toBe', () => {
  assert.equal(detect('const recompute = () => 5;\nexpect(out).toBe(recompute());', env).length, 1);
});
test('exempts a literal-expected assertion (even with a local def present)', () => {
  assert.equal(detect('function shadowTotal(){ return 142.50; }\nexpect(area).toBeCloseTo(78.54, 2);', env).length, 0);
});
test('exempts a shadow call carrying the INDEPENDENT-ORACLE marker in-window', () => {
  const src = 'function indep(){ return 142.50; }\n// INDEPENDENT-ORACLE: cross-checked against the spec table\nexpect(total).toBeCloseTo(indep(), 2);';
  assert.equal(detect(src, env).length, 0);
});
test('THE DISCRIMINATOR: does NOT flag a NON-local (independent) oracle call', () => {
  // referenceTotal is imported/global — not declared in this file — so it is a legitimate oracle.
  assert.equal(detect('expect(total).toBeCloseTo(referenceTotal(), 2);', env).length, 0);
});
test('does NOT flag a local call on the expect() actual side', () => {
  // shadowTotal is local, but here it produces the ACTUAL value; the matcher only inspects the
  // expected side (the arg AFTER the matcher method), so an actual-side call is naturally excluded.
  const src = 'function shadowTotal(){ return 142.50; }\nexpect(shadowTotal()).toBe(142.50);';
  assert.equal(detect(src, env).length, 0);
});
test('window-aware: a SHADOW-OK marker one line above exempts', () => {
  const src = 'function shadowTotal(){ return 142.50; }\n// SHADOW-OK: drift accepted, fixture-only helper\nexpect(total).toBeCloseTo(shadowTotal(), 2);';
  assert.equal(detect(src, env).length, 0);
});
test('VARIABLE shape: flags a bare var assigned from a local-fn call, used as the expected value', () => {
  const src = 'function recompute(){ return 5; }\nconst e = recompute();\nexpect(out).toBe(e);';
  assert.equal(detect(src, env).length, 1);
});
test('VARIABLE shape: does NOT flag a var assigned from a NON-local (imported) oracle call', () => {
  // referenceTotal is imported — an independent oracle — so the variable carrying its result is clean.
  assert.equal(detect('const e = referenceTotal();\nexpect(out).toBe(e);', env).length, 0);
});
test('VARIABLE shape: a SHADOW-OK marker above the assertion exempts the variable form too', () => {
  const src = 'function recompute(){ return 5; }\nconst e = recompute();\n// SHADOW-OK: fixture-only helper\nexpect(out).toBe(e);';
  assert.equal(detect(src, env).length, 0);
});
test('NUMERIC GATE: does NOT flag a fixture-builder helper that returns a data structure', () => {
  // make_item returns an object literal — canonical test data, not a numeric re-derivation of the SUT.
  assert.equal(detect('function makeItem(){ return { value: 3, name: "a" }; }\nexpect(loaded).toEqual(makeItem());', env).length, 0);
});
test('NUMERIC GATE: does NOT flag a formatter helper that returns a constructor', () => {
  // url_to_origin re-wraps its argument into a URL object — a formatter, not a numeric shadow.
  assert.equal(detect('function urlToOrigin(u){ return new URL(u); }\nexpect(pool.url).toEqual(urlToOrigin(expected));', env).length, 0);
});
test('NUMERIC GATE: STILL flags a helper that computes a number via arithmetic', () => {
  assert.equal(detect('function reShadow(items){ return items.total * 1.08; }\nexpect(x).toBeCloseTo(reShadow(items), 2);', env).length, 1);
});
