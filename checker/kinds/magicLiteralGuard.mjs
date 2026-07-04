// KIND magicLiteralGuard — flags a numeric literal in an expected-value assertion that carries no
// derivation (no inline arithmetic/URL comment, no opt-out marker). Window-aware: the derivation
// comment may sit a few lines above. Mirrors testShapeGuard (scanLines = comment-stripped code;
// rawLines = the exemption surface). Active in the Node floor; `configure` also emits a Python-flavoured
// variant (py-magic-literal-guard) for pytest projects; other build systems get only the language-agnostic checks.
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

const DEFAULT_WINDOW = 5; // engineering-judgment: same convention as testShapeGuard ignoreRule.windowLines (testShapeGuard.mjs:27)
const DEFAULT_TRIVIAL = ['0', '1', '-1'];
const DEFAULT_MARKERS = ['// CLOSED-FORM-ORACLE:'];
const DEFAULT_ASSERTIONS = [
  '\\.toBeCloseTo\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s*,',
  // toBe/toEqual: require >=3 fractional digits. Short decimals (0.5, 1.5) are almost always the
  // self-evident round result of an input literal in the same call (real-repo finding: 5/5 JS FPs
  // were 1-digit decimals); genuinely uncited golden/snapshot floats are long. toBeCloseTo stays broad.
  '\\.(?:toBe|toEqual)\\(\\s*(-?\\d+\\.\\d{3,})\\s*\\)',
];
const DEFAULT_DERIVATION = '(?://|/\\*).*(?:https?://|[0-9].*[-+*/^].*[0-9]|=\\s*[-+(]?\\s*[0-9])';
// A derivation embedded in the assertion's MESSAGE STRING — `assertEquals("x = 5.0/√6", 2.04…, …)` —
// is a cited value, not a magic literal. The message is blanked in scanLines (so the float is still
// found), but the RAW window keeps the string; exempt when a quoted string carries a formula (`= <num>`
// or `<num> <op> <num>`, incl. the √ used in scientific tests). Common, good JVM practice.
const DEFAULT_MSG_DERIVATION = '(["\'`])[^"\'`]{0,200}(?:=\\s*[-+(√]?\\s*[\\d.]|[\\d.][^"\'`]{0,40}[-+*/^√][^"\'`]{0,40}[\\d.√])[^"\'`]{0,200}\\1';

export function detect(text, env) {
  const offenders = [];
  // Blank strings too (not just comments): a numeric EXPECTED literal is always code, never inside a
  // string — so blanking strings kills false matches like `Specifier("===1.0")` / version-spec strings
  // (real-repo finding: packaging threw 322, mostly `==1.0` inside string literals). Derivation/marker
  // exemptions still read the RAW lines, so inline `// = a*b` comments are unaffected.
  const scanLines = joinLogicalLines(stripComments(text, env.lang || 'typescript', { blankStrings: true })).split('\n');
  const rawLines = text.split('\n');
  const deriv = env.derivationSrc ? new RegExp(env.derivationSrc) : null;
  const msgDeriv = env.messageDerivationSrc ? new RegExp(env.messageDerivationSrc) : null;
  const trivial = new Set(env.trivialAllowlist || DEFAULT_TRIVIAL);
  const win = env.windowLines || DEFAULT_WINDOW;
  scanLines.forEach((line, i) => {
    for (const src of env.assertionSrcs || DEFAULT_ASSERTIONS) {
      const re = new RegExp(src, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const lit = (m[1] || '').trim();
        if (!lit || trivial.has(lit)) continue;
        const window = rawLines.slice(Math.max(0, i - win + 1), i + 1).join('\n');
        if ((env.markers || DEFAULT_MARKERS).some((mk) => window.includes(mk))) continue;
        if (deriv && deriv.test(window)) continue;
        if (msgDeriv && msgDeriv.test(window)) continue; // derivation in the assertion's message string
        offenders.push({ line: i + 1, token: 'magic-literal' });
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
  assertionSrcs: (spec.params && spec.params.assertionSrcs) || DEFAULT_ASSERTIONS,
  derivationSrc: (spec.params && spec.params.derivationSrc) || DEFAULT_DERIVATION,
  messageDerivationSrc: (spec.params && spec.params.messageDerivationSrc) || DEFAULT_MSG_DERIVATION,
  markers: (spec.params && spec.params.markers) || DEFAULT_MARKERS,
  windowLines: (spec.params && spec.params.windowLines) || DEFAULT_WINDOW,
  trivialAllowlist: (spec.params && spec.params.trivialAllowlist) || DEFAULT_TRIVIAL,
});
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
