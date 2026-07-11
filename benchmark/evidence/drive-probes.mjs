#!/usr/bin/env node
// Probe each harvested work item: shallow clone OUTSIDE the repo, install without scripts, run
// gutcheck diff-scoped, append one result row. Resumable: items already in results.jsonl are skipped.
// Containment: --ignore-scripts installs; the probe itself executes repo test code in temp copies
// with per-item timeouts — accepted pilot posture, documented in the plan.
// Usage: node drive-probes.mjs --clones=<abs dir> [--work=...] [--results=...] [--limit=N]
import { appendJsonl, readJsonl, sh } from './lib.mjs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ITEM_TIMEOUT_MS = 15 * 60 * 1000;
const LEAK_MAX_AGE_MS = 30 * 60 * 1000;

export const alreadyDone = (resultsFile) => new Set(readJsonl(resultsFile).map((r) => r.id));

// realpath + boundary-aware: catches both symlink blindness (macOS /tmp -> /private/tmp) and the
// false positive on a sibling dir that merely shares a string prefix (e.g. "repo-clones" next
// to "repo"). Returns true iff clonesDir IS repoRoot or lies inside it — the violation to reject.
export function isInsideRepo(clonesDir, repoRoot) {
  mkdirSync(clonesDir, { recursive: true });
  const realClones = realpathSync(clonesDir);
  const realRepo = realpathSync(repoRoot);
  const rel = relative(realRepo, realClones);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// A timed-out gutcheck probe is SIGKILLed (see lib.mjs sh()), so prove.mjs's `finally` never runs
// and its mkdtemp'd repo copy under os.tmpdir() leaks. Sweep only copies older than maxAgeMs so a
// concurrent run's still-live copy is never touched. tmpRoot is injectable for tests.
export function sweepLeakedProveDirs(tmpRoot = tmpdir(), maxAgeMs = LEAK_MAX_AGE_MS) {
  let entries; try { entries = readdirSync(tmpRoot); } catch { return []; }
  const now = Date.now();
  const removed = [];
  for (const name of entries) {
    if (!name.startsWith('gutcheck-prove-')) continue;
    const p = join(tmpRoot, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (now - st.mtimeMs > maxAgeMs) {
      try { rmSync(p, { recursive: true, force: true }); removed.push(p); } catch {}
    }
  }
  return removed;
}

export function probeOne(item, { clonesDir, repoRoot = REPO_ROOT }) {
  const t0 = Date.now();
  try {
    const gv = sh('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD']).out.trim();
    const row = (status, extra = {}) => ({ id: item.id, repo: item.repo, sha: item.sha, status, gutcheck: null, elapsed_ms: Date.now() - t0, gutcheck_version: gv, ...extra });
    const dir = join(clonesDir, item.repo.replace('/', '__'));
    if (!existsSync(dir)) {
      const c = sh('git', ['clone', '--depth=50', '--quiet', item.clone_url, dir], { timeoutMs: 300000 });
      if (c.status !== 0) return row('clone-failed', { error: c.err.slice(-300) });
    }
    const f = sh('git', ['-C', dir, 'fetch', '--depth=50', '--quiet', 'origin', item.sha], { timeoutMs: 300000 });
    const co = sh('git', ['-C', dir, 'checkout', '--quiet', '--force', item.sha], { timeoutMs: 60000 });
    if (f.status !== 0 || co.status !== 0) return row('checkout-failed', { error: (f.err + co.err).slice(-300) });
    if (existsSync(join(dir, 'package.json'))) {
      const i = sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], { cwd: dir, timeoutMs: 300000 });
      if (i.status !== 0) return row('install-failed', { error: i.err.slice(-300) });
    }
    const p = sh('node', [join(repoRoot, 'mutation', 'gutcheck.mjs'), dir, '--json', '--no-fallback', '--no-self-check', `--since=${item.parent_expr}`, '--max-probes=40'], { timeoutMs: ITEM_TIMEOUT_MS });
    if (p.status === 124) { sweepLeakedProveDirs(); return row('timeout'); }
    let parsed = null; try { parsed = JSON.parse(p.out); } catch {}
    if (!parsed) return row('probe-error', { error: (p.err || p.out).slice(-300) });
    return row('ok', { gutcheck: parsed });
  } catch (e) {
    // Blanket net for a malformed work item (e.g. missing `repo`): never let a poison-pill item
    // crash before any row exists, or it's retried and crashes every resume forever. Only ever
    // touch item fields that are safe to be absent.
    return {
      id: item.id ?? 'malformed-item',
      repo: item.repo ?? null,
      sha: item.sha ?? null,
      status: 'probe-error',
      gutcheck: null,
      elapsed_ms: Date.now() - t0,
      gutcheck_version: null,
      error: String(e && e.message).slice(0, 300),
    };
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const outDir = args.out || 'benchmark/evidence/results';
  const workFile = args.work || `${outDir}/work.jsonl`, resultsFile = args.results || `${outDir}/results.jsonl`;
  if (!args.clones) { console.error('drive-probes: --clones=<dir> is required (must be OUTSIDE the repo)'); process.exit(2); }
  const clonesDir = resolve(args.clones); // REQUIRED, must be outside the repo
  if (isInsideRepo(clonesDir, REPO_ROOT)) { console.error('clones dir must be OUTSIDE the repo'); process.exit(2); }
  // fail-closed: refuse to drive if the probe cannot catch its own planted fake
  const scRaw = await import(join(REPO_ROOT, 'mutation', 'selfcheck.mjs'));
  const sc = scRaw.selfCheck();
  if (!sc.ok) { console.error(`gutcheck self-check FAILED — ${sc.detail}; refusing to drive`); process.exit(2); }
  const done = alreadyDone(resultsFile);
  const work = readJsonl(workFile).filter((w) => !done.has(w.id)).slice(0, Number(args.limit || Infinity));
  console.log(`driving ${work.length} item(s), ${done.size} already done`);
  for (const [i, item] of work.entries()) {
    const r = probeOne(item, { clonesDir });
    appendJsonl(resultsFile, r);
    // --purge-after: delete the clone once its verdict row is durably appended — bounds disk usage
    // for corpus-scale drives (the 2026-07-05 confirmatory run filled 188GB and ENOSPC'd the tail).
    // Any later audit re-clones individual repos on demand; the results row is the record.
    if ('purge-after' in args) { try { rmSync(join(clonesDir, item.repo.replace('/', '__')), { recursive: true, force: true }); } catch {} }
    const g = r.gutcheck;
    console.log(`[${i + 1}/${work.length}] ${item.id} → ${r.status}${g ? ` scored=${g.scored} hollow=${g.hollow.length} skipped=${g.skipped.length} outOfScope=${g.outOfScope}` : ''} (${Math.round(r.elapsed_ms / 1000)}s)`);
  }
}
if (process.argv[1] && process.argv[1].endsWith('drive-probes.mjs')) await main();
