// mutation/changes.mjs — pure analysis for the diff verification report: which top-level functions a
// diff touched, classified later by what the probe proved about them. Enumeration tracks the probe's
// guttable grammar (grammar-sync tested, both directions): everything enumerated is guttable, so
// report reach never exceeds probe reach.
//
// KNOWN DELTA (guttable by the probe, deliberately UNENUMERATED here): object-property function
// values (`name: function () {}` inside a top-level object literal). Line-anchored enumeration
// cannot distinguish an exported API object from a nested config literal, so enumerating the form
// would flood the report with config callbacks — precision first. Pinned both ways by the
// known-delta test in test/changes.test.mjs.
//
// Shared blind spots (verified consistent on BOTH sides — grossBreak refuses them AND this module
// does not enumerate them, so there is no delta; do not re-litigate):
//   - TS type-annotated const: `const f: Handler = (x) => …` — the `: Type` breaks both grammars.
//   - bare object-property arrow: `name: (x) => …` — the probe's `:` form requires `function`.
import { codeOnly } from '../checker/lexer.mjs';

// JS/TS top-level declaration forms (the grossBreak grammar): function/async function/function*,
// export and export-default variants, const/let/var name = (…)=>/function. Class methods
// deliberately absent.
const JS_DECL = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;

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

export function declaredFns(code, lang) {
  const masked = codeOnly(code, lang === 'python' ? 'python' : 'typescript');
  const lines = masked.split('\n');
  const out = [];
  if (lang === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]); // top-level only: no leading indent
      if (!m) continue;
      let lastNonBlank = i; // fallback: def with no body lines at all → endLine === line
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (ln.trim() === '') continue; // blank line: not the terminator, not part of the span either
        if (ln.length - ln.trimStart().length === 0) break; // column-0 nonblank: the next top-level stmt
        lastNonBlank = j;
      }
      out.push({ fn: m[1], line: i + 1, endLine: lastNonBlank + 1 });
    }
    return out;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = JS_DECL.exec(lines[i]);
    if (!m) continue;
    out.push({ fn: m[1] || m[2], line: i + 1, endLine: jsEndLine(lines, i) });
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
  const refEligible = (b, fn) => {
    if (b.verdict === 'skipped' || b.verdict === 'inconclusive') return true;
    if (b.verdict === 'caught') return !(b.caughtFns || []).includes(fn);
    if (b.verdict === 'hollow') return !(b.survivors || []).includes(fn);
    return false;
  };
  for (const { file, granularity, decls } of changedByFile) {
    for (const { fn, line } of decls) {
      const hollowIn = blockRecords.filter((b) => b.verdict === 'hollow' && (b.survivors || []).includes(fn));
      const provenIn = blockRecords.filter((b) => b.verdict === 'caught' && (b.caughtFns || []).includes(fn));
      const pick = (bs) => bs.map((b) => ({ file: b.file, line: b.line, name: b.name }));
      if (hollowIn.length) { changes.push({ file, fn, line, status: 'hollow', granularity, evidence: { blocks: pick(hollowIn) } }); continue; }
      if (provenIn.length) { changes.push({ file, fn, line, status: 'proven', granularity, evidence: { blocks: pick(provenIn) } }); continue; }
      const refs = blockRecords.filter((b) => refEligible(b, fn) && ref(b.bodyMasked || '', fn));
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
  return { changes, changeSummary: { files: changedByFile.length, fns: changes.length, proven: n('proven'), hollow: n('hollow'), unverifiable: n('unverifiable'), untested: n('untested') } };
}
