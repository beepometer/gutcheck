// Gate: the published README headline (Σ fns 13,982; untested 88.1%; unverifiable 9.9%;
// proven 1.9%) and the corpus-level counts (1,803 commits / 1,654 ok / 2,361 scored blocks /
// 23 hollow tests) must recompute from the TRACKED corpus alone — never from the gitignored
// results*.jsonl drive outputs. If this ever fails, the receipt is broken: fix the corpus or the
// README, never this oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCorpus, recompute } from '../benchmark/evidence/recompute-changes.mjs';

test('published figures recompute exactly from benchmark/evidence/corpus/diffs.jsonl', () => {
  const rows = readCorpus();
  const r = recompute(rows);

  // Corpus-level (README's evidence-drive table).
  assert.equal(r.commits, 1803);
  assert.equal(r.ok, 1654);
  assert.equal(r.scoredBlocks, 2361);
  assert.equal(r.hollowTests, 23);

  // Per-function headline (README's 88.1 / 9.9 / 1.9 over 13,982 changed functions).
  assert.equal(r.fns, 13982);
  assert.equal(r.pct.untested, '88.1');
  assert.equal(r.pct.unverifiable, '9.9');
  assert.equal(r.pct.proven, '1.9');
});
