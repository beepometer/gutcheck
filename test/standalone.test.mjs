import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configForProject, findTestFiles, dedupeTestRoots, toPosix } from '../checker/standalone.mjs';
import { runChecker } from '../checker/core.mjs';

function fixture(files) {
  const d = mkdtempSync(join(tmpdir(), 'skstand-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}

test('findTestFiles picks Python + JS/JSX/TSX test files by name/location', () => {
  const fs = ['/a/test_x.py', '/a/x_test.py', '/a/src/x.py', '/b/x.test.js', '/b/src/y.js', '/b/tests/z.js',
    '/b/__tests__/button.tsx', '/b/tests/Comp.jsx', '/b/src/Comp.tsx'];
  assert.deepEqual(findTestFiles(fs, '.py').sort(), ['/a/test_x.py', '/a/x_test.py']);
  assert.deepEqual(findTestFiles(fs, '.js').sort(), ['/b/__tests__/button.tsx', '/b/tests/Comp.jsx', '/b/tests/z.js', '/b/x.test.js']);
});

test('configForProject auto-discovers a Python project and emits the 6-check floor', () => {
  const d = fixture({ 'pyproject.toml': '[project]\nname = "x"\n', 'tests/test_a.py': 'def test_a():\n    assert f() == 3\n' });
  try {
    const { cfg, testFileCount } = configForProject(d);
    assert.ok(cfg); assert.equal(testFileCount, 1);
    assert.deepEqual(cfg.paths.srcRoots.test, ['tests']);
    assert.equal(cfg.checker.checks.length, 6);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('configForProject overrides detect ext with the dominant test-file ext (.ts guess, .js tests)', () => {
  const d = fixture({ 'package.json': '{"name":"x"}', 'tsconfig.json': '{}', 'test/a.test.js': 'x', 'test/b.test.js': 'y' });
  try {
    const { cfg } = configForProject(d);
    assert.equal(cfg.language.fileExt, '.js'); // not .ts, despite tsconfig — tests are .js
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('INTEGRATION: a planted Python shadow + uncited magic go RED through the standalone config', () => {
  const d = fixture({
    'pyproject.toml': '[project]\nname = "x"\n',
    'tests/test_calc.py': 'def _shadow():\n    return 142.50\n\ndef test_t():\n    assert total() == _shadow()\n\ndef test_m():\n    assert rate() == 0.0825\n',
  });
  try {
    const { cfg, testRoots } = configForProject(d);
    const res = runChecker(cfg, { harnessDir: d, repoRoot: d, testSrcRoots: testRoots });
    const checks = (res.offenders || []).map((o) => o.check);
    assert.ok(checks.includes('py-shadow-oracle-guard'), 'planted shadow caught');
    assert.ok(checks.includes('py-magic-literal-guard'), 'uncited magic caught');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("INTEGRATION: a multi-line uncited float assertion is caught at the joined statement's start line (logical-line join)", () => {
  const d = fixture({
    'pyproject.toml': '[project]\nname = "x"\n',
    'tests/test_calc.py': 'def test_m():\n    assert rate(\n        region,\n        year,\n    ) == 0.0825\n',
  });
  try {
    const { cfg, testRoots } = configForProject(d);
    const offs = runChecker(cfg, { harnessDir: d, repoRoot: d, testSrcRoots: testRoots }).offenders || [];
    assert.ok(offs.some((o) => o.check === 'py-magic-literal-guard'), 'multi-line uncited float caught');
    assert.equal(offs.find((o) => o.check === 'py-magic-literal-guard').line, 2, 'reported at the assert statement start line');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a clean project yields zero offenders (derivation-commented float, independent oracle)', () => {
  const d = fixture({
    'pyproject.toml': '[project]\nname = "x"\n',
    'tests/test_ok.py': 'def test_ok():\n    # 3.14159 * 5 * 5 = 78.54\n    assert area(5) == approx(78.54)\n',
  });
  try {
    const { cfg, testRoots } = configForProject(d);
    const res = runChecker(cfg, { harnessDir: d, repoRoot: d, testSrcRoots: testRoots });
    assert.equal(res.phase, 'scan', 'must reach the scan phase (meta-guard passed)');
    assert.ok(res.checkCount > 0, 'the source-discipline floor actually ran');
    assert.equal(res.ok, true, 'clean project must be OK');
    assert.deepEqual(res.offenders.map((o) => `${o.check}:${o.line}`), []); // no `|| []` — offenders must exist
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('findTestFiles discovers Kotlin/Java tests by *Test naming and src/test trees', () => {
  const fs = ['/a/FooTest.kt', '/a/BarTests.kt', '/a/Baz.kt', '/a/src/test/java/Q.kt', '/a/src/main/java/M.kt', '/a/WidgetIT.java'];
  assert.deepEqual(findTestFiles(fs, '.kt').sort(), ['/a/BarTests.kt', '/a/FooTest.kt', '/a/WidgetIT.java', '/a/src/test/java/Q.kt']);
});

test('findTestFiles discovers C++ and C# tests', () => {
  const fs = ['/a/foo_test.cc', '/a/test_bar.cpp', '/a/BazTest.cpp', '/a/main.cpp', '/a/CalcTests.cs', '/a/Helper.cs', '/a/tests/Q.cs'];
  assert.deepEqual(findTestFiles(fs, '.cpp').sort(), ['/a/BazTest.cpp', '/a/foo_test.cc', '/a/test_bar.cpp']);
  assert.deepEqual(findTestFiles(fs, '.cs').sort(), ['/a/CalcTests.cs', '/a/tests/Q.cs']);
});

test('findTestFiles discovers C (.c) tests (ships with C++)', () => {
  assert.deepEqual(findTestFiles(['/a/math_test.c', '/a/util.c', '/a/test/q.c'], '.c').sort(), ['/a/math_test.c', '/a/test/q.c']);
});

// win32 path-identity discipline (Root A): findTestFiles runs against raw walk() paths, which carry the
// native separator (backslash on win32, never normalized). Every dir-boundary clause here is pure regex,
// so the win32 shape is fully expressible and provable on unix (evidence: diagnose run 28703534698,
// boundary A2 — a forward-slash-only dir clause never matched a real backslash-separated path). Each
// fixture file below is named so it can ONLY match via the dir clause (no .test./.spec./_test/Test
// filename convention), so this genuinely exercises separator tolerance, not the filename-suffix path.
test('findTestFiles: dir-boundary clauses accept backslash separators (win32 path shapes, pure regex — unix-runnable)', () => {
  const fs = [
    'C:\\a\\tests\\plain.js', 'C:\\a\\src\\other.js',
    'C:\\a\\tests\\calc.py', 'C:\\a\\src\\util.py',
    'C:\\a\\src\\test\\java\\Q.kt', 'C:\\a\\src\\main\\java\\M.kt',
  ];
  assert.deepEqual(findTestFiles(fs, '.js'), ['C:\\a\\tests\\plain.js']);
  assert.deepEqual(findTestFiles(fs, '.py'), ['C:\\a\\tests\\calc.py']);
  assert.deepEqual(findTestFiles(fs, '.kt'), ['C:\\a\\src\\test\\java\\Q.kt']);
});

// Task 1's report flagged these two configForProject siblings as the SAME class of bug as the
// dir-boundary clauses above, left un-fixed pending routing — Task 3 fixes both.
test('dedupeTestRoots: collapses nested win32 backslash-separated dirs to their top-level parent', () => {
  const dirs = ['C:\\proj\\tests', 'C:\\proj\\tests\\unit', 'C:\\proj\\tests\\e2e', 'C:\\proj\\other'];
  assert.deepEqual(dedupeTestRoots(dirs), ['C:\\proj\\tests', 'C:\\proj\\other'],
    'nested backslash roots collapse via toPosix (a forward-slash-only startsWith would never match these)');
});
test('dedupeTestRoots: already-top-level (forward-slash) dirs pass through unchanged', () => {
  const dirs = ['/a/tests', '/a/src'];
  assert.deepEqual(dedupeTestRoots(dirs), dirs);
});
test('toPosix: backslash separators become forward slashes (relTest normalization — win32 relative() emits backslashes)', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(toPosix('a/b/c'), 'a/b/c');
});
