// KIND assertionFreeTest — the high-precision strict subset of weakOracleGuard: a test file that EXERCISES
// code (a test block with a SUT call) but contains ZERO assertions of ANY framework. There is no dialect
// ambiguity here — a file with no assertion token at all cannot verify anything, so gutting any function it
// calls is invisible. Higher confidence than weakOracleGuard (which depends on classifying matcher
// strength), so it can read as a near-certain finding rather than a candidate. Still shipped advisory: a
// file may legitimately be a type-only / smoke / scaffolding test, and the owner decides.
import { join } from 'node:path';
import { codeOnly } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';
import { testBlocks, sutCallCount, TEST_FILE } from './weakOracleGuard.mjs';

// ANY assertion token, across frameworks — broad on purpose so a file that DOES assert is never mis-flagged.
// The bare-call group catches node:assert imported destructured (`import { equal, ok } from 'node:assert'`).
const ASSERTION = /\bexpect\s*\(|\bassert\b|\.should[.( ]|\bshould\s*\(|\bt\.(is|not|deepEqual|truthy|falsy|throws|notThrows|regex|fail)\b|\.(toBe|toEqual|toThrow|toMatch|toContain|toHave|toBeDefined|toBeTruthy|toBeNull|toBeGreaterThan|toBeLessThan)\b|\.(to|should)\.[a-z]|(?<![.\w$])(?:deepStrictEqual|notDeepStrictEqual|notStrictEqual|strictEqual|deepEqual|notDeepEqual|notEqual|equal|ifError|doesNotThrow|doesNotReject|throws|rejects|ok)\s*\(/;

export function detect(text, env) {
  const lang = (env && env.lang) || 'typescript';
  let code; try { code = codeOnly(text, lang); } catch { return []; }
  if (ASSERTION.test(code)) return []; // the file asserts something somewhere → not assertion-free
  for (const { body, index } of testBlocks(code)) {
    if (sutCallCount(body) > 0) return [{ line: code.slice(0, index).split('\n').length, token: 'assertion-free test: exercises code but contains zero assertions of any framework' }];
  }
  return [];
}

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
