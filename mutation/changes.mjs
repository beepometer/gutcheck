// mutation/changes.mjs — pure analysis for the diff verification report: which functions a diff
// touched, classified later by what the probe proved about them. Enumeration tracks the probe's
// guttable grammar (grammar-sync tested, both directions): everything enumerated is guttable, so
// report reach never exceeds probe reach.
//
// KNOWN DELTA (guttable by the probe, deliberately UNENUMERATED here): object-property function
// EXPRESSION values (`name: function () {}` inside a top-level object literal — the `:`-bound form,
// as opposed to the shorthand-method form `name() {}` enumerated by jsMethodDecls below). Line-
// anchored enumeration cannot distinguish an exported API object from a nested config literal, so
// enumerating the `: function` form would flood the report with config callbacks — precision first.
// Pinned both ways by the known-delta test in test/changes.test.mjs.
//
// Shared blind spots (verified consistent on BOTH sides — grossBreak refuses them AND this module
// does not enumerate them, so there is no delta; do not re-litigate):
//   - TS type-annotated const: `const f: Handler = (x) => …` — the `: Type` breaks both grammars.
//   - bare object-property arrow: `name: (x) => …` — the probe's `:` form requires `function`.
import { codeOnly } from '../checker/lexer.mjs';

// JS/TS top-level declaration forms (the grossBreak grammar): function/async function/function*,
// export and export-default variants, const/let/var name = (…)=>/function. Class methods and
// object-shorthand methods are handled separately by jsMethodDecls (below) — a materially different,
// keyword-free grammar (no `function`/`const`/`=` at all), kept as its own pass so this regex and its
// per-line loop stay untouched for every case they already handled.
const JS_DECL = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;

// JS/TS class-method / object-shorthand-method declarations: `[async] [*] NAME(params) {` with none of
// JS_DECL's keywords. Discriminated from a call site — mirrors probe.mjs's locateBareMethod (Fix B),
// kept in sync — by three checks, ALL required, on the comment/string mask:
//   1. the char immediately preceding the whole signature (skip whitespace, may cross a line) is a
//      member/statement boundary: `{` (class-body/object-literal open), `,` (prior object member),
//      `;` (prior statement), or `}` (prior member's close) — never `.`/`=`/`(`/an identifier char.
//   2. NAME is not a JS/TS keyword (JS_METHOD_NON_NAMES) — the load-bearing check here, since this
//      scan runs over every identifier in the file, not one caller-supplied name: without it,
//      `if (x) {` inside a function body reads exactly like a decl of `if` (preceded by `{`, followed
//      by a block) and `while (bar()) {` like a decl of `while`.
//   3. the paren-balanced params are followed (only whitespace between) by a body block `{` — a call
//      has no trailing block (`foo(x);` fails this; `bar` in `while (bar()) {` fails check 1 instead,
//      since it is preceded by `(`).
// Operates on the FULL mask (not per-line, unlike JS_DECL) because the boundary char can sit on the
// previous line and params may wrap. Any ambiguity → not enumerated (recall loss, never a phantom row).
const JS_METHOD_NON_NAMES = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'catch', 'try', 'finally', 'return', 'function',
  'typeof', 'instanceof', 'new', 'delete', 'void', 'yield', 'await', 'class', 'super', 'this',
  'in', 'of', 'throw', 'with',
]);
function jsMethodDecls(masked) {
  const out = [];
  const re = /(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    if (JS_METHOD_NON_NAMES.has(name)) continue;

    let p = m.index - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (p < 0 || !'{,;}'.includes(masked[p])) continue; // not preceded by a member/statement boundary

    const parenOpen = m.index + m[0].length - 1;
    let depth = 0, i = parenOpen;
    for (; i < masked.length; i++) { const c = masked[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) { i++; break; } } }
    if (depth !== 0) continue; // unbalanced — malformed or ran off the end

    let q = i;
    while (q < masked.length && /\s/.test(masked[q])) q++;
    if (masked[q] !== '{') continue; // no trailing block — a call, not a method decl

    out.push({ name, index: m.index });
  }
  return out;
}

function jsEndLine(lines, startIdx) {
  let depth = 0, seen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true; }
      else if (ch === '}') { depth--; if (seen && depth === 0) return i + 1; }
    }
    if (!seen && /;\s*$/.test(lines[i])) return i + 1; // one-line arrow `const f = (x) => x;`
  }
  return lines.length;
}

// JVM (Task 9): Kotlin `fun` and Java method declarations ONLY — the guttable units. Classes / objects /
// interfaces / enums are DELIBERATELY NOT enumerated: grossBreak (via probe.mjs's locateJvmBody) can gut
// a `fun NAME(` / `TYPE NAME(` body but never a TYPE declaration, so enumerating a class name would break
// the file-header invariant "everything enumerated is guttable, report reach never exceeds probe reach".
// An enumerated-but-ungettable class could only ever land as untested/unverifiable in classifyChanges,
// permanently — and a class span covers its whole body, so it would emit that phantom row on nearly every
// real .kt/.java diff, corrupting changeSummary.fns/.untested/.unverifiable. JS enumerates functions only;
// Python `def` only; this matches that. The JVM grammar-sync test in test/changes.test.mjs locks it.
//
// Mirrors the decl-vs-call discipline in prove.mjs's declRe / probe.mjs's locateJvmBody — a call textually
// shaped like a decl (`return add(1, 2)`, or an anonymous-class instantiation `new Runnable() {`) must
// never become a phantom fn (JAVA_NON_TYPE_WORDS rejects any match whose TYPE or NAME slot is a keyword;
// kept as a local copy since this module does not import from probe.mjs/prove.mjs).
//
// Kotlin: `fun NAME(` — modifiers, a generic `<T>`, and a receiver `Foo.` may precede; NAME is always the
// bare fn name. Java: `TYPE NAME(params) [throws ...] {` — a call site never has the trailing `{`.
const KOTLIN_DECL = /\bfun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\s*(?:<[^>]*>\s*)?\(/;
const JAVA_NON_TYPE_WORDS = new Set([
  'return', 'throw', 'new', 'yield', 'case', 'else', 'do', 'instanceof', 'synchronized',
  'assert', 'catch', 'finally', 'try', 'while', 'for', 'if', 'switch', 'super', 'this',
]);
const JAVA_DECL = /\b([A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[^{;]*)?\{/;

// endLine: if the decl's own line opens a block (`{`), brace-balance to the matching close (jsEndLine,
// shared with the JS path above); otherwise (a Kotlin expression body `= expr`, a bodyless Kotlin
// class/primary-constructor, or any decl whose signature we don't chase across lines) endLine === line
// — generous-but-safe: it can never reach into a later decl, which is all changedDecls' overlap check needs.
function jvmEndLine(lines, i) {
  return /\{/.test(lines[i]) ? jsEndLine(lines, i) : i + 1;
}

export function declaredFns(code, lang) {
  const jvmGrammar = lang === 'kotlin' ? 'kotlin' : lang === 'java' ? 'java' : null;
  const masked = codeOnly(code, lang === 'python' ? 'python' : jvmGrammar || 'typescript');
  const lines = masked.split('\n');
  const out = [];
  if (lang === 'python') {
    // Any indentation — column 0 (top-level) AND indented (class methods) are both enumerated. endLine
    // is INDENT-RELATIVE (not column-0-relative): it breaks at the next nonblank line whose indent is
    // <= this def's own indent, so a method's span stops at its dedent (the next sibling method, or the
    // class's own end) instead of swallowing the rest of the class/file the way a fixed column-0 check
    // would for an indented def.
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      let lastNonBlank = i; // fallback: def with no body lines at all → endLine === line
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (ln.trim() === '') continue; // blank line: not the terminator, not part of the span either
        if (ln.length - ln.trimStart().length <= indent) break; // dedent to <= own indent: next sibling/end
        lastNonBlank = j;
      }
      out.push({ fn: m[2], line: i + 1, endLine: lastNonBlank + 1 });
    }
    return out;
  }
  if (jvmGrammar === 'kotlin') {
    for (let i = 0; i < lines.length; i++) {
      const m = KOTLIN_DECL.exec(lines[i]);
      if (!m) continue;
      out.push({ fn: m[1], line: i + 1, endLine: jvmEndLine(lines, i) });
    }
    return out;
  }
  if (jvmGrammar === 'java') {
    for (let i = 0; i < lines.length; i++) {
      const m = JAVA_DECL.exec(lines[i]);
      if (!m) continue; // m[1]=TYPE, m[2]=NAME, m[3]=params
      if (JAVA_NON_TYPE_WORDS.has(m[1]) || JAVA_NON_TYPE_WORDS.has(m[2])) continue; // a call, not a decl
      out.push({ fn: m[2], line: i + 1, endLine: jvmEndLine(lines, i) });
    }
    return out;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = JS_DECL.exec(lines[i]);
    if (!m) continue;
    out.push({ fn: m[1] || m[2], line: i + 1, endLine: jsEndLine(lines, i) });
  }
  for (const md of jsMethodDecls(masked)) {
    const line = masked.slice(0, md.index).split('\n').length; // 1-based
    out.push({ fn: md.name, line, endLine: jsEndLine(lines, line - 1) });
  }
  return out;
}

export function hunkNewRanges(diffText) {
  const out = [];
  for (const m of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    out.push(count === 0 ? [start, start] : [start, start + count - 1]);
  }
  return out;
}

export function changedDecls(code, lang, ranges) {
  const decls = declaredFns(code, lang);
  if (ranges === null) return decls;
  return decls.filter((d) => ranges.some(([a, b]) => d.line <= b && d.endLine >= a));
}

// Status precedence: execution evidence outranks name-search evidence; hollow outranks proven is
// WRONG — a fn both caught (by one test) and survived (by another) is reported HOLLOW: one green
// mutant is a hole regardless of other tests catching it. Precedence: hollow > proven > unverifiable > untested.
export function classifyChanges(changedByFile, blockRecords) {
  const changes = [];
  const ref = (body, fn) => new RegExp(`(?<![\\w$])${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(body);
  // A block VERDICTED caught/hollow still pins its OWN fn list (caughtFns/survivors) — but it can also
  // MENTION a different changed fn it never pinned (e.g. a companion weak assertion in the same block).
  // That mention is real reference evidence: the fn isn't untested ("no test mentions it" would be
  // false), it's just not verified by THIS block — "this block pins a different fn" is 'no-pin', exactly
  // the same reason a skipped/no-pin block gets. Only reached for a fn NOT already in that block's own
  // fn list — a fn that IS in the list was already claimed by hollowIn/provenIn above, before this runs.
  // (fn, file)-PAIR attribution (fail-closed): a caughtFns/survivors bare name says only "some function
  // named `fn` was pinned/circular somewhere" — with no file identity, a same-named fn in an unrelated file
  // would be mis-attributed a verdict that was never established for it (false PROVEN / false HOLLOW). Every
  // caught/hollow blockRecord carries caughtPairs/survivorPairs (prove.mjs, built from the same sutOf map
  // that selected the gut target — see that file's comment), so attribution here is a pure (fn, file)
  // membership test. NO bare-name fallback: a record without pairs attributes nothing — 'proven'/'hollow'
  // are positive claims, so an unattributable block must never manufacture one; the fn falls through to the
  // refs/untested classification below exactly as if the block had never verdicted it at all.
  const refEligible = (b, fn, file) => {
    if (b.verdict === 'skipped' || b.verdict === 'inconclusive') return true;
    if (b.verdict === 'caught') return !(b.caughtPairs || []).some((p) => p.fn === fn && p.sutRel === file);
    if (b.verdict === 'hollow') return !(b.survivorPairs || []).some((p) => p.fn === fn && p.sutRel === file);
    return false;
  };
  for (const { file, granularity, decls } of changedByFile) {
    for (const { fn, line } of decls) {
      const hollowIn = blockRecords.filter((b) => b.verdict === 'hollow' && (b.survivorPairs || []).some((p) => p.fn === fn && p.sutRel === file));
      const provenIn = blockRecords.filter((b) => b.verdict === 'caught' && (b.caughtPairs || []).some((p) => p.fn === fn && p.sutRel === file));
      // pick() carries `testChanged` per block WHEN the source record set it (prove.mjs sets it only on
      // CAUGHT records — see that file's comment) — omitted (not `undefined`) otherwise. A caught block
      // CAN be picked up as reference evidence on a hollow/unverifiable row too (e.g. a mock-only
      // assertion admitted via refEligible), so its evidence.blocks entry carries `testChanged` there as
      // well — the field is NOT byte-identical-absent on those rows. What IS still true: no count or
      // rendered surface reads `blocks[].testChanged` on a hollow/unverifiable row — only a 'proven' row's
      // sameDiffOracle computation consumes it.
      const pick = (bs) => bs.map((b) => {
        const row = { file: b.file, line: b.line, name: b.name };
        if (b.testChanged !== undefined) row.testChanged = b.testChanged;
        return row;
      });
      if (hollowIn.length) { changes.push({ file, fn, line, status: 'hollow', granularity, evidence: { blocks: pick(hollowIn) } }); continue; }
      if (provenIn.length) {
        // SAME-DIFF-ORACLE PROVENANCE (Task 7): a proven verdict never gets a second-guessing footnote
        // about the test's authorship intent — we CAN state a fact the engine already computes and
        // discards, though: whether the binding test's FILE was itself changed in this diff. sameDiffOracle
        // is true only when EVERY binding block came from a changed test file (a fn proven partly by
        // pre-existing coverage is not "proven only by a same-diff test"). FACT-ONLY: states what changed
        // alongside what, never a verdict on why it changed.
        const blocks = pick(provenIn);
        const sameDiffOracle = blocks.length > 0 && blocks.every((b) => b.testChanged === true);
        changes.push({ file, fn, line, status: 'proven', granularity, evidence: { blocks, sameDiffOracle } });
        continue;
      }
      // wrongLayerShadow (mutation/wrongLayerShadow.mjs): a block that is BOTH zero-production-contact AND
      // a self-echo/tautological assertion (prove() attaches both signals — JVM-only — to the blockRecord;
      // see its header comment for the conjunction's soundness argument + why the hard hollow is JVM-gated)
      // can never soundly test ANY production function. It is charged against changed fn F ONLY when the
      // block's TITLE resolved to F via resolveJvmSut — prove() precomputed that as `shadowTargets`
      // (candidate SUT tokens from the title, each mapped to its declaring src/main file), so attribution
      // here is a pure (fn, file) membership test. A fn whose name only appears in the echoed expression is
      // never in shadowTargets, so it is never charged (the removed echo-token path was a false-HOLLOW
      // vector). No matching shadowTarget → no verdict here at all (never a mis-attributed hollow) — F
      // falls through to the refs/untested classification below exactly as without this signal. Checked
      // BEFORE refs so a proven shadow outranks the weaker "some test merely mentions this name"
      // unverifiable call. Byte-identical when absent: existing blockRecords never set noContact/selfEcho/
      // shadowTargets, so this `find` always returns undefined on any pre-existing call site.
      const shadow = blockRecords.find((b) => b.noContact && b.selfEcho && (b.shadowTargets || []).some((t) => t.fn === fn && t.sutRel === file));
      if (shadow) {
        changes.push({ file, fn, line, status: 'hollow', granularity, evidence: { reason: 'wrong-layer-shadow', echo: shadow.selfEcho.expr, blocks: [{ file: shadow.file, line: shadow.line, name: shadow.name }] } });
        continue;
      }
      const refs = blockRecords.filter((b) => refEligible(b, fn, file) && ref(b.bodyMasked || '', fn));
      if (refs.length) {
        const reasons = {};
        for (const b of refs) {
          const why = (b.verdict === 'caught' || b.verdict === 'hollow') ? 'no-pin' : (b.why || 'inconclusive');
          reasons[why] = (reasons[why] || 0) + 1;
        }
        const reason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0][0];
        changes.push({ file, fn, line, status: 'unverifiable', granularity, evidence: { reason, reasons, blocks: pick(refs) } });
        continue;
      }
      changes.push({ file, fn, line, status: 'untested', granularity, evidence: {} });
    }
  }
  const n = (s) => changes.filter((c) => c.status === s).length;
  // PROBE-CAP OUT OF `unverifiable` (Task 7): a probe-cap row IS unverifiable (the reference is real, the
  // block just never ran under the cap) — the row's own `status`/`evidence.reason` stay exactly as
  // before (JSON consumers of changes[].status are unaffected). Only the SUMMARY splits it out: it would
  // otherwise be lumped in with genuinely-unverifiable (mock-only, etc.), overstating that count.
  // notProbed + unverifiable always sums to the pre-split unverifiable total (n('unverifiable')).
  const unverifiableRows = changes.filter((c) => c.status === 'unverifiable');
  const notProbedCount = unverifiableRows.filter((c) => c.evidence.reason === 'probe-cap').length;
  const sameDiffProven = changes.filter((c) => c.status === 'proven' && c.evidence.sameDiffOracle === true).length;
  return {
    changes,
    changeSummary: {
      files: changedByFile.length, fns: changes.length, proven: n('proven'), hollow: n('hollow'),
      unverifiable: unverifiableRows.length - notProbedCount, untested: n('untested'),
      notProbed: notProbedCount, sameDiffProven,
    },
  };
}
