import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPlan, pluginManifest } from '../scripts/build-plugin.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'gutcheck');

function walk(d, acc = []) {
  for (const e of readdirSync(d).sort()) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

test('dist/gutcheck is in sync with the source (no drift)', () => {
  for (const { src, distRel } of copyPlan()) {
    const distPath = join(OUT, distRel);
    assert.ok(existsSync(distPath), `missing in dist: ${distRel} — run npm run build:plugin`);
    assert.deepEqual(readFileSync(distPath), readFileSync(src), `dist out of sync: ${distRel} — run npm run build:plugin`);
  }
});

test('dist/gutcheck has no orphan files (everything is accounted for by the copy plan)', () => {
  const planned = new Set(copyPlan().map((p) => p.distRel));
  planned.add('.claude-plugin/plugin.json');
  planned.add('package.json');
  for (const f of walk(OUT)) {
    const rel = relative(OUT, f);
    assert.ok(planned.has(rel), `stale dist file: ${rel} — run npm run build:plugin`);
  }
});

test('the plugin manifest is stamped from package.json (one version source)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const committed = JSON.parse(readFileSync(join(OUT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(committed.version, pkg.version);
  assert.equal(readFileSync(join(OUT, '.claude-plugin', 'plugin.json'), 'utf8'), pluginManifest());
  assert.equal(JSON.parse(readFileSync(join(OUT, 'package.json'), 'utf8')).version, pkg.version);
});

test('the marketplace points at the one bundle', () => {
  const mp = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(mp.plugins.length, 1);
  assert.equal(mp.plugins[0].source, './dist/gutcheck');
});

test('dist ships 1 discipline skill + 1 citation agent + the LICENSE', () => {
  const plan = copyPlan();
  assert.equal(plan.filter((p) => p.distRel.endsWith('SKILL.md')).length, 1);
  assert.equal(plan.filter((p) => p.distRel.startsWith('agents/')).length, 1);
  assert.ok(existsSync(join(OUT, 'skills/check/SKILL.md')), 'the check discipline skill must ship in dist');
  assert.ok(existsSync(join(OUT, 'agents/citation-verifier.md')), 'the citation-verifier agent must ship in dist');
  assert.ok(existsSync(join(OUT, 'LICENSE')), 'the MIT LICENSE must travel with the installed plugin');
});

// The whole point of bundling: an installed plugin can RUN the checker without cloning the repo.
// These prove the checker code + a generic config floor travel with dist, and that dist is generated
// (not a stale hand-copy) by pinning the bundled core to the repo source byte-for-byte.
test('dist bundles the runnable checker + a generic 5-check config floor', () => {
  assert.ok(existsSync(join(OUT, 'checker', 'cli.mjs')), 'dist must bundle checker/cli.mjs');
  const distCore = join(OUT, 'checker', 'core.mjs');
  assert.ok(existsSync(distCore), 'dist must bundle checker/core.mjs');
  assert.equal(readFileSync(distCore, 'utf8'), readFileSync(join(ROOT, 'checker', 'core.mjs'), 'utf8'),
    'dist/gutcheck/checker/core.mjs must be byte-identical to the repo checker (dist is generated, not stale) — run npm run build:plugin');
  const cfgPath = join(OUT, 'gutcheck.config.json');
  assert.ok(existsSync(cfgPath), 'dist must bundle a generic gutcheck.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.checker.checks.length, 5, 'the bundled config floor must carry exactly 5 checks');
});

// End-to-end: the BUNDLED artifact actually runs, not just that the files are present. The bundled
// skill + agent prose (dist/gutcheck/skills, dist/gutcheck/agents) is itself a known-clean harness —
// self-hosting, so no separate fixture pack is needed — and a nonexistent test dir makes the
// test-source checks vacuous → the bundled checker must exit 0 / OK.
test('the bundled checker runs and reports OK on its own bundled harness', () => {
  const out = execFileSync('node', [
    join(OUT, 'checker', 'cli.mjs'),
    '--config', join(OUT, 'gutcheck.config.json'),
    '--harness', OUT,
    '--repo-root', OUT,
    '--src-test', join(OUT, '__no_such_test_dir__'),
  ], { encoding: 'utf8' }); // execFileSync throws on a nonzero exit → an offender/meta-guard fails the test
  assert.match(out, /OK — 5 checks passed/, 'bundled checker must report OK on its own bundled harness');
});

// The configure skill runs the BUNDLED detector against the adopter's repo with no clone. These prove
// detect.mjs + the two data files it needs travel with dist, that detect.mjs is generated (byte-for-byte
// the repo source), and that gutcheck.default.json sits next to it (detect.mjs reads it as a sibling).
test('dist bundles the configure detector + its data files (byte-identical to the repo source)', () => {
  const distDetect = join(OUT, 'configure', 'detect.mjs');
  assert.ok(existsSync(distDetect), 'dist must bundle configure/detect.mjs');
  assert.equal(readFileSync(distDetect, 'utf8'), readFileSync(join(ROOT, 'configure', 'detect.mjs'), 'utf8'),
    'dist/gutcheck/configure/detect.mjs must be byte-identical to the repo detector (dist is generated, not stale) — run npm run build:plugin');
  for (const f of ['gutcheck.default.json']) {
    const distF = join(OUT, 'configure', f);
    assert.ok(existsSync(distF), `dist must bundle configure/${f}`);
    assert.equal(readFileSync(distF, 'utf8'), readFileSync(join(ROOT, 'configure', f), 'utf8'),
      `dist/gutcheck/configure/${f} must be byte-identical to the repo source — run npm run build:plugin`);
  }
  // detect.mjs imports the per-language check sets from ./checksets/ — they must travel too, byte-identical.
  const csDir = join(ROOT, 'configure', 'checksets');
  for (const f of readdirSync(csDir)) {
    const distF = join(OUT, 'configure', 'checksets', f);
    assert.ok(existsSync(distF), `dist must bundle configure/checksets/${f}`);
    assert.equal(readFileSync(distF, 'utf8'), readFileSync(join(csDir, f), 'utf8'),
      `dist/gutcheck/configure/checksets/${f} must be byte-identical — run npm run build:plugin`);
  }
});

// End-to-end: the BUNDLED detector actually runs from dist (not just that the files are present). It
// reads its sibling gutcheck.default.json at import — if that file did not travel, this throws / exits
// nonzero. A throwaway Node fixture must yield a draft carrying the full five-check checker floor.
test('the bundled detector runs from dist and emits a checker floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeptic-bundled-detect-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
    const out = execFileSync('node', [join(OUT, 'configure', 'detect.mjs'), dir], { encoding: 'utf8' });
    const draft = JSON.parse(out); // throws if the bundled detector printed non-JSON
    assert.ok(draft.checker && Array.isArray(draft.checker.checks), 'bundled detector must emit a checker.checks block');
    assert.equal(draft.checker.checks.length, 5, 'a Node project must get the full five-check floor from the bundled detector');
    assert.equal(draft._detected.buildSystem, 'node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: the bundled mutation/gutcheck.mjs CLI imports ../checker/standalone.mjs + core.mjs, so
// checker/ must travel with dist or the installed plugin's CLI dies with ERR_MODULE_NOT_FOUND. Prove the
// shipped CLI actually starts, and that mutation/ is bundled byte-identical (generated, not a stale copy).
test('the installed-plugin CLI runs (checker/ + mutation/ are bundled, no ERR_MODULE_NOT_FOUND)', () => {
  const out = execFileSync('node', [join(OUT, 'mutation', 'gutcheck.mjs'), '--version'], { encoding: 'utf8' });
  assert.match(out, /gutcheck/, 'shipped `gutcheck --version` must run and print a version');
  // every top-level mutation/*.mjs must travel byte-identical (dist is generated, not a stale hand-copy)
  for (const f of readdirSync(join(ROOT, 'mutation')).filter((n) => n.endsWith('.mjs'))) {
    const dst = join(OUT, 'mutation', f);
    assert.ok(existsSync(dst), `dist must bundle mutation/${f} — run npm run build:plugin`);
    assert.equal(readFileSync(dst, 'utf8'), readFileSync(join(ROOT, 'mutation', f), 'utf8'), `mutation/${f} out of sync — run npm run build:plugin`);
  }
});

test('marketplace.json lists the gutcheck plugin with a repo-relative source', () => {
  const mk = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(mk.name, 'gutcheck');
  const p = mk.plugins.find((x) => x.name === 'gutcheck');
  assert.ok(p, 'marketplace must list the gutcheck plugin');
  assert.ok(p.source.startsWith('./'), 'plugin source must be a repo-relative ./ path');
});

test('dist/gutcheck ships the SessionStart + UserPromptSubmit hooks byte-identical to the source', () => {
  for (const f of ['hooks.json', 'session-start', 'user-prompt-submit']) {
    const distPath = join(OUT, 'hooks', f);
    assert.ok(existsSync(distPath), `missing in dist: hooks/${f} — run npm run build:plugin`);
    assert.equal(readFileSync(distPath, 'utf8'), readFileSync(join(ROOT, 'hooks', f), 'utf8'),
      `hook out of sync: hooks/${f} — run npm run build:plugin`);
  }
  const hj = JSON.parse(readFileSync(join(OUT, 'hooks', 'hooks.json'), 'utf8'));
  const ss = hj.hooks?.SessionStart?.[0]?.hooks?.[0];
  assert.ok(ss, 'hooks.json must declare a SessionStart command hook');
  assert.match(ss.command, /hooks\/session-start/, 'SessionStart must invoke hooks/session-start');
  const ssScript = readFileSync(join(OUT, 'hooks', 'session-start'), 'utf8');
  assert.match(ssScript, /skills\/check\/SKILL\.md/, 'session-start must read the check skill');
  assert.match(ssScript, /hookSpecificOutput/, 'session-start must emit hookSpecificOutput (Claude Code)');

  // UserPromptSubmit: the foundation-verification cue injected on substantive prompts
  // (gated in-script; a neutral prompt does not trigger foundation re-verification on
  // its own, the prompt-adjacent cue does — short pleasantries are skipped).
  const ups = hj.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
  assert.ok(ups, 'hooks.json must declare a UserPromptSubmit command hook');
  assert.match(ups.command, /hooks\/user-prompt-submit/, 'UserPromptSubmit must invoke hooks/user-prompt-submit');
  const upsScript = readFileSync(join(OUT, 'hooks', 'user-prompt-submit'), 'utf8');
  assert.match(upsScript, /UserPromptSubmit/, 'user-prompt-submit must name the UserPromptSubmit event');
  assert.match(upsScript, /hookSpecificOutput/, 'user-prompt-submit must emit hookSpecificOutput (Claude Code)');
  assert.match(upsScript, /verify the foundation/i, 'user-prompt-submit must carry the foundation-verification cue');
});
