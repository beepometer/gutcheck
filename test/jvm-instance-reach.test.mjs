// jvmInstanceSuts (jvm-instance-reach): resolves a lowercase-receiver instance-method call
// (`analyzer.computeRt60(x)`) that sutFnsIn (confirm.mjs) never captures — safely, by inferring the
// receiver's RUNTIME type (the CONSTRUCTOR call's type), never its declared/annotated static type. The
// cardinal invariant is ZERO false positives: a wrong receiver-type inference guts a method that virtual
// dispatch never runs → a sound test survives → a false HOLLOW.
//
// The redesign resolves from the constructor because dispatch goes to the runtime type: for
// `val a: Base = Derived()`, `a.compute()` runs `Derived.compute`, NOT `Base.compute`. Oracles below are
// hand-derived from that invariant — never pinned from the resolver's own output. Mirrors
// test/jvm-resolver.test.mjs's project()/abs() helper conventions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jvmInstanceSuts } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-jvm-instance-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

// =========================================================================================
// Happy paths — a directly-visible constructor gives the runtime type.
// =========================================================================================

test('happy path: `val m = Meter(); assertEquals(42, m.reading(21))` resolves reading() in Meter.kt', () => {
  const d = project({
    'src/main/kotlin/Meter.kt': 'package demo\n\nclass Meter {\n    fun reading(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class MeterTest {',
    '    @Test fun t() {',
    '        val m = Meter()',
    '        assertEquals(42, m.reading(21))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val m = Meter()\n        assertEquals(42, m.reading(21))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Meter.kt')];
  const absTest = abs(d, 'src/test/kotlin/MeterTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'reading', sutRel: 'src/main/kotlin/Meter.kt' }],
  );
});

test('two classes, same method name: `a.compute()` resolves to Foo (a\'s constructor), never Bar', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo()',
    '        val b = Bar()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo()\n        val b = Bar()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'compute', sutRel: 'src/main/kotlin/Foo.kt' }],
  );
});

test('class-field + @BeforeEach: receiver is a lateinit field constructed in @BeforeEach still resolves', () => {
  const d = project({
    'src/main/kotlin/Analyzer.kt': 'package demo\n\nclass Analyzer {\n    fun computeRt60(x: Int): Int = x\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.BeforeEach',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class AnalyzerTest {',
    '    private lateinit var analyzer: Analyzer',
    '    @BeforeEach fun setup() { analyzer = Analyzer() }',
    '    @Test fun t() {',
    '        assertEquals(21, analyzer.computeRt60(21))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(21, analyzer.computeRt60(21))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Analyzer.kt')];
  const absTest = abs(d, 'src/test/kotlin/AnalyzerTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'computeRt60', sutRel: 'src/main/kotlin/Analyzer.kt' }],
  );
});

test('same-type reassignment: `var a = Foo(); a = Foo()` (one distinct constructor) still resolves', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        var a = Foo()',
    '        a = Foo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        var a = Foo()\n        a = Foo()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'compute', sutRel: 'src/main/kotlin/Foo.kt' }],
  );
});

// =========================================================================================
// VIRTUAL-DISPATCH cases — the three verified breaking inputs from the adversarial review. Each was a
// false HOLLOW under annotation-based inference; each must now resolve the RUNTIME (constructor) type.
// =========================================================================================

// #1: `val a: Base = Derived()` — annotation Base, constructor Derived, Derived overrides compute (and
// has a nested-paren default-arg constructor). Runtime dispatch runs Derived.compute → resolve Derived,
// NOT Base. (Old behavior inferred Base → gutted Base.compute (never dispatched) → false HOLLOW.)
test('VERIFIED #1: `val a: Base = Derived()` resolves Derived.compute (runtime type), never Base', () => {
  const d = project({
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    open fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Dep.kt': 'package demo\n\nclass Dep\n',
    'src/main/kotlin/Derived.kt': 'package demo\n\nclass Derived(val dep: Dep = Dep()) : Base() {\n    override fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a: Base = Derived()',
    '        assertEquals(2, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a: Base = Derived()\n        assertEquals(2, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Base.kt'), abs(d, 'src/main/kotlin/Dep.kt'), abs(d, 'src/main/kotlin/Derived.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'compute', sutRel: 'src/main/kotlin/Derived.kt' }],
  );
});

// #2a (Kotlin transitive): `val a: Base = Leaf()`, Leaf : Mid : Base, Leaf overrides compute. Runtime
// type is Leaf → resolve Leaf.compute, never Base.
test('VERIFIED #2a (kotlin transitive): `val a: Base = Leaf()` resolves Leaf.compute', () => {
  const d = project({
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    open fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Mid.kt': 'package demo\n\nopen class Mid : Base()\n',
    'src/main/kotlin/Leaf.kt': 'package demo\n\nclass Leaf : Mid() {\n    override fun compute(): Int = 3\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a: Base = Leaf()',
    '        assertEquals(3, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a: Base = Leaf()\n        assertEquals(3, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Base.kt'), abs(d, 'src/main/kotlin/Mid.kt'), abs(d, 'src/main/kotlin/Leaf.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'compute', sutRel: 'src/main/kotlin/Leaf.kt' }],
  );
});

// #2b (Java transitive, `new`): `Base b = new Leaf()`, Leaf extends Mid extends Base, Leaf overrides
// compute → resolve Leaf.compute (the constructed runtime type), never the declared Base.
test('VERIFIED #2b (java transitive): `Base b = new Leaf()` resolves Leaf.compute', () => {
  const d = project({
    'src/main/java/demo/Base.java': 'package demo;\npublic class Base {\n    public int compute() { return 1; }\n}\n',
    'src/main/java/demo/Mid.java': 'package demo;\npublic class Mid extends Base { }\n',
    'src/main/java/demo/Leaf.java': 'package demo;\npublic class Leaf extends Mid {\n    @Override public int compute() { return 3; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  @Test void t() {',
    '    Base b = new Leaf();',
    '    assertEquals(3, b.compute());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Base b = new Leaf();\n    assertEquals(3, b.compute());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Base.java'), abs(d, 'src/main/java/demo/Mid.java'), abs(d, 'src/main/java/demo/Leaf.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'),
    [{ fn: 'compute', sutRel: 'src/main/java/demo/Leaf.java' }],
  );
});

// Java `Animal a = new Dog()` where Dog overrides speak → resolve Dog (the constructed type), never the
// declared Animal. (Old behavior refused on the declared≠constructed "mismatch"; the runtime type is Dog.)
test('java new form: `Animal a = new Dog()` (Dog overrides speak) resolves Dog.speak', () => {
  const d = project({
    'src/main/java/demo/Animal.java': 'package demo;\npublic class Animal {\n    public String speak() { return "..."; }\n}\n',
    'src/main/java/demo/Dog.java': 'package demo;\npublic class Dog extends Animal {\n    @Override public String speak() { return "woof"; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  @Test void t() {',
    '    Animal a = new Dog();',
    '    assertEquals("woof", a.speak());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Animal a = new Dog();\n    assertEquals("woof", a.speak());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Animal.java'), abs(d, 'src/main/java/demo/Dog.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'),
    [{ fn: 'speak', sutRel: 'src/main/java/demo/Dog.java' }],
  );
});

// =========================================================================================
// Residual false-HOLLOW guards (zero-FP hardening before the wild-repo experiment).
// =========================================================================================

// Residual 1: a Kotlin capitalized TOP-LEVEL FACTORY function `fun Foo(): Bar = Bar()` colliding with a
// same-named `class Foo`. `Foo()` in the test is the factory (runtime type Bar), not the Foo constructor,
// but the callee is textually identical. Since a same-named `fun Foo(` exists in a reachable src file,
// `Foo()` is constructor-vs-factory AMBIGUOUS → REFUSE. (Annotated variant `val a: Bar = Foo()`.)
test('residual 1 (annotated): capitalized factory `fun Foo(): Bar` vs `class Foo` -> refuse (ctor/factory ambiguous)', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nfun Foo(): Bar = Bar()\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a: Bar = Foo()',
    '        assertEquals(2, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a: Bar = Foo()\n        assertEquals(2, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// same collision, UNANNOTATED (`val a = Foo()`) — the runtime type is still Bar (the factory return), so
// the same ambiguity holds → refuse.
test('residual 1 (unannotated): `val a = Foo()` with a same-named factory `fun Foo(` -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nfun Foo(): Bar = Bar()\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo()',
    '        assertEquals(2, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo()\n        assertEquals(2, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// Residual 1 must NOT over-refuse: `val a = Foo()` where NO same-named `fun Foo(` exists still resolves.
test('residual 1 guard does not over-refuse: `val a = Foo()` with NO same-named factory still resolves', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'compute', sutRel: 'src/main/kotlin/Foo.kt' }],
  );
});

// Residual 2: a Java ANONYMOUS SUBCLASS `new Animal() { @Override … }`. The runtime type is the anon
// subclass overriding sound(); resolving Animal would gut Animal.sound (never dispatched) → false HOLLOW.
// The `new X(...)` is immediately followed by `{` (an anon-class body) → REFUSE.
test('residual 2: java anonymous subclass `new Animal() { override sound }` -> refuse', () => {
  const d = project({
    'src/main/java/demo/Animal.java': 'package demo;\npublic class Animal {\n    public String sound() { return "..."; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  @Test void t() {',
    '    Animal a = new Animal() { @Override public String sound() { return "x"; } };',
    '    assertEquals("x", a.sound());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Animal a = new Animal() { @Override public String sound() { return "x"; } };\n    assertEquals("x", a.sound());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Animal.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

// Residual 2 must NOT over-refuse: a plain `new Foo()` (no `{` anon body) still resolves.
test('residual 2 guard does not over-refuse: plain `new Foo()` (no anon body) still resolves', () => {
  const d = project({
    'src/main/java/demo/Foo.java': 'package demo;\npublic class Foo {\n    public int compute() { return 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  @Test void t() {',
    '    Foo a = new Foo();',
    '    assertEquals(1, a.compute());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Foo a = new Foo();\n    assertEquals(1, a.compute());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Foo.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'),
    [{ fn: 'compute', sutRel: 'src/main/java/demo/Foo.java' }],
  );
});

// =========================================================================================
// Fail-closed cases — each must return [] (a miss, never a wrong resolution).
// =========================================================================================

// #3 (chain): `val a = Foo().let { Bar() }` — a is really Bar. The chain may transform the type, so
// REFUSE. (Old behavior grabbed Foo → false HOLLOW.)
test('VERIFIED #3 (chain): `val a = Foo().let { Bar() }` refuses (chained construction, type transformed)', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun m(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun m(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo().let { Bar() }',
    '        assertEquals(2, a.m())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo().let { Bar() }\n        assertEquals(2, a.m())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// Inherited method — `val a: Base = Derived()` but Derived does NOT override compute (inherits it). The
// runtime class is Derived, but its own file declares no compute → REFUSE (we only safely gut a body the
// constructed class itself declares/overrides; gutting Base's would be a virtual-dispatch guess).
test('inherited method: `val a: Base = Derived()` where Derived does not override compute -> refuse', () => {
  const d = project({
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    open fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Derived.kt': 'package demo\n\nclass Derived : Base()\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a: Base = Derived()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a: Base = Derived()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Base.kt'), abs(d, 'src/main/kotlin/Derived.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('overload guard: the constructed class declares compute() twice -> refuse (ungutable, not hollow)', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n    fun compute(x: Int): Int = x\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('factory return: `val a = makeFoo()` -> runtime type unknowable -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n\nfun makeFoo(): Foo = Foo()\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = makeFoo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = makeFoo()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('java factory RHS: `Foo a = makeFoo()` (declared type, NO `new`) -> refuse (runtime type unknowable)', () => {
  const d = project({
    'src/main/java/demo/Foo.java': 'package demo;\npublic class Foo {\n    public int compute() { return 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  static Foo makeFoo() { return new Foo(); }',
    '  @Test void t() {',
    '    Foo a = makeFoo();',
    '    assertEquals(1, a.compute());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Foo a = makeFoo();\n    assertEquals(1, a.compute());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Foo.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('annotation-only (no direct constructor): `val a: Foo = provided()` -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    private val a: Foo = provided()',   // an annotation + factory RHS, no direct constructor
    '    fun t() {',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('reassignment to distinct constructor types: `var a = Foo(); a = Bar()` -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        var a = Foo()',
    '        a = Bar()',
    '        assertEquals(2, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        var a = Foo()\n        a = Bar()\n        assertEquals(2, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('bare untyped reassignment: `var a = Foo(); a = someHelper()` -> refuse (an untypeable later assignment)', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        var a = Foo()',
    '        a = someHelper()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        var a = Foo()\n        a = someHelper()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('stdlib receiver: `val list = listOf(1,2,3); list.size()` -> refuse (listOf is a factory, not a ctor)', () => {
  const d = project({
    'src/main/kotlin/Sizes.kt': 'package demo\n\nfun size(): Int = 0\n', // decoy: a reachable bare fn of the same name
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val list = listOf(1, 2, 3)',
    '        assertEquals(3, list.size())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val list = listOf(1, 2, 3)\n        assertEquals(3, list.size())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Sizes.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('unreachable package: `val a = Foo()` but Foo is declared in an unimported package -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package com.other\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('method not declared in the constructed class: `val a = Foo()` but Foo has only other() -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun other(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val a = Foo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Foo()\n        assertEquals(1, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// contrived declarations (`val it = Foo()` / `val this = Foo()`) are not valid Kotlin, but this proves
// the exclusion is a real, explicit skip -- not an accident of type-inference failure: if it/this were
// NOT excluded, the (nonsensical but textually-present) declarations below would make them resolve.
test('this./it. receivers are skipped outright, even when a same-named ctor would otherwise resolve', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val it = Foo()',
    '        val this = Foo()', // not valid Kotlin -- purely textual, to prove the skip is explicit
    '        listOf(1).forEach { assertEquals(1, it.compute()) }',
    '        assertEquals(1, this.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        listOf(1).forEach { assertEquals(1, it.compute()) }\n        assertEquals(1, this.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// shadowing: a sibling test's own `val a = Bar()` elsewhere in the FULL file makes THIS block's `a`
// ambiguous (two distinct constructor types across the file) -> refuse. Accepted recall loss from
// scanning the whole file (needed to reach class-field/@BeforeEach construction).
test('shadowing: a sibling test\'s `val a = Bar()` elsewhere makes THIS block\'s `a` ambiguous -> refuse', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    @Test fun testOne() {',
    '        val a = Foo()',
    '        assertEquals(1, a.compute())',
    '    }',
    '    @Test fun testTwo() {',
    '        val a = Bar()',
    '        assertEquals(2, a.compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val a = Bar()\n        assertEquals(2, a.compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// =========================================================================================
// Gating — inert unless lang is kotlin/java (the JS/TS/Python byte-identity guarantee).
// =========================================================================================

test('gating: lang other than kotlin/java (undefined/js) -> always [] regardless of content', () => {
  const d = project({
    'src/main/kotlin/Meter.kt': 'package demo\n\nclass Meter {\n    fun reading(x: Int): Int = x + 1\n}\n',
  });
  const testCode = 'const m = new Meter(); assertEquals(42, m.reading(21));';
  const body = testCode;
  const srcFiles = [abs(d, 'src/main/kotlin/Meter.kt')];
  const absTest = abs(d, 'src/test/js/meter.test.js');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, undefined), []);
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'js'), []);
});

// =========================================================================================
// Inheritance-root false-HOLLOW gap (docs/plans/2026-07-08-jvm-inheritance-gap.md) — closed invariant.
//
// methodDeclCountInFile is a FILE-WIDE regex count with no class-body containment, no nesting-depth
// check, no member-kind check. When Service's declared method is actually INHERITED from Base (another
// file) while Service's own file happens to contain exactly one OTHER same-named declaration (sibling
// class, nested class, companion object, top-level fun, extension fun, java static, interface default,
// …), credit-time counts 1 -> credits; gut-time guts that wrong declaration; the pinned call still
// dispatches to the untouched inherited Base method -> a SOUND test survives the mutant -> false HOLLOW.
//
// Every RED below returns the WRONGLY-CREDITED pair {fn:'decrypt', sutRel:'.../Service.(kt|java)'} on
// unpatched HEAD and must return [] once jvmOwnPlainInstanceMember (containment + depth + member-kind +
// one-hop supertype guard) replaces the bare methodDeclCountInFile check. Oracles are the dispatch
// ground truth in the plan's §2 — hand-derived from real JVM dispatch rules, never pinned from the
// resolver's own output.
// =========================================================================================

// ---- Kotlin REDs ----

test('K1 inherited+sibling: sibling class LegacyCodec.decrypt is not Service\'s own member -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n}\n\nclass LegacyCodec {\n    fun decrypt(x: Int): Int = x - 1\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K2 companion: companion-object decrypt is not instance-callable -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    companion object {\n        fun decrypt(x: Int): Int = 99\n    }\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K3 @JvmStatic companion: the annotation changes bytecode shape, not Kotlin dispatch -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    companion object {\n        @JvmStatic fun decrypt(x: Int): Int = 99\n    }\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K4 top-level fun + bodyless class: `service.decrypt()` can never reach a top-level fun -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base()\n\nfun decrypt(x: Int): Int = 5\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K5 nested class: Parser.decrypt is not reachable via `service.` -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    class Parser {\n        fun decrypt(x: Int): Int = x - 1\n    }\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K6 extension: member-always-wins-over-extension, so an inherited member shadows the extension -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n}\n\nfun Service.decrypt(x: Int): Int = 7\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K9 object+invoke: `Service()` on an `object` is invoke-operator sugar, runtime type is invoke\'s return -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nobject Service {\n    operator fun invoke(): Codec = Codec()\n    fun decrypt(x: Int): Int = 99\n}\n',
    'src/main/kotlin/Codec.kt': 'package demo\n\nclass Codec {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val s = Service()',
    '        assertEquals(6, s.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val s = Service()\n        assertEquals(6, s.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Codec.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K10 invokable property + top-level fun: the property is the dispatch target, not the top-level fun -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    val decrypt: (Int) -> Int = { it * 2 }\n}\n\nfun decrypt(x: Int): Int = 5\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(10, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(10, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// ---- Java REDs ----

test('J1 sibling top-level class: Helper.decrypt in the same file is not Service\'s own member -> refuse', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base {\n}\n\nclass Helper {\n    int decrypt(int x) { return x - 1; }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  @Test void t() {',
    '    Service service = new Service();',
    '    assertEquals(6, service.decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Service service = new Service();\n    assertEquals(6, service.decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('J2 static, different signature: overload resolution binds the inherited instance method -> refuse', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base {\n    static String decrypt(String a, String b) { return a + b; }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  @Test void t() {',
    '    Service service = new Service();',
    '    assertEquals(6, service.decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Service service = new Service();\n    assertEquals(6, service.decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('J3 nested class: Inner.decrypt is not reachable via `service.` -> refuse', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base {\n    static class Inner {\n        int decrypt(int x) { return x - 1; }\n    }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  @Test void t() {',
    '    Service service = new Service();',
    '    assertEquals(6, service.decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Service service = new Service();\n    assertEquals(6, service.decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('J4 interface default, class-wins: a concrete Base.decrypt beats Codec\'s default silently -> refuse', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base implements Codec {\n}\n\ninterface Codec {\n    default int decrypt(int x) { return 0; }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  @Test void t() {',
    '    Service service = new Service();',
    '    assertEquals(6, service.decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Service service = new Service();\n    assertEquals(6, service.decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

// ---- Fail-closed FLIPS (NOT RED on HEAD — today-sound-by-accident credit, now a documented refusal) ----

test('K17 delegation (flip, not RED): a `by` clause at depth 0 in the class header refuses the whole class', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base by backing {\n    fun decrypt(x: Int): Int = x\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(5, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(5, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('K8 interface-default same-file (flip, not RED): Service has no own body -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\ninterface Codec {\n    fun decrypt(x: Int): Int = 0\n}\nclass Service : Codec\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(0, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(0, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// ---- Positive controls (must stay/become credited) ----

test('P1 full header, expression body: primary ctor + supertype ctor call, own plain member -> credit', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service(private val k: Int) : Base(k) {\n    fun decrypt(x: Int): Int = x + k\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base(val k: Int)\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service(1)',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service(1)\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'decrypt', sutRel: 'src/main/kotlin/Service.kt' }],
  );
});

test('P2 override: Service.decrypt overrides Base\'s single decrypt -> credit', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    override fun decrypt(x: Int): Int = x * 2\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    open fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(10, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(10, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'decrypt', sutRel: 'src/main/kotlin/Service.kt' }],
  );
});

test('P3 member after companion + ctor/init noise: depth bookkeeping walks balanced groups correctly -> credit', () => {
  const d = project({
    'src/main/kotlin/Service.kt': [
      'package demo', '',
      'class Service : Base() {',
      '    companion object {',
      '        fun make(): Service = Service()',
      '    }',
      '    constructor(x: Int) : this()',
      '    init { }',
      '    fun decrypt(x: Int): Int = x + 1',
      '}', '',
    ].join('\n'),
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    @Test fun t() {',
    '        val service = Service()',
    '        assertEquals(6, service.decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val service = Service()\n        assertEquals(6, service.decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'decrypt', sutRel: 'src/main/kotlin/Service.kt' }],
  );
});

test('P4 unresolvable supertype (Android reach control): ViewModel not in srcFiles -> credit (guard does not over-refuse)', () => {
  const d = project({
    'src/main/kotlin/Vm.kt': 'package demo\n\nclass Vm : ViewModel() {\n    fun score(x: Int): Int = x * 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class VmTest {',
    '    @Test fun t() {',
    '        val vm = Vm()',
    '        assertEquals(10, vm.score(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val vm = Vm()\n        assertEquals(10, vm.score(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Vm.kt')];
  const absTest = abs(d, 'src/test/kotlin/VmTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'score', sutRel: 'src/main/kotlin/Vm.kt' }],
  );
});

test('P5 java @Override: Service.decrypt overrides Base\'s single decrypt -> credit', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base {\n    @Override public int decrypt(int x) { return x * 2; }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  @Test void t() {',
    '    Service service = new Service();',
    '    assertEquals(10, service.decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    Service service = new Service();\n    assertEquals(10, service.decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'),
    [{ fn: 'decrypt', sutRel: 'src/main/java/demo/Service.java' }],
  );
});

// =========================================================================================
// T3: INLINE receiver crediting — Kotlin `X(...).m(...)`, Java `new X(...).m(...)`, no assignment, no
// variable (docs/plans/2026-07-09-inline-receiver-crediting.md §3/§4/T3). jvmInlineCtorMethodCallsIn
// scans the pinned fragment for an inline ctor immediately followed by `.method(...)`, then routes
// through the IDENTICAL jvmCreditTypeMethod chain the variable path uses — so every guard that protects
// the variable path (resolveJvmClass, the Kotlin factory-vs-class ambiguity guard, jvmOwnPlainInstance-
// Member) protects the inline path too, by construction, not by duplication.
// =========================================================================================

// ---- RED bites: currently [] (uncredited) on pre-T3 HEAD; each must flip to a credited pair. ----

test('T3 RED bite (kotlin): `assertEquals(5, Calc().add(2,3))` credits (fn=add, sutRel=src file)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Test',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class CalcTest {',
    '    @Test fun t() {',
    '        assertEquals(5, Calc().add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Calc().add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/CalcTest.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'add', sutRel: 'src/main/kotlin/Calc.kt' }],
  );
});

test('T3 RED bite (java): `assertEquals(5, new Calc().add(2,3))` credits (fn=add, sutRel=src file)', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class CalcTest {',
    '  @Test void t() {',
    '    assertEquals(5, new Calc().add(2, 3));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, new Calc().add(2, 3));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/CalcTest.java');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'),
    [{ fn: 'add', sutRel: 'src/main/java/demo/Calc.java' }],
  );
});

test('T3 RED bite (kotlin, actual-first arg position): `assertEquals(Calc().add(2,3), 5)` credits (JUnit puts the SUT call in either position)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(Calc().add(2, 3), 5)',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(Calc().add(2, 3), 5)\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'add', sutRel: 'src/main/kotlin/Calc.kt' }],
  );
});

test('T3 RED bite (kotlin, assertThat form): `assertThat(Calc().add(2,3)).isEqualTo(5)` credits', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.assertj.core.api.Assertions.assertThat', '',
    'class T {',
    '    fun t() {',
    '        assertThat(Calc().add(2, 3)).isEqualTo(5)',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertThat(Calc().add(2, 3)).isEqualTo(5)\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'add', sutRel: 'src/main/kotlin/Calc.kt' }],
  );
});

test('T3 RED bite (java, assertThat form): `assertThat(new Calc().add(2,3)).isEqualTo(5)` credits', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.assertj.core.api.Assertions.assertThat;', '',
    'class T {',
    '  void t() {',
    '    assertThat(new Calc().add(2, 3)).isEqualTo(5);',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertThat(new Calc().add(2, 3)).isEqualTo(5);\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'),
    [{ fn: 'add', sutRel: 'src/main/java/demo/Calc.java' }],
  );
});

// ---- adversarial: scanner-boundary refusals (jvmInlineCtorMethodCallsIn itself — the §5.1/5.2 rows that
// are about the SHAPE of the inline call, not the shared type->method credit chain) ----

test('T3 adversarial (kotlin): chained `Calc().add(2,3).let{}` style chain `X().m().n()` refuses BOTH', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun m(): Calc = Calc()\n    fun n(): Int = 1\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(1, Calc().m().n())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(1, Calc().m().n())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): chained `new Calc().m().n()` refuses BOTH', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public Calc m() { return new Calc(); }\n    public int n() { return 1; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(1, new Calc().m().n());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(1, new Calc().m().n());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): builder `Calc().build().m()` refuses BOTH (same immediately-preceding-ctor rule)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun build(): Calc = Calc()\n    fun m(): Int = 1\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(1, Calc().build().m())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(1, Calc().build().m())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): builder `new Calc().build().m()` refuses BOTH', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public Calc build() { return new Calc(); }\n    public int m() { return 1; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(1, new Calc().build().m());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(1, new Calc().build().m());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): bare ctor argument, no method (`foo(Calc())`) — no credit (scanner requires `.m(` after the ctor)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun foo(c: Calc): Int = 5',
    '    fun t() {',
    '        assertEquals(5, foo(Calc()))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, foo(Calc()))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): bare ctor argument, no method (`foo(new Calc())`) — no credit', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  static int foo(Calc c) { return 5; }',
    '  void t() {',
    '    assertEquals(5, foo(new Calc()));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, foo(new Calc()));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): property access `Calc().value` — no credit (scanner requires `(` after the member name)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    val value: Int = 5\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Calc().value)',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Calc().value)\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): field access `new Calc().value` — no credit', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public int value = 5;\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(5, new Calc().value);',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, new Calc().value);\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): non-null assertion `Calc()!!.add(2,3)` refuses (next-after-ctor-`)` must be exactly `.`)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Calc()!!.add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Calc()!!.add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin): generic ctor `Calc<Int>().add(2,3)` refuses (kotlinCtorAt matches `(` directly after the name — documented under-reach)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc<T> {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Calc<Int>().add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Calc<Int>().add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): generic ctor `new Calc<>().add(2,3)` refuses (javaCtorAt matches `(` directly after the name)', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc<T> {\n    public int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(5, new Calc<>().add(2, 3));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, new Calc<>().add(2, 3));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): dotted inline ctor `pkg.Calc().add(2,3)` refuses (simple-name-only boundary)', () => {
  const d = project({ 'src/main/kotlin/pkg/Calc.kt': 'package pkg\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, pkg.Calc().add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, pkg.Calc().add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/pkg/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): dotted inline ctor `new ns.Calc().add(2,3)` refuses (javaCtorAt requires the character right after `new`+whitespace to be capitalized)', () => {
  const d = project({ 'src/main/java/ns/Calc.java': 'package ns;\npublic class Calc {\n    public int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(5, new ns.Calc().add(2, 3));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, new ns.Calc().add(2, 3));\n';
  const srcFiles = [abs(d, 'src/main/java/ns/Calc.java')];
  const absTest = abs(d, 'src/test/java/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): ctor of an unresolved/mock name (`Mock().m()`, Mock never declared) refuses — class-resolution guard', () => {
  const d = project({ 'src/main/kotlin/Real.kt': 'package demo\n\nclass Real {\n    fun m(): Int = 5\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Mock().m())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Mock().m())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Real.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java): ctor of an unresolved/mock name (`new Mock().m()`, Mock never declared) refuses', () => {
  const d = project({ 'src/main/java/demo/Real.java': 'package demo;\npublic class Real {\n    public int m() { return 5; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(5, new Mock().m());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, new Mock().m());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Real.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (kotlin): X declared in TWO reachable files refuses (ambiguous class resolution)', () => {
  const d = project({
    'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n}\n',
    'src/main/kotlin/other/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a - b\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Calc().add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Calc().add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt'), abs(d, 'src/main/kotlin/other/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// ---- adversarial: SAM/interface, object+invoke, heritage/trailing-lambda (Kotlin-specific scanner and
// routing refusals) ----

test('T3 adversarial (kotlin): SAM parenless trailing-lambda `Runnable { }.run()` — no credit (no `(` directly after the name)', () => {
  const d = project({ 'src/main/kotlin/Runnable.kt': 'package demo\n\ninterface Runnable {\n    fun run(): Int\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Runnable { 5 }.run())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Runnable { 5 }.run())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Runnable.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin): SAM/interface with explicit call parens `X({...}).m()` refuses (interfaces excluded by resolveJvmClass)', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\ninterface Calc {\n    fun add(a: Int, b: Int): Int\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(5, Calc({ a, b -> a + b }).add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(5, Calc({ a, b -> a + b }).add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin): `object X` invoke-operator sugar `Service().decrypt()` refuses (K9, inline form)', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nobject Service {\n    operator fun invoke(): Codec = Codec()\n    fun decrypt(x: Int): Int = 99\n}\n',
    'src/main/kotlin/Codec.kt': 'package demo\n\nclass Codec {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(6, Service().decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(6, Service().decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Codec.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin): capitalized top-level factory `fun Foo(): Bar` collides with `class Foo` — refuses (inline form, ctor/factory ambiguous)', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nfun Foo(): Bar = Bar()\n\nclass Foo {\n    fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun compute(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(2, Foo().compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(2, Foo().compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin): heritage/object-expression position `(object : X() {}).m()` refuses (previous-non-ws-`:` guard)', () => {
  const d = project({ 'src/main/kotlin/X.kt': 'package demo\n\nopen class X {\n    open fun m(): Int = 1\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(1, (object : X() {}).m())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(1, (object : X() {}).m())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/X.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin): trailing-lambda ctor arg `X() { }.m()` refuses (next-after-ctor-`)` is `{`, conservative)', () => {
  const d = project({ 'src/main/kotlin/X.kt': 'package demo\n\nclass X(val block: () -> Unit = {}) {\n    fun m(): Int = 1\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(1, X() { }.m())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(1, X() { }.m())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/X.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

// ---- adversarial: `m` inherited/sibling/nested/companion/extension/static (routing through the SHARED
// jvmOwnPlainInstanceMember chain — representative inline-form coverage; the guard's own exhaustive
// correctness is already locked by the variable-path K1-K10/J1-J4 fixtures above, unchanged by T3) ----

test('T3 adversarial (kotlin): inherited-only method `Derived().compute()` refuses (Derived does not override compute)', () => {
  const d = project({
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    open fun compute(): Int = 1\n}\n',
    'src/main/kotlin/Derived.kt': 'package demo\n\nclass Derived : Base()\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(1, Derived().compute())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(1, Derived().compute())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Base.kt'), abs(d, 'src/main/kotlin/Derived.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin, K1-style sibling): sibling class LegacyCodec.decrypt is not Service\'s own member, inline form -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n}\n\nclass LegacyCodec {\n    fun decrypt(x: Int): Int = x - 1\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    fun t() {',
    '        assertEquals(6, Service().decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(6, Service().decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin, K2-style companion): companion-object decrypt is not instance-callable, inline form -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    companion object {\n        fun decrypt(x: Int): Int = 99\n    }\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    fun t() {',
    '        assertEquals(6, Service().decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(6, Service().decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin, K5-style nested): Parser.decrypt is not reachable via the inline receiver -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n    class Parser {\n        fun decrypt(x: Int): Int = x - 1\n    }\n}\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    fun t() {',
    '        assertEquals(6, Service().decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(6, Service().decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (kotlin, K6-style extension): member-always-wins-over-extension, inline form -> refuse', () => {
  const d = project({
    'src/main/kotlin/Service.kt': 'package demo\n\nclass Service : Base() {\n}\n\nfun Service.decrypt(x: Int): Int = 7\n',
    'src/main/kotlin/Base.kt': 'package demo\n\nopen class Base {\n    fun decrypt(x: Int): Int = x + 1\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class ServiceTest {',
    '    fun t() {',
    '        assertEquals(6, Service().decrypt(5))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(6, Service().decrypt(5))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Service.kt'), abs(d, 'src/main/kotlin/Base.kt')];
  const absTest = abs(d, 'src/test/kotlin/ServiceTest.kt');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'), []);
});

test('T3 adversarial (java, anon-subclass): `new Animal() { override sound }.sound()` refuses', () => {
  const d = project({
    'src/main/java/demo/Animal.java': 'package demo;\npublic class Animal {\n    public String sound() { return "..."; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals("x", new Animal() { @Override public String sound() { return "x"; } }.sound());',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals("x", new Animal() { @Override public String sound() { return "x"; } }.sound());\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Animal.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (java, bare no-new): `Calc().add(2,3)` (no `new`) — no credit (Java inline scanner requires the `new` keyword)', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public static int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(5, Calc.add(2, 3));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, Calc.add(2, 3));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (java): static `m` in X refuses (jvmOwnPlainInstanceMember, java-static guard, inline form)', () => {
  const d = project({ 'src/main/java/demo/Calc.java': 'package demo;\npublic class Calc {\n    public static int add(int a, int b) { return a + b; }\n}\n' });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class T {',
    '  void t() {',
    '    assertEquals(5, new Calc().add(2, 3));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(5, new Calc().add(2, 3));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Calc.java')];
  const absTest = abs(d, 'src/test/java/demo/T.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (java, J1-style sibling): sibling class Helper.decrypt is not Service\'s own member, inline form -> refuse', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base {\n}\n\nclass Helper {\n    int decrypt(int x) { return x - 1; }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  void t() {',
    '    assertEquals(6, new Service().decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(6, new Service().decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

test('T3 adversarial (java, J3-style nested): Inner.decrypt is not reachable via the inline receiver -> refuse', () => {
  const d = project({
    'src/main/java/demo/Service.java': 'package demo;\n\npublic class Service extends Base {\n    static class Inner {\n        int decrypt(int x) { return x - 1; }\n    }\n}\n',
    'src/main/java/demo/Base.java': 'package demo;\n\npublic class Base {\n    public int decrypt(int x) { return x + 1; }\n}\n',
  });
  const testCode = [
    'package demo;', '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;', '',
    'class ServiceTest {',
    '  void t() {',
    '    assertEquals(6, new Service().decrypt(5));',
    '  }',
    '}', '',
  ].join('\n');
  const body = '    assertEquals(6, new Service().decrypt(5));\n';
  const srcFiles = [abs(d, 'src/main/java/demo/Service.java'), abs(d, 'src/main/java/demo/Base.java')];
  const absTest = abs(d, 'src/test/java/demo/ServiceTest.java');
  assert.deepEqual(jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'java'), []);
});

// ---- positive controls (inline form must NOT over-refuse ordinary shapes) ----

test('T3 positive control (kotlin): inline receiver alongside an unrelated variable receiver in the same block — both credit', () => {
  const d = project({ 'src/main/kotlin/Calc.kt': 'package demo\n\nclass Calc {\n    fun add(a: Int, b: Int): Int = a + b\n    fun sub(a: Int, b: Int): Int = a - b\n}\n' });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        val c = Calc()',
    '        assertEquals(1, c.sub(3, 2))',
    '        assertEquals(5, Calc().add(2, 3))',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        val c = Calc()\n        assertEquals(1, c.sub(3, 2))\n        assertEquals(5, Calc().add(2, 3))\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Calc.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'sub', sutRel: 'src/main/kotlin/Calc.kt' }, { fn: 'add', sutRel: 'src/main/kotlin/Calc.kt' }],
  );
});

test('T3 positive control (kotlin): two distinct inline calls in one fragment both credit (assertEquals whole-arg-list scan)', () => {
  const d = project({
    'src/main/kotlin/Foo.kt': 'package demo\n\nclass Foo {\n    fun m(): Int = 1\n}\n',
    'src/main/kotlin/Bar.kt': 'package demo\n\nclass Bar {\n    fun n(): Int = 2\n}\n',
  });
  const testCode = [
    'package demo', '',
    'import org.junit.jupiter.api.Assertions.assertEquals', '',
    'class T {',
    '    fun t() {',
    '        assertEquals(Foo().m(), Bar().n())',
    '    }',
    '}', '',
  ].join('\n');
  const body = '        assertEquals(Foo().m(), Bar().n())\n';
  const srcFiles = [abs(d, 'src/main/kotlin/Foo.kt'), abs(d, 'src/main/kotlin/Bar.kt')];
  const absTest = abs(d, 'src/test/kotlin/T.kt');
  assert.deepEqual(
    jvmInstanceSuts(body, testCode, absTest, srcFiles, d, 'kotlin'),
    [{ fn: 'm', sutRel: 'src/main/kotlin/Foo.kt' }, { fn: 'n', sutRel: 'src/main/kotlin/Bar.kt' }],
  );
});
