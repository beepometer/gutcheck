// Repo-scoped probe lock (mutation/lock.mjs): two concurrent probe runs on one repo drive two test
// runners into the same build state (two Gradles collide and mint phantom failures) — the second run
// must refuse with a stated reason, never collide. Oracles hand-derived from the contract:
// process.ppid is a live foreign process on every platform (the test runner's parent — Windows has
// no pid 1, so the Unix-only init/launchd trick reads as a dead pid there and clears the lock);
// 999999999 exceeds every default pid_max — reliably dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRepoLock, lockPathFor } from '../mutation/lock.mjs';
import { prove } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-lock-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}

test('lock: acquire-release round trip — lockfile exists while held, gone after release', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-lock-rt-'));
  const l = acquireRepoLock(d);
  assert.ok(l.release, 'first acquire succeeds');
  assert.ok(existsSync(lockPathFor(d)), 'lockfile present while held');
  l.release();
  assert.ok(!existsSync(lockPathFor(d)), 'lockfile removed on release');
  rmSync(d, { recursive: true, force: true });
});

test('lock: held by a live foreign process → refused, holder reported', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-lock-held-'));
  writeFileSync(lockPathFor(d), JSON.stringify({ pid: process.ppid, started: '2026-07-14T00:00:00Z' }));
  const l = acquireRepoLock(d);
  assert.ok(!l.release, 'no release handle — the lock was not acquired');
  assert.equal(l.held && l.held.pid, process.ppid, 'the live holder is reported');
  unlinkSync(lockPathFor(d));
  rmSync(d, { recursive: true, force: true });
});

test('lock: a stale lock (dead pid) is cleared and acquired', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-lock-stale-'));
  writeFileSync(lockPathFor(d), JSON.stringify({ pid: 999999999, started: '2026-07-14T00:00:00Z' }));
  const l = acquireRepoLock(d);
  assert.ok(l.release, 'stale lock self-clears');
  l.release();
  rmSync(d, { recursive: true, force: true });
});

test('lock: re-entrant — a lock held by THIS process is acquired again, not refused', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-lock-reent-'));
  writeFileSync(lockPathFor(d), JSON.stringify({ pid: process.pid, started: '2026-07-14T00:00:00Z' }));
  const l = acquireRepoLock(d);
  assert.ok(l.release, 'same-pid holder is re-entrant (fallback re-runs, exception residue)');
  l.release();
  rmSync(d, { recursive: true, force: true });
});

test('prove: refuses with a stated reason while another run holds the repo lock, runs after it clears', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a, b) { return a + b; }\n',
    'test/t.test.mjs':
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { add } from '../src/lib.mjs';\n" +
      "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n",
  });
  writeFileSync(lockPathFor(d), JSON.stringify({ pid: process.ppid, started: '2026-07-14T00:00:00Z' }));
  const refused = prove(d, { runner: 'node' });
  assert.match(refused.scopeError || '', /already running/, 'a held lock is a stated refusal, never a collision');
  assert.equal(refused.probes, 0, 'nothing ran');
  unlinkSync(lockPathFor(d));
  const r = prove(d, { runner: 'node' });
  assert.equal(r.caught, 1, 'the same call succeeds once the lock clears');
  assert.ok(!existsSync(lockPathFor(d)), 'prove releases its own lock on return');
  rmSync(d, { recursive: true, force: true });
});
