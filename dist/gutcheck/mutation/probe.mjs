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
// with GUTCHECK_PROBE_TIMEOUT_MS. A run that exceeds
// it is treated as "not green" (the mutant is caught, or the unmutated test is too slow to probe →
// INCONCLUSIVE at the baseline).
const PROBE_TIMEOUT_MS = Number(process.env.GUTCHECK_PROBE_TIMEOUT_MS) || 60000;

// Locate a named function's BODY and return a replacement descriptor, or null if it can't be located/
// parsed (so the caller reports INCONCLUSIVE, never a wrong verdict). Handles `function NAME(` incl.
// generators (`function* NAME` / `async function* NAME`), `def NAME(`, `NAME = function` / `NAME: function`
// (a `=` binding or a `:` object property), parenthesised and bare single-param arrows (`NAME = x =>`),
// block- and expression-bodied. All structural scanning is on a string/comment MASK (codeOnly blanks them
// to spaces, positions preserved) so braces/parens/`=>` inside string literals or comments can't fool it,
// and the parameter list is paren-balanced before the body is located so a default-param arrow
// (`(x = () => 5) => …`) can't be mistaken for the body. Kotlin/Java delegate to locateJvmBody (below) —
// a different-enough grammar (a `fun` keyword; a leading return-type token) that folding it into this
// regex would risk the whole thing, so it is kept as a fully separate path and this JS/Python path is
// untouched by the Kotlin/Java work.
//
// The descriptor is `{ site, start, end, firstParam, originalInner, make(value), returnType }`: replacing
// `code.slice(start, end)` with `make(value)` rewrites the body to `return <value>`. grossBreak feeds a
// type-compatible sentinel (via gutValueFor); passthroughBreak feeds the first parameter. firstParam is
// the first SIMPLE parameter name (null for none/destructured/rest), originalInner is the body text being
// replaced, returnType is the declared return type text for Kotlin/Java (undefined for JS/TS/Python, so
// gutValueFor(undefined, lang) always yields the original fixed numeric sentinel there — unchanged output).
//
// TWO-PASS (JS/TS only): pass 1 is this original signature regex, byte-identical — it is tried FIRST and,
// if it finds anything, wins outright (so a top-level `function foo` always beats a same-named method
// `foo(){` elsewhere in the file — no behavior change for any case pass 1 already handled). Only when
// pass 1 finds nothing does pass 2 (locateBareMethod, below) get a turn, for a class-method / object-
// shorthand-method signature that has none of pass 1's keywords at all. Python/Kotlin/Java are untouched:
// Python's `def` already matches at any indentation (locateBody never required column 0 — only
// declaredFns' enumeration did, fixed separately in changes.mjs), and Kotlin/Java delegate to
// locateJvmBody, a fully separate path this change does not touch.
// The pass-1 signature regex (fn decl / def / `=`-or-`:` binding / arrow forms) — factored out so
// jsDeclSiteCount (below) can count the SAME sites locateBody's own pass 1 counts, with zero chance of
// the two drifting apart (they share this one regex builder, not two hand-copies of it).
function jsSigRegex(fn) {
  const e = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const G = '(?:<[^>()]*>\\s*)?'; // optional TS generic params on the name: `f<T>(`
  return new RegExp(
    `function\\b\\s*\\*?\\s*${e}\\s*${G}\\(`             // fn decl, incl. generator `function*` / `async function*`
    + `|\\bdef\\s+${e}\\s*\\(`
    + `|\\b${e}\\s*[:=]\\s*(?:async\\s*)?function\\b`    // fn-expr value of a `=` binding OR a `:` object property
    + `|\\b${e}\\s*=\\s*(?:async\\s*)?${G}\\(`
    + `|\\b${e}\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`,
  );
}
function locateBody(code, fn, lang) {
  const L = (lang === 'python' || lang === 'kotlin' || lang === 'java') ? lang : 'typescript';
  if (L === 'kotlin' || L === 'java') return locateJvmBody(code, fn, L);
  const sig = jsSigRegex(fn);
  const mask = codeOnly(code, L); // strings + comments → spaces, length/positions preserved
  // Search the MASK (a declaration-shaped mention inside a comment or string must not match) and count
  // ALL declaration-shaped sites for the name. Two or more → refuse (return null → the block lands
  // ungutable, never a verdict): taking the positionally-first match gutted a same-named non-exported
  // binding above the real export and minted a reproduced FALSE HOLLOW. This is the JVM resolver's
  // overload rule applied to JS/py — ambiguity is a reach loss, never a guess.
  const sites = [...mask.matchAll(new RegExp(sig.source, 'g'))];
  if (sites.length > 1) return null;
  const m = sites[0] || null;
  if (!m) {
    // Pass 1 found nothing — try the bare-signature method locator (JS/TS only; see locateBareMethod).
    return L === 'typescript' ? locateBareMethod(code, mask, fn) : null;
  }
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

  if (isDef) { // Python: replace the body with `return <value>`
    const colon = mask.indexOf(':', i);
    if (colon < 0) return null;
    let nl = code.indexOf('\n', colon);
    if (nl < 0) nl = code.length;
    // INLINE body (`def f(x): return x*2` / `def m(self, x): return x*2`): non-whitespace after the
    // def's terminating colon on the SAME line (checked on the MASK, so a trailing `# comment` — blanked
    // to spaces — does NOT read as inline; that's a real block-bodied def). Replace it IN PLACE →
    // `def f(x): return 987654321`. The block path below appends an INDENTED `return` on the next line,
    // which for a one-liner is a syntax error (an unindented sibling would sit under the def header) —
    // the module then fails to import, the test errors, and the probe reports an UNEARNED SOUND. Must
    // stay guttable (a valid mutant), never null, so declaredFns' one-line-def grammar-sync holds.
    if (mask.slice(colon + 1, nl).trim() !== '') {
      const start = colon + 1, end = nl;
      return { site: 'python', start, end, firstParam, originalInner: code.slice(start, end),
        make: (v) => ' return ' + v };
    }
    // BLOCK body: colon at end of line, body on the following indented lines (unchanged, byte-identical).
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

// Pass 2 of locateBody (JS/TS only) — ONLY tried when pass 1 (the function/def/=/arrow signature above)
// finds nothing. A class method or object-shorthand method has none of those keywords: `[async] [*]
// NAME(params) {` directly in declaration position, with no `function`/`def`/`=`/`:` anywhere in sight.
// Discriminated from a call site — mirrors jsMethodDecls in mutation/changes.mjs, kept in sync — by
// three checks, ALL required, on the comment/string MASK:
//   1. the char immediately preceding the whole signature (skip whitespace, may cross a line) is a
//      member/statement boundary — `{` (class-body/object-literal open), `,` (prior object member),
//      `;` (prior statement), or `}` (prior member's close) — never `.`/`=`/`(`/an identifier char,
//      any of which would mean this is a property access, assignment, nested call, or part of a
//      longer name, not a declaration.
//   2. NAME is not a JS/TS keyword — so `if (x) {` / `while (bar()) {` can never read as a decl of
//      `if`/`while` (only matters as a defensive net here since `fn` is caller-supplied; it is the
//      load-bearing check in changes.mjs's generic scan over every identifier in the file).
//   3. the paren-balanced params are followed (only whitespace between) by a body block `{` — a call
//      has no trailing block. `while (bar()) {` also fails check 1 for `bar` itself: it is preceded by
//      `(`, not a boundary char.
// Any ambiguity → null. A missed method is simply unscored (the caller reports INCONCLUSIVE); a
// mis-gutted one would be a false verdict, which this function must never produce.
const JS_METHOD_NON_NAMES = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'catch', 'try', 'finally', 'return', 'function',
  'typeof', 'instanceof', 'new', 'delete', 'void', 'yield', 'await', 'class', 'super', 'this',
  'in', 'of', 'throw', 'with',
]);
// Enumerates EVERY position satisfying all three locateBareMethod checks (boundary char, paren-balance,
// trailing `{`) — factored out of locateBareMethod so it can be driven either as "first match wins"
// (locateBareMethod itself, gut-time — unchanged behavior/order) or "count every match" (jsDeclSiteCount,
// credit-time — see its header for why the two callers must never see different sites).
function* bareMethodSites(code, mask, fn) {
  if (JS_METHOD_NON_NAMES.has(fn)) return;
  const e = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:async\\s+)?(?:\\*\\s*)?\\b${e}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(mask)) !== null) {
    let p = m.index - 1;
    while (p >= 0 && /\s/.test(mask[p])) p--;
    if (p < 0 || !'{,;}'.includes(mask[p])) continue; // not preceded by a member/statement boundary

    const parenOpen = m.index + m[0].length - 1;
    let depth = 0, i = parenOpen;
    for (; i < code.length; i++) { const c = mask[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) { i++; break; } } }
    if (depth !== 0) continue; // unbalanced — malformed or ran off the end

    let q = i;
    while (q < code.length && /\s/.test(mask[q])) q++;
    if (mask[q] !== '{') continue; // no trailing block — a call, not a method decl

    yield { start: m.index, parenOpen, i, q };
  }
}
function locateBareMethod(code, mask, fn) {
  for (const { parenOpen, i, q } of bareMethodSites(code, mask, fn)) {
    const firstParam = firstSimpleParam(code.slice(parenOpen + 1, i - 1));
    return blockSite(code, mask, q, firstParam);
  }
  return null;
}

// jsDeclSites(code, fn) — JS/TS DECLARATION-site START INDICES (into the codeOnly mask of `code`) for
// the crediting-time guards in mutation/prove.mjs's jsInstanceSuts. Returns pass-1 signature sites
// (jsSigRegex, the SAME regex locateBody's own pass 1 matches against — `m.index`) PLUS pass-2
// bare-method sites (bareMethodSites, the SAME generator locateBareMethod drives — its `start`) — built
// from the locator's OWN patterns so this can never drift from what grossBreak would actually gut. A
// count of 1 (jsDeclSiteCount below) is necessary but NOT sufficient for a safe credit: it guarantees
// the single site is the unique gut TARGET, but says nothing about which class's body (if any) contains
// it — jsInstanceSuts additionally checks the index against the resolved class's own brace span.
export function jsDeclSites(code, fn) {
  const mask = codeOnly(code, 'typescript');
  const sites = [];
  for (const m of mask.matchAll(new RegExp(jsSigRegex(fn).source, 'g'))) sites.push(m.index);
  for (const s of bareMethodSites(code, mask, fn)) sites.push(s.start);
  return sites;
}
// jsDeclSiteCount(code, fn) — the site COUNT alone (see jsDeclSites above for what the count does and
// does not guarantee). This is what makes a helper `function decrypt(){}` plus a same-named
// `class Service { decrypt(){} }` in one file count 2 (refuse), even though locateBody's "pass 1 wins
// outright" rule means gut-time would silently gut the helper while the class method stays live —
// crediting on a count of 1 there would mint a false HOLLOW risk (a sound test on the class method would
// survive the helper's mutant).
export function jsDeclSiteCount(code, fn) {
  return jsDeclSites(code, fn).length;
}

// pyDeclSiteCount(code, fn) — Python DECLARATION-site count for the crediting-time guard in
// mutation/prove.mjs's resolvePyClassMember (T4, §6.4): `jsSigRegex(fn)` matched globally over
// `codeOnly(code, 'python')` — the EXACT SAME regex + mask locateBody's own Python pass 1 (above) uses to
// locate a `def fn(` body (only the `\bdef\s+fn\s*\(` alternative can ever match real Python source; the
// other JS-shaped alternatives are inert here). One-scan-two-callers parity with jsDeclSites/jvmDeclSites:
// an instance-method credit can never survive where gut-time's own site-count refusal (locateBody line 78:
// `sites.length > 1 → null`) would fire, and a credited site is exactly the one gut-time guts.
export function pyDeclSiteCount(code, fn) {
  const mask = codeOnly(code, 'python');
  return [...mask.matchAll(new RegExp(jsSigRegex(fn).source, 'g'))].length;
}

// Type-compatible gross sentinel. A compile-failing mutant is provably classified ungutable (the runner
// gets no fresh test XML) — so an imperfect/unknown type mapping can only ever REDUCE reach, never flip a
// verdict. Default to the numeric sentinel whenever the type is unknown, complex, or (JS/TS/Python)
// undefined — this is what keeps grossBreak's JS/Python output byte-identical to before this change.
function gutValueFor(returnType, lang) {
  const t = (returnType || '').trim().replace(/\?$/, ''); // strip a Kotlin nullable marker
  if (/^(Int|Short|Byte|Integer|int|short|byte)$/.test(t)) return '987654321';
  if (/^(Long|long)$/.test(t)) return '987654321L';
  if (/^(Double|double)$/.test(t)) return '987654321.0';
  if (/^(Float|float)$/.test(t)) return '987654321.0f';
  if (/^(String|CharSequence)$/.test(t)) return '"__gutcheck_987654321__"';
  // Boolean/Char deliberately fall through: a `false` / `' '` sentinel COMPILES and collides with a real
  // return (a sound `assertFalse(valid(-1))` still passes → false HOLLOW). The numeric default instead
  // compile-fails in a Boolean/Char context → ungutable → INCONCLUSIVE (safe non-verdict). Precision over
  // reach. Unknown/complex/undefined (incl. all JS/TS/Python) also land here → numeric; compile-fail is
  // the safety net.
  return '987654321';
}

// A call textually shaped like `KEYWORD NAME(` (e.g. `return add(1, 2)`, `throw add(x)`) reads, to the
// Java signature regex below, exactly like a declaration whose return type is the keyword — the single
// biggest false-positive vector for "gut the call site instead of the declaration". These words can never
// legally BE a return type, so a match capturing one is rejected outright (see locateJvmBody).
const JAVA_NON_TYPE_WORDS = new Set([
  'return', 'throw', 'new', 'yield', 'case', 'else', 'do', 'instanceof', 'synchronized',
  'assert', 'catch', 'finally', 'try', 'while', 'for', 'if', 'switch', 'super', 'this',
]);

// Kotlin `[modifiers] fun [<T>] [Receiver.]NAME [<T>] (` / Java `[modifiers] TYPE NAME(` — a materially
// different grammar from the JS/def/arrow signature above, so this is a fully separate path (the JS/py
// path above is untouched). Matches run on the comment/string MASK, never raw `code`, so a name mentioned
// in a KDoc/Javadoc comment or inside a string literal can never be mistaken for a declaration. Every
// textual match is tried in turn (not just the first) — a same-named CALL that happens to satisfy the
// Java shape (`return add(`, `throw add(` — "return"/"throw" read as a return-type token) is rejected via
// JAVA_NON_TYPE_WORDS, and a signature with no body (an interface/abstract member) is rejected by the
// per-language body scan below — either way the search moves on to the NEXT match rather than settling
// for a wrong one. Any shape neither scan can resolve returns null (never a mislocated body).
// jvmBodySites(code, mask, fn, L) — the ONE textual scan that both gut-time (locateJvmBody, "return the
// first yielded site") and credit-time (jvmDeclSites, below) drive, so the two can never drift apart: a
// declaration credit-time counts as a "site" is, by construction, exactly what gut-time would locate and
// gut. Yields `{ index: m.index, receiverPrefixed, site }` for every signature match that passes the
// existing acceptance (JAVA_NON_TYPE_WORDS rejection for java; a located body for kotlin/java) — a
// textual match with no body (interface/abstract member, or a malformed paren list) is not a site, same
// as before this refactor. `receiverPrefixed` is true only for a kotlin `fun Recv.NAME(` extension form
// (capture group 1 on the kotlin sig); always false for java (group 1 there is the return-type token).
function* jvmBodySites(code, mask, fn, L) {
  const e = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sig = L === 'kotlin'
    ? new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:([A-Za-z_][\\w.]*)\\.)?${e}\\s*(?:<[^>]*>\\s*)?\\(`, 'g')
    : new RegExp(`(?<![.\\w$])([A-Za-z_][\\w.$]*(?:<[^>]*>)?(?:\\[\\])?)\\s+${e}\\s*\\(`, 'g');

  let m;
  while ((m = sig.exec(mask)) !== null) {
    if (L === 'java' && JAVA_NON_TYPE_WORDS.has(m[1])) continue; // a call, not a declaration

    // paren-balance the parameter list on the mask (both sig forms end with the literal '(')
    const parenOpen = m.index + m[0].length - 1;
    let depth = 0, i = parenOpen;
    for (; i < code.length; i++) { const c = mask[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) { i++; break; } } }
    if (depth !== 0) continue;
    const firstParam = firstSimpleParam(code.slice(parenOpen + 1, i - 1));

    if (L === 'kotlin') {
      const site = locateKotlinSite(code, mask, i, firstParam);
      if (site) yield { index: m.index, receiverPrefixed: !!m[1], site };
    } else {
      const braceAt = javaBodyBrace(mask, i);
      if (braceAt < 0) continue; // interface/abstract method (`;`), or scope closed (`}`) — no body here
      const site = blockSite(code, mask, braceAt, firstParam);
      if (site) yield { index: m.index, receiverPrefixed: false, site: { ...site, returnType: m[1] } };
    }
  }
}

function locateJvmBody(code, fn, L) {
  const mask = codeOnly(code, L);
  for (const { site } of jvmBodySites(code, mask, fn, L)) return site;
  return null;
}

// jvmDeclSites(code, fn, L) → [{ index, receiverPrefixed }] — the crediting-time DECLARATION-site
// enumerator for mutation/prove.mjs's jvmOwnPlainInstanceMember, built from jvmBodySites (locateJvmBody's
// OWN scan) so credit-time can never see a site gut-time (locateJvmBody) would not itself gut. `index` is
// the match start into `codeOnly(code, L)` (same masked-position convention as jsDeclSites); a count of 1
// is necessary but not sufficient for a safe credit — the caller additionally checks class-body
// containment, nesting depth, and member kind (receiverPrefixed, static/companion, …).
export function jvmDeclSites(code, fn, L) {
  const mask = codeOnly(code, L);
  const out = [];
  for (const { index, receiverPrefixed } of jvmBodySites(code, mask, fn, L)) out.push({ index, receiverPrefixed });
  return out;
}

// From just after a Kotlin param list ')', find the body: a block `{ … }` or an expression `= …`, past an
// optional `: ReturnType` (tracked through `<...>`/`(...)` nesting so a generic like `Map<String,
// List<Int>>` or a function-type return like `(Int) -> Int` can't be mistaken for the body starting).
// Fails safe (null) on any shape that reaches a top-level `}`/`;` (this signature's enclosing scope closed,
// or it explicitly has no body — an abstract/interface member) or the next `fun` keyword (a sibling
// declaration) before finding one of its own — never treats a LATER, unrelated function's body as this
// one's, which is what the caller's match-then-retry loop depends on.
// Exported so mutation/prove.mjs's parseBlocks can locate an expression-bodied `@Test fun x() = expr`
// method's OWN body via the exact SAME scan gut-time (grossBreak/passthroughBreak) uses for a named
// function — credit-time and gut-time can then never drift apart. Before this, parseBlocks' own
// brace-only scan skipped an expression-bodied test (no braces of its own) straight to the NEXT test's
// `{...}` — misattributing a sibling's body to it — or, when no later brace existed anywhere in the file,
// silently dropped the block.
export function locateKotlinSite(code, mask, fromIdx, firstParam) {
  const nextFun = /\bfun\b/.exec(mask.slice(fromIdx));
  const nextFunIdx = nextFun ? fromIdx + nextFun.index : -1;
  let sawColon = false, colonAt = -1, angle = 0, paren = 0;
  for (let p = fromIdx; p < code.length; p++) {
    if (p === nextFunIdx) return null; // reached the NEXT declaration before finding our own body
    const c = mask[p];
    if (angle === 0 && paren === 0) {
      if (c === '}' || c === ';') return null;
      if (c === ':' && !sawColon) { sawColon = true; colonAt = p; continue; }
      if (c === '{') {
        const returnType = sawColon ? code.slice(colonAt + 1, p).trim() : undefined;
        const site = blockSite(code, mask, p, firstParam);
        return site ? { ...site, returnType } : null;
      }
      if (c === '=') {
        const returnType = sawColon ? code.slice(colonAt + 1, p).trim() : undefined;
        const site = kotlinExprSite(code, mask, p + 1, firstParam);
        return site ? { ...site, returnType } : null;
      }
    }
    if (c === '<') angle++;
    else if (c === '>' && angle > 0) angle--;
    else if (c === '(') paren++;
    else if (c === ')' && paren > 0) paren--;
  }
  return null;
}

// Kotlin expression continuation across a depth-0 newline (see kotlinExprSite below). codeOnly already
// blanks comments to spaces (newlines kept), so peeking past a comment on the MASK can never mistake it
// for code. Two narrow, symbol-only signals — anything else ends the expression exactly as before (never
// a guess TOWARD continuing, which is what would risk swallowing an unrelated following statement):
//   (a) forward — the next non-whitespace char at or after the break opens a chain/elvis/reference
//       continuation: `.` (call/property chain — the confirmed real-app repro's `.roundToInt()\n
//       .coerceIn(...)`), `?.` (safe call), `?:` (elvis), `::` (reference).
//   (b) backward — the current line's last real token is one of a fixed set of binary/infix operator
//       symbols that can never legally END a complete Kotlin statement (so a statement genuinely ending
//       there would be a syntax error, i.e. the line is visibly unfinished). A boundary check on the char
//       immediately before a matched single-char token excludes it being the tail of a LONGER/different
//       token (`++`, `--`), which are NOT continuation cues.
// Deliberately narrow (symbol tokens only — no named infix functions like `a shl b`, which need word-
// boundary + identifier disambiguation this does not attempt): an unrecognized continuation shape is not
// "maybe" handled, it simply isn't, and the expression ends there, same as before this fix.
const KOTLIN_TRAILING_OPS = ['===', '!==', '->', '<=', '>=', '==', '!=', '&&', '||', '?:', '..', '::', '+', '-', '*', '/', '%', '<', '>'];
function kotlinLineContinues(mask, nlIdx) {
  let q = nlIdx + 1;
  while (q < mask.length && /\s/.test(mask[q])) q++;
  if (mask[q] === '.') return true; // chain call/property
  if (mask[q] === '?' && (mask[q + 1] === '.' || mask[q + 1] === ':')) return true; // safe call / elvis
  if (mask[q] === ':' && mask[q + 1] === ':') return true; // method/property reference

  let p = nlIdx - 1;
  while (p >= 0 && (mask[p] === ' ' || mask[p] === '\t' || mask[p] === '\r')) p--;
  if (p < 0 || mask[p] === '\n') return false; // blank line before the break — nothing to be unfinished
  for (const op of KOTLIN_TRAILING_OPS) {
    const from = p - op.length + 1;
    if (from < 0 || mask.slice(from, p + 1) !== op) continue;
    const before = mask[from - 1];
    if (before !== undefined && /[+\-*/%<>=!&|~^:.?]/.test(before)) continue; // tail of a longer/different token
    return true;
  }
  return false;
}

// Kotlin expression-bodied `fun f(...) = expr`: the body is `expr` itself, spanning to the first top-level
// `;`/newline that does NOT continue the expression (bracket-depth-aware, exactly like arrowSite's
// expression span below, plus kotlinLineContinues — see above — for the line-continuation cases a JS
// arrow expression never has). Deliberately does NOT special-case a `{` the way arrowSite does for a JS
// block-bodied arrow: in Kotlin, `= { ... }` is NEVER a block body (a Kotlin block body is always written
// directly after the signature with no `=` at all) — a `{` appearing here is a lambda LITERAL, i.e. a
// value, so the depth counter simply walks over its `{`…`}` as one more balanced group and the whole
// lambda is replaced as part of the expression, never partially reached into as if it were this function's
// own block. FAILS CLOSED (null) if the scan runs off the end with an unclosed bracket — never a partial
// span that would leave a stray trailing fragment on the mutant.
function kotlinExprSite(code, mask, fromAfterEq, firstParam) {
  let j = fromAfterEq;
  while (j < code.length && /\s/.test(code[j])) j++;
  let end = j, depth = 0;
  for (; end < code.length; end++) {
    const c = mask[end];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (depth === 0 && c === ';') break;
    else if (depth === 0 && c === '\n') {
      if (kotlinLineContinues(mask, end)) continue; // chained/binary continuation — not the end (Bug A fix)
      break;
    }
  }
  if (end === j) return null; // empty expression — malformed, fail safe
  if (depth !== 0) return null; // ran off the end with an unclosed bracket — fail safe, never a partial gut
  return { site: 'arrowExpr', start: j, end, firstParam, originalInner: code.slice(j, end), make: (v) => v };
}

// From just after a Java param list ')', find the body '{' — skipping over an optional `throws Type, ...`
// clause (ordinary text to this scan; only `<...>` generic nesting needs tracking, in case a thrown type
// is generic) — or -1 if this signature has no body (an interface/abstract method, always `;`-terminated
// in Java) or its enclosing scope closes (`}`) first.
function javaBodyBrace(mask, fromIdx) {
  let angle = 0;
  for (let p = fromIdx; p < mask.length; p++) {
    const c = mask[p];
    if (angle === 0) {
      if (c === '{') return p;
      if (c === ';' || c === '}') return -1;
    }
    if (c === '<') angle++;
    else if (c === '>' && angle > 0) angle--;
  }
  return -1;
}

// Replace a named function's body with a gross, guaranteed-non-equivalent return (sidesteps the
// equivalent-mutant problem) — a surviving value-pinned test then proves the oracle hollow. null if the
// function can't be located.
export function grossBreak(code, fn, lang) {
  const loc = locateBody(code, fn, lang);
  if (!loc) return null;
  return code.slice(0, loc.start) + loc.make(gutValueFor(loc.returnType, lang)) + code.slice(loc.end);
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
//
// A return type that is a UNION of two-or-more inline object-literal members (`): { a: X } | { b: Y } {`)
// needs the "still inside the return-type annotation" state to survive EVERY `|`-joined continuation, not
// just the first — after skipping one type-shaped brace, a `|` (found by peeking past whitespace) means
// another union member follows, so `sawColon` stays true for the NEXT `{` too; only when no `|` follows
// does the state drop, so the following `{` is trusted as the real body (confirmatory audit batch A, row
// 3: dropping this state after only one hop mutated the union's SECOND member, leaving the real body — and
// thus the SUT's actual behavior — untouched, a false HOLLOW on every value-pinned test on that fn).
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
        if (/^\s*(?:[A-Za-z_$][\w$]*\s*\??\s*:|readonly\b|\[|\(|\}|\s*$)/.test(inside)) {
          p = k;
          let q = p; while (q < code.length && /\s/.test(mask[q])) q++;
          sawColon = mask[q] === '|'; // a union continuation keeps the return-type state alive
          continue;
        }
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
