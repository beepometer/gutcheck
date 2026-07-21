import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const WARM = fileURLToPath(new URL('../scripts/warm-caches.sh', import.meta.url));

// warm-caches.sh is bash; Windows is out of scope (same policy as gate.sh / the hook tests).
const UNIX_ONLY = { skip: process.platform === 'win32' ? 'warm-caches.sh is bash (unix-only)' : false };

// Run from a throwaway cwd that is NOT the repo, so any relative-path resolution would break —
// proving the script locates its fixtures relative to its OWN location, not the caller's cwd.
function run(args = [], extraEnv = {}) {
  const cwd = mkdtempSync(`${tmpdir()}/sp5warm-`);
  const r = spawnSync('bash', [WARM, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('--dry-run plans the gradle warm at an ABSOLUTE fixtures path (cwd-independent) via the vendored wrapper', UNIX_ONLY, () => {
  const r = run(['--dry-run']);
  assert.equal(r.status, 0);
  // absolute path (leading /) ending in the fixture — a relative resolve from the tmp cwd could not produce this
  assert.match(r.out, /(^|\s)\/[^\s]*\/test\/fixtures\/jvm-project\b/m);
  assert.match(r.out, /GradleWrapperMain test --console=plain/);
});

test('--dry-run includes BOTH maven fixtures when GUTCHECK_MVN points at a usable mvn', UNIX_ONLY, () => {
  const r = run(['--dry-run'], { GUTCHECK_MVN: '/usr/bin/true' });
  assert.equal(r.status, 0);
  assert.match(r.out, /test\/fixtures\/maven-project\b/);
  assert.match(r.out, /test\/fixtures\/maven-reactor\b/);
  assert.match(r.out, /\/usr\/bin\/true -q test/);
});

test('--gradle-only skips maven entirely (no maven fixture planned)', UNIX_ONLY, () => {
  const r = run(['--gradle-only', '--dry-run'], { GUTCHECK_MVN: '/usr/bin/true' });
  assert.equal(r.status, 0);
  assert.match(r.out, /maven.*SKIP/i);
  assert.ok(!/maven-project/.test(r.out), 'maven fixtures must not be planned under --gradle-only');
});

test('fails closed (exit 2) when GUTCHECK_MVN is set but not executable', UNIX_ONLY, () => {
  const r = run(['--dry-run'], { GUTCHECK_MVN: '/no/such/mvn' });
  assert.equal(r.status, 2);
  assert.match(r.out, /GUTCHECK_MVN.*not an executable/);
});

test('--help exits 0 with usage', UNIX_ONLY, () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.out, /usage: warm-caches\.sh/);
});

test('unknown arg exits 2', UNIX_ONLY, () => {
  const r = run(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.out, /unknown arg/);
});
