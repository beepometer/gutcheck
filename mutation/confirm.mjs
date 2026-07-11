// mutation/confirm.mjs — turn the high-recall static candidates (weak/shadow-oracle flags) into
// EXECUTION-confirmed verdicts. For each candidate the checker nominated, find the production function
// feeding the flagged test, run the mutation probe (gut it, run only that test file), and reclassify:
//   SOUND        → the static flag was a false positive (a real, discriminating test) — cleared
//   HOLLOW       → the oracle genuinely does not check the SUT — confirmed (promoted to a hard finding)
//   INCONCLUSIVE → couldn't resolve / baseline / run — left as the original advisory
// This is precision WITHOUT a parser: the probe RUNS the test, so assertion dialect and multi-line shape
// never matter. JS/TS only for now (the probe's default `node --test <file>` runs a single JS test file);
// other languages return unsupported and their candidates stay advisory.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { codeOnly } from '../checker/lexer.mjs';
import { walkFiles } from '../checker/corpus.mjs';
import { testBlocks, FRAMEWORK } from '../checker/kinds/weakOracleGuard.mjs';
import { probe } from './probe.mjs';

const JS_EXT = /\.(?:m|c)?[jt]sx?$/;
const KEYWORD = /^(?:if|for|while|switch|catch|return|await|new|typeof|function|async|do|else|throw)$/;
// Kotlin control-flow keywords + stdlib SCOPE functions that take a trailing lambda but are NEVER an
// adopter SUT. Excluded (kotlin/java only) from BOTH the `name(` scan and the trailing-lambda scan below:
// a same-named src/main `fun run`/`fun with` gutted while the test actually invoked the STDLIB form would
// survive its mutant → a false HOLLOW. (Downstream is already fail-closed — the import/package-gated,
// overload-checked resolver only guts a uniquely-declared name — so this is precision defense-in-depth for
// the rare adopter that coincidentally declares one of these names in a reachable package.)
const KOTLIN_SCOPE = new Set([
  // control flow that can be written `kw { … }` / `kw(x) { … }`
  'when', 'try', 'do', 'if', 'for', 'while', 'else', 'catch', 'finally', 'init', 'this', 'it',
  // stdlib scope / builder functions (receiverless or paren'd) whose result is the lambda's value
  'run', 'runCatching', 'runBlocking', 'runTest', 'with', 'let', 'apply', 'also', 'use', 'repeat',
  'lazy', 'synchronized', 'buildString', 'buildList', 'buildMap', 'buildSet', 'sequence',
  'measureTime', 'measureTimeMillis', 'measureNanoTime',
  // coroutine builders / scopes
  'launch', 'withContext', 'coroutineScope', 'supervisorScope', 'withTimeout', 'flow', 'channelFlow', 'produce',
  // JUnit / MockK lambda-takers (assertions and stubbing, not SUTs)
  'assertThrows', 'assertDoesNotThrow', 'assertAll', 'assertTimeout', 'assertTimeoutPreemptively',
  'every', 'coEvery', 'verify', 'coVerify', 'verifyAll', 'verifyOrder', 'verifySequence', 'justRun',
]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// weak-oracle / shadow-oracle / assertion-free findings are probe-confirmable (each nominates a SUT call
// to gut). The id may be language-prefixed (js-weak-oracle-guard, shadow-oracle-guard, js-assertion-free-test).
const PROBE_KIND = /(?:^|-)(?:weak-oracle-guard|shadow-oracle-guard|assertion-free-test)$/;

export const isJsTs = (ext) => JS_EXT.test(ext || '');

// candidate SUT function names CALLED inside a test block (non-framework, non-keyword, non-method calls).
// `lang` (trailing, optional — every JS/py call site passes nothing, so behavior there is byte-identical):
// when 'kotlin'/'java', ALSO surface receiver-method callees (JCalc.square(...), obj.method(...)) — JVM
// SUTs are routinely called as static/companion/instance methods, unlike the bare-fn convention this
// scan was built for. Over-capturing is safe: the eligibility filter (pinnedFragments/eligibleFns) and
// the fail-closed SUT resolver only credit a name that's both actually pinned AND declared in src/main.
export function sutFnsIn(body, lang) {
  const names = [];
  // Lookbehind (non-consuming) so adjacent calls aren't skipped: `eq(compute(5))` → [eq, compute].
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\s*\(/g)) {
    const id = m[1];
    // KOTLIN only: also drop stdlib scope/control-flow names (`with(x){}`, `synchronized(l){}`, `repeat(n){}`) —
    // the paren'd form is captured here but must never become a gut target for Kotlin (KOTLIN_SCOPE), where the
    // val-hop below can credit it. NOT applied to Java (no Kotlin scope fns; a Java method legitimately named
    // `run`/`use`/`with` must stay a candidate — dropping it flips a CAUGHT block to a false HOLLOW) nor to
    // JS/py (byte-identical).
    if (!FRAMEWORK.has(id) && !KEYWORD.test(id) && !names.includes(id) && !(lang === 'kotlin' && KOTLIN_SCOPE.has(id))) names.push(id);
  }
  if (lang === 'kotlin') {
    // Trailing-lambda calls: `name { … }` — a Kotlin call whose lambda is the sole/last argument, written
    // with NO parens (`yaml { … }`, idiomatic DSL builders). Only a BARE lowercase-initial name is taken: an
    // Uppercase `Foo { }` is an ambiguous SAM-constructor / type literal, and a receiver'd `obj.build { }`
    // needs receiver-TYPE inference (jvmInstanceSuts' job) — both fail closed here (lookbehind rejects a
    // leading `.`/word char; `[a-z_]` rejects the uppercase form). Control-flow + stdlib scope functions are
    // excluded (KOTLIN_SCOPE). Over-capture is otherwise bounded downstream: the pin/eligibility gate and the
    // fail-closed resolver only ever gut a name that is BOTH pinned AND uniquely declared in the src/main.
    for (const m of body.matchAll(/(?<![.\w$])([a-z_]\w*)\s*\{/g)) {
      const id = m[1];
      if (!FRAMEWORK.has(id) && !KEYWORD.test(id) && !KOTLIN_SCOPE.has(id) && !names.includes(id)) names.push(id);
    }
  }
  if (lang === 'kotlin' || lang === 'java') {
    // Receiver-method calls, but ONLY on a CAPITALIZED receiver (`JCalc.square(`, `Companion.of(`) —
    // a Type/companion/static call. A lowercase-variable receiver (`list.size(`, `map.get(`) is NOT
    // captured: those method names collide with common stdlib operations, and gutting a same-named
    // src/main `fun size` when the test actually called `List.size` would falsely survive → false
    // HOLLOW. The immediate receiver segment before `.method(` must start uppercase (the lookbehind
    // anchors on that segment, so a chain like `a.B.c(` captures `c` off receiver `B`).
    // Residual (accepted): an UPPERCASE stdlib static (`Collections.sort`, `Math.max`) can still be
    // captured, but is bounded downstream — Task 7's SUT resolver is import/package-gated and only
    // guts a name declared in the adopter's src/main. Instance methods on lowercase variables are a
    // deliberate reach gap (measure-then-promote), not a correctness hole.
    for (const m of body.matchAll(/(?<![\w$])[A-Z][\w$]*\s*\.\s*([A-Za-z_$]\w*)\s*\(/g)) {
      const id = m[1];
      if (!FRAMEWORK.has(id) && !KEYWORD.test(id) && !names.includes(id)) names.push(id);
    }
  }
  return names;
}

// the it()/test() callback body whose source span contains a 1-based line (fall back to the whole file).
function bodyForLine(code, lineNo) {
  for (const b of testBlocks(code)) {
    const start = code.slice(0, b.index).split('\n').length;
    const end = start + (b.body.match(/\n/g) || []).length;
    if (lineNo >= start && lineNo <= end + 1) return b.body;
  }
  return code;
}

function declRe(fn) {
  const e = esc(fn);
  return new RegExp(
    `\\b(?:function|class)\\s+${e}\\b`
    + `|\\bfunction\\s*\\*\\s*${e}\\b`
    + `|\\b(?:const|let|var)\\s+${e}\\b`
    + `|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`,
  );
}

// a NON-test source file under the main roots that declares fn, as a path relative to dir; null if none.
function resolveSutFile(dir, mainRoots, ext, fn, isTest) {
  const re = declRe(fn);
  const roots = (mainRoots && mainRoots.length ? mainRoots : ['']).map((r) => join(dir, r));
  for (const root of roots) {
    for (const abs of walkFiles(root, ext)) {
      const rel = relative(dir, abs);
      if (isTest(rel)) continue;
      let code; try { code = codeOnly(readFileSync(abs, 'utf8'), 'typescript'); } catch { continue; }
      if (re.test(code)) return rel;
    }
  }
  return null;
}

function confirmOne(dir, cfg, finding, ext, isTest) {
  let code;
  try { code = codeOnly(readFileSync(join(dir, finding.file), 'utf8'), 'typescript'); } catch { return { verdict: 'INCONCLUSIVE', why: 'cannot read test file' }; }
  const mainRoots = (cfg.paths && cfg.paths.srcRoots && cfg.paths.srcRoots.main) || [];
  const testCmd = `node --test ${finding.file}`;
  let anyResolved = false; let hollow = null;
  for (const fn of sutFnsIn(bodyForLine(code, finding.line))) {
    const sutFile = resolveSutFile(dir, mainRoots, ext, fn, isTest);
    if (!sutFile) continue;
    anyResolved = true;
    const { verdict } = probe(dir, { testFile: finding.file, sutFile, sutFn: fn, testCmd });
    // any gutted SUT fn that BREAKS the test ⇒ the test discriminates something real ⇒ SOUND (cleared).
    if (verdict === 'SOUND') return { verdict: 'SOUND', sutFn: fn, sutFile, why: `gutting ${fn}() failed the test — a real oracle` };
    if (verdict === 'HOLLOW') hollow = { verdict: 'HOLLOW', sutFn: fn, sutFile, why: `gutting ${fn}() left the test green — the oracle does not check it` };
  }
  if (hollow) return hollow; // all resolved SUT fns survived gutting ⇒ confirmed hollow
  return { verdict: 'INCONCLUSIVE', why: anyResolved ? 'no SUT function could be baselined (deps/env?)' : 'no SUT function resolved to a source file' };
}

// confirm(dir, cfg, findings) → { supported, results:[{ finding, verdict, sutFn, sutFile, why }], counts }
export function confirm(dir, cfg, findings) {
  const ext = cfg.language.fileExt;
  if (!isJsTs(ext)) return { supported: false };
  const isTest = (rel) => {
    const p = rel.replace(/\\/g, '/');
    return /\.(?:test|spec)\.[a-z]+$/.test(p) || /(?:^|\/)(?:test|tests|__tests__|spec)\//.test(p);
  };
  const results = findings
    .filter((f) => PROBE_KIND.test(f.check))
    .map((finding) => ({ finding, ...confirmOne(dir, cfg, finding, ext, isTest) }));
  const counts = { hollow: 0, sound: 0, inconclusive: 0 };
  for (const r of results) counts[r.verdict.toLowerCase()]++;
  return { supported: true, results, counts };
}
