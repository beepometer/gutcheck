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

// A relative import path is not a derivation. DEFAULT_MSG_DERIVATION exists to exempt a value whose
// derivation is written inside an assertion's MESSAGE string ("x = 5.0/√6"), but its digit-or-dot
// character classes accepted a bare '.', so '../src/lib.js' satisfied it: leading '.', the '/' as the
// operator, the extension's '.' as the trailing operand. Every magic literal within the 5-line window
// of such an import was therefore silently exempted — and most JS/TS test files open with exactly that
// import. The control below is the whole proof: same file, same literal, extension removed, and the
// finding reappears.
test('a relative import path does not count as a derivation (extension dot is not an operand)', () => {
  const withExt = "import { area } from '../src/lib.js';\nexpect(area(5)).toBeCloseTo(78.539816, 5);";
  const noExt = "import { area } from '../src/lib';\nexpect(area(5)).toBeCloseTo(78.539816, 5);";
  assert.equal(detect(withExt, env).length, 1, 'a path-shaped string must not exempt the literal');
  assert.equal(detect(noExt, env).length, 1, 'control: same literal, no extension — always flagged');
});
test('a derivation inside an assertion message is still exempt, including leading-decimal forms', () => {
  for (const msg of ['x = 5.0/√6', 'scale = .5/2', 'half = 1/.5', 'ratio .75*4']) {
    const code = `assertEquals('${msg}', 2.041); expect(v).toBeCloseTo(2.041, 3);`;
    assert.equal(detect(code, env).length, 0, `must stay exempt: ${msg}`);
  }
});

// node:assert dialect (backlog item 5): DEFAULT_ASSERTIONS knew only jest/vitest matchers, so the
// check was structurally inert on a node:assert codebase — it had never fired on this repo's own
// ~1,210 node:assert calls, while shipping in the adopter floor and on the done-claim advisory.
// The dialect follows node:assert's (actual, expected) argument order: the expected literal is the
// SECOND argument (an optional message may trail it), and the actual side is an identifier, dotted
// path, or call (one paren-nesting level, optional `await`). The ≥3-fractional-digit floor from the
// jest calibration (5/5 one-digit-decimal FPs) carries over unchanged.
test('node:assert: flags an uncited long decimal expected in assert.strictEqual', () => {
  assert.equal(detect('assert.strictEqual(computeGain(20), 6.0206);', env).length, 1);
});
test('node:assert: flags across the equality family, multi-arg calls, await, and a trailing message', () => {
  assert.equal(detect('assert.equal(mix(1, 2), 1.41421)', env).length, 1);
  assert.equal(detect('assert.deepStrictEqual(ratio.value, 0.33333)', env).length, 1);
  assert.equal(detect("assert.strictEqual(area(5), 78.53981, 'circle area')", env).length, 1);
  assert.equal(detect('assert.strictEqual(await area(5), 78.53981)', env).length, 1);
});
test('node:assert: the >=3-fractional-digit floor holds — short decimals and integers never flag', () => {
  assert.equal(detect('assert.strictEqual(d.asSeconds(), 0.5)', env).length, 0);
  assert.equal(detect('assert.equal(n, 42)', env).length, 0);
  assert.equal(detect('assert.strictEqual(count, 1)', env).length, 0);
});
test('node:assert: an inline derivation comment exempts, same as the jest dialect', () => {
  assert.equal(detect('assert.strictEqual(gain, 6.0206); // 20 * 0.30103 = 6.0206', env).length, 0);
});
test('node:assert: a derivation in the trailing MESSAGE argument exempts (position-agnostic msgDeriv)', () => {
  assert.equal(detect("assert.strictEqual(v, 2.041, 'x = 5.0/√6')", env).length, 0);
});
test('node:assert: a float inside a string argument never flags (strings are blanked)', () => {
  assert.equal(detect("assert.strictEqual(msg, 'pi is 3.14159 here')", env).length, 0);
});
test('node:assert: a multiline call is joined and still flags (joinLogicalLines)', () => {
  assert.equal(detect('assert.strictEqual(\n  computeGain(20),\n  6.0206,\n);', env).length, 1);
});
test('node:assert: expected-FIRST (Yoda/JUnit habit) is a deliberate miss, never a flag', () => {
  assert.equal(detect('assert.strictEqual(78.53981, area(5))', env).length, 0);
});
