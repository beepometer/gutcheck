// Alias-import SUT resolution (roadmap #1 after the barrel hop): a test importing its function through
// a path alias — package.json `imports` (`#src/util`) or tsconfig/jsconfig `compilerOptions.paths`
// (`~/util`, `@/util`) — previously never bound at all: the specifier is not relative, so makeResolver
// refused and the block reported `sut-unresolved`. Wild-pilot receipt (2026-07-28): radash's entire
// suite imports `~/...` and the probe's engagement was zero.
//
// Cardinal invariant unchanged: ZERO false verdicts. An alias is followed only when the mapping is the
// one the RUNTIME would take: exact pattern beats wildcard, longest prefix wins among wildcards, and a
// multi-target array resolves to the FIRST target whose file exists — with no fallthrough past it, since
// the runtime loads that first file whether or not the symbol is declared there (resolving a later
// target would gut a file the test never runs). Everything unclear REFUSES to `sut-unresolved`:
// unmatched bare specifiers, malformed configs, and code-based alias configs (vitest resolve.alias,
// jest moduleNameMapper) which cannot be read statically. Oracles are hand-derived from the fixtures.
//
// RED bite confirmed at HEAD (before mutation/alias.mjs existed): every happy-path unit below returned
// null, and the e2e reported skipped: [{ why: 'sut-unresolved' }] — while the #-alias fixture test runs
// green under plain `node --test` (node-native subpath imports), proving the runtime resolves what the
// reader could not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResolver, importMap, prove } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-alias-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const abs = (d, ...segs) => join(d, ...segs);

const IMPL = `export function add(a, b) { return a + b; }
`;

function resolveIn(d, files, fromSpec) {
  const srcFiles = Object.keys(files).filter((r) => /\.(mjs|js|ts)$/.test(r)).map((r) => abs(d, r));
  const testCode = `import { add } from '${fromSpec}';\n`;
  return makeResolver(srcFiles, d)('add', abs(d, 'test/add.test.mjs'), importMap(testCode));
}

// ---- package.json `imports` (#-aliases, node-native) ----

test('alias: a package.json #-import wildcard resolves to the declaring file', () => {
  const files = { 'package.json': '{"type":"module","imports":{"#src/*":"./src/*"}}', 'src/impl.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '#src/impl.mjs'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: an exact #-import key (no wildcard) resolves', () => {
  const files = { 'package.json': '{"type":"module","imports":{"#impl":"./src/impl.mjs"}}', 'src/impl.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '#impl'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: a #-import conditions object takes its default/node string target', () => {
  const files = { 'package.json': '{"type":"module","imports":{"#src/*":{"default":"./src/*"}}}', 'src/impl.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '#src/impl.mjs'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- tsconfig/jsconfig `paths` ----

test('alias: a tsconfig wildcard path (`~/*` → src/*) resolves, extension candidates applied', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}', 'src/util.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/util'), 'src/util.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: baseUrl anchors the path targets', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"baseUrl":"./app","paths":{"@/*":["lib/*"]}}}', 'app/lib/x.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '@/x'), 'app/lib/x.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: an exact (non-wildcard) tsconfig pattern resolves', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"paths":{"cfg":["src/config.mjs"]}}}', 'src/config.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, 'cfg'), 'src/config.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: the longest-prefix wildcard wins (tsc precedence)', () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"],"~/deep/*":["other/*"]}}}',
    'src/deep/x.mjs': IMPL,
    'other/x.mjs': IMPL,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/deep/x'), 'other/x.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: a multi-target array resolves via the FIRST target whose file exists', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["gen/*","src/*"]}}}', 'src/x.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/x'), 'src/x.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: JSONC tsconfig (comments + trailing comma) still parses', () => {
  const files = {
    'tsconfig.json': '{\n  // aliases\n  "compilerOptions": {\n    "paths": {\n      "~/*": ["src/*"], /* block */\n    },\n  }\n}',
    'src/util.mjs': IMPL,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/util'), 'src/util.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: a one-hop tsconfig `extends` carries the parent paths', () => {
  const files = {
    'tsconfig.json': '{"extends":"./tsconfig.base.json"}',
    'tsconfig.base.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}',
    'src/util.mjs': IMPL,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/util'), 'src/util.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias: jsconfig.json works when no tsconfig exists', () => {
  const files = { 'jsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}', 'src/util.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/util'), 'src/util.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias composes with the barrel hop: `~/index` barrel re-exports the declaring file', () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}',
    'src/index.mjs': `export { add } from './impl.mjs';\n`,
    'src/impl.mjs': IMPL,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/index'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- refusal paths — every unclear case stays sut-unresolved (null), never a guess ----

test('alias MUST-NOT: an unmatched bare specifier (a real dependency) never binds', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}', 'src/util.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, 'lodash'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias MUST-NOT: first EXISTING multi-target file without the declaration refuses — no fallthrough', () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["gen/*","src/*"]}}}',
    'gen/x.mjs': `export const unrelated = 1;\n`,
    'src/x.mjs': IMPL,
  };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/x'), null, 'the runtime loads gen/x — resolving src/x would gut a file the test never runs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias MUST-NOT: a malformed tsconfig yields no aliases, never a throw', () => {
  const files = { 'tsconfig.json': '{"compilerOptions": {{{', 'src/util.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '~/util'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('alias MUST-NOT: a #-import with no matching key refuses', () => {
  const files = { 'package.json': '{"type":"module","imports":{"#src/*":"./src/*"}}', 'src/impl.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '#other/impl.mjs'), null); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('a bare dotted specifier (`..`) is a RELATIVE directory import and resolves via index candidates', () => {
  const files = { 'src/impl.mjs': IMPL, 'index.mjs': `export { add } from './src/impl.mjs';\n` };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '..'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('regression pin: a RELATIVE import resolves exactly as before, aliases untouched', () => {
  const files = { 'tsconfig.json': '{"compilerOptions":{"paths":{"~/*":["src/*"]}}}', 'src/impl.mjs': IMPL };
  const d = project(files);
  try { assert.equal(resolveIn(d, files, '../src/impl.mjs'), 'src/impl.mjs'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- e2e: prove() gains the verdict through a node-native #-alias (runnable under node --test) ----

test('PROVE alias e2e: a value-pinning test importing through a #-alias is CAUGHT', () => {
  const d = project({
    'package.json': '{"type":"module","imports":{"#src/*":"./src/*"}}',
    'src/impl.mjs': IMPL,
    'test/add.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '#src/impl.mjs';
test('add pins a concrete value', () => {
  assert.strictEqual(add(2, 3), 5);
});
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 1, 'gutting impl.mjs through the #-alias import breaks the test — CAUGHT');
    assert.equal(full.hollow.length, 0);
    assert.equal(full.skipped.length, 0, 'no longer skipped as sut-unresolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
