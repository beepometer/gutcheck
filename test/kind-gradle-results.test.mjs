import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseGradleResults } from '../mutation/prove.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/gradle-results');

test('pass suite → passed=2 failed=0', () => {
  assert.deepEqual(parseGradleResults(join(FX, 'pass')), { passed: 2, failed: 0 });
});
test('assertion failure → failed=1', () => {
  assert.deepEqual(parseGradleResults(join(FX, 'fail')), { passed: 0, failed: 1 });
});
test('error (not failure) also counts as failed', () => {
  assert.deepEqual(parseGradleResults(join(FX, 'errors')), { passed: 0, failed: 1 });
});
test('sums across multiple suite files', () => {
  assert.deepEqual(parseGradleResults(join(FX, 'multi')), { passed: 3, failed: 1 });
});
test('empty dir → 0/0 (→ inconclusive baseline)', () => {
  assert.deepEqual(parseGradleResults(join(FX, 'empty')), { passed: 0, failed: 0 });
});
test('missing dir → 0/0, never throws', () => {
  assert.deepEqual(parseGradleResults(join(FX, 'does-not-exist')), { passed: 0, failed: 0 });
});
