// @Test block parsing + JVM assertion pin gate (Task 6). Oracles hand-derived from the source text —
// never pinned from parseBlocks/eligibleFns' own output. JS/py behavior byte-identity is proven
// elsewhere (test/prove.test.mjs, test/confirm.test.mjs) by those suites staying green unmodified;
// these tests exercise only the new `lang`-gated JVM branches, always passing an explicit lang so the
// no-lang default path (what every pre-existing JS/py call site uses) is left untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, eligibleFns, eligibleFnsDetail } from '../mutation/prove.mjs';
import { sutFnsIn } from '../mutation/confirm.mjs';

const KT = `package demo
import org.junit.jupiter.api.Test
class CalcTest {
    @Test fun testAdd() { org.junit.jupiter.api.Assertions.assertEquals(5, add(2, 3)) }
    @Test fun weak() { org.junit.jupiter.api.Assertions.assertTrue(isPositive(5)) }
}`;

test('parseBlocks kotlin: one block per @Test, FQN name (pkg.Class.method)', () => {
  const bs = parseBlocks(KT, 'kotlin');
  const names = bs.map((b) => b.name).sort();
  assert.deepEqual(names, ['demo.CalcTest.testAdd', 'demo.CalcTest.weak']);
});

test('eligibility: assertEquals actual-arg call is pinned (kotlin, fully-qualified assert call)', () => {
  const add = parseBlocks(KT, 'kotlin').find((b) => b.name.endsWith('testAdd'));
  assert.deepEqual(eligibleFns(add.body, sutFnsIn(add.body, 'kotlin'), new Map(), 'kotlin'), ['add']);
});

test('eligibility: assertTrue is weak → not pinned (kotlin)', () => {
  const weak = parseBlocks(KT, 'kotlin').find((b) => b.name.endsWith('weak'));
  assert.deepEqual(eligibleFns(weak.body, sutFnsIn(weak.body, 'kotlin'), new Map(), 'kotlin'), []);
});

test('AssertJ isEqualTo pins the assertThat actual (java)', () => {
  const body = 'assertThat(square(3)).isEqualTo(9)';
  assert.ok(eligibleFns(body, sutFnsIn(body, 'java'), new Map(), 'java').includes('square'));
});

test('AssertJ weak follow-on (.isNotNull) is NOT a pin', () => {
  const body = 'assertThat(square(3)).isNotNull()';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'java'), new Map(), 'java'), []);
});

// --- receiver-method call capture + both-arg scanning — the exact shape of the JCalc.square(3) fixture
// case (test/fixtures/jvm-project/src/test/kotlin/CalcTest.kt), required for Task 8's end-to-end run ---

test('receiver-method call (JCalc.square) is a sutFnsIn candidate and eligible via assertEquals’ 2nd arg', () => {
  const body = 'assertEquals(9, JCalc.square(3))';
  const candidates = sutFnsIn(body, 'kotlin');
  assert.ok(candidates.includes('square'), candidates.join(','));
  assert.deepEqual(eligibleFns(body, candidates, new Map(), 'kotlin'), ['square']);
});

test('weak-matcher fixture shape assertTrue(isPositive(5)) yields no eligible fn', () => {
  const body = 'assertTrue(isPositive(5))';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin'), []);
});

test('parseBlocks java: @Test method -> FQN pkg.Class.method', () => {
  const src = `package demo;
import org.junit.jupiter.api.Test;
public class JCalcTest {
    @Test public void testSquare() { org.junit.jupiter.api.Assertions.assertEquals(9, JCalc.square(3)); }
}`;
  const bs = parseBlocks(src, 'java');
  assert.deepEqual(bs.map((b) => b.name), ['demo.JCalcTest.testSquare']);
});

test('parseBlocks kotlin: 2-method class -> both FQNs pkg.Class.method', () => {
  const src = `package pkg
class Widget {
    @Test fun one() { assertEquals(1, one()) }
    @Test fun two() { assertEquals(2, two()) }
}`;
  const names = parseBlocks(src, 'kotlin').map((b) => b.name).sort();
  assert.deepEqual(names, ['pkg.Widget.one', 'pkg.Widget.two']);
});

// --- default (no lang) gating: the JVM branches must stay INERT with no lang argument, since every
// pre-existing JS/py call site (mutation/prove.mjs's prove() loop, mutation/confirm.mjs's confirmOne)
// never passes one — this is the byte-identity guarantee for Task 6's change ---

test('without an explicit lang, the JVM branches are inert (no receiver-method capture, no JVM pin)', () => {
  const body = 'assertEquals(9, JCalc.square(3))';
  const candidates = sutFnsIn(body); // no lang -> pre-existing JS/py behavior only
  assert.ok(!candidates.includes('square'), candidates.join(',')); // receiver-method capture NOT applied
  assert.deepEqual(eligibleFns(body, candidates), []); // JVM matcher vocabulary NOT recognized either
});

// === Adversarial-review fixes (RED-first) ===================================================

// CRITICAL: a char literal '{' in a test body must not corrupt the brace-balance and over-run the
// method's body into the NEXT method (which would falsely pin the sibling's SUT → false HOLLOW).
// Oracle hand-derived: test A calls only peek(); square() belongs solely to the SEPARATE test B, so
// A's eligible must be exactly ['peek'] — no cross-method leak of 'square'.
test('char-literal in a test body does not leak the next method’s SUT (no brace-balance corruption)', () => {
  const src = `package demo
class T {
    @Test fun opensBrace() { assertEquals('{', peek()) }
    @Test fun sq() { assertEquals(4, square(2)) }
}`;
  const a = parseBlocks(src, 'kotlin').find((b) => b.name.endsWith('opensBrace'));
  const elig = eligibleFns(a.body, sutFnsIn(a.body, 'kotlin'), new Map(), 'kotlin');
  assert.ok(!elig.includes('square'), `cross-method leak: ${elig.join(',')}`);
  assert.deepEqual(elig, ['peek']);
});

// @Nested inner-class @Tests ARE emitted (idiomatic JUnit5-in-Kotlin), FQN'd with the FULL nesting
// chain joined by '$' — the JVM binary class name Gradle's `--tests` selector expects
// (`pkg.Outer$Inner.method`, verified live: XML tests=1). Formerly skipped, when only a bare
// `Inner.method` FQN was computable (that mis-selected). A wrong/corrupted chain can only SHRINK →
// a non-existent class path → gradle 0-match → inconclusive (never a wrong-but-valid selection).
test('@Nested inner-class @Test IS emitted with a $-joined FQN; siblings + depth handled', () => {
  const nestedOnly = `package demo
class Outer {
    @Nested inner class Inner {
        @Test fun t() { assertEquals(1, foo()) }
    }
}`;
  assert.deepEqual(parseBlocks(nestedOnly, 'kotlin').map((b) => b.name), ['demo.Outer$Inner.t']);

  const mixed = `package demo
class Outer {
    @Test fun top() { assertEquals(1, foo()) }
    @Nested inner class Inner {
        @Test fun t() { assertEquals(2, bar()) }
    }
}`;
  assert.deepEqual(parseBlocks(mixed, 'kotlin').map((b) => b.name).sort(), ['demo.Outer$Inner.t', 'demo.Outer.top']);

  const deep = `package demo
class Outer {
    @Nested inner class Mid {
        @Nested inner class Inner {
            @Test fun deep() { assertEquals(3, baz()) }
        }
    }
}`;
  assert.deepEqual(parseBlocks(deep, 'kotlin').map((b) => b.name), ['demo.Outer$Mid$Inner.deep']);
});

// Kotlin backtick-quoted `fun` names (`fun `does X`()`) are IDIOMATIC-DOMINANT in real Kotlin test
// suites (detekt/ktlint/most libraries) — the plain-identifier-only capture missed every one of them,
// so the probe was blind to those suites (a wild-pilot finding). The backtick content IS the JVM method
// name and the exact `--tests` selector, so it flows into the FQN verbatim (spaces and all). Reach fix,
// precision-safe: matching MORE @Tests only adds probes; each still passes the same downstream gates.
test('parseBlocks kotlin: backtick-named @Test is emitted; backtick content is the FQN method (spaces preserved)', () => {
  const src = `package demo
class CalcTest {
    @Test fun \`adds two numbers\`() { assertEquals(5, add(2, 3)) }
}`;
  const bs = parseBlocks(src, 'kotlin');
  assert.deepEqual(bs.map((b) => b.name), ['demo.CalcTest.adds two numbers']);
  assert.ok(bs[0].body.includes('assertEquals(5, add(2, 3))'), `body must be captured intact: ${JSON.stringify(bs[0].body)}`);
});

test('parseBlocks kotlin: backtick and plain @Test names coexist; special chars inside backticks kept', () => {
  const src = `package demo
class CalcTest {
    @Test fun testAdd() { assertEquals(5, add(2, 3)) }
    @Test fun \`add + subtract round-trip\`() { assertEquals(2, roundTrip(2)) }
}`;
  const names = parseBlocks(src, 'kotlin').map((b) => b.name).sort();
  assert.deepEqual(names, ['demo.CalcTest.add + subtract round-trip', 'demo.CalcTest.testAdd']);
});

// PRECISION: Gradle's `--tests` filter treats `*` as a WILDCARD (empirically verified: a `parses*`
// selector matched 3 distinct tests). A backtick name may LEGALLY contain `*` (`fun `a * b`()` compiles;
// its JVM method name is `a * b`) — common in a linter/glob test suite. If emitted, the selector would
// match SIBLING tests, so a sibling's mutant-kill could mask THIS block's own hollow → a false PROVEN.
// Gradle has no escape for `*`, so parseBlocks must fail closed and not emit such a block (skip = safe
// under-reach; never a wrong verdict). A normal sibling in the same class is unaffected.
test('parseBlocks kotlin: a backtick name containing "*" (gradle wildcard) is NOT emitted; sibling is', () => {
  const src = `package demo
class T {
    @Test fun \`matches a * b glob\`() { assertEquals(1, glob("a*b")) }
    @Test fun \`plain sibling\`() { assertEquals(2, plain()) }
}`;
  assert.deepEqual(parseBlocks(src, 'kotlin').map((b) => b.name), ['demo.T.plain sibling']);
});

// HARDENING (false-verdict guard): a `{`/`}` or the word `class` inside a backtick test NAME must not
// corrupt the class brace-walk. Before the fix, an unbalanced `}` in A's name truncated Outer's span, so
// sibling B's nested @Test got the classless FQN `p.B.normal` — which, had a real top-level `class B`
// existed, would select the WRONG (passing) test → a false HOLLOW. Backtick interiors are now blanked for
// all brace/`class` scanning, so both nested FQNs stay correct.
test('parseBlocks kotlin: a brace/`class` inside a backtick NAME does not corrupt a sibling nested FQN', () => {
  const src = `package p
class Outer {
    @Nested inner class A { @Test fun \`handles a } and class Foo\`() { assertEquals(1, f()) } }
    @Nested inner class B { @Test fun normal() { assertEquals(2, g()) } }
}`;
  assert.deepEqual(parseBlocks(src, 'kotlin').map((b) => b.name).sort(),
    ['p.Outer$A.handles a } and class Foo', 'p.Outer$B.normal']);
});

test('parseBlocks kotlin: backtick @Test inside a @Nested class IS emitted with the $-joined nested FQN', () => {
  const src = `package demo
class Outer {
    @Nested inner class Inner {
        @Test fun \`does a thing\`() { assertEquals(1, foo()) }
    }
}`;
  assert.deepEqual(parseBlocks(src, 'kotlin').map((b) => b.name), ['demo.Outer$Inner.does a thing']);
});

// IMPORTANT: receiver-method capture is restricted to Capitalized receivers (Type/companion/static
// calls) — a lowercase-variable receiver (list.size(), map.get()) must NOT be captured, else a src/main
// `fun size` would be gutted and the test (which calls List.size) survives → false HOLLOW.
test('receiver capture: capitalized receiver captured, lowercase-variable receiver not; bare calls unchanged', () => {
  assert.ok(!sutFnsIn('assertEquals(3, list.size())', 'kotlin').includes('size'), 'lowercase receiver must not be captured');
  assert.ok(sutFnsIn('assertEquals(9, JCalc.square(3))', 'java').includes('square'), 'capitalized receiver must be captured');
  assert.ok(sutFnsIn('assertEquals(5, add(2, 3))', 'kotlin').includes('add'), 'bare call still captured');
});

// === Trailing-lambda / DSL-call reach lever (RED-first) ==========================================
// Idiomatic Kotlin DSL specs call the SUT as `name { … }` — a trailing-lambda call with NO parens
// (detekt-utils YamlSpec: `val r = yaml { list("k", xs) }`). Two gaps hid it: sutFnsIn's `name(` scan
// never captured the parenless call, and eligibleFns' var-hop matched `const|let|var` (not Kotlin `val`)
// with a paren-ONLY callee scan. Oracles below are hand-derived from the Kotlin call grammar, never
// pinned from the code's own output. Precision-first: a captured name still clears the import/package-
// gated, overload-fail-closed resolver before a single byte is gutted.

test('trailing-lambda: a parenless `yaml { }` call is a sutFnsIn candidate (kotlin)', () => {
  assert.ok(sutFnsIn('val r = yaml { append("x") }', 'kotlin').includes('yaml'));
});

test('trailing-lambda: `val r = yaml { }` pinned by assertEquals credits yaml via the kotlin val-hop', () => {
  const body = 'val result = yaml { append("x") }\n    assertEquals("x", result)';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin'), ['yaml']);
});

// Broader win the same val-hop unlocks: a PAREN-call SUT bound to a Kotlin `val` (`val r = compute(5)`)
// was ALSO unreached, because the pre-existing hop only matched `const|let|var` — `val` (the dominant
// Kotlin idiom) fell through. This is the common `val r = sut(x); assertEquals(exp, r)` shape.
test('kotlin val-hop reaches a paren-call SUT bound to a `val` (was missed: hop was const|let|var only)', () => {
  const body = 'val result = compute(5)\n    assertEquals(25, result)';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin'), ['compute']);
});

// PRECISION (pre-existing bug, owner-authorised fix): the val-hop required `=` IMMEDIATELY after the
// captured name, so an explicit type annotation (`val result: Int = compute(a, b)`, an idiomatic Kotlin
// form) broke the hop entirely — unannotated credited, annotated didn't. An optional `: TYPE` between the
// name and `=` closes this without widening reach elsewhere (a plain `val x: Int = 5` with no call still
// credits nothing).
test('kotlin val-hop reaches a TYPE-ANNOTATED `val` (was missed: `=` had to follow the name immediately)', () => {
  const body = 'val result: Int = compute(2, 3)\n    assertEquals(5, result)';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin'), ['compute']);
});
test('kotlin val-hop: a type-annotated var with NO call on the RHS still credits nothing', () => {
  assert.deepEqual(eligibleFns('val x: Int = 5\n    assertEquals(5, x)', ['compute'], new Map(), 'kotlin'), []);
});

// PRECISION: control-flow keywords and stdlib SCOPE functions take a trailing lambda but are NEVER an
// adopter SUT. A same-named src/main `fun run`/`fun with` gutted while the test invoked the STDLIB form
// would survive → a false HOLLOW. They must never become candidates (excluded for kotlin at the source).
test('trailing-lambda: control-flow (`when`/`try`) and scope fns (`run`/`with`/`apply`) are excluded (kotlin)', () => {
  assert.ok(!sutFnsIn('val x = run { compute() }', 'kotlin').includes('run'), 'run (bare scope fn)');
  assert.ok(!sutFnsIn('val x = with(y) { compute() }', 'kotlin').includes('with'), 'with (paren scope fn — via name( scan)');
  assert.ok(!sutFnsIn('val x = synchronized(lock) { compute() }', 'kotlin').includes('synchronized'), 'synchronized (paren scope)');
  assert.ok(!sutFnsIn('when { true -> 1 }', 'kotlin').includes('when'), 'when (control flow)');
  assert.ok(!sutFnsIn('try { foo() } catch (e: E) { }', 'kotlin').includes('try'), 'try (control flow)');
});

// PRECISION: a receiver-qualified trailing lambda (`obj.build { }`) needs receiver-TYPE inference
// (jvmInstanceSuts' job) — the bare-name path must fail closed on it, or `build` could gut an unrelated
// same-named `fun build`. An Uppercase `Foo { }` is an ambiguous SAM-constructor / type literal → excluded.
test('trailing-lambda: receiver-qualified `obj.build { }` and Uppercase `Foo { }` are NOT captured', () => {
  assert.ok(!sutFnsIn('val x = obj.build { f() }', 'kotlin').includes('build'), 'receiver-qualified needs type inference');
  assert.ok(!sutFnsIn('val t = Thread { r() }', 'kotlin').includes('Thread'), 'uppercase SAM/type literal');
});

// BYTE-IDENTITY: trailing-lambda capture + the kotlin val-hop are kotlin-gated. With no lang argument
// (every pre-existing JS/py call site) they stay inert, and the pre-existing const|let|var JS hop is
// unchanged.
test('trailing-lambda + val-hop inert with no lang; JS const-hop unchanged (byte-identity)', () => {
  assert.ok(!sutFnsIn('val r = yaml { x() }').includes('yaml'), 'no trailing-lambda capture without lang');
  const js = 'const r = compute(5)\nexpect(r).toBe(25)';
  assert.deepEqual(eligibleFns(js, sutFnsIn(js)), ['compute'], 'JS const-hop still credits compute');
});

// PRECISION (adversarial-review CONFIRMED, Java false-HOLLOW): the KOTLIN_SCOPE denylist must be KOTLIN-ONLY.
// Java has no Kotlin scope functions and no trailing-lambda calls, so applying it to Java only DROPS legit
// Java SUT candidates named like a scope fn (`run`/`use`/`with`/…). Dropping the SOUND half of a mixed
// sound/hollow @Test (`assertEquals(3, run(1,2))` next to a hollow self-compare) flips a correctly-CAUGHT
// block to a false HOLLOW. Java `name(` candidates stay byte-identical to pre-change; Kotlin still excludes.
test('KOTLIN_SCOPE denylist is Kotlin-only: a Java SUT named like a scope fn stays a candidate', () => {
  assert.ok(sutFnsIn('assertEquals(3, run(1, 2))', 'java').includes('run'), 'java run must stay a candidate');
  assert.ok(sutFnsIn('assertEquals(1, use(x))', 'java').includes('use'), 'java use must stay a candidate');
  assert.ok(!sutFnsIn('val a = with(y) { compute() }', 'kotlin').includes('with'), 'kotlin with still excluded');
});

// PRECISION (adversarial-review, conditional short-circuit): the Kotlin val-hop must credit ONLY the LEADING
// call of the RHS — the callee whose result IS the var's value. A callee EMBEDDED in a compound expression
// (`provided ?: defaultPort()`, an if/else, a binary op) may be on a dead / short-circuited branch; gutting
// it leaves a SOUND test (`uses the provided port over the default`, provided non-null) green → a false
// HOLLOW. Only a leading `name(` / `name { }` (the value the pinned var actually takes) is credited.
test('kotlin val-hop credits only the LEADING call: an elvis short-circuit branch is not credited (no false HOLLOW)', () => {
  const body = 'val provided: Int? = 3000\n    val port = provided ?: defaultPort()\n    assertEquals(3000, port)';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin'), []);
});

// PRECISION (adversarial, controller-found): a pinned var with a string-literal / blank RHS masks to
// whitespace, so the val-hop's `= <ws>` must NOT swallow the NEWLINE and absorb the NEXT statement's callee.
// Otherwise `var greeting = "hi"` (set directly) followed by `val svc = makeSvc { … }` credits makeSvc to
// greeting → gutting makeSvc while greeting is set independently → survives → a FALSE HOLLOW. The Kotlin
// val-hop must stay strictly same-line (a blank-masked RHS simply yields no callee — correct under-reach).
test('kotlin val-hop stays same-line: a string-RHS var never absorbs the next line’s callee (no false HOLLOW)', () => {
  const body = 'var greeting = "hi"\n    val svc = makeSvc { config() }\n    assertEquals("hi", greeting)';
  assert.deepEqual(eligibleFns(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin'), []);
});

// === Backtick-CLASS residual (RED-first) — close the logged false-verdict family ==================
// A backtick-quoted CLASS name (`class `Weird Name``, rare/non-idiomatic) was invisible to the plain-
// identifier class scan, so an @Test inside it got a SHORTENED class chain (missing that level). Combined
// with an outer class, its @Test emitted a WRONG (shortened) `--tests` selector that can mis-select a
// sibling → a false verdict. Recognizing the backtick class keeps the $-joined chain complete.
test('parseBlocks kotlin: a backtick-named class contributes its level to the $-joined @Test FQN', () => {
  const src = `package p
class Outer {
    @Nested inner class \`Weird Name\` {
        @Test fun foo() { assertEquals(1, f()) }
    }
}`;
  assert.deepEqual(parseBlocks(src, 'kotlin').map((b) => b.name), ['p.Outer$Weird Name.foo']);
});

// PRECISION: a backtick CLASS name may legally contain `*` (a gradle `--tests` wildcard). Recognizing the
// class then re-exposes the `*` over-match at the CLASS level → must fail closed exactly like a `*` method
// name. Before the fix, foo's shortened selector `p.Outer.foo` was emitted WRONG (and could over-match);
// after, foo is correctly seen as inside a `*` class → skipped; the plain sibling still emits.
test('parseBlocks kotlin: a backtick class name containing "*" fails closed; plain-class sibling still emits', () => {
  const src = `package p
class Outer {
    @Nested inner class \`a * b\` { @Test fun foo() { assertEquals(1, f()) } }
    @Nested inner class Plain { @Test fun bar() { assertEquals(2, g()) } }
}`;
  assert.deepEqual(parseBlocks(src, 'kotlin').map((b) => b.name), ['p.Outer$Plain.bar']);
});

// === Kotlin expression-bodied @Test block delimitation (RED-first, Bug B) ========================
// An expression-bodied @Test (`@Test fun a() = assertEquals(...)`, no braces of its own) used to make
// parseBlocks' brace-only scan skip forward past it to the NEXT brace-bodied test's `{...}` — misattributing
// a sibling's body to this block. Confirmed on a real Kotlin app: `litCount_atMin_isZero`'s captured body
// came back as a DIFFERENT test's `assertEquals(-78f, segmentCenterDb(...))` call, wrongly crediting
// segmentCenterDb and reporting the block hollow. Each block must get its OWN body, never a sibling's.
test("parseBlocks kotlin: an expression-bodied @Test gets its OWN body, not the next brace-bodied test's (Bug B)", () => {
  const src = `package demo
class T {
    @Test fun a() = assertEquals(0, foo(1))
    @Test fun b() { assertEquals(-1f, bar(2)) }
}`;
  const blocks = parseBlocks(src, 'kotlin');
  const a = blocks.find((blk) => blk.name.endsWith('.a'));
  const b = blocks.find((blk) => blk.name.endsWith('.b'));
  assert.ok(a, 'block a must be emitted');
  assert.ok(a.body.includes('foo(1)'), `a's body must contain its OWN call: ${JSON.stringify(a && a.body)}`);
  assert.ok(!a.body.includes('bar(2)'), `a's body must NOT contain b's call (block misattribution): ${JSON.stringify(a && a.body)}`);
  assert.ok(b && b.body.includes('bar(2)'), 'block b must keep its own body');
});

// Positive control: a lone expression-bodied @Test (no following brace-bodied sibling to steal from) must
// still be captured with its own body — the fix must not turn it into a skip.
test('parseBlocks kotlin: a lone expression-bodied @Test (no following sibling) is still captured', () => {
  const src = `package demo
class T {
    @Test fun onlyExpr() = assertEquals(3, add(1, 2))
}`;
  const blocks = parseBlocks(src, 'kotlin');
  assert.deepEqual(blocks.map((blk) => blk.name), ['demo.T.onlyExpr']);
  assert.ok(blocks[0].body.includes('add(1, 2)'), blocks[0].body);
});

// Positive control: a brace-bodied @Test followed by an expression-bodied sibling (reversed order) stays
// correctly delimited both ways — the fix must not be direction-dependent.
test('parseBlocks kotlin: brace-bodied @Test before an expression-bodied sibling stays correctly delimited', () => {
  const src = `package demo
class T {
    @Test fun brace() { assertEquals(1, foo()) }
    @Test fun expr() = assertEquals(2, bar())
}`;
  const blocks = parseBlocks(src, 'kotlin');
  const brace = blocks.find((blk) => blk.name.endsWith('.brace'));
  const expr = blocks.find((blk) => blk.name.endsWith('.expr'));
  assert.ok(brace.body.includes('foo()') && !brace.body.includes('bar()'), brace.body);
  assert.ok(expr.body.includes('bar()') && !expr.body.includes('foo()'), expr.body);
});

// Positive control: a Java @Test (always brace-bodied — Java has no expression-bodied methods) is
// unaffected by the Kotlin-only fix.
test('parseBlocks java: a Java @Test (always brace-bodied) is unaffected by the kotlin expression-body fix', () => {
  const src = `package demo;
class T {
    @Test void t() { assertEquals(1, foo()); }
}`;
  const blocks = parseBlocks(src, 'java');
  assert.deepEqual(blocks.map((blk) => blk.name), ['demo.T.t']);
  assert.ok(blocks[0].body.includes('foo()'));
});

// ---- eligibleFnsDetail: the pin/eligibility split (public issue #3). A Kotlin destructuring declaration
// `val (a, b) = call()` is invisible to the val-hop (its LHS is not a single identifier), so the fn is not
// eligible — but the block DID pin literals, and reporting it 'no-pin' ("only checks a mock / no value
// pinned") asserts a property of the test the probe never established. The detail form states both facts
// separately so the caller can say "a pin exists; the scanner can't link it" instead. Oracle hand-derived
// from the source text (5.0f/4.8f are literal pins; no hop shape links lengthM to boundingBoxM).
test('eligibleFnsDetail kotlin: destructuring val — pins recognized (hadPin) but no eligible link', () => {
  const body = `val (lengthM, widthM) = Geometry2.boundingBoxM(lShape)
assertEquals(5.0f, lengthM, 1e-4f)
assertEquals(4.8f, widthM, 1e-4f)`;
  const d = eligibleFnsDetail(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin');
  assert.deepEqual(d.eligible, [], 'destructuring LHS: the val-hop cannot link the pinned vars');
  assert.equal(d.hadPin, true, 'the literal pins are real and must be stated as found');
});

test('eligibleFnsDetail kotlin: plain val-hop still links, hadPin true (control)', () => {
  const body = `val area = computeArea(sq)
assertEquals(12.0f, area, 1e-4f)`;
  const d = eligibleFnsDetail(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin');
  assert.deepEqual(d.eligible, ['computeArea']);
  assert.equal(d.hadPin, true);
});

test('eligibleFnsDetail: a weak-only body has no pin at all — hadPin false (no-pin stays honest)', () => {
  const body = 'assertTrue(isPositive(5))';
  const d = eligibleFnsDetail(body, sutFnsIn(body, 'kotlin'), new Map(), 'kotlin');
  assert.deepEqual(d.eligible, []);
  assert.equal(d.hadPin, false);
});

// === JVM relational vocabulary (Task 4, RED-first) ================================================
// assertTrue/assertFalse over a top-level comparison, AssertJ's directional matchers, and the kotlin.test
// trailing-lambda assertTrue/assertFalse { … } form all land in the RELATIONAL kind (never value) —
// provable (mutant red) but never able to convict (survive → hollow), same asymmetry as the JS/pytest
// relational vocabulary. The pre-existing plain-truthiness exclusion (assertTrue(isPositive(5))) must
// hold untouched: it has no top-level comparator, so it stays out of BOTH kinds.

test('relational: assertTrue with a top-level comparison is relational-eligible (kotlin)', () => {
  const body = `assertTrue(computeScore(x) > threshold(y))`;
  const d = eligibleFnsDetail(body, ['computeScore', 'threshold'], new Map(), 'kotlin');
  assert.deepEqual([...d.eligible].sort(), ['computeScore', 'threshold']);
  assert.deepEqual([...d.relationalOnly].sort(), ['computeScore', 'threshold']);
});

test('relational: plain truthiness assertTrue stays out — the pre-existing weak-matcher oracle holds', () => {
  const d = eligibleFnsDetail(`assertTrue(isPositive(5))`, ['isPositive'], new Map(), 'kotlin');
  assert.deepEqual(d.eligible, []);
});

test('relational: kotlin.test trailing-lambda assertTrue { a > b } is relational-eligible', () => {
  const d = eligibleFnsDetail(`assertTrue { computeScore(x) > 0 }`, ['computeScore'], new Map(), 'kotlin');
  assert.deepEqual(d.eligible, ['computeScore']);
  assert.deepEqual(d.relationalOnly, ['computeScore']);
});

test('relational: AssertJ isGreaterThan pushes both actual and expected sides (java)', () => {
  const d = eligibleFnsDetail(`assertThat(computeScore(x)).isGreaterThan(floor(y));`, ['computeScore', 'floor'], new Map(), 'java');
  assert.deepEqual([...d.eligible].sort(), ['computeScore', 'floor'].sort());
  assert.deepEqual([...d.relationalOnly].sort(), ['computeScore', 'floor'].sort());
});

test('relational: assertFalse comparison form is admitted; boolean-joined arg is not', () => {
  const rel = eligibleFnsDetail(`assertFalse(computeScore(x) <= 0)`, ['computeScore'], new Map(), 'kotlin');
  assert.deepEqual(rel.relationalOnly, ['computeScore']);
  const joined = eligibleFnsDetail(`assertTrue(a(x) > 0 && b(x) > 0)`, ['a', 'b'], new Map(), 'kotlin');
  assert.deepEqual(joined.eligible, []);
});

// === Kotlin val-hop: receiver'd object/singleton call reach (field report #3, RED-first) =========
// The val-hop's kotlinLeadingCall only credits a BARE lowercase head (`val x = foo(...)`); a receiver'd
// object/singleton head (`val x = Modes.speedOfSound(...)`) — the DOMINANT idiom in a Kotlin codebase
// built from `object Foo { fun bar() }` singletons — fell through to `pin-unresolved`, even though the
// direct/inline sibling shape (`assertEquals(exp, Modes.speedOfSound(...))`) already reaches fine (path 1,
// substring crediting). Fixed via kotlinReceiverCall: credit the head `Receiver.method(` ONLY when
// Receiver is Uppercase AND present in the test file's import map (an imported object/class/companion —
// never a local/param/mock var, never a same-package type with no import line). Oracles hand-derived from
// the report's reproduction (AcoustiQ StiEstimateTest/DspModuleTest) and the regex's own documented shape
// — never pinned from the code's own output.

test("kotlin val-hop credits a receiver'd object call: val c = Modes.speedOfSound(...) (was pin-unresolved)", () => {
  const body = 'val c = Modes.speedOfSound(20f, 0f)\n    assertEquals(343.359f, c, 0.05f)';
  const imports = new Map([['Modes', 'com.roomacoustics.audio.Modes']]);
  const d = eligibleFnsDetail(body, ['speedOfSound'], imports, 'kotlin');
  assert.deepEqual(d.eligible, ['speedOfSound']);
});

test("kotlin val-hop, relational: two receiver'd vals compared by assertTrue credit the fn as relationalOnly (never value)", () => {
  const body = 'val a = Foo.score(x)\n    val b = Foo.score(y)\n    assertTrue(a > b)';
  const imports = new Map([['Foo', 'com.acme.Foo']]);
  const d = eligibleFnsDetail(body, ['score'], imports, 'kotlin');
  assert.deepEqual(d.eligible, ['score']);
  assert.deepEqual(d.relationalOnly, ['score'], 'must land in relationalOnly — preserves the can-prove-never-convict asymmetry');
  assert.equal(d.hadValuePin, false, 'no value pin exists here, only the relational one');
});

test('kotlin val-hop, must-NOT-credit: a LOCAL (non-imported) lowercase receiver stays uncredited', () => {
  const body = 'val x = repo.find(id)\n    assertEquals(exp, x)';
  const d = eligibleFnsDetail(body, ['find'], new Map(), 'kotlin'); // repo is not in imports at all
  assert.deepEqual(d.eligible, []);
});

test('kotlin val-hop, must-NOT-credit: an elvis-embedded receiver call is a dead branch (^ anchor rejects; head is `cond`)', () => {
  const body = 'val x = cond ?: Foo.bar()\n    assertEquals(exp, x)';
  const imports = new Map([['Foo', 'com.acme.Foo']]);
  const d = eligibleFnsDetail(body, ['bar'], imports, 'kotlin');
  assert.deepEqual(d.eligible, []);
});

test('kotlin val-hop, must-NOT-credit: an if/else-embedded receiver call is a dead branch (head is `if`)', () => {
  const body = 'val x = if (c) Foo.a() else Foo.b()\n    assertEquals(exp, x)';
  const imports = new Map([['Foo', 'com.acme.Foo']]);
  const d = eligibleFnsDetail(body, ['a', 'b'], imports, 'kotlin');
  assert.deepEqual(d.eligible, []);
});

// Ruling 5 (deliberate under-reach, controller-decided): the import gate IS the moat — a same-package
// receiver'd call with NO import line for it (imports.has(receiver) false) stays uncredited, exactly like
// an un-imported bare call already does elsewhere. This is the same shape as the must-credit fixture
// above, with the import binding removed — isolates the import-gate itself as the deciding factor.
test('kotlin val-hop, deliberate under-reach: an Uppercase receiver NOT in the import map stays uncredited (same-package, no import line)', () => {
  const body = 'val c = Modes.speedOfSound(20f, 0f)\n    assertEquals(343.359f, c, 0.05f)';
  const d = eligibleFnsDetail(body, ['speedOfSound'], new Map(), 'kotlin'); // Modes deliberately absent from imports
  assert.deepEqual(d.eligible, []);
});

// Ruling 1 (controller-decided, chained/nested receivers OUT of scope): kotlinReceiverCall is a SINGLE
// hop anchored at `^` — for `A.b().c(1)` the regex's head match is `A.b(` (group1=A, group2=b); `c` is
// never in that match at all, so it can NEVER be credited via this hop regardless of what candidateFns
// contains. Pinned with candidateFns=['c'] ONLY (b deliberately excluded) so the assertion isolates
// exactly that invariant — not an accidental side effect of b also being absent.
test("kotlin val-hop, chained receiver A.b().c(...) — single hop only: 'c' is NEVER credited (out of scope)", () => {
  const body = 'val x = A.b().c(1)\n    assertEquals(exp, x)';
  const imports = new Map([['A', 'com.acme.A']]);
  const d = eligibleFnsDetail(body, ['c'], imports, 'kotlin');
  assert.deepEqual(d.eligible, [], "'c' (the second hop) must never be credited — chained receivers are single-hop only");
});

// Documents the OTHER half of ruling 1's safety argument: the first hop (`b`, from `A.b(`) IS credited
// when `b` itself is a candidate fn — accepted per the report's head-anchor argument (`A.b()` is always-
// evaluated, no dead branch, so gutting `b` genuinely changes the chain's result whenever the chain isn't
// value-absorbing) — the SAME acceptance already implicit in path 1's plain substring crediting of a
// nested call. This is a demonstration of accepted behavior, not a must-NOT-credit guard.
test("kotlin val-hop, chained receiver A.b().c(...): the FIRST hop 'b' IS credited when it is itself a candidate (accepted, documents ruling 1)", () => {
  const body = 'val x = A.b().c(1)\n    assertEquals(exp, x)';
  const imports = new Map([['A', 'com.acme.A']]);
  const d = eligibleFnsDetail(body, ['b'], imports, 'kotlin');
  assert.deepEqual(d.eligible, ['b']);
});

// Ruling 2 (controller-decided): a companion/nested-object receiver (`Outer.Inner.method(...)`) must fall
// through with NO credit. `imports.has('Outer')` may hold, but the regex's second group requires a
// LOWERCASE-initial token immediately after the first dot — `Inner` is Uppercase, so the whole `^`-anchored
// match fails outright (no backtracking finds a later dot to retry against) → kotlinReceiverCall returns
// null → safe under-reach, exactly as the report predicted.
test("kotlin val-hop, nested/companion receiver Outer.Inner.method(...) falls through — no credit", () => {
  const body = 'val x = Outer.Inner.method(1)\n    assertEquals(exp, x)';
  const imports = new Map([['Outer', 'com.acme.Outer']]);
  const d = eligibleFnsDetail(body, ['method'], imports, 'kotlin');
  assert.deepEqual(d.eligible, []);
});

// Ruling 4 (controller-decided, out of scope this pass): the receiver'd val-hop is KOTLIN-GATED ONLY,
// exactly like the pre-existing val-hop it extends — a Java `var` binding to the SAME shape must stay
// uncredited. (Java's shared JS-style const/let/var hop already excludes a dotted receiver via
// topLevelCallees, independent of this fix — this pins that the NEW kotlinReceiverCall path specifically
// never runs for lang: 'java'.)
test("kotlin val-hop, Java analogue is OUT of scope (evaluated-surface decision): java 'var' binding to a receiver'd call stays uncredited", () => {
  const body = 'var c = Modes.speedOfSound(20f, 0f);\n    assertEquals(343.359f, c, 0.05f);';
  const imports = new Map([['Modes', 'com.roomacoustics.audio.Modes']]);
  const d = eligibleFnsDetail(body, ['speedOfSound'], imports, 'java');
  assert.deepEqual(d.eligible, []);
});
