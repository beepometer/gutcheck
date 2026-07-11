// The frozen estimands (pre-reg §3, signed): paired bootstrap over per-task ΔG−P with a FIXED seed —
// hand-derived cases where the answer is knowable without running the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from './aggregate.mjs';

const row = (task, model, gp, pp, bp = 0, opts = {}) => ({
  task, model, lang: 'js',
  B: { fraction: bp, entryProven: false, entryCorrect: true, ...opts.B },
  P: { fraction: pp, entryProven: false, entryCorrect: true, ...opts.P },
  G: { fraction: gp, entryProven: true, entryCorrect: true, ...opts.G },
});

test('aggregate: constant paired difference -> mean exact, CI collapses onto it', () => {
  const rows = [row('t1', 'sonnet', 0.5, 0.0), row('t2', 'sonnet', 0.5, 0.0), row('t3', 'sonnet', 0.5, 0.0)];
  const a = aggregate(rows, { seed: 20260707 });
  const m = a.perModel.sonnet;
  assert.equal(m.n, 3);
  assert.equal(m.deltaGP.mean, 0.5);
  assert.equal(m.deltaGP.lo, 0.5);
  assert.equal(m.deltaGP.hi, 0.5);
});

test('aggregate: E-VALUE uses entry proven∧correct; gaming counts proven-but-wrong per arm', () => {
  const rows = [
    row('t1', 'sonnet', 1, 0, 0, { G: { entryProven: true, entryCorrect: false } }), // proven-but-WRONG in G
    row('t2', 'sonnet', 1, 0, 0, { G: { entryProven: true, entryCorrect: true } }),
  ];
  const a = aggregate(rows, { seed: 1 });
  const m = a.perModel.sonnet;
  // E-VALUE per task: G genuine (1,0) minus P genuine (0,0) -> diffs [0,1] wait: t1 G proven but wrong -> 0; t2 -> 1.
  assert.equal(m.deltaGP_value.mean, 0.5);
  assert.equal(m.gaming.G.provenButWrong, 1);
  assert.equal(m.gaming.G.provenTotal, 2);
  assert.equal(m.gaming.P.provenTotal, 0);
});

test('aggregate: reconciliation — totals equal the row count by direct recount', () => {
  const rows = [row('t1', 'sonnet', 0.2, 0.1), row('t2', 'opus', 0.3, 0.3)];
  const a = aggregate(rows, { seed: 7 });
  assert.equal(a.reconcile.rows, 2);
  assert.equal(a.perModel.sonnet.n + a.perModel.opus.n, 2);
});

test('aggregate: deterministic under the fixed seed', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, 'sonnet', (i % 3) / 3, (i % 2) / 4));
  const a1 = aggregate(rows, { seed: 20260707 });
  const a2 = aggregate(rows, { seed: 20260707 });
  assert.deepEqual(a1.perModel.sonnet.deltaGP, a2.perModel.sonnet.deltaGP);
});
