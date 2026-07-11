import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every dist/ path the README names resolves', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const paths = [...new Set(readme.match(/dist\/gutcheck[\w-]*/g) || [])];
  // Non-vacuity: the existence loop must run over real matches, not silently pass on zero.
  assert.ok(paths.length >= 1, `expected ≥1 dist path mentions in README, found ${paths.length}`);
  for (const p of paths) assert.ok(existsSync(join(ROOT, p)), `README names a non-existent dist path: ${p}`);
});

test('every repo-dir path the README names resolves in the source tree', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Inline-backtick'd paths into the repo's top-level source dirs (dist/ is covered by the test above).
  // Catches a stale or slug-rendered path leaking into source-tree prose.
  const re = /`((?:skills|agents|checker|configure|scripts|ci)\/[\w./-]*)`/g;
  const paths = [...new Set([...readme.matchAll(re)].map((m) => m[1].replace(/\/$/, '')))];
  assert.ok(paths.length >= 1, `expected ≥1 repo-dir path mention in README, found ${paths.length}`);
  for (const p of paths) assert.ok(existsSync(join(ROOT, p)), `README names a non-existent repo path: ${p}`);
});
