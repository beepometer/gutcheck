import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { runOne, javaExe, prove, gradleTaskInfo, mainCompileExecuted } from '../mutation/prove.mjs';
import { grossBreak } from '../mutation/probe.mjs';

const GUT = resolve('mutation/gutcheck.mjs');
const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'check-changed-tests');

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/jvm-project');
const haveJava = !!javaExe();
// The Gradle e2es need a WARM ~/.gradle cache: the probe runs Gradle with `--offline`, so a cold cache
// can't resolve the Kotlin plugin / JUnit runtime and the baseline fails. Locally that cache is warm from
// ordinary dev use (and process.env.CI is unset). On CI, GitHub runners DO ship a pre-installed JDK — so
// javaExe() resolves everywhere — but only the dedicated `jvm` job warms the cache and sets
// GUTCHECK_GRADLE_E2E; the other CI legs (test/*, windows) must SKIP rather than fail on a cold offline cache.
const runGradle = haveJava && (process.env.GUTCHECK_GRADLE_E2E || !process.env.CI);
const opts = runGradle ? {} : { skip: 'gradle e2e needs a warm ~/.gradle cache (CI: the jvm job sets GUTCHECK_GRADLE_E2E; else run locally)' };
// The Stop hook itself is bash — unix-only, same restriction test/agent-hook.test.mjs applies (win32 is
// out of scope for this surface regardless of the gradle cache).
const hookOpts = !runGradle ? opts : (process.platform === 'win32' ? { skip: 'hooks are unix-only (bash)' } : {});

function workCopy() {
  const w = mkdtempSync(join(tmpdir(), 'gc-jvm-e2e-'));
  cpSync(FIX, w, { recursive: true, filter: (s) => !/([\\/])(\.gradle|build)([\\/]|$)/.test(s) });
  return w;
}

test('gradle e2e: baseline testAdd is green', opts, () => {
  const w = workCopy();
  try {
    const r = runOne(w, 'gradle', 'src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testAdd', 180000);
    assert.equal(r.compiled, true);
    assert.ok(r.passed >= 1 && r.failed === 0, `baseline: ${JSON.stringify(r)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('gradle e2e: type-compatible mutant fails the test (CAUGHT signal)', opts, () => {
  const w = workCopy();
  try {
    const f = join(w, 'src/main/kotlin/Calc.kt');
    writeFileSync(f, readFileSync(f, 'utf8').replace('fun add(a: Int, b: Int): Int = a + b', 'fun add(a: Int, b: Int): Int = 987654321'));
    const r = runOne(w, 'gradle', 'src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testAdd', 180000);
    assert.equal(r.compiled, true);
    assert.ok(r.failed >= 1, `mutant should fail: ${JSON.stringify(r)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('gradle e2e: compile-failing mutant → compiled=false, no fresh XML (ungutable)', opts, () => {
  const w = workCopy();
  try {
    const f = join(w, 'src/main/kotlin/Calc.kt');
    writeFileSync(f, readFileSync(f, 'utf8').replace('return "Hello, " + name', 'return 987654321'));
    const r = runOne(w, 'gradle', 'src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testGreet', 180000);
    assert.equal(r.compiled, false);
    assert.equal(r.passed, 0); assert.equal(r.failed, 0);   // no fresh XML → never CAUGHT
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// Stale-build gate (field report 2026-07-18, the false-positive HOLLOW on AcoustiQ): the established
// root cause is a gradle daemon vfs-watch race — the probe's out-of-band mutant write can be missed by
// the daemon's file-system watcher, so the main-source compile task goes UP-TO-DATE despite changed
// source, the test reruns against STALE (unmutated) classes, and the resulting fresh-green XML is
// misread as a survivor. That race is environmental/daemon-state-dependent and can't be forced on
// demand — but it has one deterministic, non-racy stand-in with the IDENTICAL observable console shape:
// running the exact same mutant content twice in a row against the SAME work directory. The first run
// genuinely executes (bare compile line); Gradle's own incremental build then correctly — not racily —
// reports every main-source compile task UP-TO-DATE on the second run of that unchanged content, while
// `cleanTest` still forces `test` to re-execute and reproduce the same green result. mainCompileExecuted
// can't tell "correctly reused" apart from "raced" (that's the whole point of failing closed on the
// shape) — this proves the HELPER classifies real gradle output correctly, at the runOne level.
//
// This does NOT drive the scenario through prove()'s own gutOneFn/foldBlock: prove() copies its target
// into a FRESH internal work directory on every call (a different absolute path each time), and with
// --build-cache deliberately removed (see testCmdFor's own header comment — it made the race's failure
// mode WORSE by reusing output across separate directories), there is no remaining deterministic way to
// make prove()'s own internal, never-before-seen work copy read back a stale-shaped result on demand —
// only the actual (non-reproducible) race can do that now. That absence is exactly the point: it also
// means ordinary repeat probing (rerun gutcheck on an unchanged diff, a function covered by two test
// methods) can no longer manufacture a false stale reading either — see test/prove.test.mjs's argv test
// and the "prove() gradle e2e: fixture verdicts" / "relational one-sided tier" tests below, which cover
// the companion lastCompiled per-file memo (a function legitimately gutted twice in ONE run, e.g.
// Meter.reading via both testMeterReading and testMeterEcho, or Score.score via testScoreBound and
// testScoreOneSided, must still verdict correctly — those tests regressed without the memo during
// development of this fix, so they stand as this fix's fold-level regression coverage). The wiring is
// the pure `survivorEvidenceValid(r, sutRel, content, lastCompiled)` helper (unit-tested in
// test/stale-build.test.mjs) applied one line below the existing (already fold-tested)
// `r.compiled===false` veto.
test('gradle e2e: mainCompileExecuted correctly reads a genuinely reused (stale-shaped) gradle result as unproven, on real console output', opts, () => {
  const w = workCopy();
  try {
    const marker = `stale_gate_probe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(w, 'src/main/kotlin/StaleGate.kt'), [
      'package demo', `// ${marker} — guarantees this exact file content was never built before`, '',
      'fun staleGateFn(n: Int): Int = n', '',
    ].join('\n'));
    writeFileSync(join(w, 'src/test/kotlin/StaleGateTest.kt'), [
      'package demo', '',
      'import org.junit.jupiter.api.Test',
      'import org.junit.jupiter.api.Assertions.assertEquals', '',
      'class StaleGateTest {',
      '    // Echo-oracle by construction (pins staleGateFn against ITSELF, never a fixed expected value):',
      '    // any mutant survives this — a real hollow-shaped candidate for the reused-build leg below.',
      '    @Test fun testStaleGateEcho() {',
      '        val e = staleGateFn(11)',
      '        assertEquals(e, staleGateFn(11))',
      '    }',
      '}', '',
    ].join('\n'));

    const sutFile = join(w, 'src/main/kotlin/StaleGate.kt');
    const sutOrig = readFileSync(sutFile, 'utf8');
    const broken = grossBreak(sutOrig, 'staleGateFn', 'kotlin');
    assert.ok(broken && broken !== sutOrig, 'grossBreak must locate and mutate staleGateFn');
    writeFileSync(sutFile, broken);

    // FIRST run: a genuinely fresh compile of NOVEL content (the marker guarantees this exact byte
    // content was never built before, on any machine) — real bare-line evidence, real survivor.
    const first = runOne(w, 'gradle', 'src/test/kotlin/StaleGateTest.kt', 'demo.StaleGateTest.testStaleGateEcho', 180000);
    assert.equal(first.compiled, true, `first run should compile:\n${first.out.slice(-3000)}`);
    assert.ok(first.passed > 0 && first.failed === 0, `first run's mutant must genuinely survive (echo-oracle): ${JSON.stringify({ passed: first.passed, failed: first.failed })}`);
    assert.ok(mainCompileExecuted(first.out), `first run must show a bare (executed) main-compile line:\n${first.out.slice(-3000)}`);

    // SECOND run, SAME work directory, file left untouched since the first run: Gradle's own incremental
    // build correctly recognizes nothing changed and reports every main-source compile task UP-TO-DATE —
    // the exact console shape the race produces, reached here without any race at all. `cleanTest` still
    // forces the test task to re-execute, faithfully reproducing the same (genuinely correct) green.
    const second = runOne(w, 'gradle', 'src/test/kotlin/StaleGateTest.kt', 'demo.StaleGateTest.testStaleGateEcho', 180000);
    assert.equal(second.compiled, true, `second run should still compile:\n${second.out.slice(-3000)}`);
    assert.ok(second.passed > 0 && second.failed === 0, `second run reuses the exact same mutant — still a survivor: ${JSON.stringify({ passed: second.passed, failed: second.failed })}`);
    assert.equal(mainCompileExecuted(second.out), false, `second run must show no bare main-compile line (reused, not recompiled):\n${second.out.slice(-3000)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('prove() gradle e2e: fixture verdicts', opts, () => {
  const w = workCopy();
  try {
    const r = prove(w, { runner: 'gradle', timeoutMs: 300000 });
    assert.equal(r.runner, 'gradle');
    // CAUGHT: add, `triples a number` (BACKTICK-named @Test → triple gutted; regresses if backtick parsing
    // breaks), quadruples (@Nested inner-class @Test → quadruple gutted; regresses if the $-joined nested
    // FQN breaks), greet, square, testMeterReading (m.reading(21)), testPolymorphicSound (Dog.sound via a
    // Base-typed receiver — virtual dispatch), `builds via a trailing-lambda DSL` (yaml { … } — the parenless
    // trailing-lambda SUT, credited via the kotlin val-hop; regresses if trailing-lambda reach breaks).
    // HOLLOW: double, testMeterEcho (instance echo-oracle). firstTwo is ungutable; weakPositive is no-pin.
    assert.equal(r.caught, 8, `caught: ${r.caught} — expected add, triple (backtick), quadruple (@Nested), greet, square, testMeterReading, testPolymorphicSound, yaml (trailing-lambda)`);
    assert.equal(r.hollow.length, 2, `hollow: ${JSON.stringify(r.hollow)}`);
    assert.ok(r.hollow.some((h) => h.survivors.includes('double')), `one hollow entry should be the echo-oracle double(): ${JSON.stringify(r.hollow)}`);
    assert.ok(r.hollow.some((h) => h.survivors.includes('reading')), `one hollow entry should be the instance-method echo-oracle reading(): ${JSON.stringify(r.hollow)}`);
    // the polymorphic case must resolve to Dog.kt (the RUNTIME type), never Animal.kt
    assert.ok(r.hollow.every((h) => !h.survivors.includes('sound')), `sound() must be CAUGHT, not hollow: ${JSON.stringify(r.hollow)}`);
    assert.ok(r.skipped.some((s) => s.why === 'no-pin'), 'weakPositive should be no-pin');
    assert.ok(r.skipped.some((s) => s.why === 'ungutable'), 'testFirstTwo (List return) sentinel type-fails → ungutable');
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// relational-assert reach over the REAL gradle runner (mirrors test/relational-reach.test.mjs's JS
// coverage, on JVM): score(x) = x*2 is credited only through Kotlin relational assertTrue forms — the
// paren call (testScoreBound) and the parenless trailing-lambda call (testScoreOneSided). testScoreBound
// pins score(3) < 100: the +HUGE sentinel makes it red on the very first (non-deep) run -> PROVEN.
// testScoreOneSided pins score(2) > 0: +HUGE survives (still > 0), but the confirm-before-accuse
// opposite-sentinel check (run automatically for every survivor, deep or not) goes red at -HUGE (no
// longer > 0) -> ONE-SIDED, never hollow.
//
// testLabelUnbound is the string-sentinel case (amended in from Item B — a plain JS/TS/Python fn can
// never reach it: grossBreak's typed sentinel only exists for a Kotlin/Java declared return type, see
// test/relational-reach.test.mjs's own header note on that class). label(x): String = "v" + x gets the
// STRING sentinel ("__gutcheck_987654321__"), which has NO opposite mutant (grossBreakOpposite returns
// null for a string sentinel — no sign to flip). The bound "￿" sorts lexicographically ABOVE both
// the real value ('v...') and the ASCII sentinel ('_...'), so the mutant SURVIVES with no opposite
// evidence at all -> the relation is unbound, never hollow (relational-only survivors can prove or go
// one-sided but can never convict).
//
// New Score.kt/ScoreTest.kt files added to THIS test's own work copy only (same pattern as the
// K2-companion test above) — prove() is scoped to just ScoreTest.kt via `files` so the shared
// CalcTest.kt's own pre-existing caught/hollow verdicts (see the fixture-verdicts test above) can never
// leak into this block's r.hollow/r.skipped counts.
test('gradle e2e: relational one-sided tier — paren assertTrue proves, trailing-lambda assertTrue is one-sided, string-sentinel relational survivor is relation-unbound', opts, () => {
  const w = workCopy();
  try {
    writeFileSync(join(w, 'src/main/kotlin/Score.kt'), [
      'package demo', '',
      'fun score(x: Int): Int = x * 2',
      'fun label(x: Int): String = "v" + x',
      '',
    ].join('\n'));
    writeFileSync(join(w, 'src/test/kotlin/ScoreTest.kt'), [
      'package demo', '',
      'import org.junit.jupiter.api.Test',
      'import org.junit.jupiter.api.Assertions.assertTrue', '',
      'class ScoreTest {',
      '    @Test fun testScoreBound() { assertTrue(score(3) < 100) }',
      '    @Test fun testScoreOneSided() { assertTrue { score(2) > 0 } }',
      '    @Test fun testLabelUnbound() { assertTrue(label(2) < "￿") }',
      '}', '',
    ].join('\n'));

    const r = prove(w, { runner: 'gradle', timeoutMs: 300000, files: ['ScoreTest.kt'] });
    assert.equal(r.runner, 'gradle');
    assert.ok(r.caught >= 1, `testScoreBound (paren assertTrue) should prove: ${JSON.stringify(r)}`);
    assert.ok(r.oneSided.some((o) => o.name.includes('testScoreOneSided')), `testScoreOneSided (trailing-lambda assertTrue) should be one-sided: ${JSON.stringify(r.oneSided)}`);
    assert.deepEqual(
      r.skipped.filter((s) => s.why === 'relation-unbound').map((s) => s.name.split('.').pop()),
      ['testLabelUnbound'],
      `testLabelUnbound (string-sentinel, no opposite evidence) should be relation-unbound: ${JSON.stringify(r.skipped)}`,
    );
    assert.equal(r.hollow.length, 0, `hollow: ${JSON.stringify(r.hollow)}`);
    assert.ok(!r.skipped.some((s) => s.name.includes('testScoreBound') || s.name.includes('testScoreOneSided')), `neither of the other two tests should be skipped: ${JSON.stringify(r.skipped)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// `gutcheck --explain` on a Kotlin file (Bug C): explain()'s own file→lang derivation (mutation/
// gutcheck.mjs) was hardcoded to 'js' for anything but .py, so parseBlocks ran the JS/TS it()/describe()
// regex over a Kotlin file — no such calls exist there, so it always came back empty and EVERY Kotlin
// --explain failed with "no test block at or before …", regardless of whether the block was expression-
// or block-bodied. The first case here is plain block-bodied (isolates the lang-derivation fix from the
// parseBlocks expression-body fix); the second adds an expression-bodied @Test to a work copy and checks
// --explain attributes it to its OWN call, not a sibling's (the Bug A/B/C combination together).
test('gradle e2e: --explain works on a Kotlin file (brace-bodied @Test)', opts, () => {
  const w = workCopy();
  try {
    const r = spawnSync(process.execPath, [GUT, '--explain', 'src/test/kotlin/CalcTest.kt:9', w, '--runner=gradle'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /demo\.CalcTest\.testAdd/);
    assert.match(r.stdout, /PROVEN/);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('gradle e2e: --explain on an expression-bodied Kotlin @Test attributes it to its OWN call, not a sibling\'s', opts, () => {
  const w = workCopy();
  try {
    const f = join(w, 'src/test/kotlin/CalcTest.kt');
    writeFileSync(f, readFileSync(f, 'utf8').replace(
      '    @Test fun testAdd() { assertEquals(5, add(2, 3)) }          // proven\n',
      '    @Test fun testAdd() { assertEquals(5, add(2, 3)) }          // proven\n'
      + '    @Test fun testAddExpr() = assertEquals(5, add(2, 3))        // expression-bodied\n',
    ));
    const r = spawnSync(process.execPath, [GUT, '--explain', 'src/test/kotlin/CalcTest.kt:10', w, '--runner=gradle'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /demo\.CalcTest\.testAddExpr/);
    assert.match(r.stdout, /PROVEN/); // NOT the sibling `triples a number`'s verdict/body
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// Regression pin for the same Bug C fix (explain()'s file→lang derivation), driven through the CLI's own
// positional/--explain wiring (dir as positional[0] ahead of the flag, mirroring how a caller would
// actually invoke it) rather than the two tests above's fixed argv shape. Asserts the SHAPE of a real
// verdict (never the parse-failure stderr string) and status !== 2 (a usage/parse error), not status
// === 0 — explain()'s own exit-code contract returns 1 for a HOLLOW verdict, so a plain === 0 check would
// make this pin brittle to which verdict testAdd happens to land on.
test('gutcheck --explain works on a Kotlin test (regression: lang derivation once hardcoded js)', opts, () => {
  const w = workCopy();
  try {
    const r = spawnSync(process.execPath, [GUT, w, '--explain', 'src/test/kotlin/CalcTest.kt:9', '--runner=gradle'], { encoding: 'utf8' });
    assert.notEqual(r.status, 2, `usage/parse error, not a verdict:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /no test block at or before/, 'the Kotlin parse must find the block (Bug C: lang derivation once hardcoded js)');
    assert.match(r.stdout, /PROVEN|HOLLOW|not probed|inconclusive/, 'a verdict, not a parse failure');
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// jvm-instance-reach: a lowercase-receiver instance call (m.reading(21)) is now individually catchable —
// same shape as the plain-fn caught test above, but through Meter.kt's class-member method instead of a
// top-level `fun`, and selected by receiver-TYPE inference (jvmInstanceSuts), never a bare-name pin.
test('gradle e2e: instance-method mutant (Meter.reading) fails the pinned test (CAUGHT signal)', opts, () => {
  const w = workCopy();
  try {
    const f = join(w, 'src/main/kotlin/Meter.kt');
    writeFileSync(f, readFileSync(f, 'utf8').replace('fun reading(x: Int): Int = x * 2', 'fun reading(x: Int): Int = 987654321'));
    const r = runOne(w, 'gradle', 'src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testMeterReading', 180000);
    assert.equal(r.compiled, true);
    assert.ok(r.failed >= 1, `mutant should fail the pinned assertEquals(42, m.reading(21)): ${JSON.stringify(r)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// jvm-instance-reach VIRTUAL DISPATCH (the adversarial-review fix): the receiver is `val a: Animal =
// Dog()`, so `a.sound()` dispatches to Dog.sound at runtime. This pair proves the probe resolves the
// RUNTIME (constructor) type, not the declared/annotated one:
//   - gutting Dog.sound (the runtime type) FAILS testPolymorphicSound → CAUGHT (correct).
//   - gutting Animal.sound (the declared type) leaves the test GREEN → had inference chosen Animal, the
//     mutant would have no effect and the sound test would be a false HOLLOW. This leg is the regression
//     guard against ever reverting to annotation-based resolution.
test('gradle e2e: virtual-dispatch — gutting the RUNTIME type (Dog.sound) is CAUGHT', opts, () => {
  const w = workCopy();
  try {
    const f = join(w, 'src/main/kotlin/Dog.kt');
    writeFileSync(f, readFileSync(f, 'utf8').replace('override fun sound(): String = "woof"', 'override fun sound(): String = "__gutcheck_987654321__"'));
    const r = runOne(w, 'gradle', 'src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testPolymorphicSound', 180000);
    assert.equal(r.compiled, true);
    assert.ok(r.failed >= 1, `gutting the runtime type Dog.sound must fail the pinned "woof": ${JSON.stringify(r)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('gradle e2e: virtual-dispatch — gutting the DECLARED type (Animal.sound) SURVIVES (never dispatched)', opts, () => {
  const w = workCopy();
  try {
    const f = join(w, 'src/main/kotlin/Animal.kt');
    writeFileSync(f, readFileSync(f, 'utf8').replace('open fun sound(): String = "generic"', 'open fun sound(): String = "__gutcheck_987654321__"'));
    const r = runOne(w, 'gradle', 'src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testPolymorphicSound', 180000);
    assert.equal(r.compiled, true);
    assert.equal(r.failed, 0, `gutting the DECLARED type Animal.sound must NOT fail — Dog.sound is dispatched, so resolving Animal would be a false HOLLOW: ${JSON.stringify(r)}`);
    assert.ok(r.passed >= 1, `baseline still green under the Animal mutant: ${JSON.stringify(r)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// jvm-inheritance-gap (docs/plans/2026-07-08-jvm-inheritance-gap.md), K2 companion shape — the through-
// the-runner receipt. A companion-object `decrypt` is NOT instance-callable in Kotlin, so `service.
// decrypt(x)` always dispatches to Base's real (inherited) decrypt; the companion's own decrypt can never
// run. Pre-fix, jvmInstanceSuts credited Service.kt's companion decrypt (a file-wide decl count of 1,
// containment-blind) and prove() gutted it — the sound test still passed (the mutant is never dispatched)
// -> a false HOLLOW. Post-fix, jvmOwnPlainInstanceMember refuses the credit (the companion's site sits at
// nesting depth 1 inside Service's own span) -> the block lands unprobed (skipped, no SUT resolved),
// never a wrong verdict. Files are added to THIS test's own temp copy only (via workCopy(), like every
// other test in this file) — the checked-in fixtures/jvm-project tree is never mutated, so the shared
// "prove() gradle e2e: fixture verdicts" test's caught/hollow counts above are unaffected.
test('gradle e2e: K2 companion inheritance-gap shape lands unprobed, never a false HOLLOW', opts, () => {
  const w = workCopy();
  try {
    writeFileSync(join(w, 'src/main/kotlin/Service.kt'), [
      'package demo', '',
      'open class Base {',
      '    fun decrypt(x: Int): Int = x + 1',
      '}', '',
      'class Service : Base() {',
      '    companion object {',
      '        fun decrypt(x: Int): Int = 99',
      '    }',
      '}', '',
    ].join('\n'));
    writeFileSync(join(w, 'src/test/kotlin/ServiceTest.kt'), [
      'package demo', '',
      'import org.junit.jupiter.api.Test',
      'import org.junit.jupiter.api.Assertions.assertEquals', '',
      'class ServiceTest {',
      '    @Test fun testDecrypt() {',
      '        val service = Service()',
      '        assertEquals(6, service.decrypt(5))',
      '    }',
      '}', '',
    ].join('\n'));

    const r = prove(w, { runner: 'gradle', timeoutMs: 300000 });
    assert.equal(r.runner, 'gradle');
    assert.ok(!r.hollow.some((h) => h.survivors.includes('decrypt')), `Service's companion decrypt must never be counted hollow: ${JSON.stringify(r.hollow)}`);
    assert.ok(
      r.skipped.some((s) => s.file.includes('ServiceTest') && s.name.includes('testDecrypt')),
      `testDecrypt should land unprobed (skipped), not caught/hollow: ${JSON.stringify({ skipped: r.skipped, hollow: r.hollow, caught: r.caught })}`,
    );
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// ---- agent gate e2e: the Stop hook (hooks/check-changed-tests) is gutcheck's primary surface, but it
// had never been proven end-to-end on JVM (only the CLI/`prove()` above has). This drives the ACTUAL
// hook script — not prove() directly — over a throwaway git repo copied from the jvm-project fixture, the
// same way test/agent-hook.test.mjs proves it for JS. Each scenario gets its OWN fresh tmp repo (cleanest
// isolation — different diffs would not collide in the hook's per-diff-hash memo anyway, but a shared repo
// invites cross-scenario leakage on a rewrite this delicate).
function jvmHookRepo() {
  const w = mkdtempSync(join(tmpdir(), 'gc-jvm-hook-'));
  cpSync(FIX, w, { recursive: true, filter: (s) => !/([\\/])(\.gradle|build)([\\/]|$)/.test(s) });
  const g = (...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: w, stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); // this commit is the --since=HEAD baseline
  return w;
}
// Drive the real hook script exactly as Claude Code's Stop event would: stdin JSON, cwd = the repo root
// (the hook computes DIR via `pwd -P`). GUTCHECK_HOOK is left unset (inherited from process.env) so the
// gate stays ON (it is on by default; no .gutcheck marker is needed).
function runHook(w) {
  let out = '';
  try { out = execFileSync('bash', [HOOK], { cwd: w, input: '{}', encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '').toString(); }
  return out.trim();
}

test('agent gate e2e: the Stop hook blocks on a planted hollow Kotlin test and voices the denominator on a sound one', hookOpts, () => {
  // --- Scenario 1: a planted echo-oracle hollow test must BLOCK, naming its file:line. ---
  const w1 = jvmHookRepo();
  try {
    const testFile = join(w1, 'src/test/kotlin/CalcTest.kt');
    const src = readFileSync(testFile, 'utf8');
    // Circular by construction: the expected value is re-derived from the SUT itself, the exact failure
    // mode the gate exists to catch (mirrors the brief's Calc.add(2,3) example).
    const hollowSrc = src.replace(
      '@Test fun testAdd() { assertEquals(5, add(2, 3)) }',
      '@Test fun testAdd() { val e = add(2, 3); assertEquals(e, add(2, 3)) }',
    );
    assert.notEqual(hollowSrc, src, 'the testAdd rewrite must actually match the fixture source (guards against a silent no-op edit)');
    writeFileSync(testFile, hollowSrc); // uncommitted — part of the diff vs the HEAD baseline

    // Vacuous-pass guard: prove the planted hollow really DOES score HOLLOW to the probe BEFORE trusting
    // the hook's block — otherwise a degenerate "nothing probed → exit 0 → no block" could masquerade as
    // a passing assertion for the wrong reason (there is none here, but this makes the failure mode legible).
    const probeR = spawnSync(process.execPath, [GUT, w1, '--json', '--since=HEAD'], { encoding: 'utf8' });
    // exit 1 is gutcheck's "found a hollow" signal (see gutcheck.mjs's `exit()`), not an error — assert it
    // explicitly so this guard can't be satisfied by a broken run that happens to emit valid-looking JSON.
    assert.equal(probeR.status, 1, `probe should exit 1 (hollow found) on this diff:\nstdout: ${probeR.stdout}\nstderr: ${probeR.stderr}`);
    let probeJson; try { probeJson = JSON.parse(probeR.stdout); } catch { assert.fail(`probe stdout was not JSON: ${probeR.stdout}`); }
    assert.ok(probeJson.hollow && probeJson.hollow.length > 0, `the planted testAdd rewrite must score HOLLOW to the probe itself before trusting the hook: ${probeR.stdout}`);
    assert.ok(probeJson.hollow.some((h) => h.name.includes('testAdd')), `the planted testAdd specifically must be among the hollow entries: ${probeR.stdout}`);

    const out1 = runHook(w1);
    assert.ok(out1, 'the hook must produce stdout for a diff containing a proven-hollow test');
    let parsed1; try { parsed1 = JSON.parse(out1); } catch { assert.fail(`hook stdout was not JSON: ${out1}`); }
    assert.equal(parsed1.decision, 'block', `expected a Stop-hook block: ${out1}`);
    assert.match(parsed1.reason, /CalcTest\.kt:\d+/, `the reason must name the hollow test's file:line: ${parsed1.reason}`);
    assert.match(parsed1.reason, /testAdd/, `the reason must name the hollow test itself: ${parsed1.reason}`);
  } finally { rmSync(w1, { recursive: true, force: true }); }

  // --- Scenario 2: tests stay sound; a changed, still-covered SUT function voices the coverage
  // denominator as a non-blocking systemMessage (never `decision`). ---
  // NOTE: Calc.kt/Meter.kt are each shared by a CAUGHT test and a pre-existing HOLLOW echo-oracle test
  // (double()/testDouble, reading()/testMeterEcho — see "prove() gradle e2e: fixture verdicts" above).
  // The JVM SUT-side "changed" scoping is file-granular, so editing either file would re-surface those
  // PRE-EXISTING hollow tests too — turning this into an (accurate, but off-topic) block, not the clean
  // voice this scenario targets. Dog.kt is single-purpose (only sound(), bound only to the CAUGHT
  // testPolymorphicSound), so it isolates the clean-voice path cleanly.
  const w2 = jvmHookRepo();
  try {
    const sutFile = join(w2, 'src/main/kotlin/Dog.kt');
    const sutSrc = readFileSync(sutFile, 'utf8');
    // Behavior-preserving edit (adds a no-op statement) so testPolymorphicSound (unmodified) stays green
    // and still proves sound() — this exercises the CLEAN voice, not the block path.
    const editedSut = sutSrc.replace(
      'override fun sound(): String = "woof"   // the RUNTIME override the probe must gut (see Animal.kt)',
      'override fun sound(): String {\n        val noop = 0\n        return "woof" + "".repeat(noop)\n    }',
    );
    assert.notEqual(editedSut, sutSrc, 'the sound() rewrite must actually match the fixture source');
    writeFileSync(sutFile, editedSut); // uncommitted — part of the diff vs the HEAD baseline

    const out2 = runHook(w2);
    assert.ok(out2, 'the hook must produce stdout (the clean-voice systemMessage) for a changed, still-proven function');
    let parsed2; try { parsed2 = JSON.parse(out2); } catch { assert.fail(`hook stdout was not JSON: ${out2}`); }
    assert.equal(parsed2.decision, undefined, `a sound diff must never block: ${out2}`);
    assert.match(parsed2.systemMessage, /of \d+ function\(s\) you changed — \d+ proven/, `should voice the coverage denominator: ${out2}`);
  } finally { rmSync(w2, { recursive: true, force: true }); }
});

// ---- Root-module KMP task selection (pure function, no gradle): kotlin("multiplatform") at the
// repo ROOT puts tests at src/jvmTest/... with no module prefix — the jvmTest branch must match a
// rel with no leading slash. Wild specimen: sunny-chung/giant-log-viewer, where the unanchored
// match fell through to the nonexistent `test` task (fail-closed did-not-run, but it zeroes the
// whole root-module-KMP repo class even with a warm cache).
test('gradleTaskInfo: root-module KMP src/jvmTest selects jvmTest, not test', () => {
  const gi = gradleTaskInfo('/nonexistent-kmp-root', 'src/jvmTest/kotlin/com/x/ReaderTest.kt');
  assert.equal(gi.unitTask, 'jvmTest');
  assert.equal(gi.taskPath, 'jvmTest');
  assert.equal(gi.resultsDir, join('build', 'test-results', 'jvmTest'));
});

test('gradleTaskInfo: root-module commonTest with a declared jvm() target selects jvmTest', () => {
  const w = mkdtempSync(join(tmpdir(), 'gc-kmp-root-'));
  try {
    writeFileSync(join(w, 'build.gradle.kts'), 'kotlin {\n    jvm()\n}\n');
    const gi = gradleTaskInfo(w, 'src/commonTest/kotlin/com/x/CommonTest.kt');
    assert.equal(gi.taskPath, 'jvmTest');
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('gradleTaskInfo: module-prefixed KMP and root plain-JVM selection are unchanged', () => {
  assert.equal(gradleTaskInfo('/nonexistent', 'protocol/src/jvmTest/kotlin/Foo.kt').taskPath, ':protocol:jvmTest');
  assert.equal(gradleTaskInfo('/nonexistent', 'src/test/kotlin/FooTest.kt').taskPath, 'test');
});

// ---- Android extension (opt-in, env-gated): the plain-JVM fixture above never exercises AGP's
// `testDebugUnitTest` branch of gradleTaskInfo/runOne — that needs a real Android module (a synthetic
// fixture would have to fake the whole AGP + Robolectric toolchain). Bring your own app repo
// (single :app module, unit tests present) and name the probe targets:
//   GUTCHECK_ANDROID_E2E_PROJ       path to the repo (driven via a work copy, read-only to the original)
//   GUTCHECK_ANDROID_E2E_TEST       repo-relative path of a unit-test .kt file
//   GUTCHECK_ANDROID_E2E_FQN        qualified test method in that file (class FQN + '.' + method)
//   GUTCHECK_ANDROID_E2E_SUT        repo-relative path of the SUT .kt the test exercises
//   GUTCHECK_ANDROID_E2E_STRING_FN  a pure String-returning fn in the SUT whose literal the test pins
//   GUTCHECK_ANDROID_E2E_BOOL_FN    a Boolean-returning fn in the same SUT (compile-fail leg)
// Selection criteria: the test must pin a String literal from STRING_FN and call it DIRECTLY (no
// ViewModel/mock indirection) — grossBreak's String sentinel is then guaranteed type-compatible
// (COMPILES) and guaranteed to violate the pin (CAUGHT). Avoid tests whose pinned value is set as a
// side effect of a Unit-returning method: the numeric sentinel in a Unit-inferred body is a Kotlin
// type error (compile-fail, not the required CAUGHT shape). Skipped unless every var + an SDK is set.
const ANDROID_PROJ = process.env.GUTCHECK_ANDROID_E2E_PROJ || '';
const TEST_FILE_REL = process.env.GUTCHECK_ANDROID_E2E_TEST || '';
const SUT_FILE_REL = process.env.GUTCHECK_ANDROID_E2E_SUT || '';
const QUALIFIED = process.env.GUTCHECK_ANDROID_E2E_FQN || '';
const STRING_FN = process.env.GUTCHECK_ANDROID_E2E_STRING_FN || '';
const BOOL_FN = process.env.GUTCHECK_ANDROID_E2E_BOOL_FN || '';
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || (existsSync(join(homedir(), 'Library/Android/sdk')) ? join(homedir(), 'Library/Android/sdk') : null);
const aopts = (haveJava && SDK && ANDROID_PROJ && existsSync(ANDROID_PROJ) && TEST_FILE_REL && SUT_FILE_REL && QUALIFIED && STRING_FN && BOOL_FN)
  ? {} : { skip: 'Android e2e is opt-in: set the GUTCHECK_ANDROID_E2E_* vars to a local Android app repo and its probe targets (and have an SDK)' };

// Copies only what the :app module's Gradle build reads (app/ minus build/.gradle, plus the root
// wrapper/settings/build files) rather than the whole repo: a real app repo can carry large non-app
// trees (reference corpora, cloud-function packages, docs/, .git) that :app:testDebugUnitTest never
// touches for the selected test class.
function androidWorkCopy() {
  const w = mkdtempSync(join(tmpdir(), 'gc-android-e2e-'));
  cpSync(join(ANDROID_PROJ, 'app'), join(w, 'app'), { recursive: true, filter: (s) => !/([\\/])(\.gradle|build)([\\/]|$)/.test(s) });
  cpSync(join(ANDROID_PROJ, 'gradle'), join(w, 'gradle'), { recursive: true });
  for (const f of ['settings.gradle.kts', 'build.gradle.kts', 'gradle.properties']) {
    cpSync(join(ANDROID_PROJ, f), join(w, f));
  }
  writeFileSync(join(w, 'local.properties'), `sdk.dir=${SDK}\n`);
  return w;
}

test('android e2e: gradleTaskInfo resolves the AGP module to :app:testDebugUnitTest', aopts, () => {
  const gi = gradleTaskInfo(ANDROID_PROJ, TEST_FILE_REL);
  assert.equal(gi.taskPath, ':app:testDebugUnitTest');
  assert.equal(gi.resultsDir, join('app', 'build', 'test-results', 'testDebugUnitTest'));
});

test('android e2e: testDebugUnitTest mutant cycle on a real Android module (baseline green, mutant CAUGHT)', aopts, () => {
  const w = androidWorkCopy();
  try {
    const gi = gradleTaskInfo(w, TEST_FILE_REL);
    assert.equal(gi.taskPath, ':app:testDebugUnitTest');
    assert.equal(gi.resultsDir, join('app', 'build', 'test-results', 'testDebugUnitTest'));

    const baseline = runOne(w, 'gradle', TEST_FILE_REL, QUALIFIED, 600000);
    assert.equal(baseline.compiled, true, `baseline should compile:\n${baseline.out.slice(-4000)}`);
    assert.ok(baseline.passed >= 1 && baseline.failed === 0, `baseline: ${JSON.stringify({ passed: baseline.passed, failed: baseline.failed })}`);

    const sutAbs = join(w, SUT_FILE_REL);
    const mutated = grossBreak(readFileSync(sutAbs, 'utf8'), STRING_FN, 'kotlin');
    assert.ok(mutated, `grossBreak must locate ${STRING_FN} in ${SUT_FILE_REL}`);
    writeFileSync(sutAbs, mutated);

    const mutant = runOne(w, 'gradle', TEST_FILE_REL, QUALIFIED, 600000);
    assert.equal(mutant.compiled, true, `mutant should still compile (String-typed sentinel):\n${mutant.out.slice(-4000)}`);
    assert.ok(mutant.failed >= 1, `mutant should fail the pinned String assertion (CAUGHT): ${JSON.stringify({ passed: mutant.passed, failed: mutant.failed })}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// Compile-fail (ungutable) leg: BOOL_FN is Boolean-returning, so gutValueFor's
// numeric default sentinel is a genuine Kotlin type error — a real module surfaced a real gap in
// runOne's compiled-detection: AGP names the task `compileDebugKotlin` (build-variant-qualified), not
// the plain-JVM-plugin's bare `compileKotlin`, so the old `/compile(Kotlin|Java) FAILED/` regex missed
// it and misreported compiled:true on a build that never produced fresh test XML. Fixed in prove.mjs's
// runOne (compile\\w*(Kotlin|Java)\\w*\\s+FAILED); this test is the regression guard for that fix.
test('android e2e: compile-failing mutant → compiled=false, no fresh XML (ungutable) under AGP', aopts, () => {
  const w = androidWorkCopy();
  try {
    const sutAbs = join(w, SUT_FILE_REL);
    const mutated = grossBreak(readFileSync(sutAbs, 'utf8'), BOOL_FN, 'kotlin');
    assert.ok(mutated, `grossBreak must locate ${BOOL_FN} in ${SUT_FILE_REL}`);
    writeFileSync(sutAbs, mutated);

    const r = runOne(w, 'gradle', TEST_FILE_REL, QUALIFIED, 600000);
    assert.equal(r.compiled, false, `Boolean fn gutted with a numeric sentinel must fail AGP's variant-qualified compile task:\n${r.out.slice(-4000)}`);
    assert.equal(r.passed, 0); assert.equal(r.failed, 0); // no fresh XML → never CAUGHT
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// ---- Maven extension (opt-in, env-gated — mirrors the Android block above's skip pattern): CI has no
// maven binary at all, so every leg here is skipped unless GUTCHECK_MVN points at a real mvn (needs a
// warm ~/.m2 cache for the offline runs — same "warm cache" precondition as the gradle e2es' ~/.gradle).
// The fixture is a small checked-in Maven+JUnit5 project (test/fixtures/maven-project), not an external
// env-var-pointed repo — Maven's fixture is cheap enough to check in outright, unlike Android's SDK+repo.
const MAVEN_FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/maven-project');
const mopts = process.env.GUTCHECK_MVN
  ? {} : { skip: 'maven e2e is opt-in: set GUTCHECK_MVN to an mvn binary (needs a warm ~/.m2 cache for offline runs)' };

function mavenWorkCopy() {
  const w = mkdtempSync(join(tmpdir(), 'gc-maven-e2e-'));
  cpSync(MAVEN_FIX, w, { recursive: true, filter: (s) => !/([\\/])target([\\/]|$)/.test(s) });
  return w;
}

test('maven e2e: baseline addsTwoNumbers is green', mopts, () => {
  const w = mavenWorkCopy();
  try {
    const r = runOne(w, 'maven', 'src/test/java/demo/CalcTest.java', 'demo.CalcTest.addsTwoNumbers', 180000);
    assert.equal(r.compiled, true, `stdout tail:\n${r.out.slice(-2000)}`);
    assert.ok(r.passed >= 1 && r.failed === 0, `baseline: ${JSON.stringify({ passed: r.passed, failed: r.failed })}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('maven e2e: type-compatible mutant fails the test (CAUGHT signal)', mopts, () => {
  const w = mavenWorkCopy();
  try {
    const f = join(w, 'src/main/java/demo/Calc.java');
    writeFileSync(f, readFileSync(f, 'utf8').replace('return a + b;', 'return 987654321;'));
    const r = runOne(w, 'maven', 'src/test/java/demo/CalcTest.java', 'demo.CalcTest.addsTwoNumbers', 180000);
    assert.equal(r.compiled, true, `stdout tail:\n${r.out.slice(-2000)}`);
    assert.ok(r.failed >= 1, `mutant should fail: ${JSON.stringify(r)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('maven e2e: compile-failing mutant → compiled=false, no fresh XML (ungutable)', mopts, () => {
  const w = mavenWorkCopy();
  try {
    const f = join(w, 'src/main/java/demo/Calc.java');
    writeFileSync(f, readFileSync(f, 'utf8').replace(
      'return Math.max(0, Math.min(100, r));', 'return "not-an-int";',
    ));
    const r = runOne(w, 'maven', 'src/test/java/demo/CalcTest.java', 'demo.CalcTest.clampsAboveCeiling', 180000);
    assert.equal(r.compiled, false, `stdout tail:\n${r.out.slice(-2000)}`);
    assert.equal(r.passed, 0); assert.equal(r.failed, 0); // no fresh XML → never CAUGHT
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test('prove() maven e2e: fixture verdicts — add and clampScore both come back PROVEN (caught)', mopts, () => {
  const w = mavenWorkCopy();
  try {
    const r = prove(w, { runner: 'maven', timeoutMs: 300000 });
    assert.equal(r.runner, 'maven');
    assert.equal(r.caught, 2, `caught: ${r.caught} — expected add() and clampScore() both proven: ${JSON.stringify({ hollow: r.hollow, skipped: r.skipped, inconclusive: r.inconclusive })}`);
    assert.equal(r.hollow.length, 0, `hollow: ${JSON.stringify(r.hollow)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// mavenBin/mavenCompiled themselves are exercised CI-safe (fabricated fake executables + captured real
// output text, no live mvn spawn) in test/maven-runner.test.mjs; this file covers only the real spawn.

// ---- Maven reactor (multi-module) extension, same GUTCHECK_MVN gate as the single-module block above.
// The fixture is a 2-module reactor (root packaging=pom + core, test/fixtures/maven-reactor): the parent
// has no test phase of its own, so if the probe still read from the reactor ROOT's target/surefire-reports
// (v1 behavior) it would find nothing there at all — this is the exact under-reach mavenModuleDir fixes.
// Warmed the same way as the single-module fixture: a CI step runs a real (online) `mvn -q test` at the
// reactor ROOT first (builds+tests every module in one reactor pass, populating core/target/surefire-
// reports as a side effect and warming ~/.m2), then this test copies the fixture and runs the OFFLINE
// probe against the copy — mavenModuleDir resolves the owning module (core) per test file, so the mvn
// invocation and the XML read both happen in core/, not at the copy's reactor root.
const MAVEN_REACTOR_FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/maven-reactor');

function mavenReactorWorkCopy() {
  const w = mkdtempSync(join(tmpdir(), 'gc-maven-reactor-e2e-'));
  cpSync(MAVEN_REACTOR_FIX, w, { recursive: true, filter: (s) => !/([\\/])target([\\/]|$)/.test(s) });
  return w;
}

test('maven reactor e2e: submodule test scores CAUGHT via mavenModuleDir (not inconclusive-no-results)', mopts, () => {
  const w = mavenReactorWorkCopy();
  try {
    const r = prove(w, { runner: 'maven', timeoutMs: 300000 });
    assert.equal(r.runner, 'maven');
    assert.equal(r.caught, 2, `caught: ${r.caught} — expected core's add() and clampScore() both proven, not inconclusive-no-results: ${JSON.stringify({ hollow: r.hollow, skipped: r.skipped, inconclusive: r.inconclusive })}`);
    assert.equal(r.hollow.length, 0, `hollow: ${JSON.stringify(r.hollow)}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});
