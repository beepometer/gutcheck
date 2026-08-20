import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfCheck } from '../mutation/selfcheck.mjs';

// The probe's own catch-AND-survive trial: it must flag a planted hollow test AND catch a planted sound
// test, or gutcheck refuses to run (fail-closed). If this ever returns ok:false on a healthy box, the
// probe can't tell a fake test from a real one and no verdict it emits can be trusted.
test('selfCheck: the probe flags its planted hollow test and catches its planted sound test', () => {
  const r = selfCheck();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.flaggedHollow, true, 'planted hollow must be detected');
  assert.equal(r.caughtSound, true, 'planted sound must fail when its function is gutted');
});

// The trust gate must exercise the shapes that produced real false verdicts (the arrowSite class,
// 2026-08-19), not only the trivial single-line happy path: a Prettier-wrapped ternary arrow whose
// PARTIAL gut leaves the asserted branch alive (a sound test would read hollow) and a wrapped method
// chain under a tautology whose PARTIAL gut strands the chain tail on the sentinel (the crash would
// read caught and the planted fake would pass as real). A probe regressing on either shape must fail
// this gate closed instead of shipping verdicts.
test('selfCheck: the planted fixture covers the wrapped-arrow shapes', () => {
  const r = selfCheck();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.caught, 2, 'both planted sound tests must be caught — the block body AND the wrapped ternary arrow');
  assert.deepEqual(r.hollowNames, ['planted hollow (wrapped chain)'], 'the wrapped-chain tautology must be the one flagged hollow');
});
