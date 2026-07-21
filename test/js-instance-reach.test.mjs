// jsInstanceSuts (Task B1 / T3, mirrors jvmInstanceSuts): resolves a constructor-receiver'd instance-
// method call (`service.decrypt(service.encrypt(x))`) that sutFnsIn/eligibleFns never propose for JS at
// all — safely, by inferring the receiver's RUNTIME type from a directly-visible `new` call, never a
// guess. The cardinal invariant is ZERO false positives: a wrong receiver-type inference, a wrong method
// resolution, or a credit that could resolve to a declaration site gut-time would never actually break,
// all mint a false verdict — the exact thing this tool exists to prevent. Every guard below is a
// REFUSAL path; oracles here are hand-derived from that invariant, never pinned from the resolver's own
// output. Mirrors test/jvm-instance-reach.test.mjs's project()/abs() helper conventions.
//
// RED bite confirmed at HEAD (before this function existed) on the DI round-trip fixture below:
//   `gutcheck: no value-pinning tests to probe (1 skipped, 0 inconclusive). Runner: node.`
//   r.skipped === [{ file: 'test/service.test.mjs', line: 4, name: 'DI round trip', why: 'no-pin' }]
// and hand-gutting `decrypt` to the numeric sentinel makes the round-trip test fail — proving the oracle
// is independent of jsInstanceSuts (the existing gross mutant already breaks this test; the reading was
// the gap). See the second test below for the post-fix CAUGHT + --since PROVEN assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsInstanceSuts, importMap, prove } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-js-instance-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

const SERVICE_SRC = `export class Service {
  constructor(k) { this.k = k; }
  encrypt(s) { return s.split('').reverse().join(''); }
  decrypt(s) { return s.split('').reverse().join(''); }
}
`;

// ---- unit: happy path ----
test('jsInstanceSuts: DI round trip (`new Service(k)` then `service.decrypt(service.encrypt(x))`) credits both methods', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  const imports = importMap(testCode);
  const out = jsInstanceSuts(body, testCode, absTest, srcFiles, imports, d).sort((a, b) => a.fn.localeCompare(b.fn));
  assert.deepEqual(out, [
    { fn: 'decrypt', sutRel: 'src/service.mjs' },
    { fn: 'encrypt', sutRel: 'src/service.mjs' },
  ]);
});

// ---- e2e: the RED bite closes — the block is CAUGHT and, under a diff scope, `decrypt` is PROVEN ----
test('PROVE js-instance-reach e2e: constructor-receiver DI round trip is CAUGHT and decrypt classifies PROVEN under a diff scope', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/service.mjs': SERVICE_SRC,
    'test/service.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.mjs';
test('DI round trip', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'the DI round trip is genuinely CAUGHT (gutting decrypt breaks it)');
    assert.equal(full.hollow.length, 0);
    assert.equal(full.skipped.length, 0, 'no longer skipped as no-pin');

    const scoped = prove(d, { runner: 'node', changed: new Set([resolve(d, 'src/service.mjs')]) });
    const by = Object.fromEntries((scoped.changes || []).map((c) => [c.fn, c]));
    assert.equal(by.decrypt.status, 'proven', 'decrypt classifies proven under a diff scope');
    assert.equal(by.encrypt.status, 'proven', 'encrypt classifies proven under a diff scope');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- e2e: the receiver is constructed in a shared `beforeEach`, not inline — the common real-world DI
// idiom. inferReceiverTypeFromCtor scans the WHOLE test file, so the `service = new Service()` inside the
// hook still binds the receiver's type; the block stays CAUGHT. Locks this reach against regression. ----
test('PROVE js-instance-reach e2e: receiver built in a shared beforeEach still credits (CAUGHT)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/service.mjs': SERVICE_SRC,
    'test/service.test.mjs': `import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.mjs';
let service;
beforeEach(() => { service = new Service(3); });
test('DI round trip', () => {
  const out = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(out, 'abc');
});
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'beforeEach-constructed receiver is genuinely CAUGHT');
    assert.equal(full.hollow.length, 0);
    assert.equal(full.skipped.length, 0, 'not skipped as no-pin — the ctor in the hook binds the type');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- adversarial FP fixtures: every one MUST refuse (jsInstanceSuts -> []), never mint a credit that
// could resolve to the wrong declaration site. Fixture 6 (cross-file name collision) is the one
// exception in shape — the credit itself is CORRECT (it resolves to the right class), and the safety
// comes from T2's (fn, sutRel)-pair attribution in classifyChanges, not from jsInstanceSuts refusing —
// so it is asserted as its own e2e below rather than a `jsInstanceSuts -> []` unit test.

test('adversarial 1: mocked receiver (object literal) refuses — assignment RHS is not a constructor', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = { decrypt: () => 42, encrypt: () => 'x' };
  assert.strictEqual(service.decrypt(service.encrypt('abc')), 42);
});
`;
  const body = `  const service = { decrypt: () => 42, encrypt: () => 'x' };
  assert.strictEqual(service.decrypt(service.encrypt('abc')), 42);
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 2: mocked receiver (factory) refuses — a lowercase callee is not a constructor', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
function makeMock() { return { decrypt: () => 42, encrypt: () => 'x' }; }
test('t', () => {
  const service = makeMock();
  assert.strictEqual(service.decrypt(service.encrypt('abc')), 42);
});
`;
  const body = `  const service = makeMock();
  assert.strictEqual(service.decrypt(service.encrypt('abc')), 42);
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 3a: jest.mock(...) anywhere in the file refuses EVERY instance credit (file-wide taint)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
jest.mock('../src/service.mjs', () => ({ Service: class { decrypt(){ return 'abc'; } encrypt(){ return 'x'; } } }));
test('t', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 3b: vi.mock(...) refuses (vitest mock vocabulary)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
vi.mock('../src/service.mjs');
test('t', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 3c: sinon.stub(...) refuses (sinon mock vocabulary)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
import sinon from 'sinon';
test('t', () => {
  const service = new Service(3);
  sinon.stub(service, 'encrypt').returns('x');
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  sinon.stub(service, 'encrypt').returns('x');
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 4: monkey-patched receiver refuses (`service.decrypt = ...` after construction)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = new Service(3);
  service.decrypt = () => 'abc';
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  service.decrypt = () => 'abc';
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 5: prototype patch refuses (`Service.prototype.decrypt = ...`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
Service.prototype.decrypt = function () { return 'abc'; };
test('t', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 6: same method name in two classes, only one changed — no cross-file mis-attribution (T2 pair gate)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/a.mjs': `export class A {
  get() { return 1; }
}
`,
    'src/b.mjs': `export class B {
  get() { return 3; }
}
`,
    'test/b.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B } from '../src/b.mjs';
test('B get', () => {
  const b = new B();
  assert.strictEqual(b.get(1), 3);
});
`,
  });
  try {
    // sanity: the credit is REAL — gutting B.get genuinely breaks the pinned test.
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'B.get is genuinely CAUGHT via the receiver credit');

    // only src/a.mjs (an unrelated file sharing the method name `get`) is in the diff scope; the test
    // file itself stays in scope too so the block is still actually probed.
    const scoped = prove(d, { runner: 'node', changed: new Set([resolve(d, 'src/a.mjs'), resolve(d, 'test/b.test.mjs')]) });
    const row = (scoped.changes || []).find((c) => c.file === 'src/a.mjs' && c.fn === 'get');
    assert.ok(row, 'a.mjs get is classified at all');
    assert.equal(row.status, 'unverifiable', 'never hollow, never proven — the credit resolved to B, not A');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('adversarial 7: optional chain refuses (`service?.decrypt(x)` — instanceCallsIn cannot match `?.`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = new Service(3);
  assert.strictEqual(service?.decrypt(service?.encrypt('abc')), 'abc');
});
`;
  const body = `  const service = new Service(3);
  assert.strictEqual(service?.decrypt(service?.encrypt('abc')), 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 8a: short-circuit hop RHS refuses (`const d = flag && service.decrypt(x)`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = new Service(3);
  const flag = true;
  const d = flag && service.decrypt('abc');
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const flag = true;
  const d = flag && service.decrypt('abc');
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 8b: ternary directly inside the pinned expression refuses (`cond ? service.a(x) : y`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = new Service(3);
  const cond = true;
  assert.strictEqual(cond ? service.decrypt('abc') : 'y', 'abc');
});
`;
  const body = `  const service = new Service(3);
  const cond = true;
  assert.strictEqual(cond ? service.decrypt('abc') : 'y', 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 9: receiver shadowed by a callback param refuses (an unrelated outer `service` also exists)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
const service = new Service(3);
function withMock(cb) { cb({ decrypt: () => 42 }); }
test('t', () => {
  withMock((service) => { assert.strictEqual(service.decrypt(9), 42); });
});
`;
  const body = `  withMock((service) => { assert.strictEqual(service.decrypt(9), 42); });
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 10: receiver reassigned to a non-constructor value refuses (`service = wrap(service)`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
function wrap(s) { return s; }
test('t', () => {
  let service = new Service(3);
  service = wrap(service);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  let service = new Service(3);
  service = wrap(service);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 11: two distinct constructor types assigned to the same receiver refuses (ambiguous runtime type)', () => {
  const d = project({
    'src/service.mjs': SERVICE_SRC,
    'src/other.mjs': `export class Other {
  decrypt(s) { return s; }
  encrypt(s) { return s; }
}
`,
  });
  const testCode = `import { Service } from '../src/service.mjs';
import { Other } from '../src/other.mjs';
test('t', () => {
  let service = new Service(3);
  service = new Other();
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  let service = new Service(3);
  service = new Other();
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs'), abs(d, 'src/other.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 12: locally-declared class refuses (the ctor name is never bound to a relative import)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
class Fake { decrypt(){ return 'abc'; } encrypt(){ return 'x'; } }
test('t', () => {
  const service = new Fake();
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Fake();
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 13: barrel re-export refuses (the resolved file has no `class Service` of its own)', () => {
  const d = project({
    'src/service.mjs': SERVICE_SRC,
    'src/index.mjs': `export { Service } from './service.mjs';\n`,
  });
  const testCode = `import { Service } from '../src/index.mjs';
test('t', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs'), abs(d, 'src/index.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('adversarial 14: helper function + same-named class method refuses ONLY the colliding name (jsDeclSiteCount === 2)', () => {
  const d = project({
    'src/service.mjs': `export function decrypt(s) { return s.split('').reverse().join(''); }
export class Service {
  constructor(k) { this.k = k; }
  encrypt(s) { return s.split('').reverse().join(''); }
  decrypt(s) { return s.split('').reverse().join(''); }
}
`,
  });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => {
  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  const d = service.decrypt(service.encrypt('abc'));
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  const out = jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d);
  // decrypt has TWO declaration sites in src/service.mjs (the top-level helper + the class method) —
  // gutting it at gut time would silently break the HELPER (pass 1 wins outright) while the class
  // method the test actually calls stays live, so crediting it here would risk a false HOLLOW. encrypt
  // has exactly one site and is still credited — this is not a blanket file-wide refusal.
  assert.deepEqual(out, [{ fn: 'encrypt', sutRel: 'src/service.mjs' }]);
});

test('adversarial 15: pinned var reassigned in the block refuses the hop (`let d = service.decrypt(a); d = fallback(b)`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
function fallback(x) { return x; }
test('t', () => {
  const service = new Service(3);
  let d = service.decrypt(service.encrypt('abc'));
  d = fallback(d);
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  let d = service.decrypt(service.encrypt('abc'));
  d = fallback(d);
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

// IMPORTANT (reviewer finding, owner-authorised fix): identical to adversarial 15 above, but the reassigned
// pinned var's OWN declaration carries a TS type annotation (`let d: string = …`). The asnCount regex used
// to be `NAME\s*=(?![=>])` — with an annotation in between (`d: string = …`), the declaration's OWN `=`
// never matched (the `: string` sits between `d` and `=`), so asnCount only saw the LATER bare reassignment
// (`d = fallback(d)`) and read 1 instead of 2 — the `>1` ambiguity guard failed to fire, and the hop
// credited decrypt/encrypt despite `d` being reassigned before the pinned assert (same ambiguity adversarial
// 15 exists to refuse). RED at e218c27: this returns [{fn:'decrypt',...},{fn:'encrypt',...}] instead of [].
test('adversarial (Important fix): an ANNOTATED pinned var reassigned in the block still refuses the hop (`let d: string = service.decrypt(a); d = fallback(b)`)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
function fallback(x) { return x; }
test('t', () => {
  const service = new Service(3);
  let d: string = service.decrypt(service.encrypt('abc'));
  d = fallback(d);
  assert.strictEqual(d, 'abc');
});
`;
  const body = `  const service = new Service(3);
  let d: string = service.decrypt(service.encrypt('abc'));
  d = fallback(d);
  assert.strictEqual(d, 'abc');
`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

// adversarial 16 (deep-review finding, confirmed false HOLLOW): guard (g) used to be
// `jsDeclSiteCount(srcCode, method) === 1`, which only guarantees the single decl SITE is the unique gut
// TARGET file-wide — NOT that it lies inside the resolved class's OWN body. Here `Service extends Base`
// and `decrypt` is INHERITED from Base (a different file); the only same-named decl site in service.mjs
// is a completely unrelated sibling, `LegacyCodec.decrypt`. Before the class-body-containment fix,
// `jsDeclSiteCount('decrypt') === 1` (LegacyCodec's site is the only one in service.mjs) minted a credit
// of (decrypt, src/service.mjs); gut-time then guts LegacyCodec.decrypt (the site locateBody actually
// finds), dispatch still hits the untouched Base.decrypt, the mutant survives, and the test — which is
// perfectly sound — was misreported as a false HOLLOW. RED bite confirmed live on the unfixed tree
// (2026-07-08): `jsInstanceSuts` returned `[{ fn: 'decrypt', sutRel: 'src/service.mjs' }]` and the e2e
// `prove()` run reported `hollow: [{ file: 'test/service.test.mjs', ..., survivors: ['decrypt'] }]`,
// `caught: 0` — a false HOLLOW on a genuinely sound test. Post-fix: jsInstanceSuts refuses (the decl
// site is inside LegacyCodec's span, not Service's — Service has no own-body `decrypt` at all), so the
// block stays skipped/pin-unresolved — the pin is real, the refused link is the guard working (never scored, never hollow).
const BASE_SRC = `export class Base {
  decrypt(s) { return s.split('').reverse().join(''); }
}
`;
const SERVICE_EXTENDS_BASE_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  encrypt(s) { return s.split('').reverse().join(''); }
}
export class LegacyCodec {
  decrypt(s) { return 'legacy:' + s; }
}
`;
const SERVICE_TEST_CODE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.mjs';
test('decrypt round trip', () => {
  const service = new Service(3);
  const d = service.decrypt('cba');
  assert.strictEqual(d, 'abc');
});
`;
const SERVICE_TEST_BODY = `  const service = new Service(3);
  const d = service.decrypt('cba');
  assert.strictEqual(d, 'abc');
`;

test('adversarial 16: inherited method + unrelated same-named sibling class refuses (decl site outside THIS class\'s body)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_EXTENDS_BASE_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), []);
});

test('PROVE adversarial 16 e2e: the inherited-method/sibling-collision block stays skipped (no-pin), never HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_EXTENDS_BASE_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.hollow.length, 0, 'never a false HOLLOW on this sound test');
    assert.equal(full.caught, 0, 'no credit was minted, so nothing is scored as caught either');
    assert.equal(full.skipped.length, 1, 'the block stays skipped/pin-unresolved, exactly as unprobed as before jsInstanceSuts existed');
    assert.equal(full.skipped[0].why, 'pin-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- adversarial 16b: a SECOND false-HOLLOW variant of the same inheritance root. Fixture 16's
// containment span (e2) only proves the single decl site lies somewhere inside THIS class's braces —
// not that it is the class's own TOP-LEVEL (dispatchable) member. A same-named decl nested DEEPER in the
// class body — an object-literal shorthand method returned by a sibling method, or an inner class/function
// declared inside a sibling method — sits inside the span yet is never what `service.decrypt(...)`
// dispatches to (that still resolves to the inherited Base method). jsDeclSites finds the one nested site,
// containment (e2) passes (it IS inside Service's span), credit is minted, gut-time guts the unreachable
// nested copy, and the mutant survives — a false HOLLOW on a genuinely sound test.
//
// RED bite confirmed on a live fixture (object-literal variant) at HEAD (fixture-16-e2 fix applied, this
// depth check not yet applied): `gutcheck: 0/1 tests (0%) fail when the function they test is broken.`
// with `hollow: [{ file: 'test/service.test.mjs', line: 4, name: 'decrypt round trip',
// survivors: ['decrypt'] }]` — a sound round-trip test reading as HOLLOW.
const SERVICE_NESTED_OBJECT_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  encrypt(s) { return s; }
  makeInner() {
    return { decrypt(s) { return 'inner:' + s; } };
  }
}
`;
const SERVICE_NESTED_CLASS_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  encrypt(s) { return s; }
  makeInner() {
    class Helper { decrypt(s) { return 'inner:' + s; } }
    return new Helper();
  }
}
`;

test('adversarial 16b: object-literal shorthand method nested inside a sibling method refuses (not this class\'s own top-level member)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_NESTED_OBJECT_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), []);
});

test('adversarial 16b: inner class nested inside a sibling method refuses (not this class\'s own top-level member)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_NESTED_CLASS_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), []);
});

test('PROVE adversarial 16b e2e (object-literal nesting): the block stays skipped (pin-unresolved), never HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_NESTED_OBJECT_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.hollow.length, 0, 'never a false HOLLOW on this sound test');
    assert.equal(full.caught, 0, 'no credit was minted, so nothing is scored as caught either');
    assert.equal(full.skipped.length, 1, 'the block stays skipped/pin-unresolved');
    assert.equal(full.skipped[0].why, 'pin-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE adversarial 16b e2e (inner-class nesting): the block stays skipped (pin-unresolved), never HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_NESTED_CLASS_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.hollow.length, 0, 'never a false HOLLOW on this sound test');
    assert.equal(full.caught, 0, 'no credit was minted, so nothing is scored as caught either');
    assert.equal(full.skipped.length, 1, 'the block stays skipped/pin-unresolved');
    assert.equal(full.skipped[0].why, 'pin-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- positive controls: the depth check must refuse ONLY nested sites, never a class's own top-level
// member. An own-body method that follows a sibling method containing a BALANCED nested block (the
// brace-counting scan nets back to 0 by the time it reaches the site) and an own-body class-FIELD arrow
// (`decrypt = (s) => …`, itself a top-level member, matched by jsDeclSites' arrow-with-parens signature)
// must both still credit — over-refusing either would be a reach regression, not a correctness fix.
const SERVICE_OWNBODY_METHOD_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  helper() { if (true) { return 1; } }
  decrypt(s) { return s.split('').reverse().join(''); }
}
`;
const SERVICE_OWNBODY_ARROW_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  decrypt = (s) => s.split('').reverse().join('');
}
`;

test('positive control: own-body method following a sibling method with a balanced nested block still credits (depth returns to 0)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_OWNBODY_METHOD_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), [
    { fn: 'decrypt', sutRel: 'src/service.mjs' },
  ]);
});

test('positive control: own-body class-field arrow (`decrypt = (s) => ...`) still credits', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_OWNBODY_ARROW_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), [
    { fn: 'decrypt', sutRel: 'src/service.mjs' },
  ]);
});

test('PROVE positive control e2e (own-body method after a balanced nested block): decrypt is CAUGHT, never hollow', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_OWNBODY_METHOD_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'the credited own-body decrypt is exercised and CAUGHT');
    assert.equal(full.hollow.length, 0, 'a sound test on an own-body method must never read as hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE positive control e2e (own-body class-field arrow): decrypt is CAUGHT, never hollow', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_OWNBODY_ARROW_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'the credited own-body decrypt is exercised and CAUGHT');
    assert.equal(full.hollow.length, 0, 'a sound test on an own-body class-field arrow must never read as hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- adversarial 16c/16d (final consolidated review, guard g3): TWO more false-HOLLOW variants
// of the same inheritance root. Pass-1's field-initializer signature (`decrypt = …`, jsSigRegex patterns
// 3-5) anchors purely on the NAME with a `\b` boundary, blind to a `static`/`#` prefix immediately before
// it. service.decrypt(x) dispatches to the INSTANCE method on the prototype chain — a same-named STATIC
// field or PRIVATE (#) field at depth 0 is never that target. Pass-2 method sites already refuse
// static/get/set/# METHODS (the preceding-boundary-char check in bareMethodSites), so only these two
// pass-1 field-initializer forms leak. When the real `decrypt` is inherited from Base (another file),
// gut-time guts the wrong depth-0 member and a sound test reads as a false HOLLOW.
//
// RED bite confirmed live at HEAD (before guard g3), via `node mutation/gutcheck.mjs <dir>` on both:
//   16c (static arrow field): `gutcheck: 0/1 tests (0%) fail when the function they test is broken.`
//     — `1 test(s) pass even when their function is gutted`, survives gutting decrypt().
//   16d (private arrow field): identical verdict, same survivor.
const SERVICE_STATIC_ARROW_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  encrypt(s) { return s; }
  static decrypt = (s) => 'static:' + s;
}
`;
const SERVICE_PRIVATE_ARROW_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  encrypt(s) { return s; }
  #decrypt = (s) => 'priv:' + s;
  usesPriv(s) { return this.#decrypt(s); }
}
`;

test('adversarial 16c: static arrow field with the same name as the inherited instance method refuses (service.decrypt dispatches to the prototype-chain instance method, never a static)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_STATIC_ARROW_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), []);
});

test('PROVE adversarial 16c e2e (static arrow field): the block stays skipped (pin-unresolved), never HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_STATIC_ARROW_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.hollow.length, 0, 'never a false HOLLOW on this sound test');
    assert.equal(full.caught, 0, 'no credit was minted, so nothing is scored as caught either');
    assert.equal(full.skipped.length, 1, 'the block stays skipped/pin-unresolved');
    assert.equal(full.skipped[0].why, 'pin-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('adversarial 16d: private (#) arrow field with the same name as the inherited instance method refuses', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_PRIVATE_ARROW_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), []);
});

test('PROVE adversarial 16d e2e (private arrow field): the block stays skipped (pin-unresolved), never HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_PRIVATE_ARROW_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.hollow.length, 0, 'never a false HOLLOW on this sound test');
    assert.equal(full.caught, 0, 'no credit was minted, so nothing is scored as caught either');
    assert.equal(full.skipped.length, 1, 'the block stays skipped/pin-unresolved');
    assert.equal(full.skipped[0].why, 'pin-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- positive controls for guard g3: it must refuse ONLY a static/private-field decl immediately before
// the matched name, never an unrelated preceding word (`readonly`, a TS-only field modifier written on
// its own line so the fixture stays valid, executable plain JS) or an `async` instance METHOD (whose
// bareMethodSites site sits AT `async` itself, so the header re-scan — which only looks BEFORE `site` —
// never even reaches the keyword).
const SERVICE_READONLY_ARROW_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  readonly
  decrypt = (s) => s.split('').reverse().join('');
}
`;
const SERVICE_ASYNC_METHOD_SRC = `import { Base } from './base.mjs';
export class Service extends Base {
  constructor(k) { super(); this.k = k; }
  encrypt(s) { return s; }
  async decrypt(s) { return s.split('').reverse().join(''); }
}
`;
const SERVICE_ASYNC_TEST_CODE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.mjs';
test('decrypt round trip', async () => {
  const service = new Service(3);
  assert.strictEqual(await service.decrypt('cba'), 'abc');
});
`;
const SERVICE_ASYNC_TEST_BODY = `  const service = new Service(3);
  assert.strictEqual(await service.decrypt('cba'), 'abc');
`;

test('positive control: readonly-modified own-body arrow field still credits (g3 must not match on an unrelated preceding word)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_READONLY_ARROW_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_TEST_BODY, SERVICE_TEST_CODE, absTest, srcFiles, importMap(SERVICE_TEST_CODE), d), [
    { fn: 'decrypt', sutRel: 'src/service.mjs' },
  ]);
});

test('positive control: async own-body instance method still credits', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_ASYNC_METHOD_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(SERVICE_ASYNC_TEST_BODY, SERVICE_ASYNC_TEST_CODE, absTest, srcFiles, importMap(SERVICE_ASYNC_TEST_CODE), d), [
    { fn: 'decrypt', sutRel: 'src/service.mjs' },
  ]);
});

test('PROVE positive control e2e (readonly own-body arrow field): decrypt is CAUGHT, never hollow', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_READONLY_ARROW_SRC,
    'test/service.test.mjs': SERVICE_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'the credited own-body decrypt is exercised and CAUGHT');
    assert.equal(full.hollow.length, 0, 'a sound test on a readonly own-body arrow field must never read as hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE positive control e2e (async own-body instance method): decrypt is CAUGHT, never hollow', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/base.mjs': BASE_SRC,
    'src/service.mjs': SERVICE_ASYNC_METHOD_SRC,
    'test/service.test.mjs': SERVICE_ASYNC_TEST_CODE,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'the credited async own-body decrypt is exercised and CAUGHT');
    assert.equal(full.hollow.length, 0, 'a sound test on an async own-body instance method must never read as hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- gating: lang-agnostic merge point never touches Python/JVM (the merge is gated on `L === 'js'`
// directly — the block loop's own lang() classification — specifically NOT `!jvmLang && !pyAst`, which
// reads true for a regex-fallback Python block too (no python3/python interpreter on PATH), so this is
// really a prove()-level guarantee — a direct unit smoke-test that jsInstanceSuts itself has no
// lang-branching that could ever run against non-JS/TS text is out of scope here since the function has no
// lang parameter at all (that IS the byte-identity guarantee: it is never invoked for Python/JVM blocks).

// ==== T2: INLINE receiver crediting (`new X(...).m(...)`, no assignment, no variable) ============
// jsInlineCtorMethodCallsIn scans the SAME `texts` array (pinned fragments + hop RHSes) jsInstanceSuts
// already builds for the variable path, under the same MOCK_TAINT/hasTopLevelShortCircuit gates, then
// routes through the IDENTICAL jsCreditTypeMethod chain (T1) the variable path uses — so every guard
// that protects the variable path protects the inline path too, by construction, not by duplication.

// ---- RED bites (confirmed live on the pre-T2 tree via scratch fixtures, 2026-07-09): all four skipped
// 'sut-unresolved' (never scored) before this scanner existed; each now flips to its correct verdict. ----

test('T2 RED bite: `new X().m()` directly in a pinned fragment credits (fn=m, sutRel=src file)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X().m(), 5); });
`;
  const body = `  assert.strictEqual(new X().m(), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), [
    { fn: 'm', sutRel: 'src/x.mjs' },
  ]);
});

test('PROVE T2 RED bite e2e: inline direct call — skipped(sut-unresolved) pre-T2, PROVEN post-T2', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/x.mjs': 'export class X { m() { return 5; } }\n',
    'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X } from '../src/x.mjs';
test('inline direct', () => { assert.strictEqual(new X().m(), 5); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 1, 'gutting X.m to the numeric sentinel now breaks the pinned assertion');
    assert.equal(r.hollow.length, 0);
    assert.equal(r.skipped.length, 0, 'no longer skipped as sut-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE T2 hollow twin: `assert.strictEqual(new X().m(), new X().m())` credits but is a GENUINE HOLLOW (both sides gut to the same sentinel)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/x.mjs': 'export class X { m() { return 5; } }\n',
    'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X } from '../src/x.mjs';
test('inline hollow twin', () => { assert.strictEqual(new X().m(), new X().m()); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 0);
    assert.equal(r.hollow.length, 1, 'a self-comparison stays equal even when both sides gut to the same sentinel — genuinely hollow, correctly flagged (never a false verdict)');
    assert.deepEqual(r.hollow[0].survivors, ['m']);
    assert.equal(r.skipped.length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('T2 RED bite: arg-context form `expect(new X().m() + 1).toBe(6)` also credits (over-inclusive selection, same discipline as bare names)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { expect(new X().m() + 1).toBe(6); });
`;
  const body = `  expect(new X().m() + 1).toBe(6);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), [
    { fn: 'm', sutRel: 'src/x.mjs' },
  ]);
});

test('T2 RED bite: hop RHS `const r = new X().m(2); expect(r).toBe(5)` credits (SAME texts array as the variable-hop path)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m(n) { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { const r = new X().m(2); expect(r).toBe(5); });
`;
  const body = `  const r = new X().m(2);\n  expect(r).toBe(5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), [
    { fn: 'm', sutRel: 'src/x.mjs' },
  ]);
});

// ---- adversarial: scanner-boundary refusals (jsInlineCtorMethodCallsIn itself — the §5.1/5.2-JS rows
// that are about the SHAPE of the inline call, not the shared type->method credit chain) ----

test('T2 adversarial: chained `new X().m().n()` refuses BOTH (scanner only pairs a method with an IMMEDIATELY preceding ctor)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return new X(); } n() { return 1; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X().m().n(), 1); });
`;
  const body = `  assert.strictEqual(new X().m().n(), 1);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: builder `new X().build().m()` refuses BOTH (same immediately-preceding-ctor rule)', () => {
  const d = project({ 'src/x.mjs': 'export class X { build() { return new X(); } m() { return 1; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X().build().m(), 1); });
`;
  const body = `  assert.strictEqual(new X().build().m(), 1);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: bare ctor argument, no method (`foo(new X())`) — no credit (scanner requires `.m(` after the ctor)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
function foo(x) { return 5; }
test('t', () => { assert.strictEqual(foo(new X()), 5); });
`;
  const body = `  assert.strictEqual(foo(new X()), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: property access `new X().value` — no credit (scanner requires `(` after the member name)', () => {
  const d = project({ 'src/x.mjs': 'export class X { get value() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X().value, 5); });
`;
  const body = `  assert.strictEqual(new X().value, 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: method reference with no call parens (`const ref = new X().m;`) — no credit', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { const ref = new X().m; assert.strictEqual(typeof ref, 'function'); });
`;
  const body = `  const ref = new X().m;\n  assert.strictEqual(typeof ref, 'function');\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: optional chain `new X()?.m()` refuses (next-after-ctor-`)` must be exactly `.`)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X()?.m(), 5); });
`;
  const body = `  assert.strictEqual(new X()?.m(), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: TS non-null `new X().m()!` refuses (next-after-method-`)` must be none of `. ? ! {`)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X().m()!, 5); });
`;
  const body = `  assert.strictEqual(new X().m()!, 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: generic ctor `new X<T>()` refuses (jsCtorAt matches `(` directly after the name — documented under-reach)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new X<string>().m(), 5); });
`;
  const body = `  assert.strictEqual(new X<string>().m(), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: dotted inline ctor `new ns.X()` refuses (simple-name-only boundary — jsCtorAt has no dot form)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import * as ns from '../src/x.mjs';
test('t', () => { assert.strictEqual(new ns.X().m(), 5); });
`;
  const body = `  assert.strictEqual(new ns.X().m(), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: short-circuit context (`assert.strictEqual(flag || new X().m(), ...)`) refuses (existing hasTopLevelShortCircuit gate, shared with the variable path)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { const flag = 0; assert.strictEqual(flag || new X().m(), 5); });
`;
  const body = `  const flag = 0;\n  assert.strictEqual(flag || new X().m(), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

// ---- adversarial: shared type->method credit chain (jsCreditTypeMethod, T1) — the inline path routes
// through the IDENTICAL guards the variable path already has full coverage for; these confirm the wiring
// (inline calls reach the same refusals), not re-derive each guard from scratch. ----

test('T2 adversarial: ctor of an unresolved/mock name (`new Mock().m()`, Mock never imported) refuses — class-resolution guard (d)', () => {
  const d = project({ 'src/x.mjs': 'export class X { m() { return 5; } }\n' });
  const testCode = `import { X } from '../src/x.mjs';
test('t', () => { assert.strictEqual(new Mock().m(), 5); });
`;
  const body = `  assert.strictEqual(new Mock().m(), 5);\n`;
  const srcFiles = [abs(d, 'src/x.mjs')];
  const absTest = abs(d, 'test/t.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: jest.mock(...) anywhere in the file refuses the inline credit too (file-wide MOCK_TAINT, shared gate)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
jest.mock('../src/service.mjs', () => ({ Service: class { decrypt(){ return 'abc'; } encrypt(){ return 'x'; } } }));
test('t', () => { assert.strictEqual(new Service(3).decrypt(new Service(3).encrypt('abc')), 'abc'); });
`;
  const body = `  assert.strictEqual(new Service(3).decrypt(new Service(3).encrypt('abc')), 'abc');\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: `Service.prototype.decrypt = …` in the test file refuses the inline credit too (guard (f), shared)', () => {
  const d = project({ 'src/service.mjs': SERVICE_SRC });
  const testCode = `import { Service } from '../src/service.mjs';
Service.prototype.decrypt = function () { return 'abc'; };
test('t', () => { assert.strictEqual(new Service(3).decrypt('abc'), 'abc'); });
`;
  const body = `  assert.strictEqual(new Service(3).decrypt('abc'), 'abc');\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2 adversarial: helper function + same-named class method refuses ONLY the colliding name, inline form (guard (g), shared)', () => {
  const d = project({
    'src/service.mjs': `export function decrypt(s) { return s; }
export class Service {
  constructor(k) { this.k = k; }
  encrypt(s) { return s; }
  decrypt(s) { return s; }
}
`,
  });
  const testCode = `import { Service } from '../src/service.mjs';
test('t', () => { assert.strictEqual(new Service(3).decrypt(new Service(3).encrypt('abc')), 'abc'); });
`;
  const body = `  assert.strictEqual(new Service(3).decrypt(new Service(3).encrypt('abc')), 'abc');\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  const out = jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d);
  assert.deepEqual(out, [{ fn: 'encrypt', sutRel: 'src/service.mjs' }]);
});

test('T2 adversarial: inherited method + unrelated same-named sibling class refuses, inline form (guard (e2)/(g), shared)', () => {
  const d = project({ 'src/base.mjs': BASE_SRC, 'src/service.mjs': SERVICE_EXTENDS_BASE_SRC });
  const srcFiles = [abs(d, 'src/base.mjs'), abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  const testCode = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.mjs';
test('decrypt round trip', () => { const d = new Service(3).decrypt('cba'); assert.strictEqual(d, 'abc'); });
`;
  const body = `  const d = new Service(3).decrypt('cba');\n  assert.strictEqual(d, 'abc');\n`;
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

// ---- adversarial: §8.1 test-file ctor-name shadow, for BOTH the inline and the variable path (the new
// guard lives inside the shared jsCreditTypeMethod, so both callers get it identically) ----

test('T2/§8.1 adversarial: test file itself declares `class Service` (inline call) refuses — the shadow guard', () => {
  const d = project({ 'src/service.mjs': 'export class Service { decrypt() { return 99; } }\n' });
  const testCode = `import { Service } from '../src/service.mjs';
test('x', () => { class Service { decrypt(){ return 42; } } assert.strictEqual(new Service().decrypt(), 42); });
`;
  const body = `  class Service { decrypt(){ return 42; } }\n  assert.strictEqual(new Service().decrypt(), 42);\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('§8.1 adversarial: test file itself declares `class Service` (VARIABLE call) refuses — the RED bite from T1, formalized as a fixture', () => {
  const d = project({ 'src/service.mjs': 'export class Service { decrypt() { return 99; } }\n' });
  const testCode = `import { Service } from '../src/service.mjs';
test('x', () => { class Service { decrypt(){ return 42; } } const s = new Service(); assert.strictEqual(s.decrypt(), 42); });
`;
  const body = `  class Service { decrypt(){ return 42; } }\n  const s = new Service();\n  assert.strictEqual(s.decrypt(), 42);\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('PROVE §8.1 e2e (variable path): the test-file ctor-name shadow no longer mints a false HOLLOW — block stays skipped(sut-unresolved)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/service.mjs': `export class Service {
  decrypt() { return 99; }
}
`,
    'test/service.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../src/service.mjs';
test('x', () => {
  class Service { decrypt(){ return 42; } }
  const s = new Service();
  assert.strictEqual(s.decrypt(), 42);
});
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0, 'never a false HOLLOW — before this guard this scored hollow with survivors:["decrypt"]');
    assert.equal(r.caught, 0, 'no credit minted, nothing scored as caught either');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].why, 'sut-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('T2/§8.1 adversarial: test file re-assigns the ctor name (`Service = …`) refuses — the assign-form of the shadow guard', () => {
  const d = project({ 'src/service.mjs': 'export class Service { decrypt() { return 99; } }\n' });
  const testCode = `import { Service as ServiceImport } from '../src/service.mjs';
let Service = class { decrypt(){ return 42; } };
test('x', () => { assert.strictEqual(new Service().decrypt(), 42); });
`;
  const body = `  assert.strictEqual(new Service().decrypt(), 42);\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  // Note: `Service` here is never actually bound to the import at all (the import is aliased to
  // ServiceImport) — imports.get('Service') is already undefined, so guard (d) alone would refuse this.
  // The shadow guard is exercised directly below via a name that IS import-bound.
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

test('T2/§8.1 adversarial: test file re-assigns the (import-bound) ctor name refuses — the assign-form of the shadow guard, exercised past guard (d)', () => {
  const d = project({ 'src/service.mjs': 'export class Service { decrypt() { return 99; } }\n' });
  // `Service` IS import-bound (guard (d) would pass); a later bare re-assignment in the test file still
  // must refuse — a decl-time import binding says nothing about whether the identifier is reassigned
  // before the call this credit is about to gut.
  const testCode = `import { Service } from '../src/service.mjs';
if (false) { Service = class { decrypt(){ return 42; } }; }
test('x', () => { assert.strictEqual(new Service().decrypt(), 99); });
`;
  const body = `  assert.strictEqual(new Service().decrypt(), 99);\n`;
  const srcFiles = [abs(d, 'src/service.mjs')];
  const absTest = abs(d, 'test/service.test.mjs');
  assert.deepEqual(jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d), []);
});

// ---- Task 6: per-kind crediting (mirrors jvmInstanceSuts) — a relational-only fragment's instance
// credit carries `rel: true`; a value fragment's instance credit omits the key entirely (never `false`),
// so every pre-existing (value-only) caller's `{fn, sutRel}` shape stays byte-identical. ----
const CALC_SRC = `export class Calc {
  add(a, b) { return a + b; }
  mul(a, b) { return a * b; }
}
`;
test('instance credit from a relational-only fragment carries rel: true; value fragment credit does not', () => {
  const d = project({ 'src/calc.mjs': CALC_SRC });
  const testCode = `import { Calc } from '../src/calc.mjs';
test('t', () => {
  const svc = new Calc();
  expect(svc.add(1, 2)).toBeGreaterThan(0);
  expect(svc.mul(2, 3)).toBe(6);
});
`;
  const body = `  const svc = new Calc();
  expect(svc.add(1, 2)).toBeGreaterThan(0);
  expect(svc.mul(2, 3)).toBe(6);
`;
  const srcFiles = [abs(d, 'src/calc.mjs')];
  const absTest = abs(d, 'test/calc.test.mjs');
  const out = jsInstanceSuts(body, testCode, absTest, srcFiles, importMap(testCode), d);
  const add = out.find((x) => x.fn === 'add');
  const mul = out.find((x) => x.fn === 'mul');
  assert.equal(add && add.rel, true);
  assert.ok(mul && !mul.rel);
});
