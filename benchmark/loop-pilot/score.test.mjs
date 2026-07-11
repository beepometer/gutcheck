// provenFraction/provenFns over the REAL `gutcheck --json` change-classification shape (changeSummary
// keys fns/proven/hollow/unverifiable/untested; changes[] status strings) — hand-derived oracles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provenFraction, provenFns } from './score.mjs';

const R = {
  changeSummary: { fns: 4, proven: 1, hollow: 1, unverifiable: 0, untested: 2 },
  changes: [
    { fn: 'entry', file: 'src/solution.mjs', status: 'proven' },
    { fn: 'helperA', file: 'src/solution.mjs', status: 'hollow' },
    { fn: 'helperB', file: 'src/solution.mjs', status: 'untested' },
    { fn: 'helperC', file: 'src/solution.mjs', status: 'untested' },
  ],
};

test('provenFraction: proven/changed from changeSummary', () => {
  assert.deepEqual(provenFraction(R), {
    proven: 1, changed: 4, fraction: 0.25,
    byVerdict: { proven: 1, hollow: 1, unverifiable: 0, untested: 2 },
  });
});

test('provenFraction: zero changed functions -> fraction null (never NaN)', () => {
  const r = { changeSummary: { fns: 0, proven: 0, hollow: 0, unverifiable: 0, untested: 0 }, changes: [] };
  assert.equal(provenFraction(r).fraction, null);
});

test('provenFns lists the proven function names', () => {
  assert.deepEqual(provenFns(R), ['entry']);
});
