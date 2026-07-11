// Corpus trend (Fable's cheap estimand): untested-fraction by agent family × month, computed from the
// existing confirmatory corpus. Hand-derived oracle over a tiny hand-built join.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trend } from './trend.mjs';

test('trend buckets untested-fraction by family and month (join on id, month from the query window)', () => {
  const results = [
    { id: 'a@1', status: 'ok', gutcheck: { changeSummary: { fns: 10, proven: 1, hollow: 0, unverifiable: 1, untested: 8 } } },
    { id: 'b@2', status: 'ok', gutcheck: { changeSummary: { fns: 4, proven: 2, hollow: 0, unverifiable: 0, untested: 2 } } },
    { id: 'c@3', status: 'install-failed', gutcheck: null }, // non-ok rows contribute nothing
  ];
  const work = [
    { id: 'a@1', family: 'claude', query: '"x" committer-date:2026-01-01..2026-01-31' },
    { id: 'b@2', family: 'copilot', query: '"y" committer-date:2026-03-01..2026-03-31' },
    { id: 'c@3', family: 'claude', query: '"x" committer-date:2026-02-01..2026-02-28' },
  ];
  const t = trend(results, work);
  assert.equal(t.by_family.claude.fns, 10);
  assert.equal(t.by_family.claude.untested, 8);
  assert.equal(t.by_family.claude.pct, 80.0);
  assert.equal(t.by_family.copilot.pct, 50.0);
  assert.equal(t.by_month['2026-01'].untested, 8);
  assert.equal(t.by_month['2026-03'].fns, 4);
  assert.equal(t.rows_joined, 2);
});
