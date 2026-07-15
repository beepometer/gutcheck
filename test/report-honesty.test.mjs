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
    'probed 4 functions · runner=node · 6 skipped (1 no value-pinning assertion, 1 tested function not locatable, 1 function body not guttable, 1 test title is dynamic (template interpolation), 1 instrumented androidTest (not supported), 1 unsupported KMP source set)',
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
