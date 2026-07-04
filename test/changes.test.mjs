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

test('declaredFns enumerates top-level guttable forms and nothing else', () => {
  const fns = declaredFns(JS, 'js').map((d) => d.fn);
  assert.deepEqual(fns.sort(), ['alpha', 'beta', 'delta', 'gamma']);
});

test('declaredFns line/endLine spans cover the body', () => {
  const alpha = declaredFns(JS, 'js').find((d) => d.fn === 'alpha');
  assert.equal(alpha.line, 1);
  assert.equal(alpha.endLine, 3);
});

test('declaredFns python: def forms with indent-based end', () => {
  const PY = 'def top(x):\n    return x\n\nclass C:\n    def method(self):\n        return 1\n\ndef last():\n    pass\n';
  const fns = declaredFns(PY, 'python');
  assert.deepEqual(fns.map((d) => d.fn).sort(), ['last', 'top']); // class methods excluded (indented def)
  const top = fns.find((d) => d.fn === 'top');
  assert.equal(top.line, 1); assert.equal(top.endLine, 2);
});

// GRAMMAR SYNC (behavioral, fixture-driven, both directions):
// Direction 1 — enumerated ⊆ guttable: every form declaredFns enumerates, grossBreak can gut, so
// report reach never exceeds probe reach (asserted here and in the extension tests below).
// Direction 2 — exclusions: class methods are excluded AND ungettable (asserted here); the one form
// the probe CAN gut that declaredFns deliberately does not enumerate (object-property function
// values) is pinned by the known-delta test below. Report reach can never silently diverge from
// probe reach in either direction without a test going red.
test('grammar sync: every enumerated decl is guttable; class methods excluded AND ungettable', () => {
  for (const d of declaredFns(JS, 'js')) {
    const broken = grossBreak(JS, d.fn, 'typescript');
    assert.ok(broken !== null && broken !== JS, `grossBreak must gut ${d.fn}`);
  }
  assert.equal(grossBreak(JS, 'method', 'typescript'), null, 'class method must stay ungettable AND unenumerated');
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

test('grammar sync (python): column-0 async def is enumerated AND guttable; indented async def excluded', () => {
  const PY = 'async def fetch(x):\n    return x\n\nclass C:\n    async def m(self):\n        return 1\n';
  const fns = declaredFns(PY, 'python');
  assert.deepEqual(fns.map((d) => d.fn), ['fetch']);
  assert.equal(fns[0].line, 1);
  assert.equal(fns[0].endLine, 2);
  const broken = grossBreak(PY, 'fetch', 'python');
  assert.ok(broken !== null && broken !== PY, 'grossBreak must gut column-0 async def');
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
    { file: 't/1.test.mjs', line: 2, name: 'catches', bodyMasked: 'expect(provenFn(1)).toBe(2)', verdict: 'caught', caughtFns: ['provenFn'] },
    { file: 't/1.test.mjs', line: 9, name: 'circular', bodyMasked: 'const e = hollowFn(1); expect(hollowFn(1)).toBe(e)', verdict: 'hollow', survivors: ['hollowFn'] },
    { file: 't/2.test.mjs', line: 3, name: 'weak-ref', bodyMasked: 'expect(unvFn(1)).toBeDefined()', verdict: 'skipped', why: 'no-pin' },
  ];
  const { changes, changeSummary } = classifyChanges(changed, blocks);
  const by = Object.fromEntries(changes.map((c) => [c.fn, c]));
  // provenFn: in caughtFns of one caught block → proven, evidence lists that block
  assert.equal(by.provenFn.status, 'proven');
  assert.deepEqual(by.provenFn.evidence, { blocks: [{ file: 't/1.test.mjs', line: 2, name: 'catches' }] });
  // hollowFn: in survivors → hollow
  assert.equal(by.hollowFn.status, 'hollow');
  // unvFn: referenced (word-boundary) by a skipped block, no verdict → unverifiable, reason no-pin ×1
  assert.equal(by.unvFn.status, 'unverifiable');
  assert.deepEqual(by.unvFn.evidence.reasons, { 'no-pin': 1 });
  // ghostFn: referenced nowhere → untested, empty evidence
  assert.equal(by.ghostFn.status, 'untested');
  assert.deepEqual(by.ghostFn.evidence, {});
  // summary: 4 fns, 1 file — counts derived by hand from the rows above
  assert.deepEqual(changeSummary, { files: 1, fns: 4, proven: 1, hollow: 1, unverifiable: 1, untested: 1 });
});

test('classifyChanges: proven beats unverifiable when a fn appears in several blocks', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'file', decls: [{ fn: 'f', line: 1, endLine: 2 }] }];
  const blocks = [
    { file: 't', line: 1, name: 'x', bodyMasked: 'f(1)', verdict: 'skipped', why: 'no-pin' },
    { file: 't', line: 5, name: 'y', bodyMasked: 'expect(f(1)).toBe(1)', verdict: 'caught', caughtFns: ['f'] },
  ];
  assert.equal(classifyChanges(changed, blocks).changes[0].status, 'proven');
});

test('classifyChanges: hollow beats proven — one surviving mutant is a hole even when another test catches the fn', () => {
  const changed = [{ file: 'src/a.mjs', granularity: 'hunk', decls: [{ fn: 'f', line: 1, endLine: 2 }] }];
  const blocks = [
    { file: 't', line: 1, name: 'sound', bodyMasked: 'expect(f(1)).toBe(2)', verdict: 'caught', caughtFns: ['f'] },
    { file: 't', line: 5, name: 'circular', bodyMasked: 'const e = f(1); expect(f(1)).toBe(e)', verdict: 'hollow', survivors: ['f'] },
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
    { file: 't', line: 1, name: 'x', bodyMasked: "assert.ok(typeof inner === 'function'); assert.strictEqual(outer(2), 5);", verdict: 'caught', caughtFns: ['outer'] },
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
