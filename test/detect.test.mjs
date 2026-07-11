import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from '../configure/detect.mjs';
import { buildChecks, runMetaGuard } from '../checker/core.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CFG = JSON.parse(readFileSync(join(REPO_ROOT, 'configure', 'gutcheck.default.json'), 'utf8'));
const ids = (cfg) => cfg.checker.checks.map((c) => c.id).sort();

// Build a throwaway fixture project dir; files is a map of relPath -> contents.
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'gc-detect-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

test('detects a Gradle/Kotlin project (build + language + rules file + branch)', () => {
  const dir = fixture({
    'build.gradle.kts': 'plugins { kotlin("jvm") }\n',
    'CLAUDE.md': '# Project\nBacklog uses R-12 / S-3 finding ids.\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
  });
  try {
    const d = detect(dir);
    assert.equal(d._detected.buildSystem, 'gradle');
    assert.equal(d.language.fileExt, '.kt');
    assert.deepEqual(d.language.declKeywords, ['fun', 'class', 'object', 'val']);
    assert.equal(d.language.docCommentForm, 'KDoc');
    assert.match(d.commands.test, /gradlew/);
    assert.equal(d.docs.projectRulesFile, 'CLAUDE.md');
    assert.equal(d.docs.defaultBranch, 'main');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detects a Node/TypeScript project with a test script', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
    'tsconfig.json': '{}',
    '.git/HEAD': 'ref: refs/heads/develop\n',
  });
  try {
    const d = detect(dir);
    assert.equal(d._detected.buildSystem, 'node');
    assert.equal(d.language.fileExt, '.ts');
    assert.equal(d.commands.test, 'npm test');
    assert.equal(d.docs.defaultBranch, 'develop');
    assert.equal(d.docs.projectRulesFile, null); // no rules file in this fixture
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detects a Python project', () => {
  const dir = fixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
  try {
    const d = detect(dir);
    assert.equal(d._detected.buildSystem, 'python');
    assert.equal(d.language.fileExt, '.py');
    assert.equal(d.commands.test, 'pytest');
    assert.equal(d.language.docCommentForm, 'docstring');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unrecognized project yields a null draft without throwing (owner fills it)', () => {
  const dir = fixture({ 'README.md': 'hello\n' });
  try {
    const d = detect(dir);
    assert.equal(d._detected.buildSystem, null);
    assert.equal(d.language.fileExt, null);
    assert.equal(d.commands.test, null);
    assert.equal(d.docs.defaultBranch, null);
    // shape is still complete (every group present) so the owner can fill it field-by-field:
    for (const g of ['identity', 'commands', 'language', 'paths', 'docs', 'checker']) {
      assert.ok(d[g], `draft missing group ${g}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the draft carries an identity.productName slot (the owner must fill it)', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }) });
  try {
    const d = detect(dir);
    assert.ok('productName' in d.identity, 'draft.identity must expose a productName slot for the owner to fill');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed package.json does not throw; test command stays null', () => {
  const dir = fixture({ 'package.json': '{ this is not json' });
  try {
    const d = detect(dir);
    assert.equal(d._detected.buildSystem, 'node');
    assert.equal(d.commands.test, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- detect emits the language-gated source-discipline floor sourced from gutcheck.default.json ---

test('a Node project gets the full source-discipline floor (ids == the shipped default config)', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }) });
  try {
    const d = detect(dir);
    assert.deepEqual(ids(d), ids(DEFAULT_CFG));
    assert.equal(d.checker.checks.length, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Python project gets the language-agnostic citation check + the Python source checks', () => {
  const dir = fixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
  try {
    const d = detect(dir);
    assert.deepEqual(ids(d), [
      'external-citation-needs-url',
      'py-assertion-consistency', 'py-derivation-coherence', 'py-magic-literal-guard',
      'py-shadow-oracle-guard', 'py-test-shape-guards',
    ]);
    assert.equal(d.checker.checks.length, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Rust/Cargo project is still detected (build system) but carries only the citation check (no calibrated source set)', () => {
  const dir = fixture({ 'Cargo.toml': '[package]\nname = "x"\n' });
  try {
    const d = detect(dir);
    assert.equal(d._detected.buildSystem, 'cargo');
    assert.deepEqual(ids(d), ['external-citation-needs-url']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unrecognized project (no known build file) gets only the language-agnostic citation check', () => {
  const dir = fixture({ 'README.md': '# x\n' });
  try {
    assert.deepEqual(ids(detect(dir)), ['external-citation-needs-url']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the emitted Python floor self-validates: runMetaGuard(buildChecks(detect(python)))===[]', () => {
  const dir = fixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
  try {
    // Proves the Python assertion regexes still flag every must-flag fixture AND clear every
    // must-not-flag fixture — the checker would refuse to run otherwise.
    assert.deepEqual(runMetaGuard(buildChecks(detect(dir))), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paths.srcRoots is probed from immediate children; external-citation scans the test roots', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
    'test/x.test.js': 'x', 'src/a.js': 'y',
  });
  try {
    const d = detect(dir);
    assert.ok(d.paths.srcRoots.test.includes('test'), 'srcRoots.test must contain the probed test/ dir');
    assert.ok(d.paths.srcRoots.main.includes('src'), 'srcRoots.main must contain the probed src/ dir');
    const cite = d.checker.checks.find((c) => c.id === 'external-citation-needs-url');
    assert.deepEqual(cite.params.scanRoots, ['test'], 'external-citation scans the test tree only (src-widening reverted: ~94% FP on real code)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the emitted floor self-validates: runMetaGuard(buildChecks(detect(node)))===[]', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }) });
  try {
    assert.deepEqual(runMetaGuard(buildChecks(detect(dir))), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
