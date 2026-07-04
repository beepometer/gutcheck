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
import { grossBreak, passthroughBreak } from './probe.mjs';
import { sutFnsIn } from './confirm.mjs';
import { codeOnly } from '../checker/lexer.mjs';
import { classifyChanges, hunkNewRanges, changedDecls } from './changes.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', '.gradle', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'out', 'coverage', '.next', '.svelte-kit', '.vite']);
const DEFAULT_TIMEOUT_MS = Number(process.env.GUTCHECK_PROBE_TIMEOUT_MS || process.env.SKEPTIC_PROBE_TIMEOUT_MS) || 60000;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

function walk(dir, acc = []) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) { if (SKIP_DIRS.has(e.name)) continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); }
  return acc;
}
const isTestPath = (f) => (/\.(test|spec)\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f))
  || (/(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f))
  || (/\/(tests?|__tests__|spec)\//.test(f) && (/\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f) || /\.py$/.test(f)));

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
  for (const blk of [tracked, untracked]) for (const ln of blk.split('\n')) { const p = ln.trim(); if (p) set.add(resolve(repoRoot, p)); }
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
  return 'node';
}
// Runner IDs — the single source of truth: detectRunner only ever returns one of these, and the
// completeness meta-test (test/prove.test.mjs) iterates this list to guarantee every entry has both a
// testCmdFor command spec and a parseRun branch, backed by a fixture.
export const RUNNERS = ['vitest', 'jest', 'mocha', 'ava', 'pytest', 'node'];
// Windows: spawnSync('npx') cannot resolve the .cmd shim without a shell, and shell:true would
// reopen the injection hole argv-exec closed — so name the shim explicitly.
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
// Returns an argv spec { cmd, args } — NEVER a shell string. runOne execs it via spawnSync (no shell),
// so a test name containing shell-special characters (backtick, `$(...)`, quotes, …) is passed as a
// literal argument the shell never parses. reEsc(name) is REGEX escaping (still needed for node's
// --test-name-pattern and the vitest/jest -t regex matchers), not shell quoting.
// mocha's --grep IS a regex (reEsc it); ava's -m is a GLOB, not a regex — pass the RAW name, never reEsc.
export function testCmdFor(runner, file, name) {
  if (runner === 'vitest') return { cmd: NPX, args: ['vitest', 'run', file, '-t', reEsc(name)] };
  if (runner === 'jest') return { cmd: NPX, args: ['jest', file, '-t', reEsc(name), '--runInBand'] };
  if (runner === 'mocha') return { cmd: NPX, args: ['mocha', file, '--reporter', 'tap', '--grep', reEsc(name)] };
  if (runner === 'ava') return { cmd: NPX, args: ['ava', file, '--tap', '-m', name] };
  if (runner === 'pytest') return { cmd: pythonExe() || 'python', args: ['-m', 'pytest', file, '-k', name, '-q'] };
  return { cmd: 'node', args: ['--test', '--test-name-pattern', '^' + reEsc(name) + '$', file] };
}
// {passed, failed} from the runner SUMMARY — never the exit code (a zero-match run is green).
// parseRun always receives stdout+stderr CONCATENATED IN THAT ORDER (runOne), and these regexes are
// non-global .exec() — leftmost match wins. So stray summary-shaped text on stderr can only win when
// stdout has NO match at all (the jest case, whose summary IS on stderr). Keep that ordering.
export function parseRun(runner, out) {
  if (runner === 'node' || runner === 'mocha' || runner === 'ava') { const p = /#\s*pass\s+(\d+)/.exec(out); const f = /#\s*fail\s+(\d+)/.exec(out); return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 }; }
  const p = /(\d+) passed/.exec(out); const f = /(\d+) failed/.exec(out); return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 };
}
function runOne(cwd, runner, file, name, timeoutMs) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const { cmd, args } = testCmdFor(runner, file, name);
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', env, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  return { ...parseRun(runner, out), out };
}

// ---- block parsing (JS/TS it()/test(), and pytest def test_*) ----
function balancedFrom(s, openParen) { let d = 0, k = openParen; for (; k < s.length; k++) { const c = s[k]; if (c === '(') d++; else if (c === ')') { d--; if (!d) { k++; break; } } } return { arg: s.slice(openParen + 1, k - 1), end: k }; }
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
  const re = /\b(?:it|test)(?:\.(?:only|skip|concurrent|todo|failing))?\s*\(\s*(['"`])(.*?)\1\s*,\s*(?:async\s*)?(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function\s*\*?\s*[A-Za-z_$]*\s*\([^)]*\))\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    let d = 0, k = open; for (; k < code.length; k++) { const c = code[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { k++; break; } } }
    out.push({ name: m[2], body: code.slice(open + 1, k - 1), line: code.slice(0, m.index).split('\n').length });
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
export function ambiguousNames(blockNames, runner) {
  const amb = new Set();
  for (let i = 0; i < blockNames.length; i++) {
    const a = blockNames[i];
    if (runner === 'ava' && avaSpecial(a)) amb.add(a);
    for (let j = 0; j < blockNames.length; j++) {
      if (i === j) continue;
      const b = blockNames[j];
      if (runner === 'node' || runner === 'ava') { if (a === b) amb.add(a); }
      else if (a.includes(b) || b.includes(a)) amb.add(a);
    }
  }
  return amb;
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
const CHAI_PIN = /^\s*\.\s*(?:to|should)\s*\.\s*(?:(?:deep\s*\.\s*)?(?:equal|eql|include|contain)\b|have\s*\.\s*(?:deep\s*\.\s*)?(?:lengthOf|length|members|keys|string|ownProperty)\b)/;
// standalone chai `should` sound-form matcher, tested from the '.' immediately before `should`.
const SHOULD_SOUND = /^\.\s*should\s*\.\s*(?:(?:deep\s*\.\s*)?(?:equal|eql|include|contain)\b|have\s*\.\s*(?:deep\s*\.\s*)?(?:lengthOf|length|members|keys|string|ownProperty)\b)/;
// Module specifiers that resolve to node's `assert` — a local name bound to one of these (aliased default
// import/require, or a destructured named import) is recognized as an assert call even under a non-literal
// name. A name bound to any OTHER module (lodash, …) is never treated as assert — no false HOLLOW.
const ASSERT_SPECS = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const ASSERT_METHODS = /^(?:equal|strictEqual|deepEqual|deepStrictEqual)$/;
export function pinnedFragments(body, imports = new Map()) {
  body = codeOnly(body, 'typescript'); // mask strings/comments FIRST — a code sample embedded in a string
  // (or a commented-out assertion) must never be seen by the scans below (no false HOLLOW). Idempotent on
  // already-masked input, so re-masking here is harmless when eligibleFns has already masked its copy.
  const frags = [];
  for (const m of body.matchAll(/expect\s*\(/g)) {
    const { arg, end } = balancedFrom(body, m.index + m[0].length - 1);
    const after = body.slice(end);
    if (VALUE_PIN.test(after) || CHAI_PIN.test(after)) {
      frags.push(arg);
      const mm = VALUE_PIN_CALL.exec(after);
      if (mm) frags.push(balancedFrom(after, mm.index + mm[0].length - 1).arg);
    }
  }
  for (const m of body.matchAll(/\bassert(?:\.(?:strictEqual|deepStrictEqual|deepEqual|equal))?\s*\(/g)) {
    if (/\bassert\s*\($/.test(m[0])) continue; // bare assert(...) is a truthiness check, not value-pinning
    frags.push(balancedFrom(body, m.index + m[0].length - 1).arg);
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
  for (const m of body.matchAll(/\bassert\s+(.+?)\s*===?\s*(.+?)(?:$|\n)/gm)) { frags.push(m[1]); frags.push(m[2]); } // pytest / chai assert a == b
  return frags;
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
export function eligibleFns(body, candidateFns, imports = new Map()) {
  const masked = codeOnly(body, 'typescript'); // mask once; reused for both scans below (pinnedFragments
  // re-masks its input too — codeOnly is idempotent on already-masked text — so each stays independently safe).
  const frags = pinnedFragments(masked, imports);
  if (!frags.length) return [];
  const fragText = frags.join(' ; ');
  const calls = (txt, fn) => new RegExp('\\b' + reEsc(fn) + '\\s*\\(').test(txt);
  const eligible = new Set(candidateFns.filter((fn) => calls(fragText, fn)));
  // one variable hop: a bare var pinned by a matcher, assigned from a SUT call
  const bareVars = new Set(); for (const f of frags) for (const v of f.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\b/g)) bareVars.add(v[1]);
  for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$]\w*)\s*=\s*([^\n;]+)/g)) {
    if (!bareVars.has(m[1])) continue;
    const outer = topLevelCallees(m[2]);
    for (const fn of candidateFns) if (outer.includes(fn)) eligible.add(fn);
  }
  return [...eligible];
}

// ---- SUT resolution: the non-test source file that the TEST FILE actually imports a fn from ----
// Parse a test file's import bindings → Map<localName, specifier>. ESM `import` + CJS `require`.
export function importMap(code) {
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
  return m;
}
const isRelative = (spec) => /^\.\.?\//.test(spec);
function declRe(fn) {
  const e = reEsc(fn);
  return new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${e}\\b|\\b(?:export\\s+)?(?:const|let|var|function|class)\\s+${e}\\b|\\bfunction\\s*\\*\\s*${e}\\b|\\bdef\\s+${e}\\b|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`);
}
function makeResolver(srcFiles, dir) {
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
      const target = resolveRelative(testAbs, spec); // absolute candidate path(s)
      for (const f of srcFiles) {
        if (!target.has(realpathSafe(f))) continue;
        try { if (re.test(readFileSync(f, 'utf8'))) { res = relative(dir, f); break; } } catch {}
      }
    }
    cache.set(key, res); return res;
  };
}
// Resolve a relative import specifier to the set of absolute source paths it could mean (ext + index forms).
function resolveRelative(testAbs, spec) {
  const base = resolve(dirname(testAbs), spec);
  const exts = ['', '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '/index.mjs', '/index.js', '/index.ts'];
  return new Set(exts.map((e) => realpathSafe(base + e)));
}
const realpathSafe = (p) => { try { return realpathSync(p); } catch { return p; } };

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
// Bind a pinned call name to its SUT .py file IMPORT-AWARE: only through a `from MODULE import fn` the test
// actually wrote (py_blocks emits those bindings) — a name the test did not import never binds, so no false
// HOLLOW. A relative import (`level`>0) climbs parents from the test file's dir; an absolute import resolves
// against the test file's dir (pytest prepends the test's rootdir to sys.path under the flat layout). The
// resolved file must also DECLARE `def fn`. Returns the SUT path relative to dir, or null (→ skip the block).
export function resolvePySut(fn, pyImports, absTest, srcFiles, dir) {
  const binding = pyImports.find((b) => b.local === fn);
  if (!binding) return null;
  let base = dirname(absTest);
  for (let i = 1; i < (binding.level || 0); i++) base = dirname(base);
  const segs = binding.module ? binding.module.split('.') : [];
  const modBase = segs.length ? resolve(base, ...segs) : base;
  const cands = new Set([modBase + '.py', join(modBase, '__init__.py')].map(realpathSafe));
  const re = declRe(fn);
  for (const f of srcFiles) {
    if (!cands.has(realpathSafe(f))) continue;
    try { if (re.test(readFileSync(f, 'utf8'))) return relative(dir, f); } catch {}
  }
  return null;
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
  if (opts.files && opts.files.length) testFiles = testFiles.filter((f) => opts.files.some((s) => f.includes(s)));
  const srcFiles = all.filter((f) => (/\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f) || /\.py$/.test(f)) && !isTestPath(f));
  const resolveSut = makeResolver(srcFiles, dir);
  const lang = (f) => (f.endsWith('.py') ? 'python' : 'js');
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxProbes = opts.maxProbes || Infinity; // R6: bound latency on a large diff; default unlimited

  // diff scope: a Set of absolute changed paths (from opts.changed, or resolved from opts.since via git)
  let changed = opts.changed || null;
  if (!changed && opts.since) { changed = changedFilesSince(dir, opts.since); if (!changed) return { runner, scored: 0, caught: 0, hollow: [], inconclusive: [], skipped: [], outOfScope: 0, probes: 0, pct: null, scopeError: `--since ${opts.since}: not a git repo, or unknown ref`, changes: null, changeSummary: null }; }
  // canonicalize the changed set so it compares against canonical absTest/SUT paths (dir is realpath'd
  // above; a caller-supplied or symlinked path would otherwise never match). A no-op for already-canonical
  // --since entries; a deleted file (realpath throws) keeps its literal path and simply won't match.
  if (changed) changed = new Set([...changed].map((p) => { try { return realpathSync(p); } catch { return p; } }));
  const changedFileCount = changed ? changed.size : undefined;

  const work = mkdtempSync(join(tmpdir(), 'gutcheck-prove-'));
  let caught = 0; const hollow = []; const inconclusive = []; const skipped = []; const weak = []; let probes = 0; let outOfScope = 0; let capped = 0;
  // true denominators for the --deep identity-stub advisory — per-fn, not per-test: stubbed = passthrough
  // probes attempted for fn, passed = the stub survived (also lands in `weak`). An audit found most
  // survivors legitimate (no-op branches / accidental fixed points), so this reports ratios, never a
  // verdict. Built only when opts.deep; prove() returns it only then (see the final return).
  const weakSummary = opts.deep ? {} : undefined;
  // blockRecords: in-memory only (never returned) — one entry per verdicted block (caught/hollow/skipped/
  // inconclusive), carrying its masked body so classifyChanges can later attribute a changed fn's evidence.
  const blockRecords = [];
  try {
    // cpSync throws raw (EACCES, …) on an unreadable file/subdir anywhere in the tree — caught here so
    // that surfaces as a friendly scopeError instead of a stack trace. The return stays inside this outer
    // try so the finally below still runs and cleans up `work`.
    try {
      cpSync(dir, work, { recursive: true, filter: (src) => !new RegExp(`(^|[\\\\/])(${[...SKIP_DIRS].join('|')})([\\\\/]|$)`).test(src) });
    } catch (e) {
      return { runner, scored: 0, caught: 0, hollow: [], weak: [], inconclusive: [], skipped: [], outOfScope: 0, probes: 0, capped: 0, pct: null, changedFileCount, scopeError: `cannot read ${dir}: ${e && e.code || e}`, changes: null, changeSummary: null };
    }
    const nm = join(dir, 'node_modules');
    // 'junction' needs no privileges on Windows (plain dir symlinks do); non-win32 keeps 'dir'.
    if (existsSync(nm)) { try { symlinkSync(nm, join(work, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {} }

    for (const tf of testFiles) {
      const rel = relative(dir, tf); const code = readFileSync(tf, 'utf8'); const L = lang(tf);
      const absTest = resolve(dir, rel);
      const imports = importMap(code);
      // Python precision path: when python3/python is available, the stdlib-ast helper gives the test
      // blocks + which SUT calls are value-PINNED + the `from … import` bindings — so a unittest
      // `self.assertEqual(...)` block becomes eligible (the regex pinnedFragments misses it). Falls back to
      // the regex Python branch (parseBlocks + eligibleFns) when the interpreter is absent.
      const pyAst = (L === 'python') ? pyBlocks(absTest) : null;
      const blocks = pyAst ? pyAst.blocks : parseBlocks(code, L);
      const ambiguous = ambiguousNames(blocks.map((b) => b.name), runner);
      for (const b of blocks) {
        // Masked once per block (JS: strip strings/comments so a code sample in a string can't false-
        // match a fn reference later; pyAst blocks are already ast-derived, so b.body is used as-is).
        const bodyMasked = pyAst ? b.body : codeOnly(b.body, 'typescript');
        const pinnedFns = pyAst
          ? [...new Set(b.pins)]
          : eligibleFns(b.body, sutFnsIn(b.body), imports);
        const eligible = pinnedFns
          .map((fn) => ({ fn, sutRel: pyAst ? resolvePySut(fn, pyAst.imports, absTest, srcFiles, dir) : resolveSut(fn, absTest, imports) }))
          .filter((x) => x.sutRel);
        if (changed && !(changed.has(absTest) || eligible.some((e) => changed.has(resolve(dir, e.sutRel))))) {
          // Record the block BEFORE dropping it out of scope: a changed fn whose only tests are weak or
          // unresolved lives in blocks this gate never probes — with no record, classifyChanges would
          // report that fn 'untested' ("no test mentions it"), which is false. outOfScope++, the result
          // arrays, and every counter stay byte-identical; execution verdicts (caught/hollow) are
          // unaffected since those only ever arise from probed blocks.
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'skipped', why: pinnedFns.length ? 'sut-unresolved' : 'no-pin' });
          outOfScope++; continue;
        }
        if (!eligible.length) {
          const why = pinnedFns.length ? 'sut-unresolved' : 'no-pin';
          skipped.push({ file: rel, line: b.line, name: b.name, why });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'skipped', why });
          continue;
        }
        if (probes >= maxProbes) { capped++; continue; } // R6: cap reached — report, never silently drop
        // Fail-closed on ambiguous selection, but ONLY for a block that would otherwise be probed — after
        // the scope/eligibility/cap gates above, immediately before the baseline run. An out-of-scope,
        // skipped, or capped block keeps its own bucket, so diff-scoped outOfScope/inconclusive
        // denominators (the Stop hook, corpus re-drives) are never corrupted by files a diff didn't touch.
        if (ambiguous.has(b.name)) {
          const why = 'ambiguous title — another test in this file matches the same runner selection';
          inconclusive.push({ file: rel, line: b.line, name: b.name, why });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'inconclusive', why });
          continue;
        }
        if (opts.onProgress) opts.onProgress({ file: rel, name: b.name });
        const base = runOne(work, runner, rel, b.name, timeoutMs);
        if (base.passed < 1 || base.failed > 0) {
          const why = `baseline ${base.passed}p/${base.failed}f`;
          inconclusive.push({ file: rel, line: b.line, name: b.name, why, detail: (base.out || '').slice(-400) });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'inconclusive', why });
          continue;
        }
        let anyBroke = false; const survivors = []; let anyGutted = false; const brokeFns = [];
        for (const { fn, sutRel } of eligible) {
          const abs = join(work, sutRel); let orig; try { orig = readFileSync(abs, 'utf8'); } catch { continue; }
          const lang = sutRel.endsWith('.py') ? 'python' : 'typescript';
          const broken = grossBreak(orig, fn, lang);
          if (broken === null || broken === orig) continue;
          anyGutted = true; probes++;
          writeFileSync(abs, broken);
          const r = runOne(work, runner, rel, b.name, timeoutMs);
          writeFileSync(abs, orig);
          if (r.failed > 0) { anyBroke = true; brokeFns.push({ fn, abs, orig, lang }); }
          else if (r.passed > 0) survivors.push(fn);
        }
        if (anyBroke) {
          caught++;
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'caught', caughtFns: brokeFns.map((x) => x.fn) });
        }
        else if (survivors.length) {
          // R5 flake guard: a HOLLOW verdict rests on the unmutated baseline being green AND the gutted
          // mutant still passing. If the test is flaky (unstable green), re-running the now-restored
          // unmutated test may not be green — then the survivor-pass proves nothing and we must not call
          // it hollow. (The SUT was restored after each mutant run, so this runs the original code.)
          const recheck = runOne(work, runner, rel, b.name, timeoutMs);
          if (recheck.passed >= 1 && recheck.failed === 0) {
            hollow.push({ file: rel, line: b.line, name: b.name, survivors });
            blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'hollow', survivors });
          } else {
            const why = 'flaky baseline (unstable green) — not a reliable HOLLOW';
            inconclusive.push({ file: rel, line: b.line, name: b.name, why });
            blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'inconclusive', why });
          }
        }
        else if (anyGutted) {
          const why = 'mutant ran 0 tests';
          inconclusive.push({ file: rel, line: b.line, name: b.name, why });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'inconclusive', why });
        }
        else {
          const why = 'ungutable';
          skipped.push({ file: rel, line: b.line, name: b.name, why });
          blockRecords.push({ file: rel, line: b.line, name: b.name, bodyMasked, verdict: 'skipped', why });
        }
        // Depth tier (opt-in): a fn the gross stub broke but an IDENTITY stub does not was only exercised on
        // a fixed point — the assertion does not pin the function's transformation. Advisory, not a finding.
        if (opts.deep) for (const { fn, abs, orig, lang } of brokeFns) {
          const stub = passthroughBreak(orig, fn, lang);
          if (stub === null || stub === orig) continue;
          probes++;
          writeFileSync(abs, stub);
          const r = runOne(work, runner, rel, b.name, timeoutMs);
          writeFileSync(abs, orig);
          if (!weakSummary[fn]) weakSummary[fn] = { stubbed: 0, passed: 0 };
          weakSummary[fn].stubbed++;
          if (r.failed === 0 && r.passed > 0) { weak.push({ file: rel, line: b.line, name: b.name, fn }); weakSummary[fn].passed++; }
        }
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const scored = caught + hollow.length;

  // Change classification: only meaningful when the run has a diff scope at all (opts.changed or
  // opts.since); otherwise there is no "changed set" to classify against, so both stay null. Reads the
  // CURRENT on-disk source (dir, not the already-deleted `work` copy) — mutations were reverted per-probe
  // and `work` no longer exists at this point.
  let changes = null, changeSummary = null;
  if (changed) {
    const changedByFile = [];
    for (const sf of srcFiles) {
      if (!changed.has(sf)) continue;
      const srel = relative(dir, sf);
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

  return { runner, scored, caught, hollow, weak, ...(opts.deep ? { weakSummary } : {}), inconclusive, skipped, outOfScope, probes, capped, pct: scored ? Math.round((caught / scored) * 100) : null, changedFileCount, changes, changeSummary };
}

export function formatReport(r) {
  const lines = [];
  if (r.scopeError) return `gutcheck: ${r.scopeError}`;
  const scope = r.outOfScope ? ` (${r.outOfScope} test blocks outside the diff)` : '';
  if (r.scored === 0) lines.push(`gutcheck: no value-pinning tests to probe${scope} (${r.skipped.length} skipped, ${r.inconclusive.length} inconclusive). Runner: ${r.runner}.`);
  else lines.push(`gutcheck: ${r.caught}/${r.scored} tests (${r.pct}%) fail when the function they test is broken.${scope}  [${r.probes} probes, runner: ${r.runner}]`);
  const baselineFails = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why)).length;
  if (r.scored === 0 && baselineFails > 0 && baselineFails === (r.inconclusive || []).length && r.hollow.length === 0)
    lines.push(`every baseline run failed before any mutation — either these tests already fail, or the detected runner (${r.runner}) can't run them. Override with --runner=<vitest|jest|mocha|ava|pytest|node>.`);
  if (r.capped) lines.push(`(${r.capped} block(s) not probed — probe cap reached; raise --max-probes or narrow --since.)`);
  if (r.hollow.length) {
    lines.push('');
    lines.push(`${r.hollow.length} test(s) pass even when their function is gutted — they don't actually test it:`);
    for (const h of r.hollow) lines.push(`  ✗ ${h.file}:${h.line}  "${h.name}"  — survives gutting ${h.survivors.join(', ')}()`);
  } else if (r.scored > 0) lines.push(`✓ verified ${r.caught} function${r.caught === 1 ? '' : 's'} your tests genuinely catch (broke each, the test went red). ${r.skipped.length} test(s) skipped (see banner for reasons).`);
  // Identity-stub advisory (--deep): per-FUNCTION ratios, not a per-test list — no-op tests pass identity
  // stubs by design (INTENTIONAL-NOOP / ACCIDENTAL-FIXED-POINT were the audit's two majority classes, and
  // zero of the 13 audited survivors were fully-fixed-point-covered), so naming individual tests reads as
  // an accusation the audit doesn't support. Never affects the exit code — advisory only.
  if (r.weak && r.weak.length) {
    lines.push('');
    lines.push('identity-stub advisory (--deep): tests that pass when the function is replaced by a passthrough');
    // A passed:0 fn had every identity stub CAUGHT — a success story, not an advisory — so it is omitted
    // entirely (final-review wave, item 6). r.weak.length > 0 guarantees at least one fn has passed > 0.
    for (const fn of Object.keys(r.weakSummary || {})) {
      const { stubbed, passed } = r.weakSummary[fn];
      if (!passed) continue;
      lines.push(`  ~ ${fn}: ${passed} of ${stubbed} identity-stub probes passed — may cover only fixed points (no-op tests do this by design)`);
    }
  }
  // Change-verification section: only on a diff-scoped run (changeSummary is null on a plain full-suite
  // run — nothing prints here, so this is a byte-for-byte no-op on the pre-report format). No percentages
  // — counts only, per every renderer in this feature.
  if (r.changeSummary) {
    const cs = r.changeSummary;
    lines.push('');
    lines.push(`change verification: ${cs.fns} function${cs.fns === 1 ? '' : 's'} changed`);
    lines.push(`  proven ${cs.proven} · hollow ${cs.hollow} · unverifiable ${cs.unverifiable} · untested ${cs.untested}`);
    const byStatus = (s) => r.changes.filter((c) => c.status === s);
    const hollowFns = byStatus('hollow');
    if (hollowFns.length) {
      lines.push('');
      lines.push(`hollow (survives gutting — doesn't test it): ${hollowFns.length}`);
      lines.push('  ' + hollowFns.map((c) => c.fn).join(', '));
    }
    const untestedFns = byStatus('untested');
    if (untestedFns.length) {
      lines.push('');
      lines.push(`untested (no test mentions them): ${untestedFns.length}`);
      const names = untestedFns.map((c) => c.fn);
      const shown = names.slice(0, 10).join(', ');
      const more = names.length > 10 ? ` +${names.length - 10} more` : '';
      lines.push(`  ${shown}${more}`);
    }
    const unverifiableFns = byStatus('unverifiable');
    if (unverifiableFns.length) {
      lines.push('');
      lines.push(`unverifiable (dominant reason in parens): ${unverifiableFns.length}`);
      lines.push('  ' + unverifiableFns.map((c) => `${c.fn} (${c.evidence.reason})`).join(', '));
    }
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

// CLI: gutcheck prove [dir] [--since=<ref>] [--files=substr,substr] [--runner=R] [--deep] [--json]
//   --deep adds the identity-stub advisory (fixed-point-weak tests); it never changes the exit code.
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
