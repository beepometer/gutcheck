// mutation/probe.mjs — the minimal-decisive-probe: confirm a hollow/shadow test oracle by EXECUTION.
//
// A hollow test (a tautological / shadow oracle whose expected value re-runs or re-derives the code it
// tests) is, by definition, one that SURVIVES a non-equivalent change to the code under test. This is
// extreme mutation testing / "pseudo-tested method" detection (Niedermayr/Juergens/Wagner 2016;
// Descartes/Vera-Pérez/Monperrus/Baudry 2018), scoped to ONE function feeding ONE flagged assertion:
// gut that function with a gross, guaranteed-non-equivalent return and run ONLY the one test. If a
// deliberately-broken SUT does not break the test, the oracle is HOLLOW.
//
// Pairs with the cheap static shadowOracleGuard, which is a high-recall CANDIDATE generator (it over-
// flags — fixture-builders, formatters, equivalence tests). The probe is the precision gate: it clears
// those false positives (a broken SUT makes a real test fail) and confirms the genuinely hollow ones.
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeOnly } from '../checker/lexer.mjs';

// A mutation can induce an infinite loop (e.g. gutting a loop's termination condition), which without a
// bound would hang the probe — and any CI / agent loop calling it — forever. Cap each test run; override
// with GUTCHECK_PROBE_TIMEOUT_MS (SKEPTIC_PROBE_TIMEOUT_MS still works as a fallback). A run that exceeds
// it is treated as "not green" (the mutant is caught, or the unmutated test is too slow to probe →
// INCONCLUSIVE at the baseline).
const PROBE_TIMEOUT_MS = Number(process.env.GUTCHECK_PROBE_TIMEOUT_MS || process.env.SKEPTIC_PROBE_TIMEOUT_MS) || 60000;

// Locate a named function's BODY and return a replacement descriptor, or null if it can't be located/
// parsed (so the caller reports INCONCLUSIVE, never a wrong verdict). Handles `function NAME(` incl.
// generators (`function* NAME` / `async function* NAME`), `def NAME(`, `NAME = function` / `NAME: function`
// (a `=` binding or a `:` object property), parenthesised and bare single-param arrows (`NAME = x =>`),
// block- and expression-bodied. All structural scanning is on a string/comment MASK (codeOnly blanks them
// to spaces, positions preserved) so braces/parens/`=>` inside string literals or comments can't fool it,
// and the parameter list is paren-balanced before the body is located so a default-param arrow
// (`(x = () => 5) => …`) can't be mistaken for the body.
//
// The descriptor is `{ site, start, end, firstParam, originalInner, make(value) }`: replacing
// `code.slice(start, end)` with `make(value)` rewrites the body to `return <value>`. grossBreak feeds a
// fixed non-equivalent sentinel; passthroughBreak feeds the first parameter. firstParam is the first
// SIMPLE parameter name (null for none/destructured/rest), originalInner is the body text being replaced.
function locateBody(code, fn, lang) {
  const L = (lang === 'python' || lang === 'kotlin' || lang === 'java') ? lang : 'typescript';
  const e = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const G = '(?:<[^>()]*>\\s*)?'; // optional TS generic params on the name: `f<T>(`
  const sig = new RegExp(
    `function\\b\\s*\\*?\\s*${e}\\s*${G}\\(`             // fn decl, incl. generator `function*` / `async function*`
    + `|\\bdef\\s+${e}\\s*\\(`
    + `|\\b${e}\\s*[:=]\\s*(?:async\\s*)?function\\b`    // fn-expr value of a `=` binding OR a `:` object property
    + `|\\b${e}\\s*=\\s*(?:async\\s*)?${G}\\(`
    + `|\\b${e}\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`,
  );
  const m = sig.exec(code);
  if (!m) return null;
  const mask = codeOnly(code, L); // strings + comments → spaces, length/positions preserved
  const isDef = /\bdef\s/.test(m[0]);

  if (m[0].endsWith('=>')) { // bare single-param arrow: the param is the identifier before `=>`
    const pm = /([A-Za-z_$][\w$]*)\s*=>\s*$/.exec(m[0]);
    return arrowSite(code, mask, m.index + m[0].length, pm ? pm[1] : null);
  }

  // locate + paren-balance the parameter list on the mask
  let p;
  if (m[0].endsWith('(')) p = m.index + m[0].length - 1;
  else { p = mask.indexOf('(', m.index + m[0].length); if (p < 0) return null; }
  let depth = 0, i = p;
  for (; i < code.length; i++) { const c = mask[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) { i++; break; } } }
  if (depth !== 0) return null;
  const firstParam = firstSimpleParam(code.slice(p + 1, i - 1));

  if (isDef) { // Python: replace the indented block after the def's terminating colon
    const colon = mask.indexOf(':', i);
    if (colon < 0) return null;
    let nl = code.indexOf('\n', colon);
    if (nl < 0) nl = code.length;
    const defLineStart = code.lastIndexOf('\n', m.index) + 1;
    const defIndent = m.index - defLineStart;
    let consumed = 0;
    for (const ln of code.slice(nl + 1).split('\n')) {
      if (ln.trim() !== '') { const ind = ln.length - ln.trimStart().length; if (ind <= defIndent) break; }
      consumed += ln.length + 1;
    }
    const start = nl + 1, end = nl + 1 + consumed;
    return { site: 'python', start, end, firstParam, originalInner: code.slice(start, end),
      make: (v) => ' '.repeat(defIndent + 4) + 'return ' + v + '\n' };
  }

  // JS/TS: the body is the first block '{' (or '=>') AFTER any `: ReturnType` annotation. A return type
  // can itself contain object types (`): { id: string } {`), so a naive next-'{' guts the TYPE, not the
  // body, and a real test then passes against an untouched body — a false HOLLOW. findBodyBrace skips it.
  const braceAt = findBodyBrace(code, mask, i);
  const arrowAt = mask.indexOf('=>', i);
  if (arrowAt >= 0 && (braceAt < 0 || arrowAt < braceAt)) return arrowSite(code, mask, arrowAt + 2, firstParam);
  if (braceAt < 0) return null;
  return blockSite(code, mask, braceAt, firstParam);
}

// Replace a named function's body with a gross, guaranteed-non-equivalent return (sidesteps the
// equivalent-mutant problem) — a surviving value-pinned test then proves the oracle hollow. null if the
// function can't be located.
export function grossBreak(code, fn, lang) {
  const loc = locateBody(code, fn, lang);
  if (!loc) return null;
  return code.slice(0, loc.start) + loc.make('987654321') + code.slice(loc.end);
}

// Depth probe (opt-in): replace the body with `return <firstParam>` — an identity stub. A value-pinned
// test that the gross stub BREAKS but this stub does NOT only exercised a FIXED POINT of the function
// (an input the transform leaves unchanged), not the transform itself. null when there is no usable first
// parameter, when the function is ALREADY a literal identity (nothing to expose), or when the stub equals
// the source. Unlike grossBreak, an identity stub can be equivalent to a genuine identity function, so a
// survivor is an ADVISORY, never a hard HOLLOW (see prove()).
export function passthroughBreak(code, fn, lang) {
  const loc = locateBody(code, fn, lang);
  if (!loc || !loc.firstParam) return null;
  if (isIdentityInner(loc.originalInner, loc.firstParam, loc.site)) return null;
  const out = code.slice(0, loc.start) + loc.make(loc.firstParam) + code.slice(loc.end);
  return out === code ? null : out;
}

// First SIMPLE parameter name from a parameter-list source, or null. Strips a default value (`= …`) and a
// type annotation (`: T`); a destructured (`{a}`/`[a]`) or rest (`...a`) first param yields null so the
// identity stub fails safe rather than emit a wrong body.
function firstSimpleParam(text) {
  let depth = 0, end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { end = i; break; }
  }
  const p = text.slice(0, end).split('=')[0].split(':')[0].trim();
  return /^[A-Za-z_$][\w$]*$/.test(p) ? p : null;
}

// Does the body being replaced already just `return <firstParam>` (an identity)? Then passthrough is a
// no-op and there is no test weakness to expose.
function isIdentityInner(inner, p0, site) {
  const s = inner.replace(/\s+/g, '');
  if (site === 'arrowExpr') return s === p0;
  return s.replace(/;+$/, '') === 'return' + p0;
}

// From `fromIdx` (just past the param list `)`), return the index of the function BODY '{', skipping a
// `: ReturnType` annotation whose type may be an object literal `{...}`. Decides type-vs-body by content:
// a return-type object reads as `{ ident: ... }` / `{ readonly ... }` / `{ [k]: ... }` / `{ (): ... }`,
// a body reads as statements. Returns -1 at a top-level `=>` or `;` (arrow / no block) so the caller's
// arrow path takes over. Fails safe: an unrecognised shape returns -1 (→ null → INCONCLUSIVE), never a
// wrong location.
function findBodyBrace(code, mask, fromIdx) {
  let p = fromIdx, sawColon = false;
  while (p < code.length) {
    const c = mask[p];
    if (c === ':') sawColon = true;
    if (c === '{') {
      if (sawColon) {
        let d = 0, k = p;
        for (; k < code.length; k++) { const ch = mask[k]; if (ch === '{') d++; else if (ch === '}') { d--; if (!d) { k++; break; } } }
        const inside = code.slice(p + 1, k - 1);
        if (/^\s*(?:[A-Za-z_$][\w$]*\s*\??\s*:|readonly\b|\[|\(|\}|\s*$)/.test(inside)) { p = k; sawColon = false; continue; }
      }
      return p; // body brace
    }
    if (c === '=' && mask[p + 1] === '>') return -1; // arrow body — caller handles via arrowSite
    if (c === ';') return -1;
    p++;
  }
  return -1;
}

function blockSite(code, mask, openBrace, firstParam) {
  let depth = 0, k = openBrace;
  for (; k < code.length; k++) { const c = mask[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) break; } }
  if (depth !== 0) return null;
  const start = openBrace + 1, end = k;
  return { site: 'block', start, end, firstParam, originalInner: code.slice(start, end),
    make: (v) => ' return ' + v + '; ' };
}

function arrowSite(code, mask, fromAfterArrow, firstParam) {
  let j = fromAfterArrow;
  while (j < code.length && /\s/.test(code[j])) j++;
  if (mask[j] === '{') return blockSite(code, mask, j, firstParam); // block-bodied arrow
  let end = j, depth = 0; // expression arrow: replace to the end of the expression (top-level boundary)
  for (; end < code.length; end++) {
    const c = mask[end];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ';' || c === ',' || c === '\n')) break;
  }
  return { site: 'arrowExpr', start: j, end, firstParam, originalInner: code.slice(j, end), make: (v) => v };
}

function runsGreen(dir, testCmd) {
  // Strip NODE_TEST_CONTEXT so a child `node --test` does not detect a parent test runner and self-skip
  // (which would exit 0 and be misread as "passed") — same defense as mutation/run.mjs.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try { execSync(testCmd, { cwd: dir, stdio: 'ignore', env, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }); return true; } catch { return false; }
}

// probe(projectDir, candidate) → { verdict, why }
//   verdict: 'HOLLOW'  — broken SUT, test still passes → the oracle proves nothing (confirmed shadow)
//            'SOUND'   — broken SUT, test fails → a real, discriminating test (a static FP, cleared)
//            'INCONCLUSIVE' — couldn't baseline-pass, find the SUT fn, or run (no verdict)
// candidate: { testFile, sutFile, sutFn, testCmd }  (paths relative to projectDir; testCmd runs that one test)
export function probe(projectDir, { testFile, sutFile, sutFn, testCmd }) {
  const cmd = testCmd || `node --test ${testFile}`;
  const tmp = mkdtempSync(join(tmpdir(), 'gutcheck-probe-'));
  try {
    // Copy the tree WITHOUT node_modules/.git (copying a full install per run stalls CI on real repos),
    // then symlink node_modules so deps still resolve. The probe only rewrites the one SUT file.
    cpSync(projectDir, tmp, { recursive: true, filter: (src) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(src) });
    const nm = join(projectDir, 'node_modules');
    if (existsSync(nm)) { try { symlinkSync(nm, join(tmp, 'node_modules'), 'dir'); } catch { /* deps unavailable → test may go INCONCLUSIVE, never crash */ } }
    const sutPath = join(tmp, sutFile);
    if (!existsSync(sutPath)) return { verdict: 'INCONCLUSIVE', why: `SUT file not found: ${sutFile}` };
    if (!runsGreen(tmp, cmd)) return { verdict: 'INCONCLUSIVE', why: 'the test does not pass unmutated (env/deps?)' };
    const lang = sutFile.endsWith('.py') ? 'python' : 'typescript';
    const broken = grossBreak(readFileSync(sutPath, 'utf8'), sutFn, lang);
    if (broken === null) return { verdict: 'INCONCLUSIVE', why: `could not locate/parse function: ${sutFn} in ${sutFile}` };
    writeFileSync(sutPath, broken);
    return runsGreen(tmp, cmd)
      ? { verdict: 'HOLLOW', why: `test still passes after gutting ${sutFn}() — the oracle does not check it` }
      : { verdict: 'SOUND', why: `test fails when ${sutFn}() is gutted — a real, discriminating oracle` };
  } catch (err) {
    return { verdict: 'INCONCLUSIVE', why: String(err && err.message) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// CLI: gutcheck probe <testFile> <sutFile> <sutFn> [testCmd...]   (paths relative to cwd)
// Exit 1 = HOLLOW (a problem, for CI), 2 = INCONCLUSIVE/usage, 0 = SOUND.
if (process.argv[1] && process.argv[1].endsWith('probe.mjs')) {
  const [testFile, sutFile, sutFn, ...rest] = process.argv.slice(2);
  if (!testFile || !sutFile || !sutFn) {
    process.stderr.write('usage: node mutation/probe.mjs <testFile> <sutFile> <sutFn> [testCmd...]\n'
      + '  Confirms by execution whether <testFile> is a hollow oracle: guts <sutFn> in <sutFile>,\n'
      + '  runs only <testFile> — still green => HOLLOW, fails => SOUND.\n');
    process.exit(2);
  }
  const { verdict, why } = probe(process.cwd(), { testFile, sutFile, sutFn, testCmd: rest.join(' ') || undefined });
  process.stdout.write(`${verdict}: ${why}\n`);
  process.exit(verdict === 'HOLLOW' ? 1 : verdict === 'SOUND' ? 0 : 2);
}
