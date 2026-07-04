import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpus, detect, runEnv } from '../checker/kinds/testShapeGuard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'complete-config.json'), 'utf8'));
const spec = cfg.checker.checks.find((c) => c.id === 'test-shape-guards');

// INTEGRATION BITE: a planted Thread.sleep in a fixture test file is caught; a marked one is not.
test('testShapeGuard catches a planted Thread.sleep and respects the opt-out marker', () => {
  const base = join(here, '.tmp-testshape');
  const tdir = join(base, 'test');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, 'BadTest.kt'), 'class BadTest {\n  fun t() { Thread.sleep(100) }\n}\n');
  writeFileSync(join(tdir, 'OkTest.kt'), 'class OkTest {\n  fun t() { Thread.sleep(100) // TIME-LEAK-OK: warmup\n  }\n}\n');

  const ctx = { harnessDir: join(base, '.claude'), repoRoot: base, testSrcRoots: [tdir] };
  const env = runEnv(spec, cfg, ctx);
  const files = corpus(spec, cfg, ctx);
  const flagged = files.filter((f) => detect(readFileSync(f, 'utf8'), env).length > 0).map((f) => f.split('/').pop());
  rmSync(base, { recursive: true, force: true });

  assert.deepEqual(flagged, ['BadTest.kt'], 'only the unmarked Thread.sleep file should flag');
});
