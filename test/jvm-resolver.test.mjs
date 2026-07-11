// resolveJvmSut (Task 7): maps a pinned candidate function name to the single src/main .kt/.java file
// that declares it, package/import-gated and fail-closed on ambiguity. Oracles below are hand-derived
// from the package-reachability rule in the design brief, never pinned from the resolver's own output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveJvmSut } from '../mutation/prove.mjs';

// mirrors prove.test.mjs's `project()` helper: writes an { relPath: contents } map under a fresh tmpdir.
function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-jvm-resolver-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

// --- (a) same-package: the common case — test imports nothing for the SUT, only shares its package ---

test('same-package: test `package demo` (no SUT import) resolves add() declared in package demo', () => {
  const d = project({
    'src/main/kotlin/Calc.kt': 'package demo\n\nfun add(a: Int, b: Int): Int = a + b\n',
  });
  const testCode = [
    'package demo',
    '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals',
    '',
    'class CalcTest {',
    '    @Test fun testAdd() { assertEquals(5, add(2, 3)) }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/CalcTest.kt');
  assert.equal(resolveJvmSut('add', testCode, absTest, srcFiles, d, 'kotlin'), 'src/main/kotlin/Calc.kt');
});

// --- (b) import-reached: test imports the SUT's class from a different package -----------------------

test('import-reached: test imports com.x.util.Calc; SUT in package com.x.util resolves', () => {
  const d = project({
    'src/main/java/com/x/util/Calc.java': 'package com.x.util;\npublic class Calc {\n  public static int compute(int x) { return x; }\n}\n',
  });
  const testCode = [
    'package other',
    '',
    'import com.x.util.Calc;',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    '',
    'class T {',
    '  @Test void t() { assertEquals(1, Calc.compute(1)); }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/java/com/x/util/Calc.java')];
  const absTest = abs(d, 'src/test/java/other/T.java');
  assert.equal(resolveJvmSut('compute', testCode, absTest, srcFiles, d, 'java'), 'src/main/java/com/x/util/Calc.java');
});

// --- (c) unreachable package: declared, but neither same-package nor imported — must NOT resolve -------
// This is the guard that bounds the receiver-over-capture residual: a stdlib-collision name (`size`) in
// an unimported package must never resolve, or a mutant there would probe the WRONG file (false HOLLOW).

test('unreachable package: SUT declares fn but its package is neither same nor imported -> null', () => {
  const d = project({
    'src/main/kotlin/util/Sizes.kt': 'package com.other.util\n\nfun size(x: List<Int>): Int = x.size\n',
  });
  const testCode = [
    'package demo',
    '',
    'import org.junit.jupiter.api.Test',
    '',
    'class T {',
    '    @Test fun t() { size(listOf(1)) }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/kotlin/util/Sizes.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.equal(resolveJvmSut('size', testCode, absTest, srcFiles, d, 'kotlin'), null);
});

// --- (d) ambiguity: two reachable src/main files both declare the fn -> null, never guess --------------

test('ambiguity: two reachable src/main files both declare the fn -> null', () => {
  const d = project({
    'src/main/kotlin/A.kt': 'package demo\n\nfun calc(x: Int): Int = x\n',
    'src/main/kotlin/B.kt': 'package demo\n\nfun calc(x: Int): Int = x + 1\n',
  });
  const testCode = [
    'package demo',
    '',
    'class T {',
    '    fun t() { assertEquals(1, calc(1)) }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/kotlin/A.kt'), abs(d, 'src/main/kotlin/B.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.equal(resolveJvmSut('calc', testCode, absTest, srcFiles, d, 'kotlin'), null);
});

// --- (e) Java method: declRe matches a method DECLARATION, not a call site ------------------------------

test('java method: declaring class in same package resolves; a mere call site would not match declRe', () => {
  const d = project({
    'src/main/java/demo/JCalc.java': 'package demo;\npublic class JCalc {\n    public static int square(int x) { return x * x; }\n}\n',
  });
  const testCode = [
    'package demo',
    '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals',
    '',
    'class CalcTest {',
    '    @Test fun testSquare() { assertEquals(9, JCalc.square(3)) }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/java/demo/JCalc.java')];
  const absTest = abs(d, 'src/test/kotlin/CalcTest.kt');
  assert.equal(resolveJvmSut('square', testCode, absTest, srcFiles, d, 'kotlin'), 'src/main/java/demo/JCalc.java');
});

// --- (f) not declared anywhere -> null -------------------------------------------------------------------

test('not declared anywhere: no src/main file declares fn -> null', () => {
  const d = project({
    'src/main/kotlin/Calc.kt': 'package demo\n\nfun add(a: Int, b: Int): Int = a + b\n',
  });
  const testCode = [
    'package demo',
    '',
    'class T {',
    '    fun t() { assertEquals(1, missingFn(1)) }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.equal(resolveJvmSut('missingFn', testCode, absTest, srcFiles, d, 'kotlin'), null);
});

// --- (g) default-package poisoning guard: a REAL Java `import static ...Assertions.assertEquals` must
// NOT inject the empty (default) package into the reachable set. Before the fix the import regex matched
// at the keyword `static`, captured "static", popped to '', and '' entered reachable — then a
// default-package (no `package` line) Helper.java declaring the pinned name resolved WRONGLY. A
// `package demo` test can never reach a default-package method, so the correct answer is null.

test('default-package poisoning: `import static ...assertEquals` must not make a default-package Helper.java resolve', () => {
  const d = project({
    'src/main/java/Helper.java': 'public class Helper {\n    public static int helper(int x) { return x; }\n}\n', // NO package line -> default package
  });
  const testCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    '',
    'class T {',
    '  @Test void t() { assertEquals(1, helper(1)); }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/java/Helper.java')];
  const absTest = abs(d, 'src/test/java/T.java');
  assert.equal(resolveJvmSut('helper', testCode, absTest, srcFiles, d, 'java'), null);
});

// --- (h) static-import SUT reach: `import static a.b.C.compute` names member `compute` in class `C`,
// package `a.b` — the reachable package is the captured path minus its last TWO segments (member+class).
// A SUT in package `a.b` declaring `compute` must resolve through it.

test('static-import reach: `import static a.b.C.compute` reaches a SUT in package a.b declaring compute', () => {
  const d = project({
    'src/main/java/a/b/C.java': 'package a.b;\npublic class C {\n    public static int compute(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import static a.b.C.compute;',
    '',
    'class T {',
    '  @Test void t() { assertEquals(2, compute(1)); }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/java/a/b/C.java')];
  const absTest = abs(d, 'src/test/java/T.java');
  assert.equal(resolveJvmSut('compute', testCode, absTest, srcFiles, d, 'java'), 'src/main/java/a/b/C.java');
});

// --- (i) same-file overloads: the SUT must be declared EXACTLY ONCE among reachable files, counting
// DECLARATIONS not files. Two `fun parse(...)` overloads in one file is 1 candidate file but 2 declarers;
// grossBreak would gut only the FIRST overload (guessing which declarer the mutant needs), so a test that
// exercises the SECOND overload passes -> false HOLLOW. Fail closed -> null (ungutable, safe reach-loss).

test('same-file overloads (kotlin): two `fun parse` overloads in one reachable file -> null (ungutable, not hollow)', () => {
  const d = project({
    'src/main/kotlin/Calc.kt': 'package demo\n\nfun parse(s: String): Int = s.length\n\nfun parse(s: String, radix: Int): Int = s.toInt(radix)\n',
  });
  const testCode = [
    'package demo',
    '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals',
    '',
    'class T {',
    '    @Test fun t() { assertEquals(255, parse("ff", 16)) }',  // pins the SECOND overload
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.equal(resolveJvmSut('parse', testCode, absTest, srcFiles, d, 'kotlin'), null);
});

test('same-file overloads (java): two `parse` method overloads in one class -> null', () => {
  const d = project({
    'src/main/java/demo/P.java': 'package demo;\npublic class P {\n    public static int parse(String s) { return s.length(); }\n    public static int parse(String s, int radix) { return Integer.parseInt(s, radix); }\n}\n',
  });
  const testCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    '',
    'class T {',
    '  @Test void t() { assertEquals(255, P.parse("ff", 16)); }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/java/demo/P.java')];
  const absTest = abs(d, 'src/test/java/T.java');
  assert.equal(resolveJvmSut('parse', testCode, absTest, srcFiles, d, 'java'), null);
});

// guard against OVER-failing: a single (non-overloaded) declaration must STILL resolve.

test('single declaration (kotlin): a non-overloaded `fun parse` still resolves (overload guard must not over-fail)', () => {
  const d = project({
    'src/main/kotlin/Calc.kt': 'package demo\n\nfun parse(s: String): Int = s.length\n',
  });
  const testCode = [
    'package demo',
    '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals',
    '',
    'class T {',
    '    @Test fun t() { assertEquals(2, parse("hi")) }',
    '}',
    '',
  ].join('\n');
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.equal(resolveJvmSut('parse', testCode, absTest, srcFiles, d, 'kotlin'), 'src/main/kotlin/Calc.kt');
});

// --- vendored-fixture consistency: the real test/fixtures/jvm-project tree (jvm-e2e.test.mjs's fixture)
// is the SAME-PACKAGE shape this resolver depends on — CalcTest.kt `package demo` imports only JUnit, and
// both Calc.kt (Kotlin, add/greet/isPositive/firstTwo) and JCalc.java (Java, square) sit in `package demo`
// with no import. Read directly (not copied) so a regression in the actual fixture would show up here too.

test('vendored fixture: CalcTest.kt (package demo, no SUT import) resolves add/greet/square across kt+java', () => {
  const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/jvm-project');
  const testCode = readFileSync(join(FIX, 'src/test/kotlin/CalcTest.kt'), 'utf8');
  const kt = join(FIX, 'src/main/kotlin/Calc.kt');
  const java = join(FIX, 'src/main/java/demo/JCalc.java');
  const srcFiles = [kt, java];
  const absTest = join(FIX, 'src/test/kotlin/CalcTest.kt');
  assert.equal(resolveJvmSut('add', testCode, absTest, srcFiles, FIX, 'kotlin'), 'src/main/kotlin/Calc.kt');
  assert.equal(resolveJvmSut('greet', testCode, absTest, srcFiles, FIX, 'kotlin'), 'src/main/kotlin/Calc.kt');
  assert.equal(resolveJvmSut('square', testCode, absTest, srcFiles, FIX, 'kotlin'), 'src/main/java/demo/JCalc.java');
});
