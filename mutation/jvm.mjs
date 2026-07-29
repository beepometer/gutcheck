// mutation/jvm.mjs — JVM target resolution and build-tool plumbing: Kotlin/Java SUT resolution, source-set
// gating, and Gradle/Maven task discovery plus result parsing. prove.mjs imports from here; which names it
// re-exports vs. keeps private is documented at prove.mjs's own import site, not here. The byte-identical
// compatibility notes inside are pinning observed behavior — do not tidy them.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { jvmDeclSites } from './probe.mjs';
import { codeOnly } from '../checker/lexer.mjs';
import { reEsc, balancedFrom, declRe, instanceCallsIn, inferReceiverTypeFromCtor, pinnedFragmentsByKind, toPosix, canonKey } from './parse-utils.mjs';

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

// mvn binary resolution — mirrors javaExe()'s discipline (every candidate is actually EXECUTED and
// validated before being trusted, never just assumed present): an explicit override
// (GUTCHECK_MVN — an absolute path to an mvn binary) wins first, then `mvn` on PATH, then the project's
// own Maven Wrapper jar (java -cp <dir>/.mvn/wrapper/maven-wrapper.jar
// org.apache.maven.wrapper.MavenWrapperMain — no mvnw script, same win32-EINVAL-safe argv-exec
// discipline resolveRunnerBin/the gradle wrapper use: no shell, no shim). The validation env derives
// JAVA_HOME from javaExe() first (exactly as runOne, in mutation/runners.mjs, does for the real invocation) so the `-v`
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

// Maven's compile-fail signal, DISTINCT from a failing test — verified live on both real shapes (see
// test/fixtures/runner-output/maven-{compile,test}-fail.txt): a non-compiling mutant prints "[ERROR]
// COMPILATION ERROR :" (and never reaches surefire, so no fresh XML exists — parseGradleResults reads
// {0,0}); a FAILING TEST prints "Tests run: N, Failures: M" + BUILD FAILURE but NEVER COMPILATION ERROR.
// Both print BUILD FAILURE, so that string alone can't tell them apart — COMPILATION ERROR is the only
// safe discriminator. Exported as its own pure function (unlike gradle's inline regex in runOne) because
// maven has no CI binary at all — this is the only CI-safe coverage for the false-verdict-critical
// classification (see test/maven-runner.test.mjs, driven off the captured fixture text above).
export function mavenCompiled(out) { return !/COMPILATION ERROR/.test(out); }

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

// Kotlin: an assignment site is `[val|var] RECEIVER [: Type] = …` (the optional `: Type` annotation is
// consumed but IGNORED — resolution is from the RHS constructor, not the annotation) or a bare
// `RECEIVER = …` reassignment. The leading `(?<![\w$.(])` rejects a member access (`x.a =`) and a named
// argument (`foo(a = Widget())`). The RHS constructor is `[pkg.]ClassName(` with a Capitalized simple
// name — a lowercase callee (`makeFoo()`, `listOf()`) is a factory, never a constructor, so it refuses.
export function inferKotlinReceiverType(maskedTestCode, receiver) {
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
export function inferJavaReceiverType(maskedTestCode, receiver) {
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
export function hasReachableSameNameFun(name, testCode, srcFiles) {
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
export function resolveJvmClass(className, testCode, absTest, srcFiles) {
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
