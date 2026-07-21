// Relational-assert reach, SAFE form — spec Feature 2 §3/§6. The core invariant test lives here:
// a relational-only survivor is NEVER hollow. Oracles hand-derived from the spec.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prove, eligibleFnsDetail, pyBlocks } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-rel-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}

const LIB = `export function scale(x) { return x * 2 }
export function offset(x) { return x + 1 }
export function ratio(a, b) { return a / b }
export function echoLike(x) { return x }
`;

const FIXTURE = {
  'src/lib.mjs': LIB,
  'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { scale, offset, ratio, echoLike } from '../src/lib.mjs';
test('lt proven', () => { assert.ok(scale(3) < 100); });
test('gt one sided', () => { assert.ok(offset(1) > 0); });
test('ratio unbound', () => { assert.ok(ratio(4, 2) >= ratio(2, 2)); });
test('mixed hollow plus relational', () => { assert.strictEqual(echoLike(5), echoLike(5)); assert.ok(scale(2) >= scale(2)); });
`,
};

test('relational fold: red→proven, one-direction→one-sided, survive-both→relation-unbound, NEVER hollow', () => {
  const d = project(FIXTURE);
  try {
    const r = prove(d, { runner: 'node' });
    // 'lt proven': +sentinel < 100 is false → red on the plain run → proven.
    assert.ok(r.caught >= 1, `lt relation must prove: ${JSON.stringify(r)}`);
    // 'gt one sided': survives +, red under − (confirm-before-accuse opposite run) → one-sided tier.
    assert.deepEqual(r.oneSided.map((o) => o.name), ['gt one sided']);
    // 'ratio unbound': sentinel >= sentinel survives BOTH → relation-unbound skip, not a verdict.
    const ru = r.skipped.filter((s) => s.why === 'relation-unbound');
    assert.deepEqual(ru.map((s) => s.name), ['ratio unbound']);
    // THE INVARIANT: the only hollow is the value-pinned echo; no relational-only fn ever appears.
    assert.equal(r.hollow.length, 1);
    assert.equal(r.hollow[0].name, 'mixed hollow plus relational');
    assert.deepEqual(r.hollow[0].survivors, ['echoLike'], 'scale (relational-only) must not be accused');
    // relation-unbound is not scored; the one-sided and caught tiers are.
    assert.equal(r.scored, r.caught + r.hollow.length + r.oneSidedBlocks);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no new blockers: a relational-only fixture with zero value pins cannot exit hollow', () => {
  const d = project({
    'src/lib.mjs': LIB,
    'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { ratio } from '../src/lib.mjs';
test('only unbound', () => { assert.ok(ratio(4, 2) >= ratio(2, 2)); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0);
    assert.equal(r.skipped.filter((s) => s.why === 'relation-unbound').length, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Gate on PYTEST, not bare python3 — a python3-without-pytest machine false-reds the runner (the
// repo's CI learned this the hard way; mirror the suite's existing HAS_PYTEST-style gates).
const HAS_PY = (() => { try { execFileSync('python3', ['-m', 'pytest', '--version']); return true; } catch { return false; } })();
// TEST-file-side direct-spawn check needs only python3 (no pytest execution — pyBlocks() just parses the
// test file's ast) — mirrors test/py-instance-reach.test.mjs's own python3-only gate for its pyBlocks()
// unit checks, distinct from the pytest-requiring e2e gate above.
const HAS_PY3 = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();

test('py_blocks: a fn credited by BOTH equality and relational asserts stays value-class (pins), never relPins', { skip: !HAS_PY3 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-rel-dual-'));
  try {
    const f = join(d, 'test_dual.py');
    writeFileSync(f, 'def test_dual():\n    assert scale(2) == 4\n    assert scale(2) >= 1\n');
    const r = pyBlocks(f);
    assert.ok(r, 'pyBlocks must parse');
    const b = r.blocks.find((x) => x.name === 'test_dual');
    assert.deepEqual(b.pins, ['scale'], 'the equality assert value-pins scale');
    assert.deepEqual(b.relPins, [], 'scale is credited by both contexts, so relPins must NOT also list it');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('python ast path: bare relational assert credits relPins, equality stays in pins', { skip: !HAS_PY }, () => {
  const d = project({
    'src/lib.py': 'def scale(x):\n    return x * 2\n\ndef ratio(a, b):\n    return a / b\n',
    'test_lib.py': 'from src.lib import scale, ratio\n\ndef test_value():\n    assert scale(2) == 4\n\ndef test_rel():\n    assert ratio(4, 2) >= ratio(2, 2)\n',
    'src/__init__.py': '',
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    const ru = r.skipped.filter((s) => s.why === 'relation-unbound');
    assert.deepEqual(ru.map((s) => s.name), ['test_rel']);
    assert.equal(r.hollow.length, 0, 'a relational-only python survivor must never be hollow');
    assert.ok(r.caught >= 1, 'the equality test still proves');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('python ast path: unittest assertGreater family is relational [spec addendum]', { skip: !HAS_PY }, () => {
  const d = project({
    'src/lib.py': 'def scale(x):\n    return x * 2\n',
    'test_u.py': 'import unittest\nfrom src.lib import scale\n\nclass T(unittest.TestCase):\n    def test_greater(self):\n        self.assertGreater(scale(3), 1)\n',
    'src/__init__.py': '',
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    // +sentinel > 1 survives; −sentinel red → one-sided (scored, non-blocking) — or, if the opposite
    // compiles away, relation-unbound. Either way: NEVER hollow, and the block is not skipped as no-pin.
    assert.equal(r.hollow.length, 0);
    assert.equal(r.skipped.filter((s) => s.why === 'no-pin').length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('python regex fallback (no ast): relational assert is eligible via the Task 1 regex path', () => {
  // Direct unit check — the regex path runs for ALL languages inside pinnedFragmentsByKind:
  const d2 = eligibleFnsDetail('assert calc(x) > 0\n', ['calc']);
  assert.deepEqual(d2.relationalOnly, ['calc']);
});

test('cap ordering: under --max-probes=1 the value-pinned block is probed, the relational-only block is capped', () => {
  const d = project({
    'src/lib.mjs': LIB,
    // Relational-only block FIRST in source order — the pre-pass must still probe the value block first.
    'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { scale, offset } from '../src/lib.mjs';
test('rel first', () => { assert.ok(offset(1) > 0); });
test('value second', () => { assert.strictEqual(scale(2), 4); });
`,
  });
  try {
    const r = prove(d, { runner: 'node', maxProbes: 1 });
    assert.equal(r.caught, 1, 'the value-pinned block got the only probe slot');
    assert.equal(r.capped, 1, 'the relational-only block was capped, not silently dropped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('--deep over relational tiers: one-direction relational proofs demote to one-sided; relation-unbound and the mixed hollow unchanged', () => {
  const d = project(FIXTURE);
  try {
    const r = prove(d, { runner: 'node', deep: true });
    const names = r.oneSided.map((o) => o.name);
    assert.ok(names.includes('lt proven'), 'deep re-examines the red side: scale(3)<100 passes under the negative sentinel → one-sided');
    assert.ok(names.includes('gt one sided'));
    assert.deepEqual(r.skipped.filter((s) => s.why === 'relation-unbound').map((s) => s.name), ['ratio unbound']);
    assert.equal(r.hollow.length, 1);
    assert.equal(r.hollow[0].name, 'mixed hollow plus relational');
    assert.deepEqual(r.hollow[0].survivors, ['echoLike'], 'the relational-only sibling stays out of the accusation under deep too');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('byte-identity: zero-relational repo keeps source order in r.skipped (no-pin block is never deprioritized)', () => {
  const d = project({
    'src/lib.mjs': LIB,
    'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { scale } from '../src/lib.mjs';
test('a no pin', () => { assert.ok(scale(2)); });
test('b unresolved', () => { const { x } = { x: scale(2) }; assert.strictEqual(x, 4); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.deepEqual(r.skipped.map((s) => s.name), ['a no pin', 'b unresolved'], 'source order preserved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
