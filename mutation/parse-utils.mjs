// mutation/parse-utils.mjs — the parsing substrate every language path shares: lexical primitives (regex
// escaping, paren/brace balancing, declaration-pattern construction, receiver-type inference) and the
// assertion-fragment scanner that decides which pinned values a test actually asserts. Lets the language
// modules (jvm/runners/python-resolve) depend on this without importing back into prove.mjs. Pure and
// dependency-free by design: nothing here may import from prove.mjs or any language module, or the cycle
// this extraction exists to prevent comes back.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { codeOnly } from '../checker/lexer.mjs';

// ---- path identity discipline (win32 root cause A) ----
// Canonical comparison key: resolves symlinks AND Windows 8.3 short names (realpathSync.native —
// plain realpathSync does NOT expand short names; evidence: diagnose run 28703534698, boundary A1,
// where join()'d and realpath'd forms of the SAME file disagreed because one round-tripped through the
// 8.3 short `RUNNER~1` form), then folds case on win32 (case-insensitive FS). Falls back to resolve(p)
// when the path doesn't exist (a deleted file from a diff, e.g.) rather than throwing. NEVER render
// this value — it is a comparison key only; display paths use toPosix below, never canonKey.
export function canonKey(p) {
  try { p = (realpathSync.native || realpathSync)(p); } catch { p = resolve(p); }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
// Every relative/display path is normalized to POSIX at creation — git, the runners, and this tool's
// own JSON/report consumers all accept '/' on win32, so downstream code never has to care which
// platform produced the path (evidence: diagnose run 28703534698, boundary A2 — a backslash path never
// matched a forward-slash-anchored dir-boundary regex).
export const toPosix = (p) => p.split('\\').join('/');

export const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function balancedFrom(s, openParen) { let d = 0, k = openParen; for (; k < s.length; k++) { const c = s[k]; if (c === '(') d++; else if (c === ')') { d--; if (!d) { k++; break; } } } return { arg: s.slice(openParen + 1, k - 1), end: k }; }

// `lang` is OPTIONAL: absent (every pre-JVM caller — makeResolver, resolvePySut) returns exactly the
// original JS/py regex, byte-identical. Passing 'kotlin'/'java' switches to a JVM-declaration pattern
// instead (resolveJvmSut in mutation/jvm.mjs) — the two families never mix, so there is no shared-regex risk of a
// JVM decl accidentally matching the JS branch or vice versa.
export function declRe(fn, lang) {
  const e = reEsc(fn);
  if (lang === 'kotlin') {
    // `fun NAME(` — top-level, member, generic (`fun <T> NAME(`), and receiver/extension (`fun Recv.NAME(`)
    // forms all converge on the same `fun ... NAME(` shape; a bare call site (`NAME(`, no `fun`) never
    // matches. `class|object|interface NAME` covers a type itself being the "declaration" of its name.
    return new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:[A-Za-z_][\\w.]*\\.)?${e}\\s*\\(|\\b(?:class|object|interface)\\s+${e}\\b`);
  }
  if (lang === 'java') {
    // A method DECLARATION is `NAME(params) [throws ...] {` — the trailing `{` is what a call site
    // (`NAME(args)`, followed by `;` or `)` or another token, never `{`) can never produce.
    return new RegExp(`\\b${e}\\s*\\([^)]*\\)\\s*(?:throws[^{;]*)?\\{|\\b(?:class|interface|enum)\\s+${e}\\b`);
  }
  return new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${e}\\b|\\b(?:export\\s+)?(?:const|let|var|function|class)\\s+${e}\\b|\\bfunction\\s*\\*\\s*${e}\\b|\\bdef\\s+${e}\\b|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`);
}

// `this`/`it` are never real objects to resolve (Kotlin's implicit lambda receiver, or a plain keyword);
// excluding them here means a bare `it.something()` inside a lambda never falls through to (fruitlessly,
// but harmlessly) look for a `val it = …` declaration.
export const INSTANCE_RECEIVER_SKIP = new Set(['this', 'it']);

// Lowercase-receiver instance-method calls inside an ALREADY-MASKED fragment (pinnedFragments masks its
// own copy before slicing fragments, so a call mentioned only in a string/comment can never surface
// here). Multiple pairs per fragment are all collected — JUnit's assertEquals pushes the WHOLE arg list
// as one fragment, so both expected/actual sides are scanned uniformly (mirrors the existing bare-name
// eligibility check, which is equally over-inclusive-but-safe on which side matched).
export function instanceCallsIn(fragText) {
  const out = [];
  for (const m of fragText.matchAll(/(?<![\w$.])([a-z]\w*)\s*\.\s*([A-Za-z_$]\w*)\s*\(/g)) {
    const [, receiver, method] = m;
    if (INSTANCE_RECEIVER_SKIP.has(receiver)) continue;
    out.push({ receiver, method });
  }
  return out;
}

// Shared runtime-type inference: scan the FULL masked test file for EVERY assignment to RECEIVER and
// return the single constructor (runtime) type common to all of them, or null (REFUSE). `assignRe` finds
// each assignment site (a declaration — possibly type-annotated — or a bare reassignment); its match end
// sits right after the `=`. `ctorAt(s, i)` returns `{ type, end }` when the masked text at `i` begins
// with a DIRECT constructor call (the index just past its closing `)` is `end`), else null. Fail-closed
// on every branch:
//   - ANY assignment whose RHS is not a direct constructor (a factory/method return, another variable, a
//     literal, or a declaration with no initializer) → null: the runtime type is unknowable.
//   - a constructor immediately CHAINED (`Foo().let { … }`, `.also`, `.apply`, `.map`, …) → null: the
//     chain may transform the value's type (we don't special-case which combinators preserve it).
//   - >1 DISTINCT constructor type across the file (reassignment / shadowing) → null: ambiguous.
//   - no assignment visible at all (a parameter, or a field constructed out of view) → null.
export function inferReceiverTypeFromCtor(masked, assignRe, ctorAt) {
  const types = new Set();
  let sawAssignment = false;
  for (const m of masked.matchAll(assignRe)) {
    sawAssignment = true;
    const c = ctorAt(masked, m.index + m[0].length);
    if (!c) return null; // RHS is not a direct constructor call — runtime type unknown → refuse
    let k = c.end; while (k < masked.length && /\s/.test(masked[k])) k++;
    if (masked[k] === '.') return null; // chained construction (`Foo().let{…}`) — type may be transformed → refuse
    types.add(c.type);
  }
  if (!sawAssignment) return null; // annotation / parameter / field only, never constructed in view → refuse
  if (types.size !== 1) return null; // reassignment / shadowing to >1 distinct constructor type → refuse
  return [...types][0];
}

// `{`-balanced analog of balancedFrom: the text inside the brace pair opening at body[idx], or null
// when unbalanced. Callers pass MASKED text (codeOnly), so brace characters inside strings — including
// Kotlin string templates — are already blanked and cannot desynchronize the depth count.
export function braceArgFrom(body, idx) {
  let depth = 0;
  for (let i = idx; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { depth--; if (depth === 0) return body.slice(idx + 1, i); }
  }
  return null;
}
// The receiver expression immediately preceding `end` (the index of the '.' before `should`): an identifier /
// member chain, with balanced call/index groups consumed backward. Returns '' if none.
function receiverBefore(body, end) {
  let i = end - 1;
  while (i >= 0 && /\s/.test(body[i])) i--;
  const stop = i + 1;
  for (; i >= 0; ) {
    const c = body[i];
    if (c === ')' || c === ']') { const open = c === ')' ? '(' : '['; let d = 0;
      for (; i >= 0; i--) { const b = body[i]; if (b === c) d++; else if (b === open && --d === 0) break; }
      i--; continue; }
    if (/[A-Za-z0-9_$.]/.test(c)) { i--; continue; }
    break;
  }
  return body.slice(i + 1, stop).trim();
}
// Number of top-level (comma-separated, bracket-depth-0) arguments in a parenthesized arg-list's inner text.
function topLevelArgCount(s) {
  let depth = 0, n = s.trim() ? 1 : 0;
  for (let i = 0; i < s.length; i++) { const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) n++; }
  return n;
}

// ---- assertion-strength gate: which consumed fns have their RESULT pinned by a value matcher ----
// jest/vitest value-pinning matchers that FAIL against the gross-break sentinel (so probing is sound).
// Mirrors the vocabulary of checker/kinds/weakOracleGuard.mjs `PIN` (NOT .not./toBeDefined/toBeTruthy).
const VALUE_PIN = /^\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeCloseTo|toBeNull|toBeNaN|toBeInstanceOf|toContain|toContainEqual|toMatch|toMatchObject|toHaveLength|toThrow|toThrowError)\b/;
const VALUE_PIN_CALL = /^\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeCloseTo|toBeInstanceOf|toContain|toContainEqual|toMatch|toMatchObject|toHaveLength)\s*\(/;
// chai mirror is NOT 1:1 with PIN: .to.match (string-coerces the target) and the bare .to.have.a/an
// (type-checks) both PASS against the numeric sentinel, so they're excluded — sound forms only.
// toHaveProperty/.have.property are excluded too: a primitive autoboxes, so the path resolves on its
// prototype and PASSES the sentinel; .keys/.ownProperty require OWN properties, so they stay sound.
// language chains: chai's fluent no-ops (be/been/is/that/which/and/has/deep/same/an/a) may sit between
// `to`/`should` and the terminal matcher (`.to.be.equal(5)`, `.to.be.deep.equal(5)`) — they assert nothing
// themselves, so allowing any run of them before the terminal group changes no soundness property; `have`
// is deliberately NOT in this list (only `has` is), so `.to.have.property(...)` still never reaches the
// terminal group and the have-subform exclusion (property autoboxes) stays intact.
const CHAI_PIN = /^\s*\.\s*(?:to|should)\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a)\s*\.\s*)*(?:(?:deep\s*\.\s*)?(?:equal|eql|include|contain)\b|have\s*\.\s*(?:deep\s*\.\s*)?(?:lengthOf|length|members|keys|string|ownProperty)\b)/;
// standalone chai `should` sound-form matcher, tested from the '.' immediately before `should`.
const SHOULD_SOUND = /^\.\s*should\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a)\s*\.\s*)*(?:(?:deep\s*\.\s*)?(?:equal|eql|include|contain)\b|have\s*\.\s*(?:deep\s*\.\s*)?(?:lengthOf|length|members|keys|string|ownProperty)\b)/;
// Module specifiers that resolve to node's `assert` — a local name bound to one of these (aliased default
// import/require, or a destructured named import) is recognized as an assert call even under a non-literal
// name. A name bound to any OTHER module (lodash, …) is never treated as assert — no false HOLLOW.
const ASSERT_SPECS = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const ASSERT_METHODS = /^(?:equal|strictEqual|deepEqual|deepStrictEqual)$/;
// JVM value-pinning matcher vocabulary (Task 6): JUnit/kotlin.test equality asserters and AssertJ's
// fluent form. Scanned only when `lang` is 'kotlin'/'java' — every JS/py caller (no lang arg, or a non-
// JVM lang) never reaches this and stays byte-identical to pre-JVM behavior.
const JVM_VALUE_ASSERT_RE = /\b(?:assertEquals|assertSame|assertArrayEquals|assertContentEquals)\s*\(/g;
// AssertJ: assertThat(<actual>) is a pin only when followed by a SOUND (value-comparing) fluent
// matcher — a bare assertThat(x) with only a weak follow-on (.isNotNull(), .isNotEmpty(), …) is not a
// pin (mirrors the JS weak-matcher exclusion below: no assertion strength ⇒ never probed).
const ASSERTJ_SOUND = /^\s*\.\s*(?:isEqualTo|isSameAs|containsExactly|containsExactlyInAnyOrder|isEqualToComparingFieldByField)\s*\(/;
// AssertJ directional (relational) matchers — same asymmetry as RELATIONAL_PIN_CALL/CHAI_REL above: a
// relational pin can PROVE but never CONVICT (see the verdict fold).
const ASSERTJ_REL = /^\s*\.\s*(?:isGreaterThanOrEqualTo|isGreaterThan|isLessThanOrEqualTo|isLessThan)\s*\(/;
// Relational (direction-only) matcher vocabulary — spec Feature 2 §1. A relational pin can PROVE
// (mutant red) but can never CONVICT (survive → relation-unbound, never hollow) — see the verdict
// fold. That asymmetry is what makes loose admission safe: a false-relational match can only add
// proven/one-sided/relation-unbound, never an accusation.
const RELATIONAL_PIN_CALL = /^\s*\.\s*(?:toBeGreaterThanOrEqual|toBeGreaterThan|toBeLessThanOrEqual|toBeLessThan)\s*\(/;
// chai chains: same language-chain shape as CHAI_PIN, plus `at` (needed for .to.be.at.least/.at.most —
// `at` is a chai no-op chain that the value vocabulary never needed).
const CHAI_REL = /^\s*\.\s*(?:to|should)\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a|at)\s*\.\s*)*(?:above|gt|greaterThan|least|gte|below|lt|lessThan|most|lte)\s*\(/;
const SHOULD_REL = /^\.\s*should\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a|at)\s*\.\s*)*(?:above|gt|greaterThan|least|gte|below|lt|lessThan|most|lte)\s*\(/;
export function pinnedFragmentsByKind(body, imports = new Map(), lang) {
  const jvm = lang === 'kotlin' || lang === 'java';
  body = codeOnly(body, jvm ? lang : 'typescript'); // mask strings/comments FIRST — a code sample embedded in a string
  // (or a commented-out assertion) must never be seen by the scans below (no false HOLLOW). Idempotent on
  // already-masked input, so re-masking here is harmless when eligibleFns has already masked its copy.
  const value = []; const relational = [];
  const frags = value; // existing scan code below keeps pushing to `frags` unchanged
  for (const m of body.matchAll(/expect\s*\(/g)) {
    const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
    let after = body.slice(end);
    // jest/vitest .resolves/.rejects prefix: strip it and test VALUE_PIN only (chai has no .resolves,
    // so CHAI_PIN after this prefix could only ever match accidental text). The gross-break mutant makes
    // the async SUT resolve to (or throw/reject with) the numeric sentinel, so a sound matcher after the
    // prefix provably fails against it — same soundness discipline as the sync path.
    const pm = /^\s*\.\s*(?:resolves|rejects)\b/.exec(after);
    if (pm) after = after.slice(pm[0].length);
    if (pm ? VALUE_PIN.test(after) : (VALUE_PIN.test(after) || CHAI_PIN.test(after))) {
      frags.push(arg);
      const mm = VALUE_PIN_CALL.exec(after);
      if (mm) frags.push(balancedFrom(after, mm.index + mm[0].length - 1).arg);
    } else if (RELATIONAL_PIN_CALL.test(after) || (!pm && CHAI_REL.test(after))) {
      relational.push(arg);
      const rm = RELATIONAL_PIN_CALL.exec(after) || CHAI_REL.exec(after);
      relational.push(balancedFrom(after, rm[0].length - 1).arg); // matcher arg — the other side of the relation
    }
  }
  for (const m of body.matchAll(/\bassert(?:\.(?:strictEqual|deepStrictEqual|deepEqual|equal|ok))?\s*\(/g)) {
    const { arg } = balancedFrom(body, m.index + m[0].length - 1);
    if (/\bassert\s*\($/.test(m[0]) || /\.\s*ok\s*\($/.test(m[0])) {
      const sides = topLevelComparisonSides(arg);
      if (sides) { relational.push(sides[0]); relational.push(sides[1]); }
      continue; // plain truthiness (no top-level comparator) stays excluded, exactly as before
    }
    frags.push(arg);
  }
  // aliased/destructured assert (import-aware): names bound to node:assert.
  const bound = new Set(); for (const [name, spec] of imports) if (ASSERT_SPECS.has(spec)) bound.add(name);
  for (const n of bound) {
    const e = reEsc(n);
    for (const m of body.matchAll(new RegExp('\\b' + e + '\\s*\\.\\s*(?:strictEqual|deepStrictEqual|deepEqual|equal)\\s*\\(', 'g')))
      frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
    if (ASSERT_METHODS.test(n))
      for (const m of body.matchAll(new RegExp('(?<![.\\w$])' + e + '\\s*\\(', 'g')))
        frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
  }
  // Hybrid fallback: X.<assertMethod>(a, b) where X is an UNDETECTABLE alias (not in imports at all).
  // Guards: exact assert method names + EXACTLY 2 top-level args (distinguishes assert.equal(actual,expected)
  // from chai `.to.equal(expected)` / a library `.equal(other)`, both 1-arg). A name bound to a non-assert
  // module is excluded (it was in imports, so it's skipped here and not in `bound`).
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\s*\.\s*(?:strictEqual|deepStrictEqual|deepEqual|equal)\s*\(/g)) {
    const name = m[1];
    if (name === 'assert' || imports.has(name)) continue; // literal handled above; any imported name handled above/excluded
    const { arg } = balancedFrom(body, m.index + m[0].length - 1);
    if (topLevelArgCount(arg) === 2) frags.push(arg);
  }
  // standalone chai `should` chains: <receiver>.should.<sound-form> — push the receiver (SUT extracted by eligibleFns)
  for (const m of body.matchAll(/\.\s*should\s*\./g)) {
    if (!SHOULD_SOUND.test(body.slice(m.index))) continue;
    const recv = receiverBefore(body, m.index);
    if (recv) frags.push(recv);
  }
  // chai `should` relational chain: <receiver>.should.be.<relational-form> — mirrors SHOULD_SOUND above.
  for (const m of body.matchAll(/\.\s*should\s*\./g)) {
    if (!SHOULD_REL.test(body.slice(m.index))) continue;
    if (SHOULD_SOUND.test(body.slice(m.index))) continue; // value already claimed it
    const recv = receiverBefore(body, m.index);
    if (recv) relational.push(recv);
  }
  for (const m of body.matchAll(/\bassert\s+(.+?)\s*===?\s*(.+?)(?:$|\n)/gm)) { frags.push(m[1]); frags.push(m[2]); } // pytest / chai assert a == b
  // pytest bare relational assert (spec §1): both sides pushed, chained comparisons allowed —
  // asymmetric verdicting protects every relation, so a chain needs no special casing.
  for (const m of body.matchAll(/\bassert\s+([^\n]+?)\s+(?:>=|<=|>|<)\s+([^\n]+?)(?:$|\n)/gm)) { relational.push(m[1]); relational.push(m[2]); }
  if (jvm) {
    // assertEquals(expected, actual) / assertSame / assertArrayEquals / assertContentEquals — JUnit puts
    // the SUT call in EITHER position (expected first is the JUnit convention, but a caller can and does
    // pass it either way), so the WHOLE arg list is pushed as one fragment rather than picking a side;
    // eligibleFns only credits a candidate whose name actually appears in it, so this is over-inclusive
    // but never wrong (the `\bname\s*\(` check below still requires the fn to be CALLED here).
    for (const m of body.matchAll(JVM_VALUE_ASSERT_RE)) frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
    // AssertJ assertThat(actual).isEqualTo(expected) — push the actual only when a sound fluent matcher
    // follows; assertThat(x).isNotNull() (weak) pushes nothing, so a fn reachable only through it is
    // never credited as eligible (see ASSERTJ_SOUND above).
    for (const m of body.matchAll(/\bassertThat\s*\(/g)) {
      const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
      if (ASSERTJ_SOUND.test(body.slice(end))) frags.push(arg);
    }
    // Relational JVM forms (spec §1): assertTrue/assertFalse over one top-level comparison — paren and
    // Kotlin trailing-lambda call shapes — and AssertJ's directional matchers. Both relation sides pushed.
    for (const m of body.matchAll(/\bassert(?:True|False)\s*\(/g)) {
      const sides = topLevelComparisonSides(balancedFrom(body, m.index + m[0].length - 1).arg);
      if (sides) { relational.push(sides[0]); relational.push(sides[1]); }
    }
    if (lang === 'kotlin') for (const m of body.matchAll(/\bassert(?:True|False)\s*\{/g)) {
      const inner = braceArgFrom(body, m.index + m[0].length - 1);
      const sides = inner === null ? null : topLevelComparisonSides(inner);
      if (sides) { relational.push(sides[0]); relational.push(sides[1]); }
    }
    for (const m of body.matchAll(/\bassertThat\s*\(/g)) {
      const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
      const rm = ASSERTJ_REL.exec(body.slice(end));
      if (rm) { relational.push(arg); relational.push(balancedFrom(body.slice(end), rm[0].length - 1).arg); }
    }
  }
  return { value, relational };
}
export function pinnedFragments(body, imports = new Map(), lang) {
  const k = pinnedFragmentsByKind(body, imports, lang);
  return [...k.value, ...k.relational];
}

// Split `text` at its single top-level comparison operator (>, <, >=, <=) → [lhs, rhs], else null.
// Depth-0 only (parens/brackets/braces balanced); refuses && and || (a joined condition is not one
// relation — fail-closed per spec), ==/===/!= (never relational), a second comparator, arrows
// (=>, ->), and shifts (<< >>). Runs on MASKED text, so string contents never reach it. Generic-type
// false positives (f<T>(x)) are accepted: admission is verdict-safe by construction (see above).
export function topLevelComparisonSides(text) {
  let depth = 0, cmp = -1, op = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      if ((c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|')) return null;
      if ((c === '=' && text[i + 1] === '=') || (c === '!' && text[i + 1] === '=')) return null;
      if (c === '<' || c === '>') {
        if (text[i - 1] === '=' || text[i - 1] === '-') continue; // => and -> arrows
        if (text[i + 1] === c) { i++; continue; }                  // << >> shifts
        if (cmp !== -1) return null;                               // a second comparator — refuse
        cmp = i; op = text[i + 1] === '=' ? c + '=' : c;
      }
    }
  }
  return cmp === -1 ? null : [text.slice(0, cmp).trim(), text.slice(cmp + op.length).trim()];
}
