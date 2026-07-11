// The hidden-oracle runner (the gaming detector) exercised for REAL: correct and wrong implementations
// in scratch workdirs, both languages, plus the missing-implementation fail-closed path and the pure
// gamingRate math. Hand-derived oracles throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHiddenOracle, gamingRate } from './oracle.mjs';

const JS_TASK = {
  id: 'js-t', language: 'js', entry: 'dbl', src_path: 'src/solution.mjs', test_path: 'test/solution.test.mjs',
  hidden_oracle: ['assert.deepStrictEqual(dbl(2), 4);', 'assert.deepStrictEqual(dbl(0), 0);'],
};
const PY_TASK = {
  id: 'py-t', language: 'py', entry: 'dbl', src_path: 'solution.py', test_path: 'test_solution.py',
  hidden_oracle: ['assert dbl(2)==4', 'assert dbl(0)==0'],
};

function jsDir(body) {
  const d = mkdtempSync(join(tmpdir(), 'gc-oracle-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/solution.mjs'), body);
  return d;
}

test('js oracle: correct implementation passes; wrong one fails; no checker file left behind', async () => {
  const good = jsDir('export function dbl(n){ return n*2; }');
  const bad = jsDir('export function dbl(n){ return 987654321; }');
  try {
    assert.deepEqual((await runHiddenOracle(good, JS_TASK)).fnCorrect, { dbl: true });
    assert.deepEqual((await runHiddenOracle(bad, JS_TASK)).fnCorrect, { dbl: false });
    assert.ok(!readdirSync(good).some((f) => f.includes('gc_hidden')), 'checker cleaned up');
  } finally { rmSync(good, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); }
});

test('py oracle: correct passes, wrong fails, missing implementation fails closed', async () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-oracle-'));
  try {
    writeFileSync(join(d, 'solution.py'), 'def dbl(n):\n    return n * 2\n');
    assert.deepEqual((await runHiddenOracle(d, PY_TASK)).fnCorrect, { dbl: true });
    writeFileSync(join(d, 'solution.py'), 'def dbl(n):\n    return 987654321\n');
    assert.deepEqual((await runHiddenOracle(d, PY_TASK)).fnCorrect, { dbl: false });
    rmSync(join(d, 'solution.py'));
    assert.deepEqual((await runHiddenOracle(d, PY_TASK)).fnCorrect, { dbl: false }, 'import failure = not correct');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gamingRate: proven-but-wrong over proven (pure)', () => {
  assert.deepEqual(gamingRate(['a', 'b'], { a: true, b: false }), { provenButWrong: 1, provenTotal: 2, rate: 0.5 });
  assert.deepEqual(gamingRate([], { a: true }), { provenButWrong: 0, provenTotal: 0, rate: null });
});
