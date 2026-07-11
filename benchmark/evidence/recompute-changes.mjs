#!/usr/bin/env node
// Recomputes the published per-function headline (Σ fns / untested / unverifiable / proven) and the
// corpus-level counts (commits / ok / scored blocks / hollow tests) from the TRACKED corpus alone —
// `benchmark/evidence/corpus/diffs.jsonl` — never from the gitignored results*.jsonl drive outputs.
// Exists so the headline is a receipt, not an assertion: the figures in README.md must recompute
// from data anyone who clones the repo can see.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORPUS_PATH = join(REPO_ROOT, 'benchmark', 'evidence', 'corpus', 'diffs.jsonl');

export function readCorpus(path = CORPUS_PATH) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function pct(n, d) { return d ? ((n / d) * 100).toFixed(1) : '0.0'; }

// Pure: rows = parsed corpus.diffs.jsonl. Each row's per-function columns (fns, proven, hollow_fns,
// unverifiable, untested) are 0 on non-ok / no-changeSummary rows, so summing over ALL rows is correct.
export function recompute(rows) {
  let ok = 0, scoredBlocks = 0, hollowTests = 0;
  let fns = 0, proven = 0, hollowFns = 0, unverifiable = 0, untested = 0;
  for (const r of rows) {
    if (r.status === 'ok') ok++;
    scoredBlocks += r.scored || 0;
    hollowTests += r.hollow || 0;
    fns += r.fns || 0;
    proven += r.proven || 0;
    hollowFns += r.hollow_fns || 0;
    unverifiable += r.unverifiable || 0;
    untested += r.untested || 0;
  }
  return {
    commits: rows.length, ok, scoredBlocks, hollowTests,
    fns, proven, hollowFns, unverifiable, untested,
    pct: { untested: pct(untested, fns), unverifiable: pct(unverifiable, fns), proven: pct(proven, fns) },
  };
}

if (process.argv[1] && process.argv[1].endsWith('recompute-changes.mjs')) {
  console.log(JSON.stringify(recompute(readCorpus()), null, 2));
}
