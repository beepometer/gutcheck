// wrongLayerShadow: catches a test that RE-IMPLEMENTS production logic inline and asserts the result
// against a second copy of itself, with ZERO real production contact (the deleted LiveEqToggleTest shape —
// see docs/specs/2026-07-07-android-state-and-shadow-design.md PART 1). Fires HOLLOW only on the
// CONJUNCTION of (1) zero production contact [prove.mjs's hasProductionContact/jvmFileHasSharedSetupContact]
// and (2) a self-echo/tautological assertion [wrongLayerShadow.mjs's selfEchoAssertion] — every oracle
// below is hand-derived from that conjunction, never pinned from the implementation's own output.
//
// Layered like the existing JVM-resolver tests (test/jvm-resolver.test.mjs, test/jvm-instance-reach.test.mjs):
// the SIGNAL functions (selfEchoAssertion/titleSutCandidates/hasProductionContact/jvmFileHasSharedSetupContact)
// are pure/resolver-only and unit-tested directly — no runner/gradle/pytest invocation, ever (this whole
// detector is static/zero-run by design). classifyChanges is tested with hand-built blockRecords, exactly
// like test/changes.test.mjs already does. The full prove() pipeline is exercised end-to-end via
// opts.changed (bypassing git) for shapes where the flagged block stays 'skipped' (no eligible SUT to
// gut — the defining trait of a zero-contact shadow), so those integration tests never need a runner
// either; a MUST-NOT-FLAG fixture whose test genuinely calls the SUT is verified at the
// hasProductionContact/classifyChanges layers instead (calling it would make the block ELIGIBLE for the
// mutation path, which — for JVM — needs a real gradle project; JS is cheap enough via 'node' to run for
// real, so its must-not-flag fixture IS run end-to-end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfEchoAssertion, titleSutCandidates } from '../mutation/wrongLayerShadow.mjs';
import { hasProductionContact, jvmFileHasSharedSetupContact, makeResolver, prove } from '../mutation/prove.mjs';
import { classifyChanges } from '../mutation/changes.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'wls-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}

// =========================================================================================
// selfEchoAssertion — pure text analysis, no resolver access.
// =========================================================================================

test('selfEchoAssertion: Kotlin inline if/else-as-ternary self-echo (the LiveEqToggleTest shape) is found', () => {
  const body = `
        val current = setOf(2, 4)
        val index = 2
        assertEquals(
            if (index in current) current - index else current + index,
            if (index in current) current - index else current + index
        )
  `;
  const r = selfEchoAssertion(body, 'kotlin');
  assert.ok(r, 'must find the self-echo');
  assert.equal(r.expr, 'if (index in current) current - index else current + index');
});

test('selfEchoAssertion: Kotlin self-echo laundered through 2 locals (expected/actual) is found', () => {
  const body = `
        val current = setOf(2, 4)
        val index = 2
        val expected = if (index in current) current - index else current + index
        val actual = if (index in current) current - index else current + index
        assertEquals(expected, actual)
  `;
  const r = selfEchoAssertion(body, 'kotlin');
  assert.ok(r, 'must find the self-echo through the variable hop');
  assert.equal(r.expr, 'if (index in current) current - index else current + index');
});

test('selfEchoAssertion: JS inline ternary self-echo is found', () => {
  const body = `
      const current = new Set([2, 4]);
      const index = 2;
      expect(current.has(index) ? current.size - 1 : current.size + 1).toBe(current.has(index) ? current.size - 1 : current.size + 1);
  `;
  const r = selfEchoAssertion(body, undefined);
  assert.ok(r);
  assert.equal(r.expr, 'current.has(index) ? current.size - 1 : current.size + 1');
});

test('selfEchoAssertion: python self-echo laundered through 2 locals is found', () => {
  const body = `
current = {2, 4}
index = 2
expected = (current - {index}) if index in current else (current | {index})
actual = (current - {index}) if index in current else (current | {index})
assert expected == actual
  `;
  const r = selfEchoAssertion(body, 'python');
  assert.ok(r);
  assert.equal(r.expr, '(current - {index}) if index in current else (current | {index})');
});

test('selfEchoAssertion MUST-NOT-FLAG: a legit call-based test (no branchy re-derivation) is never a self-echo', () => {
  const body = `
        val vm = RoomViewModel()
        val result = vm.toggleBand(2, setOf(2, 4))
        assertEquals(setOf(4), result)
  `;
  assert.equal(selfEchoAssertion(body, 'kotlin'), null);
});

test('selfEchoAssertion MUST-NOT-FLAG: a genuine idempotence/property test (nested identical CALLS) never fires — a bare call is not "branchy"', () => {
  const body = `
        val vm = RoomViewModel()
        assertEquals(vm.toggleBand(vm.toggleBand(2, setOf(2, 4)), setOf(2, 4)), vm.toggleBand(2, setOf(2, 4)))
  `;
  assert.equal(selfEchoAssertion(body, 'kotlin'), null, 'a real property test (f(f(x)) vs f(x)) must never be treated as a self-echo');
});

test('selfEchoAssertion MUST-NOT-FLAG: a trivial identical-literal pin is not branchy, never flagged', () => {
  assert.equal(selfEchoAssertion('expect(5).toBe(5);', undefined), null);
  assert.equal(selfEchoAssertion('assertEquals(5, 5)', 'kotlin'), null);
});

// =========================================================================================
// titleSutCandidates — the TITLE-only attribution surface (the design's primary path). prove() resolves
// each candidate via resolveJvmSut and keeps only the ones that map to a real src/main declaration; a fn
// whose name appears only in the ECHO expression is intentionally NOT a candidate here.
// =========================================================================================

test('titleSutCandidates: underscore-joined `SUT_description` yields the leading SUT segment', () => {
  const c = titleSutCandidates('demo.LiveEqToggleTest.toggleBand_addsOrRemovesTheIndex');
  assert.ok(c.includes('toggleBand'), `expected toggleBand among ${JSON.stringify(c)}`);
});

test('titleSutCandidates: a `test`-prefixed camelCase method yields the decapitalized SUT name', () => {
  const c = titleSutCandidates('demo.T.testToggleBand');
  assert.ok(c.includes('toggleBand'), `expected toggleBand among ${JSON.stringify(c)}`);
});

test('titleSutCandidates: a bare method name is itself a candidate', () => {
  assert.ok(titleSutCandidates('demo.T.toggleBand').includes('toggleBand'));
});

test('titleSutCandidates CRITICAL-2 guard: a local/echo identifier that is NOT in the title is never a candidate', () => {
  // The reviewer's false-HOLLOW vector: `index`/`current` live only in the tautological expression, never
  // in the title — so they must never appear as attribution candidates.
  const c = titleSutCandidates('demo.MathTest.subtractsTwoLocals');
  assert.ok(!c.includes('index'), `index must not be a candidate: ${JSON.stringify(c)}`);
  assert.ok(!c.includes('current'), `current must not be a candidate: ${JSON.stringify(c)}`);
});

// =========================================================================================
// hasProductionContact — the zero-contact ABSENCE probe (JVM/JS/Python), reusing the SUT resolvers.
// No runner is ever invoked by these — pure resolver calls against files on disk.
// =========================================================================================

const ROOM_VM_KT = 'package demo\n\nclass RoomViewModel {\n    fun toggleBand(index: Int, current: Set<Int>): Set<Int> = if (index in current) current - index else current + index\n}\n';

test('hasProductionContact JVM: the LiveEqToggleTest shape (zero contact) resolves nothing', () => {
  const d = project({ 'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT });
  const testCode = 'package demo\nimport org.junit.jupiter.api.Assertions.assertEquals\nclass LiveEqToggleTest {\n    fun toggleBand_addsOrRemovesTheIndex() {\n        val current = setOf(2, 4)\n        val index = 2\n        assertEquals(if (index in current) current - index else current + index, if (index in current) current - index else current + index)\n    }\n}\n';
  const body = '        val current = setOf(2, 4)\n        val index = 2\n        assertEquals(if (index in current) current - index else current + index, if (index in current) current - index else current + index)\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt')];
  const absTest = join(d, 'src/test/kotlin/LiveEqToggleTest.kt');
  assert.equal(hasProductionContact(body, { lang: 'kotlin', testCode, absTest, srcFiles, dir: d }), false);
});

test('hasProductionContact JVM MUST-NOT-FLAG (a): constructing + calling the real SUT is contact', () => {
  const d = project({ 'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT });
  const testCode = 'package demo\nimport org.junit.jupiter.api.Assertions.assertEquals\nclass T {\n    fun t() {\n        val vm = RoomViewModel()\n        assertEquals(setOf(4), vm.toggleBand(2, setOf(2, 4)))\n    }\n}\n';
  const body = '        val vm = RoomViewModel()\n        assertEquals(setOf(4), vm.toggleBand(2, setOf(2, 4)))\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt')];
  const absTest = join(d, 'src/test/kotlin/T.kt');
  assert.equal(hasProductionContact(body, { lang: 'kotlin', testCode, absTest, srcFiles, dir: d }), true);
});

test('hasProductionContact JVM MUST-NOT-FLAG (b): calling a DIFFERENTLY-NAMED real helper (not itself pinned) is still contact', () => {
  const d = project({
    'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT,
    'src/main/kotlin/HelperUtils.kt': 'package demo\n\nobject HelperUtils {\n    fun normalize(x: Int): Int = x\n}\n',
  });
  const testCode = 'package demo\nimport org.junit.jupiter.api.Assertions.assertEquals\nclass T {\n    fun t() {\n        val helper = HelperUtils.normalize(2)\n        val current = setOf(2, 4)\n        val index = 2\n        assertEquals(if (index in current) current - index else current + index, if (index in current) current - index else current + index)\n    }\n}\n';
  const body = '        val helper = HelperUtils.normalize(2)\n        val current = setOf(2, 4)\n        val index = 2\n        assertEquals(if (index in current) current - index else current + index, if (index in current) current - index else current + index)\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt'), join(d, 'src/main/kotlin/HelperUtils.kt')];
  const absTest = join(d, 'src/test/kotlin/T.kt');
  assert.equal(hasProductionContact(body, { lang: 'kotlin', testCode, absTest, srcFiles, dir: d }), true);
});

test('hasProductionContact JVM MUST-NOT-FLAG (d): a genuine idempotence property test (instance calls, unpinned by sutFnsIn alone) is still contact', () => {
  const d = project({ 'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT });
  const testCode = 'package demo\nimport org.junit.jupiter.api.Assertions.assertEquals\nclass T {\n    fun t() {\n        val vm = RoomViewModel()\n        assertEquals(vm.toggleBand(vm.toggleBand(2, setOf(2, 4)), setOf(2, 4)), vm.toggleBand(2, setOf(2, 4)))\n    }\n}\n';
  const body = '        val vm = RoomViewModel()\n        assertEquals(vm.toggleBand(vm.toggleBand(2, setOf(2, 4)), setOf(2, 4)), vm.toggleBand(2, setOf(2, 4)))\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt')];
  const absTest = join(d, 'src/test/kotlin/T.kt');
  // this call is over the WHOLE block, not pinned-fragment-restricted like jvmInstanceSuts — proving the
  // broadened scan (an ABSENCE probe is safe to over-collect) actually finds an unpinned instance call too.
  assert.equal(hasProductionContact(body, { lang: 'kotlin', testCode, absTest, srcFiles, dir: d }), true);
});

test('hasProductionContact JS: zero contact vs. a real `new Foo()` construction', () => {
  const d = project({ 'src/lib.mjs': 'export class Foo { method(x) { return x + 1; } }\n' });
  const testCode = "import { Foo } from '../src/lib.mjs';\n";
  const srcFiles = [join(d, 'src/lib.mjs')];
  const absTest = join(d, 'test/t.test.mjs');
  const imports = new Map([['Foo', '../src/lib.mjs']]);
  const resolveSut = makeResolver(srcFiles, d);
  assert.equal(hasProductionContact('const x = 1 + 1;\nexpect(x).toBe(2);\n', { lang: undefined, testCode, absTest, srcFiles, dir: d, imports, resolveSut }), false);
  assert.equal(hasProductionContact('const f = new Foo();\nexpect(f.method(1)).toBe(2);\n', { lang: undefined, testCode, absTest, srcFiles, dir: d, imports, resolveSut }), true);
});

test('hasProductionContact python: zero contact vs. a real `VM()` construction (import-bound)', () => {
  const d = project({ 'src/lib.py': 'class VM:\n    def method(self, x):\n        return x + 1\n' });
  const absTest = join(d, 'test_t.py'); // flat layout: resolvePySut resolves an absolute import against the test file's own dir
  const srcFiles = [join(d, 'src/lib.py')];
  const pyImports = [{ local: 'VM', module: 'src.lib', level: 0 }];
  assert.equal(hasProductionContact('x = 1 + 1\nassert x == 2\n', { lang: 'python', testCode: '', absTest, srcFiles, dir: d, pyImports }), false);
  assert.equal(hasProductionContact('vm = VM()\nassert vm.method(1) == 2\n', { lang: 'python', testCode: '', absTest, srcFiles, dir: d, pyImports }), true);
});

// =========================================================================================
// jvmFileHasSharedSetupContact — whole-file shared-setup suppression (design doc's MUST-NOT-FLAG case (c)).
// =========================================================================================

test('jvmFileHasSharedSetupContact: no @Before/@BeforeEach at all → false', () => {
  const d = project({ 'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT });
  const code = 'package demo\nclass T {\n    fun t() {\n        val current = setOf(2, 4)\n    }\n}\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt')];
  assert.equal(jvmFileHasSharedSetupContact(code, join(d, 'src/test/kotlin/T.kt'), srcFiles, d, 'kotlin'), false);
});

test('jvmFileHasSharedSetupContact: a @BeforeEach that constructs the real SUT → true (suppresses the whole file)', () => {
  const d = project({ 'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT });
  const code = 'package demo\nimport org.junit.jupiter.api.BeforeEach\nclass T {\n    private lateinit var vm: RoomViewModel\n    @BeforeEach\n    fun setup() {\n        vm = RoomViewModel()\n    }\n}\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt')];
  assert.equal(jvmFileHasSharedSetupContact(code, join(d, 'src/test/kotlin/T.kt'), srcFiles, d, 'kotlin'), true);
});

test('jvmFileHasSharedSetupContact: a @BeforeEach present but constructing nothing resolvable → false', () => {
  const d = project({ 'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT });
  const code = 'package demo\nimport org.junit.jupiter.api.BeforeEach\nclass T {\n    private var x: Int = 0\n    @BeforeEach\n    fun setup() {\n        x = 1 + 1\n    }\n}\n';
  const srcFiles = [join(d, 'src/main/kotlin/RoomViewModel.kt')];
  assert.equal(jvmFileHasSharedSetupContact(code, join(d, 'src/test/kotlin/T.kt'), srcFiles, d, 'kotlin'), false);
});

// =========================================================================================
// classifyChanges integration — hand-built blockRecords (mirrors test/changes.test.mjs's own style).
// The core conjunction + attribution + precedence + byte-identity contract lives here.
// =========================================================================================

const changedByFileFor = (fn) => [{ file: 'src/main/kotlin/RoomViewModel.kt', granularity: 'file', decls: [{ fn, line: 4 }] }];
const TOGGLE_TARGET = [{ fn: 'toggleBand', sutRel: 'src/main/kotlin/RoomViewModel.kt' }];

test('classifyChanges TRUE POSITIVE: noContact + selfEcho + title-resolved shadowTarget → hollow, why wrong-layer-shadow', () => {
  const blockRecords = [{
    file: 'src/test/kotlin/LiveEqToggleTest.kt', line: 7, name: 'demo.LiveEqToggleTest.toggleBand_addsOrRemovesTheIndex',
    bodyMasked: '', verdict: 'skipped', why: 'no-pin',
    noContact: true, selfEcho: { line: 4, expr: 'if (index in current) current - index else current + index' }, shadowTargets: TOGGLE_TARGET,
  }];
  const { changes, changeSummary } = classifyChanges(changedByFileFor('toggleBand'), blockRecords);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'hollow');
  assert.equal(changes[0].evidence.reason, 'wrong-layer-shadow');
  assert.equal(changes[0].evidence.echo, 'if (index in current) current - index else current + index');
  assert.deepEqual(changes[0].evidence.blocks, [{ file: 'src/test/kotlin/LiveEqToggleTest.kt', line: 7, name: 'demo.LiveEqToggleTest.toggleBand_addsOrRemovesTheIndex' }]);
  assert.equal(changeSummary.hollow, 1);
});

test('classifyChanges MUST-NOT-FLAG: noContact:false (real contact) never fires, even with a self-echo + a matching shadowTarget present', () => {
  const blockRecords = [{
    file: 'src/test/kotlin/T.kt', line: 3, name: 'demo.T.toggleBand_hasRealContact',
    bodyMasked: '', verdict: 'skipped', why: 'no-pin',
    noContact: false, selfEcho: { line: 1, expr: 'if (index in current) current - index else current + index' }, shadowTargets: TOGGLE_TARGET,
  }];
  const { changes } = classifyChanges(changedByFileFor('toggleBand'), blockRecords);
  assert.equal(changes[0].status, 'untested');
  assert.equal(changes[0].evidence.reason, undefined);
});

test('classifyChanges MUST-NOT-FLAG: noContact:true but selfEcho:null (no tautological assertion) never fires', () => {
  const blockRecords = [{
    file: 'src/test/kotlin/T.kt', line: 3, name: 'demo.T.toggleBand_noAssertionShapeMatched',
    bodyMasked: '', verdict: 'skipped', why: 'no-pin',
    noContact: true, selfEcho: null, shadowTargets: TOGGLE_TARGET,
  }];
  const { changes } = classifyChanges(changedByFileFor('toggleBand'), blockRecords);
  assert.equal(changes[0].status, 'untested');
});

test('classifyChanges MUST-NOT-FLAG: zero-contact + self-echo but the title did not resolve to F (empty shadowTargets) → no hard verdict', () => {
  const blockRecords = [{
    file: 'src/test/kotlin/T.kt', line: 3, name: 'demo.T.someUnrelatedTest',
    bodyMasked: '', verdict: 'skipped', why: 'no-pin',
    noContact: true, selfEcho: { line: 1, expr: 'if (a in b) c else d' }, shadowTargets: [],
  }];
  const { changes } = classifyChanges(changedByFileFor('toggleBand'), blockRecords);
  assert.equal(changes[0].status, 'untested', 'no title-resolved target → falls through to the pre-existing classification, never a mis-attributed hollow');
});

test('classifyChanges CRITICAL-2 GUARD: a shadowTarget for a DIFFERENT fn never charges F (echo-name-collision fix)', () => {
  // The reviewer's Critical-2 vector, at the classifyChanges layer: the block's TITLE resolved to some
  // OTHER fn (`subtract`), while the changed fn under scrutiny is a same-named-as-a-local `index`. The
  // membership test is (fn, file)-exact, so `index` is never charged by a `subtract` shadowTarget.
  const blockRecords = [{
    file: 'src/test/kotlin/MathTest.kt', line: 3, name: 'demo.MathTest.subtract_twoLocals',
    bodyMasked: '', verdict: 'skipped', why: 'no-pin',
    noContact: true, selfEcho: { line: 1, expr: 'current - index' }, shadowTargets: [{ fn: 'subtract', sutRel: 'src/main/kotlin/RoomViewModel.kt' }],
  }];
  const { changes } = classifyChanges(changedByFileFor('index'), blockRecords);
  assert.equal(changes[0].fn, 'index');
  assert.notEqual(changes[0].status, 'hollow', 'an unrelated same-named-as-a-local fn must never be charged from an echo token');
});

test('classifyChanges MUST-NOT-FLAG (e, diff-scoping): F not among the changed decls at all → never appears in changes[]', () => {
  const blockRecords = [{
    file: 'src/test/kotlin/LiveEqToggleTest.kt', line: 7, name: 'demo.LiveEqToggleTest.toggleBand_addsOrRemovesTheIndex',
    bodyMasked: '', verdict: 'skipped', why: 'no-pin',
    noContact: true, selfEcho: { line: 4, expr: 'if (index in current) current - index else current + index' }, shadowTargets: TOGGLE_TARGET,
  }];
  // changedByFile lists a DIFFERENT fn — toggleBand itself was not touched by this diff.
  const { changes } = classifyChanges([{ file: 'src/main/kotlin/RoomViewModel.kt', granularity: 'file', decls: [{ fn: 'otherFn', line: 20 }] }], blockRecords);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].fn, 'otherFn');
  assert.notEqual(changes[0].status, 'hollow');
});

test('classifyChanges PRECEDENCE: a real PROVEN verdict outranks an (incidentally) shadow-attributable block', () => {
  const blockRecords = [
    { file: 'src/test/kotlin/T.kt', line: 1, name: 'demo.T.toggleBand_realCatch', bodyMasked: '', verdict: 'caught', caughtFns: ['toggleBand'], survivors: [], caughtPairs: [{ fn: 'toggleBand', sutRel: 'src/main/kotlin/RoomViewModel.kt' }], survivorPairs: [], noContact: false, selfEcho: null },
    // an UNRELATED block that happens to be zero-contact + self-echo AND resolves to the same fn — must
    // never downgrade an execution-PROVEN fn to a static hollow claim.
    { file: 'src/test/kotlin/Other.kt', line: 1, name: 'demo.Other.toggleBand_shadowLookalike', bodyMasked: '', verdict: 'skipped', why: 'no-pin', noContact: true, selfEcho: { line: 1, expr: 'if (a in b) c else d' }, shadowTargets: TOGGLE_TARGET },
  ];
  const { changes } = classifyChanges(changedByFileFor('toggleBand'), blockRecords);
  assert.equal(changes[0].status, 'proven', 'real execution evidence must never be overridden by a static shadow signal');
});

test('classifyChanges BYTE-IDENTITY: blockRecords with no noContact/selfEcho/shadowTargets fields at all behave exactly as before', () => {
  // Mirrors an existing-style test/changes.test.mjs scenario — a block that references the fn's name in
  // its body but pins nothing: must classify 'unverifiable', completely unaffected by this feature.
  const blockRecords = [{ file: 'src/test/kotlin/T.kt', line: 1, name: 'demo.T.mentionsIt', bodyMasked: 'toggleBand(1, setOf(1))', verdict: 'skipped', why: 'no-pin' }];
  const { changes, changeSummary } = classifyChanges(changedByFileFor('toggleBand'), blockRecords);
  assert.equal(changes[0].status, 'unverifiable');
  assert.equal(changes[0].evidence.reason, 'no-pin');
  assert.equal(changeSummary.hollow, 0);
});

// =========================================================================================
// Full prove() pipeline, end-to-end — opts.changed (no git needed). A zero-contact shadow block has NO
// eligible SUT (that is the whole point), so it stays 'skipped' and prove() never invokes a runner for it —
// these integration tests need no gradle/pytest install.
// =========================================================================================

test('prove() JVM TRUE POSITIVE: the reintroduced LiveEqToggleTest shape → hollow, why wrong-layer-shadow, attributed to toggleBand', () => {
  const d = project({
    'settings.gradle.kts': 'rootProject.name="x"',
    'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT,
    'src/test/kotlin/LiveEqToggleTest.kt': [
      'package demo', '',
      'import org.junit.jupiter.api.Test',
      'import org.junit.jupiter.api.Assertions.assertEquals', '',
      'class LiveEqToggleTest {',
      '    @Test',
      '    fun toggleBand_addsOrRemovesTheIndex() {',
      '        val current = setOf(2, 4)',
      '        val index = 2',
      '        assertEquals(',
      '            if (index in current) current - index else current + index,',
      '            if (index in current) current - index else current + index',
      '        )',
      '    }',
      '}', '',
    ].join('\n'),
  });
  const prodFile = join(d, 'src/main/kotlin/RoomViewModel.kt');
  const r = prove(d, { changed: new Set([prodFile]) });
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].fn, 'toggleBand');
  assert.equal(r.changes[0].status, 'hollow');
  assert.equal(r.changes[0].evidence.reason, 'wrong-layer-shadow');
  assert.equal(r.changeSummary.hollow, 1);
  assert.equal(r.probes, 0, 'zero-run: no mutation was ever attempted for this static finding');
});

test('prove() JVM MUST-NOT-FLAG (c): a @BeforeEach constructing the real SUT suppresses the same shadow shape', () => {
  const d = project({
    'settings.gradle.kts': 'rootProject.name="x"',
    'src/main/kotlin/RoomViewModel.kt': ROOM_VM_KT,
    'src/test/kotlin/LiveEqToggleTest.kt': [
      'package demo', '',
      'import org.junit.jupiter.api.Test',
      'import org.junit.jupiter.api.BeforeEach',
      'import org.junit.jupiter.api.Assertions.assertEquals', '',
      'class LiveEqToggleTest {',
      '    private lateinit var vm: RoomViewModel', '',
      '    @BeforeEach',
      '    fun setup() {',
      '        vm = RoomViewModel()',
      '    }', '',
      '    @Test',
      '    fun toggleBand_addsOrRemovesTheIndex() {',
      '        val current = setOf(2, 4)',
      '        val index = 2',
      '        assertEquals(',
      '            if (index in current) current - index else current + index,',
      '            if (index in current) current - index else current + index',
      '        )',
      '    }',
      '}', '',
    ].join('\n'),
  });
  const prodFile = join(d, 'src/main/kotlin/RoomViewModel.kt');
  const r = prove(d, { changed: new Set([prodFile]) });
  assert.equal(r.changes.length, 1);
  assert.notEqual(r.changes[0].status, 'hollow', 'the shared @BeforeEach construction must suppress the flag for every test in the file');
});

test('prove() JS MUST-NOT-FLAG: inline ternary self-echo, zero production contact → NOT a hard hollow (JS is JVM-gated, advisory only)', () => {
  // The hard wrongLayerShadow hollow is JVM-only (see prove.mjs's header comment on the gate): JS/py contact
  // detection is strictly weaker than the mutation probe's own reach (no instance-call/shared-setup contact
  // analog), so a JS shadow shape must never produce a hard hollow verdict — it would be a false hollow on
  // any JS instance-method test the weaker probe can't see contact for. This same shape used to assert
  // 'hollow' before the gate; it must now fall through to whatever the pre-existing classification is.
  const d = project({
    'package.json': '{"type":"module"}',
    'src/roomViewModel.mjs': 'export function toggleBand(index, current) {\n  return current.has(index) ? new Set([...current].filter(x => x !== index)) : new Set([...current, index]);\n}\n',
    'test/t.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "test('toggleBand adds or removes the index', () => {",
      '  const current = new Set([2, 4]);',
      '  const index = 2;',
      '  assert.strictEqual(current.has(index) ? current.size - 1 : current.size + 1, current.has(index) ? current.size - 1 : current.size + 1);',
      '});',
      '',
    ].join('\n'),
  });
  const prodFile = join(d, 'src/roomViewModel.mjs');
  const r = prove(d, { runner: 'node', changed: new Set([prodFile]) });
  assert.equal(r.changes.length, 1);
  assert.notEqual(r.changes[0].status, 'hollow', 'JS shadow shape must never be a hard hollow — the gate is JVM-only');
});

test('prove() JS MUST-NOT-FLAG (Critical-1 regression): a probe-provable instance-method test that looks zero-contact must NOT be flagged', () => {
  // The reviewer's exact Critical-1 vector: a real JS class with an instance method under test, exercised
  // through a constructed instance in an expression the static contact probe doesn't recognize as contact
  // (self-subtraction of two calls). Gutting `offset` (e.g. returning a constant) makes this test FAIL, so
  // it is genuinely probe-provable — it must never be statically mislabeled hollow. Safe today only because
  // the hard hollow is JVM-gated; this test locks that guarantee for this exact shape.
  const d = project({
    'package.json': '{"type":"module"}',
    'src/meter.mjs': 'export class Meter {\n  constructor() { this.t = 0; }\n  tick() { return this.t++; }\n  offset(x) { return x + 10; }\n}\n',
    'test/t.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "import { Meter } from '../src/meter.mjs';",
      'let m;',
      "test('offset combines with tick consistently', () => {",
      '  m = new Meter();',
      '  assert.strictEqual(m.offset(m.tick()) - m.tick(), m.offset(m.tick()) - m.tick());',
      '});',
      '',
    ].join('\n'),
  });
  const prodFile = join(d, 'src/meter.mjs');
  const r = prove(d, { runner: 'node', changed: new Set([prodFile]) });
  // the whole class body is under `changed` (file-granularity), so constructor/tick/offset all appear —
  // the load-bearing assertion is specifically about `offset`, the fn named in the test's title.
  const offset = r.changes.find((c) => c.fn === 'offset');
  assert.ok(offset, `expected an 'offset' entry among ${JSON.stringify(r.changes)}`);
  assert.notEqual(offset.status, 'hollow', 'a probe-provable instance-method test must never be statically flagged hollow');
});

test('prove() JS MUST-NOT-FLAG: a real test that imports and calls the production fn is proven, never a shadow', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/roomViewModel.mjs': 'export function toggleBand(index, current) {\n  return current.has(index) ? new Set([...current].filter(x => x !== index)) : new Set([...current, index]);\n}\n',
    'test/t.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "import { toggleBand } from '../src/roomViewModel.mjs';",
      "test('toggleBand removes an existing index', () => {",
      '  const result = toggleBand(2, new Set([2, 4]));',
      '  assert.deepStrictEqual(result, new Set([4]));',
      '});',
      '',
    ].join('\n'),
  });
  const prodFile = join(d, 'src/roomViewModel.mjs');
  const r = prove(d, { runner: 'node', changed: new Set([prodFile]) });
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].status, 'proven');
});
