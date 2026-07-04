#!/usr/bin/env node
// build-plugin — assemble the installable Claude Code plugin at dist/gutcheck by COPYING source
// files verbatim (no templating; the skill/agent prose is plain markdown maintained in place).
// test/plugin-dist.test.mjs proves the committed dist/ byte-matches a fresh build with no orphans.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'gutcheck');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Everything the installed plugin needs at runtime. Whole directories travel verbatim.
const DIRS = ['mutation', 'checker', 'configure', 'skills', 'agents', 'hooks'];
const FILES = ['LICENSE'];

export function copyPlan() {
  const plan = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel)).sort()) {
      const r = `${rel}/${e}`;
      if (statSync(join(ROOT, r)).isDirectory()) walk(r);
      else plan.push({ src: join(ROOT, r), distRel: r });
    }
  };
  for (const d of DIRS) walk(d);
  for (const f of FILES) plan.push({ src: join(ROOT, f), distRel: f });
  // skills/check/SKILL.md points at "${CLAUDE_PLUGIN_ROOT}/gutcheck.config.json" as the bundled
  // config floor — ship the generic default config at the plugin root under that name so the path
  // resolves for an installed (no-clone) plugin.
  plan.push({ src: join(ROOT, 'configure/gutcheck.default.json'), distRel: 'gutcheck.config.json' });
  return plan;
}

export function pluginManifest() {
  return JSON.stringify({
    name: 'gutcheck',
    description: 'Prove your AI-written tests actually test your code — a fast, diff-scoped mutation probe that guts each tested function and reports the tests that don\'t notice, plus a self-testing deterministic checker that fails closed unless it catches its own planted bugs.',
    version: PKG.version,
    author: { name: 'the Gutcheck authors' },
    license: 'MIT',
    repository: 'https://github.com/beepometer/gutcheck',
    homepage: 'https://github.com/beepometer/gutcheck',
    keywords: ['mutation-testing', 'test-quality', 'hollow-tests', 'ai-generated-code', 'static-analysis', 'code-review', 'testing', 'agents', 'claude-code'],
  }, null, 2) + '\n';
}

export function build() {
  rmSync(OUT, { recursive: true, force: true });
  for (const { src, distRel } of copyPlan()) {
    const dest = join(OUT, distRel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  mkdirSync(join(OUT, '.claude-plugin'), { recursive: true });
  writeFileSync(join(OUT, '.claude-plugin', 'plugin.json'), pluginManifest());
  // The bundled CLI (mutation/gutcheck.mjs) reads ../package.json for its --version string; without one
  // here it falls back to 0.0.0 for an installed (no-clone) plugin. Stamp a minimal one from the same
  // package.json the manifest above is stamped from — one version source.
  writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'gutcheck', version: PKG.version, type: 'module' }, null, 2) + '\n');
  console.log(`built dist/gutcheck: ${copyPlan().length} files + plugin.json`);
}

if (process.argv[1] && process.argv[1].endsWith('build-plugin.mjs')) build();
