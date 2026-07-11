// KIND selfComparisonOracle — a deterministic test-CORRECTNESS check. Flags an assertion whose ACTUAL
// and EXPECTED sides are both calls with TEXTUALLY IDENTICAL call expressions (same fn, same args,
// whitespace-normalized) — a "compares a function to itself" oracle. Real-repo finding (dedupSlug,
// IntegrityLandingPage): a "preserves determinism across multiple calls" test asserting
// `expect(dedupSlug(email)).toBe(dedupSlug(email))` — trivially true for ANY function that returns the
// same thing on repeat calls with the same input, INCLUDING a broken/gutted one; it pins nothing about
// the VALUE. Caught inline (`expect(f(x)).toBe(f(x))`) and via variables (`const a = f(x); const b =
// f(x); expect(a).toBe(b);`). High-precision by design: DIFFERENT args (even a case-normalization
// sibling `f('User@X')` vs `f('user@x')`) are textually different call expressions and NOT flagged;
// DIFFERENT functions are not flagged; a call compared to a LITERAL is a real pin, not a self-comparison,
// and is not flagged (the assertionSrcs regex requires BOTH operands to look like a call-or-identifier,
// so a literal on either side simply fails to match — a safe, conservative non-match, not a special case).
//
// CYCLE-10 measured: high base rate, ~zero defect yield — NOT promoted; the mutation probe (mutation/)
// owns the harmful subset this shape would otherwise flag as noise. Pulled from the adopter-facing
// floor (configure/gutcheck.default.json / configure/checksets/python.mjs no longer register it); the
// kind module stays here, reachable only via an explicit checker config — never through `gutcheck lint`.
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

// A call expression: identifier (dotted access allowed), FLAT parens — no nested call in the args. This
// keeps the regex simple and precise; a nested-call arg is a rarer shape and is just not matched (a safe
// false-negative, never a false positive). DELIBERATE EXCLUSION this guarantees: an idempotence property
// test (`expect(f(f(x))).toBe(f(x))`) is a legitimate f∘f = f pin and must NEVER flag — if nested-call
// support is ever added, the two sides are still DIFFERENT call texts and must still compare unequal
// (pinned by a kind test + a must-not-flag fixture).
const CALL = '[A-Za-z_$][\\w$.]*\\([^()]*\\)';
const RE_CALL = new RegExp(`^${CALL}$`);
const isCall = (s) => RE_CALL.test(s.trim());
// Whitespace-normalize a call text: collapse runs, strip paren-adjacent spaces so `f( x )` ≡ `f(x)`.
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

// JS/TS: `const|let|var NAME = CALL(...)`. Python config supplies a bare `NAME = CALL(...)` form instead
// (no declaration keyword) — this is the "architecture splits by language" seam.
const DEFAULT_VAR_ASSIGNS = [
  `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(${CALL})`,
];

// Test-block boundary (same default as assertionConsistency): variable bindings are block-scoped in
// real test code, so the binding map RESETS here — a declaration in one test block never resolves an
// operand in another, in either direction.
const DEFAULT_BOUNDARY = '\\b(?:it|test|describe|context|beforeEach|afterEach)\\s*\\(|\\bTEST(?:_[FP])?\\s*\\(|\\b(?:SECTION|SCENARIO)\\s*\\(|^\\s*(?:async\\s+)?def\\s+test|^\\s*func\\s+Test|^\\s*#\\[test\\]|@Test\\b';

export function detect(text, env) {
  const lang = env.lang || 'typescript';
  // Deliberately NOT blankStrings here — unlike fallbackCollapse/magicLiteralGuard/derivationCoherence,
  // a call's STRING ARGUMENTS are semantic to this kind's identity comparison: `f('User@X')` vs
  // `f('user@x')` must stay textually distinguishable, or a case-normalization sibling pair would
  // collapse into a false self-comparison match. This is the asymmetry with fallbackCollapse, where
  // string contents are never part of the compared shape.
  const lines = joinLogicalLines(stripComments(text, lang)).split('\n');
  const srcs = (env.assertionSrcs || []).map((s) => new RegExp(s));
  const varAssigns = (env.varAssignSrcs || DEFAULT_VAR_ASSIGNS).map((s) => new RegExp(s));
  const boundary = new RegExp(env.testBoundarySrc || DEFAULT_BOUNDARY);

  // varName -> normalized call text. ONE pass in line order, so only a PRECEDING declaration can bind an
  // operand (a later same-named declaration never rewrites what an earlier assertion resolved against),
  // and the map resets at each test-block boundary (bindings are block-scoped — no cross-block leaks).
  const varCall = new Map();
  // Resolve an operand to its "call identity" text: itself if it IS a call, else the call text of the
  // variable it was assigned from (if any), else null (not a call — never flagged).
  const resolve = (raw) => {
    const t = norm(raw);
    if (isCall(t)) return t;
    if (/^[A-Za-z_$][\w$]*$/.test(t) && varCall.has(t)) return varCall.get(t);
    return null;
  };

  const offenders = [];
  lines.forEach((line, i) => {
    if (boundary.test(line)) varCall.clear();
    // assignments FIRST: `const c = f(x); expect(c).toBe(f(x))` on one line is a genuine self-comparison.
    for (const re of varAssigns) {
      const m = re.exec(line);
      if (m && m[1] && m[2] && isCall(m[2])) varCall.set(m[1], norm(m[2]));
    }
    for (const re of srcs) {
      const m = re.exec(line);
      if (!m || m[1] == null || m[2] == null) continue;
      const a = resolve(m[1]);
      const b = resolve(m[2]);
      if (a && b && a === b) { offenders.push({ line: i + 1, token: 'self-comparison-oracle' }); break; }
    }
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

const envFor = (spec) => ({
  lang: (spec.params && spec.params.lang) || 'typescript',
  assertionSrcs: (spec.params && spec.params.assertionSrcs) || [],
  varAssignSrcs: (spec.params && spec.params.varAssignSrcs) || DEFAULT_VAR_ASSIGNS,
  testBoundarySrc: (spec.params && spec.params.testBoundarySrc) || undefined,
});
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
