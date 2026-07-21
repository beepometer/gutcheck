// Field report 2026-07-18 (false-positive hollow, AcoustiQ): a gradle mutant run that shows a survivor
// (passed>0, failed=0) is only valid evidence if the mutant was actually IN the build. The established
// root cause is a gradle daemon file-watching (VFS) race: the probe's out-of-band mutant write can be
// missed by the daemon's virtual filesystem, so the main-source compile task goes UP-TO-DATE despite
// changed source, the test reruns against STALE (unmutated) classes, and the resulting fresh-green XML
// is misread as a survivor -> false hollow. This file covers the CI-safe (no live gradle) layers of the
// fix: the pure console-output classifier (mainCompileExecuted), the extracted veto DECISION
// (survivorEvidenceValid — the actual thing wired into prove()'s gut loop and opposite-sentinel loop, so
// a regression here fails a fast unit test instead of silently needing a live gradle run to notice), and
// the argv change that kills the race at its source (-Dorg.gradle.vfs.watch=false). The remaining
// fold-level behavior (does prove() itself route a veto to 'ungutable', does the memo correctly let a
// within-one-run repeat gut through) is covered live in test/jvm-e2e.test.mjs, since prove() has no stub
// seam for gradle run results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainCompileExecuted, survivorEvidenceValid, testCmdFor } from '../mutation/prove.mjs';

// ---- mainCompileExecuted -------------------------------------------------------------------------
// Real gradle --console=plain shapes (captured live off test/fixtures/jvm-project, both AGP-style
// module-prefixed and plain-JVM-plugin task names): an EXECUTED task prints a BARE `> Task :taskName`
// line with nothing after it; a task gradle satisfied from prior state prints a LABELED line
// (`UP-TO-DATE` / `FROM-CACHE` / `NO-SOURCE` / `SKIPPED`). A mutant edit changes MAIN source, so a valid
// mutant run can never leave EVERY main-source compile task labeled — that combination is the signature
// of the vfs-watch race (or any other stale-reuse mechanism): the green result is void.

test('mainCompileExecuted: (a) all main-compile UP-TO-DATE + the test task ran -> false', () => {
  const out = [
    '> Task :app:cleanTest',
    '> Task :app:compileDebugKotlin UP-TO-DATE',
    '> Task :app:compileDebugJavaWithJavac UP-TO-DATE',
    '> Task :app:compileDebugUnitTestKotlin UP-TO-DATE',
    '> Task :app:testDebugUnitTest',
    '',
    'BUILD SUCCESSFUL in 2s',
  ].join('\n');
  assert.equal(mainCompileExecuted(out), false, 'every main compile task is labeled -> no fresh evidence');
});

test('mainCompileExecuted: (b) a bare main-compile line is present -> true', () => {
  const out = [
    '> Task :app:cleanTest',
    '> Task :app:compileDebugKotlin',
    '> Task :app:compileDebugUnitTestKotlin UP-TO-DATE',
    '> Task :app:testDebugUnitTest',
    '',
    'BUILD SUCCESSFUL in 4s',
  ].join('\n');
  assert.equal(mainCompileExecuted(out), true, 'a bare compile line proves the compiler ran just now');
});

test('mainCompileExecuted: (c) multi-module — mutated module bare, unmutated sibling UP-TO-DATE -> true', () => {
  const out = [
    '> Task :core:compileKotlin UP-TO-DATE',
    '> Task :app:compileDebugKotlin',
    '> Task :app:testDebugUnitTest',
    '',
    'BUILD SUCCESSFUL in 3s',
  ].join('\n');
  assert.equal(mainCompileExecuted(out), true, 'the mutated module executing is enough; an unmutated sibling staying UP-TO-DATE is correct and must not veto');
});

test('mainCompileExecuted: (d) only the TEST-source compile task ran bare, main compile stayed UP-TO-DATE -> false', () => {
  const out = [
    '> Task :app:compileDebugKotlin UP-TO-DATE',
    '> Task :app:compileDebugUnitTestKotlin',
    '> Task :app:testDebugUnitTest',
    '',
    'BUILD SUCCESSFUL in 2s',
  ].join('\n');
  assert.equal(mainCompileExecuted(out), false, 'a test-source compile task executing proves nothing about the MAIN mutant');
});

test('mainCompileExecuted: (e) FROM-CACHE labeled main compile only -> false', () => {
  const out = [
    '> Task :app:compileDebugKotlin FROM-CACHE',
    '> Task :app:testDebugUnitTest',
    '',
    'BUILD SUCCESSFUL in 1s',
  ].join('\n');
  assert.equal(mainCompileExecuted(out), false, 'FROM-CACHE is a labeled (reused) outcome, never bare evidence of a fresh compile');
});

test('mainCompileExecuted: plain-JVM-plugin naming (compileKotlin/compileTestKotlin, no AGP) — same contract', () => {
  const stale = ['> Task :compileKotlin UP-TO-DATE', '> Task :compileTestKotlin UP-TO-DATE', '> Task :test', ''].join('\n');
  assert.equal(mainCompileExecuted(stale), false, 'plain-JVM main compile UP-TO-DATE must still veto (task naming has no AGP variant qualifier)');
  const fresh = ['> Task :compileKotlin', '> Task :compileTestKotlin UP-TO-DATE', '> Task :test', ''].join('\n');
  assert.equal(mainCompileExecuted(fresh), true);
});

test('mainCompileExecuted: no compile task lines at all -> false', () => {
  assert.equal(mainCompileExecuted('some unrelated crash output before any task ran\n'), false);
});

// ---- task-name-scoped exclusion (reviewer-found regression): the test-source exclusion must key off
// the TASK-NAME segment (after the last `:`), never a blanket substring over the whole module path — a
// module literally named `integration-test`/`apptest`/`test` is a real Gradle shape, and its OWN main
// compile task must never be excluded just because "test" appears in the MODULE name. ------------------
test('mainCompileExecuted: module path containing "test" must not exclude its own bare main compile task', () => {
  assert.equal(mainCompileExecuted('> Task :integration-test:compileKotlin\n> Task :integration-test:test\n'), true,
    ':integration-test:compileKotlin is a MAIN compile task; "test" in the MODULE segment must never exclude it');
  assert.equal(mainCompileExecuted('> Task :apptest:compileKotlin\n> Task :apptest:test\n'), true);
  assert.equal(mainCompileExecuted('> Task :test:compileKotlin\n> Task :test:test\n'), true);
});

test('mainCompileExecuted: AGP test-source compile task (compileDebugUnitTestKotlin) bare, main compile UP-TO-DATE -> false', () => {
  const out = [
    '> Task :app:compileDebugKotlin UP-TO-DATE',
    '> Task :app:compileDebugUnitTestKotlin',
    '> Task :app:testDebugUnitTest',
    '',
  ].join('\n');
  assert.equal(mainCompileExecuted(out), false, 'the bare line belongs to the TEST-source compile task; the MAIN compile task stayed UP-TO-DATE');
});

// ---- survivorEvidenceValid: the extracted veto DECISION, unit-testable without a live gradle spawn ---
// (mirrors mainCompileExecuted/mavenCompiled's own pure-function style). This is the exact function
// wired into both prove() call sites — a regression here (e.g. deleting the veto) now fails HERE, not
// only on a live-gradle run that happens to hit the right shape.
test('survivorEvidenceValid: stale-shaped survivor (all main-compile UP-TO-DATE), content never validated by this run -> invalid', () => {
  const r = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin UP-TO-DATE\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(r, 'src/main/kotlin/Foo.kt', 'mutant-a', new Map()), false);
});

test('survivorEvidenceValid: bare (fresh) compile line -> valid, and records the content as this file\'s last-verified compile', () => {
  const r = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin\n> Task :app:testDebugUnitTest\n' };
  const lastCompiled = new Map();
  assert.equal(survivorEvidenceValid(r, 'src/main/kotlin/Foo.kt', 'mutant-a', lastCompiled), true);
  assert.equal(lastCompiled.get('src/main/kotlin/Foo.kt'), 'mutant-a', 'the fresh compile must be recorded for later same-content reuse');
});

test('survivorEvidenceValid: stale-shaped survivor whose content matches this run\'s last verified compile for that file -> valid (safe within-run reuse)', () => {
  const lastCompiled = new Map();
  const bare = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(bare, 'src/main/kotlin/Foo.kt', 'mutant-a', lastCompiled), true);
  const stale = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin UP-TO-DATE\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(stale, 'src/main/kotlin/Foo.kt', 'mutant-a', lastCompiled), true,
    'a second gut of the SAME fn with the SAME sentinel (e.g. two test blocks covering it) reuses known-good content — never gated');
});

test('survivorEvidenceValid: stale-shaped survivor whose content does NOT match the last verified compile -> invalid (interleaving stays fail-closed)', () => {
  const lastCompiled = new Map();
  const bareA = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin\n> Task :app:testDebugUnitTest\n' };
  survivorEvidenceValid(bareA, 'src/main/kotlin/Foo.kt', 'mutant-a', lastCompiled);
  const staleB = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin UP-TO-DATE\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(staleB, 'src/main/kotlin/Foo.kt', 'mutant-b', lastCompiled), false,
    'UP-TO-DATE relative to a DIFFERENT (older) content this run built earlier must still fail closed, never ride on the wrong match');
});

test('survivorEvidenceValid: a RED result is always valid, regardless of shape or memo state', () => {
  const red = { passed: 0, failed: 1, out: '> Task :app:compileDebugKotlin UP-TO-DATE\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(red, 'src/main/kotlin/Foo.kt', 'mutant-a', new Map()), true,
    'a stale build can only reuse already-passing original code — it can never fake a false red');
});

// Regression pin (caught live, jvm-e2e's relational-one-sided-tier suite, during development of this
// follow-up): recording a fresh compile into lastCompiled must happen on ANY genuinely fresh compile,
// including a RED (caught) one, NOT only on the green/survivor path — a fn tested by TWO blocks (e.g.
// testScoreBound catching `score` red first, testScoreOneSided gutting the SAME `score`+sentinel later
// and surviving) needs the FIRST (red) block's fresh compile recorded so the SECOND (green, now
// correctly UP-TO-DATE) block can recognize the safe reuse instead of being wrongly gated.
test('survivorEvidenceValid: a RED result with a genuinely fresh compile records the content, so a LATER green stale-shaped reuse of the SAME content is trusted', () => {
  const lastCompiled = new Map();
  const redFresh = { passed: 0, failed: 1, out: '> Task :app:compileDebugKotlin\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(redFresh, 'src/main/kotlin/Score.kt', 'score-sentinel', lastCompiled), true);
  assert.equal(lastCompiled.get('src/main/kotlin/Score.kt'), 'score-sentinel', 'the red block\'s fresh compile must still be recorded');
  const greenStale = { passed: 1, failed: 0, out: '> Task :app:compileDebugKotlin UP-TO-DATE\n> Task :app:testDebugUnitTest\n' };
  assert.equal(survivorEvidenceValid(greenStale, 'src/main/kotlin/Score.kt', 'score-sentinel', lastCompiled), true,
    'a later block gutting the SAME fn with the SAME sentinel and surviving must reuse the red block\'s validation, not be gated');
});

test('survivorEvidenceValid: a non-run (0 passed, 0 failed) is not this function\'s concern -> valid', () => {
  const nonRun = { passed: 0, failed: 0, out: '' };
  assert.equal(survivorEvidenceValid(nonRun, 'src/main/kotlin/Foo.kt', 'mutant-a', new Map()), true);
});

// ---- argv: kill the race source ------------------------------------------------------------------
// System-property form deliberately, not `--no-watch-fs`: an unknown -D property is silently ignored by
// old Gradle versions, while `--no-watch-fs` is a hard CLI parse error on Gradle < 6.7.
test('testCmdFor gradle: argv includes -Dorg.gradle.vfs.watch=false (field report 2026-07-18)', () => {
  const gi = { taskPath: ':app:testDebugUnitTest', cleanPath: ':app:cleanTestDebugUnitTest', resultsDir: 'app/build/test-results/testDebugUnitTest' };
  const { args } = testCmdFor('gradle', 'app/src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testAdd', '/proj', false, gi);
  assert.ok(args.includes('-Dorg.gradle.vfs.watch=false'), `expected -Dorg.gradle.vfs.watch=false in gradle argv: ${JSON.stringify(args)}`);
  // still every existing flag, unchanged (regression guard against accidentally replacing rather than extending)
  assert.ok(args.includes('--offline') && args.includes('--console=plain'));
  // NOT --build-cache: its location-independent, content-addressable reuse defeats mainCompileExecuted
  // across SEPARATE probe invocations (see testCmdFor's own header comment and prove.test.mjs's argv
  // test) — a live 2-invocation repro on this exact suite (test/jvm-e2e.test.mjs's "agent gate e2e" test)
  // demonstrated a repeat probe on an unchanged diff reading real survivors back as 'ungutable'.
  assert.ok(!args.includes('--build-cache'), `--build-cache must stay OUT of the gradle argv: ${JSON.stringify(args)}`);
});
