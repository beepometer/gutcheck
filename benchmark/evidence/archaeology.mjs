#!/usr/bin/env node
// Escaped-bug archaeology: in each already-cloned repo's 50-commit window, find revert/regression
// commits, extract the function names their diffs touch, and probe the PRE-bug tests that mention
// those functions. A hollow hit here = "the tests that let this bug through were provably hollow"
// — a case-study candidate for manual audit, never an automatic claim.
// No silent drops: every candidate examined appends exactly one row (probed, no-candidate-fns,
// no-matching-tests, probe-error, checkout-failed, or install-failed). The per-repo candidate cap
// is logged, not hidden: a repo with more than CANDIDATE_CAP matches gets one extra cap-reached row.
// Usage: node archaeology.mjs --clones=<abs dir> [--out=benchmark/evidence/results]
// KNOWN LIMITATION (audit gate, do not trust hollow_hits unaudited): survivors carry BARE function
// names, and testsMentioning matches by substring — a same-named function in an unrelated module can
// collide into hollow_hits. Every hit MUST pass the Task-7 manual audit (trace the test file's own
// import to the exact source file the fix commit touched) before any case-study use.
import { appendJsonl, sh, isTestFile } from './lib.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANDIDATE_CAP = 3;
const STALE_LOCK_MS = 5 * 60 * 1000;

// %x01 is a literal SOH byte git emits verbatim into the log — an unambiguous field separator that
// can't collide with commit-subject text (unlike the naive %H%s + char-split, which shredded every
// subject into single characters).
export function findCandidates(dir) {
  const r = sh('git', ['-C', dir, 'log', '--format=%H%x01%s', '-i', '-E', '--grep', 'revert|regression|reintroduc'], { timeoutMs: 30000 });
  return r.out.split('\n').filter(Boolean).map((l) => { const [sha, subject] = l.split('\x01'); return { sha, subject }; });
}

// Function names from the fix commit's diff: declaration lines added/removed + git hunk contexts.
export function changedFns(dir, sha) {
  const r = sh('git', ['-C', dir, 'show', '--unified=0', '--format=', sha], { timeoutMs: 30000 });
  const names = new Set();
  for (const m of r.out.matchAll(/^@@.*@@.*?(?:function\s+|def\s+|const\s+|let\s+)?([A-Za-z_$][\w$]*)\s*[(=]/gm)) names.add(m[1]);
  for (const m of r.out.matchAll(/^[+-]\s*(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+)([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  const noise = new Set(['if', 'for', 'while', 'switch', 'return', 'it', 'test', 'describe', 'expect', 'assert', 'import', 'from', 'mock', 'require', 'start', 'stop']);
  return [...names].filter((n) => !noise.has(n) && n.length > 2);
}

export function testsMentioning(dir, fns) {
  const all = sh('git', ['-C', dir, 'ls-files'], { timeoutMs: 30000 }).out.split('\n').filter(Boolean).filter(isTestFile);
  return all.filter((f) => {
    let code; try { code = readFileSync(join(dir, f), 'utf8'); } catch { return false; }
    return fns.some((fn) => code.includes(fn));
  });
}

// A SIGKILL'd prior git op (see lib.mjs sh(), which SIGKILLs on timeout) can leave a stale
// .git/index.lock that fails every future checkout in this clone. Only remove one old enough
// (5min) that a still-running concurrent op couldn't possibly be the one holding it.
export function clearStaleLock(dir) {
  const lock = join(dir, '.git', 'index.lock');
  let st; try { st = statSync(lock); } catch { return; }
  if (Date.now() - st.mtimeMs > STALE_LOCK_MS) { try { unlinkSync(lock); } catch {} }
}

function installIfNeeded(dir) {
  if (!existsSync(join(dir, 'package.json'))) return { status: 0, out: '', err: '' };
  return sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeoutMs: 300000 });
}

// Every candidate examined appends exactly one row — never a silent `continue` with nothing
// recorded. Task 2's clones carry node_modules installed for the WORK ITEM's sha; a prebug commit
// can have a different dependency tree, so probing it against the later tree is systematically
// wrong. Re-installing after each prebug checkout (capped at 3 candidates/repo, so this stays
// bounded) keeps the probe honest for that commit instead of silently probing the wrong one.
export function scanRepo(dir, repo, outFile) {
  clearStaleLock(dir);
  const origHead = sh('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: 30000 }).out.trim();
  const candidates = findCandidates(dir);
  const capped = candidates.slice(0, CANDIDATE_CAP);
  if (candidates.length > CANDIDATE_CAP) {
    const dropped = candidates.length - CANDIDATE_CAP;
    appendJsonl(outFile, { repo, status: 'cap-reached', dropped });
    console.log(`${repo}: cap reached — ${dropped} candidate(s) dropped`);
  }

  for (const { sha, subject } of capped) {
    const prebug = `${sha}^`;
    const row = { repo, fix_sha: sha, subject, prebug_expr: prebug, changed_fns: [], matched_test_files: [], probe: null, status: 'no-candidate-fns', hollow_hits: [] };
    const co = sh('git', ['-C', dir, 'checkout', '--quiet', '--force', prebug], { timeoutMs: 60000 });
    if (co.status !== 0) {
      row.status = 'checkout-failed';
      row.error = co.err.slice(-300);
      appendJsonl(outFile, row);
      console.log(`${repo} ${sha.slice(0, 7)} → checkout-failed`);
      continue;
    }
    const inst = installIfNeeded(dir);
    if (inst.status !== 0) {
      row.status = 'install-failed';
      row.error = inst.err.slice(-300);
      row.changed_fns = changedFns(dir, sha);
      appendJsonl(outFile, row);
      console.log(`${repo} ${sha.slice(0, 7)} → install-failed`);
      continue;
    }
    const fns = changedFns(dir, sha);
    row.changed_fns = fns;
    if (fns.length) {
      const tests = testsMentioning(dir, fns);
      row.matched_test_files = tests;
      row.status = tests.length ? 'probed' : 'no-matching-tests';
      if (tests.length) {
        const p = sh('node', [join(REPO_ROOT, 'mutation', 'gutcheck.mjs'), dir, '--json', '--no-self-check', '--no-fallback', `--files=${tests.slice(0, 5).join(',')}`, '--max-probes=20'], { timeoutMs: 10 * 60 * 1000 });
        try { row.probe = JSON.parse(p.out); } catch { row.status = 'probe-error'; }
        if (row.probe) row.hollow_hits = row.probe.hollow.filter((h) => h.survivors.some((s) => fns.includes(s)));
      }
    }
    appendJsonl(outFile, row);
    console.log(`${repo} ${sha.slice(0, 7)} "${subject.slice(0, 50)}" → ${row.status}${row.hollow_hits.length ? ` ★ ${row.hollow_hits.length} HOLLOW-on-changed-fn` : ''}`);
  }

  // Restore: leave the clone exactly as the driver left it — idempotent for any future re-drive.
  clearStaleLock(dir);
  sh('git', ['-C', dir, 'checkout', '--quiet', '--force', origHead], { timeoutMs: 60000 });
  installIfNeeded(dir);
}

if (process.argv[1] && process.argv[1].endsWith('archaeology.mjs')) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const clones = resolve(args.clones); const outFile = `${args.out || 'benchmark/evidence/results'}/archaeology.jsonl`;
  for (const e of readdirSync(clones)) scanRepo(join(clones, e), e.replace('__', '/'), outFile);
}
