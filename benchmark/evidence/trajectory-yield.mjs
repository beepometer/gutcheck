#!/usr/bin/env node
// Trajectory test-writing yield: of the model patches in the 3 most-recent SWE-bench "verified"
// submissions, how many touch a test file? Count-first — an honest "agents rarely write tests" (or
// even "layout-defeated") is an acceptable outcome. Mechanical selection only: submission dirs are
// picked by lexicographic date-prefix sort, descending, never hand-picked.
//
// Layout found (2026-07-03, via `gh api` + unauthenticated S3 GETs — no git clone): the GitHub repo
// (github.com/swe-bench/experiments, contents API) holds only README.md + metadata.yaml + a
// `results/` scoring summary per submission dir under `evaluation/verified/`. The actual model
// patches are NOT in the git repo — metadata.yaml points to `s3://swe-bench-submissions/verified/
// <submission>/{logs,trajs}`, a public, unauthenticated, listable S3 bucket. Two bulk-patch file
// shapes were observed at the submission root (adapt-per-escape-valve; both handled here):
//   - `<submission>/preds.json`      — JSON object keyed by instance_id, each value
//                                      `{instance_id, model_patch, model_name_or_path}`
//   - `<submission>/all_preds.jsonl` — JSONL, one such object per line
// (a slower, per-instance-file alternative also exists at `logs/<instance_id>/patch.diff`, matching
// the brief's anticipated tree shape, but the bulk file is a single GET instead of ~500).
// Usage: node trajectory-yield.mjs [--out=benchmark/evidence/results]
import { isTestFile, sh } from './lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const S3_BASE = 'https://swe-bench-submissions.s3.amazonaws.com/verified';
const EXAMPLE_CAP = 10;

// Parses unified-diff `+++ b/<path>` headers (git's new-file-side header). A deleted file's header
// is `+++ /dev/null` — no b/<path> to extract, so it's skipped rather than crashing the parse of the
// rest of the patch. Quoted paths (git quotes paths with special/non-ASCII chars) are unquoted.
export function testFilesInPatch(patchText) {
  if (!patchText) return [];
  const paths = [];
  for (const m of patchText.matchAll(/^\+\+\+ (.+?)\r?$/gm)) {
    const raw = m[1].trim().replace(/^"(.*)"$/, '$1');
    if (raw === '/dev/null') continue;
    paths.push(raw.startsWith('b/') ? raw.slice(2) : raw);
  }
  return paths.filter(isTestFile);
}

// gh api contents listing of the submission dirs, sorted lexicographically (date-prefixed names)
// descending — mechanical, no hand-picking. Returns null on any fetch/parse failure.
export function listSubmissions() {
  const r = sh('gh', ['api', '-H', 'Accept: application/vnd.github+json', 'repos/swe-bench/experiments/contents/evaluation/verified'], { timeoutMs: 30000 });
  if (r.status !== 0) return null;
  let entries; try { entries = JSON.parse(r.out); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  return entries.filter((e) => e.type === 'dir').map((e) => e.name).sort().reverse();
}

// lib.mjs's sh() runs spawnSync without a maxBuffer, which silently truncates (ENOBUFS) past
// Node's 1MB default — both preds.json files here are >1MB. Node's built-in fetch has no such cap,
// so the S3 GETs go through it directly instead of shelling out to curl via sh().
async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

// Bulk-fetch a submission's model patches from the public S3 bucket. Tries preds.json first, then
// all_preds.jsonl (the two shapes observed across the 3 chosen submissions) — never a per-instance
// fetch loop (500+ requests) unless neither bulk file exists.
export async function fetchPatches(submission) {
  const base = `${S3_BASE}/${submission}`;
  const predsText = await fetchText(`${base}/preds.json`);
  if (predsText) {
    try {
      const obj = JSON.parse(predsText);
      const patches = Object.values(obj).map((v) => ({ instance_id: v.instance_id, model_patch: v.model_patch }));
      if (patches.length) return { layout: 'preds.json', patches };
    } catch { /* fall through to jsonl */ }
  }
  const jsonlText = await fetchText(`${base}/all_preds.jsonl`);
  if (jsonlText) {
    const patches = [];
    for (const line of jsonlText.split('\n')) {
      if (!line.trim()) continue;
      try { const v = JSON.parse(line); patches.push({ instance_id: v.instance_id, model_patch: v.model_patch }); } catch { /* skip torn line */ }
    }
    if (patches.length) return { layout: 'all_preds.jsonl', patches };
  }
  return { layout: null, patches: [] };
}

export function writeYield(outDir, data) {
  const file = `${outDir}/trajectory-yield.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

export async function run({ outDir = 'benchmark/evidence/results', submissionCount = 3 } = {}) {
  const names = listSubmissions();
  if (!names || !names.length) {
    const file = writeYield(outDir, { status: 'layout-defeated', notes: 'gh api repos/swe-bench/experiments/contents/evaluation/verified failed or returned no submission dirs' });
    console.log(`layout-defeated: wrote ${file}`);
    return;
  }
  const chosen = names.slice(0, submissionCount);
  console.log(`3 most recent (lexicographic date-prefix, descending): ${chosen.join(', ')}`);

  const submissions_checked = [];
  const examples = [];
  const layoutNotes = [];
  let patches_scanned = 0, patches_touching_tests = 0;

  for (const sub of chosen) {
    const { layout, patches } = await fetchPatches(sub);
    layoutNotes.push(`${sub}: ${layout || 'NO BULK PATCH FILE FOUND (tried preds.json, all_preds.jsonl)'} — ${patches.length} patch(es)`);
    console.log(layoutNotes[layoutNotes.length - 1]);
    if (!layout) continue;
    submissions_checked.push(sub);
    for (const p of patches) {
      patches_scanned++;
      const testFiles = testFilesInPatch(p.model_patch || '');
      if (testFiles.length) {
        patches_touching_tests++;
        if (examples.length < EXAMPLE_CAP) examples.push({ submission: sub, instance_id: p.instance_id, test_files: testFiles });
      }
    }
  }

  if (!submissions_checked.length) {
    const file = writeYield(outDir, { status: 'layout-defeated', notes: layoutNotes.join(' | ') });
    console.log(`layout-defeated: wrote ${file}`);
    return;
  }

  const file = writeYield(outDir, { submissions_checked, patches_scanned, patches_touching_tests, examples });
  console.log(`wrote ${file}: ${patches_touching_tests}/${patches_scanned} patches touch a test file`);
}

if (process.argv[1] && process.argv[1].endsWith('trajectory-yield.mjs')) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  await run({ outDir: args.out || 'benchmark/evidence/results' });
}
