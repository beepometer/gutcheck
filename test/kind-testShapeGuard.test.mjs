import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpus, detect, runEnv } from '../checker/kinds/testShapeGuard.mjs';
import { relPath } from '../checker/corpus.mjs';

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
  // Route the offender basename through the SAME relativization site the real checker pipeline uses
  // (core.mjs's relPath) rather than a raw '/'-only split — on win32 corpus() returns absolute
  // backslash paths, so a bare `.split('/').pop()` would leak the whole absolute path (evidence:
  // diagnose run 28703534698). relPath now toPosix's its output, so this basename extraction is
  // platform-independent.
  const flagged = files.filter((f) => detect(readFileSync(f, 'utf8'), env).length > 0).map((f) => relPath(f, ctx).split('/').pop());
  rmSync(base, { recursive: true, force: true });

  assert.deepEqual(flagged, ['BadTest.kt'], 'only the unmarked Thread.sleep file should flag');
});

// FP repro (2026-08-19 lint audit): the time-leak file exemption recognized only the whole-clock APIs
// (useFakeTimers/MockDate); the equally-standard targeted stub — vi/jest.spyOn(Date, 'now') or
// sinon.stub(Date, 'now') — left a fully deterministic assertion flagged. Pins the SHIPPED floor
// config's exemption list, not a test-local copy.
test("the shipped time-random-leak exemption covers spyOn(Date, 'now') clock stubs", async () => {
  const { readFileSync } = await import('node:fs');
  const floor = JSON.parse(readFileSync(new URL('../configure/gutcheck.default.json', import.meta.url), 'utf8'));
  const rules = JSON.stringify(floor).match(/"id":"time-random-leak"[^}]*}/) ? null : null;
  const findRule = (o) => {
    if (Array.isArray(o)) { for (const v of o) { const r = findRule(v); if (r) return r; } return null; }
    if (o && typeof o === 'object') {
      if (o.id === 'time-random-leak') return o;
      for (const v of Object.values(o)) { const r = findRule(v); if (r) return r; }
    }
    return null;
  };
  const rule = findRule(floor);
  assert.ok(rule, 'the time-random-leak rule exists in the floor config');
  const spied = "vi.spyOn(Date, 'now').mockReturnValue(1700000000000);\nexpect(Date.now()).toBe(1700000000000);\n";
  assert.equal(detect(spied, { rules: [rule], lang: 'typescript' }).length, 0, 'vi.spyOn clock stub exempts the file');
  const jestSpied = spied.replace('vi.spyOn', 'jest.spyOn');
  assert.equal(detect(jestSpied, { rules: [rule], lang: 'typescript' }).length, 0, 'jest.spyOn too');
  const sinonStub = "sinon.stub(Date, 'now').returns(1700000000000);\nexpect(Date.now()).toBe(1700000000000);\n";
  assert.equal(detect(sinonStub, { rules: [rule], lang: 'typescript' }).length, 0, 'sinon.stub too');
  const unstubbed = 'expect(Date.now()).toBe(1700000000000);\n';
  assert.equal(detect(unstubbed, { rules: [rule], lang: 'typescript' }).length, 1, 'an unstubbed clock still flags');
});
