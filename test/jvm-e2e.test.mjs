import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { runOne, javaExe, prove, gradleTaskInfo } from '../mutation/prove.mjs';
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

// ---- Android extension (opt-in, env-gated): the plain-JVM fixture above never exercises AGP's
// `testDebugUnitTest` branch of gradleTaskInfo/runOne — that needs a real Android module (a synthetic
// fixture would have to fake the whole AGP + Robolectric toolchain). Point GUTCHECK_ANDROID_E2E_PROJ at
// a local Android app repo (single :app module, unit tests present) to enable; the tests drive a work
// copy only, read-only to the original. Skipped everywhere the env var or the SDK is absent.
const ANDROID_PROJ = process.env.GUTCHECK_ANDROID_E2E_PROJ || '';
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || (existsSync(join(homedir(), 'Library/Android/sdk')) ? join(homedir(), 'Library/Android/sdk') : null);
const aopts = (haveJava && SDK && ANDROID_PROJ && existsSync(ANDROID_PROJ))
  ? {} : { skip: 'Android e2e is opt-in: set GUTCHECK_ANDROID_E2E_PROJ to a local Android app repo (and have an SDK)' };

// Copies only what the :app module's Gradle build reads (app/ minus build/.gradle, plus the root
// wrapper/settings/build files) rather than the whole ~1.7 GB repo: RoomAcoustics-2 also carries a
// ~1 GB reference/ corpus, a functions/ (Firebase) tree, docs/, and .git that :app:testDebugUnitTest
// never touches for the test class this file selects (two systemProperty paths in app/build.gradle.kts
// DO point at reference/ and .claude/, but both are registered `.optional(true)` task inputs consumed
// only by test classes — ReferenceKbConsistencyTest, CitationLocatorGuardTest — this e2e never runs).
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

// Pinned test: EdtRt60RatioTest.note_aroundOne_isDiffuse asserts
// assertEquals("Diffuse field", edtRt60RatioNote(1.0f)) against a pure, one-line String-returning
// function in ResultLogic.kt that the test calls directly (no ViewModel/mockk indirection) — so
// grossBreak's String sentinel is guaranteed type-compatible (COMPILES) and guaranteed to violate the
// pinned literal (CAUGHT). Chosen over the task brief's suggested MicCalibrationStatusTypedTest /
// RoomViewModelLiveEqTest candidates after reading both: their pinned values (CalMessageStatus,
// liveEqEnabledFilterIndices) are set as a SIDE EFFECT of a Unit-returning RoomViewModel method
// (runMicCalibration / toggleLiveEqFilter / enableAllLiveEqFilters) — grossBreak's numeric sentinel in
// a Unit-inferred body is a Kotlin type error there (compile-fail, not the required CAUGHT shape).
const TEST_FILE_REL = 'app/src/test/java/com/roomacoustics/ui/screens/result/EdtRt60RatioTest.kt';
const SUT_FILE_REL = 'app/src/main/java/com/roomacoustics/ui/screens/result/ResultLogic.kt';
const QUALIFIED = 'com.roomacoustics.ui.screens.result.EdtRt60RatioTest.note_aroundOne_isDiffuse';

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
    const mutated = grossBreak(readFileSync(sutAbs, 'utf8'), 'edtRt60RatioNote', 'kotlin');
    assert.ok(mutated, 'grossBreak must locate edtRt60RatioNote in ResultLogic.kt');
    writeFileSync(sutAbs, mutated);

    const mutant = runOne(w, 'gradle', TEST_FILE_REL, QUALIFIED, 600000);
    assert.equal(mutant.compiled, true, `mutant should still compile (String-typed sentinel):\n${mutant.out.slice(-4000)}`);
    assert.ok(mutant.failed >= 1, `mutant should fail the pinned "Diffuse field" assertion (CAUGHT): ${JSON.stringify({ passed: mutant.passed, failed: mutant.failed })}`);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// Compile-fail (ungutable) leg: thdSectionVisibleOnScreen is Boolean-returning, so gutValueFor's
// numeric default sentinel is a genuine Kotlin type error — this real module surfaced a real gap in
// runOne's compiled-detection: AGP names the task `compileDebugKotlin` (build-variant-qualified), not
// the plain-JVM-plugin's bare `compileKotlin`, so the old `/compile(Kotlin|Java) FAILED/` regex missed
// it and misreported compiled:true on a build that never produced fresh test XML. Fixed in prove.mjs's
// runOne (compile\\w*(Kotlin|Java)\\w*\\s+FAILED); this test is the regression guard for that fix.
test('android e2e: compile-failing mutant → compiled=false, no fresh XML (ungutable) under AGP', aopts, () => {
  const w = androidWorkCopy();
  try {
    const sutAbs = join(w, SUT_FILE_REL);
    const mutated = grossBreak(readFileSync(sutAbs, 'utf8'), 'thdSectionVisibleOnScreen', 'kotlin');
    assert.ok(mutated, 'grossBreak must locate thdSectionVisibleOnScreen in ResultLogic.kt');
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
