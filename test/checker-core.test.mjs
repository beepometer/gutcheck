import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  assert.equal(checks.length, 6, 'the default out-of-box floor must carry exactly 6 source-discipline checks');
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
  assert.equal(res.checkCount, 6);
  assert.equal(res.offenders.length, 0);
});

// --- Task 2 (pattern-cycle): node:assert dialect extension for derivationCoherence (R3 evaluator find) ---
test('js-derivation-coherence flags a derivation-comment mismatch through the node:assert dialect (assert.strictEqual), not just expect().toBe()', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  const spec = cfg.checker.checks.find((c) => c.id === 'js-derivation-coherence');
  assert.ok(spec, 'js-derivation-coherence must be wired in the default config');
  // Their scenario: a derivation comment disagreeing with an assert-dialect (node:assert) assertion —
  // the comment computes 78.54 but the assertion expects 80.0.
  const mismatch = 'assert.strictEqual(area(5), 80.0); // 3.14159 * 5 * 5 = 78.54';
  assert.equal(detectText(spec, cfg, mismatch).length, 1, 'a node:assert.strictEqual derivation mismatch must flag');
  const agree = 'assert.strictEqual(area(5), 78.54); // 3.14159 * 5 * 5 = 78.54';
  assert.equal(detectText(spec, cfg, agree).length, 0, 'a node:assert.strictEqual derivation that agrees must NOT flag');
});

// FP hunt (review of 653c479): the assert-dialect actual side must be parsed with call-aware operand
// bounds, never comma-skipped — a comma INSIDE the actual expression's own call (`roundTo(x, 2)`) must
// not shift which argument is read as the expected value.
test('js-derivation-coherence node:assert dialect: a comma inside the ACTUAL call must not misread the expected arg (no false mismatch on agreeing assertions)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  const spec = cfg.checker.checks.find((c) => c.id === 'js-derivation-coherence');
  for (const agree of [
    'assert.strictEqual(roundTo(x, 2), 78.54); // 3.14159 * 5 * 5 = 78.54',
    'assert.strictEqual(clamp(raw, 0, 100), 78.54); // 3.14159 * 5 * 5 = 78.54',
    'assert.equal(foo(1, 2), 78.54); // 3.14159 * 5 * 5 = 78.54',
  ]) assert.equal(detectText(spec, cfg, agree).length, 0, `agreeing multi-arg actual wrongly flagged: ${agree}`);
  // the R3 mismatch scenario must STILL flag, including with a trailing message arg
  assert.equal(detectText(spec, cfg, 'assert.strictEqual(area(5), 80.0); // 3.14159 * 5 * 5 = 78.54').length, 1,
    'the R3 planted mismatch must still flag');
  assert.equal(detectText(spec, cfg, "assert.strictEqual(area(5), 80.0, 'area drifted'); // 3.14159 * 5 * 5 = 78.54").length, 1,
    'the message-arg variant must still flag');
  assert.equal(detectText(spec, cfg, 'assert.strictEqual(roundTo(x, 2), 80.0); // 3.14159 * 5 * 5 = 78.54').length, 1,
    'a multi-arg actual with a genuinely mismatched expected must still flag');
});

// --- selfComparisonOracle: pulled from the adopter-facing floor (CYCLE-10 measured: high base rate,
// ~zero defect yield — the mutation probe owns the harmful subset instead). The kind MODULE stays
// (checker/kinds/index.mjs); it is no longer registered in configure/gutcheck.default.json, so the only
// way left to prove it still works is an EXPLICIT injected config — not the shipped floor. ---
test('selfComparisonOracle is NOT in the shipped default config, but is reachable via an explicit checker config (kind module still live)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
  assert.ok(!buildChecks(cfg).some((c) => c.kind === 'selfComparisonOracle'), 'selfComparisonOracle must NOT be registered in the shipped default config');

  const explicit = {
    language: { fileExt: '.ts' },
    paths: { srcRoots: { test: ['test'] } },
    checker: {
      checks: [{
        id: 'js-self-comparison-oracle',
        kind: 'selfComparisonOracle',
        description: 'explicit-config probe — not part of the shipped floor',
        params: {
          lang: 'typescript',
          assertionSrcs: [
            "expect\\(\\s*([A-Za-z_$][\\w$.]*\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*\\)\\.toBe\\(\\s*([A-Za-z_$][\\w$.]*\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*\\)",
          ],
        },
        selfTest: {
          mustFlag: ['expect(dedupSlug(email)).toBe(dedupSlug(email));'],
          mustNotFlag: ['expect(dedupSlug(email)).toBe(otherFn(email));'],
        },
      }],
    },
  };
  const checks = buildChecks(explicit);
  assert.equal(checks.length, 1, 'the kind must build from an explicitly injected config entry');
  assert.deepEqual(runMetaGuard(checks), [], 'the explicitly-configured check must self-validate its planted fixtures');

  const d = mkdtempSync(join(tmpdir(), 'gutcheck-selfcomp-explicit-'));
  try {
    mkdirSync(join(d, 'test'), { recursive: true });
    writeFileSync(join(d, 'test', 'a.test.ts'), "expect(dedupSlug(email)).toBe(dedupSlug(email));\n");
    const res = runChecker(explicit, { harnessDir: d, repoRoot: d, testSrcRoots: [join(d, 'test')] });
    assert.equal(res.phase, 'scan');
    assert.deepEqual(res.offenders.map((o) => o.kind), ['selfComparisonOracle'], 'the planted specimen must surface through runChecker via the explicit config');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
