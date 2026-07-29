// Namespace-member SUT resolution (`_.sort(...)` on `import * as _ from '..'`) — jsNamespaceSuts.
// Wild motivation verified against radash master: tests do `import * as _ from '..'` then `_.sort(...)`,
// and 258 blocks sat in pin-unresolved because nothing tied the pinned value to a resolvable function.
//
// Cardinal invariant unchanged: ZERO false verdicts. Only a `* as NS` binding credits — a DEFAULT
// import's members are properties of ONE exported value, and a same-named top-level declaration in the
// target file could be code the test never runs; gutting it would mint a false verdict. Every guard is
// a refusal path (mock-taint, param shadow, local re-declaration, monkey-patch, unresolvable spec),
// mirroring jsInstanceSuts' coarseness. Oracles are hand-derived from the fixtures.
//
// RED bite confirmed at HEAD (before jsNamespaceSuts existed): prove() on the barrel fixture below
// reported caught: 0, skipped: ['pin-unresolved'] — while hand-gutting `sort` in util.mjs made the
// fixture test fail under plain `node --test` (0 pass / 1 fail), proving the runtime binds what the
// reader could not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsNamespaceSuts, importMap, prove } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-ns-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

const UTIL = `export function sort(a) { return [...a].sort((x, y) => x - y); }
export function sum(a) { return a.reduce((t, n) => t + n, 0); }
`;

// Run jsNamespaceSuts against a fixture: body is the block's own source, testCode the whole file.
function nsSuts(d, files, testCode, body) {
  const srcFiles = Object.keys(files).filter((r) => /\.(mjs|js|ts)$/.test(r) && !r.startsWith('test/')).map((r) => abs(d, r));
  return jsNamespaceSuts(body, testCode, abs(d, 'test/ns.test.mjs'), srcFiles, importMap(testCode), d)
    .sort((a, b) => a.fn.localeCompare(b.fn));
}

// ---- unit: happy paths ----

test('ns: a member call on `* as` bound to the DECLARING file credits (fn, sutRel)', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [{ fn: 'sort', sutRel: 'src/util.mjs' }]); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// The exact radash shape, caught by the 2026-07-29 corpus run: a BARE dotted specifier (`'..'`, no
// trailing slash) is a relative import of the parent DIRECTORY, but isRelative's old /^\.\.?\//
// required a slash after the dots — so `import * as _ from '..'` fell through to the (empty) alias
// branch and refused, and radash's 258 pin-unresolved blocks stayed exactly where they were.
test('ns: a BARE `..` specifier (parent-directory import, the radash shape) resolves', () => {
  const files = { 'src/index.mjs': `export { sort, sum } from './util.mjs';\n`, 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '..';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  const srcFiles = [abs(d, 'src/index.mjs'), abs(d, 'src/util.mjs')];
  try {
    const out = jsNamespaceSuts(body, testCode, abs(d, 'src/tests/ns.test.mjs'), srcFiles, importMap(testCode), d);
    assert.deepEqual(out, [{ fn: 'sort', sutRel: 'src/util.mjs' }]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns: a ROOT-barrel import (`* as _ from "../src"` over `export * from`) composes to the declaring file', () => {
  const files = { 'src/index.mjs': `export * from './util.mjs';\n`, 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [{ fn: 'sort', sutRel: 'src/util.mjs' }]); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns: the one-variable hop credits (`const out = _.sort(...)` then the pin on `out`)', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\ntest('t', () => { const out = _.sort([2, 1]); assert.deepStrictEqual(out, [1, 2]); });\n`;
  const body = `  const out = _.sort([2, 1]);\n  assert.deepStrictEqual(out, [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [{ fn: 'sort', sutRel: 'src/util.mjs' }]); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns: an ALIASED namespace spec (`* as _ from "~/util"`) resolves through the alias rules', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}', 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '~/util';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [{ fn: 'sort', sutRel: 'src/util.mjs' }]); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- unit: refusal paths — every one MUST yield [], never a credit that could gut the wrong code ----

test('ns MUST-NOT: a DEFAULT import never credits — members are properties of one value, not module exports', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import _ from '../src/util.mjs';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: file-wide mock-framework taint refuses every credit', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\njest.mock('../src/util.mjs');\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: NS re-declared as a local refuses (`const _ = fake()`)', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\nconst _ = makeFake();\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: NS appearing as a callback parameter anywhere refuses file-wide', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\nconst ignored = [1].map((_) => 0);\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: a monkey-patched member refuses (`_.sort = fake`)', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\n_.sort = () => [1, 2];\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: a BARE (dependency) namespace spec never binds', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from 'lodash';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: a member with no declaration in the target (nor through the hop) refuses', () => {
  const files = { 'src/util.mjs': UTIL };
  const d = project(files);
  const testCode = `import * as _ from '../src/util.mjs';\ntest('t', () => { assert.deepStrictEqual(_.missing([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.missing([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns MUST-NOT: an AMBIGUOUS star barrel (two targets declare the member) refuses through the hop', () => {
  const files = {
    'src/index.mjs': `export * from './a.mjs';\nexport * from './b.mjs';\n`,
    'src/a.mjs': UTIL,
    'src/b.mjs': UTIL,
  };
  const d = project(files);
  const testCode = `import * as _ from '../src';\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- CJS namespace form: `const R = require('..')` (the ramda shape) ----
// require() returns the module.exports object, so `R.fn` is the target's export `fn` — same resolution
// as `* as`, with one extra hazard: a file that REASSIGNS module.exports to a non-object-literal
// (`module.exports = SomeClass`) makes members properties of that ONE value, and a same-named top-level
// declaration could be code the test never runs — refused. An object-literal reassignment
// (`module.exports = { sort }`) keeps members tied to their declarations — allowed. The rebind guard
// differs from ESM too: the CJS binding IS a `const NS = ...`, so "any local declaration refuses" would
// kill every credit — instead the name must be assigned exactly ONCE file-wide (the require itself).

const CJS_UTIL = `function sort(a) { return a.slice().sort((x, y) => x - y); }
function sum(a) { return a.reduce((t, n) => t + n, 0); }
module.exports = { sort, sum };
`;

test('ns CJS: `const _ = require(rel)` on an object-literal module credits (fn, sutRel)', () => {
  const files = { 'src/util.js': CJS_UTIL };
  const d = project(files);
  const testCode = `const _ = require('../src/util.js');\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [{ fn: 'sort', sutRel: 'src/util.js' }]); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns CJS: an `exports.fn = function` style target credits', () => {
  const files = { 'src/util.js': `exports.sort = function (a) { return a.slice().sort((x, y) => x - y); };\n` };
  const d = project(files);
  const testCode = `const _ = require('../src/util.js');\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [{ fn: 'sort', sutRel: 'src/util.js' }]); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns CJS MUST-NOT: a module.exports reassigned to a NON-object-literal refuses — members are properties of one value', () => {
  const files = {
    'src/util.js': `function sort(a) { return a.slice().sort(); }
class Toolkit { sort(a) { return a; } }
module.exports = Toolkit;
`,
  };
  const d = project(files);
  const testCode = `const _ = require('../src/util.js');\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), [], 'top-level sort is not what _.sort runs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns CJS MUST-NOT: a receiver REASSIGNED after the require refuses (assigned more than once)', () => {
  const files = { 'src/util.js': CJS_UTIL };
  const d = project(files);
  const testCode = `let _ = require('../src/util.js');\n_ = makeFake();\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ns CJS MUST-NOT: a BARE require spec (dependency) never binds', () => {
  const files = { 'src/util.js': CJS_UTIL };
  const d = project(files);
  const testCode = `const _ = require('lodash');\ntest('t', () => { assert.deepStrictEqual(_.sort([2, 1]), [1, 2]); });\n`;
  const body = `  assert.deepStrictEqual(_.sort([2, 1]), [1, 2]);\n`;
  try { assert.deepEqual(nsSuts(d, files, testCode, body), []); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- e2e: prove() gains the verdict — the radash shape end-to-end ----

test('PROVE ns CJS e2e: a value-pinning `_.sort()` block over a require namespace is CAUGHT', () => {
  const d = project({
    'package.json': '{"name":"cjs-fixture","scripts":{"test":"node --test"}}',
    'src/util.js': CJS_UTIL,
    'test/ns.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const _ = require('../src/util.js');
test('cjs ns sort pins a value', () => {
  assert.deepStrictEqual(_.sort([3, 1, 2]), [1, 2, 3]);
});
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'gutting util.js through the require namespace breaks the test — CAUGHT');
    assert.equal(full.hollow.length, 0);
    assert.equal(full.skipped.length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE ns e2e: a value-pinning `_.sort()` block through a root star-barrel is CAUGHT', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/util.mjs': UTIL,
    'src/index.mjs': `export * from './util.mjs';\n`,
    'test/ns.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as _ from '../src/index.mjs';
test('ns sort pins a value', () => {
  assert.deepStrictEqual(_.sort([3, 1, 2]), [1, 2, 3]);
});
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'gutting util.mjs through the ns member call breaks the test — CAUGHT');
    assert.equal(full.hollow.length, 0);
    assert.equal(full.skipped.length, 0, 'no longer skipped as pin-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
