import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMetaGuard, buildChecks, detectText, runChecker } from '../checker/core.mjs';

// Unit-test the meta-guard MECHANISM with inline fixture checks (independent of config).
const good = {
  id: 'fx',
  detect: (t) => (t.includes('BAD') ? [{ line: 1 }] : []),
  selfTest: { env: {}, mustFlag: ['BAD'], mustNotFlag: ['ok'] },
};

test('meta-guard passes a check whose detector satisfies its self-test', () => {
  assert.deepEqual(runMetaGuard([good]), []);
});
test('meta-guard BITES a check with no self-test', () => {
  assert.ok(runMetaGuard([{ id: 'x', detect: () => [] }]).some((f) => f.includes('missing non-empty')));
});
test('meta-guard BITES a detector that misses its own must-flag', () => {
  assert.ok(runMetaGuard([{ ...good, detect: () => [] }]).some((f) => f.includes('must-flag NOT flagged')));
});
test('meta-guard BITES a detector that flags its own must-not-flag', () => {
  assert.ok(runMetaGuard([{ ...good, detect: () => [{ line: 1 }] }]).some((f) => f.includes('must-not-flag WAS flagged')));
});

// --- the keystone catches a real shipped kind through the buildChecks path (forbiddenPattern) ---
test('keystone catches a check with no self-test fixtures (via buildChecks)', () => {
  const cfg = { checker: { checks: [{
    id: 'fp-no-fixtures', kind: 'forbiddenPattern',
    description: 'fixture-less entry',
    params: { patternSrc: 'NEVER', exemptSrc: null },
    selfTest: { mustFlag: [], mustNotFlag: ['clean'] },
  }] } };
  const failures = runMetaGuard(buildChecks(cfg));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /fp-no-fixtures: missing non-empty must-flag/);
});

test('keystone catches a check whose must-flag does not flag (via buildChecks)', () => {
  const cfg = { checker: { checks: [{
    id: 'fp-bad-fixture', kind: 'forbiddenPattern',
    description: 'entry whose must-flag does not contain the forbidden pattern',
    params: { patternSrc: 'NEVER', exemptSrc: null },
    selfTest: { mustFlag: ['clean'], mustNotFlag: ['also clean'] },
  }] } };
  const failures = runMetaGuard(buildChecks(cfg));
  assert.ok(failures.some((f) => /fp-bad-fixture: must-flag NOT flagged/.test(f)));
});

// --- runtime gate: a runtime-tagged check with NO platform.runtime declared must FAIL LOUD ---
test('runtime gate BITES: a runtime-tagged check with platform.runtime UNSET fails loud (no silent green)', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const check = buildChecks({ checker: { checks: [{
    id: 'rt-unset', kind: 'forbiddenPattern', runtime: 'claude-code',
    description: 'runtime-gated check, but the config declares no platform.runtime',
    params: { patternSrc: 'NEVER', exemptSrc: null },
    selfTest: { mustFlag: ['NEVER'], mustNotFlag: ['clean'] },
  }] } })[0]; // NOTE: no `platform` block in the config
  const offenders = check.run({ harnessDir: repoRoot, repoRoot });
  assert.ok(offenders.some((o) => /platform\.runtime is unset/.test(o.token || '')), 'an unset platform.runtime under a runtime-gated check must fail loud');
});

test('Phase 2a: the shipped default config testShapeGuard rules self-validate (meta-guard clean)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  const checks = buildChecks(cfg).filter((c) => c.id === 'js-test-shape-guards');
  assert.equal(checks.length, 1, 'js-test-shape-guards check must be wired in the default config');
  assert.deepEqual(runMetaGuard(checks), [], 'the rules must flag every must-flag fixture and no must-not-flag fixture');
});

test('Phase 2a: the shipped default config magicLiteralGuard self-validates (meta-guard clean)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  const checks = buildChecks(cfg).filter((c) => c.id === 'magic-literal-guard');
  assert.equal(checks.length, 1);
  assert.deepEqual(runMetaGuard(checks), []);
});

test('detectText runs a text-shape kind detector against an in-memory string', () => {
  const spec = { id: 'm', kind: 'magicLiteralGuard', params: {} };
  assert.equal(detectText(spec, {}, 'expect(x).toBeCloseTo(3.14159, 5)').length, 1);
  assert.equal(detectText(spec, {}, 'expect(x).toBeCloseTo(3.14159, 5) // CLOSED-FORM-ORACLE: pi').length, 0);
});

test('Phase 2b: the shipped default config external-citation-needs-url self-validates (meta-guard clean)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  const checks = buildChecks(cfg).filter((c) => c.id === 'external-citation-needs-url');
  assert.equal(checks.length, 1, 'external-citation-needs-url check must be wired in the default config');
  assert.deepEqual(runMetaGuard(checks), [], 'the citation guard must flag every must-flag fixture and no must-not-flag fixture');
});

test('the shipped default config self-validates end-to-end (meta-guard clean over the source-discipline floor)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  const checks = buildChecks(cfg);
  assert.equal(checks.length, 5, 'the default out-of-box floor must carry exactly 5 source-discipline checks');
  assert.deepEqual(runMetaGuard(checks), [], 'every default-config check must satisfy its own self-test');
});

test("default config runs end-to-end through runChecker (wiring; corpus is empty by construction here)", () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  // The default config's language.fileExt is '.ts', but this repo's own tests/sources are .mjs —
  // so the corpus scanned here is empty by construction. Zero offenders is therefore guaranteed
  // vacuously; it is NOT proof the shipped prose self-hosts or scans clean. What this DOES assert
  // is that the pipeline completes: the meta-guard passes and the scan phase is reached.
  const res = runChecker(cfg, {
    harnessDir: ROOT,
    repoRoot: ROOT,
    testSrcRoots: [],
  });
  assert.equal(res.phase, 'scan', 'must reach the scan phase (meta-guard did not crash it)');
  assert.equal(res.ok, true, 'end-to-end run must complete ok: ' + JSON.stringify(res.offenders));
  assert.equal(res.checkCount, 5);
  assert.equal(res.offenders.length, 0);
});
