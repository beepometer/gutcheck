#!/usr/bin/env node
// Harvest real AI-authored test-touching commits from GitHub, round-robin across agent families
// (breaks the Claude-supply-dominance bias a single flat query list produces). Mechanical sampling:
// queries in fixed order, feed order preserved, every exclusion logged to the funnel. No manual repo
// selection, ever — family only parameterizes which queries run; judge() itself never sees `family`.
// Usage: node harvest-trailers.mjs --limit-per-family=8 [--out=benchmark/evidence/results]
//   [--families=claude,codex] [--windows=2026-01-01..2026-01-31,2026-02-01..2026-02-28]
//   [--quotas=claude:217,copilot:217,...]  (explicit per-family caps; overrides --limit-per-family)
import { isTestFile, appendJsonl, readJsonl, sh } from './lib.mjs';

// Six agent families, real trailer/author query strings (each verified to return live wild-supply
// results via a one-off gh api probe during development). `claude` is reused verbatim from the
// pre-generalization QUERIES list (regression anchor: same two strings, same order).
export const AGENT_FAMILIES = {
  claude: ['"Co-authored-by: Claude"', '"Generated with Claude Code"'],
  copilot: ['"Co-authored-by: Copilot"', 'author:copilot-swe-agent[bot]'],
  cursor: ['"Co-authored-by: Cursor"', 'author:cursoragent'],
  devin: ['author:devin-ai-integration[bot]'],
  codex: ['"Co-authored-by: openai-codex"', '"Co-authored-by: ChatGPT"'],
  aider: ['"Co-authored-by: aider"'],
};
// Fixed order — canonical round-robin sequence and the deterministic tie-break order used by
// redistributeQuota's remainder assignment.
export const FAMILY_NAMES = Object.keys(AGENT_FAMILIES);

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
// Family-agnostic by design: it never sees which family's query found the candidate — the frozen
// pre-registration forbids any selection logic beyond this mechanical funnel.
export function judge(candidate, seenRepos) {
  const { repoMeta, files, parents } = candidate;
  if (!repoMeta || !files) return 'fetch-error';
  if (repoMeta.fork) return 'fork';
  if (repoMeta.size > MAX_REPO_KB) return 'repo-too-large';
  if (seenRepos.has(repoMeta.full_name)) return `dup-repo:${seenRepos.get(repoMeta.full_name)}`;
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

// Pure cross-family dedup decision — unit-tested. The same commit (same repo@sha) can be reachable
// via two different family signatures (e.g. a commit with both a Claude and a Copilot trailer).
// `priorCandidates`: candidates already judged in an earlier PROCESS invocation (resume state) —
// silent, matches shouldSkip's historical no-row/no-refetch behavior exactly.
// `familyOwner`: Map(candidate -> family) built up live during THIS invocation only.
// Returns 'resume' (prior run, silent), 'own-family' (this family already saw it via one of its own
// other queries, silent — matches the pre-generalization single-family behavior where Claude's two
// queries could overlap), the OWNING family name (a different family claimed it first this run — the
// caller logs this as a dup, "first family wins"), or null (brand new candidate, proceed).
export function dedupDecision(cand, family, priorCandidates, familyOwner) {
  if (shouldSkip(cand, priorCandidates)) return 'resume';
  const owner = familyOwner.get(cand);
  if (owner === undefined) return null;
  return owner === family ? 'own-family' : owner;
}

// Pure quota allocator — unit-tested with hand-derived cases (thin-supply, zero-supply, all-rich).
// supply: {family: knownOrEstimatedAvailableCount}; a family missing from `supply` has 0 known supply
// (honest default — never invents supply for an unlisted family). target: total desired across all
// families in `order`. Each family's base share is min(supply[family] ?? 0, ceil(target/order.length)).
// A family that can't fill its base share (thin/zero supply) leaves a shortfall; families whose supply
// exceeds base ("rich") absorb it, proportional to their excess capacity (supply - base), floor-rounded,
// with any integer-rounding remainder assigned one-by-one to rich families in `order`, each capped at
// its own remaining supply. If total available supply < target, the returned quotas sum to the
// available total, not to target — a documented ceiling, never a fabricated one.
export function redistributeQuota(supply, target, order) {
  const n = order.length;
  if (n === 0) return {};
  const base = Math.ceil(target / n);
  const quota = {};
  let shortfall = 0;
  const rich = [];
  for (const f of order) {
    const s = supply[f] ?? 0;
    const take = Math.min(s, base);
    quota[f] = take;
    if (take < base) shortfall += base - take;
    else if (s > base) rich.push(f);
  }
  if (shortfall > 0 && rich.length) {
    const totalExcess = rich.reduce((sum, f) => sum + (supply[f] - base), 0);
    let distributed = 0;
    for (const f of rich) {
      const excess = supply[f] - base;
      const share = totalExcess > 0 ? Math.floor((shortfall * excess) / totalExcess) : 0;
      quota[f] += share;
      distributed += share;
    }
    let remainder = shortfall - distributed;
    for (const f of rich) {
      if (remainder <= 0) break;
      const room = supply[f] - quota[f];
      const add = Math.min(room, remainder);
      quota[f] += add;
      remainder -= add;
    }
  }
  return quota;
}

export function harvest({ outDir, windows, families = FAMILY_NAMES, quotas = {} }) {
  const workFile = `${outDir}/work.jsonl`, funnelFile = `${outDir}/funnel.jsonl`;
  const workRows = readJsonl(workFile), funnelRows = readJsonl(funnelFile);
  // corpus-wide, family-agnostic: one accepted commit per repo, ever. Map repo -> owning family
  // so dup-repo funnel rows can say WHICH family holds the slot (cross-family repo-slot asymmetry
  // must be measurable at full scale — review finding, 2026-07-04).
  const seenRepos = new Map(workRows.map((w) => [w.repo, w.family || 'prior']));
  const priorCandidates = new Set([...workRows.map((w) => w.id), ...funnelRows.map((f) => f.candidate)]);
  const familyOwner = new Map(); // candidate -> family, built live during this invocation only
  const emittedByFamily = Object.fromEntries(families.map((f) => [f, workRows.filter((w) => w.family === f).length]));
  const totalEmitted = () => Object.values(emittedByFamily).reduce((a, b) => a + b, 0);
  let consecutiveRateLimited = 0;

  for (const family of families) {
    const quota = quotas[family] ?? 0;
    const baseQueries = AGENT_FAMILIES[family];
    if (!baseQueries) { console.error(`harvest: unknown family '${family}', skipping`); continue; }
    const queries = windows && windows.length ? windowedQueries(baseQueries, windows) : baseQueries;
    for (const query of queries) {
      for (let page = 1; page <= 10 && emittedByFamily[family] < quota; page++) {
        const q = encodeURIComponent(query);
        const res = ghJson(`/search/commits?q=${q}&sort=committer-date&order=desc&per_page=30&page=${page}`);
        if (!res || !res.items || !res.items.length) break;
        for (const item of res.items) {
          if (emittedByFamily[family] >= quota) break;
          const full = item.repository.full_name, sha = item.sha;
          const cand = `${full}@${sha.slice(0, 7)}`;
          const decision = dedupDecision(cand, family, priorCandidates, familyOwner);
          if (decision === 'resume' || decision === 'own-family') continue; // silent — no row, no fetch
          if (decision) { // a different family already claimed this candidate this run: first family wins, logged
            appendJsonl(funnelFile, { query, family, candidate: cand, excluded: 'dup-family-sha', claimed_by: decision });
            continue;
          }
          const detail = ghJson(`/repos/${full}/commits/${sha}`);
          const repoMeta = ghJson(`/repos/${full}`);
          sh('node', ['-e', 'setTimeout(()=>{}, 700)'], { timeoutMs: 2000 }); // pace core-API calls under the hourly budget
          if (detail === 'RATE_LIMITED' || repoMeta === 'RATE_LIMITED') {
            appendJsonl(funnelFile, { query, family, candidate: cand, excluded: 'rate-limited' });
            familyOwner.set(cand, family);
            consecutiveRateLimited++;
            if (consecutiveRateLimited >= CONSECUTIVE_RATE_LIMIT_STOP) {
              console.log(`harvest stopping: ${CONSECUTIVE_RATE_LIMIT_STOP} consecutive rate-limited candidates, ${totalEmitted()} work item(s) collected so far (resume by re-running — already-judged candidates are skipped)`);
              process.exit(0);
            }
            continue;
          }
          consecutiveRateLimited = 0;
          const verdict = judge({ repoMeta, files: detail && detail.files, parents: detail && detail.parents }, seenRepos);
          familyOwner.set(cand, family);
          if (typeof verdict === 'string') { appendJsonl(funnelFile, { query, family, candidate: cand, excluded: verdict }); continue; }
          seenRepos.set(full, family);
          appendJsonl(workFile, { id: cand, source: 'trailer', family, query, repo: full, sha, parent_expr: `${sha}^`, clone_url: `https://github.com/${full}.git`, size_kb: repoMeta.size, test_files: verdict.testFiles });
          emittedByFamily[family]++;
          console.log(`[${family} ${emittedByFamily[family]}/${quota}] ${cand} (${verdict.testFiles.length} test file(s))`);
        }
        sh('node', ['-e', 'setTimeout(()=>{}, 2200)'], { timeoutMs: 5000 }); // search API: 30 req/min authed
      }
    }
  }
  console.log(`harvest done: ${totalEmitted()} total work item(s) across ${families.length} famil${families.length === 1 ? 'y' : 'ies'}`);
  for (const family of families) console.log(`  ${family}: ${emittedByFamily[family]}/${quotas[family] ?? 0}`);
  console.log(`funnel at ${funnelFile}`);
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
if (process.argv[1] && process.argv[1].endsWith('harvest-trailers.mjs')) {
  const families = (args.families ? args.families.split(',').map((f) => f.trim()).filter(Boolean) : FAMILY_NAMES)
    .filter((f) => {
      if (!AGENT_FAMILIES[f]) { console.error(`harvest: unknown family '${f}' in --families, ignoring`); return false; }
      return true;
    });
  const windows = args.windows ? args.windows.split(',').map((w) => w.trim()).filter(Boolean) : null;
  let quotas;
  if (args.quotas) {
    quotas = {};
    for (const pair of args.quotas.split(',')) {
      const [f, n] = pair.split(':');
      if (f) quotas[f.trim()] = Number(n);
    }
  } else if (args['limit-per-family']) {
    const flat = Number(args['limit-per-family']);
    quotas = Object.fromEntries(families.map((f) => [f, flat]));
  } else {
    const target = Number(args.target || args.limit || 1300);
    quotas = Object.fromEntries(families.map((f) => [f, Math.ceil(target / families.length)]));
  }
  harvest({
    outDir: args.out || 'benchmark/evidence/results',
    windows,
    families,
    quotas,
  });
}
