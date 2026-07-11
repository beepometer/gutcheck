// KIND weakOracleGuard — ADVISORY. Flags a test block that EXERCISES a SUT call but carries NO
// value-PINNING assertion: gut the called function to the mutation probe's gross-break sentinel and every
// assertion still passes (a "weak oracle"). Unlike a wrong VALUE — which goes RED at author-time and never
// commits — a weak oracle is GREEN BY CONSTRUCTION (it asserts nothing discriminating), so it is never
// corrected and survives into the repo, which is exactly why it is statically visible and real signal.
//
// "PIN" = exactly the matchers that FAIL against the sentinel (so they discriminate a gutted function),
// across jest/vitest, node:assert, chai (to / should / direct), and Playwright. "Weak" = the rest
// (toBeDefined / toBeTruthy / toBeGreaterThan / no assertion at all). Precision is bounded by
// assertion-framework dialect coverage AND statically-undecidable cases (a gut that crashes via structure
// access) — so this is a HIGH-RECALL CANDIDATE GENERATOR + an owner advisory, NEVER a hard floor fail. The
// mutation probe (which RUNS the gutted test — no dialect ambiguity) is the decisive precision gate.
import { join } from 'node:path';
import { codeOnly } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

// Matchers that FAIL against a 987654321-style gross-break → they pin a value/shape/throw and discriminate.
export const PIN = new RegExp([
  '\\.(toBe|toEqual|toStrictEqual|toBeCloseTo|toBeLessThan|toBeLessThanOrEqual|toBeNull|toBeUndefined|toBeFalsy|toBeNaN|toContain|toContainEqual|toMatch|toMatchObject|toMatchSnapshot|toMatchInlineSnapshot|toThrow|toThrowError|toHaveLength|toHaveProperty|toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveReturnedWith|toBeInstanceOf)\\b',
  'rejects\\.(toThrow|toBe|toEqual)', 'resolves\\.(toBe|toEqual|toStrictEqual)',
  'assert\\.(equal|deepEqual|strictEqual|deepStrictEqual|notEqual|notDeepEqual|match|throws|rejects)\\b', '\\bassertEquals\\(',
  // node:assert imported destructured (`import { equal } from 'node:assert'`): bare value-pinning calls.
  '(?<![.\\w$])(?:deepStrictEqual|notDeepStrictEqual|notStrictEqual|strictEqual|deepEqual|notDeepEqual|notEqual|equal|ifError|doesNotThrow|doesNotReject|throws|rejects)\\s*\\(',
  // uvu (`assert.is`) + ava (`t.is`) value-pinning matchers (truthy-only ok/true/truthy stay weak).
  '\\b(?:assert|t)\\.(?:is|equal|deepEqual|deepStrictEqual|not|type|instance|match|regex|like|snapshot|unreachable|throws|notThrows)\\b',
  '\\.to\\.(equal|eql|include|contain|match)\\b', '\\.to\\.deep\\.',
  '\\.to\\.have\\.(length|property|status|members|keys|lengthOf|ownProperty)\\b',
  '\\.to\\.be\\.(true|false|null|undefined|NaN|empty|closeTo|within|above|below|instanceof|a|an)\\b',
  '\\.should\\.(equal|eql|contain|match)\\b', '\\.should\\.deep\\.',
  '\\.should\\.have\\.(length|property|status|members|keys|lengthOf)\\b',
  '\\.should\\.be\\.(true|false|null|undefined|empty|closeTo|within|above|below|instanceof|a|an)\\b',
  '\\.(include|equal|eql|contain|above|below|within)\\(',
  '\\.(toHaveText|toHaveValue|toHaveAttribute|toHaveCount|toHaveClass|toContainText|toHaveURL|toHaveTitle|toHaveScreenshot|toBeVisible|toBeChecked|toBeDisabled)\\b',
].join('|'));
// Gutting the SUT removes its internal call, so toHaveBeenCalled DOES discriminate → treat as a pin.
export const INTERACTION = /\.(toHaveBeenCalled|toHaveBeenCalledTimes)\b|\.not\.toHaveBeenCalled\b/;
export const FRAMEWORK = new Set(['expect', 'assert', 'it', 'test', 'describe', 'context', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'vi', 'jest', 'fn', 'mock', 'spyOn', 'fc', 'require', 'import', 'Promise', 'Array', 'Object', 'JSON', 'String', 'Number', 'Boolean', 'Map', 'Set', 'console', 'setTimeout', 'setInterval', 'clearTimeout', 'Date', 'Error', 'parseInt', 'parseFloat', 'expectTypeOf', 'waitFor', 'act', 'render', 'cleanup', 'suite', 'chai']);

export function matchBrace(s, open) { let d = 0; for (let i = open; i < s.length; i++) { const c = s[i]; if (c === '{') d++; else if (c === '}' && --d === 0) return i; } return s.length; }
// yield each it()/test() callback BODY + the source index of the it/test keyword (for line numbers)
export function* testBlocks(code) {
  // STANDALONE it()/test() only — a negative lookbehind excludes a method call like a regex `.test(model)`
  // or `foo.it(...)`, which would otherwise be mistaken for a test block in a co-located source file.
  const re = /(?<![.\w$])(?:it|test)\s*\(/g; let m;
  while ((m = re.exec(code))) {
    const win = code.slice(m.index, m.index + 4000);
    const bm = /(?:=>|function\s*[A-Za-z_$]*\s*\([^)]*\))\s*\{/.exec(win);
    if (!bm) continue;
    const open = m.index + bm.index + bm[0].length - 1;
    yield { body: code.slice(open + 1, matchBrace(code, open)), index: m.index };
  }
}
// count calls to non-framework identifiers (a SUT-shaped call), not method-on-matcher calls
export function sutCallCount(body) {
  let n = 0;
  for (const mm of body.matchAll(/(?:^|[^.\w$])([A-Za-z_$]\w*)\s*\(/g)) {
    const id = mm[1];
    if (!FRAMEWORK.has(id) && !/^(if|for|while|switch|catch|return|await|new|typeof|function|async|do|else)$/.test(id)) n++;
  }
  return n;
}
const lineOf = (code, idx) => code.slice(0, idx).split('\n').length;

export function detect(text, env) {
  const lang = (env && env.lang) || 'typescript';
  let code; try { code = codeOnly(text, lang); } catch { return []; }
  const out = [];
  for (const { body, index } of testBlocks(code)) {
    if (PIN.test(body) || INTERACTION.test(body)) continue; // a pin → SOUND
    if (sutCallCount(body) > 0) out.push({ line: lineOf(code, index), token: 'weak-oracle: a SUT call with no value-pinning assertion (a gutted impl would still pass — probe it)' });
  }
  return out;
}

// Only actual TEST files — a test root often co-locates source (src/foo.ts next to src/foo.test.ts); a
// source file is not a test and `it`/`test` there would be a false block.
export const TEST_FILE = /(?:\.(?:test|spec)\.|\/(?:test|tests|__tests__|spec)\/)/;
export function corpus(spec, config, ctx) {
  const ext = config.language.fileExt;
  const roots = (ctx.testSrcRoots && ctx.testSrcRoots.length)
    ? ctx.testSrcRoots
    : (config.paths.srcRoots.test || []).map((r) => join(ctx.repoRoot, r));
  const exclude = (spec.params && spec.params.excludePathSubstrings) || [];
  return roots.flatMap((r) => walkFiles(r, ext))
    .filter((f) => TEST_FILE.test(f.replace(/\\/g, '/')) && !exclude.some((sub) => f.replace(/\\/g, '/').includes(sub)));
}

const envFor = (spec) => ({ lang: (spec.params && spec.params.lang) || 'typescript' });
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
