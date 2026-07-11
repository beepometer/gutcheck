import { test } from 'node:test';
import assert from 'node:assert';
import {
  judge, AGENT_FAMILIES, FAMILY_NAMES, windowedQueries, isRateLimited, shouldSkip,
  dedupDecision, redistributeQuota,
} from './harvest-trailers.mjs';

test('judge: the funnel is mechanical and total (family-agnostic — judge never sees family)', () => {
  const meta = (o) => ({ repoMeta: { full_name: 'a/b', fork: false, size: 100, ...o.r }, files: o.f, parents: o.p ?? [{}] });
  assert.equal(judge(meta({ r: { fork: true }, f: [] }), new Set()), 'fork');
  assert.equal(judge(meta({ r: { size: 999999999 }, f: [] }), new Set()), 'repo-too-large');
  assert.equal(judge(meta({ f: [{ filename: 'src/a.js' }] }), new Set()), 'no-test-file');
  assert.equal(judge(meta({ f: [{ filename: 'test/helper_test.rb' }] }), new Set()), 'no-test-file'); // Ruby test doesn't pass isTestFile
  assert.equal(judge(meta({ f: [{ filename: 'x.test.ts' }], p: [{}, {}] }), new Set()), 'fetch-error'); // merge commit
  // seenRepos is a Map(repo -> owning family); the exclusion label names the slot owner so
  // cross-family repo-slot asymmetry is measurable in the funnel (review finding, 2026-07-04)
  assert.equal(judge(meta({ f: [{ filename: 'x.test.ts' }] }), new Map([['a/b', 'claude']])), 'dup-repo:claude');
  assert.deepEqual(judge(meta({ f: [{ filename: 'x.test.ts' }, { filename: 'src/a.ts' }] }), new Set()), { testFiles: ['x.test.ts'] });
});

test('AGENT_FAMILIES: six families, real (live-verified) query strings, claude reused verbatim', () => {
  assert.deepEqual(FAMILY_NAMES, ['claude', 'copilot', 'cursor', 'devin', 'codex', 'aider']);
  // Regression anchor: the claude family is byte-identical to the pre-generalization flat QUERIES'
  // two Claude entries (same two strings, same order).
  assert.deepEqual(AGENT_FAMILIES.claude, ['"Co-authored-by: Claude"', '"Generated with Claude Code"']);
  for (const family of FAMILY_NAMES) {
    assert.ok(Array.isArray(AGENT_FAMILIES[family]) && AGENT_FAMILIES[family].length >= 1, `${family} has no query strings`);
  }
});

test('windowedQueries: cross-product of base queries × windows, exact format for one sample (claude family)', () => {
  const windows = ['2026-01-01..2026-01-31', '2026-02-01..2026-02-28'];
  const base = AGENT_FAMILIES.claude;
  const result = windowedQueries(base, windows);
  assert.equal(result.length, base.length * windows.length); // 2 bases × 2 windows = 4
  assert.equal(result.length, 4);
  assert.equal(result[0], `${base[0]} committer-date:2026-01-01..2026-01-31`);
  assert.equal(
    windowedQueries(['"X"'], ['2026-01-01..2026-01-31']).join(' | '),
    '"X" committer-date:2026-01-01..2026-01-31',
  );
});

test('isRateLimited: recognizes gh rate-limit failures, not unrelated errors', () => {
  assert.equal(isRateLimited('API rate limit exceeded for user ID 123.'), true);
  assert.equal(isRateLimited('gh: HTTP 403: Forbidden'), true);
  assert.equal(isRateLimited('gh: HTTP 429: Too Many Requests'), true);
  assert.equal(isRateLimited('gh: HTTP 404: Not Found'), false);
  assert.equal(isRateLimited(''), false);
  assert.equal(isRateLimited(undefined), false);
});

test('shouldSkip: a candidate already in the seen-set produces no action (resume idempotence)', () => {
  const seenCandidates = new Set(['a/b@1234567']);
  assert.equal(shouldSkip('a/b@1234567', seenCandidates), true);
  assert.equal(shouldSkip('a/b@abcdef1', seenCandidates), false);
  assert.equal(shouldSkip('a/b@1234567', new Set()), false);
});

test('dedupDecision: prior-run candidate is "resume" (silent), regardless of this run\'s familyOwner state', () => {
  assert.equal(dedupDecision('a/b@1234567', 'claude', new Set(['a/b@1234567']), new Map()), 'resume');
});

test('dedupDecision: the same family re-finding its own candidate (via a second query) is "own-family" (silent)', () => {
  const familyOwner = new Map([['a/b@1234567', 'claude']]);
  assert.equal(dedupDecision('a/b@1234567', 'claude', new Set(), familyOwner), 'own-family');
});

test('dedupDecision: a different family finding an already-claimed candidate returns the OWNING family (first family wins, logged)', () => {
  const familyOwner = new Map([['a/b@1234567', 'claude']]);
  assert.equal(dedupDecision('a/b@1234567', 'copilot', new Set(), familyOwner), 'claude');
});

test('dedupDecision: a brand new candidate (never seen, this run or prior) returns null — proceed', () => {
  assert.equal(dedupDecision('a/b@9999999', 'claude', new Set(), new Map()), null);
});

// Every expected number below is hand-derived from the algorithm's stated spec (min(supply, base)
// base share, floor-proportional shortfall redistribution to rich families, remainder to rich
// families in order) — never pasted from running redistributeQuota and copying its output.

test('redistributeQuota: all-rich — every family supplies far more than its equal share, no redistribution needed', () => {
  // target=12, 3 families, base=ceil(12/3)=4; each family has 100 >> 4, so each just takes its base.
  const quota = redistributeQuota({ a: 100, b: 100, c: 100 }, 12, ['a', 'b', 'c']);
  assert.deepEqual(quota, { a: 4, b: 4, c: 4 });
  assert.equal(quota.a + quota.b + quota.c, 12);
});

test('redistributeQuota: thin-supply — one family can only supply 1 of its 4-share; the 3-shortfall redistributes to the two rich families', () => {
  // base=4. a: take=min(1,4)=1, shortfall=3. b,c: take=4 each, excess=96 each, totalExcess=192.
  // share_b=share_c=floor(3*96/192)=1 each (distributed=2); remainder=1 goes to b (first rich, in order).
  const quota = redistributeQuota({ a: 1, b: 100, c: 100 }, 12, ['a', 'b', 'c']);
  assert.deepEqual(quota, { a: 1, b: 6, c: 5 });
  assert.equal(quota.a + quota.b + quota.c, 12); // shortfall fully absorbed — target still met exactly
});

test('redistributeQuota: zero-supply — one family has no supply at all; documented as 0, not dropped, and its share redistributes evenly', () => {
  // base=4. a: take=0, shortfall=4. b,c: excess=96 each, totalExcess=192, share=floor(4*96/192)=2 each (distributed=4, remainder=0).
  const quota = redistributeQuota({ a: 0, b: 100, c: 100 }, 12, ['a', 'b', 'c']);
  assert.deepEqual(quota, { a: 0, b: 6, c: 6 });
  assert.equal(quota.a + quota.b + quota.c, 12);
});

test('redistributeQuota: a family absent from the supply map is treated as 0 supply, never invented', () => {
  const quota = redistributeQuota({ b: 100, c: 100 }, 12, ['a', 'b', 'c']);
  assert.equal(quota.a, 0);
});

test('redistributeQuota: all-thin (total supply below target) — returns the honest available total, not a fabricated target', () => {
  // base=4. Every family supplies only 2 (< base): shortfall accrues but there are no rich families
  // to absorb it, so it goes unmet — sum is the true available total (6), not the target (12).
  const quota = redistributeQuota({ a: 2, b: 2, c: 2 }, 12, ['a', 'b', 'c']);
  assert.deepEqual(quota, { a: 2, b: 2, c: 2 });
  assert.equal(quota.a + quota.b + quota.c, 6);
});

test('redistributeQuota: the registered real-world shape — 6 families, target 1300, all rich — clears the >=1300 floor', () => {
  const quota = redistributeQuota(Object.fromEntries(FAMILY_NAMES.map((f) => [f, 999999])), 1300, FAMILY_NAMES);
  const total = Object.values(quota).reduce((a, b) => a + b, 0);
  assert.equal(total, 1302); // ceil(1300/6)=217 per family × 6 = 1302
  assert.ok(total >= 1300);
  for (const f of FAMILY_NAMES) assert.equal(quota[f], 217);
});
