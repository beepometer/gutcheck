// KIND derivationCoherence — a deterministic test-CORRECTNESS check (not a presence lint). When a numeric
// assertion carries an INLINE arithmetic derivation comment (`assertEquals(80.0, area(5)) // 3.14159*5*5 =
// 78.54`), it EVALUATES the arithmetic and flags a mismatch between what the derivation computes and what
// the assertion expects — an internal contradiction that is almost always a real bug (a transcription
// error, a stale derivation, a copy-paste). Pure, deterministic: a safe recursive-descent evaluator, no
// eval(), no network. High-precision by design: only SAME-LINE inline derivations (a comment on the line
// above may describe a different quantity), fully-numeric expressions only (a variable → skip, no FP),
// and a tolerance keyed to the asserted value's displayed precision (so rounding is not a mismatch).
//
// Corpus-audit hardening (a wild-corpus sweep found 0/9 TRUE, all four reproducible parser-mechanism
// bugs, none an evaluator bug):
// (A) CHAINED derivations — a comma-separated two-step comment (`-10 + 360 = 350, 350/10 = 35`) was
//     truncated at the FIRST `=`, evaluating only the first clause (350) against the assertion (35) —
//     a false mismatch on a comment that, read end-to-end, is fully coherent. Now every `expr = value`
//     clause in the comment is found and the LAST one (the clause that actually produces the checked
//     value) is used.
// (B) EXPRESSION assertion arguments — `.toBe(-200 - 100)` (an unparenthesized binary expression, not a
//     bare literal) had its "expected" mis-extracted as just the leading numeral (-200), discarding the
//     rest. Now the full argument is captured depth-aware (topLevelArgs) and evaluated if it is pure
//     arithmetic — `expected` becomes the real -300, not -200.
// (C) GROUPING ambiguity — a percentage-style comment written without an outer grouping paren
//     (`1-(900+150)/15000*100`, intending `(1-(900+150)/15000)*100`) evaluates differently under strict
//     PEMDAS (-6) than the author's intended grouping (93) — neither reading is "wrong," the comment is
//     just ambiguous. Now a comment mixing additive (+/-) and multiplicative (*, /, %, ^) operators at
//     the TOP level (outside any explicit inner parens) is skipped rather than resolved by guessing.
// (D) COUNT-vs-SUM — a `+`-joined list of components with NO stated `=` result (`# 3 + 4` documenting
//     which two priority values both count as "high priority," not their sum) was evaluated as if the
//     whole comment were a derivation, summing values the author meant only to enumerate. Now a comment
//     with no explicit `=`/`≈` anchor at all is never evaluated — an un-anchored descriptive list is not
//     a derivation to verify. (Conservative skip over a "count vs sum" heuristic: a real derivation that
//     happens to lack an `=` sign is no longer caught — a recall cost, not a precision one, accepted
//     deliberately over the alternative false-positive risk.)
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

// PURE-numeric guard, shared by both the comment-side derivation and (mechanism B) the code-side
// assertion argument: strip numbers (incl 1e-9), known consts/fns (pi/e/sqrt), operators/parens/√/ws.
// ANY residue means a variable/unknown token → the caller must skip (never a false positive).
function residueOf(expr) {
  return expr
    .replace(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, ' ')
    .replace(/\b(?:sqrt|pi|e)\b/g, ' ')
    .replace(/[-+*/^%()√\s]/g, '');
}

// (C) Does `expr` mix additive (+/-) and multiplicative (*, /, %, ^) operators at the TOP level (outside
// any explicit inner parens)? A leading/consecutive sign (unary minus) is not a binary operator and does
// not count. Mixed-and-unparenthesized is grouping-ambiguous — the caller skips rather than guesses.
function mixedTopLevelOperators(expr) {
  let depth = 0; let afterOperand = false; const classes = new Set();
  for (const c of expr) {
    if (c === '(') { depth++; afterOperand = false; continue; }
    if (c === ')') { depth--; afterOperand = true; continue; }
    if (/\s/.test(c)) continue;
    if (depth === 0 && /[+\-*/%^]/.test(c)) {
      if (afterOperand) classes.add(/[+\-]/.test(c) ? 'add' : 'mul'); // else: unary sign, not classified
      afterOperand = false;
      continue;
    }
    afterOperand = true;
  }
  return classes.size > 1;
}

// Balanced top-level comma split from a given start position, one shared depth counter across
// parens/brackets/braces (same simplification fallbackCollapse/shadowOracleGuard use) — (B) grabs the
// FULL expected-value argument at a matcher call, not just whatever a narrow literal-capture regex saw.
function topLevelArgs(s, from) {
  const out = []; let k = from; let d = 0; let start = from;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { if (!d) { out.push(s.slice(start, k)); return out; } d--; }
    else if (c === ',' && !d) { out.push(s.slice(start, k)); start = k + 1; }
  }
  out.push(s.slice(start));
  return out;
}

const isBareNumber = (s) => /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s.trim());

// (B) The code-side "expected" value. Every assertionSrcs regex in this codebase captures its ONE group
// as the tail of the whole match (by construction), so `m.index + m[0].length - m[1].length` is that
// group's START position — from there, topLevelArgs grabs the FULL argument text (handling both a bare
// `.toBe(80.0)` numeral and an unparenthesized expression `.toBe(-200 - 100)`, and correctly stopping
// before a trailing precision/message arg: `.toBeCloseTo(x, 2)`, `assert.strictEqual(a, b, 'msg')`).
// Falls back to the regex's own narrow capture if that invariant doesn't hold (a defensive guard for a
// custom assertionSrcs regex shaped differently).
function extractExpected(code, assertionSrcs) {
  for (const re of assertionSrcs) {
    const m = re.exec(code);
    if (!m || m[1] == null) continue;
    const start = m.index + m[0].length - m[1].length;
    const anchored = code.slice(start, start + m[1].length) === m[1];
    const args = anchored ? topLevelArgs(code, start) : null;
    const full = (args && args[0] != null ? args[0] : m[1]).trim();
    if (isBareNumber(full)) return parseFloat(full);
    if (!/[+\-*/^%]/.test(full) || residueOf(full)) return null; // not a pure-numeric expression
    try { return evalExpr(full); } catch { return null; }
  }
  return null;
}

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
    // the asserted numeric value from the code side (B: full expression args, not just a leading numeral)
    const expected = extractExpected(code, assertionSrcs);
    if (expected === null || !isFinite(expected)) return;
    // (A + D) Find EVERY `expr = value` clause in the comment (a comma-chained multi-step derivation
    // writes several) and use the LAST one — the clause that actually produces the checked value, not
    // whichever the first `=` sign happens to precede. If there is NO such clause at all — no explicit
    // `=`/`≈` anchor anywhere in the comment — this is an un-anchored descriptive list (D's count-vs-sum
    // trap: `# 3 + 4` enumerating two qualifying values, not summing them), not a derivation to verify:
    // skip rather than misread the whole comment as one.
    const CLAUSE = /([^=≈]*?)\s*[=≈]{1,3}\s*(-?[\d.]+)/g;
    let lastClause = null; let cm;
    while ((cm = CLAUSE.exec(comment)) !== null) lastClause = cm;
    if (!lastClause) return;
    // The arithmetic region: the LAST clause's left side, with a leading "Label:" (e.g.
    // CLOSED-FORM-ORACLE:) and any leading comma (from the chain split) stripped. Normalize Unicode ops.
    const region = lastClause[1].replace(/^[,\s]+/, '');
    const expr = region.replace(/^.*:\s*/, '')
      .replace(/[·×]/g, '*').replace(/÷/g, '/').replace(/²/g, '^2').replace(/³/g, '^3');
    if (!/[+\-*/^%√]/.test(expr) || !/\d/.test(expr)) return; // not an arithmetic derivation
    if (/^\s*\d+\s*-\s*\d+\s*$/.test(expr)) return; // a bare `int-int` is almost always a RANGE, not subtraction
    if (mixedTopLevelOperators(expr)) return; // (C) ambiguous grouping — don't guess which reading the author meant
    if (residueOf(expr)) return; // a variable/unknown token (`rate`, `len`) → skip, never a false positive
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
