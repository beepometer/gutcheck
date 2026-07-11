import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, runEnv } from '../checker/kinds/magicLiteralGuard.mjs';

const env = runEnv({ params: {} }); // defaults

test('flags a bare computed decimal in toBeCloseTo', () => {
  assert.equal(detect('expect(x).toBeCloseTo(3.14159, 5)', env).length, 1);
});
test('flags a long uncited decimal in toBe (>=3 fractional digits)', () => {
  assert.equal(detect('expect(x).toBe(85.83333333333333)', env).length, 1);
});
test('does NOT flag a short self-evident decimal in toBe (<3 fractional digits)', () => {
  assert.equal(detect('expect(d.asSeconds()).toBe(0.5)', env).length, 0);
});
test('exempts a literal carrying the CLOSED-FORM-ORACLE marker', () => {
  assert.equal(detect('expect(x).toBeCloseTo(3.14159, 5) // CLOSED-FORM-ORACLE: pi', env).length, 0);
});
test('exempts a literal with an inline arithmetic derivation (the GF-4 control shape)', () => {
  assert.equal(detect('expect(pct).toBeCloseTo(100.0, 6); // (100-50)/50*100 = 100.0', env).length, 0);
  assert.equal(detect('expect(area).toBeCloseTo(78.54, 2) // pi * 5^2 = 78.54', env).length, 0);
});
test('does not flag a trivial literal or a bare integer toBe', () => {
  assert.equal(detect('expect(n).toBe(1)', env).length, 0);   // trivial allowlist
  assert.equal(detect('expect(n).toBe(3)', env).length, 0);   // integer (not a decimal) in toBe
});
test('window-aware: a derivation comment one line above exempts', () => {
  assert.equal(detect('// expected = 2 * 1.25 = 2.5\nexpect(x).toBeCloseTo(2.5, 6)', env).length, 0);
});
