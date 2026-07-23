// Repo-scoped probe lock (mutation/lock.mjs): two concurrent probe runs on one repo drive two test
// runners into the same build state (two Gradles collide and mint phantom failures) — the second run
// must refuse with a stated reason, never collide. Oracles hand-derived from the contract:
// process.ppid is a live foreign process on every platform (the test runner's parent — Windows has
// no pid 1, so the Unix-only init/launchd trick reads as a dead pid there and clears the lock);
// 999999999 exceeds every default pid_max — reliably dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireRepoLock, lockPathFor, reapStaleWork, markWorkOwned } from '../mutation/lock.mjs';
import { prove } from '../mutation/prove.mjs';

// Absolute file:// URL to mutation/prove.mjs, for the hermetic child script below (its own file lives
// under a throwaway temp dir, so a relative specifier would have to track that path; an absolute URL
// sidesteps it entirely).
const PROVE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'mutation', 'prove.mjs')).href;

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

// reapStaleWork: startup reaper for orphaned gutcheck-prove-* work copies (SIGKILL skips prove()'s own
// `finally`). Each case builds a REAL dir under tmpdir() with the real prefix and removes it in
// `finally` — never leaving a fixture behind for a concurrently running probe to trip on. Dirs marked
// with a live pid (this test process) or a fresh mtime are safe to coexist with a concurrent real
// reap: pidAlive(process.pid) and the age guard both correctly read them as kept from any caller.
// The six tests below share the REAL tmpdir with every other `npm test` file (`node --test
// test/*.test.mjs` runs one process per file), but each stays parallel-suite-safe: a concurrent
// sweep from another file's first prove() call agrees with what THIS test's own reapStaleWork() call
// would conclude — dead-pid/>24h fixtures are meant to be gone under any process's rules, live-pid/
// fresh-mtime fixtures are protected under any process's rules — so a race can only reinforce the
// assertion, never flip it. Only the once-per-process pin further below depends on which SPECIFIC
// process's prove() call reaps, which a concurrent sweep from a different file genuinely can
// falsify — that one runs in a hermetically private tmpdir instead.

test('reap: marker with a dead pid → the orphaned work copy is reaped', () => {
  const dead = spawnSync(process.execPath, ['-e', '""']).pid;
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  try {
    writeFileSync(join(d, '.gutcheck-owner'), JSON.stringify({ pid: dead, started: '2026-07-14T00:00:00Z' }));
    reapStaleWork();
    assert.ok(!existsSync(d), 'a dead-pid owner is reaped');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('reap: marker with a live pid (this process) → kept', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  try {
    writeFileSync(join(d, '.gutcheck-owner'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    reapStaleWork();
    assert.ok(existsSync(d), 'a live-pid owner is never reaped');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('reap: markerless dir with a fresh mtime → kept (may be a concurrent mid-copy run)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  try {
    reapStaleWork();
    assert.ok(existsSync(d), 'a fresh markerless dir survives the age guard');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('reap: markerless dir older than 24h → reaped', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  try {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(d, old, old);
    reapStaleWork();
    assert.ok(!existsSync(d), 'a markerless dir past the 24h age guard is reaped');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('reap: dead-pid marker in a dir NOT matching the prove prefix → untouched (prefix-scoped)', () => {
  const dead = spawnSync(process.execPath, ['-e', '""']).pid;
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-other-'));
  try {
    writeFileSync(join(d, '.gutcheck-owner'), JSON.stringify({ pid: dead, started: '2026-07-14T00:00:00Z' }));
    reapStaleWork();
    assert.ok(existsSync(d), 'reaping is scoped to gutcheck-prove- dirs only');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('reap: markWorkOwned writes a parsable {pid, started} marker', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  try {
    markWorkOwned(d);
    const owner = JSON.parse(readFileSync(join(d, '.gutcheck-owner'), 'utf8'));
    assert.equal(owner.pid, process.pid, 'marker records this process as the owner');
    assert.equal(typeof owner.started, 'string', 'marker records a started timestamp');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// reapStaleWork is startup hygiene, not per-run work: gutcheck.mjs's --since/empty-scope fallbacks
// re-enter prove() up to twice in one CLI process, and this suite's own callers re-enter it far more —
// a second in-process prove() must not pay (or re-trigger) the tmpdir sweep again. Unlike the six
// tests above, this one depends on which SPECIFIC process's prove() call reaps the planted orphan —
// a genuinely different outcome than a concurrent sweep from another `npm test` file would produce
// (that file's own FIRST prove() call runs in ITS OWN fresh process, staleWorkReaped=false there, and
// would legitimately reap a dead-pid orphan sitting in the shared real tmpdir mid-test). So this pin
// runs the whole two-call scenario inside a CHILD process pointed at a PRIVATE tmpdir (TMPDIR/TEMP/TMP
// all overridden to a fresh mkdtemp'd dir nothing else on the machine knows about) — no other process,
// this suite's or any other's, can ever share or sweep it, by construction rather than by luck.
test('reap: a second in-process prove() call does not re-sweep tmpdir (once-per-process contract)', () => {
  const privateRoot = mkdtempSync(join(tmpdir(), 'gc-lock-privtmp-'));
  const scriptPath = join(privateRoot, 'reap-once.mjs');
  const fixtureFiles = {
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a, b) { return a + b; }\n',
    'test/t.test.mjs':
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { add } from '../src/lib.mjs';\n" +
      "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n",
  };
  // Runs with TMPDIR/TEMP/TMP pointed at privateRoot (os.tmpdir() honors TMPDIR on darwin/linux,
  // TEMP/TMP on win32), so every tmpdir()-based path this script touches — the fixture project, the
  // orphan, prove()'s own work copy and repo lock — lives under privateRoot alone.
  const script = `
import { prove } from ${JSON.stringify(PROVE_URL)};
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const files = ${JSON.stringify(fixtureFiles)};
const d = mkdtempSync(join(tmpdir(), 'gc-lock-'));
for (const [rel, body] of Object.entries(files)) {
  const f = join(d, rel);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, body);
}

prove(d, { runner: 'node' }); // first in-process call
const dead = spawnSync(process.execPath, ['-e', '""']).pid;
const orphan = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
writeFileSync(join(orphan, '.gutcheck-owner'), JSON.stringify({ pid: dead, started: '2026-07-14T00:00:00Z' }));
prove(d, { runner: 'node' }); // second in-process call, same process
if (!existsSync(orphan)) { console.error('orphan reaped by the second in-process prove() call'); process.exit(1); }
process.exit(0);
`;
  writeFileSync(scriptPath, script);
  try {
    const env = { ...process.env, TMPDIR: privateRoot, TEMP: privateRoot, TMP: privateRoot };
    const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `a second in-process prove() must not re-sweep tmpdir: ${r.stderr || r.stdout}`);
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
});
