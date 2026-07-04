// checker/corpus.mjs — file-set + universe helpers the check kinds scan over.
// ctx = { harnessDir, repoRoot, harnessDirs, testSrcRoots, srcExt, classDeclRegexSrc, ... }.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', '.gradle', '.idea',
  'target', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'out', 'coverage', '.next',
]);

export function repoRootOf(harnessDir) { return dirname(harnessDir); }

export function relPath(file, ctx) {
  try { return relative(ctx.repoRoot || ctx.harnessDir, file); } catch { return file; }
}

// skills/<dir>/SKILL.md + agents/*.md — the universal harness-markdown scan corpus.
export function harnessMarkdown(ctx) {
  const hd = ctx.harnessDirs || { skills: 'skills', agents: 'agents' };
  const files = [];
  const skillsDir = join(ctx.harnessDir, hd.skills);
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir).sort()) {
      const p = join(skillsDir, d, 'SKILL.md');
      if (existsSync(p) && statSync(p).isFile()) files.push(p);
    }
  }
  const agentsDir = join(ctx.harnessDir, hd.agents);
  if (existsSync(agentsDir)) {
    // .isFile() guard mirrors the skills side: a directory literally named `*.md` must not be
    // pushed (readFileSync on it would throw EISDIR and crash the runner). Sorted for deterministic output.
    for (const f of readdirSync(agentsDir).sort()) {
      const p = join(agentsDir, f);
      if (f.endsWith('.md') && statSync(p).isFile()) files.push(p);
    }
  }
  return files;
}

export function walkFiles(root, ext) {
  const out = [];
  const rec = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  if (existsSync(root)) rec(root);
  return out;
}

export { readFileSync, existsSync, join, basename };
