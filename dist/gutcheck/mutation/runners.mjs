// mutation/runners.mjs — test-runner support: the runner table, detection, binary resolution, command
// construction, and run-output parsing (including the TAP reporter pin that keeps Node 23+'s spec-default
// flip from reading 0 passed / 0 failed). prove.mjs re-exports every name here (test/prove-exports.test.mjs
// pins that surface). pythonExe (Python interpreter resolution) lives in mutation/python-resolve.mjs — testCmdFor's pytest
// branch below is its OTHER caller (besides python-resolve.mjs's own pyBlocks/pyMemberOk), so it is
// imported back from there, mirroring javaExe's home in mutation/jvm.mjs for the same reason.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { reEsc } from './parse-utils.mjs';
import { javaExe, mavenBin, mavenModuleDir, gradleTaskInfo, parseGradleResults, mavenCompiled } from './jvm.mjs';
import { pythonExe } from './python-resolve.mjs';

// ---- runner abstraction ----
export function detectRunner(dir) {
  let pkg = {}; try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch {}
  // The test script is the strongest signal of the runner a repo ACTUALLY uses — devDependencies can
  // carry other runners as fixtures or tooling (this repo does). Deps order stays as the fallback.
  const script = (pkg.scripts && typeof pkg.scripts.test === 'string') ? pkg.scripts.test : '';
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bmocha\b/.test(script)) return 'mocha';
  if (/\bava\b/.test(script)) return 'ava';
  if (/\bpytest\b/.test(script)) return 'pytest';
  if (/\bnode\s+--test\b/.test(script)) return 'node';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  if (deps.mocha) return 'mocha';
  if (deps.ava) return 'ava';
  if (['pyproject.toml', 'setup.py', 'pytest.ini', 'tox.ini'].some((m) => existsSync(join(dir, m)))) return 'pytest';
  if (['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].some((m) => existsSync(join(dir, m)))) return 'gradle';
  // Maven: checked AFTER gradle, so a repo carrying both marker sets (rare) keeps gradle — the gradle
  // branch above already returned by this point whenever a gradle marker exists.
  if (existsSync(join(dir, 'pom.xml'))) return 'maven';
  return 'node';
}
// Runner IDs — the single source of truth: detectRunner only ever returns one of these, and the
// completeness meta-test (test/prove.test.mjs) iterates this list to guarantee every entry has both a
// testCmdFor command spec and (except gradle and maven, which read JUnit XML via parseGradleResults
// instead) a parseRun branch, backed by a fixture.
export const RUNNERS = ['vitest', 'jest', 'mocha', 'ava', 'pytest', 'node', 'gradle', 'maven'];
// Languages each runner can actually execute — the runner-mismatch gate's single source of truth.
// One runner is detected per repo (detectRunner), but a repo can carry test files that runner cannot
// run (a Maven fixture inside a JS repo, a stray .py in a gradle repo). Running them anyway 'fails'
// the baseline and mints a false already-failing verdict.
export const RUNNER_LANGS = {
  vitest: ['js'], jest: ['js'], mocha: ['js'], ava: ['js'], node: ['js'],
  pytest: ['python'],
  gradle: ['kotlin', 'java'], maven: ['kotlin', 'java'],
};

// ---- runner bin resolution (win32 root cause B) ----
// spawnSync('npx.cmd') throws EINVAL on patched Node (CVE-2024-27980) and a bare `npx` is ENOENT on
// win32 (no shim named that), so npx-based invocation cannot work there without shell:true — forbidden.
// The fix: resolve the runner package's own JS bin entry (the very file the npx shim would have execed)
// and spawn it directly with `process.execPath` — an argv-exec, no shell, no shim, on every platform.
// Walks from `dir` up to the filesystem root looking for node_modules/<pkg>/package.json; the FIRST
// ancestor that has one wins (mirrors node's own module resolution — a nearer node_modules shadows any
// further up) whether or not its `bin` field ultimately resolves to something. `bin` is either a string
// (single-bin packages: jest ships `bin/jest.js`) or an object keyed by command name (multi-bin: vitest
// ships `{vitest: "vitest.mjs"}`, mocha ships BOTH `{mocha: "bin/mocha.js", _mocha: "bin/_mocha"}` — only
// the `mocha`-named entry is wanted — and ava ships `{ava: "entrypoints/cli.mjs"}`); take the entry named
// exactly `pkg`, else the object's first value (a package that doesn't name its own bin after itself
// still needs *a* value). Returns the absolute resolved path, or null if no ancestor has the package.
export function resolveRunnerBin(runner, dir) {
  let d = resolve(dir);
  for (;;) {
    const pkgDir = join(d, 'node_modules', runner);
    const pkgJson = join(pkgDir, 'package.json');
    if (existsSync(pkgJson)) {
      try {
        const bin = JSON.parse(readFileSync(pkgJson, 'utf8')).bin;
        let rel = null;
        if (typeof bin === 'string') rel = bin;
        else if (bin && typeof bin === 'object') rel = Object.prototype.hasOwnProperty.call(bin, runner) ? bin[runner] : Object.values(bin)[0];
        return rel ? resolve(pkgDir, rel) : null;
      } catch { return null; }
    }
    const parent = dirname(d);
    if (parent === d) return null; // reached the filesystem root — never found it
    d = parent;
  }
}
// The two shapes testCmdFor falls back to when resolveRunnerBin found nothing, isolated into a pure
// function of a boolean so BOTH platform branches are unit-testable on any single host (no platform
// injection/mocking — the plan's no-untestable-claims rule). Non-win32: `npx <runner>` is still useful
// when the runner is installed globally rather than locally resolvable — npx CAN be spawned there, this
// is just belt-and-suspenders for a repo without a local install. win32: npx can't be spawned at all
// (see the root-cause comment above), so a deliberately-failing, crash-proof sentinel is used instead —
// `node -e process.exit(1)` produces no output, parseRun reads 0 passed/0 failed from that empty output,
// and prove()'s baseline gate turns a 0p/0f "run" into `inconclusive` (never a crash, never a false
// HOLLOW/CAUGHT verdict) — the honest can't-actually-run-this-locally signal.
export function fallbackCmdFor(runner, isWin32) {
  if (isWin32) return { cmd: process.execPath, args: ['-e', 'process.exit(1)'] };
  return { cmd: 'npx', args: [runner] };
}
// Returns an argv spec { cmd, args } — NEVER a shell string. runOne execs it via spawnSync (no shell),
// so a test name containing shell-special characters (backtick, `$(...)`, quotes, …) is passed as a
// literal argument the shell never parses. reEsc(name) is REGEX escaping (still needed for node's
// --test-name-pattern and the vitest/jest -t regex matchers), not shell quoting.
// mocha's --grep IS a regex (reEsc it); ava's -m is a GLOB, not a regex — pass the RAW name, never reEsc.
// `dir` is the project root runOne is about to spawn IN (its cwd) — resolveRunnerBin walks up from there
// to find the runner's real local install. Defaults to process.cwd() for callers (unit tests, mainly)
// that don't have a project dir in scope; an unresolvable bin still falls through to the fallback shapes
// above exactly as if dir had never existed.
// `qualified` (default false): true when `name` is already a describe-QUALIFIED full name (prove()'s
// residual-ambiguity resolution — see qualifiedName/residualAmbiguous), not a bare title. Only mocha's
// branch consumes it: its qualified selection must be ANCHORED (`^...$`) — empirically verified (see the
// mocha e2e) that an anchored qualified pattern selects exactly one nested test, where the unanchored
// bare form does not. node's pattern is unconditionally anchored already regardless of `qualified` (no
// branch needed); vitest/jest's qualified form stays unanchored — the longer, more specific string is
// sufficient on its own (also empirically verified) — so neither reads this flag. Node's own full-name
// match only exists on v22+ — v20 fails this qualified selection closed instead (see the NODE VERSION
// CAVEAT above qualifiedName's definition in mutation/prove.mjs).
// `gradleTask` (6th param, default the root module's plain `test` task): the {taskPath,cleanPath,
// resultsDir} shape gradleTaskInfo() returns — prove()'s caller computes it per-file via gradleTaskInfo
// and passes it through; unit tests / callers with no project on disk get a valid root-`test` argv from
// the default alone.
export function testCmdFor(runner, file, name, dir = process.cwd(), qualified = false,
    gradleTask = { taskPath: 'test', cleanPath: 'cleanTest', resultsDir: 'build/test-results/test' }) {
  if (runner === 'gradle') {
    // java -cp <wrapper.jar> org.gradle.wrapper.GradleWrapperMain <cleanTask> <task> --tests <FQN>
    //   --offline --console=plain -Dorg.gradle.vfs.watch=false — no gradlew script (win32 .bat
    //   EINVAL-safe); cleanTask forces rerun (Gradle's up-to-date test-skip is real); --tests takes the
    //   class-qualified FQN literally. -Dorg.gradle.vfs.watch=false kills the vfs-watch race at its
    //   source (field report 2026-07-18): the probe's out-of-band mutant write can be missed by the
    //   daemon's virtual filesystem watcher, so a main-source compile task goes UP-TO-DATE despite
    //   changed source and the test reruns against STALE classes — a fresh-green survivor read off a
    //   build that never saw the mutant. System-property form deliberately, not `--no-watch-fs`: an
    //   unrecognized -D property is silently ignored by a Gradle version that predates it, while
    //   `--no-watch-fs` is a hard CLI parse error on Gradle < 6.7 — see mainCompileExecuted in
    //   mutation/prove.mjs for the belt-and-suspenders evidence gate that catches the race even where
    //   this flag can't (an old Gradle that ignores it).
    // NO --build-cache (removed, same field report): it made the race's failure mode WORSE, not better.
    // The local build cache is content-addressable and LOCATION-independent by design — that's its whole
    // point — so it satisfies a task from ANY prior build of byte-identical content, including a totally
    // separate probe invocation against a different temp work copy (e.g. the Stop hook re-firing on an
    // unchanged diff, or a user re-running gutcheck). A within-one-run repeat gut of the same fn (two
    // test blocks covering it) is still fast via Gradle's own always-on incremental build and is proven
    // safe by the lastCompiled memo in mutation/prove.mjs (this run watched it compile); --build-cache's only
    // ADDITIONAL effect was reusing output ACROSS separate invocations, which mainCompileExecuted cannot
    // tell apart from the race (both look identically UP-TO-DATE/FROM-CACHE) — so keeping it enabled
    // would silently mask real hollow findings on any repeat run. A live 2-invocation repro (probe the
    // same uncommitted diff twice) confirmed this: with --build-cache, the second invocation's genuine
    // survivors all read back 'ungutable' instead of their real verdict.
    const wrapper = join(dir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
    return { cmd: javaExe() || 'java', args: ['-cp', wrapper, 'org.gradle.wrapper.GradleWrapperMain',
      gradleTask.cleanPath, gradleTask.taskPath, '--tests', name, '--offline', '--console=plain', '-Dorg.gradle.vfs.watch=false'] };
  }
  if (runner === 'maven') {
    // mvn -o test -Dtest=<Class>#<method> -Dsurefire.failIfNoSpecifiedTests=false  — offline (mirrors
    // gradle's --offline); the FQN's LAST dot becomes '#' (Gradle's --tests takes a dotted FQN, Maven's
    // -Dtest takes Class#method); -Dsurefire.failIfNoSpecifiedTests=false is MANDATORY — without it a
    // zero-match -Dtest FAILS the build (verified live), which would misread as a test failure rather
    // than the honest zero-match green that mirrors gradle's own 0-match behavior.
    const mb = mavenBin(dir);
    // No mvn resolvable at all (no override, none on PATH, no wrapper jar): a deliberately-failing,
    // crash-proof sentinel — same idiom as fallbackCmdFor's win32 branch. Produces no output, so
    // parseGradleResults(dir) reads {0,0} from the (freshly emptied) results dir and prove()'s baseline
    // gate routes the block to inconclusive — never a crash, never a false verdict.
    if (!mb) return { cmd: process.execPath, args: ['-e', 'process.exit(1)'] };
    const fq = name.replace(/\.([^.]+)$/, '#$1');
    return { cmd: mb.cmd, args: [...mb.pre, '-o', 'test', '-Dtest=' + fq, '-Dsurefire.failIfNoSpecifiedTests=false'] };
  }
  if (runner === 'vitest' || runner === 'jest' || runner === 'mocha' || runner === 'ava') {
    // The args a resolved/fallback-npx invocation both share — everything AFTER the package name/bin path.
    const runnerArgs = runner === 'vitest' ? ['run', file, '-t', reEsc(name)]
      : runner === 'jest' ? [file, '-t', reEsc(name), '--runInBand']
      : runner === 'mocha' ? [file, '--reporter', 'tap', '--grep', qualified ? ('^' + reEsc(name) + '$') : reEsc(name)]
      : [file, '--tap', '-m', name]; // ava: -m is a glob, not a regex — RAW name, never reEsc
    const bin = resolveRunnerBin(runner, dir);
    if (bin) return { cmd: process.execPath, args: [bin, ...runnerArgs] };
    const isWin32 = process.platform === 'win32';
    const fb = fallbackCmdFor(runner, isWin32);
    return isWin32 ? fb : { cmd: fb.cmd, args: [...fb.args, ...runnerArgs] };
  }
  if (runner === 'pytest') return { cmd: pythonExe() || 'python', args: ['-m', 'pytest', file, '-k', name, '-q'] };
  // --test-reporter=tap is MANDATORY, not cosmetic: Node >=23 flipped the default `node --test` reporter
  // tap->spec (even for non-TTY stdout). The spec reporter prints `ℹ pass 1`, which parseRun and
  // nodeEffectiveCounts (TAP-only: `# pass N`, `1..0`, `ok N - <file>`) cannot read, so every node-runner
  // verdict parses 0p/0f — the self-check's planted sound test is never caught and gutcheck refuses to run
  // (issue #4). `--test-reporter` exists on every Node this package supports (>=20), so pin it
  // unconditionally — the node analog of mocha's `--reporter tap` / ava's `--tap` above.
  return { cmd: 'node', args: ['--test', '--test-reporter=tap', '--test-name-pattern', '^' + reEsc(name) + '$', file] };
}
// {passed, failed} from the runner SUMMARY — never the exit code (a zero-match run is green).
// parseRun always receives stdout+stderr CONCATENATED IN THAT ORDER (runOne), and these regexes are
// non-global .exec() — leftmost match wins. So stray summary-shaped text on stderr can only win when
// stdout has NO match at all (the jest case, whose summary IS on stderr). Keep that ordering.
export function parseRun(runner, out) {
  // LAST match wins, never the first: the runner's real summary comes at the END of the output, and a
  // test's own stdout can legally contain summary-shaped lines before it (`console.log('# fail 0')`,
  // TAP-ish progress from tools under test). A leftmost match let that spoof the verdict — a reproduced
  // false-HOLLOW vector (and symmetrically a false-CAUGHT one), closed by taking the final occurrence.
  const last = (re) => { let m = null; for (const x of out.matchAll(re)) m = x; return m; };
  if (runner === 'node' || runner === 'mocha' || runner === 'ava') { const p = last(/#\s*pass\s+(\d+)/g); const f = last(/#\s*fail\s+(\d+)/g); return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 }; }
  const p = last(/(\d+) passed/g); const f = last(/(\d+) failed/g); return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 };
}
// Discount a node run whose green is attributable ONLY to node's own file-wrapper subtest point,
// never to any selected test — closes the node zero-match false-HOLLOW vector at the runtime layer
// (see the runOne call site and the MASKING GUARD comment on DESCRIBE_HEAD_RE in mutation/prove.mjs for the two ways
// a selector can zero-match: a corrupted/ambiguous pattern, or a genuinely dead block such as
// describe.skip). When `--test-name-pattern` matches nothing in the given file, node still exits 0
// and reports `# pass 1`: TAP's own plan line proves it (`1..0` — zero subtests scheduled), and the
// single passing point is `ok N - <file>`, node's synthetic wrapper for "this file ran without
// error", named after the file argument verbatim — never a real test's title. (Empirically verified
// on node v22.22.2, both a non-matching --test-name-pattern and a describe.skip'd-away test: see
// test/fixtures/runner-output/node-zero-match.txt / node-one-match.txt and their README.) When a
// real test DOES match, node reports that test's own title directly — no separate wrapper line
// appears — so this helper only ever fires on a genuinely zero-match run.
// Only ever moves a run TOWARD inconclusive (every caller in runOne routes {0,0} there — see the
// baseline/survivor/recheck/deep gates in prove()); never mints a CAUGHT (requires failed > 0, and
// this function returns unchanged whenever failed > 0) or a HOLLOW (requires passed > 0 after this
// runs). Known fail-closed-direction miss: a real test literally TITLED the file's own relative path
// would be mis-coerced to 0p/0f too — accepted, since the alternative direction (a wrapper point
// counted as a real pass) is the false-HOLLOW vector this exists to close.
export function nodeEffectiveCounts(counts, out, file) {
  if (counts.failed > 0 || counts.passed < 1) return counts; // never touches a failing/empty run
  // Primary evidence, path-spelling-agnostic: node emits a column-0 `1..0` plan BEFORE the wrapper
  // point on every zero-match run (zero subtests scheduled — see node-zero-match.txt). The wrapper-
  // NAME match below cannot know every platform's path spelling: on Windows the wrapper is named by
  // a path form outside both rel-path variants (CI run 29116683747 minted a false HOLLOW from a
  // describe.skip fixture exactly this way). Nested subtest plans are indented, so column-0 `1..0`
  // can only be the top-level scheduled count; `\r?` keeps CRLF output covered.
  if (/^1\.\.0\r?$/m.test(out)) return { passed: 0, failed: 0 };
  const forms = [...new Set([file, file.split('/').join('\\')])].map(reEsc);
  const wrapRe = new RegExp(`^ok \\d+ - (?:${forms.join('|')})\\s*$`, 'gm');
  const wrappers = (out.match(wrapRe) || []).length;
  return counts.passed <= wrappers ? { passed: 0, failed: 0 } : counts;
}
export function runOne(cwd, runner, file, name, timeoutMs, qualified = false) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  if (runner === 'gradle') {
    const gi = gradleTaskInfo(cwd, file);
    const resultsAbs = join(cwd, gi.resultsDir);
    rmSync(resultsAbs, { recursive: true, force: true });   // guarantee no stale XML → fresh-read invariant
    // Ensure the daemon has a JDK even when JAVA_HOME is unset (we spawn `java`, but the wrapper's daemon
    // resolves its own JVM); derive JAVA_HOME from the resolved java when absent.
    const j = javaExe();
    if (j && j !== 'java' && !env.JAVA_HOME) env.JAVA_HOME = dirname(dirname(j));
    const { cmd, args } = testCmdFor('gradle', file, name, cwd, qualified, gi);
    const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', env, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    // Gradle task-names a Kotlin/JVM-plugin compile task plainly (`compileKotlin`/`compileJava`) but AGP
    // qualifies it by build variant (`compileDebugKotlin`, `compileDebugJavaWithJavac`, …) — \w* either
    // side of the keyword matches both without losing the anchor to a genuine compile task (a real
    // Android module run surfaced this: a Kotlin type error on the SUT failed as `compileDebugKotlin
    // FAILED`, which the plain-JVM-only pattern silently missed → false compiled=true).
    const compiled = !/compile\w*(Kotlin|Java)\w*\s+FAILED/.test(out);
    return { ...parseGradleResults(resultsAbs), compiled, out };
  }
  if (runner === 'maven') {
    // Multi-module reactor support: mavenModuleDir walks up from the test file to the nearest ancestor
    // pom.xml (root when none — single-module repos are byte-identical to v1, see mavenModuleDir's own
    // comment), and the probe reads results from AND invokes mvn IN that owning module's directory —
    // mirroring the gradle branch above, which already resolves its module via gradleTaskInfo. A
    // submodule built in isolation whose reactor siblings aren't installed to the local repo (an
    // unresolvable <parent>/inter-module dependency) fails the build here: no fresh XML, parseGradleResults
    // reads {0,0}, and prove()'s baseline gate routes that straight to inconclusive — fail-closed, exactly
    // like every other under-reach in this file, never a false verdict.
    const moduleDir = mavenModuleDir(cwd, file);
    const resultsAbs = join(moduleDir, 'target', 'surefire-reports');
    rmSync(resultsAbs, { recursive: true, force: true });   // guarantee no stale XML → fresh-read invariant
    const j = javaExe();
    if (j && j !== 'java' && !env.JAVA_HOME) env.JAVA_HOME = dirname(dirname(j));
    const { cmd, args } = testCmdFor('maven', file, name, moduleDir, qualified);
    const r = spawnSync(cmd, args, { cwd: moduleDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', env, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const compiled = mavenCompiled(out);
    return { ...parseGradleResults(resultsAbs), compiled, out };
  }
  const { cmd, args } = testCmdFor(runner, file, name, cwd, qualified);
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', env, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  let counts = parseRun(runner, out);
  if (runner === 'node') counts = nodeEffectiveCounts(counts, out, file);
  return { ...counts, out };
}
