// mutation/selfcheck.mjs — the probe's own catch-AND-survive trial, run before gutcheck reports anything.
// It plants known-SOUND tests (they pin real values) and a known-HOLLOW test (its oracle re-runs the
// function under test), runs the real probe over them, and requires the probe to CATCH every sound one
// and FLAG the hollow one. If it can't tell them apart, no verdict it emits can be trusted, so gutcheck
// refuses to run (fail-closed) — the execution analog of the static checker's meta-guard.
//
// The planted shapes mirror the classes that have produced real false verdicts, not just the trivial
// happy path: a block-bodied function; a Prettier-wrapped ternary arrow, where a PARTIAL gut (the
// arrowSite line-continuation class, fixed 2026-08-19) leaves the asserted branch alive and a sound
// test reads hollow; and a wrapped method chain under a tautology, where a partial gut strands the
// chain tail on the sentinel, the crash reads as a catch, and the planted fake passes as real. A probe
// regressing on any of those shapes fails this gate instead of shipping verdicts.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prove } from './prove.mjs';

const PLANTED_SOUND = ['planted sound', 'planted sound (wrapped arrow)'];
const PLANTED_HOLLOW = 'planted hollow (wrapped chain)';

export function selfCheck() {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-selfcheck-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'src/lib.mjs'),
      'export function dbl(x){ return x * 2; }\n' +
      "export const label = (n) =>\n  n > 0\n    ? 'pos'\n    : 'neg';\n" +
      "export const slug = (s) =>\n  s.toLowerCase()\n    .trim()\n    .replace(/\\s+/g, '-');\n");
    writeFileSync(join(d, 'test/s.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { dbl, label, slug } from '../src/lib.mjs';\n" +
      `test('${PLANTED_SOUND[0]}', () => { assert.strictEqual(dbl(3), 6); });\n` +
      `test('${PLANTED_SOUND[1]}', () => { assert.strictEqual(label(3), 'pos'); });\n` +
      `test('${PLANTED_HOLLOW}', () => { assert.strictEqual(slug('A B'), slug('A B')); });\n`);
    const r = prove(d, { runner: 'node' });
    const hollowNames = (r.hollow || []).map((h) => h.name);
    const flaggedHollow = hollowNames.includes(PLANTED_HOLLOW);
    const provenNames = new Set((r.proven || []).map((p) => p.name));
    const missedSound = PLANTED_SOUND.filter((n) => !provenNames.has(n));
    const caughtSound = missedSound.length === 0;
    const detail = !caughtSound ? `planted sound test(s) not caught when their function was gutted: ${missedSound.join(', ')}`
      : !flaggedHollow ? 'the planted hollow test (wrapped-chain tautology) was not detected'
      : '';
    return { ok: caughtSound && flaggedHollow, caughtSound, flaggedHollow, caught: r.caught, hollowNames, detail };
  } catch (e) {
    return { ok: false, caughtSound: false, flaggedHollow: false, caught: 0, hollowNames: [], detail: String(e && e.message) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
