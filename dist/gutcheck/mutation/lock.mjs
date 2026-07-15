// Repo-scoped probe lock. Two concurrent probe runs on one repository drive two test runners into the
// same build state — two Gradles collide and mint phantom failures (the observed shape: the agent's
// Stop hook firing mid-CLI-sweep). The second run must refuse with a stated reason, never collide.
// The lockfile lives in the OS tmpdir keyed by the canonical repo path — never inside the repo (no
// git-status pollution, no accidental commit). Stale = the owning pid is no longer alive; cleared
// silently and retried once. A lock held by THIS process is re-entrant (main()'s full-suite fallback
// re-runs prove(); an exception can leave a residue lock behind the same pid) — refusing ourselves
// would deadlock the fallback for no safety gain.
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function lockPathFor(dir) {
  let real; try { real = realpathSync(dir); } catch { real = dir; }
  return join(tmpdir(), `gutcheck-${createHash('sha1').update(String(real)).digest('hex').slice(0, 12)}.lock`);
}

// → { path, release() } when acquired (release only unlinks a lock this pid still owns), or
// → { held: {pid, started}|null } when a live foreign process holds it (null = lost the takeover race
//   twice — read as held: refusing is fail-closed, colliding is not).
export function acquireRepoLock(dir) {
  const path = lockPathFor(dir);
  const handle = { path, release() { try { if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path); } catch {} } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
      return handle;
    } catch {
      let holder = null; try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      if (holder && holder.pid === process.pid) return handle; // re-entrant (see header)
      if (holder && Number.isInteger(holder.pid) && pidAlive(holder.pid)) return { held: holder };
      try { unlinkSync(path); } catch {} // stale (dead pid) or unreadable — clear and retry once
    }
  }
  return { held: null };
}

// kill(pid, 0) probes liveness without signaling; EPERM = alive under another user (still a real
// holder), any other failure (ESRCH) = dead.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
