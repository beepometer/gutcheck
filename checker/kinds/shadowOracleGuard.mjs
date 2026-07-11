// KIND shadowOracleGuard — flags an expected-value assertion whose expected side is the RESULT of a
// LOCALLY-DEFINED helper that re-derives a NUMBER (a "shadow oracle" that recomputes the production value
// in the test, so production drift cannot fail the assertion). Two shapes are caught: (1) DIRECT — the
// expected arg is a local function call, `expect(x).toBe(shadow())`; and (2) VARIABLE — the expected arg
// is a bare variable assigned from a local function call, `const e = shadow(); expect(x).toBe(e)`. A call
// to a NON-local (imported) function is an independent oracle and is NOT flagged; nor is a local helper
// that returns a dict/list/string/object/constructor (a fixture-builder or formatter, not a numeric
// re-derivation — the gate that lets this tell a real shadow from make_item()/url_to_origin() on real code).
// Window-aware: a // INDEPENDENT-ORACLE: / // SHADOW-OK: marker a few lines above exempts. Active in the
// Node floor; `configure` also emits a Python variant (py-shadow-oracle-guard) for pytest projects; other
// build systems get only the language-agnostic checks until calibrated.
//
// Out of deterministic reach (by design, to stay low-false-positive): re-running the IMPORTED
// system-under-test into a variable — `const e = sut(); expect(sut()).toBe(e)` — because the checker
// cannot know which imported symbol is "production" vs an independent oracle.
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

const DEFAULT_WINDOW = 5;
const DEFAULT_MARKERS = ['// INDEPENDENT-ORACLE:', '// SHADOW-OK:'];
const DEFAULT_DEFS = [
  'function\\s+([A-Za-z_$][\\w$]*)\\s*\\(',
  'const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?\\(',
  'const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?function',
];
// DIRECT shape: the expected arg is `localFn(`.
const DEFAULT_ASSERTIONS = [
  '\\.toBeCloseTo\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\(',
  '\\.toBe\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\(',
  '\\.toEqual\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\(',
  '\\.toStrictEqual\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\(',
  '\\bassertEquals\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\(',
];
// VARIABLE shape, pre-pass: `const|let|var NAME = localFn(` → NAME is a shadow variable (group1=var, group2=callee).
const DEFAULT_VAR_ASSIGNS = [
  '(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(',
];
// VARIABLE shape, assertion: the expected arg is a bare identifier (NOT followed by `(`) — flagged only
// if that identifier is a known shadow variable.
const DEFAULT_VAR_ASSERTIONS = [
  '\\.toBeCloseTo\\(\\s*([A-Za-z_$][\\w$]*)\\s*,',
  '\\.(?:toBe|toEqual|toStrictEqual)\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)',
  '\\bassertEquals\\(\\s*([A-Za-z_$][\\w$]*)\\s*,',
];

// A shadow oracle that matters re-derives a NUMBER the way production does. A helper whose body returns
// a number or computes one (arithmetic) is shadow-eligible; one that returns a dict/list/string/object/
// constructor is a fixture-builder or formatter (real-repo finding: make_item()→{...}, url_to_origin()→
// URL(...)), NOT a numeric re-derivation, and is exempt. This is what lets the check tell GF-1
// (return 142.50) from make_item (return {...}) — both return a literal, only one returns a NUMBER.
const NUMERIC_BODY = /return\s+-?\(?\s*\d|return\s+[^{[("'\n]*[-+*/%]|=>\s*-?\(?\s*\d/;

function bodyOf(scanLines, i) {
  const defLine = scanLines[i];
  const defIndent = defLine.length - defLine.trimStart().length;
  const out = [defLine];
  for (let j = i + 1; j < Math.min(scanLines.length, i + 16); j++) {
    const ln = scanLines[j];
    if (ln.trim() === '') { out.push(ln); continue; }
    if (ln.length - ln.trimStart().length <= defIndent) break; // dedent → end of body
    out.push(ln);
  }
  return out.join('\n');
}

export function detect(text, env) {
  const offenders = [];
  const scanLines = joinLogicalLines(env.strip === false ? text : stripComments(text, env.lang || 'typescript')).split('\n');
  const rawLines = text.split('\n');
  const win = env.windowLines || DEFAULT_WINDOW;
  const allow = new Set(env.allowlist || []);
  const markers = env.markers || DEFAULT_MARKERS;

  // Pre-pass 1: every locally-declared function/arrow name → whether its body is a NUMERIC re-derivation.
  const localDefs = new Map();
  scanLines.forEach((line, i) => {
    for (const src of env.defSrcs || DEFAULT_DEFS) {
      const re = new RegExp(src, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const numeric = NUMERIC_BODY.test(bodyOf(scanLines, i));
        localDefs.set(m[1], (localDefs.get(m[1]) || false) || numeric);
      }
    }
  });
  const eligible = (name) => localDefs.get(name) === true && !allow.has(name);

  // Equivalence exemption (precise, not file-global): `mf = memoize(f); expect(mf(x)).toBe(f(x))` is a
  // wrapper/property test — the EXPECTED helper f is the BASELINE and the ACTUAL side derives from it, so
  // it is not a shadow. A DIRECT flag is exempt only when the assertion's ACTUAL side derives from (or
  // directly references) the expected helper. A genuine shadow merely stored in an array or passed
  // elsewhere (`const reg = [shadow]; expect(value).toBe(shadow())`) is NOT exempt — its actual side
  // (`value`) does not derive from it. Build varName → {local helpers consumed in its assignment}:
  const derivedFrom = new Map();
  for (const line of scanLines) {
    const a = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?!=)(.+)$/.exec(line);
    if (!a) continue;
    const [, v, rhs] = a;
    for (const h of localDefs.keys()) {
      if (h !== v && new RegExp('\\b' + h + '\\b').test(rhs)) {
        if (!derivedFrom.has(v)) derivedFrom.set(v, new Set());
        derivedFrom.get(v).add(h);
      }
    }
  }
  const balancedArg = (s, from) => { let k = from, d = 1; for (; k < s.length && d; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return s.slice(from, k - 1); };
  const topLevelArgs = (s, from) => { const out = []; let k = from, d = 0, start = from; for (; k < s.length; k++) { const c = s[k]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') { if (!d) { out.push(s.slice(start, k)); return out; } d--; } else if (c === ',' && !d) { out.push(s.slice(start, k)); start = k + 1; } } out.push(s.slice(start)); return out; };
  // Both operands of the assertion — order-agnostic so it works for JS `expect(actual).toBe(expected)`,
  // pytest `assert actual == expected`, AND JUnit `assertEquals(expected, actual)` (expected FIRST).
  const operandsOf = (line) => {
    let mm = /\bexpect\s*\(/.exec(line);
    if (mm) {
      const a = balancedArg(line, mm.index + mm[0].length);
      const after = line.slice(mm.index);
      const mb = /\.(?:toBe|toBeCloseTo|toEqual|toStrictEqual|isEqualTo|isCloseTo)\s*\(/.exec(after);
      return [a, mb ? balancedArg(after, mb.index + mb[0].length) : ''];
    }
    mm = /\bassertEquals?\s*\(\s*/.exec(line);
    if (mm) return topLevelArgs(line, mm.index + mm[0].length);
    mm = /\bassert\s+(.+?)\s*[!=]=\s*(.+)$/.exec(line);
    return mm ? [mm[1], mm[2]] : [];
  };
  // Equivalence iff the OTHER operand (not the one holding the expected helper) derives from that helper —
  // `mf = memoize(f); assertEquals(f(x), mf(x))`. A genuine shadow's other operand (`result`) does not.
  const actualDerives = (line, helper) => {
    const hre = new RegExp('\\b' + helper + '\\b');
    const passedArg = new RegExp('[(,]\\s*' + helper + '\\b(?!\\s*[(.])'); // helper passed AS a value
    const ops = operandsOf(line);
    // property test, not a shadow: the expected helper appears on BOTH operands (e.g. `add(x)(y) ==
    // add(x).call(y)` testing currying) — a shadow has the helper on one side and production on the other.
    if (ops.filter((op) => op && hre.test(op)).length >= 2) return true;
    // inline equivalence: an operand transforms the helper, e.g. `curry(f)(x)` / `memoize(f)(x)`
    for (const op of ops) if (op && passedArg.test(op)) return true;
    // variable equivalence: the OTHER operand is a var derived from the helper, e.g. `mf` from memoize(f)
    for (const op of ops) {
      if (!op || hre.test(op)) continue;
      const lead = /([A-Za-z_$][\w$]*)/.exec(op);
      if (lead && derivedFrom.get(lead[1]) && derivedFrom.get(lead[1]).has(helper)) return true;
    }
    return false;
  };
  // Pre-pass 2: variables assigned from a call to a numeric LOCAL helper — a shadow laundered through a
  // variable. varName → callee; an assignment from an imported/non-numeric callee is left alone.
  const shadowVars = new Map();
  for (const line of scanLines) {
    for (const src of env.varAssignSrcs || DEFAULT_VAR_ASSIGNS) {
      const re = new RegExp(src, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const [, varName, callee] = m;
        if (callee && eligible(callee)) shadowVars.set(varName, callee);
      }
    }
  }

  const flagAt = (i) => {
    const window = rawLines.slice(Math.max(0, i - win), i + 1).join('\n');
    if (markers.some((mk) => window.includes(mk))) return false;
    offenders.push({ line: i + 1, token: 'shadow-oracle' });
    return true;
  };

  scanLines.forEach((line, i) => {
    let flagged = false;
    for (const src of env.assertionSrcs || DEFAULT_ASSERTIONS) {
      const re = new RegExp(src, 'g');
      let m;
      while (!flagged && (m = re.exec(line)) !== null) {
        if (eligible(m[1]) && !actualDerives(line, m[1])) flagged = flagAt(i);
      }
    }
    for (const src of env.varAssertionSrcs || DEFAULT_VAR_ASSERTIONS) {
      const re = new RegExp(src, 'g');
      let m;
      while (!flagged && (m = re.exec(line)) !== null) {
        if (shadowVars.has(m[1]) && !allow.has(m[1])) flagged = flagAt(i);
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
  return roots.flatMap((r) => walkFiles(r, ext)).filter((f) => {
    const norm = f.replace(/\\/g, '/');
    return !exclude.some((sub) => norm.includes(sub));
  });
}

const envFor = (spec) => ({
  lang: (spec.params && spec.params.lang) || 'typescript',
  strip: spec.params && spec.params.strip,
  assertionSrcs: (spec.params && spec.params.assertionSrcs) || DEFAULT_ASSERTIONS,
  defSrcs: (spec.params && spec.params.defSrcs) || DEFAULT_DEFS,
  varAssignSrcs: (spec.params && spec.params.varAssignSrcs) || DEFAULT_VAR_ASSIGNS,
  varAssertionSrcs: (spec.params && spec.params.varAssertionSrcs) || DEFAULT_VAR_ASSERTIONS,
  markers: (spec.params && spec.params.markers) || DEFAULT_MARKERS,
  windowLines: (spec.params && spec.params.windowLines) || DEFAULT_WINDOW,
  allowlist: (spec.params && spec.params.allowlist) || [],
});
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
