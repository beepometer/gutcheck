// KIND assertionConsistency — a deterministic test-CORRECTNESS check. Collects every assertion of the
// shape `fn(<literal args>) == <literal value>` in a file (any assertion order — it auto-classifies which
// operand is the call and which is the literal) and flags when the SAME pure call is asserted to TWO
// DIFFERENT values. A pure call with literal args is deterministic, so two different expected values is a
// contradiction — one test is wrong (a copy-paste with a stale expected, or a genuine disagreement). Pure
// and deterministic: no eval, no network. High-precision by design: only calls whose args are ALL literals
// (a variable arg → skip, the value could legitimately differ), numeric/string/bool literal values only,
// and numeric values compared by magnitude (so 120 and 120.0 are the same, not a false contradiction).
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

// a BARE free function (no `.`/`::` receiver — a method on an object is stateful, so the same call can
// legitimately return different values across tests), parens, and args that are ALL literals (a single
// variable arg like `transform` means the result can legitimately differ → not a contradiction).
const LIT = '(?:-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|"[^"]*"|\'[^\']*\'|`[^`]*`|true|false|True|False|None|null|nil)';
const RE_LITERAL_CALL = new RegExp(`^[A-Za-z_]\\w*\\(\\s*${LIT}(?:\\s*,\\s*${LIT})*\\s*\\)$`);
const isLiteralCall = (s) => RE_LITERAL_CALL.test(s.trim());
const isLiteralVal = (s) => /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$|^[fFlLdD]?["'`].*["'`]$|^(?:true|false|True|False)$/.test(s.trim());
const normVal = (s) => { const t = s.trim(); const n = Number(t); return /^[-+]?[0-9.]/.test(t) && Number.isFinite(n) ? String(n) : t.replace(/^[fFlLdD]/, '').replace(/["'`]/g, ''); };
// strip whitespace OUTSIDE string literals only — a space INSIDE a string arg ('User Service') is
// significant and must not collapse into a different arg ('UserService').
const normCall = (s) => { let out = ''; let inStr = false; let q = ''; for (const c of s) { if (inStr) { out += c; if (c === q) inStr = false; } else if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; out += c; } else if (!/\s/.test(c)) out += c; } return out; };

export function detect(text, env) {
  const lang = env.lang || 'typescript';
  // strip comments (so a value in a comment isn't matched), KEEP strings (string expected values are real),
  // join logical lines so a multi-line assertion is one line.
  const lines = joinLogicalLines(stripComments(text, lang)).split('\n');
  const srcs = (env.assertionSrcs || []).map((s) => new RegExp(s));
  // names DEFINED locally in this file (const/let/var/function/def/fn) — a call to one of these is not a
  // stable pure function (it is commonly redefined per test, e.g. `const updater = …`), so skip it.
  const localDefs = new Set();
  const joined = lines.join('\n');
  for (const dm of joined.matchAll(/(?:const|let|var|function|def|fn|func)\s+([A-Za-z_]\w*)/g)) localDefs.add(dm[1]);
  // Only compare assertions WITHIN one test case: across `it`/`test`/`def test_…`/`func Test…` boundaries
  // the setup (fixtures, mocks, module state) differs, so the same call can legitimately return different
  // values (a function reading mocked localStorage, etc.). A contradiction within ONE case is a real bug.
  const boundary = new RegExp(env.testBoundarySrc || '\\b(?:it|test|describe|context|beforeEach|afterEach)\\s*\\(|\\bTEST(?:_[FP])?\\s*\\(|\\b(?:SECTION|SCENARIO)\\s*\\(|^\\s*(?:async\\s+)?def\\s+test|^\\s*func\\s+Test|^\\s*#\\[test\\]|@Test\\b');
  // a call whose name signals EXTERNAL / MUTABLE state (env, file, clock, random, …) is not pure — it can
  // return different values across assertions even with identical literal args, so skip it.
  const IMPURE = /env|random|rand|now|time|current|today|read|fetch|load|query|http|file|open|input|clock|date|uuid|guid/i;
  const seen = new Map(); // normalizedCall -> first asserted value (reset at each test boundary)
  const offenders = [];
  lines.forEach((line, i) => {
    if (boundary.test(line)) seen.clear();
    for (const re of srcs) {
      const m = re.exec(line);
      if (!m || m.length < 3 || m[1] == null || m[2] == null) continue;
      const a = m[1].trim(); const b = m[2].trim();
      let call; let value;
      if (isLiteralCall(a) && isLiteralVal(b)) { call = a; value = b; } else if (isLiteralCall(b) && isLiteralVal(a)) { call = b; value = a; } else continue;
      const fnName = call.match(/^[A-Za-z_]\w*/)[0];
      if (localDefs.has(fnName) || IMPURE.test(fnName)) continue; // locally-defined or impure → not stable
      const key = normCall(call);
      const v = normVal(value);
      if (seen.has(key)) { if (seen.get(key) !== v) offenders.push({ line: i + 1, token: 'value-contradiction' }); } else seen.set(key, v);
      break;
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

const envFor = (spec) => ({ lang: (spec.params && spec.params.lang) || 'typescript', assertionSrcs: (spec.params && spec.params.assertionSrcs) || [] });
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
