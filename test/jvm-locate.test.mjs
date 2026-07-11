// locateBody/grossBreak for Kotlin and Java (RED-first for Task 5). Spans and sentinels below are
// hand-derived from the source strings (never pinned from the implementation's own output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grossBreak } from '../mutation/probe.mjs';

// --- brief's base cases -----------------------------------------------------------------------

test('kotlin block body → return typed sentinel', () => {
  const src = 'fun greet(name: String): String {\n    return "Hello, " + name\n}\n';
  const out = grossBreak(src, 'greet', 'kotlin');
  assert.ok(out.includes('"__gutcheck_987654321__"'), out); // String sentinel
  assert.ok(!out.includes('"Hello, " + name'));              // original body gone
});

test('kotlin expression body → RHS replaced with typed sentinel', () => {
  const src = 'fun add(a: Int, b: Int): Int = a + b\n';
  const out = grossBreak(src, 'add', 'kotlin');
  assert.match(out, /fun add\(a: Int, b: Int\): Int =\s*987654321/);
  assert.ok(!out.includes('a + b'));
});

test('kotlin generic return type does not confuse body location', () => {
  const src = 'fun m(): Map<String, List<Int>> {\n    return mapOf()\n}\n';
  const out = grossBreak(src, 'm', 'kotlin');
  assert.ok(out.includes('return 987654321'), out); // unknown type → numeric default (compile-fail-safe)
  assert.ok(!out.includes('mapOf()'));
});

test('kotlin suspend fun located', () => {
  const src = 'suspend fun load(id: Int): Int {\n    return id * 2\n}\n';
  const out = grossBreak(src, 'load', 'kotlin');
  assert.ok(out.includes('return 987654321'));
});

test('java method → return typed sentinel', () => {
  const src = 'public class C {\n  public static int square(int x) { return x * x; }\n}\n';
  const out = grossBreak(src, 'square', 'java');
  assert.match(out, /return\s+987654321\s*;/);
  assert.ok(!out.includes('x * x'));
});

test('java String method → string sentinel', () => {
  const src = 'class C {\n  String hi() { return "hi"; }\n}\n';
  const out = grossBreak(src, 'hi', 'java');
  assert.ok(out.includes('"__gutcheck_987654321__"'));
});

// A Boolean/Char sentinel would COMPILE and collide with a real return value (`false` / `' '`) → a sound
// test (`assertFalse(valid(-1))`) still passes → a FALSE HOLLOW. gutValueFor deliberately falls Boolean
// and Char through to the numeric default, which instead compile-FAILS in that typed context → the runner
// gets no fresh XML → ungutable → INCONCLUSIVE (a safe non-verdict). These lock that: precision over reach.
test('kotlin Boolean fn guts to numeric (compile-fails → ungutable, NOT to false)', () => {
  const src = 'fun isPositive(n: Int): Boolean = n > 0\n';
  const out = grossBreak(src, 'isPositive', 'kotlin');
  assert.match(out, /fun isPositive\(n: Int\): Boolean =\s*987654321/);
  assert.ok(!/=\s*false/.test(out), out); // must NOT emit the colliding `false` sentinel
});
test('java boolean method guts to numeric (compile-fails → ungutable, NOT to false)', () => {
  const src = 'class C {\n  boolean valid(int x) { return x > 0; }\n}\n';
  const out = grossBreak(src, 'valid', 'java');
  assert.match(out, /return\s+987654321\s*;/);
  assert.ok(!out.includes('return false'), out);
});
test('kotlin Char fn guts to numeric (compile-fails → ungutable, NOT to a space char literal)', () => {
  const src = 'fun initial(name: String): Char = name[0]\n';
  const out = grossBreak(src, 'initial', 'kotlin');
  assert.match(out, /fun initial\(name: String\): Char =\s*987654321/);
  assert.ok(!out.includes("' '"), out); // must NOT emit the colliding char-literal sentinel
});

test('unlocatable fn → null (→ inconclusive)', () => {
  assert.equal(grossBreak('fun other() {}', 'missing', 'kotlin'), null);
});

// --- adversarial (a): a call to the SAME name in a DIFFERENT function must not be gutted as the decl ---

test('java: a call add(1, 2) inside a different function is not mistaken for its declaration', () => {
  const src = 'class C {\n  int compute() { return add(1, 2) + 1; }\n  int add(int a, int b) { return a + b; }\n}\n';
  const out = grossBreak(src, 'add', 'java');
  assert.ok(out.includes('return add(1, 2) + 1'), out); // the CALL site in compute() is untouched
  assert.match(out, /int add\(int a, int b\) \{ return 987654321; \}/); // add's own body is gutted
});

test('kotlin: a call add(1, 2) inside a different function is not mistaken for its declaration', () => {
  const src = 'fun compute(): Int {\n    return add(1, 2) + 1\n}\nfun add(a: Int, b: Int): Int {\n    return a + b\n}\n';
  const out = grossBreak(src, 'add', 'kotlin');
  assert.ok(out.includes('return add(1, 2) + 1'), out);
  assert.match(out, /fun add\(a: Int, b: Int\): Int \{ return 987654321; \}/);
});

test('java: an interface abstract declaration (no body) is skipped for a real implementation', () => {
  const src = 'interface Ops {\n  int add(int a, int b);\n}\nclass Impl implements Ops {\n  public int add(int a, int b) { return a + b; }\n}\n';
  const out = grossBreak(src, 'add', 'java');
  assert.match(out, /public int add\(int a, int b\) \{ return 987654321; \}/);
});

// --- adversarial (b): a Java `throws` clause before the body brace ------------------------------

test('java: a throws clause before the body brace does not block location', () => {
  const src = 'class C {\n  void read(String path) throws java.io.IOException {\n    load(path);\n  }\n}\n';
  const out = grossBreak(src, 'read', 'java');
  assert.match(out, /throws java\.io\.IOException \{ return 987654321; \}/);
  assert.ok(!out.includes('load(path)'));
});

// --- adversarial (c): a Kotlin expression body whose RHS is a lambda literal ---------------------
// `fun f(x) = { y -> y + x }` — the `{` is a LAMBDA LITERAL (a value being returned), not the
// function's own block body (Kotlin never uses `= { ... }` to mean a block body — a block body is
// always written directly after the signature with no `=`). Reaching INSIDE the lambda's braces and
// inserting `return <sentinel>` there would produce `{ return 987654321 }`, which additionally is not
// even legal Kotlin (a bare `return` inside a lambda not passed to an inline function is a compile
// error) — so this case must replace the WHOLE expression (the lambda, entire), never partially.

test('kotlin: an expression-bodied fun returning a lambda literal is replaced whole, not mislocated into the lambda', () => {
  const src = 'fun f(x: Int) = { y: Int -> y + x }\n';
  const out = grossBreak(src, 'f', 'kotlin');
  assert.ok(!out.includes('y + x'), out);
  assert.ok(!/\{\s*return 987654321/.test(out), out);  // must NOT have reached inside the lambda's braces
  assert.match(out, /fun f\(x: Int\) =\s*987654321/);   // the whole RHS (the lambda) is replaced
});

// --- adversarial (d): a Kotlin generic return type (angle brackets) before the body brace --------
// Covered above by 'kotlin generic return type does not confuse body location'; an extra case with a
// function-type return (parens + `->`) inside the generic, to confirm paren-nesting inside `<...>`
// doesn't trip the top-level brace scan either.

test('kotlin: a function-type nested inside a generic return type does not confuse body location', () => {
  const src = 'fun pairOf(): Pair<(Int) -> Int, String> {\n    return Pair({ it }, "x")\n}\n';
  const out = grossBreak(src, 'pairOf', 'kotlin');
  assert.ok(out.includes('return 987654321'), out);
  assert.ok(!out.includes('Pair({ it }, "x")'));
});

// --- adversarial (e): a Kotlin expression body CHAINED ACROSS MULTIPLE LINES (Bug A / real-app repro) ---
// kotlinExprSite used to end the span at the FIRST top-level newline, so a multi-line chained expression
// left its continuation surviving on the mutant (`= 987654321\n        .coerceIn(...)`) — a PARTIAL gut
// whose surviving `.coerceIn(...)` clamps the sentinel back toward the pinned value on some inputs, a
// confirmed false-HOLLOW vector on a real Kotlin app (csdMaxDecayMsForUseCase). The whole chained
// expression must be gutted (or, if undecidable, not-guttable) — never a partial gut with a surviving
// trailing call.
test('kotlin: a multi-line chained expression body is gutted WHOLE — no surviving trailing .op(...) call', () => {
  const src = 'internal fun csdMaxDecayMsForUseCase(useCase: RoomUseCase): Int =\n'
    + '    (useCase.rt60Max * CSD_SPAN_HEADROOM * 1000f).roundToInt()\n'
    + '        .coerceIn(CSD_SPAN_FLOOR_MS, CSD_SPAN_CEILING_MS)\n';
  const out = grossBreak(src, 'csdMaxDecayMsForUseCase', 'kotlin');
  assert.ok(out !== null, 'must be guttable, not null');
  assert.ok(!out.includes('.coerceIn('), `surviving trailing call left on the mutant: ${out}`);
  assert.ok(!out.includes('.roundToInt('), `surviving chain call left on the mutant: ${out}`);
  assert.match(out, /Int =\s*987654321/, out); // Int sentinel replaces the WHOLE expression
});

test('kotlin: elvis `?:` continuation on the next line is included in the gutted span', () => {
  const src = 'fun f(x: Int?): Int =\n    x\n        ?: fallback()\n';
  const out = grossBreak(src, 'f', 'kotlin');
  assert.ok(!out.includes('fallback()'), out);
});

test('kotlin: a trailing binary operator at end-of-line continues the expression span', () => {
  const src = 'fun sum(a: Int, b: Int): Int =\n    a +\n        b\n';
  const out = grossBreak(src, 'sum', 'kotlin');
  assert.match(out, /Int =\s*987654321/, out);
  // A standalone `b` line surviving after the sentinel means only the FIRST line ("a +") was gutted and
  // the continuation ("b") was left dangling — the false-positive vector this test guards against. (The
  // signature's own `b: Int` parameter is on the SAME line as other text, so it can't match this "b sits
  // alone on its own line" check.)
  assert.ok(!/\n[ \t]*b[ \t]*\n/.test(out), `surviving continuation left on the mutant: ${out}`);
});

// Positive control: a newline WITHOUT a continuation cue must still end the expression normally — the
// continuation fix must not over-consume into the NEXT function's own body.
test('kotlin: expression body newline WITHOUT a continuation cue still ends normally (no over-consumption into the next fun)', () => {
  const src = 'fun a(): Int = 1\nfun b(): Int = 2\n';
  const out = grossBreak(src, 'a', 'kotlin');
  assert.match(out, /fun a\(\): Int =\s*987654321\s*\nfun b\(\): Int = 2/, out);
});

// Positive control: a single-line expression body is still gutted whole (byte-identical to before).
test('kotlin: single-line expression body still gutted whole (unchanged)', () => {
  const src = 'fun add(a: Int, b: Int): Int = a + b\n';
  const out = grossBreak(src, 'add', 'kotlin');
  assert.match(out, /fun add\(a: Int, b: Int\): Int =\s*987654321/);
  assert.ok(!out.includes('a + b'));
});
