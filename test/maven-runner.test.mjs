// Maven runner support (mirrors gradle's — see mutation/prove.mjs's testCmdFor/runOne 'maven' branches
// and mavenBin/mavenCompiled). CI has NO maven binary at all, so every test here is CI-safe by
// construction: detectRunner/testCmdFor/mavenBin resolution are exercised with fabricated fake
// executables (shell scripts that just `exit 0`) rather than a real mvn install, and the compile-fail-
// vs-test-fail classification is exercised against REAL captured maven output text (see
// test/fixtures/runner-output/maven-{compile,test}-fail.txt) rather than a live spawn. The opt-in e2e
// (build+probe a real fixture through a real mvn) lives in test/jvm-e2e.test.mjs, gated on GUTCHECK_MVN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, delimiter, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { detectRunner, testCmdFor, mavenBin, mavenModuleDir, mavenCompiled, RUNNERS, javaExe } from '../mutation/prove.mjs';

const UNIX_ONLY = { skip: process.platform === 'win32' ? 'fabricated shell-script fake executables are unix-only' : false };
const FIX = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/runner-output', n), 'utf8');

function fakeExe(dir, name) {
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}

// ---- detectRunner: pom.xml -> maven; gradle marker wins when both are present ----
test('detectRunner: pom.xml only -> maven', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-detect-'));
  writeFileSync(join(d, 'pom.xml'), '<project></project>');
  try { assert.equal(detectRunner(d), 'maven'); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('detectRunner: pom.xml + settings.gradle.kts -> gradle (gradle wins over maven)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-detect-'));
  writeFileSync(join(d, 'pom.xml'), '<project></project>');
  writeFileSync(join(d, 'settings.gradle.kts'), 'rootProject.name="x"');
  try { assert.equal(detectRunner(d), 'gradle'); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('RUNNERS includes maven', () => { assert.ok(RUNNERS.includes('maven')); });

// ---- testCmdFor maven: -Dtest FQN conversion (last '.' -> '#'), fixed flags, no shell ----
test('testCmdFor maven: last-dot-to-# conversion, incl a multi-segment dotted package', UNIX_ONLY, () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-cmd-'));
  const fake = fakeExe(d, 'fake-mvn');
  const prevMvn = process.env.GUTCHECK_MVN;
  process.env.GUTCHECK_MVN = fake;
  try {
    const { cmd, args } = testCmdFor('maven', 'src/test/java/demo/CalcTest.java', 'demo.CalcTest.testAdd', d);
    assert.equal(cmd, fake);
    assert.ok(args.includes('-Dtest=demo.CalcTest#testAdd'), `args: ${JSON.stringify(args)}`);
    assert.ok(args.includes('-o') && args.includes('test'));
    assert.ok(args.includes('-Dsurefire.failIfNoSpecifiedTests=false'));

    const packaged = testCmdFor('maven', 'x', 'com.foo.bar.BazTest.qux', d);
    assert.ok(packaged.args.includes('-Dtest=com.foo.bar.BazTest#qux'), `args: ${JSON.stringify(packaged.args)}`);
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    rmSync(d, { recursive: true, force: true });
  }
});
test('testCmdFor maven: a name with no dot is passed through unchanged (never crashes)', UNIX_ONLY, () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-cmd-'));
  const fake = fakeExe(d, 'fake-mvn');
  const prevMvn = process.env.GUTCHECK_MVN;
  process.env.GUTCHECK_MVN = fake;
  try {
    const { args } = testCmdFor('maven', 'x', 'bareTitle', d);
    assert.ok(args.includes('-Dtest=bareTitle'), `args: ${JSON.stringify(args)}`);
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    rmSync(d, { recursive: true, force: true });
  }
});
test('testCmdFor maven: no mvn resolvable anywhere -> deliberately-failing sentinel, never a crash/throw', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-cmd-'));
  const prevMvn = process.env.GUTCHECK_MVN; const prevPath = process.env.PATH;
  delete process.env.GUTCHECK_MVN;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'gc-maven-emptypath-')); // guaranteed no mvn on this PATH
  try {
    const { cmd, args } = testCmdFor('maven', 'x', 'demo.T.testX', d);
    assert.equal(cmd, process.execPath, 'falls back to the crash-proof sentinel, not a bare "mvn" that could ENOENT unpredictably');
    assert.deepEqual(args, ['-e', 'process.exit(1)']);
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    process.env.PATH = prevPath;
    rmSync(d, { recursive: true, force: true });
  }
});

// ---- mavenBin resolution precedence: GUTCHECK_MVN > PATH mvn > wrapper jar > null ----
test('mavenBin: GUTCHECK_MVN wins over a resolvable PATH mvn', UNIX_ONLY, () => {
  const pathDir = mkdtempSync(join(tmpdir(), 'gc-maven-path-'));
  const overrideDir = mkdtempSync(join(tmpdir(), 'gc-maven-override-'));
  const pathMvn = fakeExe(pathDir, 'mvn');
  const overrideMvn = fakeExe(overrideDir, 'my-mvn');
  const prevMvn = process.env.GUTCHECK_MVN; const prevPath = process.env.PATH;
  process.env.GUTCHECK_MVN = overrideMvn;
  process.env.PATH = pathDir + delimiter + process.env.PATH;
  try {
    const mb = mavenBin(mkdtempSync(join(tmpdir(), 'gc-maven-proj-')));
    assert.equal(mb.cmd, overrideMvn, 'GUTCHECK_MVN must win even when a PATH mvn also resolves');
    assert.notEqual(mb.cmd, pathMvn);
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    process.env.PATH = prevPath;
    rmSync(pathDir, { recursive: true, force: true }); rmSync(overrideDir, { recursive: true, force: true });
  }
});
test('mavenBin: falls back to a resolvable PATH mvn when GUTCHECK_MVN is unset', UNIX_ONLY, () => {
  const pathDir = mkdtempSync(join(tmpdir(), 'gc-maven-path-'));
  fakeExe(pathDir, 'mvn');
  const prevMvn = process.env.GUTCHECK_MVN; const prevPath = process.env.PATH;
  delete process.env.GUTCHECK_MVN;
  process.env.PATH = pathDir + delimiter + process.env.PATH;
  try {
    const mb = mavenBin(mkdtempSync(join(tmpdir(), 'gc-maven-proj-')));
    assert.equal(mb.cmd, 'mvn');
    assert.deepEqual(mb.pre, []);
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    process.env.PATH = prevPath;
    rmSync(pathDir, { recursive: true, force: true });
  }
});
test('mavenBin: falls back to the project .mvn wrapper jar when neither override nor PATH mvn resolve (needs a real java)', { skip: !javaExe() ? 'no java resolvable in this environment' : false }, () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-wrapper-'));
  mkdirSync(join(d, '.mvn', 'wrapper'), { recursive: true });
  const wrapper = join(d, '.mvn', 'wrapper', 'maven-wrapper.jar');
  writeFileSync(wrapper, 'not a real jar — only existsSync is checked by mavenBin');
  const prevMvn = process.env.GUTCHECK_MVN; const prevPath = process.env.PATH;
  delete process.env.GUTCHECK_MVN;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'gc-maven-emptypath-'));
  try {
    const mb = mavenBin(d);
    assert.ok(mb, 'wrapper jar should resolve');
    assert.equal(mb.cmd, javaExe());
    assert.ok(mb.pre.includes('-cp') && mb.pre.includes(wrapper) && mb.pre.includes('org.apache.maven.wrapper.MavenWrapperMain'));
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    process.env.PATH = prevPath;
    rmSync(d, { recursive: true, force: true });
  }
});
test('mavenBin: null when nothing resolves at all (no override, no PATH mvn, no wrapper jar)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-none-'));
  const prevMvn = process.env.GUTCHECK_MVN; const prevPath = process.env.PATH;
  delete process.env.GUTCHECK_MVN;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'gc-maven-emptypath-'));
  try {
    assert.equal(mavenBin(d), null);
  } finally {
    if (prevMvn === undefined) delete process.env.GUTCHECK_MVN; else process.env.GUTCHECK_MVN = prevMvn;
    process.env.PATH = prevPath;
    rmSync(d, { recursive: true, force: true });
  }
});

// ---- mavenCompiled: the false-verdict-critical guard — a compile-fail and a test-FAILURE both print
// "BUILD FAILURE", so COMPILATION ERROR is the only safe discriminator between them. Driven off REAL
// captured maven output (see test/fixtures/runner-output/README.md for provenance), never invented text. ----
test('mavenCompiled: a genuine compile-fail sample (type error, no surefire XML) -> compiled:false', () => {
  const out = FIX('maven-compile-fail.txt');
  assert.match(out, /COMPILATION ERROR/);
  assert.equal(mavenCompiled(out), false);
});
test('mavenCompiled: a genuine test-FAILURE sample (BUILD FAILURE, Tests run/Failures, no COMPILATION ERROR) -> compiled:true', () => {
  const out = FIX('maven-test-fail.txt');
  assert.match(out, /BUILD FAILURE/);
  assert.match(out, /Tests run: 1, Failures: 1/);
  assert.doesNotMatch(out, /COMPILATION ERROR/, 'the key guard: a test failure must never contain the compile-fail string');
  assert.equal(mavenCompiled(out), true, 'a real test failure must never be misread as a compile failure');
});

// ---- mavenModuleDir: multi-module reactor resolution — mirrors gradleTaskInfo's module inference, but
// walks real pom.xml files on disk instead of a /src/ path convention. All fixtures below are plain
// mkdtempSync'd real directories (no shell-script fakeExe), so these run for real cross-platform,
// including on the windows CI leg's real win32 filesystem — the closest thing to a genuine win32 boundary
// check available without a Windows sandbox. ----
function mkTree(...names) {
  const root = mkdtempSync(join(tmpdir(), 'gc-maven-mod-'));
  for (const n of names) { const p = join(root, n); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); }
  return root;
}

test('mavenModuleDir: single-module — test file directly under root, root pom.xml -> root', () => {
  const root = mkTree('pom.xml');
  try {
    assert.equal(mavenModuleDir(root, 'src/test/java/demo/CalcTest.java'), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mavenModuleDir: reactor — module at depth 1 wins over the root aggregator pom (the brief\'s own example)', () => {
  const root = mkTree('pom.xml', 'core/pom.xml');
  try {
    assert.equal(mavenModuleDir(root, 'core/src/test/java/demo/CalcTest.java'), join(root, 'core'));
    assert.equal(mavenModuleDir(root, 'src/test/java/demo/CalcTest.java'), root, 'a file with no nested pom in its own ancestry still falls through to root');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mavenModuleDir: nested module pom at depth 2 — nearest ancestor wins, not a shallower intermediate pom', () => {
  const root = mkTree('pom.xml', 'core/pom.xml', 'core/sub/pom.xml');
  try {
    assert.equal(
      mavenModuleDir(root, 'core/sub/src/test/java/demo/CalcTest.java'),
      join(root, 'core', 'sub'),
      'must resolve to the deepest/nearest ancestor pom, not the shallower core/ aggregator',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mavenModuleDir: no pom.xml anywhere at or below root -> falls back to root, and a decoy pom.xml ABOVE root is never read', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gc-maven-mod-parent-'));
  writeFileSync(join(parent, 'pom.xml'), ''); // decoy — sits ABOVE the repo root; must never be picked up
  const root = mkdtempSync(join(parent, 'root-'));
  mkdirSync(join(root, 'src', 'test', 'java', 'demo'), { recursive: true });
  try {
    assert.equal(mavenModuleDir(root, 'src/test/java/demo/CalcTest.java'), root, 'never walks above the repo root, even to a real pom.xml');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('mavenModuleDir: a trailing separator on dir (single-module) still resolves to the same root directory', () => {
  const root = mkTree('pom.xml');
  try {
    const got = mavenModuleDir(root + sep, 'src/test/java/demo/CalcTest.java');
    assert.equal(resolve(got), resolve(root), 'the d.length >= dir.length guard exits one step early here (root\'s own pom.xml is skipped), but the `return dir` fallback IS the same directory — behavior-neutral, not a bug');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mavenModuleDir: a trailing separator on dir does not break nested-module resolution (the module dir is always longer than dir, so the guard never affects it)', () => {
  const root = mkTree('pom.xml', 'core/pom.xml');
  try {
    const got = mavenModuleDir(root + sep, 'core/src/test/java/demo/CalcTest.java');
    assert.equal(resolve(got), resolve(join(root, 'core')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
