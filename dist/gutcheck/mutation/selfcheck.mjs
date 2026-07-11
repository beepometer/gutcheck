// mutation/selfcheck.mjs — the probe's own catch-AND-survive trial, run before gutcheck reports anything.
// It plants a known-HOLLOW test (its oracle re-runs the function under test) and a known-SOUND test (it
// pins a real value), runs the real probe over them, and requires the probe to FLAG the hollow one and
// CATCH the sound one. If it can't tell them apart, no verdict it emits can be trusted, so gutcheck
// refuses to run (fail-closed) — the execution analog of the static checker's meta-guard.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prove } from './prove.mjs';

export function selfCheck() {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-selfcheck-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
    writeFileSync(join(d, 'test/s.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { dbl } from '../src/lib.mjs';\n" +
      "test('planted sound', () => { assert.strictEqual(dbl(3), 6); });\n" +
      "test('planted hollow', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });\n");
    const r = prove(d, { runner: 'node' });
    const flaggedHollow = r.hollow.some((h) => h.name === 'planted hollow');
    const caughtSound = r.caught >= 1;
    const detail = !caughtSound ? 'the planted sound test was not caught when its function was gutted'
      : !flaggedHollow ? 'the planted hollow test was not detected'
      : '';
    return { ok: caughtSound && flaggedHollow, caughtSound, flaggedHollow, detail };
  } catch (e) {
    return { ok: false, caughtSound: false, flaggedHollow: false, detail: String(e && e.message) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
