// Python receiver-instance crediting (T4, docs/plans/2026-07-09-inline-receiver-crediting.md): the
// Python ast path (pyAst) gets the SAME inline (`Calc().add(2,3)`) and variable (`c = Calc();
// c.add(2,3)`) crediting JS/JVM already have. Root cause (plan §1): `pin_calls_in` is deliberately
// Name-only, so a receiver'd `.method(` call was NEVER pinned at all — the variable path landed
// 'no-pin', and the inline path's bare ctor name resolved as a dead-end 'ungutable'/'sut-unresolved'
// eligible entry. Both are new reach; a wrong credit here mints a false verdict, so every REFUSE row in
// plan §5.2 (Python) gets its own adversarial fixture below — never pinned from this file's own
// implementation, hand-derived from the plan's ground truth.
//
// Two categories of unit coverage, plus e2e:
//   - TEST-file-side: py_blocks.py's new `inst` emission (pyBlocks()) — the receiver-binding/mock-taint/
//     ctor-rebind rules that live in the whole-test-file ast. No pytest execution needed.
//   - SUT-file-side: resolvePyClassMember() — the `--member` ast validation on the class's own file. No
//     pytest execution needed (still needs python3 for the --member subprocess).
//   - e2e: prove() end to end — the fx-py shape flips 0 scored -> 2/2 proven; hollow twins flag hollow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prove, pyBlocks, resolvePyClassMember } from '../mutation/prove.mjs';

const HAS_PY = (() => { try { execSync('python3 --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
// The prove() e2es below EXECUTE tests via `python3 -m pytest` (testCmdFor's pytest runner) — python3
// alone is not enough. Gate them on the module, or a pytest-less box (GitHub runners ship python3
// without pytest) reads baseline-fail → 0 scored → a false RED. CI provisions pytest via setup-python.
const HAS_PYTEST = HAS_PY && (() => { try { execSync('python3 -m pytest --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-py-instance-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

// =========================================================================================
// A) TEST-file-side: py_blocks.py `inst` emission — happy paths
// =========================================================================================

test('py_blocks inst: inline `Calc().add(2,3)` inside assertEqual is captured as {ctor,method}', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'import unittest',
      'from calc import Calc',
      '',
      'class T(unittest.TestCase):',
      '    def test_add(self):',
      '        self.assertEqual(Calc().add(2, 3), 5)',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.ok(r, 'pyBlocks must parse');
    const b = r.blocks.find((x) => x.name === 'test_add');
    assert.deepEqual(b.inst, [{ ctor: 'Calc', method: 'add' }]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst: variable `c = Calc(); c.add(2,3)` inside a bare `assert ==` is captured', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    c = Calc()',
      '    assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    const b = r.blocks.find((x) => x.name === 'test_add');
    assert.deepEqual(b.inst, [{ ctor: 'Calc', method: 'add' }]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst: same ctor reassigned twice (SAME type both times) still credits — mirrors jvmInstanceSuts', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    c = Calc()',
      '    c = Calc()',
      '    assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    const b = r.blocks.find((x) => x.name === 'test_add');
    assert.deepEqual(b.inst, [{ ctor: 'Calc', method: 'add' }]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst: nested in an expression context (`assertEqual(Calc().add(2,3) + 1, 6)`) still credits — over-inclusive-but-safe, ground truth §2.1', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'import unittest',
      'from calc import Calc',
      '',
      'class T(unittest.TestCase):',
      '    def test_add(self):',
      '        self.assertEqual(Calc().add(2, 3) + 1, 6)',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    const b = r.blocks.find((x) => x.name === 'test_add');
    assert.deepEqual(b.inst, [{ ctor: 'Calc', method: 'add' }]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// =========================================================================================
// B) TEST-file-side REFUSE rows (plan §5.2 Python) — every vector routes to inst: [], never a wrong credit
// =========================================================================================

test('py_blocks inst REFUSE: receiver is a param/fixture (`def test_x(calc)`) — never bound to a ctor', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add(calc):',
      '    assert calc.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: monkeypatched receiver (`c.add = ...`)', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    c = Calc()',
      '    c.add = lambda a, b: 999',
      '    assert c.add(2, 3) == 999',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: `setattr(c, ...)` receiver taint', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    c = Calc()',
      "    setattr(c, 'add', lambda a, b: 999)",
      '    assert c.add(2, 3) == 999',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: reassigned to a DIFFERENT ctor type (`c = Calc(); c = Other()`)', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      'from other import Other',
      '',
      'def test_add():',
      '    c = Calc()',
      '    c = Other()',
      '    assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: tuple-assigned receiver (`a, c = 1, Calc()`)', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    a, c = 1, Calc()',
      '    assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: loop target (`for c in [Calc(), Calc()]:`)', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    for c in [Calc(), Calc()]:',
      '        assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: `with` target (`with Calc() as c:`)', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    with Calc() as c:',
      '        assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: walrus target (`if (c := Calc()):`)', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    if (c := Calc()):',
      '        assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: `global` receiver binding', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'c = None',
      '',
      'def make():',
      '    global c',
      '    c = Calc()',
      '',
      'def test_add():',
      '    make()',
      '    assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: file-wide `unittest.mock` import taints EVERY instance credit in the file', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      'from unittest.mock import MagicMock',
      '',
      'def test_add():',
      '    assert Calc().add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, [], 'mock import must refuse an otherwise-creditable inline call');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: file-wide `pytest_mock` import taints every instance credit', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      'import pytest_mock',
      '',
      'def test_add():',
      '    assert Calc().add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: `monkeypatch` fixture parameter anywhere in the file taints every instance credit', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_setup(monkeypatch):',
      '    pass',
      '',
      'def test_add():',
      '    assert Calc().add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, [], 'a monkeypatch fixture ELSEWHERE in the file still taints (coarse gate, mirrors MOCK_TAINT)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: `@patch` decorator anywhere in the file taints every instance credit', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      'from unittest.mock import patch',
      '',
      "@patch('calc.Calc')",
      'def test_patched(mock_calc):',
      '    pass',
      '',
      'def test_add():',
      '    assert Calc().add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst DEFER: `self.calc = Calc()` in setUp + `self.calc.add()` in test — receiver is an Attribute, not a Name', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'import unittest',
      'from calc import Calc',
      '',
      'class T(unittest.TestCase):',
      '    def setUp(self):',
      '        self.calc = Calc()',
      '',
      '    def test_add(self):',
      '        self.assertEqual(self.calc.add(2, 3), 5)',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, [], 'self.attr receivers are DEFER this pass — never captured as a Name');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE (§8.1 shadow): the test module itself rebinds the ctor name besides its import', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    class Calc:',
      '        def add(self, a, b):',
      '            return 999',
      '    assert Calc().add(2, 3) == 999',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, [], 'a test-local `class Calc` shadows the import — crediting would gut the wrong file (false HOLLOW, live pre-fix on JS)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: chained `Calc().add(2,3).total()` — both `add` and `total` refuse', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    assert Calc().add(2, 3).total() == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('py_blocks inst REFUSE: builder `Calc().build().add()` — both refuse', { skip: !HAS_PY }, () => {
  const d = project({
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_add():',
      '    assert Calc().build().add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = pyBlocks(abs(d, 'test_calc.py'));
    assert.deepEqual(r.blocks.find((x) => x.name === 'test_add').inst, []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// =========================================================================================
// C) SUT-file-side: resolvePyClassMember() — plan §5.2 Python REFUSE rows that live in the SRC ast
// =========================================================================================

function memberProject(srcBody) {
  const d = project({ 'calc.py': srcBody });
  const pyImports = [{ local: 'Calc', module: 'calc', level: 0 }];
  const absTest = abs(d, 'test_calc.py');
  const srcFiles = [abs(d, 'calc.py')];
  return { d, pyImports, absTest, srcFiles };
}

test('resolvePyClassMember: positive control — a plain class+method resolves', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    def add(self, a, b):',
    '        return a + b',
    '',
  ].join('\n'));
  try {
    const sutRel = resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d);
    assert.equal(sutRel, 'calc.py');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: X is a function, not a class (`def Calc(...)`)', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'def Calc(x=None):',
    '    return x',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: src module binds X more than once (class + later reassignment)', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    def add(self, a, b):',
    '        return a + b',
    '',
    'Calc = None',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: @staticmethod add', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    @staticmethod',
    '    def add(a, b):',
    '        return a + b',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: @property add', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    @property',
    '    def add(self):',
    '        return 5',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: decorated class (any decorator)', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'def deco(cls):',
    '    return cls',
    '',
    '@deco',
    'class Calc:',
    '    def add(self, a, b):',
    '        return a + b',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: class with a metaclass keyword', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Meta(type):',
    '    pass',
    '',
    'class Calc(metaclass=Meta):',
    '    def add(self, a, b):',
    '        return a + b',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: nested class (not module-top-level)', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Outer:',
    '    class Calc:',
    '        def add(self, a, b):',
    '            return a + b',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: `async def add`', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    async def add(self, a, b):',
    '        return a + b',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: first param not literally `self` (`cls`)', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    def add(cls, a, b):',
    '        return a + b',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: `add` is inherited-only (declared on a base, not on Calc itself)', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Base:',
    '    def add(self, a, b):',
    '        return a + b',
    '',
    'class Calc(Base):',
    '    pass',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('resolvePyClassMember REFUSE: module-level `def add` PLUS the class method `add` in one file', { skip: !HAS_PY }, () => {
  const { d, pyImports, absTest, srcFiles } = memberProject([
    'class Calc:',
    '    def add(self, a, b):',
    '        return a + b',
    '',
    'def add(x, y):',
    '    return x + y',
    '',
  ].join('\n'));
  try {
    assert.equal(resolvePyClassMember('Calc', 'add', pyImports, absTest, srcFiles, d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// =========================================================================================
// D) e2e: prove() end to end — the fx-py shape flips (plan §1 repro matrix) + hollow twins
// =========================================================================================

test('PROVE python e2e: inline `Calc().add(2,3)` AND variable `c=Calc(); c.add(2,3)` both flip to PROVEN (2/2), previously 0 scored', { skip: !HAS_PYTEST }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': [
      'class Calc:',
      '    def add(self, a, b):',
      '        return a + b',
      '',
    ].join('\n'),
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_inline():',
      '    assert Calc().add(2, 3) == 5',
      '',
      'def test_variable():',
      '    c = Calc()',
      '    assert c.add(2, 3) == 5',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.skipped.some((s) => s.name === 'test_inline'), 'inline receiver call must not be skipped (was: sut-unresolved via the dead-end ctor name)');
    assert.ok(!r.skipped.some((s) => s.name === 'test_variable'), 'variable receiver call must not be skipped (was: no-pin)');
    assert.equal(r.caught, 2, 'both the inline and variable receiver forms must be PROVEN (2/2)');
    assert.equal(r.hollow.length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE python e2e: hollow twins — a tautological (self-echo) receiver assertion survives gutting and is flagged hollow', { skip: !HAS_PYTEST }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': [
      'class Calc:',
      '    def add(self, a, b):',
      '        return a + b',
      '',
    ].join('\n'),
    'test_calc.py': [
      'from calc import Calc',
      '',
      'def test_inline_hollow():',
      '    assert Calc().add(2, 3) == Calc().add(2, 3)',
      '',
      'def test_variable_hollow():',
      '    c = Calc()',
      '    assert c.add(2, 3) == c.add(2, 3)',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(r.hollow.some((h) => h.name === 'test_inline_hollow'), 'inline self-echo assertion must be flagged hollow (survives gutting)');
    assert.ok(r.hollow.some((h) => h.name === 'test_variable_hollow'), 'variable self-echo assertion must be flagged hollow (survives gutting)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- T0b regression, re-confirmed under T4: the class+factory collision fixture uses the INLINE shape
// (`Calc().add(2,3)`) — the new inst path must NOT rescue it. resolvePyClassMember's member_ok also
// refuses (the src module binds `Calc` twice — a def AND a class), so this must still land in skipped,
// never a verdict, exactly as T0b's own test at test/prove.test.mjs asserts. ----
test('PROVE python e2e: the T0b class+factory collision (INLINE shape) still refuses under the new inst path — no false HOLLOW, no false CAUGHT', { skip: !HAS_PYTEST }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': [
      'def Calc(x=None):',
      '    return x',
      '',
      'class Calc:',
      '    def add(self, a, b):',
      '        return a + b',
      '',
    ].join('\n'),
    'test_calc.py': [
      'import unittest',
      'from calc import Calc',
      '',
      'class T(unittest.TestCase):',
      '    def test_add(self):',
      '        self.assertEqual(Calc().add(2, 3), 5)',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.hollow.some((h) => h.name === 'test_add'), 'must never mint a HOLLOW verdict');
    const s = r.skipped.find((x) => x.name === 'test_add');
    assert.ok(s, 'must land in skipped, never a verdict');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
