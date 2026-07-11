#!/usr/bin/env node
// Lint-shape corpus measurement (CYCLE 10, PAT T3): run the FULL configured checker floor — at the
// time of this sweep, 7 configured checks (six source-discipline kinds + citation), including the two
// measurement-gated ones reachable only via config — over every pilot clone, and tally offenders per
// check. Output feeds the audit; nothing here promotes anything.
// NOTE (post-measurement): the floor's composition has since changed — selfComparisonOracle was pulled
// from the adopter-facing floor entirely, on the strength of THIS sweep's own CYCLE-10 measurement
// (high base rate, ~zero defect yield). This file is left as-history (it recorded what actually ran at
// sweep time, a 7-check floor); it is not re-run against the current (6-check) floor.
// Usage: node benchmark/evidence/lint-sweep.mjs --clones=<abs dir> [--out=benchmark/evidence/results]
import { appendJsonl } from './lib.mjs';
import { configForProject } from '../../checker/standalone.mjs';
import { runChecker } from '../../checker/core.mjs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const clones = resolve(args.clones);
const outFile = `${args.out || 'benchmark/evidence/results'}/lint-sweep.jsonl`;

let scanned = 0, errored = 0, withFindings = 0;
const tally = {};
for (const entry of readdirSync(clones).sort()) {
  const dir = join(clones, entry);
  let row = { repo: entry.replace('__', '/'), status: 'ok', findings: [] };
  try {
    const built = configForProject(dir);
    if (!built.cfg) { row.status = 'no-config'; appendJsonl(outFile, row); continue; }
    const res = runChecker(built.cfg, { harnessDir: dir, repoRoot: dir, testSrcRoots: built.testRoots });
    if (res.phase !== 'scan') { row.status = `meta-guard:${(res.failures || []).length}`; appendJsonl(outFile, row); errored++; continue; }
    row.findings = (res.offenders || []).map((o) => ({ check: o.check, file: o.file, line: o.line, severity: o.severity }));
    for (const f of row.findings) tally[f.check] = (tally[f.check] || 0) + 1;
    if (row.findings.length) withFindings++;
    scanned++;
  } catch (e) { row.status = 'error'; row.error = String(e && e.message).slice(0, 200); errored++; }
  appendJsonl(outFile, row);
}
console.log(JSON.stringify({ scanned, errored, withFindings, tally }, null, 1));
