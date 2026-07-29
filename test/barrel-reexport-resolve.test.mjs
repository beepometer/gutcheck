// One-hop re-export barrel SUT resolution (backlog item 2, docs/limits.md "What the probe can reach"):
// a test that imports `fn` through a barrel (`export { fn } from './impl.mjs'` or `export * from
// './impl.mjs'`) previously resolved only as far as the barrel — no declaration there, so the block
// reported `sut-unresolved` and the function went unverifiable. Measured on this repo's own
// module-extraction refactor: verdict coverage 60% → 45%, +170 not-locatable.
//
// The cardinal invariant is unchanged from jsInstanceSuts: ZERO false verdicts. Following a barrel may
// only ever resolve to the file whose declaration of `fn` the runtime import would actually reach —
// anything less certain REFUSES and keeps the truthful `sut-unresolved` label. Refusal paths pinned
// below: aliased re-exports (declared name differs from tested name), bare/builtin specifiers, chains
// deeper than one hop, and `export *` fan-outs where more than one target declares `fn`. Oracles are
// hand-derived (which file declares `add` is fixed by the fixture), never pinned from resolver output.
//
// RED bite confirmed at HEAD (before the hop existed): every happy-path unit below returned null, and
// the e2e reported `no value-pinning tests to probe` with skipped: [{ why: 'sut-unresolved' }] — while
// hand-gutting `add` in impl.mjs made the fixture test fail, proving the oracle is independent of the
// resolver (the mutant already breaks the test; the reading was the gap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResolver, importMap, prove } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-barrel-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

const IMPL = `export function add(a, b) { return a + b; }
export function mul(a, b) { return a * b; }
`;

// resolveSut for a test importing `add` from `fromSpec`, against the given project layout.
function resolveIn(d, files, fromSpec) {
  const srcFiles = Object.keys(files).map((r) => abs(d, r));
  const testCode = `import { add } from '${fromSpec}';\n`;
  return makeResolver(srcFiles, d)('add', abs(d, 'test/add.test.mjs'), importMap(testCode));
}

// ---- unit: happy paths — the hop resolves to the DECLARING file ----

test('barrel hop: same-name `export { add } from` resolves one hop to the declaring file', () => {
  const files = { 'src/impl.mjs': IMPL, 'src/index.mjs': `export { add, mul } from './impl.mjs';\n` };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop: a DIRECTORY specifier (`../src` → src/index.mjs) follows the index barrel', () => {
  const files = { 'src/impl.mjs': IMPL, 'src/index.mjs': `export { add } from './impl.mjs';\n` };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop: `export * from` resolves when exactly ONE starred target declares the fn', () => {
  const files = {
    'src/a.mjs': IMPL,
    'src/b.mjs': `export function sub(a, b) { return a - b; }\n`,
    'src/index.mjs': `export * from './a.mjs';\nexport * from './b.mjs';\n`,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), 'src/a.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop: an explicit named re-export WINS over a star that also declares the name (ESM precedence)', () => {
  const files = {
    'src/a.mjs': IMPL,
    'src/b.mjs': IMPL,
    'src/index.mjs': `export { add } from './a.mjs';\nexport * from './b.mjs';\n`,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), 'src/a.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- unit: refusal paths — every unclear case stays sut-unresolved (null), never a guess ----

test('barrel hop MUST-NOT: an ALIASED re-export (`sum as add`) refuses — the declared name differs', () => {
  const files = {
    'src/impl.mjs': `export function sum(a, b) { return a + b; }\n`,
    'src/index.mjs': `export { sum as add } from './impl.mjs';\n`,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop MUST-NOT: `export *` with TWO declaring targets refuses — ambiguous, never first-wins', () => {
  const files = {
    'src/a.mjs': IMPL,
    'src/b.mjs': IMPL,
    'src/index.mjs': `export * from './a.mjs';\nexport * from './b.mjs';\n`,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop MUST-NOT: a BARE specifier (`export { add } from "left-pad"`) refuses — deps are never SUTs', () => {
  const files = { 'src/index.mjs': `export { add } from 'left-pad';\n` };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop MUST-NOT: a TWO-hop chain (barrel → barrel → impl) refuses — one hop only, disclosed', () => {
  const files = {
    'src/impl.mjs': IMPL,
    'src/mid.mjs': `export { add } from './impl.mjs';\n`,
    'src/index.mjs': `export { add } from './mid.mjs';\n`,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('barrel hop MUST-NOT: a named re-export whose target does not declare the fn never falls back to stars', () => {
  const files = {
    'src/a.mjs': IMPL,
    'src/mid.mjs': `export const unrelated = 1;\n`,
    'src/index.mjs': `export { add } from './mid.mjs';\nexport * from './a.mjs';\n`,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/index.mjs'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// TS NodeNext idiom (found on superstruct, 25 sut-unresolved rows): specifiers say `.js` while the
// sources are `.ts` — `export * from './struct.js'` next to struct.ts. The literal candidates run
// first, so a real .js file wins exactly as before; the swapped pass fires only where the literal
// set matched nothing.
test('ts-swap: a `.js` specifier resolves to the `.ts` source when no .js file exists (direct import)', () => {
  const files = { 'src/impl.ts': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/impl.js'), 'src/impl.ts'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ts-swap: a star barrel with `.js` specifiers over `.ts` sources resolves through the hop (the superstruct shape)', () => {
  const files = {
    'src/index.ts': `export * from './error.js';\nexport * from './struct.js';\n`,
    'src/error.ts': `export function fail(m) { return new Error(m); }\n`,
    'src/struct.ts': IMPL,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src'), 'src/struct.ts'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ts-swap precedence pin: when BOTH .js and .ts exist, the literal .js wins exactly as before', () => {
  const files = { 'src/impl.js': IMPL, 'src/impl.ts': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/impl.js'), 'src/impl.js'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('regression pin: a DIRECT declaration in the imported file resolves exactly as before (no hop taken)', () => {
  const files = { 'src/impl.mjs': IMPL, 'src/index.mjs': `export { add } from './impl.mjs';\n` };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/impl.mjs'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- e2e: prove() gains the verdict through the barrel — gut impl.mjs, the barrel-importing test
// goes red, the block is CAUGHT (previously: skipped, why 'sut-unresolved') ----

test('PROVE barrel e2e: a value-pinning test importing through a re-export barrel is CAUGHT', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/impl.mjs': IMPL,
    'src/index.mjs': `export { add, mul } from './impl.mjs';\n`,
    'test/add.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/index.mjs';
test('add pins a concrete value', () => {
  assert.strictEqual(add(2, 3), 5);
});
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'gutting impl.mjs through the barrel import breaks the test — CAUGHT');
    assert.equal(full.hollow.length, 0);
    assert.equal(full.skipped.length, 0, 'no longer skipped as sut-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
