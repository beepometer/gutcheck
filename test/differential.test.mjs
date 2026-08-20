import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { oracleFnBodies, diffGut, diffMask } from '../scripts/differential.mjs';
import { codeOnly } from '../checker/lexer.mjs';
import { grossBreak } from '../mutation/probe.mjs';
import { declaredFns } from '../mutation/changes.mjs';

// Check C — the changes.mjs grammar-sync invariant, run corpus-wide: everything the diff report
// enumerates must be guttable (a phantom row otherwise), and everything guttable must be enumerated
// (a silent denominator hole otherwise) EXCEPT nested functions (a hunk there marks the encloser —
// deliberate) and the forms changes.mjs's header documents as known deltas (precision first).
const ENUM_EXEMPT_FORMS = new Set(['object-prop-fn', 'class-prop']);
function declViolations(code, bodies) {
  const out = [];
  const enumerated = new Set(declaredFns(code, 'js').map((d) => d.fn));
  const counts = new Map();
  for (const b of bodies) counts.set(b.name, (counts.get(b.name) || 0) + 1);
  const seen = new Set();
  for (const b of bodies) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    const guttable = grossBreak(code, b.name) !== null;
    // A same-name collision the probe REFUSES (ambiguity) can't be attributed to either decl — skip.
    // A collision the probe resolves unambiguously (pass-1 wins outright over the method pass) stays
    // checked: skipping it too would hide a real hole behind an incidental name reuse (review finding).
    if (counts.get(b.name) !== 1 && !guttable) continue;
    const listed = enumerated.has(b.name);
    if (listed && !guttable) out.push(`decl(${b.name}) enumerated but not guttable — phantom-row risk`);
    else if (!listed && guttable && !b.nested && !ENUM_EXEMPT_FORMS.has(b.form)) {
      out.push(`decl(${b.name}) guttable but not enumerated (${b.form}) — silent denominator hole`);
    }
  }
  return out;
}

// The differential oracle: a real parser (@babel/parser, devDependency only — never shipped) checks
// the two regex-layer decisions whose silent drift has produced real wrong verdicts. (1) GUT SPANS:
// a grossBreak mutant must parse, the target's body must be nothing but the sentinel (a partial gut —
// the arrowSite class — leaves original body text alive), and every other named function must be
// byte-identical (an over-run swallows a neighbor). (2) MASKING: codeOnly must blank exactly the
// comment/string/template/regex ranges the parser reports — blanking real code desyncs every brace
// walk downstream; leaking literal content feeds the scans text they must never see.
//
// The bite tests below plant each defect class and require the oracle to flag it — a differential
// harness that cannot catch a hand-planted defect guards nothing.

const ROOT = join(import.meta.dirname, '..');

// ---- bite: gut-span differential ----

const TERNARY = "export const label = (n) =>\n  n > 0\n    ? 'pos'\n    : 'neg';\n";
const CHAIN = 'export const slug = (s) =>\n  s.toLowerCase()\n    .trim();\n';
const TWO = 'export function a(){ return 1; }\nexport function b(){ return 2; }\n';

test('diffGut bites: a partial gut (original body text survives) is flagged', () => {
  // The exact pre-fix arrowSite mutant: only the condition line replaced, both branches alive.
  const partial = TERNARY.replace('n > 0', '987654321');
  const v = diffGut(TERNARY, '.mjs', 'label', partial);
  assert.equal(v.ok, false);
  assert.match(v.reason, /sentinel/);
});

test('diffGut bites: a stranded chain tail (parses, but impure body) is flagged', () => {
  // The pre-fix chain mutant: `987654321\n.trim()` parses as a member call on the literal, then
  // crashes at runtime — the crash-read-as-catch class. The parse succeeds; purity must fail it.
  const stranded = CHAIN.replace('s.toLowerCase()', '987654321');
  const v = diffGut(CHAIN, '.mjs', 'slug', stranded);
  assert.equal(v.ok, false);
  assert.match(v.reason, /sentinel/);
});

test('diffGut bites: a gut that bleeds into a neighboring function is flagged', () => {
  const overrun = 'export function a(){ return 987654321; }\nexport function b(){ return 987654322; }\n';
  const v = diffGut(TWO, '.mjs', 'a', overrun);
  assert.equal(v.ok, false);
  assert.match(v.reason, /beyond the body/);
});

test('diffGut bites: a mutant that no longer parses is flagged', () => {
  const broken = TERNARY.replace("'neg';", "'neg'; }");
  const v = diffGut(TERNARY, '.mjs', 'label', broken);
  assert.equal(v.ok, false);
  assert.match(v.reason, /parse/);
});

test('diffGut clears the real grossBreak on the shapes the bite tests plant', () => {
  const PARENS = 'export const cfg = () => ({ retries: 3 });\nexport function g(){ return 2; }\n';
  const OPFIRST = 'export const isTest = (f) =>\n  /a/.test(f)\n  || /b/.test(f);\n';
  for (const [src, fn] of [[TERNARY, 'label'], [CHAIN, 'slug'], [TWO, 'b'], [PARENS, 'cfg'], [OPFIRST, 'isTest']]) {
    const m = grossBreak(src, fn);
    assert.ok(m, `grossBreak must locate ${fn}`);
    const v = diffGut(src, '.mjs', fn, m);
    assert.equal(v.ok, true, `${fn}: ${v.reason}`);
  }
});

// ---- bite: masking differential ----

test('diffMask bites: blanked real code and leaked literal content are both flagged', () => {
  const src = 'const t = `ab`; function real(x){ return x + 1; }\n';
  const good = codeOnly(src, 'typescript');
  assert.deepEqual(diffMask(src, good, '.mjs'), [], 'the genuine mask must be clean');

  const at = src.indexOf('ab');
  const leak = good.slice(0, at) + 'ab' + good.slice(at + 2); // template content resurfaces as live text
  const leakV = diffMask(src, leak, '.mjs');
  assert.equal(leakV.length > 0, true);
  assert.equal(leakV[0].dir, 'leaked-literal');

  const ate = good.replace('return', '      '); // real code blanked as if it were a literal
  const ateV = diffMask(src, ate, '.mjs');
  assert.equal(ateV.length > 0, true);
  assert.equal(ateV[0].dir, 'ate-code');
});

test('declViolations honors the documented deltas and nesting rule, and clears a clean file', () => {
  // known-delta forms produce no violation even though the probe guts them
  const known = 'export const api = {\n  load: function (x) { return x; },\n};\nexport class C {\n  bump = (n) => n + 1;\n}\n';
  assert.deepEqual(declViolations(known, oracleFnBodies(known, '.mjs')), []);
  // a nested named helper (inside an anonymous callback) is the encloser's territory, never a hole
  const nested = 'test(\'x\', () => {\n  function helper(a) { return a + 1; }\n  return helper(1);\n});\n';
  assert.deepEqual(declViolations(nested, oracleFnBodies(nested, '.mjs')), []);
  // a plain guttable top-level fn that IS enumerated is clean
  const clean = 'export function f(x) { return x + 1; }\n';
  assert.deepEqual(declViolations(clean, oracleFnBodies(clean, '.mjs')), []);
});

test('oracleFnBodies names the planted shapes with their body kind', () => {
  const bodies = oracleFnBodies(TERNARY + 'export function g(){ return 2; }\n', '.mjs');
  const byName = Object.fromEntries(bodies.map((b) => [b.name, b.kind]));
  assert.equal(byName.label, 'expr');
  assert.equal(byName.g, 'block');
});

// ---- the corpus gate ----

function corpusFiles() {
  const dirs = ['mutation', 'checker', 'checker/kinds', 'configure', 'configure/checksets', 'scripts', 'test', 'test/fixtures/differential'];
  const files = [];
  for (const d of dirs) {
    let entries; try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = extname(e.name);
      if (!['.mjs', '.js', '.ts'].includes(ext)) continue;
      files.push(join(d, e.name));
    }
  }
  return files.sort();
}

test('differential corpus: gut spans and masking agree with the real parser on every corpus file', () => {
  const files = corpusFiles();
  assert.ok(files.length > 30, `corpus unexpectedly small: ${files.length} files`);
  const violations = [];
  let fnsChecked = 0, unlocatable = 0, unparseable = 0;
  for (const rel of files) {
    const code = readFileSync(join(ROOT, rel), 'utf8');
    const ext = extname(rel);
    let bodies;
    try { bodies = oracleFnBodies(code, ext); } catch { unparseable++; continue; }
    for (const v of diffMask(code, codeOnly(code, 'typescript'), ext)) {
      violations.push(`${rel}:${v.line} mask ${v.dir} — ${v.snippet}`);
    }
    for (const v of declViolations(code, bodies)) violations.push(`${rel} ${v}`);
    const counts = new Map();
    for (const b of bodies) counts.set(b.name, (counts.get(b.name) || 0) + 1);
    for (const b of bodies) {
      if (counts.get(b.name) !== 1) continue; // ambiguous names are the probe's own refusal territory
      const mutant = grossBreak(code, b.name);
      if (!mutant) { unlocatable++; continue; } // a reach refusal is not a wrong gut — tracked, not failed
      const verdict = diffGut(code, ext, b.name, mutant);
      if (!verdict.ok) violations.push(`${rel} gut(${b.name}) — ${verdict.reason}`);
      else fnsChecked++;
    }
  }
  // No silent caps: state what ran.
  console.log(`# differential corpus: ${files.length} files, ${fnsChecked} guts verified, ${unlocatable} unlocatable (reach), ${unparseable} unparseable`);
  assert.equal(fnsChecked > 200, true, `expected a substantive gut corpus, got ${fnsChecked}`);
  assert.deepEqual(violations, []);
});

// JVM leg of the grammar-sync invariant — direction (a) only, since no free Kotlin/Java parser exists
// to oracle direction (b): every fn the report enumerates from the real .kt/.java fixture projects
// must be guttable (an enumerated-but-ungutable fn is a permanent phantom row). Direction (b) for the
// JVM is carried by the unit tests in test/changes.test.mjs.
test('differential corpus (jvm, direction a): every enumerated Kotlin/Java fixture decl is guttable', () => {
  const files = [];
  const walkDir = (d) => {
    let entries; try { entries = readdirSync(join(ROOT, d), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walkDir(join(d, e.name));
      else if (/\.(kt|java)$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  walkDir('test/fixtures');
  assert.ok(files.length >= 8, `expected the JVM fixture corpus, got ${files.length} files`);
  const violations = [];
  let checked = 0;
  for (const rel of files.sort()) {
    const code = readFileSync(join(ROOT, rel), 'utf8');
    const lang = rel.endsWith('.kt') ? 'kotlin' : 'java';
    const decls = declaredFns(code, lang);
    const counts = new Map();
    for (const d of decls) counts.set(d.fn, (counts.get(d.fn) || 0) + 1);
    for (const d of decls) {
      if (counts.get(d.fn) !== 1) continue; // overloads/collisions are the probe's own refusal territory
      if (grossBreak(code, d.fn, lang) === null) violations.push(`${rel} decl(${d.fn}) enumerated but not guttable`);
      else checked++;
    }
  }
  console.log(`# jvm sync corpus: ${files.length} files, ${checked} decls verified guttable`);
  assert.deepEqual(violations, []);
});
