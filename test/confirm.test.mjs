import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirm, sutFnsIn } from '../mutation/confirm.mjs';

// sutFnsIn is the live part of confirm.mjs — prove.mjs imports it to find the function(s) a test exercises.
test('sutFnsIn extracts SUT calls, not framework/method calls', () => {
  assert.deepEqual(sutFnsIn("equal(compute(5), 25);"), ['equal', 'compute']);
  assert.deepEqual(sutFnsIn("expect(parse(s)).toBe(out); t.is(x, y);"), ['parse']); // expect/toBe/t.is excluded
});

test('confirm: unsupported language returns supported:false (candidates stay advisory)', () => {
  assert.deepEqual(confirm('/nonexistent', { language: { fileExt: '.py' } }, []), { supported: false });
});
