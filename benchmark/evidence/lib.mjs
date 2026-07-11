// Shared helpers for the evidence pipeline. Zero dependencies; argv-exec only (never a shell string).
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// Mirrors mutation/prove.mjs isTestPath semantics (JS/TS + Python test files).
export const isTestFile = (f) => (/\.(test|spec)\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f))
  || (/(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f))
  || (/(^|\/)(tests?|__tests__|spec)\//.test(f) && (/\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f) || /\.py$/.test(f)));

export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + '\n');
}

// A driver crash mid-append can leave a torn last line. Skip ONLY a parse failure on the last
// line (that's a torn append, not corruption) and warn; a parse failure anywhere else still throws.
export function readJsonl(file) {
  let raw; try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    try { rows.push(JSON.parse(lines[i])); }
    catch (e) {
      if (i !== lines.length - 1) throw e;
      console.error(`readJsonl: skipping torn trailing line in ${file}: ${e.message}`);
    }
  }
  return rows;
}

// killSignal is SIGKILL: verified (spawnSync a child with an `exit` handler, kill it via
// timeout+SIGTERM with no signal handler installed) that a bare SIGTERM without a registered
// handler skips exit/finally handlers exactly like SIGKILL — Node's default SIGTERM action is
// immediate termination. So SIGTERM buys prove.mjs's `finally` nothing here; SIGKILL stays.
export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeoutMs || 120000, killSignal: 'SIGKILL', cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }); // 64MB: a gutcheck --json result on a large repo can exceed spawnSync's 1MB default (ENOBUFS = silent truncation)
  let err = r.stderr || '';
  if (r.error) err += (err ? ' ' : '') + String(r.error.code || r.error); // e.g. ENOENT — don't let a missing binary masquerade as a 124 timeout
  return { status: r.status === null ? 124 : r.status, out: r.stdout || '', err };
}
