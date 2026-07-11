import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prove, RUNNERS, RUNNER_LANGS } from '../mutation/prove.mjs';

// A perfectly sound JUnit test (oracle: 2 + 3 = 5, derived by arithmetic, not by running Calc).
// Under the node runner it cannot execute — the gate must SKIP it fail-closed, never mint a
// false 'already-failing' (baseline 0p/1f) verdict for it.
function javaFixture() {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-mismatch-'));
  mkdirSync(join(d, 'src/main/java/demo'), { recursive: true });
  mkdirSync(join(d, 'src/test/java/demo'), { recursive: true });
  writeFileSync(join(d, 'src/main/java/demo/Calc.java'),
    'package demo;\npublic class Calc {\n  public static int add(int a, int b) { return a + b; }\n}\n');
  writeFileSync(join(d, 'src/test/java/demo/CalcTest.java'),
    'package demo;\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n' +
    'class CalcTest {\n  @Test\n  void addsTwoNumbers() {\n    assertEquals(5, Calc.add(2, 3));\n  }\n}\n');
  return d;
}

test('every runner declares the languages it can execute', () => {
  for (const r of RUNNERS) {
    assert.ok(Array.isArray(RUNNER_LANGS[r]) && RUNNER_LANGS[r].length > 0, `${r} missing from RUNNER_LANGS`);
  }
});

test('a java test under the node runner is skipped fail-closed, never minted already-failing', () => {
  const d = javaFixture();
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.inconclusive.length, 0, `no baseline may run under a mismatched runner: ${JSON.stringify(r.inconclusive)}`);
    assert.equal(r.scored, 0, 'nothing scored');
    assert.ok(r.skipped.some((s) => s.file.includes('CalcTest') && /runner-mismatch/.test(s.why)),
      `expected an explicit runner-mismatch skip: ${JSON.stringify(r.skipped)}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('mismatch-skipped references classify unverifiable, never untested', () => {
  const d = javaFixture();
  try {
    const changed = new Set([resolve(d, 'src/main/java/demo/Calc.java'), resolve(d, 'src/test/java/demo/CalcTest.java')]);
    const r = prove(d, { runner: 'node', changed });
    const add = r.changes.find((c) => c.fn === 'add');
    assert.ok(add, `add must appear in changes: ${JSON.stringify(r.changes)}`);
    assert.equal(add.status, 'unverifiable', `a referenced fn must not read untested: ${JSON.stringify(add)}`);
    assert.match(add.evidence.reason, /runner-mismatch/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The referencing test file itself can be OUT OF SCOPE (untouched by the diff) while the SUT it
// references IS changed — e.g. only Calc.java changed, CalcTest.java is untouched. The runner-mismatch
// gate must still record the block (mirroring the main loop's out-of-scope record-then-drop) so
// classifyChanges sees the reference and reads 'unverifiable', never 'untested' ("no test names it" —
// false; a test does name it, it just can't run under this runner AND wasn't touched).
test('runner-mismatch gate keeps out-of-scope reference evidence: SUT-only diff still reads unverifiable', () => {
  const d = javaFixture();
  try {
    const changed = new Set([resolve(d, 'src/main/java/demo/Calc.java')]);
    const r = prove(d, { runner: 'node', changed });
    const add = r.changes.find((c) => c.fn === 'add');
    assert.ok(add, `add must appear in changes: ${JSON.stringify(r.changes)}`);
    assert.equal(add.status, 'unverifiable', `a real (but out-of-scope) reference must not read untested: ${JSON.stringify(add)}`);
    assert.match(add.evidence.reason, /runner-mismatch/);
    assert.ok(r.outOfScope >= 1, 'the untouched mismatched test file must stay out of scope');
    assert.ok(!r.skipped.some((s) => s.file.includes('CalcTest')),
      `out-of-scope blocks are recorded for classifyChanges, not reported as skipped: ${JSON.stringify(r.skipped)}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
