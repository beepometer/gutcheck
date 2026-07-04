import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeOne, alreadyDone, isInsideRepo, sweepLeakedProveDirs } from './drive-probes.mjs';
import { appendJsonl } from './lib.mjs';

function localRemote() { // origin repo: commit1 = SUT+sound test; commit2 (HEAD) = adds a hollow test
  const d = mkdtempSync(join(tmpdir(), 'ev-remote-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  writeFileSync(join(d, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/sound.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert';\nimport { dbl } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(dbl(3), 6); });\n");
  execFileSync('git', ['-C', d, 'init', '-q']); g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
  writeFileSync(join(d, 'test/hollow.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert';\nimport { dbl } from '../src/lib.mjs';\ntest('hollow', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });\n");
  g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agent adds test']);
  const sha = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { d, sha };
}

test('probeOne: clones, probes the diff, and reports the planted hollow', () => {
  const { d, sha } = localRemote();
  const clones = mkdtempSync(join(tmpdir(), 'ev-clones-'));
  const item = { id: `local@${sha.slice(0, 7)}`, repo: 'local/remote', sha, parent_expr: `${sha}^`, clone_url: d, test_files: ['test/hollow.test.mjs'] };
  const r = probeOne(item, { clonesDir: clones });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.gutcheck.hollow.length, 1);
  assert.match(r.gutcheck.hollow[0].name, /hollow/);
  assert.ok(r.gutcheck_version.length >= 7 - 3);
  rmSync(d, { recursive: true, force: true }); rmSync(clones, { recursive: true, force: true });
});

test('probeOne: a dead clone_url yields clone-failed, never a throw', () => {
  const clones = mkdtempSync(join(tmpdir(), 'ev-clones2-'));
  const r = probeOne({ id: 'x@0000000', repo: 'x/dead', sha: '0'.repeat(40), parent_expr: 'HEAD^', clone_url: '/no/such/remote-xyz' }, { clonesDir: clones });
  assert.equal(r.status, 'clone-failed');
  rmSync(clones, { recursive: true, force: true });
});

test('alreadyDone reads resume state', () => {
  const d = mkdtempSync(join(tmpdir(), 'ev-res-'));
  const f = join(d, 'results.jsonl');
  appendJsonl(f, { id: 'a@1' }); appendJsonl(f, { id: 'b@2' });
  assert.deepEqual([...alreadyDone(f)].sort(), ['a@1', 'b@2']);
  rmSync(d, { recursive: true, force: true });
});

test('probeOne: a malformed work item (missing repo) never throws — returns a probe-error row', () => {
  const clones = mkdtempSync(join(tmpdir(), 'ev-clones3-'));
  const r = probeOne({ id: 'bad@0000000' }, { clonesDir: clones });
  assert.equal(r.status, 'probe-error');
  assert.equal(r.id, 'bad@0000000');
  assert.equal(r.repo, null);
  assert.equal(r.sha, null);
  assert.ok(r.error && r.error.length > 0);
  rmSync(clones, { recursive: true, force: true });
});

test('probeOne: an item missing even `id` still returns a row, never throws', () => {
  const clones = mkdtempSync(join(tmpdir(), 'ev-clones4-'));
  assert.doesNotThrow(() => {
    const r = probeOne({}, { clonesDir: clones });
    assert.equal(r.status, 'probe-error');
    assert.equal(r.id, 'malformed-item');
  });
  rmSync(clones, { recursive: true, force: true });
});

test('isInsideRepo: symlink resolution catches aliasing (e.g. macOS /tmp -> /private/tmp)', () => {
  const fakeRepo = mkdtempSync(join(tmpdir(), 'ev-repo-'));
  const inner = join(fakeRepo, 'clones');
  mkdirSync(inner);
  const link = join(tmpdir(), `ev-link-${process.pid}-${Date.now()}`);
  symlinkSync(inner, link);
  assert.equal(isInsideRepo(link, fakeRepo), true);
  rmSync(link, { force: true }); rmSync(fakeRepo, { recursive: true, force: true });
});

test('isInsideRepo: a sibling dir sharing only a string prefix is not flagged', () => {
  const base = mkdtempSync(join(tmpdir(), 'ev-base-'));
  const repo = join(base, 'skeptic'); mkdirSync(repo);
  const clones = join(base, 'skeptic-clones'); mkdirSync(clones);
  assert.equal(isInsideRepo(clones, repo), false);
  rmSync(base, { recursive: true, force: true });
});

test('isInsideRepo: the repo root itself is rejected (rel === "")', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ev-selfrepo-'));
  assert.equal(isInsideRepo(repo, repo), true);
  rmSync(repo, { recursive: true, force: true });
});

test('sweepLeakedProveDirs: removes only stale gutcheck-prove-* dirs, never fresh ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'ev-tmproot-'));
  const stale = join(root, 'gutcheck-prove-stale');
  const fresh = join(root, 'gutcheck-prove-fresh');
  mkdirSync(stale); mkdirSync(fresh);
  const old = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
  utimesSync(stale, old, old);
  const removed = sweepLeakedProveDirs(root, 30 * 60 * 1000);
  assert.deepEqual(removed, [stale]);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(fresh));
  rmSync(root, { recursive: true, force: true });
});
