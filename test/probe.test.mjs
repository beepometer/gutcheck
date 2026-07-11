import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, grossBreak, passthroughBreak, jsDeclSiteCount, jsDeclSites } from '../mutation/probe.mjs';

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

// A one-line INLINE-body Python def must be gutted IN PLACE (`def f(x): return 987654321`), not by
// appending an indented `return` on the next line — that would be an IndentationError, the module would
// fail to import, the test would error, and the probe would report an UNEARNED SOUND (over-claiming
// "proven" for what could be a genuinely hollow one-line test). It fails safe (never a false HOLLOW),
// but the wrong verdict is unacceptable, and indented one-line methods are common in Python.
test('grossBreak: a one-line inline-body python def is gutted in place (valid mutant, not an IndentationError)', () => {
  const top = grossBreak('def f(x): return x*2\n', 'f', 'python') || '';
  assert.match(top, /def f\(x\): return 987654321/, 'body replaced in place on the def line');
  assert.doesNotMatch(top, /x\*2/, 'the real one-line body is gone');
  assert.doesNotMatch(top, /\n\s+return 987654321/, 'must NOT append an indented return (that is the IndentationError bug)');

  const method = grossBreak('class C:\n    def m(self, x): return x*2\n', 'm', 'python') || '';
  assert.match(method, /def m\(self, x\): return 987654321/, 'indented one-line method gutted in place');
  assert.doesNotMatch(method, /x\*2/);
  assert.doesNotMatch(method, /\n\s+return 987654321\n\s+return/, 'no doubled/misindented return');

  // Regression: a normal MULTI-LINE def still guts exactly as before (byte-identical block-body path).
  assert.equal(grossBreak('def f(x):\n    return x*2\n', 'f', 'python'), 'def f(x):\n    return 987654321\n');
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
// Confirmatory audit batch A, row 3 (workslo/05_vibe-flow-pro): a return type that is a UNION of two or
// more inline object-literal members escaped the mutation into the union's SECOND (or later) member
// instead of the function body — findBodyBrace dropped its "inside-return-type" state after skipping
// only the FIRST union member, so the next `{` (the second member's type brace) was mistaken for the
// body and gutted instead, leaving the real body (and thus the SUT's actual behavior) untouched → every
// value-pinned test on that fn trivially "survived" (a false HOLLOW, not a real test-quality finding).
test('grossBreak: a TS return-type UNION of object literals does not escape into a later member (confirmatory audit batch A, row 3)', () => {
  const two = grossBreak(
    'function validateDevelopmentGraph(nodes, edges): { valid: true } | { valid: false; error: string } {\n'
    + '  if (nodes.length === 0) return { valid: false, error: "empty" };\n'
    + '  return { valid: true };\n'
    + '}',
    'validateDevelopmentGraph',
  ) || '';
  assert.match(two, /987654321/, 'the sentinel return is present — the BODY was gutted');
  assert.match(two, /:\s*\{ valid: true \} \| \{ valid: false; error: string \} \{/, 'the return-type union survives byte-for-byte, untouched');
  assert.doesNotMatch(two, /if \(nodes\.length === 0\)/, 'the real body logic is gone');
  assert.doesNotMatch(two, /return \{ valid: true \};\n\}/, 'the real tail return is gone');
  // three-member variant — the fix must not just special-case exactly one `|` hop
  const three = grossBreak(
    'function f(x): { a: number } | { b: number } | { c: number } {\n  doWork(x);\n  return { a: 1 };\n}',
    'f',
  ) || '';
  assert.match(three, /987654321/, 'the sentinel return is present — the BODY was gutted');
  assert.match(three, /:\s*\{ a: number \} \| \{ b: number \} \| \{ c: number \} \{/, 'the 3-member return-type union survives untouched');
  assert.doesNotMatch(three, /doWork\(x\)/, 'the real body logic is gone');
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

// Pass 2 of locateBody (class method / object-shorthand method — no `function`/`def`/`=` keyword at
// all). Only reached when pass 1 finds nothing, so this exercises locateBareMethod directly.
test('grossBreak: a bare class-method signature is gutted (pass 2 — no top-level match exists)', () => {
  const out = grossBreak('class C { updateUser(id){ return id*2 } }', 'updateUser', 'js');
  assert.ok(out !== null, 'a valid mutant must be produced, not null');
  assert.match(out, /987654321/);
  assert.doesNotMatch(out, /id\*2/);
});
test('grossBreak: a bare object-shorthand-method signature is gutted (pass 2)', () => {
  const out = grossBreak('const o = { compute(x){ return x + 1; } };', 'compute', 'js');
  assert.ok(out !== null, 'a valid mutant must be produced, not null');
  assert.match(out, /987654321/);
  assert.doesNotMatch(out, /return x \+ 1/);
});
test('grossBreak: adversarial call-vs-decl for the bare-method pass 2 — never mis-gut a call site', () => {
  assert.equal(grossBreak('foo(x);', 'foo', 'js'), null, 'a bare call statement is not a method decl');
  assert.equal(grossBreak('if (cond) { doThing(); }', 'cond', 'js'), null, '`if (cond) {` is not a decl of `cond`');
  assert.equal(grossBreak('while (bar()) { spin(); }', 'bar', 'js'), null, 'a call inside a while-condition is not a decl');
});

// jsDeclSiteCount (Task B1 / T3): counts pass-1 (jsSigRegex) + pass-2 (bareMethodSites) declaration
// sites for a name, built from locateBody/locateBareMethod's OWN patterns so the counter can never drift
// from what grossBreak would actually gut — mutation/prove.mjs's jsInstanceSuts credit-time uniqueness
// guard depends on that invariant (a count of 1 there must mean gut-time would break exactly that site).
test('jsDeclSiteCount: a single top-level function declaration counts 1', () => {
  assert.equal(jsDeclSiteCount('export function decrypt(s){ return s; }', 'decrypt'), 1);
});
test('jsDeclSiteCount: a single bare class-method declaration (pass 2 only) counts 1', () => {
  assert.equal(jsDeclSiteCount('class Service { decrypt(s){ return s; } }', 'decrypt'), 1);
});
test('jsDeclSiteCount: a name with no declaration at all counts 0', () => {
  assert.equal(jsDeclSiteCount('export function encrypt(s){ return s; }', 'decrypt'), 0);
  assert.equal(jsDeclSiteCount('foo(x); if (cond) { bar(); }', 'foo'), 0, 'call sites are never declarations');
});
// The load-bearing case: a top-level helper fn AND a same-named class method in ONE file. locateBody's
// pass 1 "wins outright" at gut time (it would silently gut the HELPER, leaving the class method live),
// so a naive pass-2-only or pass-1-only count would read 1 and let jsInstanceSuts credit a method gut-
// time can never actually reach — this is exactly the false-HOLLOW vector jsDeclSiteCount closes.
test('jsDeclSiteCount: a top-level helper fn PLUS a same-named class method counts 2 (the collision case)', () => {
  const code = `export function decrypt(s) { return s.split('').reverse().join(''); }
export class Service {
  decrypt(s) { return s.split('').reverse().join(''); }
}
`;
  assert.equal(jsDeclSiteCount(code, 'decrypt'), 2);
});
test('jsDeclSiteCount: two class-method sites (pass 2 only, two different classes) counts 2', () => {
  const code = `class A { get(){ return 1; } }
class B { get(){ return 2; } }
`;
  assert.equal(jsDeclSiteCount(code, 'get'), 2);
});
test('jsDeclSiteCount: a mention inside a string or comment is never counted (mask-first, like locateBody)', () => {
  const code = `// function decrypt(s){ return s; }
const note = "function decrypt(s){ return s; }";
export class Service { decrypt(s){ return s; } }
`;
  assert.equal(jsDeclSiteCount(code, 'decrypt'), 1, 'only the real class-method declaration counts');
});
test('jsDeclSiteCount: a JS/TS keyword name never counts a pass-2 site (mirrors locateBareMethod\'s refusal)', () => {
  assert.equal(jsDeclSiteCount('class C { if(){ return 1; } }', 'if'), 0);
});

// jsDeclSites (T3 false-HOLLOW fix): the crediting-time class-body-containment guard in
// mutation/prove.mjs's jsInstanceSuts needs more than a COUNT — it needs the site's POSITION, so it can
// check whether the one unique decl site actually falls inside the resolved class's own brace span, or
// merely inside some unrelated sibling class (or is inherited from elsewhere entirely, leaving its only
// same-named site on a sibling). jsDeclSiteCount is exactly jsDeclSites(...).length.
test('jsDeclSites: returns the START INDEX of a single top-level function declaration', () => {
  const code = 'export function decrypt(s){ return s; }';
  const sites = jsDeclSites(code, 'decrypt');
  assert.deepEqual(sites.length, 1);
  assert.equal(code.slice(sites[0], sites[0] + 8), 'function');
});
test('jsDeclSites: length is always exactly jsDeclSiteCount\'s count', () => {
  const code = `export function decrypt(s) { return s.split('').reverse().join(''); }
export class Service {
  decrypt(s) { return s.split('').reverse().join(''); }
}
`;
  assert.equal(jsDeclSites(code, 'decrypt').length, jsDeclSiteCount(code, 'decrypt'));
  assert.equal(jsDeclSites(code, 'decrypt').length, 2);
});
// The load-bearing distinction: a unique decl site's index can fall inside a completely unrelated
// SIBLING class's body rather than the class actually being resolved to (here `Service extends Base` —
// `decrypt` is inherited, never declared on Service itself — and the only same-named site in this file
// is `LegacyCodec.decrypt`, an unrelated sibling). A site COUNT of 1 cannot tell these two cases apart;
// jsDeclSites must report the TRUE position so the caller can.
test('jsDeclSites: site-in-sibling-class vs site-in-class-body are positionally distinguishable', () => {
  const code = `export class Service extends Base {
  encrypt(s) { return s; }
}
export class LegacyCodec {
  decrypt(s) { return 'legacy:' + s; }
}
`;
  const sites = jsDeclSites(code, 'decrypt');
  assert.equal(sites.length, 1, 'Service has no own decrypt at all — the only site is LegacyCodec\'s');
  const serviceOpen = code.indexOf('{', code.indexOf('class Service'));
  const serviceClose = code.indexOf('\n}', serviceOpen); // Service's own closing brace
  const legacyOpen = code.indexOf('{', code.indexOf('class LegacyCodec'));
  assert.ok(sites[0] > legacyOpen, 'the site falls inside LegacyCodec\'s body, not before it');
  assert.ok(!(sites[0] > serviceOpen && sites[0] < serviceClose), 'the site is NOT inside Service\'s own body span');
});
test('jsDeclSites: an own-body class method site falls strictly inside that class\'s own brace span', () => {
  const code = `export class Service {
  decrypt(s) { return s; }
}
`;
  const sites = jsDeclSites(code, 'decrypt');
  assert.equal(sites.length, 1);
  const open = code.indexOf('{', code.indexOf('class Service'));
  const close = code.lastIndexOf('}');
  assert.ok(sites[0] > open && sites[0] < close, 'the site is inside Service\'s own body span');
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
