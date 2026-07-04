import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prove, formatReport, eligibleFns, topLevelCallees, parseRun, parseBlocks, detectRunner, changedFilesSince, importMap, testCmdFor, RUNNERS, ambiguousNames } from '../mutation/prove.mjs';

const FIX = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/runner-output', n), 'utf8');
const PROVE_CLI = resolve('mutation/prove.mjs'); // mirrors how the "PROVE CLI --json" test below locates the CLI
// mirrors prove.mjs's internal reEsc (not exported) — used only to build the expected mocha --grep arg.
const reEscForTest = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'sk-prove-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
// gated e2e fixtures need the runner package ITSELF resolvable from inside the fixture: mocha's
// describe()/it() are CLI-injected globals so it never needs this, but ava/vitest test files `import`
// their own package, and jest's worker pool needs a real local install to reliably pipe output back.
// Without this, `npx <runner>` (no --no-install in testCmdFor) silently falls back to fetching whatever
// is CURRENTLY LATEST off the registry (verified: mocha 11.7.6 / ava 8.0.1 — NOT our pinned devDependency
// majors) — slow, network-dependent, and not actually proving the version we ship against. Symlinking the
// repo's own node_modules into the fixture makes prove()'s own internal work-dir symlink
// (`work/node_modules -> dir/node_modules`) resolve our PINNED local install deterministically and offline.
function projectWithRunner(files) {
  const d = project(files);
  symlinkSync(resolve('node_modules'), join(d, 'node_modules'), 'dir');
  return d;
}

const HAS_PY = (() => { try { execSync('python3 --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
// gated e2e runner availability: `npx --no-install` fails cleanly (no install attempt) when the
// runner isn't present, so these gates are a pure probe — never a dependency add.
const has = (bin) => { try { execSync(`npx --no-install ${bin} --version`, { stdio: 'ignore' }); return true; } catch { return false; } };
const HAS_MOCHA = has('mocha');
const HAS_AVA = has('ava');
const HAS_VITEST = has('vitest');
const HAS_JEST = has('jest');

// ---- unit: the assertion-strength gate ----
test('eligibleFns: value-pinning assertions make the consumed fn eligible', () => {
  assert.deepEqual(eligibleFns('assert.strictEqual(add(2,3), 5);', ['add']), ['add']);
  assert.deepEqual(eligibleFns('expect(score(a,b)).toBe(1);', ['score']), ['score']);
});
test('eligibleFns: a one-variable hop is followed', () => {
  assert.deepEqual(eligibleFns('const s = score(a, b);\nexpect(s).toBeCloseTo(1.0, 2);', ['score']), ['score']);
});
test('topLevelCallees: only the value-producing outer call, not nested argument calls', () => {
  assert.deepEqual(topLevelCallees("run(['--config', join(ROOT, 'x')])"), ['run']);
  assert.deepEqual(topLevelCallees('compute(5)'), ['compute']);
  assert.deepEqual(topLevelCallees('wrap(a) + tag(b)'), ['wrap', 'tag']); // two top-level calls both count
});
test('eligibleFns: a nested incidental call in the hop RHS is NOT attributed', () => {
  // r is pinned via r.status; the RHS calls run(...) and incidental join(...). Only run is eligible.
  const body = "const r = run(['--config', join(ROOT,'x')]);\nassert.strictEqual(r.status, 2);";
  assert.deepEqual(eligibleFns(body, ['run', 'join']).sort(), ['run']);
});
test('eligibleFns: weak assertions do NOT make a fn eligible (the navGraph FP class)', () => {
  assert.deepEqual(eligibleFns('expect(getNode(e.from)).toBeDefined();', ['getNode']), []);
  assert.deepEqual(eligibleFns('assert.ok(total(items) !== null);', ['total']), []);
  assert.deepEqual(eligibleFns('expect(a).not.toBe(b);\nexpect(getNode(x)).toBeTruthy();', ['getNode']), []);
});
test('eligibleFns: widened value-pin matchers make the consumed fn eligible', () => {
  assert.deepEqual(eligibleFns("expect(() => parse('x')).toThrow();", ['parse']), ['parse']);
  assert.deepEqual(eligibleFns("expect(tags(x)).toContain('a');", ['tags']), ['tags']);
  assert.deepEqual(eligibleFns('expect(build(1)).toMatchObject({id:1});', ['build']), ['build']);
  assert.deepEqual(eligibleFns('expect(list(x)).toHaveLength(3);', ['list']), ['list']);
  assert.deepEqual(eligibleFns('expect(slug(x)).to.equal("a-b");', ['slug']), ['slug']); // chai
});
test('eligibleFns: genuinely weak matchers still do NOT make a fn eligible', () => {
  assert.deepEqual(eligibleFns('expect(getNode(x)).toBeDefined();', ['getNode']), []);
  assert.deepEqual(eligibleFns('expect(getNode(x)).toBeTruthy();', ['getNode']), []);
});
test('eligibleFns: chai matchers that PASS against the numeric sentinel are NOT eligible (no false HOLLOW)', () => {
  assert.deepEqual(eligibleFns('expect(slug(x)).to.match(/^[a-z0-9-]+$/);', ['slug']), []);   // chai coerces → passes sentinel
  assert.deepEqual(eligibleFns("expect(num(x)).to.have.a('number');", ['num']), []);          // type-assertion passes for a number
  assert.deepEqual(eligibleFns("expect(num(x)).to.have.an('number');", ['num']), []);
});
test('eligibleFns: sound chai have-subforms remain eligible', () => {
  assert.deepEqual(eligibleFns('expect(list(x)).to.have.lengthOf(3);', ['list']), ['list']);
  assert.deepEqual(eligibleFns("expect(obj(x)).to.have.keys('a', 'b');", ['obj']), ['obj']);
});
test('eligibleFns: bare-path property existence is NOT eligible (autoboxing passes the numeric sentinel)', () => {
  assert.deepEqual(eligibleFns("expect(t(x)).toHaveProperty('toString');", ['t']), []);
  assert.deepEqual(eligibleFns("expect(t(x)).to.have.property('constructor');", ['t']), []);
});
test('eligibleFns: import-aware aliased assert member form (t.strictEqual)', () => {
  const body = "var t = require('assert');\nt.strictEqual(add(2,3), 5);";
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['t', 'assert']])), ['add']);
});
test('eligibleFns: import-aware destructured assert (bare strictEqual)', () => {
  const body = "const { strictEqual } = require('node:assert');\nstrictEqual(add(2,3), 5);";
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['strictEqual', 'node:assert']])), ['add']);
});
test('eligibleFns: an aliased assert bound to a NON-assert module is NOT recognized', () => {
  const body = "const t = require('lodash');\nt.equal(add(2,3), 5);"; // lodash, not assert
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['t', 'lodash']])), []);
});
test('eligibleFns: hybrid fallback pins X.strictEqual(a,b) when X is an undetectable alias', () => {
  const body = "t.strictEqual(add(2,3), 5);"; // t not in imports at all
  assert.deepEqual(eligibleFns(body, ['add'], new Map()), ['add']);
});
test('eligibleFns: fallback does NOT fire for a 1-arg method (chai .to.equal / set.equal)', () => {
  // chai: expect(...).to.equal(y) already handled by expect-path; the bare `to.equal(y)` is 1-arg → not an assert pin
  assert.deepEqual(eligibleFns("const s = other(); s.equal(add(1,2));", ['add'], new Map()), []); // 1 arg
});
test('eligibleFns: fallback does NOT fire when X is bound to a non-assert module', () => {
  const body = "const t = require('lodash');\nt.equal(add(2,3), 5);";
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['t', 'lodash']])), []);
});
test('eligibleFns: fallback does not mis-pin jest toStrictEqual', () => {
  // expect(add(2,3)).toStrictEqual(5) IS already eligible via the expect/VALUE_PIN path — assert add still eligible,
  // but NOT via the assert fallback (toStrictEqual is not `.strictEqual` right after a dot).
  assert.deepEqual(eligibleFns("expect(add(2,3)).toStrictEqual(5);", ['add'], new Map()), ['add']);
});

// ---- unit: strings/comments are masked before the pin gate scans (no false HOLLOW from a code sample) ----
test('eligibleFns: an assertion inside a string literal does not pin (masking)', () => {
  const body = 'const code = "assert.equal(foo(2), 5)";\nassert.strictEqual(bar(1), 2);';
  assert.deepEqual(eligibleFns(body, ['foo', 'bar']).sort(), ['bar']); // foo referenced only in a string → NOT eligible
});
test('eligibleFns: the assert-fallback does not fire inside a string (masking)', () => {
  const body = 'const sample = "obj.equal(foo(2), bar)";\nassert.strictEqual(baz(1), 2);';
  assert.deepEqual(eligibleFns(body, ['foo', 'baz']).sort(), ['baz']);
});
test('eligibleFns: a commented-out assertion does not pin (masking)', () => {
  const body = '// assert.strictEqual(foo(2), 5)\nassert.strictEqual(bar(1), 2);';
  assert.deepEqual(eligibleFns(body, ['foo', 'bar']).sort(), ['bar']);
});
test('eligibleFns: a real assertion with a STRING expected value still pins (masking preserves real code)', () => {
  assert.deepEqual(eligibleFns('expect(slug(x)).to.equal("a-b");', ['slug']), ['slug']);
});

// ---- unit: standalone chai `should` chains (no `expect(...)` wrapper) ----
test('eligibleFns: chai should — direct call receiver', () => {
  assert.deepEqual(eligibleFns("add(2,3).should.equal(5);", ['add']), ['add']);
});
test('eligibleFns: chai should — via a one-variable hop', () => {
  assert.deepEqual(eligibleFns("const r = add(2,3);\nr.should.equal(5);", ['add']), ['add']);
});
test('eligibleFns: chai should — sound have-form (lengthOf)', () => {
  assert.deepEqual(eligibleFns("list(x).should.have.lengthOf(3);", ['list']), ['list']);
});
test('eligibleFns: chai should — UNSOUND forms are NOT eligible', () => {
  assert.deepEqual(eligibleFns("thing(x).should.have.property('id');", ['thing']), []);   // property autoboxes
  assert.deepEqual(eligibleFns("slug(x).should.match(/^[a-z]+$/);", ['slug']), []);        // match string-coerces
  assert.deepEqual(eligibleFns("flag(x).should.be.true;", ['flag']), []);                  // .be.* excluded
});

// ---- unit: import-aware SUT binding parses a test file's import bindings ----
test('importMap: relative, bare, builtin, default, namespace specifiers', () => {
  const code = `import { join } from 'node:path';
import { add, sub as minus } from '../src/math.mjs';
import flatten from 'lodash/flatten';
import * as utils from './utils.js';`;
  const m = importMap(code);
  assert.equal(m.get('join'), 'node:path');      // builtin
  assert.equal(m.get('add'), '../src/math.mjs'); // relative
  assert.equal(m.get('minus'), '../src/math.mjs'); // aliased
  assert.equal(m.get('flatten'), 'lodash/flatten'); // bare dep
  assert.equal(m.get('utils'), './utils.js');    // namespace
});

// ---- unit: result parsing never trusts the exit code ----
test('parseRun reads passed/failed from the runner summary', () => {
  assert.deepEqual(parseRun('vitest', ' Tests  1 passed | 14 skipped (15)'), { passed: 1, failed: 0 });
  assert.deepEqual(parseRun('vitest', ' Tests  2 failed | 13 passed (15)'), { passed: 13, failed: 2 });
  assert.deepEqual(parseRun('node', '# pass 5\n# fail 0\n'), { passed: 5, failed: 0 });
});
test('parseRun reads mocha TAP summary from a recorded fixture', () => {
  assert.deepEqual(parseRun('mocha', FIX('mocha-2pass-1fail.txt')), { passed: 2, failed: 1 });
});
test('parseRun reads ava TAP summary from a recorded fixture', () => {
  assert.deepEqual(parseRun('ava', FIX('ava-2pass-1fail.txt')), { passed: 2, failed: 1 });
});
test('detectRunner recognizes mocha and ava from deps, jest/vitest still take precedence', () => {
  const m = project({ 'package.json': '{"devDependencies":{"mocha":"^10"}}' });
  const a = project({ 'package.json': '{"devDependencies":{"ava":"^6"}}' });
  const j = project({ 'package.json': '{"devDependencies":{"jest":"^29","mocha":"^10"}}' });
  try {
    assert.equal(detectRunner(m), 'mocha');
    assert.equal(detectRunner(a), 'ava');
    assert.equal(detectRunner(j), 'jest', 'jest wins over mocha when both present');
  } finally { for (const d of [m, a, j]) rmSync(d, { recursive: true, force: true }); }
});
test('testCmdFor: mocha uses --reporter tap + --grep with a REGEX-escaped name', () => {
  assert.deepEqual(testCmdFor('mocha', 't.js', 'a.b(c)'),
    { cmd: 'npx', args: ['mocha', 't.js', '--reporter', 'tap', '--grep', reEscForTest('a.b(c)')] });
});
test('testCmdFor: ava uses --tap + -m with the RAW name (glob, not regex)', () => {
  assert.deepEqual(testCmdFor('ava', 't.js', 'a.b(c)'),
    { cmd: 'npx', args: ['ava', 't.js', '--tap', '-m', 'a.b(c)'] });
});
// ---- fail-closed ambiguity detection: could this block's runner selection ALSO match a sibling in the
// same file? (the exact cross-test misattribution that flipped a true HOLLOW into a false CAUGHT — see
// .superpowers/sdd/recall-investigation.md). Pure + unit-testable, no runner spawned.
test('ambiguousNames: node is anchored — only an EXACT duplicate title is ambiguous', () => {
  assert.deepEqual(ambiguousNames(['a', 'a', 'b'], 'node'), new Set(['a']));
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'node'), new Set());
});
test('ambiguousNames: vitest -t is substring-either-direction — a prefix pair is ambiguous', () => {
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'vitest'), new Set(['adds', 'adds two']));
});
test('ambiguousNames: jest, mocha and pytest use the same substring-either-direction rule', () => {
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'jest'), new Set(['adds', 'adds two']));
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'mocha'), new Set(['adds', 'adds two']));
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'pytest'), new Set(['adds', 'adds two']));
});
test('ambiguousNames: ava -m follows matcher v5 — exact duplicates, `*` wildcard, and leading-`!` negation are ambiguous; `?[{` are literals', () => {
  assert.deepEqual(ambiguousNames(['a', 'a', 'b'], 'ava'), new Set(['a']));
  assert.deepEqual(ambiguousNames(['a*b', 'c'], 'ava'), new Set(['a*b']));
  assert.deepEqual(ambiguousNames(['!negated', 'c'], 'ava'), new Set(['!negated']));
  assert.deepEqual(ambiguousNames(['a?b[x]{y}', 'c'], 'ava'), new Set(), 'matcher treats ?[{ as plain literals — not ambiguous');
});
test('runner-completeness: every RUNNERS entry has a command spec and a parseRun branch that reads a fixture', () => {
  const FIXTURES = { // representative output + known counts per runner
    node:   { out: '# pass 2\n# fail 1\n', passed: 2, failed: 1 },
    vitest: { out: ' Tests  1 failed | 2 passed (3)', passed: 2, failed: 1 },
    jest:   { out: 'Tests: 1 failed, 2 passed, 3 total', passed: 2, failed: 1 },
    pytest: { out: '2 passed, 1 failed in 0.01s', passed: 2, failed: 1 },
    mocha:  { out: FIX('mocha-2pass-1fail.txt'), passed: 2, failed: 1 },
    ava:    { out: FIX('ava-2pass-1fail.txt'), passed: 2, failed: 1 },
  };
  for (const r of RUNNERS) {
    const spec = testCmdFor(r, 'x.test.js', 'my test');
    assert.ok(spec && spec.cmd && Array.isArray(spec.args) && spec.args.length > 0, `${r}: testCmdFor must return a non-empty {cmd,args}`);
    assert.ok(FIXTURES[r], `${r}: needs a parseRun fixture in the completeness test`);
    assert.deepEqual(parseRun(r, FIXTURES[r].out), { passed: FIXTURES[r].passed, failed: FIXTURES[r].failed }, `${r}: parseRun must read its output`);
  }
});
test('parseBlocks finds it()/test() names and bodies', () => {
  const b = parseBlocks("test('a', () => { foo(); });\nit('b', async () => { bar(); });", 'js');
  assert.deepEqual(b.map((x) => x.name), ['a', 'b']);
});
test('parseBlocks: function() callbacks and .only/.skip/.concurrent modifiers are found', () => {
  const code = [
    "it('arrow', () => { foo(); });",
    "it('fn', function () { bar(); });",
    "test.only('only', () => { baz(); });",
    "it.skip('skip', () => { qux(); });",
    "test.concurrent('conc', async () => { zap(); });",
  ].join('\n');
  assert.deepEqual(parseBlocks(code, 'js').map((b) => b.name), ['arrow', 'fn', 'only', 'skip', 'conc']);
});

// ---- integration: run the real probe over a synthetic node:test project ----
const SUT = `export function add(a, b){ return a + b; }
export function total(items){ return items.reduce((s, i) => s + i.p * i.q, 0); }
export function fmt(n){ return '$' + n.toFixed(2); }
`;
const head = "import { test } from 'node:test'; import assert from 'node:assert';";

test('PROVE: sound tests are caught, an imported-SUT shadow is HOLLOW, a weak assertion is not probed', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': SUT,
    'test/t.test.mjs': `${head} import { add, total, fmt } from '../src/lib.mjs';
test('add sound', () => { assert.strictEqual(add(2, 3), 5); });
test('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });
test('weak', () => { assert.ok(total([{p:1,q:2}]) !== null); });
test('fmt sound', () => { assert.strictEqual(fmt(13.5), '$13.50'); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'node');
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 2, 'add + fmt caught');
    assert.equal(r.hollow.length, 1, 'the shadow is the only hollow');
    assert.equal(r.hollow[0].name, 'shadow');
    assert.ok(r.hollow[0].survivors.includes('total'));
    // the weak `assert.ok(... !== null)` block must NOT be flagged hollow — it is left unprobed
    assert.ok(!r.hollow.some((h) => h.name === 'weak'), 'weak block not flagged');
    assert.ok(r.skipped.some((s) => s.name === 'weak'), 'weak block skipped as non-pinning');
    assert.equal(r.scored, 3);
    // a RELATIVE dir must work too (else the node_modules symlink target resolves to itself)
    const rel = prove(relative(process.cwd(), d), { runner: 'node' });
    assert.equal(rel.caught, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE: a generator SUT is resolved and probed (not silently skipped)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/gen.mjs': 'export function* range(n){ for (let i = 0; i < n; i++) yield i; }\n',
    'test/g.test.mjs': `${head} import { range } from '../src/gen.mjs';
test('range', () => { const it = range(3); assert.strictEqual(it.next().value, 0); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 1, 'the generator test is probed and caught');
    assert.ok(!r.skipped.some((s) => s.name === 'range'), 'range not skipped — its SUT resolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a test NAME containing shell-special characters must not corrupt the single-test run: the runner
// invocation is argv (execFileSync), never a shell string, so a backtick/`$(...)` in the name is inert. ----
test('PROVE: a test name with a backtick and $(...) is genuinely probed — no false HOLLOW from shell metacharacters', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': "export function wrap(x){ return '[' + x + ']'; }\n",
    'test/t.test.mjs': head + " import { wrap } from '../src/lib.mjs';\n"
      + "test('wraps `x` as $(literal)', () => { assert.strictEqual(wrap('a'), '[a]'); });\n",
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 1, 'gutting wrap() genuinely fails the backtick/$ named test');
    assert.equal(r.hollow.length, 0, 'must not be reported hollow — the shell never sees the name');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- depth tier: --deep exposes fixed-point-weak tests with an identity stub ----
test('PROVE --deep: a fixed-point input is flagged weak; a discriminating test and a true identity fn are not', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': `export function norm(s){ return s.trim().toLowerCase(); }
export function echo(x){ return x; }
`,
    'test/t.test.mjs': `${head} import { norm, echo } from '../src/lib.mjs';
test('fixed point', () => { assert.strictEqual(norm('hello'), 'hello'); });
test('discriminating', () => { assert.strictEqual(norm('  Hi  '), 'hi'); });
test('identity ok', () => { assert.strictEqual(echo('a'), 'a'); });
`,
  });
  try {
    const base = prove(d, { runner: 'node' });
    assert.equal(base.caught, 3, 'all three are caught by gross gutting');
    assert.ok(!base.weak || base.weak.length === 0, 'the weak advisory is opt-in (off without --deep)');
    const deep = prove(d, { runner: 'node', deep: true });
    assert.equal(deep.caught, 3, '--deep does not change the gross verdict');
    assert.ok(deep.weak && deep.weak.some((w) => w.name === 'fixed point' && w.fn === 'norm'),
      'the fixed-point test is flagged weak');
    assert.ok(!deep.weak.some((w) => w.name === 'discriminating'), 'a discriminating test is not weak');
    assert.ok(!deep.weak.some((w) => w.name === 'identity ok'), 'a true identity fn is not weak (the guard holds)');
    // true denominators (Task 6): norm is attempted for BOTH the 'fixed point' and 'discriminating' blocks
    // (each broke under gross break, so each reaches the deep tier) — 2 stubbed. The identity stub survives
    // only 'fixed point' (norm('hello') is already trimmed+lowercased — a fixed point of the transform) —
    // 1 passed. echo's body already literally IS `return x`; passthroughBreak declines (nothing to expose),
    // so echo never gets attempted and carries no weakSummary entry at all.
    assert.deepEqual(deep.weakSummary, { norm: { stubbed: 2, passed: 1 } });
    assert.equal(base.weakSummary, undefined, 'weakSummary is opt-in (omitted without --deep)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- formatReport: the identity-stub advisory renders per-FUNCTION ratios from weakSummary, never a
// per-test list (Task 6 — audit-gated promotion; see .superpowers/sdd/weak-audit.md) ----
test('formatReport renders the identity-stub advisory per-fn from weakSummary (hand-derived ratios)', () => {
  const r = {
    scopeError: null, scored: 2, caught: 2, hollow: [], skipped: [], inconclusive: [], probes: 5, runner: 'node', pct: 100,
    // hand-derived: norm was attempted 3x across the suite and the identity stub survived 2 of those 3;
    // echo was attempted once and the stub was CAUGHT every time (0 of 1 survived) — a success story, not
    // an advisory (final-review wave, item 6): a passed:0 row must be OMITTED, not rendered with the same
    // "may cover only fixed points" caveat that only applies when the stub actually survived.
    weak: [
      { file: 'test/t.test.mjs', line: 3, name: 'fixed point', fn: 'norm' },
      { file: 'test/t.test.mjs', line: 20, name: 'another fixed point', fn: 'norm' },
    ],
    weakSummary: { norm: { stubbed: 3, passed: 2 }, echo: { stubbed: 1, passed: 0 } },
  };
  const out = formatReport(r);
  assert.match(out, /identity-stub advisory \(--deep\): tests that pass when the function is replaced by a passthrough/);
  assert.match(out, /~ norm: 2 of 3 identity-stub probes passed — may cover only fixed points \(no-op tests do this by design\)/);
  assert.doesNotMatch(out, /~ echo:/, 'a passed:0 fn is a success story (every stub was caught) — omitted, not advised against');
  assert.doesNotMatch(out, /"fixed point"/, 'the per-test list is replaced by the per-fn form — no test names rendered');
});

test('formatReport: zero weak findings render no identity-stub section (byte-level null canary — no --deep)', () => {
  const r = { scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100, weak: [] };
  const out = formatReport(r);
  assert.doesNotMatch(out, /identity-stub advisory/, 'weak: [] (no --deep) must render nothing new');
});

// ---- diff scope ----
const TWOFILE = {
  'package.json': '{"type":"module"}',
  'src/lib.mjs': SUT,
  'test/a.test.mjs': `${head} import { add } from '../src/lib.mjs';\ntest('a sound', () => { assert.strictEqual(add(1, 2), 3); });`,
  'test/b.test.mjs': `${head} import { fmt } from '../src/lib.mjs';\ntest('b sound', () => { assert.strictEqual(fmt(5), '$5.00'); });`,
};
test('PROVE --scope: only blocks whose test file OR a probed source file changed are probed', () => {
  const d = project(TWOFILE);
  try {
    // only test/a changed → b is out of scope
    const onlyA = prove(d, { runner: 'node', changed: new Set([resolve(d, 'test/a.test.mjs')]) });
    assert.equal(onlyA.caught, 1);
    assert.equal(onlyA.outOfScope, 1);
    // a shared SOURCE file changed → BOTH tests are in scope, even though neither test file changed
    const srcChanged = prove(d, { runner: 'node', changed: new Set([resolve(d, 'src/lib.mjs')]) });
    assert.equal(srcChanged.caught, 2);
    assert.equal(srcChanged.outOfScope, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// ---- ambiguity gates ONLY would-be-probed blocks: an out-of-scope ambiguous block must stay in its own
// bucket (outOfScope), never leak into inconclusive — otherwise every diff-scoped run (the Stop hook, the
// corpus re-drive) gets corrupted outOfScope/inconclusive denominators from files it didn't even touch. ----
test('PROVE: ambiguity applies only to would-be-probed blocks — out-of-scope ambiguous blocks stay outOfScope', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a,b){ return a+b; }\nexport function dbl(x){ return x*2; }\n',
    'test/amb.test.mjs': `${head} import { add } from '../src/lib.mjs';
test('dup', () => { assert.strictEqual(add(1, 2), 3); });
test('dup', () => { assert.strictEqual(add(2, 2), 4); });
`,
    'test/other.test.mjs': `${head} import { dbl } from '../src/lib.mjs';
test('other', () => { assert.strictEqual(dbl(3), 6); });
`,
  });
  try {
    // only test/other changed → the ambiguous file is OUT of scope: counted there, never inconclusive
    const out = prove(d, { runner: 'node', changed: new Set([resolve(d, 'test/other.test.mjs')]) });
    assert.equal(out.outOfScope, 2, 'both out-of-scope ambiguous blocks count in outOfScope');
    assert.equal(out.inconclusive.length, 0, 'no ambiguity verdict on an out-of-scope block');
    assert.equal(out.caught, 1, 'the in-scope block is probed normally');
    // the ambiguous file itself changed → in scope → fail-closed to inconclusive with the exact reason
    const inn = prove(d, { runner: 'node', changed: new Set([resolve(d, 'test/amb.test.mjs')]) });
    assert.equal(inn.outOfScope, 1, 'the unrelated file is out of scope');
    assert.equal(inn.inconclusive.length, 2, 'both in-scope ambiguous blocks are fail-closed');
    assert.ok(inn.inconclusive.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'),
      'the exact contract string is reported');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('changedFilesSince: tracked edits and untracked new files since a ref', () => {
  const d = project({ 'package.json': '{"type":"module"}', 'src/lib.mjs': SUT });
  try {
    execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init', { cwd: d });
    writeFileSync(join(d, 'src/lib.mjs'), SUT + '\n// edit');
    writeFileSync(join(d, 'src/new.mjs'), 'export const x = 1;\n');
    const changed = changedFilesSince(d, 'HEAD');
    assert.ok([...changed].some((p) => p.endsWith('/src/lib.mjs')), 'tracked edit seen');
    assert.ok([...changed].some((p) => p.endsWith('/src/new.mjs')), 'untracked new file seen');
    assert.equal(changedFilesSince(d, 'no-such-ref'), null, 'bad ref → null');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a symlinked project path must not silently drop in-scope tests ----
// git resolves --show-toplevel to the CANONICAL path, so the changed-file set is canonical; if prove
// keeps a non-canonical (symlinked) dir, absTest never matches `changed` and every block is dropped as
// out-of-scope — a silent false negative (a real hollow test missed). prove must canonicalize its dir.
test('PROVE --since via a symlinked project path scopes correctly (canonical git root)', () => {
  const real = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n',
  });
  execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init', { cwd: real });
  mkdirSync(join(real, 'test'), { recursive: true }); // the agent "just wrote" an untracked hollow test
  writeFileSync(join(real, 'test/t.test.mjs'), `${head} import { total } from '../src/lib.mjs';
test('totals', () => { const e = total([{p:2,q:3}]); assert.strictEqual(total([{p:2,q:3}]), e); });
`);
  const link = `${real}-link`;
  symlinkSync(real, link);
  try {
    const r = prove(link, { runner: 'node', since: 'HEAD' });
    assert.equal(r.outOfScope, 0, 'the changed test is in scope despite the symlinked path');
    assert.equal(r.hollow.length, 1, 'the hollow test is found, not silently dropped');
  } finally { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); }
});

// ---- the probe cap bounds latency and is reported, never a silent truncation (R6) ----
test('PROVE maxProbes caps the probed blocks and reports the cap (no silent truncation)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function a(x){return x+1;}\nexport function b(x){return x+2;}\nexport function c(x){return x+3;}\n',
    'test/t.test.mjs': `${head} import { a, b, c } from '../src/lib.mjs';
test('a', () => { assert.strictEqual(a(1), 2); });
test('b', () => { assert.strictEqual(b(1), 3); });
test('c', () => { assert.strictEqual(c(1), 4); });
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 3, 'all three are probed without a cap');
    const capped = prove(d, { runner: 'node', maxProbes: 1 });
    assert.equal(capped.probes, 1, 'only one block probed under maxProbes:1');
    assert.equal(capped.capped, 2, 'the other two are reported as capped, not silently dropped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a flaky test must never be reported HOLLOW (R5) ----
// The fixture passes its first two runs (the unmutated baseline, then the gutted mutant — its oracle
// re-runs the SUT so the gross break can't break it) and throws on its THIRD run. Without the flake
// guard prove sees baseline-green + mutant-survives and calls it HOLLOW; with the guard it re-runs the
// unmutated test before declaring HOLLOW, the third run fails, and the verdict is INCONCLUSIVE.
test('PROVE: a flaky test (unstable green) is INCONCLUSIVE, never a false HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n',
    'test/flaky.test.mjs': `${head}
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { total } from '../src/lib.mjs';
const counter = fileURLToPath(new URL('./.c', import.meta.url));
test('flaky hollow', () => {
  let n = 0; try { n = Number(readFileSync(counter, 'utf8')) || 0; } catch {}
  writeFileSync(counter, String(n + 1));
  if (n >= 2) throw new Error('flake');
  const e = total([{p:2,q:3}]); assert.strictEqual(total([{p:2,q:3}]), e);
});
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0, 'a flaky test must not be reported HOLLOW');
    assert.ok(r.inconclusive.some((x) => /flaky/.test(x.why)), 'flaky test → inconclusive');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- ambiguous SUT resolution must never produce a false HOLLOW ----
test('PROVE: a fn name declared in two source files resolves to the IMPORTED one (no false HOLLOW)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/real.mjs': 'export function area(r){ return 3.14159 * r * r; }\n',
    'src/decoy.mjs': 'export function area(r){ return 0; }\n', // same name, NOT imported by the test
    'test/t.test.mjs': `${head} import { area } from '../src/real.mjs';
test('area', () => { assert.strictEqual(Math.round(area(2)), 13); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // import-aware binding resolves `area` to the IMPORTED real.mjs (decoy is ignored), so it is probed + caught
    assert.equal(r.caught, 1, 'the imported SUT is resolved and caught, not skipped');
    assert.ok(!r.hollow.some((h) => h.name === 'area'), 'still never a false hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// NOTE on this fixture: a second real, independently-resolvable SUT call in the same block (e.g. a `run()`
// imported from its own source file) would mask the bug under test — if THAT call genuinely breaks when
// gutted, the block is reported "caught" regardless of whether `join` is (mis)bound, because `prove()`
// ORs catch-status across every probed fn in a block. So `join` must be the ONLY probed/resolvable fn here
// for this test to actually discriminate buggy vs. fixed binding (verified empirically while implementing:
// the brief's original run()+join() combo produces hollow.length===0 under BOTH the buggy and the fixed
// resolver — it never bites).
test('PROVE: an incidental builtin call (path.join) is never bound to a same-named local helper (no false HOLLOW)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/util.mjs': "export const join = (t) => t.join('\\n');\n", // a LOCAL helper named join, NOT imported by the test
    'test/t.test.mjs': `${head} import { join } from 'node:path';
test('exits 2 when missing', () => { const status = ['--config', join('a', 'b'), 'missing'].includes('missing') ? 2 : 0; assert.strictEqual(status, 2); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0, 'a good test must not be flagged hollow for an incidental path.join');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python ast precision path: unittest self.assertEqual is recognized (the regex pinnedFragments misses it) ----
test('PROVE python: a unittest self.assertEqual block is probed (not skipped)', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': 'def add(a, b):\n    return a + b\n',
    'test_calc.py': 'import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n',
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.skipped.some((s) => s.name === 'test_add'), 'assertEqual block must be eligible, not skipped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python precision-path REGRESSION: assertNotAlmostEqual is an INEQUALITY assertion — pinning it lets
// the gross sentinel (987654321) pass unchanged (still "not almost equal"), producing a false HOLLOW on a
// correct test. ----
test('PROVE python: assertNotAlmostEqual is never pinned (no false HOLLOW on a correct test)', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'near.py': 'def near(a, b):\n    return a + b\n',
    'test_near.py': 'import unittest\nfrom near import near\nclass T(unittest.TestCase):\n    def test_near(self):\n        self.assertNotAlmostEqual(near(2, 3), 999.0)\n',
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.hollow.some((h) => h.name === 'test_near'), 'an inequality assertion must never be pinned — no false HOLLOW');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python precision-path REGRESSION: an attribute/method call (`Service().process(...)`) must NOT be
// pinned under its bare attribute name — doing so lets the SUT resolver bind a same-named but unrelated
// free function (`from helpers import process`) and gut the WRONG file, producing a false HOLLOW. ----
test('PROVE python: an attribute call is not pinned under its bare name (no cross-file false HOLLOW)', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'helpers.py': 'def process(x):\n    return x * 3\n',
    'test_service.py': [
      'import unittest',
      'from helpers import process',
      '',
      'class Service:',
      '    def process(self, x):',
      '        return x * 2',
      '',
      'class T(unittest.TestCase):',
      '    def test_process(self):',
      '        self.assertEqual(Service().process(2), 4)',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.hollow.some((h) => h.name === 'test_process'), 'Service().process must not be mis-bound to the free helpers.process (no false HOLLOW)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- gated end-to-end: the real mocha/ava binaries run against a synthetic project. Skips cleanly
// when the runner isn't installed (HAS_MOCHA/HAS_AVA above) — the fixture-based parseRun tests and
// the runner-completeness meta-test above carry the CI precision coverage for these runners. ----
test('PROVE mocha e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_MOCHA }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"mocha":"*"}}',
    'src/lib.js': 'function add(a,b){return a+b;} function total(x){return x.reduce((s,i)=>s+i,0);} module.exports={add,total};',
    'test/t.test.js': `const assert=require('node:assert');const {add,total}=require('../src/lib.js');
describe('s',function(){
  it('add sound',function(){ assert.strictEqual(add(2,3),5); });
  it('shadow',function(){ const e=total([1,2]); assert.strictEqual(total([1,2]),e); });
});`,
  });
  try {
    assert.equal(detectRunner(d), 'mocha');
    const r = prove(d, { runner: 'mocha' });
    assert.ok(r.caught >= 1, 'the sound add test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'shadow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'add sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// NOTE on assertion style: ava's OWN `t.is()`/`t.deepEqual()` assertion API is not in pinnedFragments'
// value-pin vocabulary (only node assert / jest-vitest matchers / chai are recognized — see the
// ASSERTION-STRENGTH GATE comment at the top of prove.mjs), and ava's idiomatic concise-body arrow style
// (`t => t.is(...)`, no braces) isn't seen by parseBlocks at all (it requires a block body). A real ava
// suite written idiomatically would score 0 probeable tests — a genuine, pre-existing gap in mutation/'s
// eligibility layer, confirmed live and left unfixed here (mutation/ is out of scope for this task). This
// fixture instead uses node's `assert` (recognized vocabulary, same as the mocha fixture above) with
// block bodies — ava supports plain node assert in a test body; `ava.failWithoutAssertions:false` is
// required or ava fails the test with "finished without running any assertions" even though the node
// assert itself passed. This still genuinely exercises testCmdFor/parseRun/the real ava binary end-to-end.
test('PROVE ava e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_AVA }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"ava":"*"},"ava":{"failWithoutAssertions":false}}',
    'src/lib.js': 'export function add(a,b){return a+b;} export function total(x){return x.reduce((s,i)=>s+i,0);}',
    'test/t.test.js': `import test from 'ava';
import assert from 'node:assert';
import {add,total} from '../src/lib.js';
test('add sound', () => { assert.strictEqual(add(2,3),5); });
test('shadow', () => { const e=total([1,2]); assert.strictEqual(total([1,2]),e); });`,
  });
  try {
    assert.equal(detectRunner(d), 'ava');
    const r = prove(d, { runner: 'ava' });
    assert.ok(r.caught >= 1, 'the sound add test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'shadow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'add sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE vitest e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_VITEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"vitest":"*"}}',
    'src/lib.mjs': 'export function dbl(x){ return x * 2; }\n',
    'test/t.test.mjs': `import { test, expect } from 'vitest';
import { dbl } from '../src/lib.mjs';
test('sound', () => { expect(dbl(3)).toBe(6); });
test('hollow', () => { const e = dbl(3); expect(dbl(3)).toBe(e); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'vitest');
    const r = prove(d, { runner: 'vitest' });
    assert.ok(r.caught >= 1, 'the sound test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'hollow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- fail-closed ambiguous-title regression: mirrors the confirmed pilot-validity bug (see
// .superpowers/sdd/recall-investigation.md) — two it()s sharing an exact title in different describe()s
// collide under vitest's substring `-t` selection, so one invocation runs BOTH. The starter-tier sibling
// genuinely crashes under the gross-break sentinel (a `.split()` call on what's now a bare number
// literal); the growth-tier sibling is a pure self-comparison oracle that would survive (HOLLOW) in
// isolation. Before the fix, the crash's failure got misattributed to the surviving sibling too, so BOTH
// blocks scored CAUGHT (verified against the unmodified code: caught:2, hollow:0 — the true hollow never
// surfaced). The fix must fail closed: both land in `inconclusive` with the ambiguous-title reason —
// never a verdict either way, and no probe wasted on either.
test('PROVE vitest e2e: an ambiguous duplicate title across describes is fail-closed, never misattributed', { skip: !HAS_VITEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"vitest":"*"}}',
    'src/lib.mjs': "export function makeSlug(x){ return String(x) + '-abc'; }\n",
    'test/t.test.mjs': `import { describe, it, expect } from 'vitest';
import { makeSlug } from '../src/lib.mjs';
describe('starter tier', () => {
  it('same title', () => { const slug1 = makeSlug(5); expect(slug1.split('-')[0]).toBe('5'); });
});
describe('growth tier', () => {
  it('same title', () => { const s1 = makeSlug(5); expect(makeSlug(5)).toBe(s1); });
});
`,
  });
  try {
    assert.equal(detectRunner(d), 'vitest');
    const r = prove(d, { runner: 'vitest' });
    assert.equal(r.caught, 0, 'never a verdict on an ambiguous title — must not land in caught');
    assert.equal(r.hollow.length, 0, 'never a verdict on an ambiguous title — must not land in hollow either');
    assert.equal(r.probes, 0, 'no probe is wasted on an ambiguous block');
    const named = r.inconclusive.filter((i) => i.name === 'same title');
    assert.equal(named.length, 2, 'both same-titled blocks are fail-closed to inconclusive');
    assert.ok(named.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'),
      'the exact contract string is reported');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- gated end-to-end, jest ----
// runOne captures stdout+stderr symmetrically on both the success and failure paths (jest writes its
// PASSING-run summary to stderr, not stdout), and testCmdFor passes --runInBand so jest's default
// worker-forking doesn't lose piped output — see mutation/prove.mjs.
test('PROVE jest e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_JEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"jest":"*"}}',
    'src/lib.js': 'function dbl(x){ return x * 2; }\nmodule.exports = { dbl };\n',
    'test/t.test.js': `const assert = require('node:assert');
const { dbl } = require('../src/lib.js');
test('sound', () => { assert.strictEqual(dbl(3), 6); });
test('hollow', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'jest');
    const r = prove(d, { runner: 'jest' });
    assert.ok(r.caught >= 1, 'the sound test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'hollow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- CLI --json: machine-readable output (consumed by the Stop hook) ----
test('PROVE CLI --json: emits the machine-readable result with the hollow list', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': SUT,
    'test/t.test.mjs': `${head} import { add, total } from '../src/lib.mjs';
test('add sound', () => { assert.strictEqual(add(2, 3), 5); });
test('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });
`,
  });
  try {
    let out;
    try { out = execSync(`node ${JSON.stringify(resolve('mutation/prove.mjs'))} ${JSON.stringify(d)} --runner=node --json`, { encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '').toString(); } // exits 1 when a hollow test is present
    const r = JSON.parse(out);
    assert.equal(r.hollow.length, 1);
    assert.equal(r.hollow[0].name, 'shadow');
    assert.equal(r.caught, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE CLI: --max-probes is honored (the Stop-hook entry point)', () => {
  // project with TWO probeable blocks; cap at 1 → capped >= 1 in the JSON
  const d = mkdtempSync(join(tmpdir(), 'gc-maxp-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function a(x){ return x + 1; }\nexport function b(x){ return x + 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { a, b } from '../src/lib.mjs';\n" +
    "test('ta', () => { assert.strictEqual(a(1), 2); });\n" +
    "test('tb', () => { assert.strictEqual(b(1), 3); });\n");
  const out = execFileSync('node', [PROVE_CLI, d, '--max-probes=1', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(r.capped >= 1, `expected capped >= 1, got ${JSON.stringify(r)}`);
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: .claude/ (session worktrees) is never walked — no double-reported findings', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-claude-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  const T = "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('hollow', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });\n";
  writeFileSync(join(d, 'test/t.test.mjs'), T);
  // a worktree copy under .claude/ that would double-report if walked
  mkdirSync(join(d, '.claude/worktrees/w1/test'), { recursive: true });
  mkdirSync(join(d, '.claude/worktrees/w1/src'), { recursive: true });
  writeFileSync(join(d, '.claude/worktrees/w1/package.json'), '{"type":"module"}');
  writeFileSync(join(d, '.claude/worktrees/w1/src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, '.claude/worktrees/w1/test/t.test.mjs'), T);
  const r = prove(d, { runner: 'node' });
  assert.equal(r.hollow.length, 1, `expected exactly one finding, got ${JSON.stringify(r.hollow)}`);
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: skip reasons distinguish no-pin from sut-unresolved', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-skipwhy-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { double } from 'some-external-pkg';\n" +           // pins a value, SUT not a relative import
    "test('pins but unresolvable', () => { assert.strictEqual(double(4), 8); });\n" +
    "test('no pin at all', () => { assert.ok(true); });\n");
  const r = prove(d, { runner: 'node' });
  const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.why]));
  assert.equal(why['pins but unresolvable'], 'sut-unresolved');
  assert.equal(why['no pin at all'], 'no-pin');
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: a failing baseline carries the runner output tail (diagnosable)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-base-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('red', () => { assert.strictEqual(dbl(3), 7); });\n");   // fails at baseline
  const r = prove(d, { runner: 'node' });
  assert.equal(r.inconclusive.length, 1);
  assert.ok(typeof r.inconclusive[0].detail === 'string' && r.inconclusive[0].detail.length > 0, 'runner output tail attached');
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: changedFileCount reports the size of the --since scope', () => {
  // reuse the gitProject-style fixture; committed clean tree → since HEAD sees 0 changed files
  const d = mkdtempSync(join(tmpdir(), 'gc-cc-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: d });
  const r = prove(d, { since: 'HEAD' });
  assert.equal(r.changedFileCount, 0);
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: an unreadable subdirectory yields a friendly scopeError, not a stack trace', { skip: process.platform === 'win32' ? 'chmod 000 is a no-op on Windows' : (process.getuid && process.getuid() === 0 ? 'root ignores modes' : false) }, () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-eacces-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'locked'));
  writeFileSync(join(d, 'locked/x.txt'), 'x');
  chmodSync(join(d, 'locked'), 0o000);
  try {
    const r = prove(d, { runner: 'node' });
    assert.match(String(r.scopeError), /cannot read/);
  } finally { chmodSync(join(d, 'locked'), 0o755); rmSync(d, { recursive: true, force: true }); }
});

test('detectRunner prefers the package.json test script over devDependency runners', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-rpref-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' }, devDependencies: { vitest: '^3.0.0', jest: '^29.0.0' } }));
  assert.equal(detectRunner(d), 'node');
  rmSync(d, { recursive: true, force: true });
});

test('detectRunner: a test script naming no runner falls back to deps order', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-rfall-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo see-ci' }, devDependencies: { jest: '^29.0.0' } }));
  assert.equal(detectRunner(d), 'jest');
  rmSync(d, { recursive: true, force: true });
});

// ---- change classification e2e: --since drives changes/changeSummary through all four statuses ----
// base commit: src/lib.mjs declares 4 fns; test/lib.test.mjs pins the first (proven), circularly
// self-references the second (hollow), weakly asserts the third (unverifiable, no-pin), and never
// mentions the fourth at all (untested). The "agent commit" then edits ALL FOUR fn bodies (a same-line
// trailing-comment tweak — line count stable, so each edit lands in its own single-line git hunk) plus a
// trailing comment in the test file (brings the whole test file into the --since diff so its blocks are
// in scope even though the weak/untested ones have no eligible SUT of their own).
const CHANGES_LIB_BASE = `export function provenFn(x) {
  return x + 1;
}
export function hollowFn(x) {
  return x + 1;
}
export function unvFn(x) {
  return x + 1;
}
export function ghostFn(x) {
  return x + 1;
}
`;
const CHANGES_LIB_EDITED = `export function provenFn(x) {
  return x + 1; // touched
}
export function hollowFn(x) {
  return x + 1; // touched
}
export function unvFn(x) {
  return x + 1; // touched
}
export function ghostFn(x) {
  return x + 1; // touched
}
`;
const CHANGES_TEST_BASE = `${head}
import { provenFn, hollowFn, unvFn } from '../src/lib.mjs';
test('proven catches', () => { assert.strictEqual(provenFn(1), 2); });
test('circular hollow', () => { const e = hollowFn(1); assert.strictEqual(hollowFn(1), e); });
test('weak unv', () => { assert.ok(unvFn(1) !== undefined); });
`;
test('PROVE --since: changes/changeSummary classify all four statuses end-to-end', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': CHANGES_LIB_BASE,
    'test/lib.test.mjs': CHANGES_TEST_BASE,
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: d });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    // the "agent commit" — uncommitted edits to all four fn bodies + the test file (kept unstaged; --since
    // diffs the ref against the working tree, so committing is not required).
    writeFileSync(join(d, 'src/lib.mjs'), CHANGES_LIB_EDITED);
    writeFileSync(join(d, 'test/lib.test.mjs'), CHANGES_TEST_BASE + '// touched\n');

    const r = prove(d, { runner: 'node', since: baseSha });

    assert.equal(r.caught, 1, 'provenFn genuinely caught');
    assert.equal(r.hollow.length, 1, 'hollowFn survives gutting (circular self-reference)');
    assert.ok(r.hollow.some((h) => h.survivors.includes('hollowFn')));

    assert.ok(r.changes, 'changes is populated under --since');
    assert.ok(r.changeSummary, 'changeSummary is populated under --since');
    assert.deepEqual(r.changeSummary, { files: 1, fns: 4, proven: 1, hollow: 1, unverifiable: 1, untested: 1 });

    const by = Object.fromEntries(r.changes.map((c) => [c.fn, c]));
    assert.equal(by.provenFn.status, 'proven');
    assert.equal(by.hollowFn.status, 'hollow');
    assert.equal(by.unvFn.status, 'unverifiable');
    assert.equal(by.unvFn.evidence.reason, 'no-pin');
    assert.equal(by.ghostFn.status, 'untested');
    assert.deepEqual(by.ghostFn.evidence, {});
    for (const c of r.changes) assert.equal(c.granularity, 'hunk', `${c.fn} row carries hunk granularity`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A SOURCE-ONLY diff must still classify a weakly-tested fn as unverifiable: the weak block's test file
// did not change, its `eligible` is empty (no value pin), so the scope gate drops it out of scope BEFORE
// any verdict push — without a block record there, the changed fn would misreport 'untested' ("no test
// mentions it"), which is false. The record must be captured before the outOfScope gate.
test('PROVE --since: a source-only diff classifies a weakly-tested fn unverifiable, not untested', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function f(x) {\n  return x + 1;\n}\n',
    'test/weak.test.mjs': `${head}\nimport { f } from '../src/lib.mjs';\ntest('weak only', () => { assert.ok(f(1) !== undefined); });\n`,
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: d });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    writeFileSync(join(d, 'src/lib.mjs'), 'export function f(x) {\n  return x + 1; // touched\n}\n'); // src ONLY
    const r = prove(d, { runner: 'node', since: baseSha });
    assert.equal(r.outOfScope, 1, 'the weak block itself stays out of scope (unchanged bucket semantics)');
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].status, 'unverifiable', 'weakly-referenced changed fn is unverifiable, never untested');
    assert.equal(r.changes[0].evidence.reasons['no-pin'], 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The per-file `git diff -U0` catch branch: when the diff cannot be computed (here: a non-git dir with an
// explicitly supplied changed-set + since — note the review's deleted-file example never reaches this call,
// since a deleted file is absent from the srcFiles walk), classification falls back to ranges=null /
// granularity 'file' and never throws out of prove().
test('PROVE: git diff -U0 failure falls back to file granularity (catch branch, no throw)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function f(x) {\n  return x + 1;\n}\n',
  });
  try {
    const r = prove(d, { runner: 'node', changed: new Set([resolve(d, 'src/lib.mjs')]), since: 'HEAD' });
    assert.equal(r.scopeError, undefined, 'no scope error — the changed set was supplied directly');
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].granularity, 'file', 'diff failure degrades to file granularity');
    assert.equal(r.changes[0].status, 'untested');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
