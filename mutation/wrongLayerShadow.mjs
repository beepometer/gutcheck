// mutation/wrongLayerShadow.mjs — the wrong-layer-shadow detector: a test that re-implements production
// logic inline and asserts the result against a second copy of itself, with ZERO real production contact
// (the deleted LiveEqToggleTest shape: `if (index in current) current - index else current + index`,
// transcribed into the test body and asserted against an identical re-derivation — a production-line
// inversion could never fail it, and there is no real SUT call for the mutation probe to gut).
//
// Static, zero-run: pure text analysis, no resolver/filesystem access. prove.mjs computes the ZERO-CONTACT
// half of the conjunction (it already has the SUT resolvers + srcFiles) and pairs it with this module's
// SELF-ECHO half before attaching both to a blockRecord; changes.mjs's classifyChanges reads both signals
// off blockRecords and uses titleSutCandidates (below) — resolved via the SUT resolver — to decide
// whether a changed fn may be charged with it (title-only attribution; never an echo-token match).
//
// Fires HOLLOW only on the CONJUNCTION of (1) zero production contact [prove.mjs] and (2) a self-echo /
// tautological assertion [selfEchoAssertion, below] — the conjunction is airtight (see the design doc):
// condition 1's only escape (a reflection/DI test with no literal symbol) is closed by 2 (a self-comparison
// can't fail regardless of SUT behavior); condition 2's only misfire (a legitimate idempotence/property
// test, `assertEquals(f(x), f(f(x)))`) is closed by 1 (a real property test references the production
// symbol, so it never reaches zero-contact in the first place). Neither half alone is safe to flag on.
import { codeOnly, joinLogicalLines } from '../checker/lexer.mjs';

// ---- tiny duplicated utilities ----
// checker/kinds/shadowOracleGuard.mjs's balancedArg/topLevelArgs/operandsOf and selfComparisonOracle.mjs's
// norm are UNEXPORTED closures defined inside those kinds' own detect() functions (not module-level
// exports), so they can't be imported directly — and this task's file list keeps checker/kinds/ out of
// scope for editing. Duplicating these few lines here (identical logic) is safer than reaching into
// another kind's internals or widening this task's edit surface into checker/.
const balancedArg = (s, from) => { let k = from, d = 1; for (; k < s.length && d; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return s.slice(from, k - 1); };
const topLevelArgs = (s, from) => { const out = []; let k = from, d = 0, start = from; for (; k < s.length; k++) { const c = s[k]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') { if (!d) { out.push(s.slice(start, k)); return out; } d--; } else if (c === ',' && !d) { out.push(s.slice(start, k)); start = k + 1; } } out.push(s.slice(start)); return out; };
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

// Both operands of a value-pinning assertion, order-agnostic (mirrors shadowOracleGuard.mjs's operandsOf):
// JS `expect(actual).toBe(expected)`; JUnit `assertEquals(expected, actual)` / `assertSame(...)` (JUnit
// puts either side first in practice, so the whole arg list is treated as the operand pair); unittest
// `self.assertEqual(expected, actual)`; node's `assert.strictEqual(actual, expected)` /
// `assert.deepStrictEqual(...)` (dotted form); python/chai bare `assert actual == expected`. Returns `[]`
// when no recognized assertion shape matches this line (never a guess).
function operandsOf(line) {
  let mm = /\bexpect\s*\(/.exec(line);
  if (mm) {
    const a = balancedArg(line, mm.index + mm[0].length);
    const after = line.slice(mm.index);
    const mb = /\.(?:toBe|toEqual|toStrictEqual|toBeCloseTo)\s*\(/.exec(after);
    return mb ? [a, balancedArg(after, mb.index + mb[0].length)] : [];
  }
  mm = /\bassert(?:Equals|Same|Equal)\s*\(\s*/.exec(line);
  if (mm) return topLevelArgs(line, mm.index + mm[0].length);
  mm = /\bassert\s*\.\s*(?:strictEqual|deepStrictEqual|deepEqual|equal)\s*\(\s*/.exec(line);
  if (mm) return topLevelArgs(line, mm.index + mm[0].length);
  mm = /\bassert\s+(.+?)\s*==\s*(.+)$/.exec(line);
  return mm ? [mm[1], mm[2]] : [];
}

// A "branchy" expression — the shape a shadow re-derivation actually takes: an if/else expression (Kotlin
// `if (c) a else b`, python `a if c else b`), a ternary (`c ? a : b`), arithmetic, set/collection
// membership (`in`), or a boolean combinator. Deliberately excludes a bare literal/identifier/single call —
// a trivial identical-literal pin, or a bare `x === x`, is not this detector's target (and a bare identical
// CALL is selfComparisonOracle's shape, not this one) — this is what keeps condition 2 from ever firing on
// a plain non-tautological pin.
const HAS_IF_ELSE = /\bif\b[\s\S]*\belse\b/;
const HAS_TERNARY = /\?[^:?;]*:/;
const HAS_ARITH = /[\w)\]]\s*[-+*/%]\s*[\w(]/;
const HAS_IN = /\bin\b/;
const HAS_BOOL = /&&|\|\||(?:^|[^!=&|])!(?!=)/;
function isBranchy(s) {
  return HAS_IF_ELSE.test(s) || HAS_TERNARY.test(s) || HAS_ARITH.test(s) || HAS_IN.test(s) || HAS_BOOL.test(s);
}

// Resolve an operand to its underlying branchy-expression text, laundered through AT MOST 2 local-variable
// hops (`val e = <branchy>; … assertEquals(e, …)`, or a 2-hop chain `val e2 = e1`). `assigns`: Map<name,
// rhsText> of every `const|let|var|val NAME = RHS` (or bare python `NAME = RHS`) seen so far in the block,
// built incrementally in line order — only a PRECEDING declaration can resolve an operand (mirrors
// selfComparisonOracle.mjs's varCall map). Returns the branchy text (whitespace-normalized) or null (not
// resolvable to a branchy expression at all, or not branchy — never flagged).
function resolveBranchy(operand, assigns) {
  let cur = (operand || '').trim();
  for (let hop = 0; hop <= 2; hop++) {
    if (!cur) return null;
    if (isBranchy(cur)) return norm(cur);
    const bare = /^[A-Za-z_$][\w$]*$/.exec(cur);
    if (!bare || !assigns.has(bare[0])) return null;
    cur = assigns.get(bare[0]);
  }
  return null;
}

const ASSIGN_RE = /(?:\b(?:const|let|var|val)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>?[\],\s]+)?\s*=(?!=)\s*(.+)$/;

// selfEchoAssertion(rawBody, lang) → { line, expr } for the FIRST self-echo/tautological assertion found in
// the block (1-based line within rawBody, and the echoed expression text), or null. `lang`: 'kotlin' |
// 'java' | 'python' | undefined (JS/TS default).
export function selfEchoAssertion(rawBody, lang) {
  const jvm = lang === 'kotlin' || lang === 'java';
  const masked = codeOnly(rawBody, jvm ? lang : (lang === 'python' ? 'python' : 'typescript'));
  const lines = joinLogicalLines(masked).split('\n');
  const assigns = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const am = ASSIGN_RE.exec(line);
    if (am) assigns.set(am[1], am[2].replace(/[;,]\s*$/, ''));
    const [a, b] = operandsOf(line);
    if (a == null || b == null || a.trim() === '' || b.trim() === '') continue;
    const ra = resolveBranchy(a, assigns);
    const rb = resolveBranchy(b, assigns);
    if (ra && rb && ra === rb) return { line: i + 1, expr: ra };
  }
  return null;
}

// titleSutCandidates(blockName) — the candidate production method-name tokens a test's TITLE names, for the
// design's PRIMARY (and now ONLY) attribution path: the shadow is charged to changed fn F iff the block's
// title resolves to F via the SAME resolver the mutation path uses (prove.mjs runs resolveJvmSut over these
// candidates and keeps only the ones that resolve to a real src/main declaration). An earlier version also
// attributed on F's name appearing in the ECHO expression — REMOVED: a common local like `index`/`current`/
// `size` in a tautological echo collides with a same-named but unrelated changed production fn, a verified
// false HOLLOW (an `index()` fn charged for a test that never references it). The title is the test's own
// descriptive name and conventionally names the method under test, so it is the sound attribution surface;
// a fn merely appearing in the re-implemented expression is not.
//
// Extraction handles the realistic JVM test-naming conventions (Kotlin backtick names aren't recognized as
// @Test blocks by parseBlocks at all, so they never reach here): `toggleBand_addsOrRemovesTheIndex`
// (underscore-joined `SUT_description` — the leading segment is the SUT), `testToggleBand` (a `test` prefix
// + Capitalized SUT), and a bare `toggleBand`. Each candidate is emitted BOTH as-is and first-letter-
// lowercased (so a stripped `ToggleBand` also yields `toggleBand`). Non-SUT segments (`addsOrRemovesTheIndex`)
// simply fail to resolve downstream and are dropped — never a phantom attribution.
export function titleSutCandidates(blockName) {
  const method = String(blockName || '').split('.').pop() || '';
  const cands = new Set();
  const add = (s) => { if (s) { cands.add(s); cands.add(s[0].toLowerCase() + s.slice(1)); } };
  const noTest = method.replace(/^test_?/i, '');
  for (const whole of [method, noTest]) {
    add(whole);
    for (const seg of whole.split(/_+/)) add(seg);
  }
  return [...cands].filter(Boolean);
}
