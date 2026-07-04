import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, grossBreak, passthroughBreak } from '../mutation/probe.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'sk-probe-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}

const SUT = `export function computeTotal(items){ return items.reduce((a,b)=>a+b,0); }
export function loadItem(d){ return { v: d.v / 2 }; }
export function dumpItem(x){ return { v: x.v * 2 }; }
export function memoize(fn){ const c=new Map(); return (...a)=>{ const k=JSON.stringify(a); if(!c.has(k))c.set(k,fn(...a)); return c.get(k); }; }
export function area(r){ return 3.14159*r*r; }
`;
const head = "import test from 'node:test'; import assert from 'node:assert';";

test('grossBreak replaces a JS function body (brace-aware), null if absent', () => {
  const out = grossBreak('export function f(x){ return g(x) + 1; }', 'f');
  assert.match(out, /987654321/);
  assert.doesNotMatch(out, /return g\(x\)/);
  assert.equal(grossBreak('export function g(){}', 'notthere'), null);
});
test('grossBreak handles a const-arrow and a python def', () => {
  assert.match(grossBreak('const f = (x) => x + 1;', 'f') || '', /987654321/);
  assert.match(grossBreak('def f(x):\n    return x + 1\n', 'f') || '', /987654321/);
});

// Regression: bugs found by the adversarial review of grossBreak.
test('grossBreak: a brace inside a string literal does not fool the body scanner', () => {
  const out = grossBreak("function process() {\n  const e = 'unmatched {';\n  return 0;\n}", 'process');
  assert.match(out, /987654321/);
  assert.doesNotMatch(out, /return 0/);
});
test('grossBreak: a default-param arrow is not mistaken for the function body', () => {
  for (const code of ['const foo = (x = () => 5) => x() + 1;', 'const foo = (x = () => {}) => x();']) {
    const out = grossBreak(code, 'foo');
    assert.match(out, /987654321/, code);
    assert.doesNotMatch(out, /\bx\(\)/, code); // the real body x()/x()+1 was gutted, default param intact
  }
});
test('grossBreak: bare single-param and async arrows are recognized', () => {
  assert.match(grossBreak('const f = x => x + 1;', 'f') || '', /987654321/);
  assert.match(grossBreak('export const compute = n => n * 2;', 'compute') || '', /987654321/);
  assert.match(grossBreak('const f = async x => x + 1;', 'f') || '', /987654321/);
});
test('grossBreak: gutts only the named function in a multi-function file', () => {
  const code = 'export function a(){ return 1; }\nexport function b(){ return 2; }\n';
  const out = grossBreak(code, 'b');
  assert.match(out, /function a\(\)\{ return 1; \}/); // a untouched
  assert.match(out, /function b\(\)\{ return 987654321; \}/);
});
test('grossBreak: a TS return-type annotation is not mistaken for the function body', () => {
  // Found on a real repo (selectBeat): in `): { id: string } {` the FIRST brace is the return TYPE,
  // the body is the second. Gutting the type leaves the real body running → a false HOLLOW verdict.
  const obj = grossBreak('export function pick(s, t = 0.25): { id: string; drift: boolean } {\n  return { id: s[0].id, drift: false };\n}', 'pick') || '';
  assert.match(obj, /:\s*\{ id: string; drift: boolean \}/); // the return TYPE survives intact
  assert.doesNotMatch(obj, /return \{ id: s\[0\]/);          // the real BODY is gutted
  assert.match(obj, /987654321/);
  // a generic on the function name must still be located and gutted
  const gen = grossBreak('function h<T>(x): T[] {\n  return [x];\n}', 'h') || '';
  assert.match(gen, /987654321/);
  assert.doesNotMatch(gen, /return \[x\]/);
  // a brace-free return type (void / union) already worked — guard against regression
  const v = grossBreak('function log(x): void {\n  sideEffect(x);\n}', 'log') || '';
  assert.match(v, /987654321/);
  assert.doesNotMatch(v, /sideEffect\(x\)/);
});

// Recall: shapes grossBreak previously dropped to null (→ INCONCLUSIVE, an unscored test).
test('grossBreak: generator and async-generator declarations are gutted', () => {
  const g = grossBreak('export function* foo(){ yield 1; yield 2; }', 'foo') || '';
  assert.match(g, /987654321/);
  assert.doesNotMatch(g, /yield 1/);
  const ag = grossBreak('export async function* foo(){ yield 1; }', 'foo') || '';
  assert.match(ag, /987654321/);
  assert.doesNotMatch(ag, /yield 1/);
  // a normal (non-generator) function must STILL be located — no regression from relaxing the sig
  assert.match(grossBreak('export function plain(){ return 7; }', 'plain') || '', /987654321/);
  assert.equal(grossBreak('const functionfoo = 1;', 'foo'), null); // `functionfoo` is one identifier, not `function foo`
});
test('grossBreak: a colon-property function value is gutted', () => {
  const out = grossBreak('export const u = { foo: function(a){ return a + 1; } };', 'foo') || '';
  assert.match(out, /987654321/);
  assert.doesNotMatch(out, /return a \+ 1/);
});
test('grossBreak: a non-function colon (object key, typed binding) is NOT gutted', () => {
  assert.equal(grossBreak('const u = { foo: 2, bar: 3 };', 'foo'), null);
  assert.equal(grossBreak('const foo: number = compute();', 'foo'), null);
});

test('passthroughBreak: body becomes `return <firstParam>`; null when there is no usable param', () => {
  assert.match(passthroughBreak('export function norm(s){ return s.trim(); }', 'norm') || '', /\{\s*return s;\s*\}/);
  assert.match(passthroughBreak('export function add(a, b){ return a + b; }', 'add') || '', /\{\s*return a;\s*\}/);
  assert.match(passthroughBreak('const norm = (s) => s.trim().toLowerCase();', 'norm') || '', /=>\s*s\b/);
  assert.match(passthroughBreak('def clean(s, n):\n    return s.strip()\n', 'clean', 'python') || '', /return s\b/);
  assert.equal(passthroughBreak('function f(){ return 5; }', 'f'), null, 'no params → null');
  assert.equal(passthroughBreak('function f({ a }){ return a; }', 'f'), null, 'destructured param → null');
  assert.equal(passthroughBreak('function f(...args){ return args[0]; }', 'f'), null, 'rest param → null');
});
test('passthroughBreak: a literal identity function is NOT mutated (returns null — nothing to expose)', () => {
  assert.equal(passthroughBreak('export const id = x => x;', 'id'), null);
  assert.equal(passthroughBreak('export function id(x){ return x; }', 'id'), null);
});

test('PROBE: a runtime tautology is HOLLOW (test passes even with a gutted SUT)', () => {
  const d = project({ 'package.json': '{"type":"module"}', 'src/sut.mjs': SUT,
    'test/t.test.mjs': `${head} import { computeTotal } from '../src/sut.mjs';\ntest('x',()=>{ const e=computeTotal([1,2,3]); assert.strictEqual(computeTotal([1,2,3]), e); });` });
  try { assert.equal(probe(d, { testFile: 'test/t.test.mjs', sutFile: 'src/sut.mjs', sutFn: 'computeTotal' }).verdict, 'HOLLOW'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROBE: a fixture round-trip is SOUND (gutting the SUT breaks it)', () => {
  const d = project({ 'package.json': '{"type":"module"}', 'src/sut.mjs': SUT,
    'test/t.test.mjs': `${head} import { loadItem, dumpItem } from '../src/sut.mjs';\nfunction makeItem(){ return {v:3}; }\ntest('rt',()=>{ assert.deepStrictEqual(loadItem(dumpItem(makeItem())), makeItem()); });` });
  try { assert.equal(probe(d, { testFile: 'test/t.test.mjs', sutFile: 'src/sut.mjs', sutFn: 'loadItem' }).verdict, 'SOUND'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROBE: a function-equivalence (memoize) test is SOUND', () => {
  const d = project({ 'package.json': '{"type":"module"}', 'src/sut.mjs': SUT,
    'test/t.test.mjs': `${head} import { memoize } from '../src/sut.mjs';\nfunction f(x,y){ return x+y; }\ntest('eq',()=>{ const mf=memoize(f); assert.strictEqual(mf(1,2), f(1,2)); });` });
  try { assert.equal(probe(d, { testFile: 'test/t.test.mjs', sutFile: 'src/sut.mjs', sutFn: 'memoize' }).verdict, 'SOUND'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROBE: INCONCLUSIVE when the unmutated test does not pass, or the fn is absent', () => {
  const d = project({ 'package.json': '{"type":"module"}', 'src/sut.mjs': SUT,
    'test/t.test.mjs': `${head}\ntest('bad',()=>{ assert.strictEqual(1,2); });` });
  try { assert.equal(probe(d, { testFile: 'test/t.test.mjs', sutFile: 'src/sut.mjs', sutFn: 'area' }).verdict, 'INCONCLUSIVE'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});
