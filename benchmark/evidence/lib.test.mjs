import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTestFile, appendJsonl, readJsonl, sh } from './lib.mjs';

test('isTestFile matches the probe-visible test shapes and rejects the rest', () => {
  for (const f of ['src/a.test.ts', 'x/b.spec.mjs', 'pkg/test_util.py', 'tests/anything.js', '__tests__/c.jsx'])
    assert.equal(isTestFile(f), true, f);
  for (const f of ['src/a.ts', 'types/a.test.d.ts', 'test_helper.rb', 'docs/tests.md'])
    assert.equal(isTestFile(f), false, f);
});

test('appendJsonl/readJsonl round-trip and tolerate a missing file', () => {
  const d = mkdtempSync(join(tmpdir(), 'ev-lib-'));
  const f = join(d, 'sub', 'x.jsonl');
  assert.deepEqual(readJsonl(f), []);
  appendJsonl(f, { a: 1 }); appendJsonl(f, { b: 'two' });
  assert.deepEqual(readJsonl(f), [{ a: 1 }, { b: 'two' }]);
  rmSync(d, { recursive: true, force: true });
});

test('sh runs argv-exec and reports timeouts as status 124', () => {
  assert.equal(sh('node', ['-e', 'process.exit(3)']).status, 3);
  assert.equal(sh('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 500 }).status, 124);
});

test('sh handles large output without truncation (maxBuffer >= 64MB)', () => {
  const r = sh('node', ['-e', "process.stdout.write('x'.repeat(3*1024*1024))"]);
  assert.equal(r.status, 0, 'should exit with status 0');
  assert.equal(r.out.length, 3 * 1024 * 1024, 'output should not be truncated');
});

test('sh: a spawn error (e.g. missing binary) is labeled in err, not silently conflated with a timeout', () => {
  const r = sh('no-such-binary-xyz', []);
  assert.equal(r.status, 124); // spawnSync leaves status null for a spawn failure too
  assert.match(r.err, /ENOENT/);
});

test('readJsonl tolerates a torn trailing line but throws on a torn middle line', () => {
  const d = mkdtempSync(join(tmpdir(), 'ev-torn-'));
  const good = join(d, 'good.jsonl');
  writeFileSync(good, '{"id":"a@1"}\n{"id":"b@2"}\n{"id":"c@3","ga\n');
  assert.deepEqual(readJsonl(good), [{ id: 'a@1' }, { id: 'b@2' }]);
  const bad = join(d, 'bad.jsonl');
  writeFileSync(bad, '{"id":"a@1"}\n{"id":"b@2","ga\n{"id":"c@3"}\n');
  assert.throws(() => readJsonl(bad));
  rmSync(d, { recursive: true, force: true });
});
