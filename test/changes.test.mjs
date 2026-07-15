import { test } from 'node:test';
import assert from 'node:assert';
import { declaredFns, hunkNewRanges, changedDecls, classifyChanges } from '../mutation/changes.mjs';
import { grossBreak } from '../mutation/probe.mjs';

const JS = `export function alpha(x) {
  return x + 1;
}
const beta = (a, b) => {
  return a * b;
};
export async function gamma() {
  return 1;
}
function* delta() { yield 1; }
class Widget {
  method(x) { return x; }
}
// function commentFn() {}
const s = "function stringFn() {}";
`;

test('declaredFns enumerates top-level guttable forms, plus class/object methods, and nothing else', () => {
  const fns = declaredFns(JS, 'js').map((d) => d.fn);
  assert.deepEqual(fns.sort(), ['alpha', 'beta', 'delta', 'gamma', 'method']);
});

test('declaredFns line/endLine spans cover the body', () => {
  const alpha = declaredFns(JS, 'js').find((d) => d.fn === 'alpha');
  assert.equal(alpha.line, 1);
  assert.equal(alpha.endLine, 3);
});

test('declaredFns python: def forms with indent-based end, including indented (class method) defs', () => {
  const PY = 'def top(x):\n    return x\n\nclass C:\n    def method(self):\n        return 1\n\ndef last():\n    pass\n';
  const fns = declaredFns(PY, 'python');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['last', 'method', 'top']); // indented def now enumerated
  const top = fns.find((d) => d.fn === 'top');
  assert.equal(top.line, 1); assert.equal(top.endLine, 2); // top-level span unchanged (byte-identical)
  const method = fns.find((d) => d.fn === 'method');
  assert.equal(method.line, 5); assert.equal(method.endLine, 6); // dedent to `def last` (col 0) ends it
});

// GRAMMAR SYNC (behavioral, fixture-driven, both directions):
// Direction 1 — enumerated ⊆ guttable: every form declaredFns enumerates, grossBreak can gut, so
// report reach never exceeds probe reach (asserted here and in the extension tests below). Class
// methods and object-shorthand methods are now ENUMERATED (Fix A, changes.mjs's jsMethodDecls) and
// GUTTABLE (Fix B, probe.mjs's locateBareMethod, pass 2 of locateBody) — a deliberate flip from the
// old "excluded AND ungettable" behavior this test used to pin; the recall gap it closes (a diff
// touching only class methods used to contribute zero rows) is documented in changes.mjs's header.
// Direction 2 — the one form the probe CAN gut that declaredFns still deliberately does not enumerate
// (the `:`-bound object-property function EXPRESSION value) is pinned by the known-delta test below.
// Report reach can never silently diverge from probe reach in either direction without a test going red.
test('grammar sync: every enumerated decl is guttable, including the class method (deliberate flip)', () => {
  const fns = declaredFns(JS, 'js').map((d) => d.fn).sort();
  assert.deepEqual(fns, ['alpha', 'beta', 'delta', 'gamma', 'method']);
  for (const d of declaredFns(JS, 'js')) {
    const broken = grossBreak(JS, d.fn, 'typescript');
    assert.ok(broken !== null && broken !== JS, `grossBreak must gut ${d.fn}`);
  }
});

// Export-default declaration variants: enumerated AND guttable (both directions of the sync).
// (Multiple `export default` in one string is fine — the fixture is analyzed, never executed.)
const JS_EXT = `export default function epsilon(n) {
  return n * 2;
}
export default async function eta() {
  return 4;
}
export default function* theta() { yield 2; }
const obj = {
  omega: function () { return 9; },
};
`;

test('grammar sync (export default): default fn/async fn/generator are enumerated AND guttable', () => {
  const fns = declaredFns(JS_EXT, 'js');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['epsilon', 'eta', 'theta']);
  for (const d of fns) {
    const broken = grossBreak(JS_EXT, d.fn, 'typescript');
    assert.ok(broken !== null && broken !== JS_EXT, `grossBreak must gut ${d.fn}`);
  }
});

test('grammar sync (python): column-0 async def AND indented async def are both enumerated AND guttable (deliberate flip)', () => {
  const PY = 'async def fetch(x):\n    return x\n\nclass C:\n    async def m(self):\n        return 1\n';
  const fns = declaredFns(PY, 'python');
  assert.deepEqual(fns.map((d) => d.fn), ['fetch', 'm']);
  assert.equal(fns[0].line, 1);
  assert.equal(fns[0].endLine, 2);
  for (const d of fns) {
    const broken = grossBreak(PY, d.fn, 'python');
    assert.ok(broken !== null && broken !== PY, `grossBreak must gut ${d.fn}`);
  }
});

// ONE-LINE inline-body defs (top-level AND indented method) are ENUMERATED and VALIDLY GUTTABLE — the
// mutant is an in-place `return 987654321` on the def line, NOT an appended indented return (which would
// be an IndentationError → module fails to import → the probe reports an unearned SOUND). Locks the
// one-line shape into the grammar-sync invariant.
test('grammar sync (python): one-line inline-body defs (top-level + indented method) are enumerated AND validly guttable', () => {
  const PY1 = 'def g(x): return x*2\n\nclass C:\n    def m(self, x): return x*2\n';
  const fns = declaredFns(PY1, 'python');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['g', 'm']);
  for (const d of fns) {
    const broken = grossBreak(PY1, d.fn, 'python');
    assert.ok(broken !== null && broken !== PY1, `grossBreak must gut ${d.fn}`);
    assert.match(broken, /: return 987654321/, `${d.fn} gut in place on the def line (no IndentationError)`);
    assert.doesNotMatch(broken, /\n\s+return 987654321\n\s*def/, `${d.fn}: no misindented appended return`);
  }
});

// KNOWN DELTA (deliberate, precision-first — documented in the mutation/changes.mjs header): a
// top-level object-property function value IS guttable by the probe but is NOT enumerated by
// declaredFns, because line-anchored enumeration cannot tell an exported API object from a nested
// config literal. This test pins the delta from BOTH sides so it can neither silently widen (form
// becomes ungettable → probe regressed) nor silently close (form becomes enumerated → precision
// decision overturned without a test change).
test('known delta: object-property function value is guttable but deliberately unenumerated', () => {
  const broken = grossBreak(JS_EXT, 'omega', 'typescript');
  assert.ok(broken !== null && broken !== JS_EXT, 'omega IS guttable by the probe');
  assert.ok(!declaredFns(JS_EXT, 'js').some((d) => d.fn === 'omega'),
    'omega must stay unenumerated (the documented known delta)');
});

// CLASS/OBJECT METHOD RECALL (this fix): (a) two class methods, both enumerated with correct spans,
// and the first method's span must NOT swallow the second's declaration line.
test('declaredFns: a JS class with two methods — both enumerated, spans do not swallow each other', () => {
  const CLS2 = `class Two {
  first(a) {
    return a + 1;
  }
  second(b) {
    return b * 2;
  }
}
`;
  const fns = declaredFns(CLS2, 'js');
  const first = fns.find((d) => d.fn === 'first');
  const second = fns.find((d) => d.fn === 'second');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['first', 'second']);
  assert.equal(first.line, 2); assert.equal(first.endLine, 4);
  assert.equal(second.line, 5); assert.equal(second.endLine, 7);
  assert.ok(first.endLine < second.line, "first's span must not reach into second's declaration line");
});

// (b) object-shorthand methods: both enumerated.
test('declaredFns: object-shorthand methods are both enumerated', () => {
  const OBJ = 'const o = { foo(){}, bar(){} };';
  assert.deepEqual(declaredFns(OBJ, 'js').map((d) => d.fn).sort(), ['bar', 'foo']);
});

// (c) a Python class with two indented methods — both enumerated, spans do not swallow each other.
test('declaredFns: a Python class with two indented methods — both enumerated, spans do not swallow each other', () => {
  const PY = 'class P:\n    def m1(self):\n        return 1\n\n    def m2(self):\n        return 2\n';
  const fns = declaredFns(PY, 'python');
  const m1 = fns.find((d) => d.fn === 'm1');
  const m2 = fns.find((d) => d.fn === 'm2');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['m1', 'm2']);
  assert.equal(m1.line, 2); assert.equal(m1.endLine, 3);
  assert.equal(m2.line, 5); assert.equal(m2.endLine, 6);
  assert.ok(m1.endLine < m2.line, "m1's span must not reach into m2's declaration line");
});

// (d) DECL-VS-CALL: a call site on its own line, `if (cond) {`, and `while (bar()) {` must never be
// enumerated as decls (no phantom fn from control flow or a bare call).
test('declaredFns: call sites and control flow are never phantom method decls (JS)', () => {
  const CALLS = `function run() {
  foo(x);
  if (cond) {
    doThing();
  }
  while (bar()) {
    spin();
  }
}
`;
  assert.deepEqual(declaredFns(CALLS, 'js').map((d) => d.fn), ['run']);
});

// (e) PRECISION regression: a top-level function and a same-named class method both exist — grossBreak
// must gut the TOP-LEVEL function (pass 1 of locateBody wins outright), never the method. This is the
// two-pass mechanism's core safety guarantee: pass 2 (the bare-method locator) never even runs when
// pass 1 already found something.
test('grossBreak precision regression: a top-level function wins over a same-named class method', () => {
  const code = `function foo() {
  return 1;
}
class C {
  foo() {
    return 2;
  }
}
`;
  const out = grossBreak(code, 'foo', 'typescript');
  assert.match(out, /function foo\(\) \{\s*return 987654321;\s*\}/, 'the top-level function is gutted');
  assert.match(out, /foo\(\) \{\s*return 2;\s*\}/, "the method's body is untouched");
});

// JVM (Task 9): Kotlin/Java declaration enumeration — FUNCTIONS/METHODS ONLY (classes/objects/
// interfaces/enums are not enumerated because grossBreak can't gut them; locked by the grammar-sync
// test below, mirroring the JS 'class methods excluded AND ungettable' test at the top of this file).
// Mirrors prove.mjs's declRe/locateJvmBody decl-vs-call discipline (a call site shaped like a decl,
// e.g. `new Runnable() {`, must not become a phantom fn — pinned by the regression test below).
const KT = `fun add(a: Int, b: Int): Int {
    return a + b
}
fun square(x: Int): Int {
    return x * x
}
`;

test('declaredFns kotlin: two top-level funs with correct line/endLine', () => {
  const fns = declaredFns(KT, 'kotlin');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['add', 'square']);
  const add = fns.find((d) => d.fn === 'add');
  assert.equal(add.line, 1); assert.equal(add.endLine, 3);
  const square = fns.find((d) => d.fn === 'square');
  assert.equal(square.line, 4); assert.equal(square.endLine, 6);
});

test('changedDecls kotlin: hunk over one fn returns only that fn', () => {
  assert.deepEqual(changedDecls(KT, 'kotlin', [[4, 4]]).map((d) => d.fn), ['square']);
});

test('declaredFns kotlin: receiver form `fun Foo.bar(` names the fn `bar`', () => {
  const KT_RECV = 'fun Foo.bar(x: Int): Int {\n    return x\n}\n';
  assert.deepEqual(declaredFns(KT_RECV, 'kotlin').map((d) => d.fn), ['bar']);
});

test('declaredFns kotlin: expression-bodied fun has endLine === line', () => {
  const KT_EXPR = 'fun double(x: Int) = x * 2\n';
  const fns = declaredFns(KT_EXPR, 'kotlin');
  assert.equal(fns.length, 1);
  assert.equal(fns[0].fn, 'double');
  assert.equal(fns[0].line, 1);
  assert.equal(fns[0].endLine, 1);
});

test('declaredFns kotlin: block-bodied fn endLine is the closing brace, does not swallow the next fn', () => {
  const KT_MULTI = `fun compute(a: Int, b: Int): Int {
    val sum = a + b
    val doubled = sum * 2
    return doubled
}
fun next(x: Int): Int {
    return x + 1
}
`;
  const fns = declaredFns(KT_MULTI, 'kotlin');
  const compute = fns.find((d) => d.fn === 'compute');
  const next = fns.find((d) => d.fn === 'next');
  assert.equal(compute.line, 1);
  assert.equal(compute.endLine, 5); // the closing "}" line
  assert.ok(compute.endLine < next.line, "compute's span must not reach into next's declaration line");
  assert.equal(next.line, 6);
  assert.equal(next.endLine, 8);
});

const JAVA = `class Calculator {
    int add(int a, int b) {
        return a + b;
    }
    int square(int x) {
        return x * x;
    }
}
`;

test('declaredFns java: class with two methods — both methods found, class name NOT enumerated', () => {
  const fns = declaredFns(JAVA, 'java').map((d) => d.fn).sort();
  assert.deepEqual(fns, ['add', 'square']); // exactly the two methods; `Calculator` is not a fn
});

test('changedDecls java: hunk over one method returns only that method', () => {
  assert.deepEqual(changedDecls(JAVA, 'java', [[5, 5]]).map((d) => d.fn), ['square']);
});

test('declaredFns java: anonymous-class instantiation is not a phantom decl (`new Runnable() {`)', () => {
  const ANON = `void schedule() {
    Runnable r = new Runnable() {
        public void run() {
            doWork();
        }
    };
}
`;
  const fns = declaredFns(ANON, 'java').map((d) => d.fn);
  assert.ok(!fns.includes('Runnable'), 'the `new Runnable() {` call site must not read as a decl of Runnable');
  assert.ok(fns.includes('schedule'));
  assert.ok(fns.includes('run'));
});

// GRAMMAR SYNC (JVM) — mirrors the JS 'class methods excluded AND ungettable' test above: every name
// declaredFns enumerates for a .kt/.java file must be guttable by grossBreak (so report reach never
// exceeds probe reach), AND a class/object/interface/enum name must NOT be enumerated (grossBreak
// returns null for a type declaration — enumerating one would be a permanently untested/unverifiable
// phantom row corrupting changeSummary). This locks the invariant for JVM the way line ~49 locks it for JS.
test('grammar sync (kotlin): every enumerated decl is guttable; class/object names excluded AND ungettable', () => {
  const KT_CLS = `class Calc {
    fun add(a: Int, b: Int): Int {
        return a + b
    }
}
object Helper {
    fun square(x: Int): Int = x * x
}
`;
  const fns = declaredFns(KT_CLS, 'kotlin').map((d) => d.fn).sort();
  assert.deepEqual(fns, ['add', 'square']); // the member funs only — NOT Calc, NOT Helper
  for (const fn of fns) {
    const broken = grossBreak(KT_CLS, fn, 'kotlin');
    assert.ok(broken !== null && broken !== KT_CLS, `grossBreak must gut ${fn}`);
  }
  assert.equal(grossBreak(KT_CLS, 'Calc', 'kotlin'), null, 'a Kotlin class name is ungettable AND unenumerated');
  assert.equal(grossBreak(KT_CLS, 'Helper', 'kotlin'), null, 'a Kotlin object name is ungettable AND unenumerated');
});

test('grammar sync (java): every enumerated decl is guttable; class/interface/enum names excluded AND ungettable', () => {
  const JAVA_CLS = `class Calculator {
    int add(int a, int b) {
        return a + b;
    }
    int square(int x) {
        return x * x;
    }
}
enum Color { RED, GREEN }
`;
  const fns = declaredFns(JAVA_CLS, 'java').map((d) => d.fn).sort();
  assert.deepEqual(fns, ['add', 'square']); // the methods only — NOT Calculator, NOT Color
  for (const fn of fns) {
    const broken = grossBreak(JAVA_CLS, fn, 'java');
    assert.ok(broken !== null && broken !== JAVA_CLS, `grossBreak must gut ${fn}`);
  }
  assert.equal(grossBreak(JAVA_CLS, 'Calculator', 'java'), null, 'a Java class name is ungettable AND unenumerated');
  assert.equal(grossBreak(JAVA_CLS, 'Color', 'java'), null, 'a Java enum name is ungettable AND unenumerated');
});

// DECL-VS-CALL regression: control-flow calls and a bare call must NEVER read as declarations. Verified
// to hold today; this pins it so a future regex tweak can't silently start emitting phantom fns.
test('declaredFns kotlin: control-flow calls and a bare call are not phantom decls', () => {
  const KT_CALLS = `fun run() {
    if (foo()) {
    }
    while (bar()) {
    }
    baz(x)
}
`;
  const fns = declaredFns(KT_CALLS, 'kotlin').map((d) => d.fn);
  assert.deepEqual(fns, ['run']); // ONLY the real fun — never foo/bar/baz
});

test('declaredFns java: control-flow calls and a bare call are not phantom decls', () => {
  const JAVA_CALLS = `void run() {
    if (foo()) {
    }
    while (bar()) {
    }
    if (a) {
    } else if (x()) {
    }
    baz(y);
}
`;
  const fns = declaredFns(JAVA_CALLS, 'java').map((d) => d.fn);
  assert.deepEqual(fns, ['run']); // ONLY the real method — never foo/bar/x/baz
});

test('hunkNewRanges parses new-side ranges incl. deletion-only and single-line hunks', () => {
  const diff = `@@ -1,2 +1,3 @@\n@@ -10,0 +14 @@\n@@ -20,5 +30,0 @@\n`;
  assert.deepEqual(hunkNewRanges(diff), [[1, 3], [14, 14], [30, 30]]);
});

test('changedDecls: intersection picks only the touched function; null ranges = all', () => {
  const decls = declaredFns(JS, 'js');
  assert.deepEqual(changedDecls(JS, 'js', [[5, 5]]).map((d) => d.fn), ['beta']);
  assert.equal(changedDecls(JS, 'js', null).length, decls.length);
});

test('classifyChanges: four statuses with exact evidence shapes', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'hunk', decls: [
    { fn: 'provenFn', line: 1, endLine: 3 }, { fn: 'hollowFn', line: 5, endLine: 7 },
    { fn: 'unvFn', line: 9, endLine: 11 }, { fn: 'ghostFn', line: 13, endLine: 15 },
  ]}];
  const blocks = [
    { file: 't/1.test.mjs', line: 2, name: 'catches', bodyMasked: 'expect(provenFn(1)).toBe(2)', verdict: 'caught', caughtFns: ['provenFn'], caughtPairs: [{ fn: 'provenFn', sutRel: 'src/a.mjs' }] },
    { file: 't/1.test.mjs', line: 9, name: 'circular', bodyMasked: 'const e = hollowFn(1); expect(hollowFn(1)).toBe(e)', verdict: 'hollow', survivors: ['hollowFn'], survivorPairs: [{ fn: 'hollowFn', sutRel: 'src/a.mjs' }] },
    { file: 't/2.test.mjs', line: 3, name: 'weak-ref', bodyMasked: 'expect(unvFn(1)).toBeDefined()', verdict: 'skipped', why: 'no-pin' },
  ];
  const { changes, changeSummary } = classifyChanges(changed, blocks);
  const by = Object.fromEntries(changes.map((c) => [c.fn, c]));
  // provenFn: in caughtFns of one caught block → proven, evidence lists that block. sameDiffOracle: false
  // — the fixture's block carries no `testChanged` (undefined !== true), the honest default.
  assert.equal(by.provenFn.status, 'proven');
  assert.deepEqual(by.provenFn.evidence, { blocks: [{ file: 't/1.test.mjs', line: 2, name: 'catches' }], sameDiffOracle: false });
  // hollowFn: in survivors → hollow
  assert.equal(by.hollowFn.status, 'hollow');
  // unvFn: referenced (word-boundary) by a skipped block, no verdict → unverifiable, reason no-pin ×1
  assert.equal(by.unvFn.status, 'unverifiable');
  assert.deepEqual(by.unvFn.evidence.reasons, { 'no-pin': 1 });
  // ghostFn: referenced nowhere → untested, empty evidence
  assert.equal(by.ghostFn.status, 'untested');
  assert.deepEqual(by.ghostFn.evidence, {});
  // summary: 4 fns, 1 file — counts derived by hand from the rows above; notProbed/sameDiffProven are 0
  // (no probe-cap row, no same-diff-oracle row in this fixture).
  assert.deepEqual(changeSummary, { files: 1, fns: 4, proven: 1, hollow: 1, unverifiable: 1, untested: 1, notProbed: 0, sameDiffProven: 0 });
});

test('classifyChanges: proven beats unverifiable when a fn appears in several blocks', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'file', decls: [{ fn: 'f', line: 1, endLine: 2 }] }];
  const blocks = [
    { file: 't', line: 1, name: 'x', bodyMasked: 'f(1)', verdict: 'skipped', why: 'no-pin' },
    { file: 't', line: 5, name: 'y', bodyMasked: 'expect(f(1)).toBe(1)', verdict: 'caught', caughtFns: ['f'], caughtPairs: [{ fn: 'f', sutRel: 'src/a.mjs' }] },
  ];
  assert.equal(classifyChanges(changed, blocks).changes[0].status, 'proven');
});

test('classifyChanges: hollow beats proven — one surviving mutant is a hole even when another test catches the fn', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'hunk', decls: [{ fn: 'f', line: 1, endLine: 2 }] }];
  const blocks = [
    { file: 't', line: 1, name: 'sound', bodyMasked: 'expect(f(1)).toBe(2)', verdict: 'caught', caughtFns: ['f'], caughtPairs: [{ fn: 'f', sutRel: 'src/a.mjs' }] },
    { file: 't', line: 5, name: 'circular', bodyMasked: 'const e = f(1); expect(f(1)).toBe(e)', verdict: 'hollow', survivors: ['f'], survivorPairs: [{ fn: 'f', sutRel: 'src/a.mjs' }] },
  ];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'hollow');
  // evidence lists only the hollow block — the hole, not the catch
  assert.deepEqual(changes[0].evidence, { blocks: [{ file: 't', line: 5, name: 'circular' }] });
});

// Reviewer repro (final-review wave, item 1): a block VERDICTED caught/hollow still MENTIONS a changed fn
// it never pinned (a companion weak assertion in the same block) — that fn must not fall into 'untested'
// ("no test mentions it" is false; the block does mention it, just doesn't pin it). The pre-fix `refs`
// scan only looked at skipped/inconclusive blocks, so a caught/hollow block's non-pinned mention was
// invisible to it — this pins the fix: caught/hollow blocks join the reference scan whenever the fn is
// NOT in that block's own pinned-fn list (else it would already be proven/hollow via provenIn/hollowIn).
test('classifyChanges: a fn referenced (not pinned) inside a CAUGHT block is unverifiable, not untested', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'hunk', decls: [
    { fn: 'inner', line: 1, endLine: 2 }, { fn: 'outer', line: 4, endLine: 6 },
  ] }];
  const blocks = [
    { file: 't', line: 1, name: 'x', bodyMasked: "assert.ok(typeof inner === 'function'); assert.strictEqual(outer(2), 5);", verdict: 'caught', caughtFns: ['outer'], caughtPairs: [{ fn: 'outer', sutRel: 'src/a.mjs' }] },
  ];
  const { changes } = classifyChanges(changed, blocks);
  const by = Object.fromEntries(changes.map((c) => [c.fn, c]));
  // outer: pinned and caught → proven, unaffected by the widening (provenIn already claims it)
  assert.equal(by.outer.status, 'proven');
  // inner: mentioned by the same block, but not in ITS caughtFns — the block pins a different fn
  // (semantically exact: 'no-pin'), so inner is unverifiable, never the false 'untested'.
  assert.equal(by.inner.status, 'unverifiable');
  assert.deepEqual(by.inner.evidence.reasons, { 'no-pin': 1 });
});

test('a probe-cap record keeps reference evidence: unverifiable (probe-cap), never untested', () => {
  const changed = [{ file: 'src/calc.mjs', granularity: 'file', decls: [{ fn: 'add', line: 1 }] }];
  const blocks = [{ file: 'test/calc.test.mjs', line: 3, name: 'adds', bodyMasked: 'assert.strictEqual(add(2, 3), 5)', verdict: 'skipped', why: 'probe-cap' }];
  const { changes, changeSummary } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'unverifiable', JSON.stringify(changes));
  assert.equal(changes[0].evidence.reason, 'probe-cap');
  assert.equal(changeSummary.untested, 0);
});

// SAME-DIFF-ORACLE PROVENANCE (Task 7): a proven verdict stands as proven (an adversarially-authored
// oracle is indistinguishable from a legitimate one from the outside), but the engine already knows
// whether the binding test's FILE was itself changed in this diff — a fact, not an accusation.
// `testChanged` rides each CAUGHT blockRecord (prove.mjs); pick() carries it through; a proven row's
// evidence.sameDiffOracle is true only when EVERY binding block's test file changed.
test('a proven fn whose every binding test changed in the same diff is counted sameDiffProven', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'file', decls: [{ fn: 'add', line: 1 }] }];
  const blocks = [{ file: 'test/a.test.mjs', line: 3, name: 'adds', verdict: 'caught', testChanged: true, caughtPairs: [{ fn: 'add', sutRel: 'src/a.mjs' }], bodyMasked: 'add(2, 3)' }];
  const { changes, changeSummary } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'proven');
  assert.equal(changes[0].evidence.sameDiffOracle, true);
  assert.equal(changeSummary.sameDiffProven, 1);
});
// .every() semantics: ONE binding block from an unchanged test file must sink sameDiffOracle to false —
// a fn proven partly by pre-existing coverage is not "proven only by a new same-diff test".
test('a proven fn with one binding block from an unchanged test file is NOT sameDiffProven (the .every() semantics)', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'file', decls: [{ fn: 'add', line: 1 }] }];
  const blocks = [
    { file: 'test/a.test.mjs', line: 3, name: 'adds new', verdict: 'caught', testChanged: true, caughtPairs: [{ fn: 'add', sutRel: 'src/a.mjs' }], bodyMasked: 'add(2, 3)' },
    { file: 'test/a.test.mjs', line: 9, name: 'adds old', verdict: 'caught', testChanged: false, caughtPairs: [{ fn: 'add', sutRel: 'src/a.mjs' }], bodyMasked: 'add(4, 5)' },
  ];
  const { changes, changeSummary } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'proven');
  assert.equal(changes[0].evidence.sameDiffOracle, false, 'not every binding block came from a changed test file');
  assert.equal(changeSummary.sameDiffProven, 0);
});

// PROBE-CAP OUT OF `unverifiable` (Task 7): a probe-cap row is TRUE-unverifiable (the reference is real,
// the block just never ran), but lumping it with genuinely-unverifiable (mock-only, etc.) at the summary
// level overstates the latter. Row status/reason are UNCHANGED (JSON consumers of changes[].status keep
// working); only changeSummary splits: unverifiable excludes probe-cap rows, notProbed counts them.
test('probe-cap rows count as notProbed, not unverifiable', () => {
  const changed = [{ file: 'src/calc.mjs', granularity: 'file', decls: [{ fn: 'add', line: 1 }, { fn: 'sub', line: 5 }] }];
  const blocks = [
    { file: 'test/calc.test.mjs', line: 3, name: 'adds', bodyMasked: 'assert.strictEqual(add(2, 3), 5)', verdict: 'skipped', why: 'probe-cap' },
    { file: 'test/calc.test.mjs', line: 9, name: 'weak sub', bodyMasked: 'assert.ok(sub(2, 3) !== undefined)', verdict: 'skipped', why: 'no-pin' },
  ];
  const { changes, changeSummary } = classifyChanges(changed, blocks);
  const by = Object.fromEntries(changes.map((c) => [c.fn, c]));
  assert.equal(by.add.status, 'unverifiable');
  assert.equal(by.add.evidence.reason, 'probe-cap');
  assert.equal(by.sub.status, 'unverifiable');
  assert.equal(by.sub.evidence.reason, 'no-pin');
  assert.equal(changeSummary.unverifiable, 1, 'only the genuinely-unverifiable (no-pin) row counts here');
  assert.equal(changeSummary.notProbed, 1, 'the probe-cap row is split out as notProbed');
});

// (fn, sutRel)-PAIR ATTRIBUTION (Task B0): caughtFns/survivors are bare names with no file identity — a
// caught/hollow record for `decrypt` whose ACTUAL sut is src/a.mjs must never be attributed to a changed
// `decrypt` that lives in an unrelated src/b.mjs. Before this fix, classifyChanges matched by bare name
// only (`(b.caughtFns || []).includes(fn)`), producing exactly this false PROVEN/HOLLOW (verified at HEAD:
// the same fixture below returned `status: 'proven'`). caughtPairs/survivorPairs give the (fn, file) key
// the bare-name arrays never carried; NO bare-name fallback — a mismatched pair is fail-closed to
// 'unverifiable' (reason 'no-pin'), never a manufactured proven/hollow.
test('classifyChanges (fn, sutRel) pair attribution: a caught record for decrypt@src/a.mjs must NOT prove a changed decrypt@src/b.mjs (false PROVEN, fixed)', () => {
  const changed = [{ file: 'src/b.mjs', granularity: 'fn', decls: [{ fn: 'decrypt', line: 4 }] }];
  const blocks = [{
    file: 'test/a.test.mjs', line: 3, name: 'a round trip',
    bodyMasked: 'const a = new A(); expect(a.decrypt(a.encrypt(x))).toBe(x)',
    verdict: 'caught', caughtFns: ['decrypt'], survivors: [],
    caughtPairs: [{ fn: 'decrypt', sutRel: 'src/a.mjs' }], survivorPairs: [],
  }];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].fn, 'decrypt');
  assert.notEqual(changes[0].status, 'proven', 'cross-file same-name coincidence must never manufacture a proven verdict');
  assert.equal(changes[0].status, 'unverifiable', 'the block mentions decrypt but pins a different declaration — the honest verdict');
  assert.equal(changes[0].evidence.reason, 'no-pin');
});

test('classifyChanges (fn, sutRel) pair attribution: a hollow record for decrypt@src/a.mjs must NOT charge a changed decrypt@src/b.mjs as hollow (false HOLLOW, fixed)', () => {
  const changed = [{ file: 'src/b.mjs', granularity: 'fn', decls: [{ fn: 'decrypt', line: 4 }] }];
  const blocks = [{
    file: 'test/a.test.mjs', line: 3, name: 'a circular pin',
    bodyMasked: 'const a = new A(); const e = a.decrypt(x); expect(a.decrypt(x)).toBe(e)',
    verdict: 'hollow', survivors: ['decrypt'],
    survivorPairs: [{ fn: 'decrypt', sutRel: 'src/a.mjs' }],
  }];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].fn, 'decrypt');
  assert.notEqual(changes[0].status, 'hollow', 'cross-file same-name coincidence must never manufacture a hollow verdict');
  assert.equal(changes[0].status, 'unverifiable', 'the block mentions decrypt but pins a different declaration — the honest verdict');
  assert.equal(changes[0].evidence.reason, 'no-pin');
});

// POSITIVE CONTROL: same fixtures as above, but the pair now points at the CHANGED file itself — proven/
// hollow must classify exactly as before the fix. This is the guarantee the precision-risk analysis rests
// on: a true verdict for changed fn F@file always comes from a probe of F@file, so the pair matches by
// construction and no real verdict is lost by the tightening.
test('classifyChanges (fn, sutRel) pair attribution: a matching pair still classifies proven, unchanged', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'fn', decls: [{ fn: 'decrypt', line: 4 }] }];
  const blocks = [{
    file: 'test/a.test.mjs', line: 3, name: 'a round trip',
    bodyMasked: 'const a = new A(); expect(a.decrypt(a.encrypt(x))).toBe(x)',
    verdict: 'caught', caughtFns: ['decrypt'], survivors: [],
    caughtPairs: [{ fn: 'decrypt', sutRel: 'src/a.mjs' }], survivorPairs: [],
  }];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'proven');
  assert.deepEqual(changes[0].evidence, { blocks: [{ file: 'test/a.test.mjs', line: 3, name: 'a round trip' }], sameDiffOracle: false });
});

test('classifyChanges (fn, sutRel) pair attribution: a matching pair still classifies hollow, unchanged', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'fn', decls: [{ fn: 'decrypt', line: 4 }] }];
  const blocks = [{
    file: 'test/a.test.mjs', line: 3, name: 'a circular pin',
    bodyMasked: 'const a = new A(); const e = a.decrypt(x); expect(a.decrypt(x)).toBe(e)',
    verdict: 'hollow', survivors: ['decrypt'],
    survivorPairs: [{ fn: 'decrypt', sutRel: 'src/a.mjs' }],
  }];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'hollow');
  assert.deepEqual(changes[0].evidence, { blocks: [{ file: 'test/a.test.mjs', line: 3, name: 'a circular pin' }] });
});

// Fail-closed, no bare-name fallback: a caught/hollow record with NO pairs at all (an old-shaped record,
// or a future caller that forgets to build them) must attribute NOTHING — never resurrect the bare-name
// match this fix removed. 'proven'/'hollow' are positive claims; an unattributable block must never
// manufacture one.
test('classifyChanges (fn, sutRel) pair attribution: a caught/hollow record with no pairs at all attributes nothing (fail-closed, no bare-name fallback)', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'fn', decls: [{ fn: 'decrypt', line: 4 }] }];
  const caughtNoPairs = classifyChanges(changed, [{
    file: 't', line: 1, name: 'x', bodyMasked: 'expect(decrypt(x)).toBe(y)', verdict: 'caught', caughtFns: ['decrypt'], survivors: [],
  }]);
  assert.notEqual(caughtNoPairs.changes[0].status, 'proven');
  assert.equal(caughtNoPairs.changes[0].status, 'unverifiable');
  const hollowNoPairs = classifyChanges(changed, [{
    file: 't', line: 1, name: 'x', bodyMasked: 'const e = decrypt(x); expect(decrypt(x)).toBe(e)', verdict: 'hollow', survivors: ['decrypt'],
  }]);
  assert.notEqual(hollowNoPairs.changes[0].status, 'hollow');
  assert.equal(hollowNoPairs.changes[0].status, 'unverifiable');
});

// ---- Reason rollup tie-break (public issue #3, defect B): at equal count, an execution-observed reason
// ('ungutable' — the engine really gutted and the mutant failed to compile) must outrank a purely-static
// scan reason ('no-pin') — Object.entries insertion order otherwise silently picks whichever block sits
// earlier in the file, burying an engine-VERIFIED fact behind a weaker static guess. Oracle hand-derived:
// 1×no-pin + 1×ungutable is a tie, and the execution-observed side is the defined winner.
test('unverifiable reason rollup: on a count tie, execution-observed (ungutable) beats static (no-pin) regardless of block order', () => {
  const changed = [{ file: 'src/geo.kt', granularity: 'file', decls: [{ fn: 'boundingBoxM', line: 1, endLine: 3 }] }];
  const blocks = [
    { file: 't/g.test.kt', line: 2, name: 'destructured', bodyMasked: 'val (l, w) = boundingBoxM(sq)', verdict: 'skipped', why: 'no-pin' },
    { file: 't/g.test.kt', line: 9, name: 'direct', bodyMasked: 'assertEquals(z, boundingBoxM(e))', verdict: 'skipped', why: 'ungutable' },
  ];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes[0].status, 'unverifiable');
  assert.deepEqual(changes[0].evidence.reasons, { 'no-pin': 1, ungutable: 1 }, 'both facts stay visible in the tally');
  assert.equal(changes[0].evidence.reason, 'ungutable', 'the execution-observed reason is the dominant one');
});

test('unverifiable reason rollup: a strictly higher static count still wins outright (tie-break only)', () => {
  const changed = [{ file: 'src/geo.kt', granularity: 'file', decls: [{ fn: 'scaleM', line: 1, endLine: 3 }] }];
  const blocks = [
    { file: 't/g.test.kt', line: 2, name: 'a', bodyMasked: 'scaleM(1)', verdict: 'skipped', why: 'no-pin' },
    { file: 't/g.test.kt', line: 9, name: 'b', bodyMasked: 'scaleM(2)', verdict: 'skipped', why: 'no-pin' },
    { file: 't/g.test.kt', line: 16, name: 'c', bodyMasked: 'assertEquals(z, scaleM(3))', verdict: 'skipped', why: 'ungutable' },
  ];
  const { changes } = classifyChanges(changed, blocks);
  assert.equal(changes[0].evidence.reason, 'no-pin', 'count dominance is unchanged — priority applies only at a tie');
});
