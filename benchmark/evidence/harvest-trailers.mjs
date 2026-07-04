#!/usr/bin/env node
// Harvest real AI-authored test-touching commits from GitHub. Mechanical sampling: queries in fixed
// order, feed order preserved, every exclusion logged to the funnel. No manual repo selection, ever.
// Usage: node harvest-trailers.mjs --limit=250 [--out=benchmark/evidence/results]
//   [--windows=2026-01-01..2026-01-31,2026-02-01..2026-02-28]
import { isTestFile, appendJsonl, readJsonl, sh } from './lib.mjs';

export const QUERIES = [
  '"Co-authored-by: Claude"',
  '"Generated with Claude Code"',
  '"Co-authored-by: Copilot"',
  'author:devin-ai-integration[bot]',
  '"Co-authored-by: openhands"',
  '"Co-authored-by: Cursor"',
];
const MAX_REPO_KB = 150 * 1024;
const CONSECUTIVE_RATE_LIMIT_STOP = 3;

// Cross-product of base queries × fixed date windows — pure, unit-tested. Windows are decided a
// priori by the caller (--windows=<comma-separated date-ranges>), never adapted mid-run.
export function windowedQueries(baseQueries, windows) {
  return baseQueries.flatMap((b) => windows.map((w) => `${b} committer-date:${w}`));
}

// True when gh's stderr indicates the call was rejected for rate limiting, not some other failure.
export function isRateLimited(err) {
  return /API rate limit exceeded/i.test(err || '') || /\b(403|429)\b/.test(err || '');
}

// gh api wrapper: returns parsed JSON, null (fetch-error, logged upstream), or the sentinel string
// 'RATE_LIMITED' (distinct from null) when a rate-limited call still fails after one 60s-backoff retry.
export function ghJson(path) {
  const call = () => sh('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], { timeoutMs: 60000 });
  let r = call();
  if (r.status !== 0) {
    if (!isRateLimited(r.err)) return null;
    sh('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 65000 }); // rate limit: back off 60s, retry once
    r = call();
    if (r.status !== 0) return 'RATE_LIMITED';
  }
  try { return JSON.parse(r.out); } catch { return null; }
}

// Pure funnel decision — unit-tested. commit: {repo:{full_name,fork,size}, sha, files:[{filename}], parents:[...]}
export function judge(candidate, seenRepos) {
  const { repoMeta, files, parents } = candidate;
  if (!repoMeta || !files) return 'fetch-error';
  if (repoMeta.fork) return 'fork';
  if (repoMeta.size > MAX_REPO_KB) return 'repo-too-large';
  if (seenRepos.has(repoMeta.full_name)) return 'dup-repo';
  if (!parents || parents.length !== 1) return 'fetch-error'; // merges/roots: no clean parent diff
  const testFiles = files.map((f) => f.filename).filter(isTestFile);
  if (!testFiles.length) return 'no-test-file';
  // language filtering lives inside isTestFile (only JS/TS/Py shapes match) — a lone .rb "test" lands in no-test-file
  return { testFiles };
}

// Pure resume decision — unit-tested. A candidate already judged in a prior run (accepted into
// work.jsonl or rejected into funnel.jsonl) is skipped entirely: no new row, no re-fetch.
export function shouldSkip(cand, seenCandidates) {
  return seenCandidates.has(cand);
}

export function harvest({ limit, outDir, windows }) {
  const workFile = `${outDir}/work.jsonl`, funnelFile = `${outDir}/funnel.jsonl`;
  const workRows = readJsonl(workFile), funnelRows = readJsonl(funnelFile);
  const seenRepos = new Set(workRows.map((w) => w.repo));
  const seenCandidates = new Set([...workRows.map((w) => w.id), ...funnelRows.map((f) => f.candidate)]);
  let emitted = workRows.length;
  const queries = windows && windows.length ? windowedQueries(QUERIES, windows) : QUERIES;
  let consecutiveRateLimited = 0;
  for (const query of queries) {
    for (let page = 1; page <= 10 && emitted < limit; page++) {
      const q = encodeURIComponent(query);
      const res = ghJson(`/search/commits?q=${q}&sort=committer-date&order=desc&per_page=30&page=${page}`);
      if (!res || !res.items || !res.items.length) break;
      for (const item of res.items) {
        if (emitted >= limit) break;
        const full = item.repository.full_name, sha = item.sha;
        const cand = `${full}@${sha.slice(0, 7)}`;
        if (shouldSkip(cand, seenCandidates)) continue; // already judged in a prior run — no row, no fetch
        const detail = ghJson(`/repos/${full}/commits/${sha}`);
        const repoMeta = ghJson(`/repos/${full}`);
        sh('node', ['-e', 'setTimeout(()=>{}, 700)'], { timeoutMs: 2000 }); // pace core-API calls under the hourly budget
        if (detail === 'RATE_LIMITED' || repoMeta === 'RATE_LIMITED') {
          appendJsonl(funnelFile, { query, candidate: cand, excluded: 'rate-limited' });
          seenCandidates.add(cand);
          consecutiveRateLimited++;
          if (consecutiveRateLimited >= CONSECUTIVE_RATE_LIMIT_STOP) {
            console.log(`harvest stopping: ${CONSECUTIVE_RATE_LIMIT_STOP} consecutive rate-limited candidates, ${emitted} work item(s) collected so far (resume by re-running — already-judged candidates are skipped)`);
            process.exit(0);
          }
          continue;
        }
        consecutiveRateLimited = 0;
        const verdict = judge({ repoMeta, files: detail && detail.files, parents: detail && detail.parents }, seenRepos);
        seenCandidates.add(cand);
        if (typeof verdict === 'string') { appendJsonl(funnelFile, { query, candidate: cand, excluded: verdict }); continue; }
        seenRepos.add(full);
        appendJsonl(workFile, { id: cand, source: 'trailer', query, repo: full, sha, parent_expr: `${sha}^`, clone_url: `https://github.com/${full}.git`, size_kb: repoMeta.size, test_files: verdict.testFiles });
        emitted++;
        console.log(`[${emitted}/${limit}] ${cand} (${verdict.testFiles.length} test file(s))`);
      }
      sh('node', ['-e', 'setTimeout(()=>{}, 2200)'], { timeoutMs: 5000 }); // search API: 30 req/min authed
    }
  }
  console.log(`harvest done: ${emitted} work items, funnel at ${funnelFile}`);
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
if (process.argv[1] && process.argv[1].endsWith('harvest-trailers.mjs'))
  harvest({
    limit: Number(args.limit || 250),
    outDir: args.out || 'benchmark/evidence/results',
    windows: args.windows ? args.windows.split(',').map((w) => w.trim()).filter(Boolean) : null,
  });
