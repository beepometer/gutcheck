#!/usr/bin/env node
// Untested-fraction trend over the existing confirmatory corpus, by agent family × harvest month —
// the "is the 88%-untested window closing, or is it structural?" estimand. Pure join + tally; the CLI
// tail runs it over the tracked corpus files and prints the tables (every figure recounts from raw rows).
// Usage: node trend.mjs [resultsFile workFile]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const monthOf = (query) => {
  const m = /committer-date:(\d{4}-\d{2})-\d{2}\.\./.exec(query || '');
  return m ? m[1] : 'unknown';
};

export function trend(resultRows, workRows) {
  const meta = new Map(workRows.map((w) => [w.id, { family: w.family || 'unknown', month: monthOf(w.query) }]));
  const mk = () => ({ fns: 0, untested: 0, proven: 0, unverifiable: 0, hollow: 0, diffs: 0 });
  const by_family = {}, by_month = {}, family_month = {};
  let rows_joined = 0;
  for (const r of resultRows) {
    if (r.status !== 'ok' || !r.gutcheck || !r.gutcheck.changeSummary) continue;
    const cs = r.gutcheck.changeSummary;
    if (!cs.fns) continue;
    const m = meta.get(r.id) || { family: 'unknown', month: 'unknown' };
    rows_joined++;
    for (const [key, bucket] of [[m.family, by_family], [m.month, by_month], [`${m.family}|${m.month}`, family_month]]) {
      const b = (bucket[key] ||= mk());
      b.diffs++; b.fns += cs.fns; b.untested += cs.untested; b.proven += cs.proven;
      b.unverifiable += cs.unverifiable; b.hollow += cs.hollow;
    }
  }
  for (const bucket of [by_family, by_month, family_month]) {
    for (const b of Object.values(bucket)) b.pct = b.fns ? Math.round((b.untested / b.fns) * 1000) / 10 : null;
  }
  return { by_family, by_month, family_month, rows_joined };
}

if (process.argv[1] && process.argv[1].endsWith('trend.mjs')) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const base = join(HERE, '..', 'evidence', 'results-confirmatory');
  const results = readFileSync(process.argv[2] || join(base, 'results-gen2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const work = readFileSync(process.argv[3] || join(base, 'work.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const t = trend(results, work);
  console.log(`joined ${t.rows_joined} ok-diffs with changed functions\n`);
  const table = (title, bucket) => {
    console.log(title);
    for (const [k, b] of Object.entries(bucket).sort()) {
      console.log(`  ${k.padEnd(12)} diffs=${String(b.diffs).padStart(4)} fns=${String(b.fns).padStart(6)} untested=${String(b.pct).padStart(5)}% proven=${b.fns ? Math.round((b.proven / b.fns) * 1000) / 10 : '-'}%`);
    }
    console.log('');
  };
  table('BY FAMILY', t.by_family);
  table('BY MONTH', t.by_month);
}
