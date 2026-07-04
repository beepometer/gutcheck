#!/usr/bin/env node
import { mkdtempSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repos = JSON.parse(execSync(`cat ${JSON.stringify(join(HERE, 'repos.json'))}`).toString());
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const PROVE = resolve(arg('prove', join(HERE, '../../mutation/prove.mjs')));
const OUT = resolve(arg('out', join(HERE, 'baseline.json')));

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 }).toString();
const results = [];
for (const r of repos) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), `reach-${r.name}-`)));
  const dir = join(work, r.name);
  try {
    sh(`git clone --depth 1 ${JSON.stringify(r.url)} ${JSON.stringify(dir)}`, work);
    try { sh(r.install, dir); } catch (e) { /* record install failure but still probe */ }
    let out = '';
    try { out = sh(`node ${JSON.stringify(PROVE)} ${JSON.stringify(dir)} --json`, dir); }
    catch (e) { out = (e.stdout || '').toString(); } // exit 1 when a hollow is found
    const j = JSON.parse(out.trim().split('\n').pop());
    results.push({ name: r.name, lang: r.lang, runner: j.runner, probes: j.probes, scored: j.scored, caught: j.caught,
      hollow: j.hollow, skipped: (j.skipped || []).length, inconclusive: (j.inconclusive || []).length, outOfScope: j.outOfScope });
  } catch (e) {
    results.push({ name: r.name, lang: r.lang, error: String(e && e.message).slice(0, 200) });
  } finally { rmSync(work, { recursive: true, force: true }); }
}
const tot = (k) => results.reduce((s, x) => s + (x[k] || 0), 0);
const totalBlocks = tot('scored') + tot('skipped') + tot('inconclusive');
const summary = { probedFraction: totalBlocks ? +(tot('scored') / totalBlocks).toFixed(3) : 0,
  scored: tot('scored'), skipped: tot('skipped'), inconclusive: tot('inconclusive'),
  caught: tot('caught'), hollow: results.reduce((s, x) => s + ((x.hollow && x.hollow.length) || 0), 0) };
writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
process.stdout.write(`wrote ${OUT}\nprobedFraction=${summary.probedFraction} scored=${summary.scored} skipped=${summary.skipped}\n`);
