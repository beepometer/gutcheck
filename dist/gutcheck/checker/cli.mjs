#!/usr/bin/env node
// gutcheck check CLI — runs the portable coherence checks against a project's harness.
//   node checker/cli.mjs [--config gutcheck.config.json] [--harness .claude] [--repo-root .]
//                        [--src-test path/a,path/b]
// Exit 0 = clean; 1 = offender(s) or a meta-guard failure; 2 = usage/config error.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { runChecker } from './core.mjs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) { a[m[1]] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const configPath = resolve(args.config || 'gutcheck.config.json');
if (!existsSync(configPath)) {
  console.error(`gutcheck check: config not found at ${configPath} (pass --config <path>)`);
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const harness = resolve(args.harness || (config.checker && config.checker.harnessRoot) || '.claude');
const repoRoot = resolve(args['repo-root'] || dirname(harness));
const testSrcRoots = args['src-test']
  ? String(args['src-test']).split(',').map((r) => resolve(r))
  : ((config.paths && config.paths.srcRoots && config.paths.srcRoots.test) || []).map((r) => join(repoRoot, r));

let res;
try {
  res = runChecker(config, { harnessDir: harness, repoRoot, testSrcRoots });
} catch (err) {
  // A misconfigured check (e.g. an unsupported language.fileExt with no lexer grammar) must exit
  // cleanly as a config error, not crash with an uncaught stack trace.
  console.error(`gutcheck check: config error — ${err.message}`);
  process.exit(2);
}

if (res.phase === 'meta-guard') {
  console.error('gutcheck check: META-GUARD FAILED — a check is missing or failing its own self-test:');
  for (const f of res.failures) console.error('  ✗ ' + f);
  process.exit(1);
}
const advisories = res.offenders.filter((o) => o.severity === 'advisory');
const failing = res.offenders.filter((o) => o.severity !== 'advisory');
// Advisories (e.g. weak-oracle candidates) are surfaced but never fail the run — they are a worklist to
// probe, not a gate. Print them under their own heading whether or not there are hard offenders.
const printAdvisories = () => {
  if (!advisories.length) return;
  console.error(`gutcheck check: ${advisories.length} advisory finding(s) (not failing — review or probe):`);
  for (const o of advisories) console.error(`  • ${o.file ? `${o.file}:${o.line}` : `[${o.check}]`}  (${o.check})  ${o.token || ''}`);
};
if (res.ok) {
  console.log(`gutcheck check: OK — ${res.checkCount} checks passed, 0 offenders.`);
  printAdvisories();
  process.exit(0);
}
console.error(`gutcheck check: FAILED — ${failing.length} offender(s) across ${res.checkCount} checks:`);
for (const o of failing) {
  const loc = o.file ? `${o.file}:${o.line}` : `[${o.check}]`;
  console.error(`  ✗ ${loc}  (${o.check})  ${o.token || ''}`);
}
printAdvisories();
process.exit(1);
