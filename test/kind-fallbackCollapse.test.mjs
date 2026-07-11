import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, runEnv } from '../checker/kinds/fallbackCollapse.mjs';

const env = runEnv({ params: { lang: 'typescript' } });

// specimen: our own war story — a fallback silently launders an absent field into an empty collection,
// then the test compares to that same empty shape: the assertion can never fail on a missing field.
test('flags the `assert.deepEqual((x || []).map(...), [])` war-story shape', () => {
  const src = "assert.deepEqual((res.offenders || []).map(o => o.check), []);";
  assert.equal(detect(src, env).length, 1);
});

test('flags the `?? {}` toEqual({}) variant (call-derived: the fallback operand is itself a call)', () => {
  assert.equal(detect('expect(getOpts() ?? {}).toEqual({});', env).length, 1);
});

// --- call-derived restriction (corpus audit, docs/plans/2026-07-04-pattern-cycle.md Task 3): the 2
// audited FPs both read a STATIC parsed-JSON field (package.json), not a computed producer output ---
test('does NOT flag a fallback over a STATIC config field with no call anywhere upstream (audit FP shape)', () => {
  const src = 'expect(packageJson.dependencies ?? {}).toEqual({});';
  assert.equal(detect(src, env).length, 0);
});

test('does NOT flag a fallback whose only "call" upstream is a bare import()/require() static-file load', () => {
  const src = 'const packageJson = (\n  await import("../package.json", { with: { type: "json" } })\n).default;\n'
    + 'expect(packageJson.dependencies ?? {}).toEqual({});';
  assert.equal(detect(src, env).length, 0);
});

test('flags via rule (a): the fallback operand itself contains a call (Map#get)', () => {
  assert.equal(detect('expect([...(g.edges.get("postgres") ?? [])]).toEqual([]);', env).length, 1);
});

test('flags via rule (b): the fallback is chained into a method before the outer matcher', () => {
  const src = 'expect((doc.diagnostics ?? []).filter((d) => d.severity === 1)).toEqual([]);';
  assert.equal(detect(src, env).length, 1);
});

test('flags via rule (c): the operand base variable resolves to a call one property-access hop back', () => {
  const src = 'const skill = createDataSphereServerlessSkill();\nconst klass = skill.constructor;\n'
    + 'expect(klass.REQUIRED_ENV_VARS ?? []).toEqual([]);';
  assert.equal(detect(src, env).length, 1);
});

test("flags via rule (c): a call-derived identifier in the wrapping ternary CONDITION counts, not just the fallback's own operand", () => {
  const src = "const isValid = validator(fixture);\nexpect(isValid ? [] : (validator.errors ?? [])).toStrictEqual([]);";
  assert.equal(detect(src, env).length, 1);
});

test('does NOT flag a fallback compared to a NON-EMPTY expected', () => {
  const src = "assert.deepEqual((res.offenders || []).map(o => o.check), ['x']);";
  assert.equal(detect(src, env).length, 0);
});

test('does NOT flag a fallback in a SETUP line, separate from the asserted expression', () => {
  const src = 'const offenders = res.offenders || [];\nassert.deepEqual(offenders.map(o => o.check), []);';
  assert.equal(detect(src, env).length, 0);
});

test('does NOT flag a plain compare-to-empty with no fallback upstream', () => {
  assert.equal(detect('expect(list).toEqual([]);', env).length, 0);
});

// Self-lint regression: the war-story shape appearing INSIDE a quoted string or template literal is
// fixture/specimen TEXT (e.g. this very test file's own examples above), not a live assertion — it must
// never flag. Before blankStrings was wired into detect()'s stripComments call, this check scanned
// through quote/backtick boundaries and flagged its own test suite's fixture strings.
test('does NOT flag the war-story shape when it lives INSIDE a quoted string or template literal (fixture text, not live code)', () => {
  const quoted = 'const src = "assert.deepEqual((res.offenders || []).map(o => o.check), []);";';
  const templated = 'const src = `assert.deepEqual((res.offenders || []).map(o => o.check), []);`;';
  assert.equal(detect(quoted, env).length, 0, 'double-quoted string literal must not flag');
  assert.equal(detect(templated, env).length, 0, 'template literal must not flag');
});
