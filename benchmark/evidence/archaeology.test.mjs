import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findCandidates, changedFns, testsMentioning, scanRepo, clearStaleLock } from './archaeology.mjs';
import { readJsonl } from './lib.mjs';

// base commit: calc() correct + a hollow test that only mentions calc. "break calc" commit: calc's
// return is flipped — only the hollow test covers it, so nothing catches the break. fix commit:
// subject contains "Revert" and restores calc — the escaped-bug case the scanner is built to find.
function localRepo() {
  const d = mkdtempSync(join(tmpdir(), 'arch-repo-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  writeFileSync(join(d, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/calc.mjs'), 'export function calc(a, b) { return a + b; }\n');
  writeFileSync(join(d, 'test/calc.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert';\nimport { calc } from '../src/calc.mjs';\ntest('hollow calc', () => { const e = calc(2, 3); assert.strictEqual(calc(2, 3), e); });\n");
  execFileSync('git', ['-C', d, 'init', '-q']); g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);

  writeFileSync(join(d, 'src/calc.mjs'), 'export function calc(a, b) { return a - b; }\n');
  g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'break calc']);

  writeFileSync(join(d, 'src/calc.mjs'), 'export function calc(a, b) { return a + b; }\n');
  g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Revert "break calc"']);
  const fixSha = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { d, fixSha };
}

test('findCandidates: finds the Revert-subject fix commit, subject intact (separator fix)', () => {
  const { d, fixSha } = localRepo();
  const cs = findCandidates(d);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].sha, fixSha);
  assert.equal(cs[0].subject, 'Revert "break calc"');
  rmSync(d, { recursive: true, force: true });
});

test('changedFns: the fix commit diff names calc', () => {
  const { d, fixSha } = localRepo();
  const fns = changedFns(d, fixSha);
  assert.ok(fns.includes('calc'), JSON.stringify(fns));
  rmSync(d, { recursive: true, force: true });
});

test('changedFns: filters noise keywords including import, from, mock, require, start, stop', () => {
  const d = mkdtempSync(join(tmpdir(), 'arch-noise-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  writeFileSync(join(d, 'test.mjs'), 'export function calc(a, b) { return a + b; }\n');
  execFileSync('git', ['-C', d, 'init', '-q']); g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);

  writeFileSync(join(d, 'test.mjs'), 'from moses.loop import (\n  def calc(a, b):\n    return a + b\nvi.mock("x", () => ({ require: start, stop }))');
  g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add noise']);
  const noiseSha = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const fns = changedFns(d, noiseSha);
  assert.ok(!fns.includes('import'), `import should be filtered: ${JSON.stringify(fns)}`);
  assert.ok(!fns.includes('from'), `from should be filtered: ${JSON.stringify(fns)}`);
  assert.ok(!fns.includes('mock'), `mock should be filtered: ${JSON.stringify(fns)}`);
  assert.ok(!fns.includes('require'), `require should be filtered: ${JSON.stringify(fns)}`);
  assert.ok(!fns.includes('start'), `start should be filtered: ${JSON.stringify(fns)}`);
  assert.ok(!fns.includes('stop'), `stop should be filtered: ${JSON.stringify(fns)}`);
  assert.ok(fns.includes('calc'), `calc should NOT be filtered: ${JSON.stringify(fns)}`);
  rmSync(d, { recursive: true, force: true });
});

test('testsMentioning: finds the test file that mentions calc', () => {
  const { d } = localRepo();
  const tests = testsMentioning(d, ['calc']);
  assert.deepEqual(tests, ['test/calc.test.mjs']);
  rmSync(d, { recursive: true, force: true });
});

test('scanRepo: end-to-end — flags the planted hollow test on the changed fn, restores HEAD', () => {
  const { d, fixSha } = localRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'arch-out-'));
  const outFile = join(outDir, 'archaeology.jsonl');
  const origHead = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  scanRepo(d, 'local/repo', outFile);

  const rows = readJsonl(outFile);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'probed');
  assert.equal(row.fix_sha, fixSha);
  assert.equal(row.prebug_expr, `${fixSha}^`);
  assert.ok(row.changed_fns.includes('calc'));
  assert.deepEqual(row.matched_test_files, ['test/calc.test.mjs']);
  assert.equal(row.hollow_hits.length, 1);
  assert.match(row.hollow_hits[0].name, /hollow/);
  assert.ok(row.hollow_hits[0].survivors.includes('calc'));

  // restored to its original HEAD — idempotent for a future re-drive
  const headAfter = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(headAfter, origHead);

  rmSync(d, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true });
});

test('scanRepo: a fix commit with no parent (checkout of <sha>^ fails) appends a checkout-failed row, never a drop', () => {
  const d = mkdtempSync(join(tmpdir(), 'arch-nofail-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  writeFileSync(join(d, 'README.md'), 'x');
  execFileSync('git', ['-C', d, 'init', '-q']); g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Revert "root regression"']);
  const rootSha = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const outDir = mkdtempSync(join(tmpdir(), 'arch-out2-'));
  const outFile = join(outDir, 'archaeology.jsonl');
  scanRepo(d, 'local/nofail', outFile);

  const rows = readJsonl(outFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'checkout-failed');
  assert.equal(rows[0].fix_sha, rootSha);
  assert.ok(rows[0].error && rows[0].error.length > 0);

  rmSync(d, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true });
});

test('scanRepo: an npm install failure after prebug checkout appends install-failed, never probes the wrong tree', () => {
  const d = mkdtempSync(join(tmpdir(), 'arch-instfail-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  writeFileSync(join(d, 'package.json'), '{ this is not valid json');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/calc.mjs'), 'export function calc(a, b) { return a + b; }\n');
  writeFileSync(join(d, 'test/calc.test.mjs'), "import { test } from 'node:test';\ntest('placeholder', () => {});\n");
  execFileSync('git', ['-C', d, 'init', '-q']); g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);

  writeFileSync(join(d, 'src/calc.mjs'), 'export function calc(a, b) { return a - b; }\n');
  g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'break calc']);

  writeFileSync(join(d, 'src/calc.mjs'), 'export function calc(a, b) { return a + b; }\n');
  g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Revert "break calc"']);
  const fixSha = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const outDir = mkdtempSync(join(tmpdir(), 'arch-out5-'));
  const outFile = join(outDir, 'archaeology.jsonl');
  scanRepo(d, 'local/instfail', outFile);

  const rows = readJsonl(outFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'install-failed');
  assert.equal(rows[0].fix_sha, fixSha);
  // --loglevel=error allows npm to emit real error text on failure (verified: EJSONPARSE now exits
  // 1 with stderr populated) — the row carries the `error` field with actual diagnostic content.
  assert.equal(typeof rows[0].error, 'string');
  assert.ok(rows[0].error && rows[0].error.length > 0, 'error field should contain diagnostics from npm install failure');
  assert.ok(!existsSync(join(d, 'node_modules'))); // install genuinely failed, no half-installed tree

  rmSync(d, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true });
});

test('scanRepo: more than 3 candidates in one repo caps at 3 and logs a cap-reached row with the drop count', () => {
  const d = mkdtempSync(join(tmpdir(), 'arch-cap-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  execFileSync('git', ['-C', d, 'init', '-q']);
  writeFileSync(join(d, 'README.md'), '0'); g('add', '-A');
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(d, 'README.md'), String(i + 1)); g('add', '-A');
    execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `regression fix ${i}`]);
  }
  const outDir = mkdtempSync(join(tmpdir(), 'arch-out3-'));
  const outFile = join(outDir, 'archaeology.jsonl');
  scanRepo(d, 'local/cap', outFile);

  const rows = readJsonl(outFile);
  const capRow = rows.find((r) => r.status === 'cap-reached');
  assert.ok(capRow, JSON.stringify(rows));
  assert.equal(capRow.dropped, 2); // 5 candidates - cap of 3
  const candidateRows = rows.filter((r) => r.status !== 'cap-reached');
  assert.equal(candidateRows.length, 3);

  rmSync(d, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true });
});

test('clearStaleLock: removes an index.lock older than 5 minutes, leaves a fresh one alone', () => {
  const d = mkdtempSync(join(tmpdir(), 'arch-lock-'));
  mkdirSync(join(d, '.git'));
  const lock = join(d, '.git', 'index.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 6 * 60 * 1000);
  utimesSync(lock, old, old);
  clearStaleLock(d);
  assert.ok(!existsSync(lock));

  writeFileSync(lock, '');
  clearStaleLock(d);
  assert.ok(existsSync(lock)); // fresh lock left alone

  rmSync(d, { recursive: true, force: true });
});

test('scanRepo: a stale index.lock from a prior SIGKILLd op is cleared before checkout, not fatal', () => {
  const { d, fixSha } = localRepo();
  const lock = join(d, '.git', 'index.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 6 * 60 * 1000);
  utimesSync(lock, old, old);

  const outDir = mkdtempSync(join(tmpdir(), 'arch-out4-'));
  const outFile = join(outDir, 'archaeology.jsonl');
  scanRepo(d, 'local/stalelock', outFile);

  const rows = readJsonl(outFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'probed');
  assert.equal(rows[0].fix_sha, fixSha);

  rmSync(d, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true });
});
