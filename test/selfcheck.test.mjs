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
