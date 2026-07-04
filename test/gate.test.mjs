import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../scripts/gate.sh', import.meta.url));

// gate.sh is bash; on Windows this surface is out of scope (same policy as the hook tests).
const UNIX_ONLY = { skip: process.platform === 'win32' ? 'gate.sh is bash (unix-only)' : false };

// Run gate.sh against a synthetic config; return {status, out}.
function runGate(commands, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sp5gate-'));
  const cfgPath = join(dir, 'gutcheck.config.json');
  writeFileSync(cfgPath, JSON.stringify({ commands }));
  const r = spawnSync('bash', [GATE, '--config', cfgPath, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('PASS: check command exits 0 (no banner configured)', UNIX_ONLY, () => {
  const r = runGate({ check: 'true' });
  assert.equal(r.status, 0);
  assert.match(r.out, /PASS \(coherence check\)/);
});
test('FAIL: check command exits non-zero', UNIX_ONLY, () => {
  const r = runGate({ check: 'false' });
  assert.equal(r.status, 1);
  assert.match(r.out, /FAIL \(coherence check/);
});
test('PASS: exit 0 AND buildSuccessLine present', UNIX_ONLY, () => {
  const r = runGate({ check: 'echo BUILD SUCCESSFUL', buildSuccessLine: 'BUILD SUCCESSFUL' });
  assert.equal(r.status, 0);
});
test('FAIL (masked-failure A): exit 0 but success banner ABSENT (the gradle exit-0-no-success pathology)', UNIX_ONLY, () => {
  const r = runGate({ check: 'echo BUILD FAILED', buildSuccessLine: 'BUILD SUCCESSFUL' });
  assert.equal(r.status, 1);
  assert.match(r.out, /success banner absent/);
});
test('FAIL (masked-failure B): non-zero exit even though the success banner is present', UNIX_ONLY, () => {
  const r = runGate({ check: 'echo BUILD SUCCESSFUL; false', buildSuccessLine: 'BUILD SUCCESSFUL' });
  assert.equal(r.status, 1);
});
test('a pass-OR-fail-shaped banner key other than buildSuccessLine is NOT used to gate success', UNIX_ONLY, () => {
  // A failed build that prints a pass/fail banner under some OTHER commands.* key must still FAIL —
  // proving the gate only ever reads commands.buildSuccessLine, never grepping any lookalike key.
  const r = runGate({ check: 'echo BUILD FAILED; false', otherBannerKey: 'BUILD (SUCCESSFUL|FAILED)' });
  assert.equal(r.status, 1);
});
test('--full routes to commands.testFull (not check)', UNIX_ONLY, () => {
  const r = runGate({ check: 'false', testFull: 'true' }, ['--full']);
  assert.equal(r.status, 0);
  assert.match(r.out, /PASS \(full suite\)/);
});
test('--full + buildSuccessLine: a masked failure on the full route is caught (route x banner)', UNIX_ONLY, () => {
  const r = runGate({ testFull: 'echo BUILD FAILED', buildSuccessLine: 'BUILD SUCCESSFUL' }, ['--full']);
  assert.equal(r.status, 1);
  assert.match(r.out, /success banner absent/);
});
test('--full falls back to commands.test when testFull is unset', UNIX_ONLY, () => {
  const r = runGate({ check: 'false', test: 'true' }, ['--full']);
  assert.equal(r.status, 0);
});
test('exit 2: config file missing', UNIX_ONLY, () => {
  const r = spawnSync('bash', [GATE, '--config', '/no/such/gutcheck.config.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match((r.stdout || '') + (r.stderr || ''), /config not found/);
});
test('exit 2: no command configured for the requested run', UNIX_ONLY, () => {
  const r = runGate({ testFull: 'true' }); // default run needs commands.check
  assert.equal(r.status, 2);
  assert.match(r.out, /no command configured/);
});
test('exit 2: unknown arg', UNIX_ONLY, () => {
  const r = runGate({ check: 'true' }, ['--bogus']);
  assert.equal(r.status, 2);
});
test('default run uses commands.check, not testFull (routing discriminator)', UNIX_ONLY, () => {
  const r = runGate({ check: 'true', testFull: 'false' });
  assert.equal(r.status, 0);
  assert.match(r.out, /coherence check/);
});
