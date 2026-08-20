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
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { grossBreak, grossBreakOpposite, hasFirstParamIdentityBranch, passthroughBreak, jsDeclSites, jvmDeclSites, locateKotlinSite, linkNodeModules } from './probe.mjs';
import { sutFnsIn } from './confirm.mjs';
import { codeOnly } from '../checker/lexer.mjs';
import { classifyChanges, hunkNewRanges, changedDecls } from './changes.mjs';
import { loadAliasesCached, aliasBases } from './alias.mjs';
import { selfEchoAssertion, titleSutCandidates } from './wrongLayerShadow.mjs';
import { acquireRepoLock, reapStaleWork, markWorkOwned } from './lock.mjs';
import { reEsc, balancedFrom, declRe, INSTANCE_RECEIVER_SKIP, instanceCallsIn, inferReceiverTypeFromCtor, pinnedFragmentsByKind, toPosix, canonKey } from './parse-utils.mjs';
// Extracted to parse-utils.mjs; re-exported so every existing importer of prove.mjs is unaffected
// (test/prove-exports.test.mjs pins that surface). pinnedFragmentsByKind is also imported above,
// since eligibleFnsDetail/the JS instance resolver/prove() still call it locally.
export { pinnedFragments, pinnedFragmentsByKind, braceArgFrom, topLevelComparisonSides, toPosix, canonKey } from './parse-utils.mjs';
import { javaExe, mavenBin, mavenModuleDir, jvmSourceSetGate, gradleTaskInfo, parseGradleResults, mavenCompiled, resolveJvmSut, jvmInstanceSuts, resolveJvmClass, hasReachableSameNameFun, inferKotlinReceiverType, inferJavaReceiverType } from './jvm.mjs';
// Extracted to mutation/jvm.mjs; re-exported so every existing importer of prove.mjs is unaffected
// (test/prove-exports.test.mjs pins that surface). Also imported above: every one of the ten below
// except jvmOwnPlainInstanceMember is still called by code remaining in this file, and
// resolveJvmClass/hasReachableSameNameFun/inferKotlinReceiverType/inferJavaReceiverType (never
// exported from prove.mjs — private to its own pin) back jvmInstanceContact's absence probe.
export {
  javaExe, mavenBin, mavenModuleDir, jvmSourceSetGate, gradleTaskInfo, parseGradleResults, mavenCompiled,
  resolveJvmSut, jvmOwnPlainInstanceMember, jvmInstanceSuts,
} from './jvm.mjs';
import { RUNNER_LANGS, detectRunner, runOne } from './runners.mjs';
// Extracted to mutation/runners.mjs; re-exported so every existing importer of prove.mjs is unaffected
// (test/prove-exports.test.mjs pins that surface). Only RUNNER_LANGS/detectRunner/runOne are still
// called by code remaining in this file. The rest (RUNNERS, resolveRunnerBin, fallbackCmdFor, testCmdFor,
// parseRun, nodeEffectiveCounts) have no remaining call site in this file — re-export only.
export {
  RUNNERS, RUNNER_LANGS, detectRunner, resolveRunnerBin, fallbackCmdFor, testCmdFor, parseRun,
  nodeEffectiveCounts, runOne,
} from './runners.mjs';
import { pyBlocks, resolvePySut, resolvePyClassMember } from './python-resolve.mjs';
// Extracted to mutation/python-resolve.mjs; re-exported so every existing importer of prove.mjs is
// unaffected (test/prove-exports.test.mjs pins that surface). pyBlocks/resolvePySut/resolvePyClassMember
// are still called by code remaining in this file (the Python block loop below), so both the plain
// import above and the re-export are needed. pythonExe is ALSO pinned on prove.mjs's surface (it was
// public there before any extraction — test/prove-exports.test.mjs's SURFACE list, captured before any
// export moved, already includes it) but has no remaining call site here now that pyBlocks/pyMemberOk
// (its only callers in this file) moved out with it — re-export only, no plain import.
export { pyBlocks, resolvePySut, resolvePyClassMember, pythonExe } from './python-resolve.mjs';
import { formatReport } from './report.mjs';
// Extracted to mutation/report.mjs; re-exported so every existing importer of prove.mjs is unaffected
// (test/prove-exports.test.mjs pins that surface). formatReport is also imported above since main()
// below still calls it directly; oneSidedLines/extraHollowOf have no remaining call site in this file
// now that formatFullScanReport/formatDiffReport (their only callers) moved out with them — re-export
// only, no plain import.
export { formatReport, oneSidedLines, extraHollowOf } from './report.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', '.gradle', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'out', 'coverage', '.next', '.svelte-kit', '.vite']);
const DEFAULT_TIMEOUT_MS = Number(process.env.GUTCHECK_PROBE_TIMEOUT_MS) || 60000;

// Reap orphaned prove() work copies at most ONCE per process (mutation/lock.mjs's reapStaleWork):
// gutcheck.mjs's --since-unresolvable and empty-scope full-suite fallbacks re-enter prove() up to
// twice in the same CLI process, and this module's own callers (tests, main()'s retries) may call
// prove() far more than that — the tmpdir sweep is startup hygiene, not per-run work, so repeating
// it inside one process only pays its cost (a full tmpdir readdir) again for zero extra benefit.
let staleWorkReaped = false;

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

// ---- block parsing (JS/TS it()/test(), and pytest def test_*) ----
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
const AFTER_TITLE_RE = /^\s*,\s*(?:async\s*)?(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\s*\*?\s*[A-Za-z_$]*\s*\([^)]*\))\s*\{/;
function scanTitledCalls(code, headRe) {
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
// Parameterized blocks — `it.each([...])('adds %i', fn)`, vitest's `.for`, the jest tagged-template
// table form `it.each` + backtick-table + `('title $a', fn)`, with optional modifier chains
// (`it.only.each`). The TITLE is runtime-expanded from the table (per-row `%i`/`$var` substitution),
// so every discovered block is `dynamic: true` regardless of the literal's quote kind: it can never
// be fed to a runner as a selector, but discovering it means prove() emits the honest
// `why: 'dynamic-title'` skip (with fileMasked) and classifyChanges reads a fn covered only by these
// as 'unverifiable', never the false 'untested'. Every non-parse falls closed to "not discovered"
// (the status quo): an unbalanced table, a missing title call, or a concise-body callback emits
// nothing rather than a corrupted block.
const EACH_HEAD_RE = /\b(?:it|test)(?:\.(?:only|skip|concurrent|failing))?\.(?:each|for)\s*(?=\(|`)/g;
function scanEachTitledCalls(code, maskedCode) {
  const out = [];
  for (const hm of code.matchAll(EACH_HEAD_RE)) {
    if (!(maskedCode.startsWith('it', hm.index) || maskedCode.startsWith('test', hm.index))) continue; // blanked region → phantom
    let p = hm.index + hm[0].length; // at the table's `(` or its tagged-template backtick
    if (code[p] === '(') {
      let d = 0, k = p;
      for (; k < code.length; k++) { const c = maskedCode[k]; if (c === '(') d++; else if (c === ')') { d--; if (!d) { k++; break; } } }
      if (d !== 0) continue; // unbalanced table — fail closed
      p = k;
    } else {
      let k = p + 1; // raw scan: the mask blanks the whole template, delimiters included
      while (k < code.length && !(code[k] === '`' && code[k - 1] !== '\\')) k++;
      if (k >= code.length) continue; // unterminated — fail closed
      p = k + 1;
    }
    let q = p;
    while (q < code.length && /\s/.test(code[q])) q++;
    if (code[q] !== '(') continue; // no title call — fail closed
    q++;
    while (q < code.length && /\s/.test(code[q])) q++;
    if (!'\'"`'.includes(code[q])) continue;
    const sq = scanQuoted(code, q);
    if (!sq) continue;
    const rest = AFTER_TITLE_RE.exec(code.slice(sq.end + 1));
    if (!rest) continue;
    out.push({ index: hm.index, title: sq.dynamic ? sq.raw : unescapeTitle(sq.raw), dynamic: true, openBrace: sq.end + rest[0].length });
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
  for (const tc of scanEachTitledCalls(code, maskedCode)) events.push({ kind: 'test', pos: tc.index, tc });
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
// `(\/|$)`: a BARE `.` or `..` (no trailing slash) is a relative import of the directory itself —
// radash's `import * as _ from '..'` — resolved by resolveRelative's `/index.*` candidates. The old
// slash-required form silently dropped those specs into the alias branch, which refused them
// (found by the 2026-07-29 corpus run: radash's entire suite sat behind exactly this).
const isRelative = (spec) => /^\.\.?(\/|$)/.test(spec);
// Exported so hasProductionContact (wrongLayerShadow's JS contact probe) can be unit-tested directly with
// a hand-built resolver, mirroring resolveJvmSut/resolvePySut's own direct-testing convention — no
// behavior change for prove()'s own internal call site.
export function makeResolver(srcFiles, dir) {
  const cache = new Map();
  return (fn, testAbs, imports) => {
    const key = `${testAbs}::${fn}`;
    if (cache.has(key)) return cache.get(key);
    const spec = imports.get(fn);
    const res = spec ? resolveSpecMember(spec, fn, testAbs, srcFiles, dir) : null;
    cache.set(key, res); return res;
  };
}
// The ONE spec→declaring-file semantics, shared by makeResolver (a test's direct import of `fn`) and
// jsNamespaceSuts (`NS.fn()` on a `* as NS` binding — the module export IS the same resolution
// question). Binds when the specifier is a RELATIVE file or matches a DECLARATIVE path alias
// (package.json `#` imports, tsconfig/jsconfig paths); builtins (node:*), bare deps (lodash, …)
// matching no alias rule, and un-imported globals never bind → the block is left unprobed, never a
// false HOLLOW. In both branches a direct declaration wins and only a fully-unresolved file considers
// the one-hop barrel follow.
function resolveSpecMember(spec, fn, testAbs, srcFiles, dir) {
  let res = null;
  if (isRelative(spec)) {
    const re = declRe(fn);
    const base = resolve(dirname(testAbs), spec);
    for (const target of [extCandidateKeys(base), tsSwapKeys(base)]) {
      if (!target) continue;
      let sawFile = false;
      for (const f of srcFiles) {
        if (!target.has(canonKey(f))) continue;
        sawFile = true;
        try { if (re.test(readFileSync(f, 'utf8'))) { res = toPosix(relative(dir, f)); break; } } catch {}
      }
      if (!res) {
        for (const f of srcFiles) {
          if (!target.has(canonKey(f))) continue;
          res = followReexportOnce(f, fn, srcFiles, dir);
          if (res) break;
        }
      }
      // A literal candidate FILE existing ends the search whether or not it resolved — the swap only
      // fires where the literal set matched nothing at all.
      if (res || sawFile) break;
    }
  } else {
    // Alias fallback (mutation/alias.mjs): ordered candidate bases, consumed with tsc's
    // first-existing-target semantics — the first base with a file ON DISK ends the search whether
    // or not the declaration is found there, because that is the file the runtime loads (falling
    // through to a later target would gut a file the test never runs: a false-verdict vector).
    // On-disk existence is deliberately broader than srcFiles membership — a target that exists
    // but is not a probeable source (a test-classified file, say) consumes the resolution and
    // refuses, fail-closed.
    const aliases = loadAliasesCached(dir);
    const bases = aliases.length ? aliasBases(spec, aliases) : null;
    if (bases) {
      const re = declRe(fn);
      const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
      for (const b of bases) {
        // Existence honors the ts-swap too: a `.js`-specified alias target whose only source is `.ts`
        // still counts as this target existing (literal candidates checked first, same precedence).
        let swapPaths = null;
        for (const [ext, alts] of TS_SWAP) if (b.endsWith(ext)) { swapPaths = alts.map((a) => b.slice(0, -ext.length) + a); break; }
        const literalExists = EXT_CANDIDATES.some((e) => isFile(b + e));
        if (!literalExists && !(swapPaths && swapPaths.some(isFile))) continue;
        const target = literalExists ? extCandidateKeys(b) : tsSwapKeys(b);
        const matches = srcFiles.filter((f) => target.has(canonKey(f)));
        for (const f of matches) {
          try { if (re.test(readFileSync(f, 'utf8'))) { res = toPosix(relative(dir, f)); break; } } catch {}
        }
        if (!res) for (const f of matches) { res = followReexportOnce(f, fn, srcFiles, dir); if (res) break; }
        break;
      }
    }
  }
  return res;
}
// Resolve a relative import specifier to the set of absolute source paths it could mean (ext + index
// forms), as canonKeys — so a case/8.3-short-name/symlink difference between the specifier's resolved
// form and the actual on-disk srcFiles entry (win32) still matches (replaces the old realpathSafe).
const EXT_CANDIDATES = ['', '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '/index.mjs', '/index.js', '/index.ts'];
const extCandidateKeys = (absBase) => new Set(EXT_CANDIDATES.map((e) => canonKey(absBase + e)));
function resolveRelative(testAbs, spec) {
  return extCandidateKeys(resolve(dirname(testAbs), spec));
}
// TS NodeNext idiom: specifiers say `.js` while the sources are `.ts` (`export * from './struct.js'`
// next to struct.ts — found on superstruct, where it hid a whole barrel from the hop). Returns the
// SWAPPED candidate set for a base whose extension has a TS source form, or null. Callers run the
// literal set first and consult this only when the literal candidates matched NOTHING — so a real
// on-disk .js (a repo genuinely shipping .js sources, or a built file beside its source) wins exactly
// as before and the swap can never redirect a resolution away from an existing literal match.
const TS_SWAP = [['.js', ['.ts', '.tsx']], ['.jsx', ['.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']]];
function tsSwapKeys(absBase) {
  for (const [ext, alts] of TS_SWAP) {
    if (absBase.endsWith(ext)) {
      const stem = absBase.slice(0, -ext.length);
      return new Set(alts.map((a) => canonKey(stem + a)));
    }
  }
  return null;
}

// One-hop re-export barrel follow: the imported file carries no DECLARATION of `fn`, but forwards it —
// `export { fn } from './impl.mjs'` (same-name only) or `export * from './impl.mjs'`. The runtime import
// reaches the declaration through exactly that hop, so gutting the resolved file genuinely breaks the
// test; anything less certain REFUSES (null → the block keeps its truthful `sut-unresolved` label):
//   - an ALIASED re-export (`sum as fn`) — the declared name differs from the tested name, so a gut
//     aimed at `fn` in the target could never break the function the test actually runs;
//   - a bare/builtin specifier — deps are never SUTs (same moat as the direct path);
//   - a chain deeper than one hop — the named target that is itself only a barrel resolves nothing,
//     and it never falls back to stars (an explicit name outranks a star in ESM, so a star hit there
//     would contradict what the runtime resolves);
//   - `export *` fan-outs where more than one target file declares `fn` — ambiguous, never first-wins.
// Raw-text scan, same convention as importMap/declRe — codeOnly would blank the specifier strings this
// needs. `export * as ns from` never matches the star pattern (it exports `ns`, not `fn`), and
// `export type { … }` never matches the named pattern (the `type` keyword breaks `export\s*{`).
function followReexportOnce(barrelAbs, fn, srcFiles, dir) {
  let text; try { text = readFileSync(barrelAbs, 'utf8'); } catch { return null; }
  const declaringTargets = (specs) => {
    const hits = new Set();
    const re = declRe(fn);
    for (const s of specs) {
      if (!isRelative(s)) continue;
      const base = resolve(dirname(barrelAbs), s);
      for (const target of [extCandidateKeys(base), tsSwapKeys(base)]) {
        if (!target) continue;
        let sawFile = false;
        for (const f of srcFiles) {
          if (!target.has(canonKey(f))) continue;
          sawFile = true;
          try { if (re.test(readFileSync(f, 'utf8'))) hits.add(f); } catch {}
        }
        if (sawFile) break; // literal file existed — the swap never overrides it (see tsSwapKeys)
      }
    }
    return [...hits];
  };
  const named = [];
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/).map((b) => b.trim());
      if (bits[0] === fn && bits[bits.length - 1] === fn) { named.push(m[2]); break; }
    }
  }
  if (named.length) {
    const hits = declaringTargets(named);
    return hits.length === 1 ? toPosix(relative(dir, hits[0])) : null;
  }
  const stars = [...text.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const hits = declaringTargets(stars);
  return hits.length === 1 ? toPosix(relative(dir, hits[0])) : null;
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
    for (const text of pinnedScanTexts(masked, frags)) {
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

// The scan texts a pinned block yields for receiver'd-call crediting: the pinned fragments themselves,
// plus one variable hop mirroring eligibleFns' own bare-var hop — a pinned bare var assigned (same-line,
// single-assignment only) from a call RHS. bareVars is the set of identifiers appearing anywhere in a
// pinned fragment (over-inclusive-but-safe, same discipline as eligibleFns). Shared by jsInstanceSuts
// and jsNamespaceSuts — extracted verbatim from the former's kind loop, byte-identical behavior.
// The reassigned-pinned-var refusal (fixture 15): >1 assignment to a name anywhere in the masked block
// body means the pinned value may not be THIS declaration's RHS result at all — refuse the hop outright.
// Both regexes carry the arrow-aware annotation-skip group between the name and `=`: without it, an
// ANNOTATED declaration's own `=` never matched (the `: Type` sits in between), so an annotated
// `let c: Calc = new Calc()` reassigned once elsewhere read asnCount 1 instead of 2 — the declaration's
// own assignment silently uncounted — and the ambiguity guard failed to fire.
function pinnedScanTexts(masked, frags) {
  const bareVars = new Set();
  for (const f of frags) for (const v of f.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\b/g)) bareVars.add(v[1]);
  const texts = [...frags];
  for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*(?:=>|[^=\n])+?)?[^\S\n]*=(?!>)[^\S\n]*([^\n;]+)/g)) {
    if (!bareVars.has(m[1])) continue;
    const asnCount = (masked.match(new RegExp(`(?<![\\w$.])${reEsc(m[1])}(?:\\s*:\\s*(?:=>|[^=\\n])+?)?\\s*=(?![=>])`, 'g')) || []).length;
    if (asnCount > 1) continue;
    texts.push(m[2]);
  }
  return texts;
}

// ---- JS/TS NAMESPACE-member SUT resolution: `_.sort(...)` on an `import * as _ from '..'` binding ----
// The runtime receiver of `NS.fn()` under a namespace import IS the module namespace object, so `NS.fn`
// is exactly the target module's export `fn` — the same resolution question makeResolver answers for a
// direct import, routed through the same resolveSpecMember core (relative or declarative-alias spec,
// direct declaration first, then one barrel hop — `import * as _ from '..'` over an `export * from`
// index composes to the declaring file). Wild receipt: radash's suite (258 pin-unresolved blocks) is
// exactly this shape.
// ONLY `import * as NS` binds — a DEFAULT import's members are properties of one exported value, not
// module exports, and a same-named top-level declaration in that file could be code the test never
// runs: gutting it would mint a false verdict. Every guard below is a REFUSAL path, mirroring
// jsInstanceSuts at the same coarseness:
//   - file-wide mock-framework taint (a module factory can replace the whole namespace);
//   - NS appearing as ANY callback/function parameter in the file (a fragment-level `_.sort()` could
//     bind the lambda's `_`, not the module — scope analysis is out of budget, refuse file-wide);
//   - NS locally re-declared (`const NS = …`, `function NS…`) anywhere in the file;
//   - NS monkey-patched (`NS.fn = …`) or Object.assign/defineProperty'd (frozen at ESM runtime, but a
//     CJS-interop namespace is not — refuse rather than reason about interop);
//   - a specifier that is neither relative nor a declarative alias, or a member with no unique
//     declaration through the core — resolveSpecMember refuses there.
export function jsNamespaceSuts(body, testCode, absTest, srcFiles, imports, dir) {
  const nsBindings = new Map(); // name -> { spec, cjs }
  for (const m of testCode.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) nsBindings.set(m[1], { spec: m[2], cjs: false });
  // CJS namespace form (`const R = require('..')`, the ramda shape): require() returns module.exports,
  // so `R.fn` is the target's export `fn` — plain-identifier LHS only; destructured requires stay on the
  // existing bare-name path. An ESM binding of the same name wins (a double binding is nonsense code —
  // the assignment-count guard below refuses it anyway).
  for (const m of testCode.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!nsBindings.has(m[1])) nsBindings.set(m[1], { spec: m[2], cjs: true });
  }
  if (!nsBindings.size) return [];
  const maskedTestCode = codeOnly(testCode, 'typescript');
  if (MOCK_TAINT.test(maskedTestCode)) return [];
  const paramNames = jsParamNames(maskedTestCode);
  const masked = codeOnly(body, 'typescript');
  const byKind = pinnedFragmentsByKind(masked, imports);
  const out = []; const seen = new Set();
  const credit = (method, sutRel, rel) => {
    const key = method + '::' + sutRel;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rel ? { fn: method, sutRel, rel: true } : { fn: method, sutRel });
  };
  for (const [frags, rel] of [[byKind.value, false], [byKind.relational, true]]) {
    if (!frags.length) continue;
    for (const text of pinnedScanTexts(masked, frags)) {
      if (hasTopLevelShortCircuit(text)) continue;
      for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const [, ns, method] = m;
        const binding = nsBindings.get(ns);
        if (!binding) continue;
        if (paramNames.has(ns)) continue;
        const nsE = reEsc(ns);
        if (binding.cjs) {
          // The CJS binding IS a `const NS = …`, so the ESM any-local-declaration refusal would kill
          // every credit. Instead: NS must be assigned exactly ONCE file-wide (the require itself) and
          // never be a function/class declaration — a rebound receiver could be anything.
          const asn = (maskedTestCode.match(new RegExp(`(?<![\\w$.])${nsE}\\s*=(?![=>])`, 'g')) || []).length;
          if (asn !== 1) continue;
          if (new RegExp(`\\b(?:function|class)\\s+${nsE}\\b`).test(maskedTestCode)) continue;
        } else if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${nsE}\\b`).test(maskedTestCode)) continue;
        if (new RegExp(`\\b${nsE}\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=(?![=>])`).test(maskedTestCode)) continue;
        if (new RegExp(`\\bObject\\s*\\.\\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\\s*\\(\\s*${nsE}\\b`).test(maskedTestCode)) continue;
        const sutRel = resolveSpecMember(binding.spec, method, absTest, srcFiles, dir);
        if (!sutRel) continue;
        // CJS-only target guard: a module.exports REASSIGNED to a non-object-literal
        // (`module.exports = SomeClass` / `= require(…)`) makes members properties of that one value —
        // a same-named top-level declaration could be code the test never runs. An object-literal
        // reassignment keeps members tied to their declarations and passes.
        if (binding.cjs) {
          try {
            const sutMasked = codeOnly(readFileSync(join(dir, sutRel), 'utf8'), 'typescript');
            if (/\bmodule\s*\.\s*exports\s*=(?!\s*\{)/.test(sutMasked)) continue;
          } catch { continue; }
        }
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
  // the wrong content. See survivorEvidenceValid — defined earlier in this file (parseGradleResults itself
  // lives in mutation/jvm.mjs, re-exported near the top) — for the read/write contract.
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
    // Every node_modules SKIP_DIRS stripped — the root's AND workspace-nested ones — is symlinked
    // back at its same relative path (see linkNodeModules for the monorepo rationale).
    linkNodeModules(dir, work);

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
      // Whole-FILE masked source, attached to dynamic-title records only (classifyChanges' file-level
      // reference fallback — see that function): a loop-generated characterization test takes its
      // subject from module scope (import + case table), so the fn's name never appears in the block
      // BODY the refs scan reads. Lazy + memoized: masking the full source costs nothing on the
      // overwhelmingly common zero-dynamic-title file. JS-only by construction (parseBlocks sets
      // dynamicTitle for template-interpolated titles; pyAst blocks never carry it).
      let fileMasked0 = null;
      const fileMasked = () => (fileMasked0 ??= codeOnly(code, 'typescript'));
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
          // Namespace-member reach (`_.sort()` on `import * as _`): same additive merge, same dedupe —
          // and same L === 'js' gate, for the same regex-fallback-Python reason as above.
          for (const inst of jsNamespaceSuts(b.body, code, absTest, srcFiles, imports, dir)) {
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
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: why0, ...(b.dynamicTitle ? { fileMasked: fileMasked() } : {}) });
          outOfScope++; continue;
        }
        if (b.dynamicTitle || !eligible.length) {
          skipped.push({ file: rel, line: b.line, name: b.name, why: why0 });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, ...shadowSignals, verdict: 'skipped', why: why0, ...(b.dynamicTitle ? { fileMasked: fileMasked() } : {}) });
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
