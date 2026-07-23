// mutation/prove.mjs — the probe-as-front-door. Drives the mutation probe from EVERY test block (not from
// a static finding), and reports a mutation-detection SCORE plus the tests that pass even when the function
// they test is broken. Where the static checker is silent (it is high-precision, so it says nothing on
// unfamiliar shapes), this fires on real code and its verdict is execution-proven: "I broke your function
// and this test still passed" is not a matter of opinion.
//
// Two precision guards keep the verdicts trustworthy:
//   1. ASSERTION-STRENGTH GATE — a function is probed only if its result flows into a VALUE-PINNING matcher
//      (toBe/toEqual/toStrictEqual/toBeCloseTo, assert(.deep)?(strict)?Equal, `=== / ==`), directly or via
//      one variable hop. A block whose only checks are weak (toBeDefined/toBeTruthy/assert.ok/.not.toBe) is
//      left to the static weak-oracle advisory, never probed — so an existence/invariant test that uses a
//      helper as its oracle is not mis-flagged hollow.
//   2. EXECUTION BASELINE — a block is probed only after its single test runs GREEN unmutated (≥1 passed,
//      0 failed), parsed from the runner's summary, NOT its exit code (a zero-match run exits 0/green).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync, symlinkSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grossBreak, grossBreakOpposite, hasFirstParamIdentityBranch, passthroughBreak, jsDeclSites, jvmDeclSites, locateKotlinSite, pyDeclSiteCount } from './probe.mjs';
import { sutFnsIn } from './confirm.mjs';
import { codeOnly } from '../checker/lexer.mjs';
import { classifyChanges, hunkNewRanges, changedDecls } from './changes.mjs';
import { selfEchoAssertion, titleSutCandidates } from './wrongLayerShadow.mjs';
import { acquireRepoLock, reapStaleWork, markWorkOwned } from './lock.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', '.gradle', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'out', 'coverage', '.next', '.svelte-kit', '.vite']);
const DEFAULT_TIMEOUT_MS = Number(process.env.GUTCHECK_PROBE_TIMEOUT_MS) || 60000;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- path identity discipline (win32 root cause A) ----
// Canonical comparison key: resolves symlinks AND Windows 8.3 short names (realpathSync.native —
// plain realpathSync does NOT expand short names; evidence: diagnose run 28703534698, boundary A1,
// where join()'d and realpath'd forms of the SAME file disagreed because one round-tripped through the
// 8.3 short `RUNNER~1` form), then folds case on win32 (case-insensitive FS). Falls back to resolve(p)
// when the path doesn't exist (a deleted file from a diff, e.g.) rather than throwing. NEVER render
// this value — it is a comparison key only; display paths use toPosix below, never canonKey.
export function canonKey(p) {
  try { p = (realpathSync.native || realpathSync)(p); } catch { p = resolve(p); }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
// Every relative/display path is normalized to POSIX at creation — git, the runners, and this tool's
// own JSON/report consumers all accept '/' on win32, so downstream code never has to care which
// platform produced the path (evidence: diagnose run 28703534698, boundary A2 — a backslash path never
// matched a forward-slash-anchored dir-boundary regex).
export const toPosix = (p) => p.split('\\').join('/');

// Python interpreter, resolved ONCE: some systems ship `python3` but no bare `python`. Used for BOTH the
// pytest command and the stdlib-ast block helper, so they agree. null when neither is on PATH (→ the
// Python ast precision path is skipped and the regex Python branch is used as the fallback).
const PY_HELPER = fileURLToPath(new URL('./py_blocks.py', import.meta.url));
let _pyExe; // memoized: 'python3' | 'python' | null
export function pythonExe() {
  if (_pyExe !== undefined) return _pyExe;
  _pyExe = null;
  for (const exe of ['python3', 'python']) {
    try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); _pyExe = exe; break; } catch {}
  }
  return _pyExe;
}

// java, resolved ONCE: JAVA_HOME/bin/java if present+runnable, else `java` on PATH, else null (→ gradle/
// maven probing is skipped, never a crash). Mirrors pythonExe(). Both JVM wrappers need a JDK anyway.
let _javaExe;
export function javaExe() {
  if (_javaExe !== undefined) return _javaExe;
  _javaExe = null;
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(join(process.env.JAVA_HOME, 'bin', 'java'));
  cands.push('java');
  for (const exe of cands) {
    try { execFileSync(exe, ['-version'], { stdio: 'ignore' }); _javaExe = exe; break; } catch {}
  }
  return _javaExe;
}
// Reap orphaned prove() work copies at most ONCE per process (mutation/lock.mjs's reapStaleWork):
// gutcheck.mjs's --since-unresolvable and empty-scope full-suite fallbacks re-enter prove() up to
// twice in the same CLI process, and this module's own callers (tests, main()'s retries) may call
// prove() far more than that — the tmpdir sweep is startup hygiene, not per-run work, so repeating
// it inside one process only pays its cost (a full tmpdir readdir) again for zero extra benefit.
let staleWorkReaped = false;
// mvn binary resolution — mirrors javaExe()'s discipline (every candidate is actually EXECUTED and
// validated before being trusted, never just assumed present): an explicit override
// (GUTCHECK_MVN — an absolute path to an mvn binary) wins first, then `mvn` on PATH, then the project's
// own Maven Wrapper jar (java -cp <dir>/.mvn/wrapper/maven-wrapper.jar
// org.apache.maven.wrapper.MavenWrapperMain — no mvnw script, same win32-EINVAL-safe argv-exec
// discipline resolveRunnerBin/the gradle wrapper use: no shell, no shim). The validation env derives
// JAVA_HOME from javaExe() first (exactly as runOne does for the real invocation below) so the `-v`
// preflight can't spuriously fail on a box where `mvn` needs JAVA_HOME set but the ambient process env
// doesn't have it. Returns { cmd, pre } (pre = leading args before the maven goal args, [] for a direct
// mvn invocation) or null when nothing is resolvable at all — callers must then fail closed (skip the
// block, never a verdict), exactly like an absent java/python interpreter. Deliberately NOT memoized
// (unlike javaExe/pythonExe): GUTCHECK_MVN and `dir` legitimately vary per call/test (a per-block probe
// loop always passes the same `dir`, so the repeat `-v` cost is one small subprocess per test run, not
// per mutant — accepted for correctness/testability over that constant-factor cost).
export function mavenBin(dir) {
  const env = { ...process.env };
  const j = javaExe();
  if (j && j !== 'java' && !env.JAVA_HOME) env.JAVA_HOME = dirname(dirname(j));
  const tryBin = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore', env }); return true; } catch { return false; } };
  if (process.env.GUTCHECK_MVN && tryBin(process.env.GUTCHECK_MVN)) return { cmd: process.env.GUTCHECK_MVN, pre: [] };
  if (tryBin('mvn')) return { cmd: 'mvn', pre: [] };
  const wrapper = join(dir, '.mvn', 'wrapper', 'maven-wrapper.jar');
  if (j && existsSync(wrapper)) return { cmd: j, pre: ['-cp', wrapper, 'org.apache.maven.wrapper.MavenWrapperMain'] };
  return null;
}
// Nearest ancestor dir (at or above the test file, never above the repo root `dir`) containing pom.xml —
// the Maven module that OWNS the test, mirroring gradleTaskInfo's module resolution for Gradle. Maven
// modules aren't guaranteed to align with a `/src/` path segment the way Gradle's do, so this walks the
// real pom.xml files on disk instead of a string convention. Single-module repos (root itself is the only
// pom.xml) resolve to `dir` — either via the loop finding root's own pom.xml, or via the `return dir`
// fallback when it doesn't (e.g. a trailing separator on `dir` shortens the walked-up root string below
// `dir.length` by exactly the separator's one char, so the loop exits one step early) — both give the SAME
// directory, so the rewire is behavior-neutral for every single-module repo that worked under v1. The
// `d.length >= dir.length` guard can never straddle `dir`: each dirname() step removes a whole path
// segment (name + separator, ≥2 chars) except the very last step onto `dir` itself, so the only length
// that can fall short of `dir.length` by a single char is `dir` with its separator stripped — never a
// directory above it. Verified for exactly this (nested modules, no-pom fallback, a decoy pom.xml planted
// ABOVE the root, and a trailing-separator `dir`) in test/maven-runner.test.mjs.
export function mavenModuleDir(dir, testFileRel) {
  let d = dirname(join(dir, testFileRel));
  while (d.length >= dir.length) {
    if (existsSync(join(d, 'pom.xml'))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return dir;
}

function walk(dir, acc = []) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) { if (SKIP_DIRS.has(e.name)) continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); }
  return acc;
}
// Dir-boundary clauses accept EITHER separator ([\\/]) — walk()'s raw absolute paths carry the native
// separator (backslash on win32, never normalized to POSIX; only a created `rel` is), so this must
// tolerate both regardless of which platform runs it (verified unix-side with literal backslash
// fixtures — see test/prove.test.mjs).
export const isTestPath = (f) => (/\.(test|spec)\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f))
  || (/(^|[\\/])(test_[^\\/]+|[^\\/]+_test)\.py$/.test(f))
  || (/[\\/](tests?|__tests__|spec)[\\/]/.test(f) && (/\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f) || /\.py$/.test(f)))
  // JVM: *Test/*Tests/*Spec/*IT by basename convention, or anything under a src/test or src/androidTest
  // tree — mirrors checker/standalone.mjs:38-39's discovery rule so the probe and the lint checker agree
  // on what counts as a test file.
  || (/(Test|Tests|Spec|IT)\.(kt|java)$/.test(f))
  || (/[\\/]src[\\/](test|androidTest)[\\/]/.test(f) && /\.(kt|java)$/.test(f));

// ---- diff scope: the absolute paths changed since a git ref (tracked diff ∪ untracked), or null if the
// ref/repo can't be resolved. A new test file the agent just wrote is untracked, so both are unioned. ----
export function changedFilesSince(dir, ref) {
  const run = (cmd) => { try { return execSync(cmd, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; } };
  const root = run('git rev-parse --show-toplevel');
  if (root == null) return null;
  const repoRoot = root.trim();
  const tracked = run(`git diff --name-only ${JSON.stringify(ref)} --`);
  if (tracked == null) return null; // bad ref
  const untracked = run('git ls-files --others --exclude-standard') || '';
  const set = new Set();
  for (const blk of [tracked, untracked]) for (const ln of blk.split('\n')) { const p = ln.trim(); if (p) set.add(canonKey(resolve(repoRoot, p))); }
  return set;
}

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
// Resolve the gradle task + results dir for the module owning a test file. The module dir is the path
// segment before `/src/` (''=root). A module applying AGP (com.android.application|library) runs local
// unit tests via testDebugUnitTest with XML under <module>/build/test-results/testDebugUnitTest/; a plain
// JVM (kotlin("jvm")/java) module uses `test`. Task paths are module-qualified (`:core:contract:test`)
// so a multi-module build runs (and reports) only the owning module. Gradle auto-generates `clean<Task>`.
// JVM source-set gate: which src/<set>/ test files the probe can actually run. `test` (plain JVM +
// Android local units) and `jvmTest` (KMP's JVM target) are supported. `androidTest` is INSTRUMENTED —
// device/emulator, minutes per mutant, outside the one-fast-rerun model. Every other *Test source set
// (commonTest, iosTest, …) has no supported single-target task. Returns the skip reason, or null for a
// supported (or non-source-set) path. The prove loop applies this PRE-baseline: zero gradle runs, an
// explicit reason per block, never an inconclusive noise row (measured before the gate: gamedge burned 9
// baselines on androidTest files, cc-pocket 8 on KMP sets).
// A module demonstrably has a KMP JVM target when it declares `jvm()` / `jvm {` in its build file
// (line-anchored — the kotlin{} DSL indents it) or carries a src/jvmTest dir. Used to decide whether
// commonTest maps to the jvmTest task (below) or fails closed.
function kmpJvmTargetExists(dir, relPosix) {
  const i = relPosix.indexOf('/src/');
  const moduleDir = i > 0 ? relPosix.slice(0, i) : '';
  if (existsSync(join(dir, moduleDir, 'src', 'jvmTest'))) return true;
  for (const b of ['build.gradle.kts', 'build.gradle']) {
    try { if (/^\s*jvm\s*[({]/m.test(readFileSync(join(dir, moduleDir, b), 'utf8'))) return true; } catch {}
  }
  return false;
}

export function jvmSourceSetGate(relPosix, dir = null) {
  const m = /(?:^|\/)src\/([A-Za-z0-9]+)\//.exec(relPosix);
  if (!m) return null;
  const set = m[1];
  if (set === 'test' || set === 'jvmTest') return null;
  if (set === 'androidTest') return 'instrumented-test';
  // commonTest EXECUTES under the module's jvmTest task when a JVM target exists (KMP compiles common
  // test sources into every target's test compilation) — the dominant idiom keeps shared tests here
  // (wild specimen cc-pocket). Without dir context or without a JVM target: fail closed.
  if (set === 'commonTest') return (dir && kmpJvmTargetExists(dir, relPosix)) ? null : 'unsupported-source-set';
  if (/Test$/.test(set)) return 'unsupported-source-set';
  return null;
}

export function gradleTaskInfo(dir, testFileRel) {
  const rel = toPosix(testFileRel);
  const i = rel.indexOf('/src/');
  const moduleDir = i > 0 ? rel.slice(0, i) : '';
  // KMP: a src/jvmTest/ file runs via the module's `jvmTest` task (results at build/test-results/jvmTest,
  // same JUnit XML the correctness spine reads). Checked BEFORE android detection — a KMP module with an
  // android target still runs its JVM-target tests through jvmTest, never testDebugUnitTest (wild
  // specimen: heypandax/cc-pocket :protocol, where `test` 0-matched and burned a baseline per block).
  // Anchored like jvmSourceSetGate's regex: a ROOT-module KMP rel has no leading slash
  // (src/jvmTest/..., wild specimen sunny-chung/giant-log-viewer), so a bare '/src/jvmTest/'
  // substring match misses it and falls through to the nonexistent `test` task.
  if (/(?:^|\/)src\/jvmTest\//.test(rel) || (/(?:^|\/)src\/commonTest\//.test(rel) && kmpJvmTargetExists(dir, rel))) {
    const prefix = moduleDir ? ':' + moduleDir.split('/').join(':') + ':' : '';
    return { unitTask: 'jvmTest', taskPath: prefix + 'jvmTest', cleanPath: prefix + 'cleanJvmTest', resultsDir: join(moduleDir, 'build', 'test-results', 'jvmTest') };
  }
  let isAndroid = false;
  for (const b of ['build.gradle.kts', 'build.gradle']) {
    const p = join(dir, moduleDir, b);
    // AGP detection, two signals: the literal plugin id (`id("com.android.application")` / groovy apply) OR —
    // the modern version-catalog idiom (`alias(libs.plugins.android.application)`, wild specimen
    // lnxgod/friendorfoe) where the literal id lives only in libs.versions.toml — the mandatory top-level
    // `android { }` extension block, which every AGP module carries regardless of declaration style. The
    // block scan is LINE-ANCHORED so `android` in a comment (`// android {`) or an indented string can't
    // flip a plain-JVM module (a wrong android flag costs only a 0-match → inconclusive — precision-safe —
    // but detection stays honest). Known residual: convention-plugin indirection (module has neither the id
    // nor its own android block) still falls back to `test` → the AGP aggregate task rejects `--tests` →
    // 0p/0f → inconclusive; never a wrong verdict.
    try {
      const text = readFileSync(p, 'utf8');
      if (/com\.android\.(application|library)/.test(text) || /^\s*android\s*\{/m.test(text)) { isAndroid = true; break; }
    } catch {}
  }
  const unitTask = isAndroid ? 'testDebugUnitTest' : 'test';
  const cap = unitTask[0].toUpperCase() + unitTask.slice(1);
  const prefix = moduleDir ? ':' + moduleDir.split('/').join(':') + ':' : '';
  return {
    unitTask,
    taskPath: prefix + unitTask,
    cleanPath: prefix + 'clean' + cap,
    resultsDir: join(moduleDir, 'build', 'test-results', unitTask),
  };
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
// CAVEAT on qualifiedName below).
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
    //   `--no-watch-fs` is a hard CLI parse error on Gradle < 6.7 — see mainCompileExecuted below for the
    //   belt-and-suspenders evidence gate that catches the race even where this flag can't (an old
    //   Gradle that ignores it).
    // NO --build-cache (removed, same field report): it made the race's failure mode WORSE, not better.
    // The local build cache is content-addressable and LOCATION-independent by design — that's its whole
    // point — so it satisfies a task from ANY prior build of byte-identical content, including a totally
    // separate probe invocation against a different temp work copy (e.g. the Stop hook re-firing on an
    // unchanged diff, or a user re-running gutcheck). A within-one-run repeat gut of the same fn (two
    // test blocks covering it) is still fast via Gradle's own always-on incremental build and is proven
    // safe by the lastCompiled memo below (this run watched it compile); --build-cache's only
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
// (see the runOne call site and the MASKING GUARD comment on DESCRIBE_HEAD_RE above for the two ways
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
// {passed, failed} from the JUnit XML Gradle writes to build/test-results/<task>/TEST-*.xml — the
// framework-agnostic signal (JUnit4/5/kotlin.test all emit it). Gradle's console carries NO pass/fail
// count, so this is the gradle analog of parseRun. Sums every <testsuite> opening tag's attributes
// (attr order-independent; "testsuite" contains "tests" but the required `="` disambiguates). A missing
// dir / no files → {0,0} → prove()'s baseline gate routes to inconclusive (never a stale or wrong read).
export function parseGradleResults(dir) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.startsWith('TEST-') && f.endsWith('.xml')); }
  catch { return { passed: 0, failed: 0 }; }
  const attr = (tag, name) => { const m = new RegExp(name + '="(\\d+)"').exec(tag); return m ? +m[1] : 0; };
  let tests = 0, skipped = 0, failures = 0, errors = 0;
  for (const f of files) {
    let xml; try { xml = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const tm of xml.matchAll(/<testsuite\b[^>]*>/g)) {
      tests += attr(tm[0], 'tests'); skipped += attr(tm[0], 'skipped');
      failures += attr(tm[0], 'failures'); errors += attr(tm[0], 'errors');
    }
  }
  return { passed: tests - skipped - failures - errors, failed: failures + errors };
}
// Field report 2026-07-18 (false-positive hollow, AcoustiQ): `compiled === false` and an empty {0,0}
// result are both already gated (see the callers below), but a THIRD shape leaked one past them — a
// gradle daemon vfs-watch race can miss the probe's out-of-band mutant write, so the main-source compile
// task goes UP-TO-DATE despite changed source, the test reruns against STALE (unmutated) classes, and
// the resulting fresh-green XML reads as a genuine survivor. A mutant edit changes MAIN source, so a
// valid mutant run can never leave every main-source compile task labeled (UP-TO-DATE/FROM-CACHE/
// NO-SOURCE/SKIPPED) — that combination proves the daemon built stale sources: the green result is void,
// and treating it as a survivor mints a false hollow. Test-source compile tasks (Gradle's own
// `compileTestKotlin`/`compileTestJava`, AGP's `compileDebugUnitTestKotlin`/`compileDebugAndroidTestKotlin`)
// legitimately stay labeled on every mutant run (the mutant never touches test sources) — excluded by a
// broad `Test` substring match (covers both naming conventions; a false EXCLUDE only makes this gate
// MORE conservative, never less, since excluding a real candidate just costs reach, never precision).
// The substring check is scoped to the TASK-NAME segment only (after the LAST `:`), never the full
// module-qualified path — a module literally named `integration-test`/`apptest`/`test` (real, reviewer-
// verified shapes) would otherwise have its OWN main compile task (`:integration-test:compileKotlin`)
// wrongly excluded by "test" appearing in the MODULE name, downgrading a genuine hollow in that module to
// ungutable — reach lost for a false reason, never a precision gain.
// Gradle's plain console prints one line per task: `> Task :app:compileDebugKotlin` — BARE, meaning the
// task actually EXECUTED just now — or `> Task :app:compileDebugKotlin UP-TO-DATE` (also FROM-CACHE/
// NO-SOURCE/SKIPPED) — LABELED, meaning gradle reused a prior outcome. Only a bare non-test compile line
// counts as fresh evidence the compiler saw the CURRENT (mutated) bytes; multi-module runs are satisfied
// by the mutated module alone (an unmutated sibling staying UP-TO-DATE is correct and must not veto).
export function mainCompileExecuted(out) {
  for (const m of out.matchAll(/^> Task :(\S*)(?:\s+(\S+))?\s*$/gm)) {
    const path = m[1]; const label = m[2] || '';
    const taskName = path.slice(path.lastIndexOf(':') + 1); // segment after the LAST colon — module path segments (however "test"-shaped) must never feed the checks below
    if (!/compile\w*(Kotlin|Java)/i.test(taskName)) continue;
    if (/test/i.test(taskName)) continue;
    if (label === '') return true; // bare line = executed just now
  }
  return false;
}
// The gradle-only stale-build veto decision (field report 2026-07-18), extracted into its own pure
// function so it can be unit-tested without a live gradle spawn (mirrors mainCompileExecuted/mavenCompiled
// above). `r` is a runOne-shaped result ({passed, failed, out}); `sutRel` + `content` identify WHICH
// mutant is under evidence; `lastCompiled` is a Map, one entry per sut file, of the last mutant content
// this run itself watched compile fresh (see its own header comment at the prove() declaration site for
// why "last", not "ever"). The recording (mainCompileExecuted -> lastCompiled.set) happens FIRST and
// UNCONDITIONALLY on every genuinely fresh compile, red or green — a real caught result (e.g.
// testScoreBound gutting `score`) is just as valid a "this run built this exact content" receipt as a
// survivor is, and a LATER block gutting the SAME fn with the SAME sentinel (e.g. testScoreOneSided,
// deterministically identical bytes) must be able to recognize that reuse even though its own compile
// task reads UP-TO-DATE. Short-circuiting recording on the red path was a real regression caught by the
// live jvm-e2e relational-one-sided-tier suite during development — recording must never depend on the
// pass/fail branch below. Contract: a RED result (r.failed > 0) is always valid — a stale build can only
// reuse already-passing original code, so it can only ever fake a GREEN, never a false red. A result that
// isn't a survivor at all (passed === 0 too — a 0/0 non-run) is likewise never this function's concern
// (every caller only reaches it once a survivor is already established) and reads as valid so a caller
// applying it unconditionally can't misfire. A GREEN (passed > 0) result is valid exactly when either the
// compile task actually executed (mainCompileExecuted) or `lastCompiled` already shows this EXACT content
// as the last thing this run verified compiling for this file (Gradle correctly, non-racily, reusing its
// own recent work — possibly recorded by a RED block moments ago). Anything else — labeled, and not
// matching the last verified content — is exactly the field report's shape: void.
export function survivorEvidenceValid(r, sutRel, content, lastCompiled) {
  const executed = mainCompileExecuted(r.out);
  if (executed) lastCompiled.set(sutRel, content);
  if (r.failed > 0 || r.passed === 0) return true;
  return executed || lastCompiled.get(sutRel) === content;
}
// Maven's compile-fail signal, DISTINCT from a failing test — verified live on both real shapes (see
// test/fixtures/runner-output/maven-{compile,test}-fail.txt): a non-compiling mutant prints "[ERROR]
// COMPILATION ERROR :" (and never reaches surefire, so no fresh XML exists — parseGradleResults reads
// {0,0}); a FAILING TEST prints "Tests run: N, Failures: M" + BUILD FAILURE but NEVER COMPILATION ERROR.
// Both print BUILD FAILURE, so that string alone can't tell them apart — COMPILATION ERROR is the only
// safe discriminator. Exported as its own pure function (unlike gradle's inline regex in runOne) because
// maven has no CI binary at all — this is the only CI-safe coverage for the false-verdict-critical
// classification (see test/maven-runner.test.mjs, driven off the captured fixture text above).
export function mavenCompiled(out) { return !/COMPILATION ERROR/.test(out); }
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

// ---- block parsing (JS/TS it()/test(), and pytest def test_*) ----
function balancedFrom(s, openParen) { let d = 0, k = openParen; for (; k < s.length; k++) { const c = s[k]; if (c === '(') d++; else if (c === ')') { d--; if (!d) { k++; break; } } } return { arg: s.slice(openParen + 1, k - 1), end: k }; }
// `{`-balanced analog of balancedFrom: the text inside the brace pair opening at body[idx], or null
// when unbalanced. Callers pass MASKED text (codeOnly), so brace characters inside strings — including
// Kotlin string templates — are already blanked and cannot desynchronize the depth count.
export function braceArgFrom(body, idx) {
  let depth = 0;
  for (let i = idx; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { depth--; if (depth === 0) return body.slice(idx + 1, i); }
  }
  return null;
}
// The receiver expression immediately preceding `end` (the index of the '.' before `should`): an identifier /
// member chain, with balanced call/index groups consumed backward. Returns '' if none.
function receiverBefore(body, end) {
  let i = end - 1;
  while (i >= 0 && /\s/.test(body[i])) i--;
  const stop = i + 1;
  for (; i >= 0; ) {
    const c = body[i];
    if (c === ')' || c === ']') { const open = c === ')' ? '(' : '['; let d = 0;
      for (; i >= 0; i--) { const b = body[i]; if (b === c) d++; else if (b === open && --d === 0) break; }
      i--; continue; }
    if (/[A-Za-z0-9_$.]/.test(c)) { i--; continue; }
    break;
  }
  return body.slice(i + 1, stop).trim();
}
// Number of top-level (comma-separated, bracket-depth-0) arguments in a parenthesized arg-list's inner text.
function topLevelArgCount(s) {
  let depth = 0, n = s.trim() ? 1 : 0;
  for (let i = 0; i < s.length; i++) { const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) n++; }
  return n;
}
// Escape-aware quoted-string scan starting at the position of the OPENING quote character itself
// (code[qPos] is one of ' " `). A backslash always escapes the NEXT character — it can never terminate
// or (for a template literal) open interpolation — matching JS string-literal grammar. This replaces a
// naive `(['"`])(.*?)\1` backreference: that pattern DOES eventually backtrack past an escaped quote
// onto the real closing quote (verified empirically — it does not truncate the MATCH), but the text it
// captures still carries the raw backslash (`caught\'s edge`), which then never equals the runner's
// actual (unescaped) runtime title (`caught's edge`) — a silent selection mismatch (0 tests matched, not
// a crash) that misreads as HOLLOW (see test/prove.test.mjs for
// the real incident this regex produced). For a template literal, also tracks whether an UNESCAPED `${`
// appears — such a title is computed at runtime and can never be captured (see unescapeTitle/scanTitledCalls).
// Returns `{ raw, end, dynamic }` (end = index of the closing quote char) or null if the string never
// closes (malformed/truncated source — the caller skips this occurrence rather than throwing).
function scanQuoted(code, qPos) {
  const q = code[qPos];
  let dynamic = false;
  for (let i = qPos + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') { i++; continue; } // escaped char: never a terminator, never re-examined as a delimiter
    if (q === '`' && c === '$' && code[i + 1] === '{') dynamic = true;
    if (c === q) return { raw: code.slice(qPos + 1, i), end: i, dynamic };
  }
  return null;
}
// Unescape a captured quoted-string's RAW source text (backslashes intact) into the runtime value a
// runner actually reports as the test/describe title — the value prove()'s selection must match against.
// Handles the escapes a hand-written title plausibly contains (\\, \', \", \`, \n, \r, \t, \b, \f, \v, \0,
// \xHH, \uHHHH, \u{H+}); any other backslash-char pair is a JS "identity escape" (backslash dropped, char
// kept — covers a stray \$ in a non-interpolated template literal, \/, etc). Never called on a dynamic title.
function unescapeTitle(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const n = raw[++i];
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (n in simple) { out += simple[n]; continue; }
    if (n === 'x' && /^[0-9a-fA-F]{2}/.test(raw.slice(i + 1))) { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (n === 'u' && raw[i + 1] === '{') {
      const close = raw.indexOf('}', i + 2);
      if (close !== -1) { out += String.fromCodePoint(parseInt(raw.slice(i + 2, close), 16)); i = close; continue; }
    }
    if (n === 'u' && /^[0-9a-fA-F]{4}/.test(raw.slice(i + 1))) { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; continue; }
    out += n === undefined ? '' : n; // identity escape (or a trailing lone backslash — drop it, no crash)
  }
  return out;
}
// Escape-aware scan for the shared `<keyword>(<quote><title><same-quote>, <arrow-or-function> {` call
// shape — test/it AND describe/suite are the SAME grammar, differing only in the keyword alternation, so
// both parseBlocks call sites share this one title-capture path instead of two regexes drifting apart.
// `headRe` matches only the title-agnostic HEAD (keyword + optional modifier + `(` + the opening quote
// character) — the quote's true close is then found via scanQuoted (escape-aware), never a backreference,
// so an escaped quote can never truncate or corrupt the capture. Returns `[{ index, title, dynamic,
// openBrace }]`: `index` is the head match start, `title` is the unescaped runtime string (or, when
// `dynamic`, the raw literal source text — display-only, since a dynamic title has no static runtime
// value), and `openBrace` is the index of the call body's `{`.
function scanTitledCalls(code, headRe) {
  const AFTER_TITLE_RE = /^\s*,\s*(?:async\s*)?(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\s*\*?\s*[A-Za-z_$]*\s*\([^)]*\))\s*\{/;
  const out = [];
  for (const hm of code.matchAll(headRe)) {
    const qPos = hm.index + hm[0].length - 1; // index of the opening quote character itself
    const sq = scanQuoted(code, qPos);
    if (!sq) continue; // unterminated string literal at this position — not parseable JS here, skip
    const rest = AFTER_TITLE_RE.exec(code.slice(sq.end + 1));
    if (!rest) continue; // not actually followed by `, <fn> {` — this head match isn't a real titled call
    out.push({ index: hm.index, title: sq.dynamic ? sq.raw : unescapeTitle(sq.raw), dynamic: sq.dynamic, openBrace: sq.end + rest[0].length });
  }
  return out;
}
export function parseBlocks(code, lang) {
  const out = [];
  if (lang === 'python') {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)def\s+(test_[A-Za-z0-9_]*)\s*\(/.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length; const body = [];
      for (let j = i + 1; j < lines.length; j++) { const ln = lines[j]; if (ln.trim() !== '' && ln.length - ln.trimStart().length <= indent) break; body.push(ln); }
      out.push({ name: m[2], body: body.join('\n'), line: i + 1 });
    }
    return out;
  }
  if (lang === 'kotlin' || lang === 'java') {
    // JVM branch — @Test-annotated methods (Kotlin `fun`, Java return-typed method), FQN'd as
    // `pkg.Outer$Inner.method` (the exact Gradle `--tests` selector; no `path` array needed — FQNs don't
    // collide within a module). Brace-scoped class tracker mirrors the describe-scope idiom below,
    // keyed on `class NAME {` instead of `describe(...)`. @ParameterizedTest/@TestFactory carry a
    // different annotation, so they never match the @Test regex — never emitted. @Nested inner-class
    // @Tests ARE emitted, FQN'd with the full '$'-joined class chain (see classChain below).
    const masked = codeOnly(code, lang);
    // For all brace/paren/`class`-keyword SCANNING (never for capturing the @Test name), also blank the
    // INTERIOR of Kotlin backtick identifiers. codeOnly preserves backtick names (they are identifiers,
    // not string literals), so a `{`/`}`/`(`/`)` or the word `class` inside a backtick name
    // (`fun `handles a } in class X`()`, common in linter/parser test suites) would either truncate the
    // class brace-walk or mint a PHANTOM class → a wrong FQN → potentially a WRONG-but-valid `--tests`
    // selector → a false verdict. Blanking is length-preserving (interior → spaces, both delimiters kept),
    // so every index computed against maskedB stays aligned with `code` AND with `masked` (which TEST_RE
    // still runs over to capture names). Java has no backtick identifiers → this is a no-op there.
    const maskedB = masked.replace(/`[^`\r\n]*`/g, (m) => '`' + ' '.repeat(m.length - 2) + '`');
    const pkgMatch = /(?:^|\n)\s*package\s+([\w.]+)\s*;?/.exec(masked);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    // class-scope events: {name, start, end} bound the class BODY (between its braces) — a @Test
    // match's position falls inside iff its class is the (innermost, smallest-span) enclosing one.
    // The scan from `class NAME` to its opening `{` tracks paren depth so a primary-constructor arg
    // list / supertype-constructor call (`class Foo(x: Int) : Base(x) {`) is skipped rather than
    // mistaken for the class body's brace. Runs over maskedB so a backtick name can neither mint a
    // phantom `class` match nor unbalance the brace walk.
    // A class name is a plain identifier OR (Kotlin) a backtick-quoted name (`class `Weird Name``, rare but
    // legal). Both are scanned over maskedB — its blanked backtick INTERIORS mean a `class`/backtick sitting
    // INSIDE a backtick METHOD name mints no phantom class. For the backtick form, maskedB shows only spaces
    // between the delimiters, so the name is recovered from `masked` (backtick idents preserved there) at the
    // aligned offsets. Recognizing it closes a logged residual: an invisible backtick class shortened the
    // $-chain of its @Tests → a WRONG (mis-selecting) `--tests` FQN → a false verdict. Java has no backtick
    // class form, so its regex is unchanged (byte-identical).
    const CLASS_RE = lang === 'kotlin'
      ? /\bclass\s+(?:([A-Za-z_$][\w$]*)|`([^`\r\n]*)`)/g
      : /\bclass\s+([A-Za-z_$][\w$]*)/g;
    const classEvents = [];
    for (const cm of maskedB.matchAll(CLASS_RE)) {
      let className = cm[1];
      if (className === undefined) { // backtick class — recover the verbatim name from `masked`
        const open = cm.index + cm[0].indexOf('`');
        const close = cm.index + cm[0].lastIndexOf('`');
        className = masked.slice(open + 1, close);
      }
      let i = cm.index + cm[0].length, depth = 0, openBrace = -1;
      for (; i < maskedB.length; i++) {
        const c = maskedB[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '{' && depth === 0) { openBrace = i; break; }
        else if (c === ';' && depth === 0) break; // forward decl / no body — no scope to open
      }
      if (openBrace === -1) continue;
      let d = 0, k = openBrace;
      for (; k < maskedB.length; k++) { const ch = maskedB[k]; if (ch === '{') d++; else if (ch === '}') { d--; if (!d) { k++; break; } } }
      classEvents.push({ name: className, start: openBrace + 1, end: k - 1 });
    }
    // The FULL enclosing-class chain at a position — every class whose brace span contains it, ordered
    // OUTERMOST→innermost (largest span first). Joined with '$' this is the JVM binary class name Gradle's
    // `--tests` selector expects for @Nested inner classes (`pkg.Outer$Inner.method`, verified live). This
    // supersedes the earlier nested-class SKIP: formerly only a bare `Inner.method` FQN was computable
    // (which mis-selected), so nested @Tests were dropped; now the whole chain resolves them. Spans are
    // properly brace-nested (never partially overlapping), so span-size ordering equals nesting order. A
    // corrupted span (e.g. an unbalanced brace inside a backtick name) can only SHRINK the chain → a
    // non-existent class path → Gradle 0-match → inconclusive; never a wrong-but-valid class (nesting is
    // unique). `object`/companion levels are not tracked (regex is `class`-only) → their @Tests, if any,
    // get a short chain → 0-match → inconclusive (safe; @Test-in-object is not a JUnit idiom).
    const classChain = (pos) => classEvents
      .filter((ce) => pos >= ce.start && pos < ce.end)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))
      .map((ce) => ce.name);
    // @Test [other annotations] [modifiers] fun name( — Kotlin; @Test [other annotations] [modifiers]
    // ReturnType name( — Java (no `fun` keyword; the return type is mandatory, so the alternation is
    // language-keyed rather than shared). Both stop AT the method's open paren. Kotlin names come in two
    // shapes: a plain identifier (group 1) OR a backtick-quoted name `does X` (group 2) — the latter is
    // idiomatic-dominant in real Kotlin suites and its INNER text (no backticks) is both the JVM method
    // name and the exact Gradle `--tests` selector, so it feeds the FQN verbatim, spaces and all. The
    // backtick class `[^`\r\n]+` excludes the delimiter and newlines (a backtick name is single-line);
    // codeOnly keeps backtick identifiers intact (they are NOT string literals in the Kotlin grammar), so
    // the match runs correctly against the masked text. Java has no backtick form — group 2 is Kotlin-only.
    const TEST_RE = lang === 'kotlin'
      ? /@Test\b(?:\s*\([^)]*\))?\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:(?:public|private|internal|protected|open|override|abstract|final|suspend|inline|infix|operator|external|actual|expect)\s+)*fun\s+(?:([A-Za-z_$][\w$]*)|`([^`\r\n]+)`)\s*\(/g
      : /@Test\b(?:\s*\([^)]*\))?\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|synchronized|abstract)\s+)*(?:[A-Za-z_$][\w$]*(?:<[^>]*>)?(?:\[\])?\s+)+([A-Za-z_$][\w$]*)\s*\(/g;
    for (const tm of masked.matchAll(TEST_RE)) {
      // tm[0] ends right after the method name's '(' (paren depth already 1) — balance to its close,
      // then locate the body. All brace/paren counting runs over maskedB (backtick interiors blanked) so
      // a backtick param or a backtick local (`val `weird }` = …`) inside the body cannot unbalance the
      // walk; positions align with masked.
      let i = tm.index + tm[0].length, depth = 1;
      for (; i < maskedB.length && depth > 0; i++) { const c = maskedB[i]; if (c === '(') depth++; else if (c === ')') depth--; }
      let bodyStart, bodyEnd;
      if (lang === 'kotlin') {
        // Kotlin: block- AND expression-bodied (`fun x() = expr`) methods, via the SAME scan gut-time
        // (grossBreak/passthroughBreak) uses to find a named function's body — so an expression-bodied
        // @Test can never be attributed a sibling's body here (was Bug B: the old brace-only scan below
        // skipped an expression-bodied test with no braces of its own straight to the NEXT test's
        // `{...}`, or — with no later brace anywhere in the file — silently dropped it).
        const site = locateKotlinSite(code, maskedB, i, null);
        if (!site) continue; // abstract/expect-only signature, or no locatable body — nothing to probe
        bodyStart = site.start; bodyEnd = site.end;
      } else {
        // Java: always block-bodied (no expression-bodied methods in the language) — unchanged scan.
        let openBrace = -1;
        for (; i < maskedB.length; i++) { if (maskedB[i] === '{') { openBrace = i; break; } if (maskedB[i] === ';') break; }
        if (openBrace === -1) continue; // abstract/expect-only signature — no body, nothing to probe
        let d = 0, k = openBrace;
        for (; k < maskedB.length; k++) { const c = maskedB[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { k++; break; } } }
        bodyStart = openBrace + 1; bodyEnd = k - 1;
      }
      const classPath = classChain(tm.index).join('$'); // '' at file top level; 'Outer$Inner' when nested
      // Fail closed on a class-less JVM @Test: a real JUnit @Test is ALWAYS inside a class, so an empty
      // classPath means the class brace-walk was corrupted (e.g. a masking artifact truncated the span).
      // Emitting `pkg.method` then risks a bare-CLASS `--tests` pattern: if `method` collides with a real
      // top-level class name, Gradle runs that whole class (baseline green) while the block mutates an
      // unrelated SUT → the mutant "survives" → a FALSE HOLLOW (adversarial-review Case E). Skip it.
      if (!classPath) continue;
      // tm[1] = plain identifier; tm[2] = Kotlin backtick-name inner text (java has no group 2 → undefined).
      const method = tm[1] || tm[2];
      // Gradle's `--tests` filter treats `*` as a WILDCARD (empirically: `Class.parses*` selected 3
      // tests). A backtick name — method OR class (`class `a * b``) — may legally contain `*`; emitting it
      // would let the selector match SIBLING tests, so a sibling's mutant-kill could mask this block's own
      // hollow → a false PROVEN. No gradle escape exists for `*`, so fail closed on a `*` anywhere in the
      // selector — don't emit a block we cannot uniquely select. (Plain identifiers and Java names never
      // contain `*`, so this only ever affects Kotlin backtick method or class names.)
      if (classPath.includes('*') || method.includes('*')) continue;
      const name = [pkg, classPath, method].filter(Boolean).join('.');
      out.push({ name, body: code.slice(bodyStart, bodyEnd), line: code.slice(0, tm.index).split('\n').length });
    }
    return out;
  }
  const HEAD_RE = /\b(?:it|test)(?:\.(?:only|skip|concurrent|todo|failing))?\s*\(\s*(?:['"`])/g;
  // describe()/suite() scope tracker (same brace-balance idiom as the it/test body extraction below,
  // just applied to the ENCLOSING call instead of the probed block itself) — gives each it/test block a
  // `path: [describe titles...]`, outermost first, so a bare-title collision can be qualified before
  // failing closed (see qualifiedName/residualAmbiguous). Built as a position-sorted event list (describe
  // scopes + test blocks) walked ONCE with a stack: a describe event pushes {title, end}; a test event
  // first pops any describe whose extent already closed (stack top's end <= this event's position), then
  // reads the remaining stack as its path.
  // MASKING GUARD: a describe-shaped token inside a string or comment must open no scope — a phantom
  // scope leaks a bogus path onto the NEXT real block, corrupting its qualified name (and a corrupted
  // selector can zero-match: on node, a zero-match run's only green point is the file wrapper —
  // nodeEffectiveCounts (see runOne, near parseRun) now discounts that wrapper-only pass to 0p/0f at the
  // runtime layer, so a corrupted pattern routes to inconclusive rather than minting a false-HOLLOW
  // verdict; this guard still matters for keeping the qualified name itself correct). The regex can't simply run over the
  // codeOnly-masked text: codeOnly blanks string interiors AND their quote delimiters, and a real
  // describe's own title IS a string literal, so no real describe would match there. Instead each RAW
  // match is validated positionally: codeOnly is length-preserving (masked regions become spaces, every
  // offset untouched), so a match is real iff the masked text still carries its keyword at the same
  // index; a match inside a string/comment sits in a blanked region and fails the check. Phantom
  // it()/test() tokens inside strings remain the pre-existing (pre-describe-tracking) imprecision class —
  // they mint a bogus BLOCK (skipped: no-pin) but never a bogus PATH on a real sibling.
  const DESCRIBE_HEAD_RE = /\b(?:describe|suite)(?:\.(?:only|skip|concurrent|todo|failing))?\s*\(\s*(?:['"`])/g;
  const maskedCode = codeOnly(code, 'typescript');
  const events = [];
  // Both brace-depth walks below count on `maskedCode`, NOT raw `code`: a stray `{`/`}` embedded inside a
  // string, comment, or (critically) a regex literal — e.g. `/foo\{/`, an escaped brace with no matching
  // closer in that literal — is invisible to a raw-text counter, which overshoots the block's real closing
  // `}` and keeps consuming source until enough LATER `}` characters (borrowed from subsequent sibling
  // blocks) coincidentally rebalance it back to 0. The earlier block's captured body then bleeds into one
  // or more siblings, misattributing a SUT call to the wrong block (confirmatory audit batch B, row 9: a
  // static-only test's swallowed span absorbed a later sibling's real SUT call, producing a false HOLLOW
  // on the block that never even invoked the mutated function). `maskedCode` is length-preserving (codeOnly
  // blanks masked regions to spaces without shifting offsets), so indices below stay valid against `code`.
  for (const dc of scanTitledCalls(code, DESCRIBE_HEAD_RE)) {
    if (!(maskedCode.startsWith('describe', dc.index) || maskedCode.startsWith('suite', dc.index))) continue; // blanked region → phantom
    let d = 0, k = dc.openBrace; for (; k < code.length; k++) { const c = maskedCode[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { k++; break; } } }
    events.push({ kind: 'describe', pos: dc.openBrace + 1, end: k - 1, title: dc.title });
  }
  // Same phantom guard as describe/suite above, and now load-bearing rather than incidental: once the
  // depth walk below counts on `maskedCode`, a phantom it()/test() head-matched INSIDE a string literal
  // (a common fixture-as-string-data pattern this very suite uses, e.g. `"it('a', () => { f(); });"` as a
  // parseBlocks() test input) has its own self-contained braces blanked away too — with no local pair to
  // balance, the walk from its openBrace no longer finds ANY '{' to increment on and instead runs straight
  // into a REAL sibling's closing '}', decrementing depth negative and overshooting just as badly as the
  // regex-literal case this fix targets. Filtering the phantom out here (never even a mint-a-bogus-block
  // event) is the robust form of the old comment's "mints a bogus BLOCK but stays harmless" invariant,
  // which previously held only by the accident of raw-text counting also (coincidentally) closing a
  // phantom's own local brace pair.
  for (const tc of scanTitledCalls(code, HEAD_RE)) {
    if (!(maskedCode.startsWith('it', tc.index) || maskedCode.startsWith('test', tc.index))) continue; // blanked region → phantom
    events.push({ kind: 'test', pos: tc.index, tc });
  }
  events.sort((a, b) => a.pos - b.pos);
  const stack = [];
  for (const e of events) {
    while (stack.length && stack[stack.length - 1].end <= e.pos) stack.pop();
    if (e.kind === 'describe') { stack.push(e); continue; }
    const tc = e.tc;
    let d = 0, k = tc.openBrace; for (; k < code.length; k++) { const c = maskedCode[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { k++; break; } } }
    // A DYNAMIC title (template-literal interpolation — `` `user ${id}` ``) has no statically-knowable
    // runtime value: `name` still carries the raw literal text for display (--explain, receipts), but
    // `dynamicTitle: true` routes the block to an unconditional skip (why: 'dynamic-title') in prove()'s
    // per-block loop, before the pin/eligibility gates — never fed to a runner as a selector.
    out.push({ name: tc.title, dynamicTitle: tc.dynamic, body: code.slice(tc.openBrace + 1, k - 1), line: code.slice(0, tc.index).split('\n').length, path: stack.map((s) => s.title) });
  }
  return out;
}

// ---- fail-closed ambiguity detection: could a runner's single-test selection for THIS block's bare
// title also sweep in a sibling block in the same file? testCmdFor selects by bare title (never describe-
// qualified — see below), so two same-titled blocks under different describe()s share one invocation; the
// runner's aggregate pass/fail counts then can't be told apart, and a crashing sibling's failure gets
// misattributed to a surviving (truly hollow) one — flipping a true HOLLOW into a false CAUGHT (confirmed
// on a real repo: two same-titled `it()` blocks in different describe()s shared one `-t` invocation; the
// starter-tier sibling crashed under the mutation and its failure was misattributed to the truly-hollow
// growth-tier sibling, undercounting hollow tests). Ambiguous names are never probed — prove()'s per-file loop
// routes a WOULD-BE-PROBED ambiguous block (in scope, eligible, under the cap) straight to `inconclusive`
// instead of running its baseline. Pure + unit-testable (no runner spawned). Per-runner selection
// semantics (mirrors testCmdFor):
//   node   — `--test-name-pattern '^name$'` is ANCHORED: ambiguous iff another block has the exact name.
//   ava    — `-m name` goes through the `matcher` package (v5): only `*` is a wildcard, and only a
//            LEADING `!` is special (it negates the whole pattern — a title starting with '!' selects
//            nearly every OTHER test). `?[{` are plain literals. Ambiguous iff an exact duplicate, the
//            name contains `*`, or it starts with `!`.
//   others — vitest/jest/mocha's `-t`/`--grep` and pytest's `-k` all match as a SUBSTRING of the full
//            title (mocha/pytest unanchored, vitest/jest on the describe-qualified chain): ambiguous iff
//            another block's name is a substring of this one OR vice versa (equal counts as substring).
//            (pytest `-k` also has and/or/not operators, but they are whitespace-delimited tokens and
//            parseBlocks/pyBlocks names are Python identifiers — never whitespace — so they can't fire.)
const avaSpecial = (s) => s.includes('*') || s.startsWith('!');
// Per-runner pairwise "could one runner invocation select both?" predicate, factored out so both
// ambiguousNames (stage 1, bare titles) and residualAmbiguous (stage 2, describe-qualified full names,
// below) share the exact same rule instead of drifting. `anchored` mirrors an ANCHORED runtime
// invocation — node's pattern is unconditionally anchored already, and mocha's QUALIFIED --grep becomes
// anchored too (see testCmdFor) — an anchored selector can only ever collide on an EXACT match, never a
// substring, regardless of runner.
// gradle and maven are EXACT-match too: testCmdFor emits `--tests <FQN>` (gradle) / `-Dtest=Class#method`
// (maven) with no wildcard, and both match the fully-qualified name EXACTLY (no substring semantics). So
// a prefix-related FQN pair (`demo.T.testSave` / `demo.T.testSaveAll`, `p.C.add` / `p.C.addAll`) shares no
// invocation — the JVM norm. The `gradle`/`maven` disjuncts only change behavior on a JVM run; a JS/py run
// never reaches them (byte-safe).
function collidesPair(a, b, runner, anchored) {
  if (runner === 'node' || runner === 'ava' || runner === 'gradle' || runner === 'maven' || anchored) return a === b;
  return a.includes(b) || b.includes(a);
}
export function ambiguousNames(blockNames, runner) {
  const amb = new Set();
  for (let i = 0; i < blockNames.length; i++) {
    const a = blockNames[i];
    if (runner === 'ava' && avaSpecial(a)) amb.add(a);
    for (let j = 0; j < blockNames.length; j++) {
      if (i === j) continue;
      if (collidesPair(a, blockNames[j], runner, false)) amb.add(a);
    }
  }
  return amb;
}
// ---- Stage 2: qualify a bare-title collision with the describe-path chain before failing closed. A bare
// collision from ambiguousNames is not necessarily unresolvable — many are two describe()s sharing an
// inner title (the exact pilot bug: describe('starter tier'){it('x')} + describe('growth tier'){it('x')}
// share the bare title 'x', but their ENCLOSING PATH differs). qualifiedName joins a block's describe-path
// + its own title exactly the way Jest/Vitest/Mocha build a test's "full name"/"full title" (ancestor
// titles + own title, single-space-joined) — empirically verified against the real installed binaries
// (see the runner e2es in test/prove.test.mjs): vitest/jest's `-t` and mocha's `--grep`, given this joined
// string, select only the intended nested test. node's `--test-name-pattern` is unconditionally anchored
// already, and — empirically verified — ALSO matches per-level against each node's OWN name independent
// of ancestors, so a bare anchored pattern still matches every same-named nested test regardless of which
// describe it's under; only the FULL joined name (still anchored) disambiguates it (see the node e2e).
// NODE VERSION CAVEAT (measured on v20.20.2 vs v22.22.2, node20-qualification branch): the FULL-joined-name
// match above is a v22+ capability only. v20's `--test-name-pattern` has no "full name" concept at all — it
// matches ONLY each node's own (single-level) name, cascading down from a matching ancestor — so the joined
// `qualifiedName()` pattern 0-matches on v20 (both colliding blocks report `# SKIP test name does not match
// pattern`, 0 pass/0 fail) rather than selecting one. That 0p/0f baseline is not a wrong verdict: prove()'s
// baseline gate (`base.passed < 1`) routes it to `inconclusive` (why: `did-not-run 0p/0f` — 0 failed is
// never an accusation) exactly like any other unrunnable baseline — fail-closed, same as an unresolved
// residual collision. That 0p/0f reading is itself v20-specific: on v22 (current LTS, this repo's
// dev/CI baseline) the identical 0-match instead
// reports `# pass 1` — the file-wrapper subtest point counted as a pass — which nodeEffectiveCounts (see
// runOne, near parseRun) now discounts back to 0p/0f at the runtime layer, so both versions land on the
// same inconclusive outcome via different native runner readings. A second
// `--test-name-pattern` flag doesn't fix this either (verified): node ORs matches independently per level,
// so adding the bare leaf-title pattern back just re-admits every same-titled sibling, reproducing the
// original ambiguity. An ancestor-only anchored pattern (e.g. `^growth tier$`) DOES isolate the intended
// leaf on v20 in a minimal fixture, but adopting it generally would be unsound: residualAmbiguous only
// proves the qualified name differs for the specific colliding PAIR, never that the ancestor title is
// globally unique in the file — reusing it as the sole selector risks silently sweeping in an unrelated
// third block elsewhere (the exact misattribution bug this whole mechanism exists to prevent). So v20 stays
// fail-closed on this recovery path by design; the two node e2es below gate their expectations on
// `process.versions.node`'s major version accordingly. Confirmatory CI/fleets relying on the recall-
// recovery number must pin node >=22.
// ava is flat — no describe nesting in its own API — and enforces per-file title uniqueness itself (see
// the ava e2e), so it never reaches this refinement. pytest/python blocks carry no `path` (python has no
// describe-nesting analog in this parser), so qualifiedName degenerates to the bare name and stage 2 is a
// provable no-op for pytest (see residualAmbiguous below) — documented, not coded around.
// Known limit: single-space joining inherits Jest/Mocha's own full-name boundary ambiguity ('a b'+'c' ≡ 'a'+'b c') — unguarded beyond the bare-collision pool, matching ecosystem convention.
export function qualifiedName(b) { return [...(b.path || []), b.name].join(' '); }
// Re-runs collidesPair on the QUALIFIED full name, but ONLY for pairs that already collided on the bare
// title (stage 1) — a genuinely unrelated pair can never newly collide only because of qualification; this
// is strictly a REFINEMENT, never a new source of ambiguity. Per-BLOCK (index), not per-name-string: two
// blocks sharing one bare name can resolve independently of each other (one describe-pair may disambiguate
// while another same-named instance elsewhere in the file still collides). mocha's qualified selection is
// ANCHORED (see testCmdFor), so its residual check uses exact-match (anchored=true); node is unconditional
// exact-match already (collidesPair short-circuits on runner==='node'); vitest/jest stay substring
// (unanchored — their qualified `-t` is still a substring match, just now on the longer, more specific
// string). ava is never called with this (see qualifiedName's comment) — ambiguousNames alone is its
// complete story.
export function residualAmbiguous(blocks, bareAmbiguous, runner) {
  const residual = new Set();
  if (runner === 'ava') { // flat + self-uniqueness-enforced — qualification never applies (see above)
    for (let i = 0; i < blocks.length; i++) if (bareAmbiguous.has(blocks[i].name)) residual.add(i);
    return residual;
  }
  const anchored = runner === 'mocha'; // mocha's qualified --grep is anchored; others' qualified form is not
  for (let i = 0; i < blocks.length; i++) {
    if (!bareAmbiguous.has(blocks[i].name)) continue;
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue;
      if (!collidesPair(blocks[i].name, blocks[j].name, runner, false)) continue; // only the pair stage 1 flagged
      if (collidesPair(qualifiedName(blocks[i]), qualifiedName(blocks[j]), runner, anchored)) residual.add(i);
    }
  }
  return residual;
}

// ---- assertion-strength gate: which consumed fns have their RESULT pinned by a value matcher ----
// jest/vitest value-pinning matchers that FAIL against the gross-break sentinel (so probing is sound).
// Mirrors the vocabulary of checker/kinds/weakOracleGuard.mjs `PIN` (NOT .not./toBeDefined/toBeTruthy).
const VALUE_PIN = /^\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeCloseTo|toBeNull|toBeNaN|toBeInstanceOf|toContain|toContainEqual|toMatch|toMatchObject|toHaveLength|toThrow|toThrowError)\b/;
const VALUE_PIN_CALL = /^\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeCloseTo|toBeInstanceOf|toContain|toContainEqual|toMatch|toMatchObject|toHaveLength)\s*\(/;
// chai mirror is NOT 1:1 with PIN: .to.match (string-coerces the target) and the bare .to.have.a/an
// (type-checks) both PASS against the numeric sentinel, so they're excluded — sound forms only.
// toHaveProperty/.have.property are excluded too: a primitive autoboxes, so the path resolves on its
// prototype and PASSES the sentinel; .keys/.ownProperty require OWN properties, so they stay sound.
// language chains: chai's fluent no-ops (be/been/is/that/which/and/has/deep/same/an/a) may sit between
// `to`/`should` and the terminal matcher (`.to.be.equal(5)`, `.to.be.deep.equal(5)`) — they assert nothing
// themselves, so allowing any run of them before the terminal group changes no soundness property; `have`
// is deliberately NOT in this list (only `has` is), so `.to.have.property(...)` still never reaches the
// terminal group and the have-subform exclusion (property autoboxes) stays intact.
const CHAI_PIN = /^\s*\.\s*(?:to|should)\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a)\s*\.\s*)*(?:(?:deep\s*\.\s*)?(?:equal|eql|include|contain)\b|have\s*\.\s*(?:deep\s*\.\s*)?(?:lengthOf|length|members|keys|string|ownProperty)\b)/;
// standalone chai `should` sound-form matcher, tested from the '.' immediately before `should`.
const SHOULD_SOUND = /^\.\s*should\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a)\s*\.\s*)*(?:(?:deep\s*\.\s*)?(?:equal|eql|include|contain)\b|have\s*\.\s*(?:deep\s*\.\s*)?(?:lengthOf|length|members|keys|string|ownProperty)\b)/;
// Module specifiers that resolve to node's `assert` — a local name bound to one of these (aliased default
// import/require, or a destructured named import) is recognized as an assert call even under a non-literal
// name. A name bound to any OTHER module (lodash, …) is never treated as assert — no false HOLLOW.
const ASSERT_SPECS = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const ASSERT_METHODS = /^(?:equal|strictEqual|deepEqual|deepStrictEqual)$/;
// JVM value-pinning matcher vocabulary (Task 6): JUnit/kotlin.test equality asserters and AssertJ's
// fluent form. Scanned only when `lang` is 'kotlin'/'java' — every JS/py caller (no lang arg, or a non-
// JVM lang) never reaches this and stays byte-identical to pre-JVM behavior.
const JVM_VALUE_ASSERT_RE = /\b(?:assertEquals|assertSame|assertArrayEquals|assertContentEquals)\s*\(/g;
// AssertJ: assertThat(<actual>) is a pin only when followed by a SOUND (value-comparing) fluent
// matcher — a bare assertThat(x) with only a weak follow-on (.isNotNull(), .isNotEmpty(), …) is not a
// pin (mirrors the JS weak-matcher exclusion below: no assertion strength ⇒ never probed).
const ASSERTJ_SOUND = /^\s*\.\s*(?:isEqualTo|isSameAs|containsExactly|containsExactlyInAnyOrder|isEqualToComparingFieldByField)\s*\(/;
// AssertJ directional (relational) matchers — same asymmetry as RELATIONAL_PIN_CALL/CHAI_REL above: a
// relational pin can PROVE but never CONVICT (see the verdict fold).
const ASSERTJ_REL = /^\s*\.\s*(?:isGreaterThanOrEqualTo|isGreaterThan|isLessThanOrEqualTo|isLessThan)\s*\(/;
// Relational (direction-only) matcher vocabulary — spec Feature 2 §1. A relational pin can PROVE
// (mutant red) but can never CONVICT (survive → relation-unbound, never hollow) — see the verdict
// fold. That asymmetry is what makes loose admission safe: a false-relational match can only add
// proven/one-sided/relation-unbound, never an accusation.
const RELATIONAL_PIN_CALL = /^\s*\.\s*(?:toBeGreaterThanOrEqual|toBeGreaterThan|toBeLessThanOrEqual|toBeLessThan)\s*\(/;
// chai chains: same language-chain shape as CHAI_PIN, plus `at` (needed for .to.be.at.least/.at.most —
// `at` is a chai no-op chain that the value vocabulary never needed).
const CHAI_REL = /^\s*\.\s*(?:to|should)\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a|at)\s*\.\s*)*(?:above|gt|greaterThan|least|gte|below|lt|lessThan|most|lte)\s*\(/;
const SHOULD_REL = /^\.\s*should\s*\.\s*(?:(?:be|been|is|that|which|and|has|deep|same|an|a|at)\s*\.\s*)*(?:above|gt|greaterThan|least|gte|below|lt|lessThan|most|lte)\s*\(/;
export function pinnedFragmentsByKind(body, imports = new Map(), lang) {
  const jvm = lang === 'kotlin' || lang === 'java';
  body = codeOnly(body, jvm ? lang : 'typescript'); // mask strings/comments FIRST — a code sample embedded in a string
  // (or a commented-out assertion) must never be seen by the scans below (no false HOLLOW). Idempotent on
  // already-masked input, so re-masking here is harmless when eligibleFns has already masked its copy.
  const value = []; const relational = [];
  const frags = value; // existing scan code below keeps pushing to `frags` unchanged
  for (const m of body.matchAll(/expect\s*\(/g)) {
    const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
    let after = body.slice(end);
    // jest/vitest .resolves/.rejects prefix: strip it and test VALUE_PIN only (chai has no .resolves,
    // so CHAI_PIN after this prefix could only ever match accidental text). The gross-break mutant makes
    // the async SUT resolve to (or throw/reject with) the numeric sentinel, so a sound matcher after the
    // prefix provably fails against it — same soundness discipline as the sync path.
    const pm = /^\s*\.\s*(?:resolves|rejects)\b/.exec(after);
    if (pm) after = after.slice(pm[0].length);
    if (pm ? VALUE_PIN.test(after) : (VALUE_PIN.test(after) || CHAI_PIN.test(after))) {
      frags.push(arg);
      const mm = VALUE_PIN_CALL.exec(after);
      if (mm) frags.push(balancedFrom(after, mm.index + mm[0].length - 1).arg);
    } else if (RELATIONAL_PIN_CALL.test(after) || (!pm && CHAI_REL.test(after))) {
      relational.push(arg);
      const rm = RELATIONAL_PIN_CALL.exec(after) || CHAI_REL.exec(after);
      relational.push(balancedFrom(after, rm[0].length - 1).arg); // matcher arg — the other side of the relation
    }
  }
  for (const m of body.matchAll(/\bassert(?:\.(?:strictEqual|deepStrictEqual|deepEqual|equal|ok))?\s*\(/g)) {
    const { arg } = balancedFrom(body, m.index + m[0].length - 1);
    if (/\bassert\s*\($/.test(m[0]) || /\.\s*ok\s*\($/.test(m[0])) {
      const sides = topLevelComparisonSides(arg);
      if (sides) { relational.push(sides[0]); relational.push(sides[1]); }
      continue; // plain truthiness (no top-level comparator) stays excluded, exactly as before
    }
    frags.push(arg);
  }
  // aliased/destructured assert (import-aware): names bound to node:assert.
  const bound = new Set(); for (const [name, spec] of imports) if (ASSERT_SPECS.has(spec)) bound.add(name);
  for (const n of bound) {
    const e = reEsc(n);
    for (const m of body.matchAll(new RegExp('\\b' + e + '\\s*\\.\\s*(?:strictEqual|deepStrictEqual|deepEqual|equal)\\s*\\(', 'g')))
      frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
    if (ASSERT_METHODS.test(n))
      for (const m of body.matchAll(new RegExp('(?<![.\\w$])' + e + '\\s*\\(', 'g')))
        frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
  }
  // Hybrid fallback: X.<assertMethod>(a, b) where X is an UNDETECTABLE alias (not in imports at all).
  // Guards: exact assert method names + EXACTLY 2 top-level args (distinguishes assert.equal(actual,expected)
  // from chai `.to.equal(expected)` / a library `.equal(other)`, both 1-arg). A name bound to a non-assert
  // module is excluded (it was in imports, so it's skipped here and not in `bound`).
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\s*\.\s*(?:strictEqual|deepStrictEqual|deepEqual|equal)\s*\(/g)) {
    const name = m[1];
    if (name === 'assert' || imports.has(name)) continue; // literal handled above; any imported name handled above/excluded
    const { arg } = balancedFrom(body, m.index + m[0].length - 1);
    if (topLevelArgCount(arg) === 2) frags.push(arg);
  }
  // standalone chai `should` chains: <receiver>.should.<sound-form> — push the receiver (SUT extracted by eligibleFns)
  for (const m of body.matchAll(/\.\s*should\s*\./g)) {
    if (!SHOULD_SOUND.test(body.slice(m.index))) continue;
    const recv = receiverBefore(body, m.index);
    if (recv) frags.push(recv);
  }
  // chai `should` relational chain: <receiver>.should.be.<relational-form> — mirrors SHOULD_SOUND above.
  for (const m of body.matchAll(/\.\s*should\s*\./g)) {
    if (!SHOULD_REL.test(body.slice(m.index))) continue;
    if (SHOULD_SOUND.test(body.slice(m.index))) continue; // value already claimed it
    const recv = receiverBefore(body, m.index);
    if (recv) relational.push(recv);
  }
  for (const m of body.matchAll(/\bassert\s+(.+?)\s*===?\s*(.+?)(?:$|\n)/gm)) { frags.push(m[1]); frags.push(m[2]); } // pytest / chai assert a == b
  // pytest bare relational assert (spec §1): both sides pushed, chained comparisons allowed —
  // asymmetric verdicting protects every relation, so a chain needs no special casing.
  for (const m of body.matchAll(/\bassert\s+([^\n]+?)\s+(?:>=|<=|>|<)\s+([^\n]+?)(?:$|\n)/gm)) { relational.push(m[1]); relational.push(m[2]); }
  if (jvm) {
    // assertEquals(expected, actual) / assertSame / assertArrayEquals / assertContentEquals — JUnit puts
    // the SUT call in EITHER position (expected first is the JUnit convention, but a caller can and does
    // pass it either way), so the WHOLE arg list is pushed as one fragment rather than picking a side;
    // eligibleFns only credits a candidate whose name actually appears in it, so this is over-inclusive
    // but never wrong (the `\bname\s*\(` check below still requires the fn to be CALLED here).
    for (const m of body.matchAll(JVM_VALUE_ASSERT_RE)) frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
    // AssertJ assertThat(actual).isEqualTo(expected) — push the actual only when a sound fluent matcher
    // follows; assertThat(x).isNotNull() (weak) pushes nothing, so a fn reachable only through it is
    // never credited as eligible (see ASSERTJ_SOUND above).
    for (const m of body.matchAll(/\bassertThat\s*\(/g)) {
      const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
      if (ASSERTJ_SOUND.test(body.slice(end))) frags.push(arg);
    }
    // Relational JVM forms (spec §1): assertTrue/assertFalse over one top-level comparison — paren and
    // Kotlin trailing-lambda call shapes — and AssertJ's directional matchers. Both relation sides pushed.
    for (const m of body.matchAll(/\bassert(?:True|False)\s*\(/g)) {
      const sides = topLevelComparisonSides(balancedFrom(body, m.index + m[0].length - 1).arg);
      if (sides) { relational.push(sides[0]); relational.push(sides[1]); }
    }
    if (lang === 'kotlin') for (const m of body.matchAll(/\bassert(?:True|False)\s*\{/g)) {
      const inner = braceArgFrom(body, m.index + m[0].length - 1);
      const sides = inner === null ? null : topLevelComparisonSides(inner);
      if (sides) { relational.push(sides[0]); relational.push(sides[1]); }
    }
    for (const m of body.matchAll(/\bassertThat\s*\(/g)) {
      const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
      const rm = ASSERTJ_REL.exec(body.slice(end));
      if (rm) { relational.push(arg); relational.push(balancedFrom(body.slice(end), rm[0].length - 1).arg); }
    }
  }
  return { value, relational };
}
export function pinnedFragments(body, imports = new Map(), lang) {
  const k = pinnedFragmentsByKind(body, imports, lang);
  return [...k.value, ...k.relational];
}
// Callee names whose '(' is at bracket-depth 0 (not nested inside another call's args / an array / object).
export function topLevelCallees(expr) {
  const out = []; let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(' || c === '[' || c === '{') {
      if (c === '(' && depth === 0) { const m = /([A-Za-z_$][\w$]*)\s*$/.exec(expr.slice(0, i)); if (m && !/[.\w$]/.test(expr[i - m[0].length - 1] || '')) out.push(m[1]); }
      depth++;
    } else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return out;
}
// True if the expression has a SHORT-CIRCUIT / conditional operator at bracket-depth 0 — `||`, `&&`, `??`,
// or a ternary `? … :` (the `?` of `?:`/`??`/`cond ? a : b`). A callee on such a branch may never execute,
// so crediting it via the var-hop would be a false HOLLOW; the hop fails closed on the whole RHS instead.
// Depth-aware: a conditional INSIDE a call arg (`foo(a || b)`) does not gate the var's value, so it is
// ignored. A `?.` optional chain (JS) / safe call is a receiver'd call already excluded by topLevelCallees,
// so its `?` (followed by `.`) is deliberately NOT flagged. A non-short-circuit binary (`a() + b()`) has no
// such operator, so both always-evaluated callees stay credited (reach preserved).
export function hasTopLevelShortCircuit(expr) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      if ((c === '|' && expr[i + 1] === '|') || (c === '&' && expr[i + 1] === '&')) return true;
      if (c === '?' && expr[i + 1] !== '.') return true; // ?? / ?: / ternary `? … :`, but not `?.`
    }
  }
  return false;
}
// The LEADING call of a Kotlin expression: a bare lowercase-initial `name(` OR `name { }` (trailing lambda,
// the reach this lever adds) at the very HEAD of the expression — i.e. the callee whose result IS the whole
// expression's value. Returns the name, or null. An optional `<…>` allows an explicit type argument. A
// receiver'd head (`obj.build { }`), an Uppercase head (a type/SAM constructor), or a callee EMBEDDED in a
// compound expression (`provided ?: defaultPort()`, `if (c) a() else b()`) all yield null — the last is the
// point: an embedded callee can sit on a dead/short-circuited branch, so gutting it may leave a SOUND test
// green (a false HOLLOW). Used only by eligibleFns' Kotlin val-hop.
export function kotlinLeadingCall(expr) {
  const m = /^\s*([a-z_]\w*)\s*(?:<[^>]*>\s*)?[({]/.exec(expr);
  return m ? m[1] : null;
}
// The receiver'd HEAD call of a Kotlin expression (field report #3): `Receiver.method(` at the very head,
// where Receiver is an Uppercase-initial name present in the test file's import map (a resolvable
// object/companion/class singleton — never a local/param/mock var). This is the DOMINANT Kotlin test
// idiom (`val x = Modes.speedOfSound(...)`) that kotlinLeadingCall deliberately excludes (its own head
// requires a lowercase-initial name). Same two fail-closed guards as kotlinLeadingCall, both load-bearing:
//   - Import gate (`imports.has(m[1])`): the receiver must be a name the test file actually imports — a
//     mock (`mockk()`, a local var, `repo.find(id)`) is lowercase and fails the regex outright; a same-
//     package type reached with NO import line for it also fails this gate (deliberate under-reach — the
//     import gate IS the moat here, exactly like resolveJvmSut's own package-reachability gate). The
//     honest guarantee is STRICTLY-MORE-GATED-THAN-THE-INLINE-PATH, not impossibility: an uppercase local
//     val shadowing an import, or `mockkObject(Modes)` stubbing an imported object, satisfies the gate —
//     the same shapes the already-shipped inline capitalized-receiver path credits with NO import gate
//     at all, so this path narrows that pre-existing surface rather than adding to it.
//   - Head anchor (`^\s*`): the call must be the WHOLE expression's head, so a dead/short-circuited branch
//     (`cond ?: Foo.bar()`, `if (c) Foo.a() else Foo.b()`) can never match — the head token there is
//     `cond`/`if`, not an Uppercase receiver, so the regex fails at position 0 with no retry.
// Chained/nested receivers are a single hop by construction, not a special case: `A.b().c(...)` matches
// only `A.b(` (group 2 = `b`) — `c` is never captured at all, so it can never be credited via this path
// regardless of candidateFns (evaluated-surface decision: chained receivers are out of scope). A
// companion/nested-object receiver (`Outer.Inner.method(...)`) falls through with no credit: the second
// group requires a LOWERCASE-initial token right after the first dot, and `Inner` is Uppercase, so the
// whole `^`-anchored match fails outright (safe under-reach, not a special-cased guard).
// Kotlin-gated only (mirrors the pre-existing val-hop it extends): the Java analogue was evaluated and
// deliberately left out of scope this pass — see importMap's `lang === 'kotlin'` gate below, which is
// the reason a Java `var x = Modes.speedOfSound(...)` never has `Modes` in its import map at all.
// Returns `method`, or null.
export function kotlinReceiverCall(expr, imports) {
  const m = /^\s*([A-Z]\w*)\s*\.\s*([a-z_]\w*)\s*(?:<[^>]*>\s*)?\(/.exec(expr);
  if (!m) return null;
  if (!imports.has(m[1])) return null; // receiver must be imported (object/type), not a local/mock/unimported type
  return m[2];
}
// Split `text` at its single top-level comparison operator (>, <, >=, <=) → [lhs, rhs], else null.
// Depth-0 only (parens/brackets/braces balanced); refuses && and || (a joined condition is not one
// relation — fail-closed per spec), ==/===/!= (never relational), a second comparator, arrows
// (=>, ->), and shifts (<< >>). Runs on MASKED text, so string contents never reach it. Generic-type
// false positives (f<T>(x)) are accepted: admission is verdict-safe by construction (see above).
export function topLevelComparisonSides(text) {
  let depth = 0, cmp = -1, op = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      if ((c === '&' && text[i + 1] === '&') || (c === '|' && text[i + 1] === '|')) return null;
      if ((c === '=' && text[i + 1] === '=') || (c === '!' && text[i + 1] === '=')) return null;
      if (c === '<' || c === '>') {
        if (text[i - 1] === '=' || text[i - 1] === '-') continue; // => and -> arrows
        if (text[i + 1] === c) { i++; continue; }                  // << >> shifts
        if (cmp !== -1) return null;                               // a second comparator — refuse
        cmp = i; op = text[i + 1] === '=' ? c + '=' : c;
      }
    }
  }
  return cmp === -1 ? null : [text.slice(0, cmp).trim(), text.slice(cmp + op.length).trim()];
}
// Back-compat single-value form — every reach/eligibility consumer that only needs the linked names.
export function eligibleFns(body, candidateFns, imports = new Map(), lang) {
  return eligibleFnsDetail(body, candidateFns, imports, lang).eligible;
}
// Detail form: `eligible` (candidate fns a pinned fragment or a var-hop actually links) plus `hadPin` —
// whether ANY pinned fragment existed at all. The two are separate facts: a pin the scanner cannot link
// (a destructuring LHS, an unmodeled hop shape) leaves eligible empty while hadPin is true, and the skip
// reason must say THAT ('pin-unresolved') rather than claim "no value pinned" about a test that pins
// (public issue #3 — the false claim sends users to "fix" sound tests).
export function eligibleFnsDetail(body, candidateFns, imports = new Map(), lang) {
  const codeLang = (lang === 'kotlin' || lang === 'java') ? lang : 'typescript';
  const masked = codeOnly(body, codeLang); // mask once; reused for both scans below (pinnedFragmentsByKind
  // re-masks its input too — codeOnly is idempotent on already-masked text — so each stays independently safe).
  const byKind = pinnedFragmentsByKind(masked, imports, lang);
  if (!byKind.value.length && !byKind.relational.length) return { eligible: [], relationalOnly: [], hadPin: false, hadValuePin: false };
  // Per-kind crediting (relational-assert reach, Feature 2 §1): the crediting body below is run ONCE PER
  // KIND (value fragments, then relational fragments) — byte-identical logic each time, just reading a
  // different fragment list. A fn linked only through the relational scan is provable (mutant red) but
  // must never CONVICT (survive → hollow) — the verdict fold reads relationalOnly to enforce that asymmetry.
  const creditFrom = (frags) => {
    if (!frags.length) return new Set();
    const fragText = frags.join(' ; ');
    const calls = (txt, fn) => new RegExp('\\b' + reEsc(fn) + '\\s*\\(').test(txt);
    const eligible = new Set(candidateFns.filter((fn) => calls(fragText, fn)));
    // one variable hop: a bare var pinned by a matcher, assigned from a SUT call. Strictly SAME-LINE
    // (`[^\S\n]*` around `=`, not `\s*`): a `\s` matches the newline, so a var whose RHS masks to whitespace
    // (`let g = "hi"` → the string blanks to spaces) would let `[^\n;]+` reach onto the NEXT statement and
    // credit its callee to `g` → a false HOLLOW when g is set independently and that callee is gutted. A
    // blank-masked RHS now matches nothing (no callee) — a correct under-reach. And skip a RHS with a top-level
    // short-circuit / conditional (`hasTopLevelShortCircuit`): an embedded callee (`provided || defaultPort()`)
    // may sit on a dead branch → gutting it leaves a SOUND test green → a false HOLLOW. (Both were pre-existing
    // vectors in this shared JS/py hop; fixed here — a non-short-circuit `+` still credits both callees.)
    const bareVars = new Set(); for (const f of frags) for (const v of f.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\b/g)) bareVars.add(v[1]);
    // PRECISION (composite TS type annotations, owner-authorised fix): the annotation-skip group must be
    // ARROW-AWARE — `(?:=>|[^=\n])+?` consumes a `=>` token as one atomic unit, instead of the plain
    // `[^=\n]+?`, which lazily stops at the FIRST literal `=` it sees. A function-type member inside a
    // composite annotation contains `=>`, and `=>` itself CONTAINS a bare `=` character — so the old group
    // truncated mid-type (`{ cb: (x: number) => number, compute(): number } = { cb: identity }` stopped right
    // after the arrow's `=`), and the REST of the type (`compute(): number`, method-signature-shaped text)
    // spilled into the RHS text scanned below for calls → a false credit for a fn never actually called. The
    // group is arrow-aware but deliberately NOT brace-aware (it does not track `{}`/`<>` nesting) — that is
    // sufficient because (a) a quoted string-literal type (`'a=b'`-shaped) is already blanked by codeOnly's
    // masking before this regex ever runs, so a literal `=` hiding in a string can't false-stop the scan, and
    // (b) stopping at the first bare `=` that isn't part of `=>` is exactly the real assignment operator for
    // any realistic annotation — a genuine SECOND bare `=` inside the type is not a shape TS/Kotlin produce.
    // The REQUIRED assignment separator right after the group also needs `(?!>)`: the group is lazy/optional,
    // so it stops at the FIRST position the trailing pattern accepts — without `(?!>)` that trailing pattern
    // still accepts an arrow's `=` (it doesn't know the group is "supposed" to be arrow-aware), so the group
    // would stop one char too early regardless of what it can consume. `(?!>)` forces it past the arrow.
    // Mirrored at the Kotlin val/var hop and the jsInstanceSuts copy below (both reference this comment).
    for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*(?:=>|[^=\n])+?)?[^\S\n]*=(?!>)[^\S\n]*([^\n;]+)/g)) {
      if (!bareVars.has(m[1])) continue;
      if (hasTopLevelShortCircuit(m[2])) continue;
      const outer = topLevelCallees(m[2]);
      for (const fn of candidateFns) if (outer.includes(fn)) eligible.add(fn);
    }
    // Kotlin val-hop: the hop above matches `const|let|var` with a paren-ONLY callee scan, so a Kotlin `val`
    // binding — the dominant idiom — and a parenless trailing-lambda RHS (`val r = yaml { … }`) both fall
    // through. Mirror it for `val`/`var`. Kotlin-only: JS/py/Java never enter here (byte-identical). Same var-hop
    // safety plus the same two precision guards as the shared hop (same-line + no dead-branch credit), but via
    // kotlinLeadingCall (the RHS-HEAD call whose result IS the var's value): unlike the JS hop's short-circuit
    // scan, this ALSO excludes a Kotlin `if`/`when` EXPRESSION RHS (`val x = if (c) a() else b()` → the head is
    // the `if` keyword, never a candidate) — a conditional form JS lacks. The credited name is still gated by
    // sutFnsIn (scope/control-flow excluded) and the import/package-gated, overload-fail-closed resolver.
    if (lang === 'kotlin') {
      // Arrow-aware annotation-skip group — same fix, same reasoning, as the const/let/var hop above.
      for (const m of masked.matchAll(/\b(?:val|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*(?:=>|[^=\n])+?)?[^\S\n]*=(?!>)[^\S\n]*([^\n;]+)/g)) {
        if (!bareVars.has(m[1])) continue;
        const lead = kotlinLeadingCall(m[2]);
        if (lead && candidateFns.includes(lead)) eligible.add(lead);
        // Receiver'd object/singleton call (field report #3): `val x = Modes.speedOfSound(...)` — the
        // dominant idiom kotlinLeadingCall's bare-lowercase-head requirement misses. Import-gated + head-
        // anchored (see kotlinReceiverCall) — purely ADDITIVE, never loosens what kotlinLeadingCall itself
        // credits, and runs on the SAME masked match so it inherits the same-line + non-conditional guards.
        const recv = kotlinReceiverCall(m[2], imports);
        if (recv && candidateFns.includes(recv)) eligible.add(recv);
      }
      // Destructuring val-hop (field report 2026-07-22 §3): `val (a, b, …) = f(...)` binds componentN()
      // of f's return, so a pin on ANY component is bound by f exactly as a pin on a single-var hop is —
      // componentN is a projection of the returned object, never weaker evidence than the single-var hop.
      // Same masked matchAll, same same-line `=(?!>)` separator, same kotlinLeadingCall/kotlinReceiverCall
      // heads: the dead-branch (if/when head) and mock-receiver (lowercase/unimported) moats carry over
      // unchanged. The `.split(',')` on the component list is not angle-bracket-aware — a component's own
      // generic annotation (`val (a: Map<String, Int>, b) = …`) yields a harmless phantom token (`Int>`)
      // that can never match a real pinned var; the boundary names always survive intact. SOUND TODAY only
      // while gutValueFor's gutable set stays scalar-only: every destructurable type (data class,
      // Pair/Triple, Map.Entry, Array/List) falls through to the numeric sentinel → compile-fail →
      // 'ungutable', so this hop converts skip reasons (pin-unresolved → ungutable), never mints a mutant
      // run. If a collection/data-class sentinel ever lands in gutValueFor, re-audit this credit path for
      // false-hollow exposure first.
      for (const m of masked.matchAll(/\b(?:val|var)\s*\(\s*([^)\n]+?)\s*\)[^\S\n]*=(?!>)[^\S\n]*([^\n;]+)/g)) {
        const names = m[1].split(',').map((s) => s.trim().split(':')[0].trim());
        if (!names.some((n) => bareVars.has(n))) continue; // at least one component is a pinned bare var
        const lead = kotlinLeadingCall(m[2]);
        if (lead && candidateFns.includes(lead)) eligible.add(lead);
        const recv = kotlinReceiverCall(m[2], imports);
        if (recv && candidateFns.includes(recv)) eligible.add(recv);
      }
    }
    return eligible;
  };
  const valueCredit = creditFrom(byKind.value);
  const relCredit = creditFrom(byKind.relational);
  const relationalOnly = [...relCredit].filter((f) => !valueCredit.has(f));
  return {
    eligible: [...valueCredit, ...relationalOnly],
    relationalOnly,
    hadPin: true,
    hadValuePin: byKind.value.length > 0,
  };
}

// ---- SUT resolution: the non-test source file that the TEST FILE actually imports a fn from ----
// Parse a test file's import bindings → Map<localName, specifier>. ESM `import` + CJS `require`, plus
// (kotlin-gated only — see below) Kotlin's bare `import a.b.C` form. `lang` is OPTIONAL: every pre-
// existing call site (no lang arg, JS/py) reproduces the original ESM/CJS-only regex byte-identically —
// the Kotlin branch below is additive and only ever runs when lang === 'kotlin'.
export function importMap(code, lang) {
  const m = new Map();
  for (const im of code.matchAll(/\bimport\s+([^;]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = im[1].trim(), spec = im[2];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const part of named[1].split(',')) { const name = part.trim().split(/\s+as\s+/).pop().trim(); if (name) m.set(name, spec); }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause); if (ns) m.set(ns[1], spec);
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause); if (def && !/^\{|\*/.test(clause)) m.set(def[1], spec);
  }
  for (const rq of code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const lhs = rq[1], spec = rq[2];
    const named = /\{([^}]*)\}/.exec(lhs);
    if (named) for (const part of named[1].split(',')) { const name = part.trim().split(/\s*:\s*/).pop().trim(); if (name) m.set(name, spec); }
    else m.set(lhs, spec);
  }
  // Kotlin plain import (field report #3 — no `from` clause, so the ESM regex above never matches it):
  // `import a.b.C`. Keyed on the SIMPLE (last dotted) segment — `Modes` from `import
  // com.roomacoustics.audio.Modes` — because that is the receiver TOKEN a call site actually shows
  // (`Modes.speedOfSound(...)`); this is the map kotlinReceiverCall's import gate reads. Kotlin-gated
  // (Java's static-import shape has a different member/class split and was evaluated out of scope this
  // pass — see kotlinReceiverCall's own header) so every JS/py caller (and every Java one) is unaffected.
  // A wildcard import (`import a.b.*`) captures a trailing '.' with nothing after it — split leaves an
  // EMPTY last segment, which the `if (last)` guard drops — so a wildcard never names a specific type as
  // "imported" (deliberate: the import gate only credits an EXPLICITLY named receiver, same moat as the
  // no-import-line case below it).
  if (lang === 'kotlin') {
    for (const im of code.matchAll(/^\s*import\s+([\w.]+)(?:\s*\.\s*\*)?/gm)) {
      const segs = im[1].split('.');
      const last = segs[segs.length - 1];
      if (last) m.set(last, im[1]);
    }
  }
  return m;
}
const isRelative = (spec) => /^\.\.?\//.test(spec);
// `lang` is OPTIONAL: absent (every pre-JVM caller — makeResolver, resolvePySut) returns exactly the
// original JS/py regex, byte-identical. Passing 'kotlin'/'java' switches to a JVM-declaration pattern
// instead (resolveJvmSut below) — the two families never mix, so there is no shared-regex risk of a
// JVM decl accidentally matching the JS branch or vice versa.
function declRe(fn, lang) {
  const e = reEsc(fn);
  if (lang === 'kotlin') {
    // `fun NAME(` — top-level, member, generic (`fun <T> NAME(`), and receiver/extension (`fun Recv.NAME(`)
    // forms all converge on the same `fun ... NAME(` shape; a bare call site (`NAME(`, no `fun`) never
    // matches. `class|object|interface NAME` covers a type itself being the "declaration" of its name.
    return new RegExp(`\\bfun\\s+(?:<[^>]*>\\s*)?(?:[A-Za-z_][\\w.]*\\.)?${e}\\s*\\(|\\b(?:class|object|interface)\\s+${e}\\b`);
  }
  if (lang === 'java') {
    // A method DECLARATION is `NAME(params) [throws ...] {` — the trailing `{` is what a call site
    // (`NAME(args)`, followed by `;` or `)` or another token, never `{`) can never produce.
    return new RegExp(`\\b${e}\\s*\\([^)]*\\)\\s*(?:throws[^{;]*)?\\{|\\b(?:class|interface|enum)\\s+${e}\\b`);
  }
  return new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${e}\\b|\\b(?:export\\s+)?(?:const|let|var|function|class)\\s+${e}\\b|\\bfunction\\s*\\*\\s*${e}\\b|\\bdef\\s+${e}\\b|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`);
}
// Exported so hasProductionContact (wrongLayerShadow's JS contact probe) can be unit-tested directly with
// a hand-built resolver, mirroring resolveJvmSut/resolvePySut's own direct-testing convention — no
// behavior change for prove()'s own internal call site.
export function makeResolver(srcFiles, dir) {
  const cache = new Map();
  return (fn, testAbs, imports) => {
    const key = `${testAbs}::${fn}`;
    if (cache.has(key)) return cache.get(key);
    let res = null;
    const spec = imports.get(fn);
    // Import-aware: bind ONLY when the test imports fn from a RELATIVE file. Builtins (node:*) and bare deps
    // (lodash, …) and un-imported globals never bind → the block is left unprobed, never a false HOLLOW.
    if (spec && isRelative(spec)) {
      const re = declRe(fn);
      const target = resolveRelative(testAbs, spec); // absolute candidate path(s), as canonKeys
      for (const f of srcFiles) {
        if (!target.has(canonKey(f))) continue;
        try { if (re.test(readFileSync(f, 'utf8'))) { res = toPosix(relative(dir, f)); break; } } catch {}
      }
    }
    cache.set(key, res); return res;
  };
}
// Resolve a relative import specifier to the set of absolute source paths it could mean (ext + index
// forms), as canonKeys — so a case/8.3-short-name/symlink difference between the specifier's resolved
// form and the actual on-disk srcFiles entry (win32) still matches (replaces the old realpathSafe).
function resolveRelative(testAbs, spec) {
  const base = resolve(dirname(testAbs), spec);
  const exts = ['', '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '/index.mjs', '/index.js', '/index.ts'];
  return new Set(exts.map((e) => canonKey(base + e)));
}

// ---- Python precision path (stdlib `ast`, zero new dependency) ----
// Run mutation/py_blocks.py over a test file → { imports:[{local,module,level}], blocks:[{name,line,
// endline,calls,pins}] }, or null when python3/python is absent or the helper fails (→ regex fallback).
// `pins` are the SUT calls whose RESULT is value-pinned by an equality matcher (assertEqual family /
// `assert ==`) — including unittest's `self.assertEqual(...)`, which the JS-oriented pinnedFragments misses.
export function pyBlocks(absTestFile) {
  const exe = pythonExe();
  if (!exe) return null;
  try {
    const out = execFileSync(exe, [PY_HELPER, absTestFile], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const parsed = JSON.parse(out);
    if (!parsed || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.imports)) return null;
    return parsed;
  } catch { return null; }
}
// Shared binding + module-file resolution for BOTH resolvePySut and resolvePyClassMember (T4, §6.3 — "one
// helper, two callers, no drift"): given a name bound via `from MODULE import NAME` in pyImports, resolve
// which of srcFiles it could mean. A relative import (`level`>0) climbs parents from the test file's dir;
// an absolute import resolves against the test file's dir (pytest prepends the test's rootdir to sys.path
// under the flat layout). Returns the matching srcFiles entries (module.py or module/__init__.py — at most
// one of those normally exists, but both candidates are checked so a case/symlink collision still
// matches), or null when the name isn't imported at all. Callers apply their own downstream ambiguity
// discipline over the returned list.
function resolvePyModuleFiles(name, pyImports, absTest, srcFiles) {
  const binding = pyImports.find((b) => b.local === name);
  if (!binding) return null;
  let base = dirname(absTest);
  for (let i = 1; i < (binding.level || 0); i++) base = dirname(base);
  const segs = binding.module ? binding.module.split('.') : [];
  const modBase = segs.length ? resolve(base, ...segs) : base;
  const cands = new Set([modBase + '.py', join(modBase, '__init__.py')].map(canonKey));
  return srcFiles.filter((f) => cands.has(canonKey(f)));
}
// Bind a pinned call name to its SUT .py file IMPORT-AWARE: only through a `from MODULE import fn` the test
// actually wrote (py_blocks emits those bindings) — a name the test did not import never binds, so no false
// HOLLOW. The resolved file must also DECLARE `def fn`. Returns the SUT path relative to dir, or null (→
// skip the block).
export function resolvePySut(fn, pyImports, absTest, srcFiles, dir) {
  const files = resolvePyModuleFiles(fn, pyImports, absTest, srcFiles);
  if (!files) return null;
  const re = declRe(fn);
  // Ambiguity guard, mirroring the JVM overload rule: a module that binds NAME via BOTH a `class NAME`
  // declaration and a def/assign-style declaration (`def NAME(` / `NAME = ...`) rebinds the module-level
  // name at import time — whichever comes LAST textually wins at runtime. Gut-time's jsSigRegex
  // (probe.mjs) has no `class NAME` alternative, so it always guts the def/assign form regardless of
  // which one the runtime actually binds. When the class is what runs, the def/assign mutant is dead
  // code — the mutant survives a sound test → false HOLLOW. Refuse rather than guess.
  const e = reEsc(fn);
  const classRe = new RegExp(`\\bclass\\s+${e}\\b`);
  const defAssignRe = new RegExp(`\\bdef\\s+${e}\\b|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`);
  for (const f of files) {
    try {
      const text = readFileSync(f, 'utf8');
      if (classRe.test(text) && defAssignRe.test(text)) return null;
      if (re.test(text)) return toPosix(relative(dir, f));
    } catch {}
  }
  return null;
}

// resolvePyClassMember(ctor, method, pyImports, absTest, srcFiles, dir) → sutRel | null (T4, §6.3). The
// Python instance-receiver counterpart of resolvePySut: shares resolvePyModuleFiles' binding + module-file
// resolution (one helper, two callers — no drift), then hands each candidate file to the py_blocks.py
// `--member` ast validator (§6.2: exactly one module-top-level `ClassDef ctor` with no decorator/metaclass,
// no other module-level binding of `ctor`, exactly one non-async undecorated `FunctionDef method` directly
// in `ctor`'s own body with first param literally `self`, no other `def method` anywhere in the module),
// then requires `pyDeclSiteCount(srcText, method) === 1` — gut-time regex parity (§6.4, mirrors jsDeclSites/
// jvmDeclSites), so a credited site is exactly the one grossBreak's Python pass 1 would actually gut. A
// python3-less environment (pythonExe() null) refuses every candidate (pyMemberOk returns false) — the
// pyAst caller in prove()'s block loop never even reaches here in that case (pyBlocks() itself already
// returns null with no interpreter, so `pyAst` is null and the whole T4 path is skipped — this is a second,
// independent fail-closed layer, not the only one).
const pyMemberCache = new Map();
function pyMemberOk(absSrc, ctor, method) {
  const key = absSrc + '::' + ctor + '::' + method;
  if (pyMemberCache.has(key)) return pyMemberCache.get(key);
  let ok = false;
  const exe = pythonExe();
  if (exe) {
    try {
      const out = execFileSync(exe, [PY_HELPER, '--member', absSrc, ctor, method], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      ok = JSON.parse(out).ok === true;
    } catch { ok = false; }
  }
  pyMemberCache.set(key, ok);
  return ok;
}
export function resolvePyClassMember(ctor, method, pyImports, absTest, srcFiles, dir) {
  const files = resolvePyModuleFiles(ctor, pyImports, absTest, srcFiles);
  if (!files) return null;
  for (const f of files) {
    if (!pyMemberOk(f, ctor, method)) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (pyDeclSiteCount(text, method) !== 1) continue;
    return toPosix(relative(dir, f));
  }
  return null;
}

// ---- JVM SUT resolution (Task 7): package/import-gated, fail-closed on ambiguity ----
// JVM has no relative-path imports (the JS/py resolvers' whole mechanism), so a callee binds by PACKAGE
// REACHABILITY instead: the set of packages the test file could plausibly mean a bare name from — its own
// `package` plus every `import`ed package. The SAME-PACKAGE case is the common one (a JVM test typically
// shares its SUT's package and imports nothing for it, only JUnit/AssertJ), which is why testPackage must
// be seeded into the reachable set — omitting it would leave the ordinary case unresolved.
function jvmPackageOf(code) {
  const m = /^\s*package\s+([\w.]+)/m.exec(code);
  return m ? m[1] : '';
}
// An import's PACKAGE, by kind (all reduce to a uniform pop rule):
//   - ordinary `import a.b.C` (class) / `import a.b.foo` (top-level fn) → drop the LAST segment → `a.b`.
//   - ordinary wildcard `import a.b.*` → the `[\w.]+` capture greedily eats the trailing '.' (the optional
//     `\.\s*\*` group is left with nothing to consume), so it captures `a.b.`; split→['a','b',''], one
//     pop drops the '' → `a.b`.
//   - Java STATIC `import static a.b.C.member` → the member lives in class C in package a.b, so drop the
//     last TWO segments (member + class) → `a.b`. Static wildcard `import static a.b.C.*` captures `a.b.C.`
//     (same trailing-'.' greed); two pops drop the '' then C → `a.b`.
// The `(static\s+)?` group is REQUIRED for two reasons: (1) without it the regex matches at the keyword
// `static` and captures the literal "static" → pops to '' → the DEFAULT package poisons the reachable set,
// so a default-package src/main file wrongly resolves (a false HOLLOW — `import static …Assertions.assert*`
// is in nearly every real Java JUnit/AssertJ test); (2) it drives the second pop that gives statically-
// imported SUTs their package. An import must NEVER inject '' into reachable (guarded by `if (p)`), so the
// default package enters `reachable` ONLY from a genuinely empty `testPackage` seed, never from an import.
function jvmReachablePackages(testCode) {
  const pkgs = new Set([jvmPackageOf(testCode)]);
  for (const im of testCode.matchAll(/^\s*import\s+(static\s+)?([\w.]+)(?:\s*\.\s*\*)?/gm)) {
    const segs = im[2].split('.');
    segs.pop();                 // drop class (ordinary) / member-or-wildcard-slot (static)
    if (im[1]) segs.pop();      // static: also drop the class
    const p = segs.join('.');
    if (p) pkgs.add(p);         // an import must never inject the empty (default) package
  }
  return pkgs;
}
// fn -> the single src/main .kt/.java file that DECLARES it EXACTLY ONCE, or null. Fail-closed like
// resolvePySut, but the ambiguity unit is a DECLARATION, not a file: 0 declarations → null (never probed —
// safe, at worst a missed reach); >=2 declarations → null (ambiguous — guessing which declarer a mutant
// needs to break risks a FALSE hollow, strictly worse than a miss). Crucially this rejects BOTH ≥2
// declaring FILES **and** ≥2 OVERLOADS in one file: grossBreak guts only the FIRST matching declaration,
// so an overloaded SUT whose test exercises a LATER overload would pass under the mutant → false hollow.
// Counting declarations globally (not files) makes an overloaded SUT ungutable (a safe reach-loss). A
// candidate file must clear BOTH gates: its own `package` is in the test's reachable set (bounds the
// residual — an unimported package's same-named fn, e.g. a stdlib-collision `size`, must never resolve),
// AND it `declRe(fn, fileLang)`-declares fn (the DECLARATION pattern — `fun NAME(` / `TYPE NAME(...) {` —
// never a bare call site). `lang` (the TEST file's kotlin|java) is accepted for call-site parity with the
// other resolvers but unused here: each CANDIDATE's own lang is derived from its own extension.
export function resolveJvmSut(fn, testCode, absTest, srcFiles, dir, lang) {
  const reachable = jvmReachablePackages(testCode);
  let testKey; try { testKey = canonKey(absTest); } catch { testKey = absTest; }
  let winner = null; let declCount = 0;
  for (const f of srcFiles) {
    const fileLang = f.endsWith('.kt') ? 'kotlin' : f.endsWith('.java') ? 'java' : null;
    if (!fileLang) continue; // non-JVM entries in a mixed srcFiles list are simply skipped
    if (canonKey(f) === testKey) continue; // defensive: never resolve to the test file itself
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (!reachable.has(jvmPackageOf(text))) continue;
    // Count DECLARATION occurrences (global) — the same decl-vs-call pattern declRe uses, so overloads in
    // ONE file are counted individually; the `[^)]*` in the Java method pattern is bounded by the first
    // ')', so two overloads can't be swallowed as one match. Summed across every reachable file.
    const re = new RegExp(declRe(fn, fileLang).source, 'g');
    const n = (text.match(re) || []).length;
    if (n > 0) { winner = f; declCount += n; }
  }
  if (declCount !== 1) return null; // 0 → unreachable/undeclared; >=2 → ambiguous (≥2 files OR same-file overloads)
  return toPosix(relative(dir, winner));
}

// ---- JVM INSTANCE-method SUT resolution: `analyzer.computeRt60(x)` on a lowercase-variable receiver ----
// sutFnsIn (confirm.mjs) deliberately EXCLUDES a lowercase-receiver call — a name like `compute` off
// `list.compute(` collides with too many things to gut blind. This resolves the SAME shape SAFELY by
// inferring the RECEIVER's RUNTIME type and binding the method to ONLY that type's own declaration —
// never a bare name.
//
// CRITICAL (virtual dispatch): an instance call dispatches to the receiver's RUNTIME type, which is the
// type of the CONSTRUCTOR that produced the value — NOT its declared/annotated static type. For
// `val a: Base = Derived()` a real `a.compute()` runs `Derived.compute`, so gutting `Base.compute` would
// never execute → a sound test survives → a FALSE HOLLOW. Therefore inference resolves from the
// CONSTRUCTOR CALL (`= ClassName(...)` / `= new ClassName(...)`), never the annotation. When the runtime
// type is not a directly-visible constructor call — an annotation/declared type only, a factory or method
// return (`= makeThing()`), a chained construction (`= Foo().let { … }`), a parameter/field with no
// visible construction, or a reassignment to >1 distinct constructor type — the runtime type is genuinely
// unknowable statically, so this REFUSES (a miss, never a guess). Resolving the constructor's type makes a
// separate virtual-dispatch guard unnecessary: we always gut the very class the receiver actually is.

// `this`/`it` are never real objects to resolve (Kotlin's implicit lambda receiver, or a plain keyword);
// excluding them here means a bare `it.something()` inside a lambda never falls through to (fruitlessly,
// but harmlessly) look for a `val it = …` declaration.
const INSTANCE_RECEIVER_SKIP = new Set(['this', 'it']);

// Lowercase-receiver instance-method calls inside an ALREADY-MASKED fragment (pinnedFragments masks its
// own copy before slicing fragments, so a call mentioned only in a string/comment can never surface
// here). Multiple pairs per fragment are all collected — JUnit's assertEquals pushes the WHOLE arg list
// as one fragment, so both expected/actual sides are scanned uniformly (mirrors the existing bare-name
// eligibility check, which is equally over-inclusive-but-safe on which side matched).
function instanceCallsIn(fragText) {
  const out = [];
  for (const m of fragText.matchAll(/(?<![\w$.])([a-z]\w*)\s*\.\s*([A-Za-z_$]\w*)\s*\(/g)) {
    const [, receiver, method] = m;
    if (INSTANCE_RECEIVER_SKIP.has(receiver)) continue;
    out.push({ receiver, method });
  }
  return out;
}

// Shared runtime-type inference: scan the FULL masked test file for EVERY assignment to RECEIVER and
// return the single constructor (runtime) type common to all of them, or null (REFUSE). `assignRe` finds
// each assignment site (a declaration — possibly type-annotated — or a bare reassignment); its match end
// sits right after the `=`. `ctorAt(s, i)` returns `{ type, end }` when the masked text at `i` begins
// with a DIRECT constructor call (the index just past its closing `)` is `end`), else null. Fail-closed
// on every branch:
//   - ANY assignment whose RHS is not a direct constructor (a factory/method return, another variable, a
//     literal, or a declaration with no initializer) → null: the runtime type is unknowable.
//   - a constructor immediately CHAINED (`Foo().let { … }`, `.also`, `.apply`, `.map`, …) → null: the
//     chain may transform the value's type (we don't special-case which combinators preserve it).
//   - >1 DISTINCT constructor type across the file (reassignment / shadowing) → null: ambiguous.
//   - no assignment visible at all (a parameter, or a field constructed out of view) → null.
function inferReceiverTypeFromCtor(masked, assignRe, ctorAt) {
  const types = new Set();
  let sawAssignment = false;
  for (const m of masked.matchAll(assignRe)) {
    sawAssignment = true;
    const c = ctorAt(masked, m.index + m[0].length);
    if (!c) return null; // RHS is not a direct constructor call — runtime type unknown → refuse
    let k = c.end; while (k < masked.length && /\s/.test(masked[k])) k++;
    if (masked[k] === '.') return null; // chained construction (`Foo().let{…}`) — type may be transformed → refuse
    types.add(c.type);
  }
  if (!sawAssignment) return null; // annotation / parameter / field only, never constructed in view → refuse
  if (types.size !== 1) return null; // reassignment / shadowing to >1 distinct constructor type → refuse
  return [...types][0];
}

// Kotlin: an assignment site is `[val|var] RECEIVER [: Type] = …` (the optional `: Type` annotation is
// consumed but IGNORED — resolution is from the RHS constructor, not the annotation) or a bare
// `RECEIVER = …` reassignment. The leading `(?<![\w$.(])` rejects a member access (`x.a =`) and a named
// argument (`foo(a = Widget())`). The RHS constructor is `[pkg.]ClassName(` with a Capitalized simple
// name — a lowercase callee (`makeFoo()`, `listOf()`) is a factory, never a constructor, so it refuses.
function inferKotlinReceiverType(maskedTestCode, receiver) {
  const r = reEsc(receiver);
  const assignRe = new RegExp(`(?<![\\w$.(])(?:(?:val|var)\\s+)?${r}\\s*(?::\\s*[\\w.<>?, ]+?)?\\s*=(?!=)`, 'g');
  return inferReceiverTypeFromCtor(maskedTestCode, assignRe, kotlinCtorAt);
}
function kotlinCtorAt(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const m = /^(?:[\w.]*\.)?([A-Z]\w*)\s*\(/.exec(s.slice(i));
  if (!m) return null;
  const { end } = balancedFrom(s, i + m[0].length - 1); // paren-balance from the ctor's '('
  return { type: m[1], end };
}

// Java: an assignment site is `[Type] RECEIVER = …` (declared type consumed but IGNORED) or a bare
// `RECEIVER = …` reassignment. The RHS constructor is `new [pkg.]ClassName(`. A declaration WITHOUT `new`
// (`Foo a = makeFoo()` factory, or `Foo a;` with no initializer) yields no constructor RHS → refuse: a
// factory's runtime type is unknowable, exactly like Kotlin. (Java has no named call arguments, so the
// `(?<![\w$.(])` guard is only defensive there.)
function inferJavaReceiverType(maskedTestCode, receiver) {
  const r = reEsc(receiver);
  const assignRe = new RegExp(`(?<![\\w$.(])(?:[A-Za-z_][\\w.<>?\\[\\], ]*\\s+)?${r}\\s*=(?!=)`, 'g');
  return inferReceiverTypeFromCtor(maskedTestCode, assignRe, javaCtorAt);
}
function javaCtorAt(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const m = /^new\s+(?:[\w.]*\.)?([A-Z]\w*)\s*\(/.exec(s.slice(i));
  if (!m) return null;
  const { end } = balancedFrom(s, i + m[0].length - 1);
  // `new X(...) { … }` — an ANONYMOUS SUBCLASS: the runtime type is the anon class (which may override
  // the method), not X, so gutting X's method could never be dispatched → refuse. (The chain-refuse in
  // inferReceiverTypeFromCtor catches a trailing `.`; this catches a trailing `{`.)
  let k = end; while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] === '{') return null;
  return { type: m[1], end };
}

// Kotlin allows a capitalized TOP-LEVEL FACTORY function with the SAME name as a class
// (`fun Foo(): Bar = Bar()` alongside `class Foo`), so a bare `Foo()` callee is constructor-vs-factory
// AMBIGUOUS: it may return a DIFFERENT runtime type than the `class Foo` constructor. kotlinCtorAt can't
// tell them apart (identical call text), so once the callee resolved to `class Foo`, this asks whether
// ANY reachable src file ALSO declares a same-named `fun Foo(` — if so, refuse (fail closed). Only fires
// when such a same-named function actually exists (rare); Java is exempt (no bare-name factory functions).
// Reachability-gated exactly like resolveJvmClass. The `fun` pattern here is declRe's Kotlin form (member,
// generic, and receiver/extension shapes all reduce to `fun … NAME(`), never a call site.
function hasReachableSameNameFun(name, testCode, srcFiles) {
  const reachable = jvmReachablePackages(testCode);
  const funRe = new RegExp(declRe(name, 'kotlin').source.split('|')[0]); // the `fun …NAME(` alternative only, not `class NAME`
  for (const f of srcFiles) {
    if (!f.endsWith('.kt')) continue; // only Kotlin has a bare `Foo()` factory-function shape
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (!reachable.has(jvmPackageOf(text))) continue;
    if (funRe.test(codeOnly(text, 'kotlin'))) return true;
  }
  return false;
}

// The single reachable src/main file that DECLARES `class ClassName` (Kotlin also accepts `object` —
// interfaces are deliberately EXCLUDED: an interface member has no gut-able body of its own, and treating
// an interface as "the" declarer of an overridable method is exactly the virtual-dispatch risk this whole
// resolver exists to avoid). Package/import-gated exactly like resolveJvmSut, and fails closed on 0 or ≥2
// reachable declaring files — never guesses between two same-named classes.
function resolveJvmClass(className, testCode, absTest, srcFiles) {
  const reachable = jvmReachablePackages(testCode);
  let testKey; try { testKey = canonKey(absTest); } catch { testKey = absTest; }
  const e = reEsc(className);
  let winner = null; let count = 0;
  for (const f of srcFiles) {
    const fileLang = f.endsWith('.kt') ? 'kotlin' : f.endsWith('.java') ? 'java' : null;
    if (!fileLang) continue;
    if (canonKey(f) === testKey) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (!reachable.has(jvmPackageOf(text))) continue;
    const masked = codeOnly(text, fileLang);
    const classRe = fileLang === 'kotlin' ? new RegExp(`\\b(?:class|object)\\s+${e}\\b`) : new RegExp(`\\bclass\\s+${e}\\b`);
    if (classRe.test(masked)) { winner = f; count++; }
  }
  if (count !== 1) return null;
  return winner;
}

// How many times `method` is DECLARED inside one specific file (reuses declRe's decl-vs-call pattern).
// Used ONLY by jvmInstanceContact (the ABSENCE probe, below) now — the MUTATION path (jvmInstanceSuts)
// uses jvmOwnPlainInstanceMember instead (docs/plans/2026-07-08-jvm-inheritance-gap.md): a file-wide
// count alone is necessary but NOT sufficient to safely gut (no class-body containment, no nesting-depth
// check, no member-kind check — see that function's header). Tightening jvmInstanceContact itself the
// same way would be UNSAFE in the opposite direction: it is an over-collection-safe absence probe, and a
// tighter count could make a block with REAL contact read as zero-contact (a new wrongLayerShadow false
// flag) — so this stays exactly as loose as before, scoped to the contact path only.
function methodDeclCountInFile(fileAbs, method) {
  const fileLang = fileAbs.endsWith('.kt') ? 'kotlin' : fileAbs.endsWith('.java') ? 'java' : null;
  if (!fileLang) return 0;
  let text; try { text = readFileSync(fileAbs, 'utf8'); } catch { return 0; }
  const re = new RegExp(declRe(method, fileLang).source, 'g');
  return (codeOnly(text, fileLang).match(re) || []).length;
}

// ---- jvmOwnPlainInstanceMember: the containment + depth + member-kind + one-hop-supertype guard that
// replaces the bare methodDeclCountInFile check in jvmInstanceSuts (docs/plans/2026-07-08-jvm-
// inheritance-gap.md — the "JVM inheritance-root false-HOLLOW gap"). methodDeclCountInFile's file-wide,
// containment-blind count is necessary but NOT sufficient: a count of 1 only proves the single site is
// the unique GUT target file-wide — not that it is the resolved class's own dispatchable instance
// member. When the real `decrypt` a receiver dispatches to is actually INHERITED from Base (another
// file) while Service's own file happens to contain exactly one OTHER same-named declaration (a
// sibling/nested class, a companion object, a top-level fun, a receiver'd extension, a java static, an
// interface default, …), the old count credits that wrong declaration — gut-time guts it, the pinned
// call still runs the untouched inherited method, and a SOUND test survives the mutant: a false HOLLOW.
// This guard closes that gap: credit only when the single site is a PLAIN instance member declared
// DIRECTLY inside the resolved class's own body, at body top level (depth 0), never receiver-prefixed
// (a kotlin extension) or `static` (java) — plus a one-hop supertype same-name guard for the override
// case (X1). Every check below is a REFUSAL path; any failure returns false, leaving the block exactly
// as unprobed as `methodDeclCountInFile(...) !== 1` used to.
// ----

const KOTLIN_HEADER_BLACKLIST = new Set([
  'fun', 'class', 'object', 'interface', 'val', 'var', 'typealias', 'import', 'package', 'return',
  'companion', 'init', 'by',
]);
const JAVA_HEADER_BLACKLIST = new Set(['class', 'interface', 'enum', 'record']);

// Header-skip → class body span (§4.3): a single forward scan from just after the class NAME token,
// blind-skipping everything inside `<...>` (generics) and `(...)` (primary-ctor params, supertype ctor
// args) depth, refusing on any depth-0 character that isn't whitespace/word/`:` (kotlin)/`,`/`.`/`@` — a
// `by` at depth 0 (kotlin) refuses the WHOLE class outright (K17: a delegate expression may take a
// trailing lambda, making the header's first depth-0 `{` indistinguishable from the real body — so the
// span can never be safely located when `by` appears). Returns `{ open, close, supertypeNames }` (the
// class body's brace span + every depth-0 CAPITALIZED token seen after the heritage clause starts —
// kotlin: after the first depth-0 `:`; java: after `extends`, stopping at `implements`/`permits`) or null
// (refuse: unparseable header, or no body at all — a bodyless Kotlin class with everything inherited).
// Over-collecting a supertype name (a `where`-clause bound, a generic type param) is safe: names are
// only ever used to REFUSE more (§4.6), never to credit.
function jvmClassBodySpan(maskedSrc, headerStart, fileLang) {
  const blacklist = fileLang === 'kotlin' ? KOTLIN_HEADER_BLACKLIST : JAVA_HEADER_BLACKLIST;
  let angle = 0, paren = 0;
  let sawColon = false;      // kotlin: seen a depth-0 ':' — the heritage clause has started
  let afterExtends = false;  // java: between 'extends' and 'implements'/'permits'/the body brace
  const supertypeNames = [];
  let tokenStart = -1;

  const flush = (endIdx) => {
    if (tokenStart < 0) return true;
    const tok = maskedSrc.slice(tokenStart, endIdx);
    tokenStart = -1;
    if (blacklist.has(tok)) return false; // ran off a bodyless header, or a fail-closed `by`
    if (fileLang === 'kotlin') {
      if (sawColon && /^[A-Z]/.test(tok)) supertypeNames.push(tok.split('.').pop());
    } else {
      if (tok === 'extends') afterExtends = true;
      else if (tok === 'implements' || tok === 'permits') afterExtends = false;
      else if (afterExtends && /^[A-Z]/.test(tok)) supertypeNames.push(tok.split('.').pop());
    }
    return true;
  };

  for (let i = headerStart; i < maskedSrc.length; i++) {
    const c = maskedSrc[i];
    if (angle > 0 || paren > 0) { // skip blind, but keep tracking nesting so we know when we're back at 0
      if (c === '<') angle++;
      else if (c === '>' && angle > 0) angle--;
      else if (c === '(') paren++;
      else if (c === ')' && paren > 0) paren--;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) { if (tokenStart < 0) tokenStart = i; continue; }
    if (!flush(i)) return null;
    if (/\s/.test(c)) continue;
    if (c === '<') { angle++; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') return null;              // a stray close paren at depth 0 — malformed header, refuse
    if (c === ':' && fileLang === 'kotlin') { sawColon = true; continue; }
    if (c === ',' || c === '.' || c === '@') continue;
    if (c === '{') {
      let depth = 0, k = i;
      for (; k < maskedSrc.length; k++) { const cc = maskedSrc[k]; if (cc === '{') depth++; else if (cc === '}') { depth--; if (depth === 0) break; } }
      if (depth !== 0) return null;           // unbalanced — refuse
      return { open: i, close: k, supertypeNames };
    }
    return null;                              // any other depth-0 character — unparseable header, refuse
  }
  return null; // EOF before a body brace — bodyless class (everything inherited), refuse
}

// Modifier back-walk (§4.5): from `siteStart` (kotlin: the index of `fun`; java: the index of the
// return-TYPE token — jvmDeclSites' `index`), walk word-tokens BACKWARDS, collecting language-modifier
// keywords and annotations (a token immediately preceded by `@`) — stopping at the first token that is
// neither, which bounds the walk WITHOUT needing a statement terminator (a Kotlin expression-bodied
// member has no `;`, so a PREVIOUS member's trailing expression, e.g. `= x + 1`, must stop the walk at
// `1`, never leaking THAT member's modifiers into this one's). `isStatic` is java-only (kotlin never
// refuses on a modifier); `hasOverride` is the kotlin `override` keyword or java's `@Override` annotation
// — consumed only by the one-hop supertype guard (§4.6).
function jvmModifierBackWalk(maskedSrc, siteStart, fileLang) {
  const modSet = fileLang === 'kotlin'
    ? new Set(['public', 'protected', 'private', 'internal', 'open', 'final', 'override', 'abstract',
      'sealed', 'suspend', 'inline', 'noinline', 'crossinline', 'operator', 'infix', 'tailrec',
      'external', 'actual', 'expect'])
    : new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native',
      'strictfp', 'default']);
  let isStatic = false, hasOverride = false;
  let i = siteStart;
  for (;;) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(maskedSrc[j])) j--;
    if (j < 0) break;
    let k = j;
    while (k >= 0 && /\w/.test(maskedSrc[k])) k--;
    const tokStart = k + 1;
    if (tokStart > j) break; // hit a non-word character immediately — nothing more to collect
    const tok = maskedSrc.slice(tokStart, j + 1);
    if (tokStart > 0 && maskedSrc[tokStart - 1] === '@') { // an annotation — always continues the walk
      if (fileLang === 'java' && tok === 'Override') hasOverride = true;
      i = tokStart - 1;
      continue;
    }
    if (modSet.has(tok)) {
      if (fileLang === 'java' && tok === 'static') isStatic = true;
      if (fileLang === 'kotlin' && tok === 'override') hasOverride = true;
      i = tokStart;
      continue;
    }
    break; // first non-modifier, non-annotation token — stop (never leak a PRIOR member's modifiers in)
  }
  return { isStatic, hasOverride };
}

// jvmOwnPlainInstanceMember(classFileAbs, className, method, testCode, absTest, srcFiles) → boolean.
// §4.2–§4.7's closed invariant: credit `method` against the resolved class file only if its file-wide
// site count is exactly 1, that single site is a plain instance member declared DIRECTLY in the class's
// OWN body at top level, the class is a `class` (never a kotlin `object` — K9: `Service()` on an object
// is invoke-operator sugar, so the runtime type is unknowable) declared exactly once in the file, the
// header parses under the fail-closed skip rule, the file's masked text brace-balances, and — for the
// override case — the one-hop supertype same-name guard (X1) clears. Any failing check → refuse.
export function jvmOwnPlainInstanceMember(classFileAbs, className, method, testCode, absTest, srcFiles) {
  const fileLang = classFileAbs.endsWith('.kt') ? 'kotlin' : classFileAbs.endsWith('.java') ? 'java' : null;
  if (!fileLang) return false;
  let text; try { text = readFileSync(classFileAbs, 'utf8'); } catch { return false; }
  const maskedSrc = codeOnly(text, fileLang);

  // §4.7 global brace-balance sanity — before any span work, so a leaked brace (a Kotlin string-template
  // interpolation nesting a quote, an unlexed Java text block) can't desync the span/depth math below.
  let bal = 0;
  for (const c of maskedSrc) {
    if (c === '{') bal++;
    else if (c === '}') { bal--; if (bal < 0) return false; }
  }
  if (bal !== 0) return false;

  // §4.2 class location — exactly one `class|object NAME` (kotlin) / `class NAME` (java) in the file; a
  // resolved `object` (incl. `companion object NAME`) refuses outright (K9).
  const e = reEsc(className);
  const classRe = fileLang === 'kotlin' ? new RegExp(`\\b(class|object)\\s+${e}\\b`, 'g') : new RegExp(`\\b(class)\\s+${e}\\b`, 'g');
  const classMatches = [...maskedSrc.matchAll(classRe)];
  if (classMatches.length !== 1) return false;
  const classMatch = classMatches[0];
  if (fileLang === 'kotlin' && classMatch[1] === 'object') return false;

  // §4.3 header-skip → body span
  const span = jvmClassBodySpan(maskedSrc, classMatch.index + classMatch[0].length, fileLang);
  if (!span) return false;
  const { open, close, supertypeNames } = span;

  // §4.4 site containment + depth — file-wide site count must be exactly 1 (subsumes the old overload
  // rule: gut-time guts the FIRST body-site in the file, so a second site anywhere means gut-time may hit
  // the wrong one), that site inside THIS class's own span, at body top level (depth 0).
  const sites = jvmDeclSites(text, method, fileLang);
  if (sites.length !== 1) return false;
  const [site] = sites;
  if (!(site.index > open && site.index < close)) return false;
  let nestDepth = 0;
  for (let k = open + 1; k < site.index; k++) { const c = maskedSrc[k]; if (c === '{') nestDepth++; else if (c === '}') nestDepth--; }
  if (nestDepth !== 0) return false;

  // §4.5 member-kind — a receiver-prefixed (kotlin extension) site is never THIS class's own dispatchable
  // member; a java `static` site is refused (an instance receiver call could still legally hit a
  // same-named STATIC, but whether an instance overload also exists in the hierarchy is unknowable).
  if (site.receiverPrefixed) return false;
  const { isStatic, hasOverride } = jvmModifierBackWalk(maskedSrc, site.index, fileLang);
  if (fileLang === 'java' && isStatic) return false;

  // §4.6 one-hop supertype same-name guard (X1) — a resolvable direct parent that ALSO declares `method`
  // makes the override case dispatch-ambiguous unless this site is a marked override AND the parent
  // declares it exactly once (dispatch-by-signature is otherwise unknowable even for an override).
  // Unresolvable (library/interface) parents are status-quo residue — skipped, never refused.
  for (const name of supertypeNames) {
    const parentFileAbs = resolveJvmClass(name, testCode, absTest, srcFiles);
    if (!parentFileAbs) continue;
    const parentLang = parentFileAbs.endsWith('.kt') ? 'kotlin' : parentFileAbs.endsWith('.java') ? 'java' : null;
    if (!parentLang) continue;
    let parentText; try { parentText = readFileSync(parentFileAbs, 'utf8'); } catch { continue; }
    const parentSiteCount = jvmDeclSites(parentText, method, parentLang).length;
    if (parentSiteCount === 0) continue;
    if (parentSiteCount >= 2) return false;
    if (!hasOverride) return false;
  }
  return true;
}

// jvmCreditTypeMethod(type, method, testCode, absTest, srcFiles, dir, lang) → sutRel | null.
// The SHARED tail of the JVM type->method credit chain — extracted verbatim from jvmInstanceSuts's
// variable-path loop body (T3) so the INLINE path (Kotlin `X(...).m(...)`, Java `new X(...).m(...)`) can
// never diverge from it: both callers resolve `type` however they see fit (variable: inferKotlinReceiverType
// / inferJavaReceiverType from a constructor-assignment, reused unchanged; inline: read directly off the
// ctor at the call site) and then hand it, with the called `method` name, to this ONE function. Every
// branch below is a REFUSAL (returns null) — the only success return is the resolved SUT's path relative
// to `dir`. The Kotlin capitalized-factory-vs-class guard (hasReachableSameNameFun) lives HERE, not in
// either caller, so the inline path can never skip it — the exact hazard T3 exists to close.
function jvmCreditTypeMethod(type, method, testCode, absTest, srcFiles, dir, lang) {
  const classFileAbs = resolveJvmClass(type, testCode, absTest, srcFiles);
  if (!classFileAbs) return null; // unreachable / undeclared / declared in ≥2 reachable files
  // Kotlin capitalized-factory-vs-class collision: if a same-named `fun <type>(` is reachable, the
  // `type()` callee is constructor-vs-factory ambiguous (may return a different runtime type) → refuse.
  if (lang === 'kotlin' && hasReachableSameNameFun(type, testCode, srcFiles)) return null;
  // The method must be a PLAIN INSTANCE member declared DIRECTLY in the RUNTIME class's OWN body: an
  // INHERITED method (declared only in a superclass) is refused — we can only safely gut a body the
  // constructed class itself declares or overrides. jvmOwnPlainInstanceMember (docs/plans/2026-07-08-
  // jvm-inheritance-gap.md) also subsumes the old file-wide overload guard AND closes the inheritance-
  // root gap a bare declaration COUNT left open (a same-named sibling/nested/companion/extension/static
  // declaration elsewhere in the file could satisfy a count of 1 while being the WRONG gut target).
  if (!jvmOwnPlainInstanceMember(classFileAbs, type, method, testCode, absTest, srcFiles)) return null;
  return toPosix(relative(dir, classFileAbs));
}

// jvmInstanceSuts(body, testCode, absTest, srcFiles, dir, lang) → [{fn, sutRel, rel?}], one entry per
// pinned lowercase-receiver instance call this block makes that could be resolved SAFELY end-to-end.
// `body` is THIS block's own source (scopes the pinned-call scan to calls this specific test actually
// makes); `testCode` is the WHOLE test file (scopes the receiver's type inference across block-local
// construction AND class-field/@BeforeEach setup). Runs only for lang 'kotlin'/'java' — every other
// caller (JS/py/no-lang) gets `[]` and this function is otherwise never reached (see prove()'s block
// loop), so JS/TS/Python behavior stays byte-identical. Purely ADDITIVE: the caller merges this with the
// existing bare-name eligible list, deduped by (fn, sutRel) — it never removes anything sutFnsIn/
// resolveJvmSut already found.
// Per-kind crediting (relational-assert reach): value fragments are scanned FIRST, relational SECOND, so
// a (method, sutRel) pair reachable through both kinds is credited as a VALUE entry (the `seen` dedupe
// keeps whichever kind got there first) — a relational credit can prove but never convict, so letting a
// value credit win is the safe direction. `rel` is omitted (not `false`) on a value entry, so every
// pre-existing (value-only) caller's `{fn, sutRel}` shape stays byte-identical.
export function jvmInstanceSuts(body, testCode, absTest, srcFiles, dir, lang) {
  if (lang !== 'kotlin' && lang !== 'java') return [];
  const maskedTestCode = codeOnly(testCode, lang);
  const byKind = pinnedFragmentsByKind(body, undefined, lang); // masks its own copy of `body`
  const out = []; const seen = new Set();
  const credit = (method, sutRel, rel) => {
    const key = method + '::' + sutRel;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rel ? { fn: method, sutRel, rel: true } : { fn: method, sutRel });
  };
  for (const [frags, rel] of [[byKind.value, false], [byKind.relational, true]]) {
    for (const frag of frags) {
      for (const { receiver, method } of instanceCallsIn(frag)) {
        const type = lang === 'kotlin' ? inferKotlinReceiverType(maskedTestCode, receiver) : inferJavaReceiverType(maskedTestCode, receiver);
        if (!type) continue; // runtime type not a directly-visible constructor (annotation/factory/chain/ambiguous) — skip
        const sutRel = jvmCreditTypeMethod(type, method, testCode, absTest, srcFiles, dir, lang);
        if (!sutRel) continue;
        credit(method, sutRel, rel);
      }
      // INLINE receiver (T3): Kotlin `X(...).m(...)` / Java `new X(...).m(...)` directly in this same
      // pinned fragment — no assignment, no variable. Routed through the IDENTICAL shared credit chain
      // above (jvmCreditTypeMethod) — a wrong-target inline credit is exactly as much a false verdict as a
      // wrong-target variable credit, so it gets exactly the same guards, never fewer. Frags only (no hop
      // infra on JVM — documented asymmetry with JS, not a correctness issue: pinnedFragments already
      // masks/scopes the pinned assertion text, and JVM has no bare-var-hop discipline to mirror).
      for (const { type, method } of jvmInlineCtorMethodCallsIn(frag, lang)) {
        const sutRel = jvmCreditTypeMethod(type, method, testCode, absTest, srcFiles, dir, lang);
        if (!sutRel) continue;
        credit(method, sutRel, rel);
      }
    }
  }
  return out;
}

// jvmInlineCtorMethodCallsIn(frag, lang) — INLINE constructor-receiver'd instance calls in an
// already-masked pinned fragment: Kotlin `X(...).m(...)`, Java `new X(...).m(...)`. Returns
// [{ type, method }] pairs (never resolves anything — resolution/credit is jvmCreditTypeMethod's job,
// identical to the variable path).
//
// The ctor parse REUSES kotlinCtorAt/javaCtorAt unchanged, at a boundary-checked simple-name scan
// position (`(?<![\w$.])`): for Kotlin this sits right on the capitalized class-name character itself;
// for Java it sits on the `new` keyword (javaCtorAt then re-parses `new\s+NAME(` from there, exactly as
// the variable path's ctorAt calls do). A dotted/qualified name (`pkg.X()`, `new ns.X()`) is therefore
// never even found: Kotlin's boundary fails immediately (the name character is preceded by `.`), and
// Java's scan regex requires the character right after `new`+whitespace to be `[A-Z]` — a lowercase
// package segment there (`new ns.X(`) fails outright — same documented under-reach as jsCtorAt on the JS
// path. Kotlin additionally refuses when the previous non-whitespace character is `:` — the heritage /
// object-expression position (`class Foo : X() {}`, `(object : X() {}) `) where `X(...)` is a supertype
// constructor delegation, not an inline receiver construction (belt-and-suspenders: the next-non-ws-must-
// be-`.` check below already refuses every realistic occurrence of this shape too, since a heritage/
// object-expression `X(...)` is always immediately followed by a class/object body `{`).
//
// Two boundary checks (identical discipline to jsInlineCtorMethodCallsIn) make this closed and
// fail-closed:
//   - the first non-whitespace character after the ctor's balanced `)` must be EXACTLY `.` — excludes a
//     bare ctor with no method call, Kotlin's trailing-lambda `X() { }.m()` and `object : X() {…}.m()`
//     (both leave `{` there), and Java's anonymous-subclass `new X(){ … }.m()` (already independently
//     refused inside javaCtorAt's own trailing-`{` check — this is belt-and-suspenders for Java).
//   - the first non-whitespace character after the METHOD call's own balanced `)` must be NONE of
//     `. ? ! {` — excludes a chained `X().m().n()` (refuses `m`; `n`'s receiver is `m`'s return, never
//     reached — this scanner only pairs a method with an IMMEDIATELY preceding ctor), a builder chain
//     `X().build().m()`, Kotlin's `X()!!.m()`, and (defensively) a trailing `{`.
//
// A ctor not immediately followed by `.NAME(` (a bare ctor argument, a property/field access, a method
// reference with no call parens) is simply never emitted — "no credit" per §5.1, not a refusal path.
function jvmInlineCtorMethodCallsIn(frag, lang) {
  const out = [];
  const scanRe = lang === 'java' ? /(?<![\w$.])new\s+[A-Z]/g : /(?<![\w$.])[A-Z]\w*\s*\(/g;
  for (const m of frag.matchAll(scanRe)) {
    if (lang === 'kotlin') {
      let p = m.index - 1;
      while (p >= 0 && /\s/.test(frag[p])) p--;
      if (frag[p] === ':') continue; // heritage / object-expression position
    }
    const c = lang === 'java' ? javaCtorAt(frag, m.index) : kotlinCtorAt(frag, m.index);
    if (!c) continue;
    let i = c.end;
    while (i < frag.length && /\s/.test(frag[i])) i++;
    if (frag[i] !== '.') continue; // not immediately followed by a member access
    i++;
    while (i < frag.length && /\s/.test(frag[i])) i++;
    const mm = /^([A-Za-z_$][\w$]*)\s*\(/.exec(frag.slice(i));
    if (!mm) continue; // property/field access, or a method reference with no call parens
    const methodParenOpen = i + mm[0].length - 1;
    const { end: methodEnd } = balancedFrom(frag, methodParenOpen);
    let j = methodEnd;
    while (j < frag.length && /\s/.test(frag[j])) j++;
    const nc = frag[j];
    if (nc === '.' || nc === '?' || nc === '!' || nc === '{') continue; // chained/optional/non-null refusal
    out.push({ type: c.type, method: mm[1] });
  }
  return out;
}

// ---- JS/TS INSTANCE-method SUT resolution (Task B1 / T3): `service.decrypt(service.encrypt(x))` on a
// receiver constructed via `new Service(...)` ----
// Mirrors jvmInstanceSuts's core idea (resolve the receiver's RUNTIME type from a directly-visible
// constructor call, never a guess) via the SAME shared inferReceiverTypeFromCtor helper. JS/TS's binding
// model needs strictly MORE guards than JVM's package-reachability wall, because ordinary JS values have
// no such wall at all: a mock/spy/stub is just an object, a receiver can be shadowed by a callback
// parameter, and locateBody's "pass 1 wins outright" rule means a helper fn plus a same-named class
// method must be counted TOGETHER (jsDeclSites) — and the single site (if unique) must also lie inside
// the RESOLVED class's own body, not merely be unique file-wide (an inherited method can leave its only
// same-named sibling site in an unrelated class — see guard (g) below) — or a credit could resolve to a
// declaration site gut-time would never actually break. Every step below is a REFUSAL path; this function only ever ADDS
// a receiver-resolved (fn, sutRel) pair when every single guard clears — any failure anywhere leaves the
// block exactly as unprobed as it is today (skipped/no-pin), never a wrong verdict.
//
// File-wide mock-framework taint: masking blanks the spec STRING but not the call identifiers, so the
// shape of `jest.mock(...)`/`sinon.stub(...)`/etc. survives masking even when its argument doesn't. A
// partial module factory (`jest.mock('./s.mjs', () => ({ Service: class { decrypt(){return 42} } }))`)
// makes `new Service()` construct the MOCK while the text still says `new Service(...)` — no per-call
// guard below can see through that, so the gate is deliberately coarse: ANY mock-framework call anywhere
// in the test file refuses EVERY instance credit in it, never just the tainted spec.
const MOCK_TAINT = /\b(?:jest|vi)\s*\.\s*(?:mock|doMock|unstable_mockModule|spyOn)\s*\(|\bsinon\s*\.\s*(?:stub|mock|replace|replaceGetter|fake)\s*\(|\b(?:proxyquire|rewiremock)\b|\bmock\s*\.\s*module\s*\(/;

// JS constructor-assignment site: `[const|let|var] RECEIVER = …` (a declaration) or a bare `RECEIVER = …`
// reassignment — the `(?![=>])` excludes `==`/`===`/`=>` so an equality check or an arrow body starting
// right at the receiver's name can never be mistaken for an assignment. Mirrors inferJavaReceiverType's
// assignRe shape (JS has no declared-type annotation to consume, so there is nothing to skip there).
function jsAssignRe(receiver) {
  const r = reEsc(receiver);
  return new RegExp(`(?<![\\w$.])(?:(?:const|let|var)\\s+)?${r}\\s*=(?![=>])`, 'g');
}
// JS constructor call at position i: `new ClassName(` with a Capitalized simple name — deliberately NO
// dotted prefix (`new ns.Service()` refuses: the namespace slice is deferred, and the import-binding
// check below is only sound for a plain identifier bound directly by `imports`). Paren-balances to `end`
// exactly like javaCtorAt; JS has no `new X(){}` anonymous-subclass form, so there is no analogous
// trailing-`{` refusal — the shared inferReceiverTypeFromCtor's trailing-`.` chain refusal alone covers
// `new Service().withX()`.
function jsCtorAt(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const m = /^new\s+([A-Z][\w$]*)\s*\(/.exec(s.slice(i));
  if (!m) return null;
  const { end } = balancedFrom(s, i + m[0].length - 1);
  return { type: m[1], end };
}
// Every parameter name bound ANYWHERE in the masked test file (arrow — parenthesised or bare-single-arg —
// and `function` forms). Deliberately OVER-collects (destructuring/rest tokens and defaults are stripped
// or skipped, never partially matched into a false name) — a param-name guard only ever REFUSES a
// receiver, so over-collection can only reduce reach, never mis-credit.
function jsParamNames(maskedTestCode) {
  const names = new Set();
  const addList = (list) => {
    for (let part of list.split(',')) {
      part = part.trim().split('=')[0].trim(); // strip a default value
      if (/^[A-Za-z_$][\w$]*$/.test(part)) names.add(part); // skip destructuring `{..}`/`[..]` and rest `...x` shapes
    }
  };
  for (const m of maskedTestCode.matchAll(/\(([^()]*)\)\s*=>/g)) if (m[1].trim()) addList(m[1]);
  for (const m of maskedTestCode.matchAll(/\bfunction\b[^(]*\(([^()]*)\)/g)) if (m[1].trim()) addList(m[1]);
  for (const m of maskedTestCode.matchAll(/(?<![\w$.)])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}

// jsCreditTypeMethod(type, method, maskedTestCode, absTest, srcFiles, imports, dir) → sutRel | null.
// The SHARED tail of the type->method credit chain — guards (d)(e)(e2)(f)(g)(g2)(g3) plus the new §8.1
// shadow guard — extracted verbatim from jsInstanceSuts's variable-path loop body so the INLINE path
// (`new X().m()`, T2) can never diverge from it: both callers resolve `type` however they see fit
// (variable: infer from a constructor-assignment; inline: read directly off the `new X(` at the call
// site) and then hand it, with the called `method` name, to this ONE function. Every branch below is a
// REFUSAL (returns null) — the only success return is the resolved SUT's path relative to `dir`.
function jsCreditTypeMethod(type, method, maskedTestCode, absTest, srcFiles, imports, dir) {
  // (d) class binding: only a RELATIVE import binds — test-local classes, bare deps, globals refuse.
  const spec = imports.get(type);
  if (!spec || !isRelative(spec)) return null; // fixture 12 (locally-declared class)
  const targets = resolveRelative(absTest, spec);
  let selfKey; try { selfKey = canonKey(absTest); } catch { selfKey = absTest; }
  let classFileAbs = null; let classFileCount = 0;
  for (const f of srcFiles) {
    if (!targets.has(canonKey(f))) continue;
    if (canonKey(f) === selfKey) continue; // never resolve to the test file itself
    classFileCount++; classFileAbs = f;
  }
  if (classFileCount !== 1) return null; // 0: unresolved; >=2: ambiguous extension match

  // (e) the class must be declared in the resolved file EXACTLY once (0: barrel/re-export; >=2: ambiguous).
  let srcCode; try { srcCode = readFileSync(classFileAbs, 'utf8'); } catch { return null; }
  const maskedSrc = codeOnly(srcCode, 'typescript');
  const classMatches = [...maskedSrc.matchAll(new RegExp(`\\bclass\\s+${reEsc(type)}\\b`, 'g'))];
  if (classMatches.length !== 1) return null; // fixture 13

  // (e2) class-BODY containment span (T3 false-HOLLOW fix): a decl-site count of 1 (guard (g) below)
  // only guarantees the site is the unique gut TARGET file-wide — not that it lies inside THIS
  // class's own body. An inherited method (declared on a base class, possibly in another file) can
  // leave exactly one same-named SIBLING decl site in this file — e.g. `class Service extends Base {}`
  // (decrypt lives on Base) plus an unrelated `class LegacyCodec { decrypt(){} }`: jsDeclSites finds
  // exactly one `decrypt` site, but it is LegacyCodec's, not Service's — gutting it never touches the
  // dispatch path the test actually exercises, so the mutant survives and a sound test reads as a
  // false HOLLOW. Require the head immediately after the class name to be a PLAIN optional single
  // heritage clause (`extends Name` or `extends Name.Name...`, optionally dotted) followed by `{` —
  // `extends (class {})`, `extends mixin(Base)`, `implements X`, or any other shape refuses outright
  // (can't safely locate a body span). Brace-match from that `{`; unbalanced → refuse. Fail-closed
  // direction accepted: a same-file `class Base { decrypt(){} } class Service extends Base {}` also
  // now refuses (the site is inside Base's span, not Service's) even though crediting would happen to
  // be sound there — correctness over reach.
  const classMatch = classMatches[0];
  const afterClassName = maskedSrc.slice(classMatch.index + classMatch[0].length);
  const headM = /^\s*(?:extends\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)?\s*\{/.exec(afterClassName);
  if (!headM) return null; // non-plain heritage clause — cannot safely locate the body span
  const openBrace = classMatch.index + classMatch[0].length + headM[0].length - 1;
  let braceDepth = 0, closeBrace = -1;
  for (let k = openBrace; k < maskedSrc.length; k++) {
    const c = maskedSrc[k];
    if (c === '{') braceDepth++;
    else if (c === '}') { braceDepth--; if (braceDepth === 0) { closeBrace = k; break; } }
  }
  if (closeBrace === -1) return null; // unbalanced braces — refuse

  // (f) ctor-name taint: `Service.prototype.decrypt = …` anywhere in the test file.
  if (new RegExp(`\\b${reEsc(type)}\\s*\\.\\s*prototype\\b`).test(maskedTestCode)) return null; // fixture 5

  // (g) method-decl uniqueness, located with the prober's OWN patterns — the single invariant that
  // makes fixture 14 (helper fn + same-named class method) safe: gut-time locateBody would silently
  // gut the helper (pass 1 wins outright) while the class method stays live, so crediting here must
  // see BOTH sites and refuse, not just the one pass-2 would find on its own. AND (fixture 16) the
  // one surviving site must fall STRICTLY inside this class's own brace span (e2 above) — a unique
  // site that resolves to a sibling class or an inherited base is not this class's own declaration.
  const sites = jsDeclSites(srcCode, method);
  if (sites.length !== 1) return null;
  const [site] = sites;
  if (!(site > openBrace && site < closeBrace)) return null; // fixture 16: site outside THIS class's body

  // (g2) direct-member depth (fixture 16b): the single decl site must sit at the class body's TOP level,
  // not nested inside a method body, object literal, or inner class/function (those fall within the
  // brace span but are NOT the class's own dispatchable member — gutting them never touches
  // service.method(...) dispatch → false HOLLOW).
  let nestDepth = 0;
  for (let k = openBrace + 1; k < site; k++) { const c = maskedSrc[k]; if (c === '{') nestDepth++; else if (c === '}') nestDepth--; }
  if (nestDepth !== 0) return null;

  // (g3) PLAIN INSTANCE member only. service.decrypt(x) dispatches to the instance method on the prototype
  // chain, so a same-named STATIC field, PRIVATE (#) member, or get/set ACCESSOR at depth 0 is NOT that
  // target — when the real decrypt is inherited from a base, gut-time guts the wrong member → false HOLLOW.
  // Pass-2 method sites already require a { ; } boundary before the name (so static/get/set/# METHODS are
  // never sites); only a pass-1 field-initializer (`decrypt = …`, anchored on the NAME) can smuggle one in,
  // so re-scan the member header back to the previous boundary.
  if (maskedSrc[site - 1] === '#') return null;                        // private (#) field member
  let hdr = site - 1;
  while (hdr > openBrace && /[\w$\s]/.test(maskedSrc[hdr])) hdr--;
  if (/\b(?:static|get|set)\b/.test(maskedSrc.slice(hdr, site))) return null; // static field / accessor header

  // (§8.1, new) test-file ctor-name shadow: `class X { … }` declared INSIDE the test file (any scope —
  // this is a textual scan over the whole masked test file, so a block-scoped class shadowing the import
  // still matches), or a bare re-assignment `X = …`, means the identifier `X` the test actually references
  // at runtime may not be the imported src class at all — a JS `class`/`const X =` declared in an inner
  // scope shadows the outer import for every reference inside that scope, and this function has no scope
  // tracker to tell "shadowed here" from "not shadowed". Refusing on ANY such declaration anywhere in the
  // file is the fail-closed call: crediting would otherwise gut the imported file's method while the
  // test's `s.decrypt()` dispatches to the shadow copy — mutant survives, sound test reads as a false
  // HOLLOW (confirmed live pre-fix: `test('x', () => { class Service { decrypt(){return 42} } const s =
  // new Service(); expect(s.decrypt()).toBe(42); })` with `Service` also imported from src credited
  // (decrypt, src/service.mjs) and the e2e read `caught: 0, hollow: [...{survivors:['decrypt']}]`). The
  // `(?<![\w$.])` boundary on the assign form excludes a member access (`x.Service = …`) and a dotted
  // qualifier; `(?![=>])` excludes `==`/`===`/`=>` so an equality check or an arrow body starting right at
  // the name is never mistaken for an assignment.
  if (new RegExp(`\\bclass\\s+${reEsc(type)}\\b`).test(maskedTestCode)) return null;
  if (new RegExp(`(?<![\\w$.])${reEsc(type)}\\s*=(?![=>])`).test(maskedTestCode)) return null;

  return toPosix(relative(dir, classFileAbs));
}

// jsInstanceSuts(body, testCode, absTest, srcFiles, imports, dir) → [{fn, sutRel, rel?}], one entry per
// pinned receiver'd instance call this block makes that resolves SAFELY end-to-end. `body` is THIS
// block's own source (scopes the pinned-call scan to calls this specific test actually makes); `testCode`
// is the WHOLE test file (scopes the receiver's constructor-assignment scan across block-local
// construction AND a shared `beforeEach`/field setup). JS/TS only — the caller never reaches this for
// Python/JVM (see prove()'s block loop), so those paths stay byte-identical. Purely ADDITIVE: the caller
// merges this with the existing bare-name eligible list, deduped by (fn, sutRel) — it never removes
// anything sutFnsIn/resolveSut already found, and it never adds a bare name to candidateFns.
// Per-kind crediting (relational-assert reach, Task 6, mirrors jvmInstanceSuts): value fragments are
// scanned FIRST, relational SECOND, so a (method, sutRel) pair reachable through both kinds is credited
// as a VALUE entry (the `seen` dedupe keeps whichever kind got there first) — a relational credit can
// prove but never convict, so letting a value credit win is the safe direction. `rel` is omitted (not
// `false`) on a value entry, so every pre-existing (value-only) caller's `{fn, sutRel}` shape stays
// byte-identical. File-level pre-computation (maskedTestCode/MOCK_TAINT/paramNames/masked) stays outside
// the kind loop — only fragment-derived inputs (bareVars, texts) rebuild per kind.
export function jsInstanceSuts(body, testCode, absTest, srcFiles, imports, dir) {
  const maskedTestCode = codeOnly(testCode, 'typescript');
  if (MOCK_TAINT.test(maskedTestCode)) return []; // file-wide mock-framework taint (fixture 3)
  const paramNames = jsParamNames(maskedTestCode);

  const masked = codeOnly(body, 'typescript');
  const byKind = pinnedFragmentsByKind(masked, imports); // masks its own (already-masked) copy of `body`

  const out = []; const seen = new Set();
  const credit = (method, sutRel, rel) => {
    const key = method + '::' + sutRel;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rel ? { fn: method, sutRel, rel: true } : { fn: method, sutRel });
  };
  for (const [frags, rel] of [[byKind.value, false], [byKind.relational, true]]) {
    if (!frags.length) continue;

    // one variable hop, mirroring eligibleFns' own bare-var hop: a pinned bare var assigned (same-line,
    // single-assignment only) from an instance-call RHS. bareVars is the set of identifiers appearing
    // anywhere in a pinned fragment (over-inclusive-but-safe, same discipline as eligibleFns).
    const bareVars = new Set();
    for (const f of frags) for (const v of f.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\b/g)) bareVars.add(v[1]);
    const texts = [...frags];
    // Arrow-aware annotation-skip group — same fix, same reasoning, as eligibleFns' const/let/var hop.
    for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*(?:=>|[^=\n])+?)?[^\S\n]*=(?!>)[^\S\n]*([^\n;]+)/g)) {
      if (!bareVars.has(m[1])) continue;
      // reassigned pinned var (fixture 15): >1 assignment to this name anywhere in the masked block body
      // means the pinned value may not be THIS declaration's RHS result at all — refuse the hop outright,
      // stricter than the existing bare-name hop (never retrofit that shipped behavior this cycle).
      // The count regex carries the SAME arrow-aware annotation-skip group between the name and `=`: without
      // it, an ANNOTATED declaration's own `=` never matched (the `: Type` sits in between), so an annotated
      // `let c: Calc = new Calc()` reassigned once elsewhere read asnCount 1 instead of 2 — the declaration's
      // own assignment silently uncounted — and this guard failed to fire on a genuinely ambiguous pin.
      const asnCount = (masked.match(new RegExp(`(?<![\\w$.])${reEsc(m[1])}(?:\\s*:\\s*(?:=>|[^=\\n])+?)?\\s*=(?![=>])`, 'g')) || []).length;
      if (asnCount > 1) continue;
      texts.push(m[2]);
    }

    for (const text of texts) {
      if (hasTopLevelShortCircuit(text)) continue; // dead-branch refusal (fixture 8), every scan text
      for (const { receiver, method } of instanceCallsIn(text)) {
        if (paramNames.has(receiver)) continue; // (a) receiver shadowed by a callback param (fixture 9)

        // (b) receiver-taint: monkey-patch (`service.decrypt = …`) or Object.assign/defineProperty(receiver, …)
        const recvE = reEsc(receiver);
        const monkeyPatched = new RegExp(`\\b${recvE}\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=(?![=>])`).test(maskedTestCode);
        const objectPatched = new RegExp(`\\bObject\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\\s*\\(\\s*${recvE}\\b`).test(maskedTestCode);
        if (monkeyPatched || objectPatched) continue; // fixture 4

        // (c) runtime type from a directly-visible constructor call — REUSES the shared helper untouched.
        const type = inferReceiverTypeFromCtor(maskedTestCode, jsAssignRe(receiver), jsCtorAt);
        if (!type) continue; // mock/factory/reassigned-to-non-ctor/two-ctor-types (fixtures 1,2,10,11)

        // (d)-(g3)+(§8.1): the shared type->method credit chain (T1 extraction) — identical for variable
        // and inline receivers.
        const sutRel = jsCreditTypeMethod(type, method, maskedTestCode, absTest, srcFiles, imports, dir);
        if (!sutRel) continue;
        credit(method, sutRel, rel);
      }
      // INLINE receiver (T2): `new X(...).m(...)` directly in this same pinned fragment / hop-RHS text — no
      // assignment, no variable. Scanned under the SAME hasTopLevelShortCircuit/MOCK_TAINT gates as the
      // variable path above (the taint gate is checked once at function top; short-circuit just above), then
      // routed through the identical shared credit chain — a wrong-target inline credit is exactly as much a
      // false verdict as a wrong-target variable credit, so it gets exactly the same guards, never fewer.
      for (const { type, method } of jsInlineCtorMethodCallsIn(text)) {
        const sutRel = jsCreditTypeMethod(type, method, maskedTestCode, absTest, srcFiles, imports, dir);
        if (!sutRel) continue;
        credit(method, sutRel, rel);
      }
    }
  }
  return out;
}

// jsInlineCtorMethodCallsIn(text) — INLINE constructor-receiver'd instance calls in a pinned fragment or
// hop-RHS text: `new X(...).m(...)`, no assignment, no variable. Returns [{ type, method }] pairs (never
// resolves anything — resolution/credit is jsCreditTypeMethod's job, identical to the variable path).
// The ctor parse REUSES jsCtorAt unchanged (simple Capitalized name, no dots, paren-balanced — so a
// generic `new X<T>()` or a dotted `new ns.X()` never matches at all, same documented under-reach as the
// variable path's ctorAt calls). Two boundary checks make this a closed, fail-closed scanner rather than a
// loose "any ctor near any call" match:
//   - the first non-whitespace character after the ctor's balanced `)` must be EXACTLY `.` — excludes a
//     bare `new X()` with no method call, an optional chain `new X()?.m()`, and (JS has no `new X(){}`
//     anonymous-subclass form) leaves nothing else to exclude here.
//   - the first non-whitespace character after the METHOD call's own balanced `)` must be NONE of
//     `. ? ! {` — excludes a chained `new X().m().n()` (refuses `m`; `n`'s receiver is `m`'s return, which
//     this scanner never even reaches, since it only ever pairs a method with an IMMEDIATELY preceding
//     ctor), an optional-chained continuation, a TS non-null assertion `new X().m()!`, and (defensively;
//     JS has no legal inline-ctor shape producing this) a trailing `{`.
// A ctor not immediately followed by `.NAME(` (a bare `new X()` argument, `new X().value` property access,
// `new X().m` with no call parens) is simply never emitted — "no credit" per §5.1, not a refusal path.
function jsInlineCtorMethodCallsIn(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w$.])new\s+[A-Z]/g)) {
    const c = jsCtorAt(text, m.index);
    if (!c) continue;
    let i = c.end;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '.') continue; // not immediately followed by a member access
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    const mm = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(i));
    if (!mm) continue; // property access, or a method reference with no call parens
    const methodParenOpen = i + mm[0].length - 1;
    const { end: methodEnd } = balancedFrom(text, methodParenOpen);
    let j = methodEnd;
    while (j < text.length && /\s/.test(text[j])) j++;
    const nc = text[j];
    if (nc === '.' || nc === '?' || nc === '!' || nc === '{') continue; // chained/optional/non-null refusal
    out.push({ type: c.type, method: mm[1] });
  }
  return out;
}

// ---- wrongLayerShadow: zero-production-contact ABSENCE probe (Task: wrongLayerShadow) ----
// Reuses the SAME SUT resolvers the mutation path uses (resolveJvmSut/resolveJvmClass/jvmInstanceSuts's
// own inference helpers/resolveSut/resolvePySut), but as an ABSENCE probe: it is safe to over-collect
// candidates here (finding MORE candidate contact only makes a block LESS likely to be flagged, never
// more), so — unlike jvmInstanceSuts, which is scoped to PINNED (asserted) fragments for gutting safety —
// this scans EVERY lowercase-receiver instance call in the WHOLE block, asserted or not.
function jvmInstanceContact(bodyMasked, testCode, absTest, srcFiles, lang) {
  const maskedTestCode = codeOnly(testCode, lang);
  for (const { receiver, method } of instanceCallsIn(bodyMasked)) {
    const type = lang === 'kotlin' ? inferKotlinReceiverType(maskedTestCode, receiver) : inferJavaReceiverType(maskedTestCode, receiver);
    if (!type) continue;
    const classFileAbs = resolveJvmClass(type, testCode, absTest, srcFiles);
    if (!classFileAbs) continue;
    if (lang === 'kotlin' && hasReachableSameNameFun(type, testCode, srcFiles)) continue;
    if (methodDeclCountInFile(classFileAbs, method) !== 1) continue;
    return true; // resolves to a real src/main declaration — contact found
  }
  return false;
}
// hasProductionContact(rawBody, ctx) → true iff ANY call/class-reference in rawBody resolves to a src/main
// declaration via the existing resolvers, used as an ABSENCE probe (zero production contact = every
// candidate name in the block fails to resolve). `ctx`: { lang: 'kotlin'|'java'|'python'|undefined(JS),
// testCode, absTest, srcFiles, dir, imports (JS Map), pyImports (py imports array), resolveSut (JS
// resolver closure) }. Exported for direct unit testing (mirrors resolveJvmSut/jvmInstanceSuts's own
// testing convention — no runner/gradle/pytest invocation needed, this never executes anything).
export function hasProductionContact(rawBody, ctx) {
  const jvmLang = ctx.lang === 'kotlin' || ctx.lang === 'java' ? ctx.lang : undefined;
  const bodyMasked = codeOnly(rawBody, jvmLang || 'typescript');
  for (const name of sutFnsIn(bodyMasked, jvmLang)) {
    if (jvmLang) { if (resolveJvmSut(name, ctx.testCode, ctx.absTest, ctx.srcFiles, ctx.dir, jvmLang)) return true; }
    else if (ctx.lang === 'python') { if (resolvePySut(name, ctx.pyImports, ctx.absTest, ctx.srcFiles, ctx.dir)) return true; }
    else if (ctx.resolveSut(name, ctx.absTest, ctx.imports)) return true;
  }
  if (jvmLang && jvmInstanceContact(bodyMasked, ctx.testCode, ctx.absTest, ctx.srcFiles, jvmLang)) return true;
  return false;
}
// The brace-balanced body of every method annotated with one of `annotationRe`'s matches (JUnit4 `@Before`
// / JUnit5 `@BeforeEach`) — found by locating the annotation, then the METHOD's own first `(` (its param
// list) forward from there, balancing it, then balancing the following `{...}` body. Conventionally
// `@Before`/`@BeforeEach` never take their own arguments, so "the next `(`" is always the method's param
// list, never the annotation's.
function jvmAnnotatedMethodBodies(code, masked, annotationRe) {
  const bodies = [];
  for (const m of masked.matchAll(annotationRe)) {
    const parenIdx = masked.indexOf('(', m.index + m[0].length);
    if (parenIdx === -1) continue;
    let d = 1, k = parenIdx + 1;
    for (; k < masked.length && d; k++) { if (masked[k] === '(') d++; else if (masked[k] === ')') d--; }
    let ob = -1;
    for (; k < masked.length; k++) { if (masked[k] === '{') { ob = k; break; } if (masked[k] === ';') break; }
    if (ob === -1) continue;
    let bd = 0, kk = ob;
    for (; kk < masked.length; kk++) { const c = masked[kk]; if (c === '{') bd++; else if (c === '}') { bd--; if (!bd) { kk++; break; } } }
    bodies.push(code.slice(ob + 1, kk - 1));
  }
  return bodies;
}
// jvmFileHasSharedSetupContact: whole-file-scoped suppression (design doc's case (c)) — a shared
// @Before/@BeforeEach method may construct the real SUT into a field the flagged block never itself
// references (tracing field access across the whole class is out of scope for this module), so the mere
// PRESENCE of a resolvable-contact @Before/@BeforeEach method suppresses EVERY block in the file — never a
// false shadow because of an untraced shared fixture. Deliberately keyed on the ANNOTATION (which no @Test
// method carries), so a sibling @Test's own LOCAL contact can never leak into this whole-file suppression —
// that stays strictly block-scoped (hasProductionContact above), closing the "one legit test in the file
// silently immunizes every other test" over-broad reading the design doc's wording explicitly rejects.
export function jvmFileHasSharedSetupContact(code, absTest, srcFiles, dir, lang) {
  const masked = codeOnly(code, lang);
  for (const body of jvmAnnotatedMethodBodies(code, masked, /@(?:Before|BeforeEach)\b/g)) {
    if (hasProductionContact(body, { lang, testCode: code, absTest, srcFiles, dir })) return true;
  }
  return false;
}

// prove(dir, opts) → aggregate. opts: { runner, files:[substr], timeoutMs, onProgress }
export function prove(dir, opts = {}) {
  dir = resolve(dir); // absolutize: a relative dir would make the node_modules symlink target relative (→ self)
  try { dir = realpathSync(dir); } catch {} // canonicalize symlinks: git resolves --since's repo root to the
  // real path, so a symlinked dir (e.g. macOS /tmp→/private/tmp) would make absTest never match `changed`
  // and silently drop every block out of scope — a false negative. realpath keeps both sides canonical.
  let dirStat = null; try { dirStat = statSync(dir); } catch {}
  if (!dirStat || !dirStat.isDirectory()) return { runner: '', scored: 0, caught: 0, hollow: [], weak: [], inconclusive: [], skipped: [], outOfScope: 0, probes: 0, capped: 0, pct: null, scopeError: `path not found: ${dir}`, changedFileCount: undefined, changes: null, changeSummary: null };
  const runner = opts.runner || detectRunner(dir);
  const all = walk(dir);
  let testFiles = all.filter(isTestPath);
  if (opts.files && opts.files.length) testFiles = testFiles.filter((f) => opts.files.some((s) => toPosix(f).includes(toPosix(s))));
  const srcFiles = all.filter((f) => (/\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f) || /\.py$/.test(f) || /\.(kt|java)$/.test(f)) && !isTestPath(f));
  // A scan root that contains test files but ZERO non-test source files can never resolve any SUT —
  // every pinned block reports sut-unresolved. Field report 2026-07-22 §4: a --files run invoked from
  // inside the test directory read as a resolver regression; N per-test resolution failures masked one
  // scope mistake. State it once, up front.
  const scopeWarning = (!srcFiles.length && testFiles.length) ? `no non-test source files under ${dir} — SUT resolution will fail for every test; run from the project root that contains both sources and tests` : undefined;
  const resolveSut = makeResolver(srcFiles, dir);
  const lang = (f) => (f.endsWith('.py') ? 'python' : f.endsWith('.kt') ? 'kotlin' : f.endsWith('.java') ? 'java' : 'js');
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxProbes = opts.maxProbes || Infinity; // R6: bound latency on a large diff; default unlimited
  const timeBudgetMs = opts.timeBudgetMs || 0; // wall-clock cap for the whole probe pass; 0 = unlimited
  const probeStart = Date.now();
  // The budget bounds ANALYSIS too, not just probing: the per-block eligibility work (JVM SUT resolvers
  // scan source files per candidate) is the expensive phase on a large unscoped repo, and the pre-probe
  // cap check sits after the skip routing, which `continue`s first — an all-skip prefix used to grind
  // unbounded (20+ min, zero probes, zero output) with the budget never consulted. Checked at the top of
  // the block loop and before the per-file shared-setup scan; a block past the budget records probe-cap
  // without analysis — "not probed" must mean not analyzed either, or the budget is a lie.
  const budgetExhausted = () => Boolean(timeBudgetMs && Date.now() - probeStart >= timeBudgetMs);

  // diff scope: a Set of absolute changed paths (from opts.changed, or resolved from opts.since via git)
  let changed = opts.changed || null;
  if (!changed && opts.since) { changed = changedFilesSince(dir, opts.since); if (!changed) return { runner, scored: 0, caught: 0, hollow: [], inconclusive: [], skipped: [], outOfScope: 0, probes: 0, pct: null, scopeError: `--since ${opts.since}: not a git repo, or unknown ref`, changes: null, changeSummary: null }; }
  // canonicalize the changed set so it compares against canonical absTest/SUT keys (dir is realpath'd
  // above; a caller-supplied or symlinked path would otherwise never match, and on win32 a case or 8.3
  // short-name difference would too). A no-op for already-canonical --since entries; a deleted file
  // (realpath throws inside canonKey) falls back to its resolved literal path and simply won't match.
  if (changed) changed = new Set([...changed].map((p) => canonKey(p)));
  const changedFileCount = changed ? changed.size : undefined;

  // Under a probe cap the ORDER decides what gets verified: the wedge is agent-written tests, so test
  // files the diff touched are probed before untouched ones. Stable within each partition (fs order) —
  // deterministic, and a no-op when nothing is capped or no diff scope is set. canonKey is computed once
  // per file (not once per partition) since it may hit the filesystem (realpath).
  if (changed) {
    const inDiff = new Set(testFiles.filter((f) => changed.has(canonKey(f))));
    testFiles = [...testFiles.filter((f) => inDiff.has(f)), ...testFiles.filter((f) => !inDiff.has(f))];
  }

  // Repo-scoped probe lock (mutation/lock.mjs): a second concurrent probe on this repo would drive a
  // second test runner into the same build state — two Gradles collide and mint phantom failures (the
  // observed shape: the agent hook firing mid-CLI-sweep). Acquired after scope resolution (a bad --since
  // still errors lock-free), released in the work-dir finally below. Held by a live process → a stated
  // refusal via scopeError (CLI exit 2; the gate parses it, yields, and never memoizes it).
  const repoLock = acquireRepoLock(dir);
  if (!repoLock.release) {
    const who = repoLock.held && repoLock.held.pid ? ` (pid ${repoLock.held.pid})` : '';
    return { runner, scored: 0, caught: 0, hollow: [], inconclusive: [], skipped: [], outOfScope: 0, probes: 0, pct: null, scopeError: `another gutcheck probe is already running on this repo${who} — likely the agent hook or another terminal; rerun when it finishes (a stale lock clears itself)`, changes: null, changeSummary: null };
  }
  // Reap orphaned work copies from prior SIGKILL'd runs (mutation/lock.mjs) before minting our own —
  // after the repo lock is held (so this doesn't race a concurrent probe's own startup) and before
  // this run's mkdtemp (so this run's own dir cannot be present yet to mis-scan). Once per process
  // (staleWorkReaped, declared near javaExe() above): flag set BEFORE the call so a throwing reap
  // can never retry — hygiene stays fail-silent-once, never a repeated per-call tmpdir scan.
  if (!staleWorkReaped) { staleWorkReaped = true; reapStaleWork(); }

  const work = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  markWorkOwned(work);
  // Counter units differ by design: `probes` counts mutant runs — one per eligible FUNCTION gutted —
  // while caught/hollow/scored count TEST-BLOCK verdicts. A block binding K functions yields K probes
  // but one verdict, so probes ≥ scored always; the excess is multi-function blocks (plus any
  // survivors inside a caught block, surfaced separately as grossSurvivors). pct reads caught/scored only.
  let caught = 0; const hollow = []; const inconclusive = []; const skipped = []; const weak = []; const oneSided = []; let oneSidedBlocks = 0; let probes = 0; let outOfScope = 0; let capped = 0; let envAborted = 0; const proven = [];
  // Stale-build gate memo (field report 2026-07-18), gradle-only: one entry per sut file, the LAST
  // mutant content this run itself watched compile fresh (a bare line). The SAME sut function is
  // routinely gutted more than once in a single run — any other test block that also calls it gets an
  // independent probe (see the survivorTally header above) — and gutting it twice with the SAME
  // deterministic sentinel writes byte-identical content both times. Gradle's own (correct, always-on)
  // incremental build then reports the SECOND occurrence UP-TO-DATE relative to the FIRST — not a race,
  // just Gradle correctly recognizing it already built exactly this moments ago. Keyed by file and valued
  // by content (not an ever-seen set of every mutant this run built) so a STALE read is trusted only when
  // it matches the MOST RECENT thing this run verified compiling for that file — a result that's
  // UP-TO-DATE relative to some OTHER, older content this run built earlier (an old-Gradle interleaving:
  // gut fn A, gut fn B, gut fn A again with a DIFFERENT sentinel than the first time — rare, but possible
  // under --deep's opposite-mutant interleaving) must still fail closed, never ride on a stale match to
  // the wrong content. See survivorEvidenceValid (above parseGradleResults) for the read/write contract.
  const lastCompiled = new Map();
  // true denominators for the --deep identity-stub advisory — per-fn, not per-test: stubbed = passthrough
  // probes attempted for fn, passed = the stub survived (also lands in `weak`). An audit found most
  // survivors legitimate (no-op branches / accidental fixed points), so this reports ratios, never a
  // verdict. Built only when opts.deep; prove() returns it only then (see the final return).
  const weakSummary = opts.deep ? {} : undefined;
  // blockRecords: in-memory only (never returned) — one entry per verdicted block (caught/hollow/skipped/
  // inconclusive), carrying its masked body so classifyChanges can later attribute a changed fn's evidence.
  const blockRecords = [];
  // grossSurvivors accumulator (measurement-gated promotion): each
  // eligible fn already gets its own separate mutant run per block, so a fn's survive/catch outcome is
  // measured correctly even when a sibling fn's own run fails the SAME block — but a 'caught' verdict
  // (sibling broke it) previously threw the fn's own survival away, reporting it NOWHERE. This tally
  // captures exactly that NOVEL class: survivedIn is fed from CAUGHT blocks only — a hollow block's
  // survivors are already reported via r.hollow at higher severity, and re-tallying them would double-
  // count the observation (the corpus measurement must count only what the probe reports nowhere else).
  // caughtIn is fed from caught blocks too (the suppression clause's denominator). Tallied per
  // (sutRel, fn) — never bare name, so two same-named fns in different files can't merge (a caught fn in
  // file B must never suppress a real finding in file A). Inconclusive/skipped/ungutable blocks and the
  // hollow branch's flake-failed sibling contribute nothing.
  const survivorTally = new Map();
  const tallyKey = (sutRel, fn) => sutRel + '::' + fn;
  // Cap two-pass (budget-starvation fix): a relational fn in an early block must never spend
  // --max-probes budget a later block's VALUE verdict needs. gutOneFn/foldBlock/deferredBlocks below
  // split each block's per-fn gut work from its verdict fold, so the fold can run later (pass 2) than
  // the gutting that feeds it — without touching the fold's own logic at all.
  //
  // gutOneFn: the single per-fn mutate→run→classify step, shared by pass 1 (value-only entries, gutted
  // inline as each block is reached — old-engine parity) and pass 2 (deferred relational entries,
  // gutted after every test file's value work is done). Mutates `ctx` in place: ctx.anyGutted/
  // sawCompileFail are plain properties (not `let`s) precisely so a later call — same block, later
  // pass — can flip them and have foldBlock(ctx) see the update; ctx.brokeFns/survivorFns/survivors
  // are arrays, mutated by push either way. Body is byte-identical to the pre-cap-two-pass inline gut
  // loop, just field-qualified onto ctx instead of closing over per-block `let`s.
  const gutOneFn = (ctx, fn, sutRel, isRel) => {
    const abs = join(ctx.work, sutRel); let orig; try { orig = readFileSync(abs, 'utf8'); } catch { return; }
    const lang = sutRel.endsWith('.py') ? 'python' : sutRel.endsWith('.kt') ? 'kotlin' : sutRel.endsWith('.java') ? 'java' : 'typescript';
    const broken = grossBreak(orig, fn, lang);
    if (broken === null || broken === orig) return;
    if (ctx.runner === 'gradle' || ctx.runner === 'maven') {
      // A gradle/maven mutant can fail to COMPILE (a type-changing sentinel against a non-numeric/
      // non-string return type, e.g. List<Int>) — that is not a weak test surviving a real mutant, it
      // is no valid mutant existing at all. Treat it exactly as grossBreak returning null for this fn:
      // never counted (no anyGutted, no probes++), revert, move to the next eligible fn. A block
      // whose every eligible fn compile-fails then falls through to the existing 'ungutable' skip
      // below — never inconclusive, never caught.
      writeFileSync(abs, broken);
      const r = runOne(ctx.work, ctx.runner, ctx.rel, ctx.selectName, ctx.timeoutMs, ctx.selectQualified);
      writeFileSync(abs, orig);
      if (r.compiled === false) { ctx.sawCompileFail = true; return; }
      // Stale-build gate (field report 2026-07-18): a survivor is only evidence if the mutant was in
      // the build — see survivorEvidenceValid's own header comment for the full contract (vfs-watch race
      // mechanism + the lastCompiled memo). Only gradle carries this belt-and-suspenders check (maven has
      // no equivalent live-verified console signal — see mavenCompiled's own header note on why gradle
      // needed a second detector at all). A veto is treated EXACTLY like a compile-fail: never counted,
      // never a survivor, falls through to the 'ungutable' skip below rather than minting a false hollow
      // off a build that never saw the mutant.
      if (ctx.runner === 'gradle' && !survivorEvidenceValid(r, sutRel, broken, lastCompiled)) { ctx.sawCompileFail = true; return; }
      ctx.anyGutted = true; probes++;
      if (r.failed > 0) ctx.brokeFns.push({ fn, abs, orig, lang, rel: isRel });
      else if (r.passed > 0) { ctx.survivors.push(fn); ctx.survivorFns.push({ fn, abs, orig, lang, rel: isRel }); }
      return;
    }
    ctx.anyGutted = true; probes++;
    writeFileSync(abs, broken);
    const r = runOne(ctx.work, ctx.runner, ctx.rel, ctx.selectName, ctx.timeoutMs, ctx.selectQualified);
    writeFileSync(abs, orig);
    if (r.failed > 0) ctx.brokeFns.push({ fn, abs, orig, lang, rel: isRel });
    else if (r.passed > 0) { ctx.survivors.push(fn); ctx.survivorFns.push({ fn, abs, orig, lang, rel: isRel }); }
  };
  // foldBlock: the verdict fold, extracted verbatim from the inline per-block tail so it can run either
  // immediately (pass 1, a block with no deferred relational fns — old-engine parity) or later (pass 2,
  // after this block's deferred relational fns have been drained on leftover budget). Reads/writes the
  // run-level accumulators by closure (caught, hollow, oneSided, oneSidedBlocks, inconclusive, skipped,
  // blockRecords, probes, weak, weakSummary) exactly as the inline code did; everything block-specific
  // travels in `ctx` (see the ctx literal at the call site for the exact field list — it also carries
  // `tallyBlock`, a per-block closure the inline code already had in scope that isn't otherwise
  // reconstructible from ctx's other fields).
  const foldBlock = (ctx) => {
    const { b, rel, bodyMasked, shadowSignals, sutOf, brokeFns, survivorFns, survivors, anyGutted, sawCompileFail, relStarved, work, runner, selectName, selectQualified, timeoutMs, absTestKey, changed, deep, tallyBlock } = ctx;
    // Two-sentinel pass — confirm-before-accuse: every SURVIVOR (candidate hollow) is re-gutted with
    // the opposite-signed sentinel BEFORE verdicting, on every run — a hollow accusation is minted
    // only when the test stays green in BOTH directions, so it can never be a sentinel-sign accident
    // (field-observed: two mirror-image threshold tests once drew HOLLOW and PROVEN purely by sign,
    // the hollow copy contradicting its own receipt). Survivors are rare, so the default cost is
    // near zero — the extra run is paid exactly when an accusation is at stake, like the R5 recheck.
    // --deep extends the same pass to the RED side (brokeFns), demoting one-direction-only proofs to
    // one-sided. oppRed maps fn → the opposite mutant's result; ABSENT = no evidence (no numeric
    // opposite exists, or it didn't compile, or the run was a 0p/0f non-run) — and no evidence means
    // no reclassification: the fn keeps its single-sentinel meaning, fail-closed as everywhere else.
    // R5 flake guard FIRST when an accusation is at stake (no fn broke, some survived): hollow AND
    // one-sided both rest on the survivor-pass being stable, and an unstable test must stay
    // inconclusive — never allowed to fake opposite-run evidence (CI caught exactly that bypass when
    // this guard briefly ran after the opposite mutants). Running it first also skips their cost on
    // a flaky block.
    let flakyBlock = false; let flakeChecked = false;
    if (!brokeFns.length && survivorFns.length) {
      flakeChecked = true;
      const recheck = runOne(work, runner, rel, selectName, timeoutMs, selectQualified);
      flakyBlock = !(recheck.passed >= 1 && recheck.failed === 0);
    }
    const oppRed = new Map();
    if (!flakyBlock) for (const { fn, abs, orig, lang } of (deep ? [...brokeFns, ...survivorFns] : (brokeFns.length ? [] : survivorFns))) {
      const opp = grossBreakOpposite(orig, fn, lang);
      if (opp === null || opp === orig) continue;
      probes++;
      writeFileSync(abs, opp);
      const r = runOne(work, runner, rel, selectName, timeoutMs, selectQualified);
      writeFileSync(abs, orig);
      if ((runner === 'gradle' || runner === 'maven') && r.compiled === false) continue;
      // Stale-build gate, mirrored (field report 2026-07-18): a stale green on the OPPOSITE run must
      // never fake opposite-run evidence — that would either wrongly confirm a hollow (survivor side)
      // or wrongly demote a genuinely bound fn to one-sided (deep-mode brokeFns side). `continue` leaves
      // oppRed unset for this fn, same as "no opposite mutant exists" — no evidence, no reclassification.
      // Shares the lastCompiled memo with the primary gut loop (survivorEvidenceValid handles the red-is-
      // always-valid case internally too, so this reads identically whichever loop reaches it first).
      if (runner === 'gradle' && !survivorEvidenceValid(r, sutOf.get(fn), opp, lastCompiled)) continue;
      if (r.failed > 0) oppRed.set(fn, true);
      else if (r.passed > 0) oppRed.set(fn, false);
    }
    // Fn tiers: bound (red under both, or red with no opposite evidence), one-sided (red under
    // exactly one sentinel), blind (green under both, or green with no opposite evidence). On a
    // plain run only survivors carry opposite evidence, so bound = brokeFns exactly.
    const boundFns = brokeFns.filter(({ fn }) => oppRed.get(fn) !== false);
    const oneSidedFns = [
      ...brokeFns.filter(({ fn }) => oppRed.get(fn) === false).map((x) => ({ ...x, posRed: true })),
      ...survivorFns.filter(({ fn }) => oppRed.get(fn) === true).map((x) => ({ ...x, posRed: false })),
    ];
    const blindAll = survivorFns.filter(({ fn }) => oppRed.get(fn) !== true);
    // SAFE-form asymmetry (spec §3): a relational-only credit can prove (red→boundFns) and can be
    // one-sided (red under exactly one sentinel), but its survival is NOT evidence of a hollow test —
    // a one-sided relation passes extreme sentinels by construction (assertTrue(score >= 0) survives
    // +HUGE). Split here, at the same tier gate as every other verdict — never post-filtered.
    const blindFns = blindAll.filter((x) => !x.rel);
    const relUnboundFns = blindAll.filter((x) => x.rel);
    for (const { fn, posRed } of oneSidedFns) oneSided.push({ file: rel, line: b.line, name: b.name, fn, posRed });
    const oneSidedPairs = oneSidedFns.map((x) => ({ fn: x.fn, sutRel: sutOf.get(x.fn) }));
    if (boundFns.length) {
      caught++;
      // Caught-branch blockRecords now also carries `survivors` (the already-computed local array): a
      // sibling fn broke this block, but any OTHER eligible fn's own separate mutant run may have
      // survived — previously computed, never persisted. Purely additive: no existing reader branches
      // on a `survivors` key for a 'caught'-verdict record (classifyChanges only reads `caughtFns` for
      // 'caught'), so this changes no verdict, count, or report line.
      // caughtPairs/survivorPairs: (fn, sutRel) pairs built from THIS block's own sutOf map — the
      // (fn, file)-identity classifyChanges needs to attribute a verdict without a bare-name collision
      // across files (mutation/changes.mjs's refEligible/hollowIn/provenIn). blockRecords itself is
      // in-memory only (never surfaced in r.hollow or formatReport) — but caughtPairs is hoisted below
      // so the SAME array also seeds r.proven[].pairs (field report 2026-07-22 §6), the one place this
      // per-fn evidence does reach the public result.
      // testChanged (same-diff-oracle provenance, Task 7): whether THIS test FILE was itself part of
      // the diff (`absTestKey` is computed once per test file, above) — a fact classifyChanges can
      // later fold into a proven row's evidence (every binding block's test file changed in this diff
      // → the oracle is same-diff, worth stating as fact, not a verdict). false on a full-scan run
      // (changed is null) — there is no "this diff" to be same to.
      const caughtPairs = boundFns.map((x) => ({ fn: x.fn, sutRel: sutOf.get(x.fn) }));
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'caught', caughtFns: boundFns.map((x) => x.fn), survivors, caughtPairs, survivorPairs: survivors.map((fn) => ({ fn, sutRel: sutOf.get(fn) })), ...(oneSidedPairs.length ? { oneSidedPairs } : {}), testChanged: changed ? changed.has(absTestKey) : false });
      // proven[] (field report 2026-07-22 §6): the machine-readable twin of `caught++` — which test, at
      // which line, bound which fn. hollow[] has carried this per-row evidence since day one; proven rows
      // were scalar-only, so a --files run (the documented big-repo chunking mode) had no record of WHAT
      // was proven. Omit-when-empty at the return site (grossSurvivors precedent).
      proven.push({ file: rel, line: b.line, name: b.name, fns: boundFns.map((x) => x.fn), pairs: caughtPairs });
      tallyBlock(brokeFns.map((x) => x.fn), survivors);
    }
    else if (flakyBlock) {
      // R5 flake guard verdict: the survivor-pass proves nothing on an unstable test — never a
      // hollow, never a one-sided; the opposite mutants were skipped above for the same reason.
      const why = 'flaky baseline (unstable green) — not a reliable HOLLOW';
      inconclusive.push({ file: rel, line: b.line, name: b.name, why });
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'inconclusive', why });
    }
    else if (relStarved && (blindFns.length || oneSidedFns.length)) {
      // Belt-and-braces (structural insurance against future defer-decision drift): a hollow or
      // one-sided VERDICT from a block that still has an un-probed eligible rel fn is unsound — the
      // dispatch above already guarantees this is unreachable for the accusation-shaped case (it never
      // defers at all, so `relStarved` stays false there), but if a future change ever lets a starved
      // rel fn reach here, fail closed to the same probe-cap accounting the pass-2 drain uses, rather
      // than mint a verdict on partial evidence. (The oneSided[] per-fn push above is unaffected — it is
      // independent per-fn evidence, same as it already coexists with a 'caught' block verdict.)
      capped++;
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: 'probe-cap' });
    }
    else if (blindFns.length) {
      // Stability was already verified by the pre-opposite R5 check for accusation-shaped blocks.
      // The one path that arrives here unchecked is deep-only — brokeFns existed but every one
      // demoted to one-sided — so run the same guard now, before the accusation.
      const recheck = flakeChecked ? null : runOne(work, runner, rel, selectName, timeoutMs, selectQualified);
      if (recheck === null || (recheck.passed >= 1 && recheck.failed === 0)) {
        const blindNames = blindFns.map((x) => x.fn);
        hollow.push({ file: rel, line: b.line, name: b.name, survivors: blindNames, survivorPairs: blindFns.map(({ fn }) => ({ fn, sutRel: sutOf.get(fn) })) });
        blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'hollow', survivors: blindNames, survivorPairs: blindFns.map(({ fn }) => ({ fn, sutRel: sutOf.get(fn) })), ...(oneSidedPairs.length ? { oneSidedPairs } : {}) });
        // Deliberately NOT tallied into survivorTally: a hollow block's survivors are already reported
        // via r.hollow at higher severity — grossSurvivors is the NOVEL observation class only
        // (survivals inside caught blocks, reported nowhere else); tallying here would double-count.
      } else {
        const why = 'flaky baseline (unstable green) — not a reliable HOLLOW';
        inconclusive.push({ file: rel, line: b.line, name: b.name, why });
        blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'inconclusive', why });
      }
    }
    else if (oneSidedFns.length) {
      // Deep-only tier: every gutted fn went red under exactly one sentinel — the test binds one
      // direction of error. A verdict (counts in scored), never a blocker: only hollow exits 1,
      // so --deep can clear a sign-accident hollow but can never manufacture a new block.
      oneSidedBlocks++;
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'one-sided', oneSidedPairs });
    }
    else if (relUnboundFns.length) {
      // Every gutted fn is a relational-only survivor under both sentinels: the relation binds
      // neither direction against an extreme, so the honest answer is "can't verify" — routed
      // through the existing skip plumbing (never scored, never exits 1, spec §3).
      const why = 'relation-unbound';
      skipped.push({ file: rel, line: b.line, name: b.name, why });
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why, ...(oneSidedPairs.length ? { oneSidedPairs } : {}) });
    }
    else if (anyGutted) {
      const why = 'mutant ran 0 tests';
      inconclusive.push({ file: rel, line: b.line, name: b.name, why });
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'inconclusive', why });
    }
    else {
      // 'ungutable' is honest only when at least one eligible entry's body WAS located and gutted but
      // the compiler rejected the mutant (the gradle compile-fail path above) — the only path that can
      // currently prove "located but unmutatable". Every other way to land here means no eligible
      // entry's body was ever located/mutated at all (the ctor-name dead-end, an overload-ambiguous fn,
      // an unlocatable body) — 'sut-unresolved' is the truthful label (existing plumbing: the
      // "tested function not locatable" banner, UNVERIFIABLE_REASON_MSG).
      const why = sawCompileFail ? 'ungutable' : 'sut-unresolved';
      skipped.push({ file: rel, line: b.line, name: b.name, why });
      blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why });
    }
    // Depth tier (opt-in): a fn the gross stub broke but an IDENTITY stub does not was only exercised on
    // a fixed point — the assertion does not pin the function's transformation. Advisory, not a finding.
    // Suppressed for a fn with a production first-param identity branch (`return label`, `?: label`,
    // `else a`, …): there the stub is indistinguishable from correct behavior and the branch's own
    // tests survive it BY CONSTRUCTION — field-observed as 5/5 false advisories in one wild run.
    if (deep) for (const { fn, abs, orig, lang } of brokeFns) {
      if (hasFirstParamIdentityBranch(orig, fn, lang)) continue;
      const stub = passthroughBreak(orig, fn, lang);
      if (stub === null || stub === orig) continue;
      probes++;
      writeFileSync(abs, stub);
      const r = runOne(work, runner, rel, selectName, timeoutMs, selectQualified);
      writeFileSync(abs, orig);
      if ((runner === 'gradle' || runner === 'maven') && r.compiled === false) continue; // identity stub didn't type-check → not a weak survivor
      if (!weakSummary[fn]) weakSummary[fn] = { stubbed: 0, passed: 0 };
      weakSummary[fn].stubbed++;
      if (r.failed === 0 && r.passed > 0) { weak.push({ file: rel, line: b.line, name: b.name, fn }); weakSummary[fn].passed++; }
    }
  };
  // deferredBlocks: run-global queue of { ctx, deferredRel } — every block whose gut loop collected at
  // least one relational fn lands here instead of folding inline; drained in pass 2, after the whole
  // testFiles loop (see below), on whatever probe/time budget is left.
  const deferredBlocks = [];
  try {
    // cpSync throws raw (EACCES, …) on an unreadable file/subdir anywhere in the tree — caught here so
    // that surfaces as a friendly scopeError instead of a stack trace. The return stays inside this outer
    // try so the finally below still runs and cleans up `work`.
    try {
      // Filter judges paths RELATIVE to the copy root: an ANCESTOR directory named like a skip-dir
      // (e.g. clones parked under ~/.claude/) must never suppress the copy — only segments inside the
      // project tree count. Names are regex-escaped ('.git' must not match 'digit').
      const skipRe = new RegExp(`(^|[\\\\/])(${[...SKIP_DIRS].map(reEsc).join('|')})([\\\\/]|$)`);
      cpSync(dir, work, { recursive: true, filter: (src) => !skipRe.test(relative(dir, src)) });
    } catch (e) {
      return { runner, scored: 0, caught: 0, hollow: [], weak: [], inconclusive: [], skipped: [], outOfScope: 0, probes: 0, capped: 0, pct: null, changedFileCount, scopeError: `cannot read ${dir}: ${e && e.code || e}`, changes: null, changeSummary: null };
    }
    const nm = join(dir, 'node_modules');
    // 'junction' needs no privileges on Windows (plain dir symlinks do); non-win32 keeps 'dir'.
    if (existsSync(nm)) { try { symlinkSync(nm, join(work, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {} }

    // Fail-fast on a broken env: the first ENV_ABORT_THRESHOLD blocks that reach a baseline all failing it with none passing means a broken build/wrong runner is failing every test — stop probing the guaranteed-inconclusive rest.
    const ENV_ABORT_THRESHOLD = 10;
    let baselineOk = 0, baselineBad = 0;
    for (const tf of testFiles) {
      const rel = toPosix(relative(dir, tf)); const code = readFileSync(tf, 'utf8'); const L = lang(tf);
      const absTest = resolve(dir, rel);
      const absTestKey = changed ? canonKey(absTest) : null; // computed once per test file, not per block
      // Runner-mismatch gate: skip the whole file fail-closed BEFORE any per-block work, one explicit
      // record per block so classifyChanges keeps the reference evidence (unverifiable-with-reason,
      // never 'untested'). An unknown runner id keeps today's behavior (no gate). Mirrors the
      // jvmSourceSetGate shape below.
      const runnerLangs = RUNNER_LANGS[runner];
      if (runnerLangs && !runnerLangs.includes(L)) {
        const gateWhy = `runner-mismatch — ${runner} cannot run ${L} tests`;
        for (const b of parseBlocks(code, L)) {
          const gateMasked = codeOnly(b.body, (L === 'kotlin' || L === 'java') ? L : 'typescript');
          // Record BEFORE the scope check — a changed fn whose only referencing test lives in an
          // untouched mismatched-language file must classify unverifiable (the reference is real),
          // never 'untested'. Mirrors the main loop's out-of-scope record-then-drop.
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked: gateMasked, noContact: false, selfEcho: null, shadowTargets: [], verdict: 'skipped', why: gateWhy });
          if (changed && !changed.has(absTestKey)) { outOfScope++; continue; }
          skipped.push({ file: rel, line: b.line, name: b.name, why: gateWhy });
        }
        continue;
      }
      const imports = importMap(code, L); // L: kotlin-gated bare-import parsing (field report #3); no-op for JS/py/java
      // Python precision path: when python3/python is available, the stdlib-ast helper gives the test
      // blocks + which SUT calls are value-PINNED + the `from … import` bindings — so a unittest
      // `self.assertEqual(...)` block becomes eligible (the regex pinnedFragments misses it). Falls back to
      // the regex Python branch (parseBlocks + eligibleFns) when the interpreter is absent.
      const pyAst = (L === 'python') ? pyBlocks(absTest) : null;
      // JVM lang for THIS test file (undefined for JS/py — the byte-identity lever: every downstream call
      // below passes jvmLang through, and undefined reproduces the pre-JVM no-arg call exactly).
      const jvmLang = (L === 'kotlin' || L === 'java') ? L : undefined;
      // Unsupported JVM source sets skip here, before ANY per-block work: no baseline, no mutant, an
      // explicit reason per block (see jvmSourceSetGate). Diff-scoped runs keep their out-of-scope
      // accounting for untouched files, exactly like the per-block scope gate below.
      if (jvmLang) {
        const gateWhy = jvmSourceSetGate(rel, dir);
        if (gateWhy) {
          for (const b of parseBlocks(code, L)) {
            if (changed && !changed.has(absTestKey)) { outOfScope++; continue; }
            const bodyMasked = codeOnly(b.body, L);
            skipped.push({ file: rel, line: b.line, name: b.name, why: gateWhy });
            blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, noContact: false, selfEcho: null, shadowTargets: [], verdict: 'skipped', why: gateWhy });
          }
          continue;
        }
      }
      // wrongLayerShadow whole-file shared-setup suppression (design doc's case (c)) — computed ONCE per
      // test file, JVM only (see jvmFileHasSharedSetupContact's header for why JS/py don't get this).
      const jvmSharedSetupContact = (jvmLang && !budgetExhausted()) ? jvmFileHasSharedSetupContact(code, absTest, srcFiles, dir, jvmLang) : false;
      const blocks0 = pyAst ? pyAst.blocks : parseBlocks(code, L);
      // Value-pins-first under a cap (spec §4): only RELATIONAL-ONLY blocks are deprioritized — a
      // no-pin block keeps its source position, so a repo with zero relational asserts keeps
      // byte-identical output (spec §6.3), r.skipped row order included. Pre-classification stays
      // REGEX-ONLY (pinnedFragmentsByKind / already-computed pyAst pins — no fs, no resolvers, no
      // spawns), same cost class as the parseBlocks scan that already ran. Resolution work still
      // happens only at a block's own turn (the budget invariant above). Single pass, stable.
      const isRelOnly = (b) => {
        if (pyAst) return b.pins.length === 0 && (b.relPins || []).length > 0;
        const k = pinnedFragmentsByKind(b.body, imports, jvmLang);
        return k.value.length === 0 && k.relational.length > 0;
      };
      const front = []; const rear = [];
      for (const b of blocks0) (isRelOnly(b) ? rear : front).push(b);
      const blocks = [...front, ...rear];
      const ambiguous = ambiguousNames(blocks.map((b) => b.name), runner);
      // Stage 2 (only when stage 1 found anything — residualAmbiguous is a no-op-safe pure fn either way,
      // but skipping it on the common empty case avoids a wasted O(n^2) pass over every file's blocks).
      const residual = ambiguous.size ? residualAmbiguous(blocks, ambiguous, runner) : new Set();
      for (const [bi, b] of blocks.entries()) {
        // Masked once per block (JS: strip strings/comments so a code sample in a string can't false-
        // match a fn reference later; pyAst blocks are already ast-derived, so b.body is used as-is).
        const bodyMasked = pyAst ? b.body : codeOnly(b.body, 'typescript');
        // Budget check BEFORE the analysis below (see budgetExhausted's comment): once exhausted, the
        // block records probe-cap immediately — same accounting as the pre-probe cap further down, minus
        // the shadow signals deliberately never computed for an unanalyzed block. maxProbes stays at the
        // pre-probe site only: counting probes costs nothing, and its capped blocks keep full analysis.
        if (budgetExhausted()) {
          capped++;
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'skipped', why: 'probe-cap' });
          continue;
        }
        // wrongLayerShadow signals (Task: wrongLayerShadow) — computed for EVERY block regardless of
        // verdict (a shadow test is typically 'skipped'/no-pin, since it has no eligible SUT to gut: the
        // whole point is that nothing here resolves), pure and runner-independent (never invokes runOne,
        // so this never needs a gradle/pytest/node install to compute).
        //
        // The HARD hollow verdict is JVM-ONLY. hasProductionContact's non-JVM branch checks only bare-name
        // calls: sutFnsIn excludes `.method(` instance calls, and there is no JS/py analog of
        // jvmInstanceContact / jvmFileHasSharedSetupContact. So JS/py contact detection is strictly WEAKER
        // than the mutation probe's own reach — a JS/py class-method SUT called on a constructed instance
        // (`m = new Meter(); m.offset(...)`, or a `@BeforeEach`/`setUp`-shared instance) reads as
        // zero-contact and would produce a FALSE hollow on a probe-provable test. Therefore noContact is
        // computed (and can be true) only for kotlin/java; JS/py get { false, null, [] } → the conjunction
        // never fires. JS/py parity (instance-method/property/type contact + beforeEach/setUp suppression)
        // is an explicit follow-on, not shipped here. selfEcho is only computed for JVM too (inert without
        // noContact, so there is no reason to run it on a JS/py body that can never be flagged).
        let noContact = false, selfEcho = null, shadowTargets = [];
        if (jvmLang) {
          selfEcho = selfEchoAssertion(b.body, jvmLang);
          noContact = !jvmSharedSetupContact && !hasProductionContact(b.body, { lang: jvmLang, testCode: code, absTest, srcFiles, dir });
          // Attribution — the design's PRIMARY (now only) path: charge the shadow to a changed fn F ONLY
          // when the block's TITLE resolves to F via resolveJvmSut (the same resolver the mutation path
          // uses). titleSutCandidates extracts candidate SUT method-name tokens from the title; each is
          // resolved to its declaring src/main file; classifyChanges then charges F iff (F, F's file) is
          // among these. A fn whose name merely appears in the tautological ECHO expression (a local like
          // `index`/`current`) is NEVER attributed — that echo-token path caused a verified false hollow.
          if (noContact && selfEcho) {
            shadowTargets = [...new Map(titleSutCandidates(b.name)
              .map((c) => [c, resolveJvmSut(c, code, absTest, srcFiles, dir, jvmLang)])
              .filter(([, sutRel]) => sutRel)
              .map(([fn, sutRel]) => [fn + '::' + sutRel, { fn, sutRel }])).values()];
          }
        }
        const shadowSignals = { noContact, selfEcho, shadowTargets };
        // pyAst pins are already fn-linked by py_blocks.py, so hadPin collapses to "any pin" there —
        // the pin-unresolved split below is only ever reachable on the JS/TS/JVM textual-scan path.
        // relPins (relational-assert reach, Task 5): merged in with `pins` for `eligible` (either kind
        // makes the fn probeable) but reported separately as `relationalOnly` — a fn present in BOTH
        // b.pins and b.relPins stays value-class (the filter below excludes it from relationalOnly),
        // matching py_blocks.py's own dedup of relPins against pins.
        const pinDetail = pyAst
          ? {
              eligible: [...new Set([...b.pins, ...(b.relPins || [])])],
              relationalOnly: (b.relPins || []).filter((f) => !b.pins.includes(f)),
              hadPin: b.pins.length + (b.relPins || []).length > 0,
            }
          : eligibleFnsDetail(b.body, sutFnsIn(b.body, jvmLang), imports, jvmLang);
        const pinnedFns = pinDetail.eligible;
        const relOnly = new Set(pinDetail.relationalOnly || []);
        const eligible = pinnedFns
          .map((fn) => ({ fn, sutRel: pyAst ? resolvePySut(fn, pyAst.imports, absTest, srcFiles, dir) : jvmLang ? resolveJvmSut(fn, code, absTest, srcFiles, dir, jvmLang) : resolveSut(fn, absTest, imports), rel: relOnly.has(fn) }))
          .filter((x) => x.sutRel);
        // JVM instance-method reach (jvm-instance-reach): a lowercase-receiver call (`analyzer.compute(x)`)
        // that sutFnsIn never captures at all — resolved separately via receiver-TYPE inference, so it
        // can't be produced by the bare-name path above. Purely ADDITIVE, deduped by (fn, sutRel); never
        // touches JS/py (jvmLang is undefined there, so this is always []).
        if (jvmLang) {
          for (const inst of jvmInstanceSuts(b.body, code, absTest, srcFiles, dir, jvmLang)) {
            if (!eligible.some((x) => x.fn === inst.fn && x.sutRel === inst.sutRel)) eligible.push(inst);
          }
        }
        // JS/TS instance-method reach (Task B1 / T3): a constructor-receiver'd call (`service.decrypt(x)`)
        // that sutFnsIn/eligibleFns never propose for JS at all — resolved separately via receiver-TYPE
        // inference from a directly-visible `new` call, mirroring jvmInstanceSuts. Purely ADDITIVE, deduped
        // by (fn, sutRel); gated on `L === 'js'` DIRECTLY (the block loop's own lang() classification) so
        // Python and JVM blocks stay byte-identical — deliberately NOT `!jvmLang && !pyAst`, which is true
        // for a regex-fallback Python block (no python3/python interpreter on PATH: jvmLang is undefined
        // AND pyAst is null there too) and would hand jsInstanceSuts Python source it was never designed
        // to parse.
        if (L === 'js') {
          for (const inst of jsInstanceSuts(b.body, code, absTest, srcFiles, imports, dir)) {
            if (!eligible.some((x) => x.fn === inst.fn && x.sutRel === inst.sutRel)) eligible.push(inst);
          }
        }
        // Python instance-method reach (T4, §6.3): a receiver'd call — inline `Calc().add(2,3)` or
        // variable `c = Calc(); c.add(2,3)` — that resolvePySut's bare-name pins path never resolves at
        // all (the inline form's ctor name is a dead-end 'sut-unresolved' eligible entry; the variable
        // form is never even pinned, `pin_calls_in` is deliberately Name-only). `b.inst` is py_blocks.py's
        // own ast-derived {ctor,method} pairs (§6.1) — already scoped to THIS block's pin contexts with
        // the file-wide mock-taint/ctor-rebind/receiver-binding rules applied there (py_blocks holds the
        // whole test file's ast, exactly where that inference belongs). Purely ADDITIVE, deduped by
        // (fn, sutRel); gated strictly on `pyAst` — a regex-fallback Python block (no python3/python on
        // PATH) has no `.inst` field at all (`b` is a parseBlocks() block there, not a pyAst block), so
        // this stays byte-identical to before T4 whenever the ast precision path is unavailable.
        if (pyAst) {
          for (const { ctor, method } of (b.inst || [])) {
            const sutRel = resolvePyClassMember(ctor, method, pyAst.imports, absTest, srcFiles, dir);
            if (!sutRel) continue;
            if (!eligible.some((x) => x.fn === method && x.sutRel === sutRel)) eligible.push({ fn: method, sutRel });
          }
        }
        // fn -> sutRel for THIS block only — the source of the (sutRel,fn) key the caughtFns/survivors name
        // arrays below don't carry themselves. tallyBlock feeds survivorTally from the CAUGHT branch only
        // (see the accumulator comment above — hollow survivors are r.hollow's, not this tally's).
        const sutOf = new Map(eligible.map((e) => [e.fn, e.sutRel]));
        const tallyBlock = (caughtNames, survivedNames) => {
          for (const fn of caughtNames) {
            const sutRel = sutOf.get(fn); if (!sutRel) continue;
            const key = tallyKey(sutRel, fn);
            if (!survivorTally.has(key)) survivorTally.set(key, { file: sutRel, fn, survivedIn: [], caughtIn: 0 });
            survivorTally.get(key).caughtIn++;
          }
          for (const fn of survivedNames) {
            const sutRel = sutOf.get(fn); if (!sutRel) continue;
            const key = tallyKey(sutRel, fn);
            if (!survivorTally.has(key)) survivorTally.set(key, { file: sutRel, fn, survivedIn: [], caughtIn: 0 });
            survivorTally.get(key).survivedIn.push({ file: rel, line: b.line, name: b.name });
          }
        };
        // A DYNAMIC title (parseBlocks: template-literal interpolation; pyAst blocks never carry this)
        // takes priority over the pin/eligibility reasons below — no runner selection can ever target a
        // runtime-computed title, so the block is unprobeable regardless of whether it also has an
        // eligible SUT. Same scope-vs-skip routing as the pre-existing reasons, just a new `why`.
        // 'no-pin' vs 'pin-unresolved': both skip, but they state different established facts — no pinned
        // fragment existed at all, vs a pin exists that no hop shape could link to a called function
        // (destructuring LHS, etc.). The rendered messages must each claim only what the scan proved.
        const why0 = b.dynamicTitle ? 'dynamic-title' : (pinnedFns.length || eligible.length) ? 'sut-unresolved' : pinDetail.hadPin ? 'pin-unresolved' : 'no-pin';
        if (changed && !(changed.has(absTestKey) || eligible.some((e) => changed.has(canonKey(resolve(dir, e.sutRel)))))) {
          // Record the block BEFORE dropping it out of scope: a changed fn whose only tests are weak or
          // unresolved lives in blocks this gate never probes — with no record, classifyChanges would
          // report that fn 'untested' ("no test mentions it"), which is false. outOfScope++, the result
          // arrays, and every counter stay byte-identical; execution verdicts (caught/hollow) are
          // unaffected since those only ever arise from probed blocks.
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: why0 });
          outOfScope++; continue;
        }
        if (b.dynamicTitle || !eligible.length) {
          skipped.push({ file: rel, line: b.line, name: b.name, why: why0 });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: why0 });
          continue;
        }
        if (probes >= maxProbes || (timeBudgetMs && Date.now() - probeStart >= timeBudgetMs)) {
          // R6: cap reached (probe count OR wall-clock budget) — report, never silently drop. The
          // record keeps the block's reference evidence alive: a fn whose only tests are capped blocks
          // reads 'unverifiable (probe-cap)', never 'untested' — the default-capped run must not state
          // something the uncapped run refutes. Checked BEFORE starting the next probe only — a
          // baseline/mutant pair already in flight always finishes atomically.
          capped++;
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: 'probe-cap' });
          continue;
        }
        // Environment-abort fail-fast (see ENV_ABORT_THRESHOLD): once the first N blocks to reach a baseline
        // have all failed it and NONE has passed, every remaining probeable block would fail identically —
        // stop and record each as skipped 'env-abort', exactly mirroring the probe-cap record above (real
        // reference evidence kept alive, so a fn read only here classifies 'unverifiable', never 'untested'),
        // then finish through the normal reporting path. A baseline that passes among the first N probeable
        // blocks (baselineOk > 0 before the threshold is hit) disables this permanently; a pass reachable
        // only AFTER N failures is itself aborted here — ordering-dependent by design, but fail-closed: an
        // aborted pass reads 'unverifiable', never a false verdict. Nothing already recorded changes; no
        // verdict is ever minted from an aborted block.
        if (baselineOk === 0 && baselineBad >= ENV_ABORT_THRESHOLD) {
          envAborted++;
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: 'env-abort' });
          continue;
        }
        // Fail-closed on ambiguous selection, but ONLY for a block that would otherwise be probed — after
        // the scope/eligibility/cap gates above, immediately before the baseline run. An out-of-scope,
        // skipped, or capped block keeps its own bucket, so diff-scoped outOfScope/inconclusive
        // denominators (the Stop hook, corpus re-drives) are never corrupted by files a diff didn't touch.
        // A bare-title collision is qualified with the describe path FIRST (residualAmbiguous, stage 2)
        // before failing closed — only a RESIDUAL collision (identical describe-path + title) still lands
        // here. A resolved block selects by its qualified full name for every runOne call below (baseline,
        // mutant, recheck, --deep stub) — never its bare b.name, and never surfaced in any report/
        // blockRecords entry (those always keep b.name — qualification is a selection-only detail).
        const isAmbiguous = ambiguous.has(b.name);
        if (isAmbiguous && residual.has(bi)) {
          const why = 'ambiguous title — another test in this file matches the same runner selection';
          inconclusive.push({ file: rel, line: b.line, name: b.name, why });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'inconclusive', why });
          continue;
        }
        const selectName = isAmbiguous ? qualifiedName(b) : b.name;
        const selectQualified = isAmbiguous && runner === 'mocha'; // only mocha's --grep needs anchoring — see testCmdFor
        if (opts.onProgress) opts.onProgress({ file: rel, name: b.name });
        const base = runOne(work, runner, rel, selectName, timeoutMs, selectQualified);
        if (base.passed < 1 || base.failed > 0) {
          // Split the vocabulary at the source so every accusation surface inherits it: only a test that
          // RAN and FAILED is accusable ('baseline Xp/Yf' — the HEAD-rot signal). A 0-failure non-run
          // (skip, zero-match selection, timeout kill, unparsable summary) is 'did-not-run' — fail-closed
          // inconclusive, never a block: the agent cannot fix a failure that does not exist.
          // baselineBad counts BOTH here (ran-and-failed AND did-not-run) — the same widened set the
          // wipeout hint reads — so the env-abort threshold mirrors that check's semantics exactly.
          baselineBad++;
          const why = `${base.failed > 0 ? 'baseline' : 'did-not-run'} ${base.passed}p/${base.failed}f`;
          inconclusive.push({ file: rel, line: b.line, name: b.name, why, detail: (base.out || '').slice(-400) });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'inconclusive', why });
          continue;
        }
        baselineOk++; // a green baseline exists — the env is not wiped out, so env-abort never fires from here on
        // ctx carries everything foldBlock needs for THIS block, gathered exactly where the inline code
        // used to declare its own locals — anyGutted/sawCompileFail are plain properties (not `let`s)
        // so pass 2 can flip them after pass 1 has already built this object; brokeFns/survivorFns/
        // survivors are arrays, mutated by push either way.
        const ctx = { b, rel, bodyMasked, shadowSignals, eligible, sutOf, brokeFns: [], survivorFns: [], survivors: [], anyGutted: false, sawCompileFail: false, relStarved: false, work, runner, selectName, selectQualified, timeoutMs, absTestKey, changed, deep: opts.deep, tallyBlock };
        const deferredRel = [];
        // Split by kind (cap two-pass): a falsy-`rel` entry guts inline, right here, exactly as before —
        // pass 1's value probing is byte-equivalent to the pre-cap-two-pass engine for a block with no
        // relational fns. A truthy-`rel` entry is NEVER gutted here; it is collected so its probe cost is
        // paid in pass 2, after every test file's value work has already run — a relational fn in an
        // early block can no longer eat the --max-probes budget a later block's value verdict (including
        // a hollow accusation) needs.
        // `rel: isRel` — the destructured field is renamed on the way in: this loop already has an
        // outer `rel` in scope (the test FILE's relative path). Binding the per-entry relational flag to
        // the bare name `rel` would shadow it for the rest of this loop body.
        const hasValueFns = eligible.some((e) => !e.rel);
        for (const { fn, sutRel, rel: isRel } of eligible) {
          if (isRel) { deferredRel.push({ fn, sutRel, rel: isRel }); continue; }
          gutOneFn(ctx, fn, sutRel, isRel);
        }
        if (deferredRel.length === 0) {
          // No relational fns in this block: fold immediately, at the same point in the loop as before —
          // old-engine parity for every value-only block.
          foldBlock(ctx);
        } else if (hasValueFns && ctx.brokeFns.length === 0) {
          // Accusation-shaped (confirm-before-accuse extended to budget): this block has value fns, and
          // NONE of them broke — the value evidence alone could already read hollow/blind, so a rel fn
          // still sitting unprobed in pass 2 is not "pure upside" here the way it is for a caught-locked
          // block below. Deferring risks pass 2 starving it and folding a HOLLOW on partial evidence that
          // the full picture would have caught (reviewer-found regression: a rel fn that breaks under its
          // sentinel, if never gutted, silently leaves a value-only survivor to accuse alone). Gut every
          // deferred fn INLINE, right now, with NO budget check — an at-stake accusation always pays its
          // full confirmation cost in this engine (same principle as the R5 recheck and the opposite-
          // sentinel pass), so this is byte-identical to the pre-cap-two-pass single-pass engine for this
          // block class. Then fold inline — never deferred, so `ctx.relStarved` stays false.
          for (const { fn, sutRel, rel: isRel } of deferredRel) gutOneFn(ctx, fn, sutRel, isRel);
          foldBlock(ctx);
        } else {
          // Either caught is already locked in (`ctx.brokeFns.length > 0` — a rel fn's own eventual
          // result can only ever promote a survivor's opposite-sentinel evidence or add a sibling
          // one-sided/bound entry; it can never erase the value fn that already broke, so starving it is
          // pure upside, never a false accusation) or this is a relational-only block (`!hasValueFns` —
          // no value fn ever existed to be accusation-shaped in the first place; its own fold ceiling is
          // one-sided/relation-unbound, never hollow — see the SAFE-form asymmetry). Safe to defer.
          deferredBlocks.push({ ctx, deferredRel });
        }
      }
    }
    // Pass 2 — drain deferred relational fns after every test file's value work is done. Same per-fn
    // gut code as pass 1 (gutOneFn), but budget-checked PER FN here (pass 1's value loop is
    // block-granular, unchanged) since pass 2 flattens every deferred block's remaining work into one
    // queue; once the cap binds, a deferred fn is simply never gutted — no probe, no record (see the
    // accounting note below).
    for (const { ctx, deferredRel } of deferredBlocks) {
      let starved = false;
      for (const { fn, sutRel, rel: isRel } of deferredRel) {
        if (probes >= maxProbes || (timeBudgetMs && Date.now() - probeStart >= timeBudgetMs)) { starved = true; break; }
        gutOneFn(ctx, fn, sutRel, isRel);
      }
      if (starved && !ctx.anyGutted) {
        // Budget-starved accounting (the only new branch — everything else reuses foldBlock verbatim):
        // this block had no value fns (else ctx.anyGutted would already be true from pass 1) AND its
        // relational fns never got a chance to run at all — 'sut-unresolved'/'ungutable' would mislabel
        // an analyzed-but-never-probed block as unlocatable. The honest label is the same one the
        // pre-baseline probe-cap check already uses.
        capped++;
        blockRecords.push({ file: ctx.rel, line: ctx.b.line, name: ctx.b.name, bodyMasked: ctx.bodyMasked, ...ctx.shadowSignals, verdict: 'skipped', why: 'probe-cap' });
      } else {
        // Either some fn got gutted (value evidence from pass 1, and/or at least one deferred rel fn
        // before the cap bound) or every deferred fn was attempted and none needed deferring further
        // (grossBreak/compile-fail reasons, not budget) — either way, the verbatim fold decides the
        // verdict. `relStarved` records whether the cap cut this block's rel loop off before every
        // deferredRel fn got a chance — only reachable here for a caught-locked-in or relational-only
        // block (the accusation-shaped case above never defers at all), but foldBlock's belt-and-braces
        // guard reads it regardless, as structural insurance against a future defer-decision change.
        ctx.relStarved = starved;
        foldBlock(ctx);
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); repoLock.release(); }
  // scored counts VERDICTS: caught + hollow + (deep) one-sided blocks — a one-sided block is a real
  // verdict on the test (binds one direction), it just never blocks.
  const scored = caught + hollow.length + oneSidedBlocks;

  // Change classification: only meaningful when the run has a diff scope at all (opts.changed or
  // opts.since); otherwise there is no "changed set" to classify against, so both stay null. Reads the
  // CURRENT on-disk source (dir, not the already-deleted `work` copy) — mutations were reverted per-probe
  // and `work` no longer exists at this point.
  let changes = null, changeSummary = null;
  if (changed) {
    const changedByFile = [];
    for (const sf of srcFiles) {
      if (!changed.has(canonKey(sf))) continue;
      const srel = toPosix(relative(dir, sf));
      const scode = readFileSync(sf, 'utf8');
      const slang = lang(sf);
      let ranges = null, granularity = 'file';
      // Hunk-level precision only when --since gives us a base ref to diff against; a bare opts.changed
      // scope (no ref) has no diff to compute hunks from, so every changed src file classifies at 'file'
      // granularity (its entire declared-fn set is "changed"). A git failure or unparsable diff falls back
      // the same way — never a thrown error out of prove().
      if (opts.since) {
        try {
          // argv form (never a shell string): opts.since/srel reach the git process as literal argv
          // entries, so a ref or path containing shell-special characters can't be (mis)interpreted.
          const out = execFileSync('git', ['diff', '-U0', opts.since, '--', srel], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          ranges = hunkNewRanges(out);
          granularity = 'hunk';
        } catch { ranges = null; granularity = 'file'; }
      }
      changedByFile.push({ file: srel, granularity, decls: changedDecls(scode, slang, ranges) });
    }
    ({ changes, changeSummary } = classifyChanges(changedByFile, blockRecords));
  }

  // Per-run aggregation (gross tier — JSON-only, undocumented, measurement gate): a fn qualifies only when
  // it survived at least one CAUGHT block (the novel class — see the survivorTally comment) AND was caught
  // in none — the conservative suppression clause that keeps a fn masked-in-one-block-but-proven-in-
  // another (the breakEvenSeries shape) from being a false finding. `[]` would mean nothing qualifies;
  // per spec that omits the field entirely rather than shipping an empty array for the common case.
  //
  // Fn-LEVEL exclusion vs hollow reports (adjudicated): any fn appearing in ANY r.hollow[].survivors list
  // is dropped, even when it also survived a caught block — a hollow-reported fn is already under audit,
  // and its caught-block survivals are context for THAT audit, not novel yield. This still matches on bare
  // name (not r.hollow[].survivorPairs' sutRel) and so over-excludes only in the rare cross-file same-name
  // case — conservative in the right direction for a novelty measurement (a dropped observation costs one
  // data point; a double-counted one corrupts the tally).
  const hollowFns = new Set(hollow.flatMap((h) => h.survivors));
  const grossSurvivorsList = [...survivorTally.values()].filter((e) => e.survivedIn.length > 0 && e.caughtIn === 0 && !hollowFns.has(e.fn));

  return { runner, scored, caught, hollow, weak, oneSided, oneSidedBlocks, ...(proven.length ? { proven } : {}), ...(opts.deep ? { weakSummary } : {}), inconclusive, skipped, outOfScope, probes, capped, envAborted, pct: scored ? Math.round((caught / scored) * 100) : null, changedFileCount, changes, changeSummary, ...(grossSurvivorsList.length ? { grossSurvivors: grossSurvivorsList } : {}), ...(scopeWarning ? { scopeWarning } : {}) };
}

// Plain-English translation of a skip/inconclusive why-code, for the unverifiable section only — a
// reader should never have to know what "sut-unresolved" means. A baseline/did-not-run/flaky/
// ambiguous-title inconclusive reason (free text, not a fixed code) reads as one generic readable
// phrase; anything truly unrecognized falls back to the raw reason verbatim rather than hiding it.
const UNVERIFIABLE_REASON_MSG = {
  'no-pin': 'only checks a mock / no value pinned',
  'one-sided': 'the binding test detects only one direction of error',
  'pin-unresolved': "pins a value the probe can't tie to a called function",
  'relation-unbound': "relational oracle — the mutant survived both extremes; the relation doesn't pin a value",
  'sut-unresolved': "can't locate the function from the test's imports",
  'dynamic-title': 'test name is computed at runtime',
  'ungutable': "no compiling wrong-value sentinel for this function (return type or body form)",
  'instrumented-test': 'needs a device/emulator',
  'unsupported-source-set': 'unsupported Gradle source set',
  'probe-cap': 'not probed — probe cap or time budget reached (raise --max-probes/--time-budget)',
  'env-abort': 'not probed — the run aborted after the first baselines all failed (likely wrong runner or broken build/environment)',
};
function readableUnverifiableReason(reason) {
  if (Object.prototype.hasOwnProperty.call(UNVERIFIABLE_REASON_MSG, reason)) return UNVERIFIABLE_REASON_MSG[reason];
  if (/^baseline |^did-not-run |^flaky baseline|^ambiguous title/.test(reason || '')) return 'the referencing test is inconclusive';
  if (/^runner-mismatch/.test(reason || '')) return "the detected runner can't run this test's language";
  return reason;
}

// r.hollow entries NOT already carried by a changed-function hollow row — the whole-scope findings every
// human diff surface must render (the exit code counts them; see formatDiffReport's comment). Shared by
// formatDiffReport here and formatMarkdown (mutation/gutcheck.mjs) so the two surfaces can never drift.
export function extraHollowOf(r) {
  const changeHollowBlocks = new Set((r.changes || []).filter((c) => c.status === 'hollow' && c.evidence && c.evidence.blocks)
    .flatMap((c) => c.evidence.blocks.map((b) => `${b.file}:${b.line}`)));
  return (r.hollow || []).filter((h) => !changeHollowBlocks.has(`${h.file}:${h.line}`));
}

// Boundary-blind-spot aggregate — a fold over r.oneSided rows, formatter-only (result shape, JSON,
// SARIF, exit codes untouched). Groups by the direction the test BINDS: posRed=true → red under the
// positive sentinel → binds only against too-high results; posRed=false → too-low. 'inline' = one
// header line (diff + markdown surfaces); 'breakdown' = header + per-direction file counts
// (full-scan surface, where volume lives). A single row always collapses to the singular inline form.
export function oneSidedLines(rows, style) {
  const n = rows.length;
  if (!n) return [];
  const hi = rows.filter((o) => o.posRed), lo = rows.filter((o) => !o.posRed);
  if (n === 1) return [`boundary blind spots: 1 one-sided test — binds only against ${hi.length ? 'too-high' : 'too-low'} results; never a blocker:`];
  const head = (txt) => `boundary blind spots: ${n} one-sided test(s) — ${txt}; never a blocker:`;
  if (style === 'breakdown') {
    const lines = [head('these bind one direction of error only')];
    for (const [group, label] of [[hi, 'too-high'], [lo, 'too-low']]) {
      if (!group.length) continue;
      const perFile = new Map();
      for (const o of group) perFile.set(o.file, (perFile.get(o.file) || 0) + 1);
      const files = [...perFile.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      lines.push(`  bind only against ${label} results (${group.length}): ${files.map(([f, c]) => `${f} (${c})`).join(', ')}`);
    }
    return lines;
  }
  if (!hi.length || !lo.length) return [head(`all bind only against ${hi.length ? 'too-high' : 'too-low'} results`)];
  return [head(`${hi.length} bind${hi.length === 1 ? 's' : ''} only against too-high results, ${lo.length} only against too-low`)];
}

// Full-suite human report (no diff scope — r.changeSummary is null). Pinned byte-for-byte by the
// gutcheck-cli.test.mjs "byte-identical to the release format" test and mutation/gutcheck.mjs's own
// banner()-then-formatReport() call: this function must never reference r.changeSummary/r.changes.
function formatFullScanReport(r) {
  const lines = [];
  const scope = r.outOfScope ? ` (${r.outOfScope} test blocks outside the diff)` : '';
  if (r.scored === 0 && (r.probes > 0 || (r.inconclusive || []).length > 0)) lines.push(`gutcheck: no verdicts — ${r.probes} test(s) probed, all inconclusive (${r.inconclusive.length} inconclusive, ${r.skipped.length} skipped). Runner: ${r.runner}.`);
  else if (r.scored === 0) lines.push(`gutcheck: no value-pinning tests to probe${scope} (${r.skipped.length} skipped, ${r.inconclusive.length} inconclusive). Runner: ${r.runner}.`);
  else {
    // Denominator-first headline: when tests were skipped or inconclusive, the
    // one line that gets quoted must carry the coverage fraction — "verdicts on X of Y tests" — so it can
    // never read as a whole-suite claim. A clean run (nothing skipped, nothing inconclusive) keeps the
    // single-clause release format byte-for-byte: there the scored count IS the denominator.
    const total = r.scored + (r.skipped || []).length + (r.inconclusive || []).length;
    if (total > r.scored) lines.push(`gutcheck: verdicts on ${r.scored} of ${total} tests (${Math.round((r.scored / total) * 100)}%) — ${r.caught}/${r.scored} (${r.pct}%) fail when the function they test is broken.${scope}  [${r.probes} probes, runner: ${r.runner}]`);
    else lines.push(`gutcheck: ${r.caught}/${r.scored} tests (${r.pct}%) fail when the function they test is broken.${scope}  [${r.probes} probes, runner: ${r.runner}]`);
  }
  const baselineFailRows = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
  const baselineFails = baselineFailRows.length;
  // The wipeout check counts BOTH 'baseline' (ran-and-failed) and 'did-not-run' (skip/zero-match/
  // timeout) rows: a probe set where every baseline is still the classic wrong-runner
  // symptom (nothing legitimately ran), and this banner is advice ("...or the detected runner can't
  // run them"), never an accusation — unlike the per-row ✗ listing just below, which stays scoped to
  // baselineFailRows only, since a did-not-run row never earns the "already fail" label.
  const baselineOrDidNotRunCount = (r.inconclusive || []).filter((i) => /^(baseline|did-not-run) /.test(i.why)).length;
  const allBaselinesFailed = r.scored === 0 && baselineOrDidNotRunCount > 0 && baselineOrDidNotRunCount === (r.inconclusive || []).length && r.hollow.length === 0;
  // The env-abort fail-fast (prove()) and this wipeout hint compose into ONE line: when the run stopped
  // after the first N baselines all failed, the hint states that fact (first N failed, likely wrong runner
  // or broken build/environment, fix it or --runner=<r>, M remaining not probed) instead of the plain
  // "every baseline run failed" phrasing — never two contradictory messages. r.envAborted is undefined on
  // an older/hand-built result, so that path stays byte-identical.
  if (allBaselinesFailed && r.envAborted)
    lines.push(`every baseline run failed before any mutation — the first ${baselineOrDidNotRunCount} all failed, so probing stopped (likely the wrong runner or a broken build/environment). Fix it or pass --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>. ${r.envAborted} remaining block(s) not probed.`);
  else if (allBaselinesFailed)
    lines.push(`every baseline run failed before any mutation — either these tests already fail, or the detected runner (${r.runner}) can't run them. Override with --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>.`);
  // PARTIAL baseline failures — a first-class signal (wild-pilot HEAD-rot finding: failing-at-HEAD tests
  // are common in the wild, and a partial set was previously silent here). A test that fails before any
  // mutation can't verify anything; fix it first. Deliberately scoped to tests gutcheck PROBED (a baseline
  // exists only for eligible blocks), never a whole-suite claim. The all-fail case above keeps its
  // runner-suspicion framing instead (a total wipeout usually means the runner, not the tests).
  else if (baselineFails > 0) {
    lines.push('');
    lines.push(`⚠️ ${baselineFails} probed test(s) already fail before any mutation — they verify nothing until they pass:`);
    for (const i of baselineFailRows) lines.push(`  ✗ ${i.file}:${i.line}  '${i.name}'`);
  }
  if (r.capped) lines.push(`(${r.capped} block(s) not probed — probe cap or time budget reached; raise --max-probes/--time-budget or narrow --since.)`);
  if (r.hollow.length) {
    lines.push('');
    lines.push(`${r.hollow.length} test(s) pass even when their function is gutted — they don't actually test it:`);
    for (const h of r.hollow) lines.push(`  ✗ ${h.file}:${h.line}  '${h.name}'  — survives gutting ${h.survivors.join(', ')}()`);
  } else if (r.scored > 0) lines.push(`✓ ${r.caught} function${r.caught === 1 ? '' : 's'} verified: gutted each, its test went red.${r.skipped.length ? ` ${r.skipped.length} test(s) skipped (see banner for reasons).` : ''}`);
  // Identity-stub advisory (--deep): per-FUNCTION ratios, not a per-test list — no-op tests pass identity
  // stubs by design (INTENTIONAL-NOOP / ACCIDENTAL-FIXED-POINT were the audit's two majority classes, and
  // zero of the 13 audited survivors were fully-fixed-point-covered), so naming individual tests reads as
  // an accusation the audit doesn't support. Never affects the exit code — advisory only.
  if (r.weak && r.weak.length) {
    lines.push('');
    lines.push('identity-stub advisory (--deep): tests that pass when the function is replaced by a passthrough (counts are stub probes, not all binding tests)');
    // A passed:0 fn had every identity stub CAUGHT — a success story, not an advisory — so it is omitted
    // entirely (final-review wave, item 6). r.weak.length > 0 guarantees at least one fn has passed > 0.
    for (const fn of Object.keys(r.weakSummary || {})) {
      const { stubbed, passed } = r.weakSummary[fn];
      if (!passed) continue;
      lines.push(`  ~ ${fn}: ${passed} of ${stubbed} identity-stub probes passed — may cover only fixed points (no-op tests do this by design)`);
    }
  }
  // One-sided tier (--deep): tests red under exactly one sentinel — they bind one direction of error
  // (threshold/comparison oracles). A verdict, never a blocker; each row states the two observed runs.
  if (r.oneSided && r.oneSided.length) {
    lines.push('');
    lines.push(...oneSidedLines(r.oneSided, 'breakdown'));
    for (const o of r.oneSided) lines.push(`  ~ ${o.file}:${o.line}  '${o.name}'  — ${o.fn}() gutted: ${o.posRed ? 'red under the positive sentinel, passes under the negative one' : 'passes under the positive sentinel, red under the negative one'}`);
  }
  // Side signals: two existing inconclusive buckets that were silent in the report — a flaky test
  // (unstable green re-run) and a title collision (two blocks share one runner selection). Neither is a
  // verdict on the test, so neither counts toward hollow/caught; surfaced as a one-line heads-up so a
  // reader doesn't read "0 hollow" as "everything sound" when some tests were simply unrunnable-as-a-
  // verdict. Only when count > 0 — a clean run (no such buckets) emits neither line (byte-for-byte no-op).
  const flakyN = (r.inconclusive || []).filter((i) => /^flaky baseline/.test(i.why)).length;
  if (flakyN) { lines.push(''); lines.push(`${flakyN} test(s) unstable across identical reruns (rerun instability, not a verdict)`); }
  const collisionN = (r.inconclusive || []).filter((i) => /^ambiguous title/.test(i.why)).length;
  if (collisionN) { lines.push(''); lines.push(`${collisionN} title collision(s) — colliding titles break per-test selection (rename or qualify)`); }
  return lines.join('\n');
}

// Diff-scoped human report (r.changeSummary present — a --since run). The verdict is the PRODUCT's
// answer ("what happened to the diff I just wrote") and leads unconditionally as line 1; hollow findings
// and already-failing baselines stay prominent right under it (never demoted); the whole-project probe
// mechanics — what mutation/gutcheck.mjs's CLI used to print as a banner() preamble ahead of everything,
// plus this function's own former "X/Y tests fail" and "✓ N verified" lines — collapse into ONE trailing
// parenthesized footnote, so a reader never has to wade through whole-probed-set detail to find the
// answer about their own diff. mutation/gutcheck.mjs's main() no longer calls banner() for this case.
function formatDiffReport(r) {
  const cs = r.changeSummary;
  const lines = [];
  // hollow>0 renders the count in CAPS and moves it right after "proven" for prominence.
  const fnsWord = `${cs.fns} function${cs.fns === 1 ? '' : 's'} in this diff`;
  const unverifiablePart = cs.unverifiable > 0 ? ` · ${cs.unverifiable} unverifiable` : '';
  // Same-diff-oracle provenance + probe-cap-out-of-unverifiable (Task 7): both FACT-ONLY, both rendered
  // only when their count is > 0 (undefined/0 on an older or hand-built changeSummary → no fragment,
  // byte-identical to before either field existed). "via tests changed in this diff" states a fact about
  // what changed alongside the proof, stated as fact, never as a verdict. "not probed (cap)" moves
  // probe-cap fns out of the unverifiable bucket at the summary level (row status is unaffected).
  const provenPart = (cs.sameDiffProven || 0) > 0 ? ` (${cs.sameDiffProven} via tests changed in this diff)` : '';
  const provenWord = `${cs.proven} proven${provenPart}`;
  const notProbedPart = (cs.notProbed || 0) > 0 ? ` · ${cs.notProbed} not probed (cap)` : '';
  // Whole-scope hollows the changed-function rows don't carry: the exit code counts r.hollow across the
  // WHOLE probed scope (a touched test file is probed whole-file), so a hollow whose survivor is not a
  // changed function would otherwise exit 1 with a headline reading "0 hollow" — a silent false negative
  // on THIS surface, the one a first-run user reads. extraHollowOf is the same set-subtraction
  // formatMarkdown (mutation/gutcheck.mjs) renders as its ❌ section; both the headline fragment and the
  // section below render only when non-empty, so a run with none stays byte-identical.
  const extraHollow = extraHollowOf(r);
  const extraHollowPart = extraHollow.length ? ` · ${extraHollow.length} HOLLOW beyond the diff` : '';
  const body = cs.hollow > 0
    ? `${provenWord}, ${cs.hollow} HOLLOW, ${cs.untested} with no binding test`
    : `${provenWord}, ${cs.untested} with no binding test, ${cs.hollow} hollow`;
  lines.push(`gutcheck: ${fnsWord} — ${body}${unverifiablePart}${notProbedPart}${extraHollowPart}.`);

  // Baseline-already-failing tests: prominent, never folded into the footnote — a probed test that fails
  // before any mutation verifies nothing until it passes, and the reviewer should fix it first.
  const baselineFailRows = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
  // See formatFullScanReport's twin comment: the wipeout check widens to BOTH prefixes (a did-not-run
  // row is still the classic wrong-runner symptom), while the per-row ✗ listing below stays scoped to
  // baselineFailRows only — a did-not-run row never earns the "already fail" label.
  const baselineOrDidNotRunCount = (r.inconclusive || []).filter((i) => /^(baseline|did-not-run) /.test(i.why)).length;
  const allBaselinesFailed = r.scored === 0 && baselineOrDidNotRunCount > 0 && baselineOrDidNotRunCount === (r.inconclusive || []).length && r.hollow.length === 0;
  if (allBaselinesFailed && r.envAborted) {
    // See formatFullScanReport's twin: the env-abort tail folds INTO the wipeout hint, one coherent line.
    lines.push('');
    lines.push(`every baseline run failed before any mutation — the first ${baselineOrDidNotRunCount} all failed, so probing stopped (likely the wrong runner or a broken build/environment). Fix it or pass --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>. ${r.envAborted} remaining block(s) not probed.`);
  } else if (allBaselinesFailed) {
    lines.push('');
    lines.push(`every baseline run failed before any mutation — either these tests already fail, or the detected runner (${r.runner}) can't run them. Override with --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>.`);
  } else if (baselineFailRows.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${baselineFailRows.length} probed test(s) already fail before any mutation — they verify nothing until they pass:`);
    for (const i of baselineFailRows) lines.push(`  ✗ ${i.file}:${i.line}  '${i.name}'`);
  }
  if (r.capped) { lines.push(''); lines.push(`(${r.capped} block(s) not probed — probe cap or time budget reached; raise --max-probes/--time-budget or narrow --since.)`); }

  // Per-status detail: hollow is NEVER demoted — its receipted ✗ file:line 'name' — survives gutting
  // fn() lines (plus the gutcheck --explain pointer) sit right under the verdict, same as the old
  // execution-based r.hollow list did, but attributed to the specific CHANGED function per row (more
  // precise than a bare survivors list when one block survives several changed functions).
  const byStatus = (s) => r.changes.filter((c) => c.status === s);
  const hollowFns = byStatus('hollow');
  if (hollowFns.length) {
    lines.push('');
    lines.push(`hollow — the test passes even when the function is gutted; fix the test (receipt: gutcheck --explain <file:line>) (${hollowFns.length}):`);
    for (const c of hollowFns) {
      const b = c.evidence && c.evidence.blocks && c.evidence.blocks[0];
      if (!b) continue;
      // wrongLayerShadow (JVM-only, static — mutation/wrongLayerShadow.mjs) never ran a mutant at all, so
      // it never earns "survives gutting" phrasing; it gets its own accurate tail instead.
      const tail = c.evidence.reason === 'wrong-layer-shadow'
        ? `re-implements the logic and asserts it against a second copy of itself (zero production contact): \`${c.evidence.echo}\``
        : `survives gutting ${c.fn}()`;
      lines.push(`  ✗ ${b.file}:${b.line}  '${b.name}'  — ${tail}`);
    }
  }
  if (extraHollow.length) {
    lines.push('');
    lines.push(`hollow beyond the changed functions — a touched test file is probed whole-file, and these tests pass even when the function they verify is gutted; fix the test (receipt: gutcheck --explain <file:line>) (${extraHollow.length}):`);
    for (const h of extraHollow) lines.push(`  ✗ ${h.file}:${h.line}  '${h.name}'  — still passes when ${(h.survivors || []).join(', ')}() is gutted`);
  }
  const untestedFns = byStatus('untested');
  if (untestedFns.length) {
    lines.push('');
    lines.push(`no binding test — no test names ${untestedFns.length === 1 ? 'it' : 'them'} (${untestedFns.length}):`);
    const names = untestedFns.map((c) => c.fn);
    const shown = names.slice(0, 10).join(', ');
    const more = names.length > 10 ? ` +${names.length - 10} more` : '';
    lines.push(`  ${shown}${more}`);
  }
  // probe-cap out of `unverifiable` (Task 7): split at the DETAIL level too, mirroring the summary split
  // above — a probe-cap row is real reference evidence, just never run under the cap, so it moves under
  // the existing "(N block(s) not probed …)" note's own vocabulary instead of sitting alongside a
  // genuinely-unverifiable (mock-only, etc.) row. Row status/reason are unchanged either way.
  const unverifiableFns = byStatus('unverifiable').filter((c) => c.evidence.reason !== 'probe-cap');
  if (unverifiableFns.length) {
    lines.push('');
    lines.push(`unverifiable — a test exists but I can't confirm it binds the function (${unverifiableFns.length}):`);
    lines.push('  ' + unverifiableFns.map((c) => `${c.fn} (${readableUnverifiableReason(c.evidence.reason)})`).join(', '));
  }
  const notProbedFns = byStatus('unverifiable').filter((c) => c.evidence.reason === 'probe-cap');
  if (notProbedFns.length) {
    lines.push('');
    lines.push(`not probed (cap) — probe cap or time budget reached before these could be checked (${notProbedFns.length}):`);
    lines.push('  ' + notProbedFns.map((c) => c.fn).join(', '));
  }

  // Identity-stub advisory (--deep): see formatFullScanReport's comment — same per-function ratios.
  if (r.weak && r.weak.length) {
    lines.push('');
    lines.push('identity-stub advisory (--deep): tests that pass when the function is replaced by a passthrough (counts are stub probes, not all binding tests)');
    for (const fn of Object.keys(r.weakSummary || {})) {
      const { stubbed, passed } = r.weakSummary[fn];
      if (!passed) continue;
      lines.push(`  ~ ${fn}: ${passed} of ${stubbed} identity-stub probes passed — may cover only fixed points (no-op tests do this by design)`);
    }
  }
  // One-sided tier (--deep): see formatFullScanReport's comment — same tier, same rows.
  if (r.oneSided && r.oneSided.length) {
    lines.push('');
    lines.push(...oneSidedLines(r.oneSided, 'inline'));
    for (const o of r.oneSided) lines.push(`  ~ ${o.file}:${o.line}  '${o.name}'  — ${o.fn}() gutted: ${o.posRed ? 'red under the positive sentinel, passes under the negative one' : 'passes under the positive sentinel, red under the negative one'}`);
  }
  // Side signals (flaky rerun instability / title collision) — see formatFullScanReport's comment.
  const flakyN = (r.inconclusive || []).filter((i) => /^flaky baseline/.test(i.why)).length;
  if (flakyN) { lines.push(''); lines.push(`${flakyN} test(s) unstable across identical reruns (rerun instability, not a verdict)`); }
  const collisionN = (r.inconclusive || []).filter((i) => /^ambiguous title/.test(i.why)).length;
  if (collisionN) { lines.push(''); lines.push(`${collisionN} title collision(s) — colliding titles break per-test selection (rename or qualify)`); }

  // The mechanics footnote: everything mutation/gutcheck.mjs's CLI used to print as a whole-probed-set
  // banner() preamble ahead of the report, PLUS this function's former "X/Y tests fail" and "✓ N
  // verified" lines, collapsed into one trailing line. The verdict above already answered "what happened
  // to my diff"; this is "how gutcheck got there" for anyone who wants the receipt.
  lines.push('');
  lines.push(`  (probed ${r.probes} fn${r.probes === 1 ? '' : 's'} · ${r.caught}/${r.scored} bound · ${r.skipped.length} skipped · runner ${r.runner})`);
  return lines.join('\n');
}

export function formatReport(r) {
  if (r.scopeError) return `gutcheck: ${r.scopeError}`;
  const body = r.changeSummary ? formatDiffReport(r) : formatFullScanReport(r);
  return r.scopeWarning ? `gutcheck: warning: ${r.scopeWarning}\n${body}` : body;
}

// CLI: gutcheck prove [dir] [--since=<ref>] [--files=substr,substr] [--runner=R] [--deep] [--json]
//   --deep adds the identity-stub advisory (fixed-point-weak tests) and the opposite-sentinel probe
//   (one-sided threshold oracles); advisories only — it never changes a verdict or the exit code.
//   --json prints JSON.stringify(result) instead of the human report (consumed by the Stop hook); the
//   exit code is unchanged (1 if any hollow, 2 on a scope error, else 0).
export function main(argv) {
  const args = argv.filter((a) => !a.startsWith('-'));
  const dir = args[0] || process.cwd();
  const opt = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : undefined; };
  const filesOpt = opt('files');
  const r = prove(dir, { files: filesOpt ? filesOpt.split(',') : undefined, runner: opt('runner'), since: opt('since'), deep: argv.includes('--deep'), maxProbes: opt('max-probes') ? Number(opt('max-probes')) : undefined });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r) + '\n');
  else process.stdout.write(formatReport(r) + '\n');
  if (r.scopeError) return 2;
  return r.hollow.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('prove.mjs')) process.exit(main(process.argv.slice(2)));
