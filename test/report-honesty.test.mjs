import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banner } from '../mutation/gutcheck.mjs';
import { formatReport } from '../mutation/prove.mjs';

// The banner once itemized a hardcoded reason list, so pin-unresolved and probe-cap skips (both real,
// both emitted by prove()) vanished from the breakdown — on one wild full run, a third of the skips
// went unattributed. The banner must itemize EVERY why code present, and the itemized counts must
// sum to the skipped total; a why code with no label renders verbatim rather than disappearing.

const baseR = { probes: 4, runner: 'node', skipped: [], outOfScope: 0, capped: 0 };

test('banner: every skip reason is itemized — pin-unresolved and probe-cap included, unknown codes verbatim', () => {
  const r = { ...baseR, skipped: [
    { why: 'no-pin' }, { why: 'no-pin' },
    { why: 'pin-unresolved' },
    { why: 'probe-cap' },
    { why: 'env-abort' },
    { why: 'some-future-reason' },
  ] };
  const out = banner(r);
  assert.match(out, /6 skipped \(/, 'total count leads the breakdown');
  assert.match(out, /2 no value-pinning assertion/);
  assert.match(out, /1 pin not tied to a called function/, 'pin-unresolved must be itemized');
  assert.match(out, /1 not probed \(cap\/time budget\)/, 'probe-cap must be itemized');
  assert.match(out, /1 not probed \(env abort\)/, 'env-abort must be itemized');
  assert.match(out, /1 some-future-reason/, 'an unlabeled code renders verbatim, never silently dropped');
});

test('banner: itemized counts sum to the skipped total for every reason mix', () => {
  const r = { ...baseR, skipped: [
    { why: 'no-pin' }, { why: 'sut-unresolved' }, { why: 'ungutable' }, { why: 'dynamic-title' },
    { why: 'instrumented-test' }, { why: 'unsupported-source-set' }, { why: 'pin-unresolved' },
    { why: 'probe-cap' }, { why: 'env-abort' }, { why: 'mystery' }, { why: 'mystery' },
  ] };
  const out = banner(r);
  const m = out.match(/(\d+) skipped \((.*)\)$/);
  assert.ok(m, `banner must carry a parenthesized breakdown: ${out}`);
  // Each part opens with its count; labels may themselves contain parentheses but never a comma.
  const itemized = m[2].split(', ').reduce((a, part) => a + Number(part.match(/^(\d+) /)[1]), 0);
  assert.equal(itemized, Number(m[1]), 'itemized reason counts must sum to the skipped total');
});

test('banner: the six original labels are unchanged (no churn for existing readers)', () => {
  const r = { ...baseR, skipped: [
    { why: 'no-pin' }, { why: 'sut-unresolved' }, { why: 'ungutable' },
    { why: 'dynamic-title' }, { why: 'instrumented-test' }, { why: 'unsupported-source-set' },
  ] };
  assert.equal(
    banner(r),
    'probed 4 functions · runner=node · 6 skipped (1 no value-pinning assertion, 1 tested function not locatable, 1 function body not guttable, 1 test title is dynamic (interpolated or parameterized), 1 instrumented androidTest (not supported), 1 unsupported KMP source set)',
  );
});

// Full-scan headline: when tests were skipped or inconclusive, the coverage denominator leads —
// "verdicts on X of Y tests" — so the shareable one-liner can no longer read as a whole-suite claim.
// A clean run (nothing skipped, nothing inconclusive) keeps the existing single-clause line byte-for-byte.

const fullScanR = (over) => ({ runner: 'node', scored: 2, caught: 2, pct: 100, probes: 3, hollow: [],
  inconclusive: [], skipped: [], outOfScope: 0, capped: 0, changes: null, changeSummary: null, ...over });

test('full-scan headline: skipped/inconclusive tests put the coverage denominator first', () => {
  const r = fullScanR({ skipped: [{ why: 'no-pin' }, { why: 'no-pin' }], inconclusive: [{ why: 'baseline 0p/1f', file: 'f', line: 1, name: 'n' }] });
  const head = formatReport(r).split('\n').find((l) => l.startsWith('gutcheck:'));
  assert.equal(head, 'gutcheck: verdicts on 2 of 5 tests (40%) — 2/2 (100%) fail when the function they test is broken.  [3 probes, runner: node]');
});

test('full-scan headline: a clean run (nothing skipped or inconclusive) is byte-identical to the release format', () => {
  const head = formatReport(fullScanR({})).split('\n').find((l) => l.startsWith('gutcheck:'));
  assert.equal(head, 'gutcheck: 2/2 tests (100%) fail when the function they test is broken.  [3 probes, runner: node]');
});

// Sibling-binding context on hollow rows (field report 2026-08-13 §6): triaging a hollow finding
// needs one fact the run already computed — whether ANOTHER probed test binds the same fn (an
// equivalence/determinism companion of a proven value-pin vs a fn whose self-comparison is its only
// probed coverage). Stated from r.proven's execution evidence, joined on the (fn, sutRel) PAIR (a
// bare name would cross-attribute a same-named fn in an unrelated file), zero extra probe cost.
// FACT-ONLY: it counts proofs, it never renders a fix-now/by-design verdict.
test('a hollow row states how many OTHER proven tests bind the same fn', () => {
  const r = fullScanR({
    scored: 3, caught: 2,
    hollow: [{ file: 't/eq.test.mjs', line: 9, name: 'commutes', survivors: ['total'], survivorPairs: [{ fn: 'total', sutRel: 'src/lib.mjs' }] }],
    proven: [
      { file: 't/pin.test.mjs', line: 3, name: 'totals', fns: ['total'], pairs: [{ fn: 'total', sutRel: 'src/lib.mjs' }] },
      { file: 't/pin2.test.mjs', line: 5, name: 'totals empty', fns: ['total'], pairs: [{ fn: 'total', sutRel: 'src/lib.mjs' }] },
      { file: 't/other.test.mjs', line: 7, name: 'same name, unrelated file', fns: ['total'], pairs: [{ fn: 'total', sutRel: 'src/other.mjs' }] },
    ],
  });
  const row = formatReport(r).split('\n').find((l) => l.includes('survives gutting'));
  assert.match(row, /survives gutting total\(\)/);
  // 2, not 3: the same-named fn in an UNRELATED file must not count — pair attribution, never bare name
  assert.match(row, /\(total\(\) is bound by 2 other proven tests\)/, row);
});

test('a hollow row whose fn no other probed test binds says exactly that — the real-gap signal', () => {
  const r = fullScanR({
    scored: 1, caught: 0, pct: 0,
    hollow: [{ file: 't/eq.test.mjs', line: 9, name: 'commutes', survivors: ['total'], survivorPairs: [{ fn: 'total', sutRel: 'src/lib.mjs' }] }],
  });
  const row = formatReport(r).split('\n').find((l) => l.includes('survives gutting'));
  assert.match(row, /\(no other probed test binds total\(\)\)/, row);
});
