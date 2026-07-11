import { test } from 'node:test';
import assert from 'node:assert';
import { aggregate } from './aggregate.mjs';

// Six hand-built rows exercising every branch of aggregate(). Every expected number below is
// computed BY HAND from the row literals in this file — never by running aggregate() and pasting
// its output back. If aggregate() is wrong, these numbers stay wrong until a human re-derives them.

// row1: ok, probes=4 (>0 so it counts toward diffs_with_probes), caught=2, exactly 1 hollow entry,
// 1 skip why='no-pin'.
const row1 = {
  id: 'org/repoA@aaa1111', repo: 'org/repoA', sha: 'aaa1111', status: 'ok',
  gutcheck: {
    probes: 4, caught: 2,
    hollow: [{ file: 'src/a.test.js', line: 10, name: 'hollow test A', survivors: ['calc'] }],
    inconclusive: [],
    skipped: [{ file: 'src/a.test.js', line: 20, name: 'skipped A', why: 'no-pin' }],
  },
};

// row2: ok, probes=6 (>0), caught=3, no hollow, 1 inconclusive entry, 2 skips why='sut-unresolved'.
const row2 = {
  id: 'org/repoB@bbb2222', repo: 'org/repoB', sha: 'bbb2222', status: 'ok',
  gutcheck: {
    probes: 6, caught: 3,
    hollow: [],
    inconclusive: [{ file: 'src/b.test.js', line: 5, name: 'inconclusive B', why: 'baseline 0p/1f' }],
    skipped: [
      { file: 'src/b.test.js', line: 15, name: 'skip B1', why: 'sut-unresolved' },
      { file: 'src/b.test.js', line: 25, name: 'skip B2', why: 'sut-unresolved' },
    ],
  },
};

// row3: ok, probes=0 (zero-probeable — excluded from diffs_with_probes, counted in
// zero_probeable_ok_diffs), caught=0, no hollow/inconclusive, 4 skips why='no-pin'.
const row3 = {
  id: 'org/repoC@ccc3333', repo: 'org/repoC', sha: 'ccc3333', status: 'ok',
  gutcheck: {
    probes: 0, caught: 0,
    hollow: [],
    inconclusive: [],
    skipped: [
      { file: 'src/c.test.js', line: 1, name: 'skip C1', why: 'no-pin' },
      { file: 'src/c.test.js', line: 2, name: 'skip C2', why: 'no-pin' },
      { file: 'src/c.test.js', line: 3, name: 'skip C3', why: 'no-pin' },
      { file: 'src/c.test.js', line: 4, name: 'skip C4', why: 'no-pin' },
    ],
  },
};

// row4-6: non-ok statuses. gutcheck is null on these (matches drive-probes.mjs's row() shape) —
// they contribute to diffs.by_status only, nothing to probeable/verdicts/skips/hollow_list.
const row4 = { id: 'org/repoD@ddd4444', repo: 'org/repoD', sha: 'ddd4444', status: 'clone-failed', gutcheck: null };
const row5 = { id: 'org/repoE@eee5555', repo: 'org/repoE', sha: 'eee5555', status: 'timeout', gutcheck: null };
const row6 = { id: 'org/repoF@fff6666', repo: 'org/repoF', sha: 'fff6666', status: 'install-failed', gutcheck: null };

const rows = [row1, row2, row3, row4, row5, row6];

test('aggregate: hand-derived summary over 6 rows (2 ok-with-probes, 1 ok-zero-probeable, 3 non-ok)', () => {
  const summary = aggregate(rows);

  // diffs.total = 6 — one per row, regardless of status.
  // diffs.by_status: ok=3 (row1,row2,row3), clone-failed=1 (row4), checkout-failed=0 (none),
  // install-failed=1 (row6), probe-error=0 (none), timeout=1 (row5).
  // probeable.diffs_with_probes = 2 — row1(probes=4>0) + row2(probes=6>0); row3(probes=0) excluded.
  // probeable.total_probed = 4+6+0 = 10 — sum of gutcheck.probes over the 3 ok rows.
  // probeable.zero_probeable_ok_diffs = 1 — row3 only (probes===0).
  // verdicts.caught = 2+3+0 = 5 — row1(2) + row2(3) + row3(0).
  // verdicts.hollow = 1+0+0 = 1 — row1's single hollow entry; row2/row3 contribute 0.
  // verdicts.inconclusive = 0+1+0 = 1 — row2's single inconclusive entry; row1/row3 contribute 0.
  // skips.by_reason['no-pin'] = 1(row1) + 0(row2) + 4(row3) = 5.
  // skips.by_reason['sut-unresolved'] = 0(row1) + 2(row2) + 0(row3) = 2.
  // skips.by_reason['ungutable'] = 0 — no row emits an 'ungutable' skip.
  // hollow_list = exactly row1's hollow entry, tagged with row1's id/repo/sha — rows 2-6
  // contribute nothing (row2/row3 have empty hollow[]; rows 4-6 are not ok).
  const expected = {
    diffs: {
      total: 6,
      by_status: {
        ok: 3,
        'clone-failed': 1,
        'checkout-failed': 0,
        'install-failed': 1,
        'probe-error': 0,
        timeout: 1,
      },
    },
    probeable: {
      diffs_with_probes: 2,
      total_probed: 10,
      zero_probeable_ok_diffs: 1,
    },
    verdicts: {
      caught: 5,
      hollow: 1,
      inconclusive: 1,
    },
    skips: {
      by_reason: {
        'no-pin': 5,
        'sut-unresolved': 2,
        ungutable: 0,
      },
    },
    hollow_list: [
      { id: 'org/repoA@aaa1111', repo: 'org/repoA', sha: 'aaa1111', file: 'src/a.test.js', line: 10, name: 'hollow test A', survivors: ['calc'] },
    ],
  };

  assert.deepEqual(summary, expected);
});

test('aggregate: empty input — every count is zero, no crash', () => {
  const summary = aggregate([]);
  assert.equal(summary.diffs.total, 0);
  assert.deepEqual(summary.diffs.by_status, {
    ok: 0, 'clone-failed': 0, 'checkout-failed': 0, 'install-failed': 0, 'probe-error': 0, timeout: 0,
  });
  assert.deepEqual(summary.probeable, { diffs_with_probes: 0, total_probed: 0, zero_probeable_ok_diffs: 0 });
  assert.deepEqual(summary.verdicts, { caught: 0, hollow: 0, inconclusive: 0 });
  assert.deepEqual(summary.skips.by_reason, { 'no-pin': 0, 'sut-unresolved': 0, ungutable: 0 });
  assert.deepEqual(summary.hollow_list, []);
});

// A malformed 'ok' row without a gutcheck payload must never throw — it contributes to
// diffs.by_status.ok (1) but nothing else (the row is dropped from the ok-with-gutcheck set).
test('aggregate: an ok row with gutcheck=null is counted in by_status but skipped everywhere else', () => {
  const malformed = { id: 'org/repoG@ggg7777', repo: 'org/repoG', sha: 'ggg7777', status: 'ok', gutcheck: null };
  const summary = aggregate([malformed]);
  assert.equal(summary.diffs.total, 1);
  assert.equal(summary.diffs.by_status.ok, 1);
  assert.deepEqual(summary.probeable, { diffs_with_probes: 0, total_probed: 0, zero_probeable_ok_diffs: 0 });
  assert.deepEqual(summary.verdicts, { caught: 0, hollow: 0, inconclusive: 0 });
  assert.deepEqual(summary.hollow_list, []);
});
