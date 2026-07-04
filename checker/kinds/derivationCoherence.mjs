// KIND derivationCoherence — a deterministic test-CORRECTNESS check (not a presence lint). When a numeric
// assertion carries an INLINE arithmetic derivation comment (`assertEquals(80.0, area(5)) // 3.14159*5*5 =
// 78.54`), it EVALUATES the arithmetic and flags a mismatch between what the derivation computes and what
// the assertion expects — an internal contradiction that is almost always a real bug (a transcription
// error, a stale derivation, a copy-paste). Pure, deterministic: a safe recursive-descent evaluator, no
// eval(), no network. High-precision by design: only SAME-LINE inline derivations (a comment on the line
// above may describe a different quantity), fully-numeric expressions only (a variable → skip, no FP),
// and a tolerance keyed to the asserted value's displayed precision (so rounding is not a mismatch).
import { join } from 'node:path';
import { stripComments, joinLogicalLines, GRAMMARS } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

const CONSTS = { pi: Math.PI, e: Math.E };

// Safe arithmetic evaluator. Supports + - * / % ^ (** normalized), parens, unary minus, scientific
// notation, and the constants pi/e. Throws on a variable or anything unparseable → caller skips (no FP).
export function evalExpr(input) {
  const s = input.replace(/\*\*/g, '^');
  let i = 0;
  const peek = () => s[i];
  const skip = () => { while (/\s/.test(s[i])) i++; };
  function atom() {
    skip();
    if (peek() === '(') { i++; const v = expr(); skip(); if (peek() === ')') i++; else throw new Error('paren'); return v; }
    if (peek() === '-') { i++; return -atom(); }
    if (peek() === '√') { i++; return Math.sqrt(atom()); } // √ (common in scientific derivations)
    const word = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (word) {
      if (word[0] === 'sqrt') { i += 4; return Math.sqrt(atom()); }
      if (CONSTS[word[0]] !== undefined) { i += word[0].length; return CONSTS[word[0]]; }
      throw new Error('var');
    }
    const num = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!num) throw new Error('num'); i += num[0].length; return parseFloat(num[0]);
  }
  function power() { let b = atom(); skip(); while (peek() === '^') { i++; b = Math.pow(b, atom()); skip(); } return b; }
  function term() { let v = power(); skip(); while (peek() === '*' || peek() === '/' || peek() === '%') { const op = s[i++]; const r = power(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; skip(); } return v; }
  function expr() { let v = term(); skip(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; skip(); } return v; }
  const v = expr(); skip();
  if (i < s.length || !isFinite(v)) throw new Error('trailing');
  return v;
}

const decimals = (n) => { const m = /\.(\d+)/.exec(String(n)); return m ? m[1].length : 0; };

export function detect(text, env) {
  const lang = env.lang || 'typescript';
  const lineMarks = (GRAMMARS[lang] && GRAMMARS[lang].line) || ['//'];
  // logical lines (multi-line asserts), strings blanked (a number in a string isn't the value), comments kept.
  const lines = joinLogicalLines(stripComments(text, lang, { blankStrings: true, keepComments: true })).split('\n');
  const assertionSrcs = (env.assertionSrcs || []).map((s) => new RegExp(s));
  const offenders = [];
  lines.forEach((line, i) => {
    // split the line at its first line-comment marker → [code, inline comment]
    let cut = -1; let mark = '';
    for (const m of lineMarks) { const at = line.indexOf(m); if (at >= 0 && (cut < 0 || at < cut)) { cut = at; mark = m; } }
    if (cut < 0) return; // no inline comment → nothing to cross-check
    const code = line.slice(0, cut);
    const comment = line.slice(cut + mark.length);
    if (!/[+\-*/^%]/.test(comment) || !/\d/.test(comment)) return; // no arithmetic in the comment
    // qualified derivation: the assertion legitimately differs from the raw arithmetic (capped/rounded/…)
    if (/\b(?:cap|capp|clamp|round|floor|ceil|trunc|approx|limit|nearest|roughly|min|max)\w*\b/i.test(comment)) return;
    // the asserted numeric value from the code side
    let expected = null;
    for (const re of assertionSrcs) { const m = re.exec(code); if (m && m[1] != null) { expected = parseFloat(m[1]); break; } }
    if (expected === null || !isFinite(expected)) return;
    // The arithmetic region: the part before `= <number>` (a stated result), with a leading "Label:"
    // (e.g. CLOSED-FORM-ORACLE:) stripped; else the whole comment. Normalize Unicode math operators.
    const region = (/([^=≈]*?)\s*[=≈]{1,3}\s*-?[\d.]/.exec(comment) || [, comment])[1];
    const expr = region.replace(/^.*:\s*/, '')
      .replace(/[·×]/g, '*').replace(/÷/g, '/').replace(/²/g, '^2').replace(/³/g, '^3');
    if (!/[+\-*/^%√]/.test(expr) || !/\d/.test(expr)) return; // not an arithmetic derivation
    if (/^\s*\d+\s*-\s*\d+\s*$/.test(expr)) return; // a bare `int-int` is almost always a RANGE, not subtraction
    // PURE-numeric guard: strip numbers (incl 1e-9), known consts/fns (pi/e/sqrt), operators/parens/√/ws.
    // ANY residue means a variable/unknown token (`rate`, `len`) → skip, never a false positive.
    const residue = expr
      .replace(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, ' ')
      .replace(/\b(?:sqrt|pi|e)\b/g, ' ')
      .replace(/[-+*/^%()√\s]/g, '');
    if (residue) return;
    let computed; try { computed = evalExpr(expr); } catch { return; } // unparseable → skip (no FP)
    const tol = Math.max(Math.abs(expected) * 1e-3, 0.5 * 10 ** -decimals(expected));
    // accept a ratio↔percentage scale (the comment shows `130/200`, the assertion is the percentage 65) —
    // a ×100/÷100 relationship is almost always a unit/percentage convention, not a bug. The DIRECT
    // comparison stays tight (tol); only the scale-shifted compares get the looser percentage tolerance.
    const near = (a, t) => Math.abs(a - expected) <= t;
    const pctTol = Math.max(Math.abs(expected) * 1e-2, tol);
    if (!(near(computed, tol) || near(computed * 100, pctTol) || near(computed / 100, pctTol))) offenders.push({ line: i + 1, token: 'derivation-mismatch' });
  });
  return offenders;
}

export function corpus(spec, config, ctx) {
  const ext = config.language.fileExt;
  const roots = (ctx.testSrcRoots && ctx.testSrcRoots.length)
    ? ctx.testSrcRoots
    : (config.paths.srcRoots.test || []).map((r) => join(ctx.repoRoot, r));
  const exclude = (spec.params && spec.params.excludePathSubstrings) || [];
  return roots.flatMap((r) => walkFiles(r, ext)).filter((f) => !exclude.some((sub) => f.replace(/\\/g, '/').includes(sub)));
}

const envFor = (spec) => ({ lang: (spec.params && spec.params.lang) || 'typescript', assertionSrcs: (spec.params && spec.params.assertionSrcs) || [] });
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
