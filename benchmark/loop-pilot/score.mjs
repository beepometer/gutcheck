// Scoring over the shipped probe's --json result. provenFraction/provenFns are pure (unit-tested);
// scoreArtifact shells out to the REAL CLI (never a re-implementation) and parses stdout — exit code 1
// (hollow found) still carries a full result.
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function provenFraction(r) {
  const cs = (r && r.changeSummary) || { fns: 0, proven: 0, hollow: 0, unverifiable: 0, untested: 0 };
  return {
    proven: cs.proven, changed: cs.fns,
    fraction: cs.fns ? cs.proven / cs.fns : null,
    byVerdict: { proven: cs.proven, hollow: cs.hollow, unverifiable: cs.unverifiable, untested: cs.untested },
  };
}

export const provenFns = (r) => ((r && r.changes) || []).filter((c) => c.status === 'proven').map((c) => c.fn);

// Run the probe on a workdir, scoped to everything since `sinceRef` (the scaffold commit).
export function scoreArtifact(workdir, sinceRef, { timeoutMs = 300000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile('node', [join(REPO, 'mutation', 'gutcheck.mjs'), workdir, '--json', '--no-fallback', '--no-self-check', `--since=${sinceRef}`],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        try { resolvePromise({ ok: true, result: JSON.parse(stdout) }); }
        catch { resolvePromise({ ok: false, error: (err && String(err.message).slice(0, 300)) || 'unparseable', raw: (stdout || '').slice(0, 300) }); }
      });
  });
}
