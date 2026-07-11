// KIND fallbackCollapse — a deterministic test-CORRECTNESS check. Flags a compare-to-EMPTY assertion
// (`toEqual([])` / `toEqual({})` / `assert.deepEqual(..., [])` / `assert.deepStrictEqual(..., {})`)
// whose ACTUAL expression contains a `|| []` / `|| {}` / `?? []` / `?? {}` fallback UPSTREAM of the
// matcher, in the SAME statement. Real war story (this repo): `assert.deepEqual((res.offenders ||
// []).map(o => o.check), [])` — if `res.offenders` is ever absent/undefined, the fallback silently
// launders it into `[]`, `.map` runs over nothing, and the assertion compares `[]` to `[]`: the test
// passes whether or not offenders were EVER produced. The fallback makes "no data" and "empty result"
// indistinguishable, and the expected side being empty means there is no other signal that would catch
// it either. High-precision by design: a fallback compared to a NON-empty expected is a real pin (not
// flagged); a fallback that lives in a SETUP line, separate from the asserted expression, is not flagged
// (the fallback and the compare-to-empty matcher must appear in the SAME statement).
// `toHaveLength(0)` is deliberately OUT of scope: a length-0 pin after a fallback is the same collapse
// shape but a separate matcher family — left for a future cycle if corpus measurement warrants it.
//
// CALL-DERIVED restriction (corpus-audit hardening): a fallback
// over a STATIC field read (`packageJson.dependencies ?? {}` off a checked-in package.json) is not a
// "producer went silent" bug — key-absence there is a legitimate authoring convention, not a defect
// signature, and the corpus's only 2 FPs were exactly this shape. So this check now flags ONLY when the
// asserted actual is CALL-DERIVED, via any of: (a) the fallback's own left operand contains a call
// (`g.edges.get("postgres") ?? []`); (b) the fallback expression (inside the asserted actual, before the
// outer matcher) is itself chained into a call/method (`(doc.diagnostics ?? []).filter(...)`); (c) the
// operand's base variable resolves — via nearest-preceding same-block assignment, one property-access
// hop of indirection allowed (`klass = skill.constructor`, `skill = createSkill()`) — to a call. Rule
// (c) is checked against EVERY bare identifier referenced in the actual expression, not just the
// fallback's own operand, so a ternary-guarded fallback whose CONDITION is call-derived also counts
// (`isValid ? [] : (validator.errors ?? [])`, where `isValid = validator(fixture)`). A bare `import(...)`/
// `require(...)` — module/static-asset loading, not a computed producer result — is deliberately NOT
// treated as a qualifying call; this is the exact distinction between the audit's 16 TRUE fallback-
// collapse findings (all trace to a real runtime producer) and its 2 FPs (`await import("../package.json",
// ...)`, a static config read).
//
// PROMOTED to mutation/gutcheck.mjs's LINT_KINDS via CYCLE-10 corpus measurement (16 TRUE / 0 FP post-tightening).
// Reachable via checker config and now user-facing through `gutcheck lint`.
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

const FALLBACK = /(?:\|\||\?\?)\s*(?:\[\]|\{\})/;
const EMPTY = /^(?:\[\]|\{\})$/;
// An identifier immediately followed by `(` — a call/method invocation — EXCLUDING bare `import`/
// `require` (module/static-file loads, not a computed producer result; see file header).
const CALL_TOKEN = /\b(?!import\b|require\b)[A-Za-z_$][\w$]*\s*\(/;
// A fallback group, parenthesized, immediately chained into a call/method — `(x ?? []).filter(...)`.
const CHAINED_AFTER_FALLBACK = /\([^()]*(?:\|\||\?\?)\s*(?:\[\]|\{\})\)\s*\.[A-Za-z_$][\w$]*\s*\(/;
// Block-scoped variable bindings reset at a test-block boundary — same idiom selfComparisonOracle uses.
const TEST_BOUNDARY = /\b(?:it|test|describe|context|beforeEach|afterEach)\s*\(|\bTEST(?:_[FP])?\s*\(|\b(?:SECTION|SCENARIO)\s*\(|^\s*(?:async\s+)?def\s+test|^\s*func\s+Test|^\s*#\[test\]|@Test\b/;
// `const|let|var NAME = RHS` (RHS runs to end of line/statement; a trailing `;` is optional since a
// multi-line call-arg statement can leave a line unterminated after joinLogicalLines).
const ASSIGN = /(?:^|[;{])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+?);?\s*$/;

const DEFAULT_CHAIN_MATCHERS = ['toEqual', 'toStrictEqual', 'toContainEqual'];
const DEFAULT_ASSERT_MATCHERS = ['deepEqual', 'deepStrictEqual'];

// Balanced-bracket arg extraction (parens/brackets/braces share one depth counter — the same
// simplification the shadowOracleGuard/weakOracleGuard kinds use: real code never interleaves them
// unbalanced). Returns { text, end } where `end` is the index right after the matched close.
function balancedArg(s, from) {
  let k = from; let d = 1;
  for (; k < s.length && d; k++) {
    const c = s[k];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
  }
  return { text: s.slice(from, k - 1), end: k };
}

// Top-level comma split inside a call's arg list (same shared-depth counter).
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

// `expect(ACTUAL).matcher(EXPECTED)` — matcher is one of env.chainMatchers.
function checkChain(line, matchers) {
  const mm = /\bexpect\s*\(/.exec(line);
  if (!mm) return null;
  const openIdx = mm.index + mm[0].length;
  const { text: actual, end } = balancedArg(line, openIdx);
  const after = line.slice(end);
  const mb = new RegExp(`^\\s*\\.(?:${matchers.join('|')})\\s*\\(`).exec(after);
  if (!mb) return null;
  const { text: expected } = balancedArg(line, end + mb[0].length);
  return { actual, expected };
}

// `assert.matcher(ACTUAL, EXPECTED[, message])` — node:assert dialect, matcher is one of env.assertMatchers.
function checkAssertArgs(line, matchers) {
  const mm = new RegExp(`\\bassert\\.(?:${matchers.join('|')})\\s*\\(`).exec(line);
  if (!mm) return null;
  const args = topLevelArgs(line, mm.index + mm[0].length);
  if (args.length < 2) return null;
  return { actual: args[0], expected: args[1] };
}

// Every bare (non-property-access) identifier referenced in `actual` — the operands rule (c) resolves.
// `x.y` contributes `x`, not `y`; `x` alone (followed by `(`, `.`, or nothing) contributes `x`.
function referencedIdents(actual) {
  const out = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(actual)) !== null) {
    let p = m.index - 1;
    while (p >= 0 && /\s/.test(actual[p])) p--;
    if (p >= 0 && actual[p] === '.') continue; // property name, not a variable reference
    out.add(m[0]);
  }
  return out;
}

// Is the fallback's ACTUAL expression call-derived, per the three rules in the file header?
function isCallDerived(actual, callDerivedVars) {
  const m = FALLBACK.exec(actual);
  if (m && CALL_TOKEN.test(actual.slice(0, m.index))) return true; // (a) direct call in the left operand
  if (CHAINED_AFTER_FALLBACK.test(actual)) return true; // (b) chained onto the parenthesized fallback
  for (const id of referencedIdents(actual)) if (callDerivedVars.get(id) === true) return true; // (c)
  return false;
}

export function detect(text, env) {
  const lang = env.lang || 'typescript';
  // blankStrings: a quoted/templated fixture string that merely CONTAINS this shape as text (e.g. a
  // kind-test's own `"assert.deepEqual((x || []).map(...), [])"` specimen) is not live code and must
  // not be treated as an asserted actual/expected — only unquoted, real assertions qualify.
  const lines = joinLogicalLines(stripComments(text, lang, { blankStrings: true })).split('\n');
  const chainMatchers = env.chainMatchers || DEFAULT_CHAIN_MATCHERS;
  const assertMatchers = env.assertMatchers || DEFAULT_ASSERT_MATCHERS;
  const offenders = [];
  // varName -> true (call-derived) | false (assigned, but not call-derived) — built incrementally as we
  // scan forward, so only a PRECEDING assignment can resolve a later line's operand; resets at each
  // test-block boundary (bindings are block-scoped, same idiom selfComparisonOracle uses).
  const callDerivedVars = new Map();
  lines.forEach((line, i) => {
    if (TEST_BOUNDARY.test(line)) callDerivedVars.clear();
    const am = ASSIGN.exec(line);
    if (am) {
      const [, name, rhs] = am;
      const lead = /^([A-Za-z_$][\w$]*)/.exec(rhs.trim());
      const indirect = !CALL_TOKEN.test(rhs) && lead && callDerivedVars.get(lead[1]) === true;
      callDerivedVars.set(name, CALL_TOKEN.test(rhs) || !!indirect);
    }
    const hits = [checkChain(line, chainMatchers), checkAssertArgs(line, assertMatchers)].filter(Boolean);
    for (const hit of hits) {
      if (FALLBACK.test(hit.actual) && EMPTY.test(hit.expected.trim()) && isCallDerived(hit.actual, callDerivedVars)) {
        offenders.push({ line: i + 1, token: 'fallback-collapse' });
        break;
      }
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
  chainMatchers: (spec.params && spec.params.chainMatchers) || DEFAULT_CHAIN_MATCHERS,
  assertMatchers: (spec.params && spec.params.assertMatchers) || DEFAULT_ASSERT_MATCHERS,
});
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
