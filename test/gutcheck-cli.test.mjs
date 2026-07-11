import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync, execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync as _mkdtemp, writeFileSync as _write, mkdirSync as _mkdir } from 'node:fs';
import { tmpdir as _tmp } from 'node:os';
import { join as _join } from 'node:path';
import { formatMarkdown } from '../mutation/gutcheck.mjs';

const GUT = resolve('mutation/gutcheck.mjs');
const head = "import { test } from 'node:test'; import assert from 'node:assert';";

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gut-cli-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
const run = (args) => spawnSync(process.execPath, [GUT, ...args], { encoding: 'utf8' });

// a project whose only test is HOLLOW: its expected value re-runs the function under test
const HOLLOW_PROJ = {
  'package.json': '{"type":"module"}',
  'src/lib.mjs': 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n',
  'test/t.test.mjs': `${head} import { total } from '../src/lib.mjs';\ntest('totals', () => { const e = total([{p:2,q:3}]); assert.strictEqual(total([{p:2,q:3}]), e); });\n`,
};

test('gutcheck --version prints the gutcheck identity', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^gutcheck \d/);
});

test('gutcheck on a hollow project: self-check banner + legibility banner + REJECT, exit 1', () => {
  const d = project(HOLLOW_PROJ);
  try {
    const r = run([d, '--runner=node']);
    assert.match(r.stdout, /self-check ✓/, 'self-check banner shown');
    assert.match(r.stdout, /probed \d+ function/, 'legibility banner shown');
    assert.match(r.stdout, /survives gutting total/, 'names the hollow test/function');
    assert.equal(r.status, 1, 'exit 1 when a hollow test is present');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --explain shows the proof for one hollow test', () => {
  const d = project(HOLLOW_PROJ);
  try {
    const r = run(['--explain', 'test/t.test.mjs:2', d, '--runner=node']);
    assert.match(r.stdout, /HOLLOW/);
    assert.match(r.stdout, /987654321/, 'shows the literal mutation applied');
    assert.match(r.stdout, /\(src\/lib\.mjs\)/, 'the hollow receipt names the survivor file');
    assert.equal(r.status, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A dynamic (template-literal-interpolated) test title (Task 2) has no statically-knowable runtime value
// — --explain must name that reason specifically, not fall through to the generic "no value-pinning
// assertion" message (this test does pin a value; the title is the reason it's unprobeable).
test('gutcheck --explain on a dynamic (template-literal-interpolated) test title explains why it is unprobeable', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function dbl(x){ return x * 2; }\n',
    'test/t.test.mjs': head + " import { dbl } from '../src/lib.mjs';\n" +
      "const id = 3;\n" +
      "test(`dbl of ${id}`, () => { assert.strictEqual(dbl(id), 6); });\n",
  });
  try {
    const r = run(['--explain', 'test/t.test.mjs:3', d, '--runner=node']);
    assert.match(r.stdout, /not probed/);
    assert.match(r.stdout, /interpolation/i, 'names the specific reason, not the generic no-value-pinning message');
    assert.equal(r.status, 0, 'not-probed is not a failing verdict');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The run banner (Task 2) must also break out the dynamic-title reason, mirroring no-pin/sut-unresolved/ungutable.
test('gutcheck banner reports a dynamic test title as its own skip reason', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function dbl(x){ return x * 2; }\n',
    'test/t.test.mjs': head + " import { dbl } from '../src/lib.mjs';\n" +
      "const id = 3;\n" +
      "test(`dbl of ${id}`, () => { assert.strictEqual(dbl(id), 6); });\n",
  });
  try {
    const r = run([d, '--runner=node']);
    assert.match(r.stdout, /1 skipped \(1 test title is dynamic \(template interpolation\)\)/);
    assert.equal(r.status, 0, 'a dynamic-only project has zero hollow, zero caught — not a failure');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck lint flags a deterministic triage violation (derivation mismatch), exit 1', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'test/t.test.mjs': "import { test } from 'node:test';\ntest('area', () => {\n  expect(area(5)).toBe(80.0); // 3.14159 * 5 * 5 = 78.54\n});\n",
  });
  try {
    const r = run(['lint', d]);
    assert.equal(r.status, 1, 'exit 1 on a finding');
    assert.match(r.stdout + r.stderr, /derivation/, 'names the derivation-coherence check');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck lint on a clean project: exit 0', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'test/t.test.mjs': `${head}\ntest('ok', () => { assert.strictEqual(1 + 1, 2); });\n`,
  });
  try { assert.equal(run(['lint', d]).status, 0); } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck lint flags fallback-collapse (compare-to-empty with a || [] fallback), exit 1', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function getItems() { return null; }\n',
    'test/t.test.mjs': `${head} import { getItems } from '../src/lib.mjs';\ntest('items empty', () => { const res = { items: getItems() }; assert.deepEqual((res.items || []).map(x => x.id), []); });\n`,
  });
  try {
    const r = run(['lint', d]);
    assert.equal(r.status, 1, 'exit 1 on a finding');
    assert.match(r.stdout + r.stderr, /fallback/, 'names the fallback-collapse check');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Dogfood gate: `gutcheck lint` must stay clean on THIS repo. This is the regression test for the
// class of bug where a check scans through quote/backtick boundaries and flags its own fixture
// strings (test specimens that quote a code shape as TEXT, never execute it) — see fallbackCollapse's
// blankStrings fix. If a future check reintroduces that class, this test goes RED.
test('gutcheck lint on this repo itself: exit 0 (self-lint clean)', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const r = run(['lint', ROOT]);
  assert.equal(r.status, 0, `gutcheck lint must exit 0 on its own repo, got:\n${r.stdout}${r.stderr}`);
});

test('gutcheck --format github emits an ::error annotation per hollow test, exit 1', () => {
  const d = project(HOLLOW_PROJ);
  try {
    const r = run([d, '--runner=node', '--format=github']);
    assert.doesNotMatch(r.stdout, /self-check/, 'no banner in machine mode');
    assert.match(r.stdout, /^::error file=[^,]*t\.test\.mjs,line=\d+,title=[^:]*::/m, 'a GitHub error annotation');
    assert.match(r.stdout, /totals/, 'names the hollow test');
    assert.equal(r.status, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --format sarif emits valid SARIF with a hollow-test result, exit 1', () => {
  const d = project(HOLLOW_PROJ);
  try {
    const r = run([d, '--runner=node', '--format=sarif']);
    const sarif = JSON.parse(r.stdout);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].tool.driver.name, 'gutcheck');
    assert.equal(sarif.runs[0].results.length, 1);
    assert.equal(sarif.runs[0].results[0].ruleId, 'hollow-test');
    assert.match(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, /t\.test\.mjs$/);
    assert.equal(r.status, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --format sarif on a clean project: 0 results, exit 0', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a,b){ return a+b; }\n',
    'test/t.test.mjs': `${head} import { add } from '../src/lib.mjs';\ntest('adds', () => { assert.strictEqual(add(2,3), 5); });\n`,
  });
  try {
    const r = run([d, '--runner=node', '--format=sarif']);
    assert.equal(JSON.parse(r.stdout).runs[0].results.length, 0);
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --json emits machine-readable output with no banners', () => {
  const d = project(HOLLOW_PROJ);
  try {
    const r = run([d, '--runner=node', '--json']);
    assert.doesNotMatch(r.stdout, /self-check/, 'no banner under --json');
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hollow.length, 1);
    assert.equal(r.status, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// the first-run experience: a healthy repo must never read as "nothing happened" — it gets a positive
// artifact naming what was actually verified, not just a bare "No hollow oracles" line.
test('a healthy repo prints the positive artifact, never a bare nothing', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a,b){ return a+b; }\n',
    'test/t.test.mjs': `${head} import { add } from '../src/lib.mjs';\ntest('adds', () => { assert.strictEqual(add(2,3), 5); });\n`,
  });
  try {
    const r = run([d, '--runner=node']);
    assert.match(r.stdout, /\d+ function(s)? verified/, 'names what it actually verified');
    assert.doesNotMatch(r.stdout, /^No hollow oracles/m, 'never just the bare no-hollow-oracles line');
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// an empty --since scope (the diff touched no probeable test) is a silent loss on a first run — gutcheck
// must fall back to scanning the whole suite rather than reporting "probed 0 functions" and stopping.
test('an empty --since scope falls back to a full-suite scan instead of a silent zero', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a,b){ return a+b; }\n',
    'test/t.test.mjs': `${head} import { add } from '../src/lib.mjs';\ntest('adds', () => { assert.strictEqual(add(2,3), 5); });\n`,
  });
  try {
    execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init', { cwd: d });
    writeFileSync(join(d, 'docs.txt'), 'unrelated untracked change\n'); // touches nothing probeable
    const r = run([d, '--runner=node', '--since=HEAD']);
    assert.match(r.stdout, /full suite/, 'explains the fallback to a full-suite scan');
    assert.match(r.stdout, /\d+ function(s)? verified/, 'the fallback scan still lands on the positive artifact');
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --demo shows a planted catch with no project needed', () => {
  const r = run(['--demo']);
  assert.match(r.stdout, /demo/i, 'labels the run as a demo');
  assert.match(r.stdout, /survives gutting/, 'shows the planted hollow test being caught');
  assert.equal(r.status, 1, 'the planted hollow test is a visible catch (exit 1)');
});

function runCli(args, cwd) {
  // spawnSync (not execFileSync) so stderr is captured on the success path too — execFileSync only
  // returns stdout when the process exits 0, which would silently hide a machine-mode self-check banner.
  const r = spawnSync('node', [GUT, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
// tiny git project: one committed SUT + one committed sound test (node:test, zero install)
function gitProject() {
  const d = mkdtempSync(join(tmpdir(), 'gc-args-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('sound', () => { assert.strictEqual(dbl(3), 6); });\n");
  for (const c of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']])
    execFileSync('git', c, { cwd: d, stdio: 'ignore' });
  return d;
}

// gitProject() plus a second, untested function in the same source file (`ghost`) and an uncommitted
// edit that touches both fn bodies (same-line trailing comment — stable line numbers, isolated
// single-line git hunks, mirroring Task 2's e2e fixture pattern).
function gitProjectWithChange() {
  const d = mkdtempSync(join(tmpdir(), 'gc-change-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'),
    'export function dbl(x){ return x * 2; }\n' +
    'export function ghost(x){ return x + 1; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('sound', () => { assert.strictEqual(dbl(3), 6); });\n");
  for (const c of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']])
    execFileSync('git', c, { cwd: d, stdio: 'ignore' });
  // uncommitted "agent edit": touch both fn bodies (same-line trailing comment keeps line numbers stable)
  writeFileSync(join(d, 'src/lib.mjs'),
    'export function dbl(x){ return x * 2; } // touched\n' +
    'export function ghost(x){ return x + 1; } // touched\n');
  return d;
}

test('human output leads with the diff verdict on --since runs, then the reworded change-verification detail, then a single mechanics footnote (no banner() preamble)', () => {
  const d = gitProjectWithChange(); // helper below: base commit + edit to a tested fn and an untested fn
  const r = runCli(['--since=HEAD', '--no-self-check'], d);
  assert.match(r.out, /gutcheck: 2 functions in this diff — 1 proven, 1 with no binding test, 0 hollow\./, 'the diff verdict is present');
  assert.match(r.out, /no binding test — no test names (it|them) \(1\):/);
  assert.doesNotMatch(r.out, /change verification:/, 'the redundant counts line is dropped — the lead line already states them');
  // release UX pass #2: banner()'s whole-probed-set preamble no longer prints ahead of the report at
  // all — the diff verdict is line 1, and the mechanics move to a single trailing footnote instead.
  assert.equal(r.out.split('\n')[0], 'gutcheck: 2 functions in this diff — 1 proven, 1 with no binding test, 0 hollow.', 'the diff verdict is the very first line — no banner() preamble ahead of it');
  const diffIdx = r.out.indexOf('functions in this diff');
  const footIdx = r.out.indexOf('(probed');
  assert.ok(diffIdx >= 0 && footIdx > diffIdx, 'the mechanics footnote trails the diff verdict');
  assert.match(r.out, /\(probed \d+ fns? · \d+\/\d+ bound · \d+ skipped · runner \S+\)\s*$/, 'the trailing mechanics footnote, exact shape');
});

test('human output for a full-suite run is byte-identical to the release format (changes null)', () => {
  const d = gitProject();
  const r = runCli(['--no-self-check'], d);
  // exact pinned output (release UX pass: the dangling "0 test(s) skipped (see banner …)" clause is
  // omitted when nothing was skipped — the banner shows no skipped segment at 0, so the pointer dangled).
  assert.equal(r.out, 'probed 1 function · runner=node\ngutcheck: 1/1 tests (100%) fail when the function they test is broken.  [1 probes, runner: node]\n✓ 1 function verified: gutted each, its test went red.\n');
});

// ---- release UX pass: usage errors exit 2 BEFORE any probe runs (a CI typo must never silently pass
// or silently produce the wrong surface), and vocabulary is identical across surfaces ----

test('markdown without --since is a usage error: exit 2, no probe, reason on stderr', () => {
  const d = gitProject();
  const r = runCli(['--format=markdown'], d);
  assert.equal(r.status, 2);
  assert.match(r.err, /--format=markdown requires --since/);
  assert.ok(!/probing #/.test(r.out + r.err), 'must not pay the probe cost for a usage error');
});

test('unknown --format is a usage error: exit 2, names the valid formats', () => {
  const d = gitProject();
  const r = runCli(['--format=sairf'], d);
  assert.equal(r.status, 2);
  assert.match(r.err, /unknown --format.*sarif\|github\|markdown/);
});

test('unknown --runner is a usage error: exit 2, names the valid runners', () => {
  const d = gitProject();
  const r = runCli(['--runner=nonsense'], d);
  assert.equal(r.status, 2);
  assert.match(r.err, /unknown --runner.*gradle/);
});

test('unknown flag is a usage error: exit 2 (a typo of a behavior flag must not silently change semantics)', () => {
  const d = gitProject();
  const r = runCli(['--no-fallbck'], d);
  assert.equal(r.status, 2);
  assert.match(r.err, /unknown flag --no-fallbck/);
});

test('--explain uses the frozen verdict vocabulary: PROVEN, never SOUND', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function dbl(n){ return n*2; }\n',
    'test/t.test.mjs': `${head} import { dbl } from '../src/lib.mjs';\ntest('doubles', () => { assert.strictEqual(dbl(2), 4); });\n`,
  });
  try {
    const r = run(['--explain', 'test/t.test.mjs:2', d, '--runner=node']);
    assert.match(r.stdout, /→ PROVEN\./);
    assert.doesNotMatch(r.stdout, /SOUND/);
    assert.match(r.stdout, /binds|bind/, 'says proven = the test binds the function');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Unsupported JVM source sets skip CLEANLY: no gradle run, an explicit reason per block, and a labeled
// banner bucket — previously each block burned a baseline and landed as inconclusive noise. The project
// here has NO gradle wrapper at all: the test passes only because the gate fires before any spawn.
test('androidTest + commonTest files skip pre-baseline with explicit reasons (no gradle ever runs)', () => {
  const d = project({
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n',
    'app/src/androidTest/java/com/x/UiTest.kt': 'package com.x\nclass UiTest {\n    @Test fun tapsThrough() { assertEquals(1, flow()) }\n}\n',
    'shared/src/commonTest/kotlin/com/x/CommonTest.kt': 'package com.x\nclass CommonTest {\n    @Test fun works() { assertEquals(2, calc()) }\n}\n',
  });
  try {
    const r = run([d, '--runner=gradle', '--json', '--no-self-check']);
    const j = JSON.parse(r.stdout);
    assert.equal(j.probes, 0, 'zero gradle runs');
    assert.equal(j.inconclusive.length, 0, 'no inconclusive noise');
    const whys = j.skipped.map((s) => s.why).sort();
    assert.deepEqual(whys, ['instrumented-test', 'unsupported-source-set']);
    const human = run([d, '--runner=gradle', '--no-self-check']);
    assert.match(human.stdout, /1 instrumented androidTest \(not supported\)/);
    assert.match(human.stdout, /1 unsupported KMP source set/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// BLOCKER fix: the markdown PR comment must show every hollow the exit code counts — including hollow
// tests in the probed scope whose function is NOT in the changed-function table (a touched test file is
// probed whole-file; the reviewer surface must carry the receipt for its own failing check).
test('markdown renders probed-scope hollow tests beyond the changed-function rows (exit-code receipt)', () => {
  const d = gitProject(); // base: committed sound fn+test
  // pre-existing hollow test in the SAME file; the diff only touches the test file (no src change)
  writeFileSync(join(d, 'test/t.test.mjs'),
    readFileSync(join(d, 'test/t.test.mjs'), 'utf8')
    + "test('echo', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });\n");
  const r = runCli(['--since=HEAD', '--no-self-check', '--format=markdown'], d);
  assert.equal(r.status, 1, 'hollow found -> exit 1');
  assert.match(r.out, /hollow test\(s\) found in the probed scope/, 'the section exists');
  assert.match(r.out, /test\/t\.test\.mjs:\d+ 'echo'/, 'names the hollow test with file:line');
});

test('--format=markdown renders the PR body and matches the hand-written golden', () => {
  const d = gitProjectWithChange();
  const r = runCli(['--since=HEAD', '--no-self-check', '--format=markdown'], d);
  const golden = readFileSync(new URL('./fixtures/report.golden.md', import.meta.url), 'utf8');
  assert.equal(r.out, golden); // golden is HAND-WRITTEN first, never pasted from output
  // this fixture has neither a flaky test nor a title collision, so neither side-signal line fires —
  // the golden above is untouched by Task 5 (confirms the gating, doubles as a byte-level canary).
});

// ---- side signal: a flaky test (unstable green) never becomes a HOLLOW verdict — it lands in
// r.inconclusive with why starting 'flaky baseline' (see the flake guard in mutation/prove.mjs and its
// unit-level fixture in test/prove.test.mjs). That bucket was silent in the report; it must now surface
// as one human-readable line so a reader doesn't mistake "0 hollow" for "everything sound" when some
// tests were actually unrunnable-as-a-verdict. Reuses the exact deterministic-flake mechanism (a counter
// file, not Math.random) so the CLI-level run is fully deterministic.
test('gutcheck reports the flaky-test side-signal line (rerun instability, not a hollow verdict)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n',
    'test/flaky.test.mjs': `${head}
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { total } from '../src/lib.mjs';
const counter = fileURLToPath(new URL('./.c', import.meta.url));
test('flaky hollow', () => {
  let n = 0; try { n = Number(readFileSync(counter, 'utf8')) || 0; } catch {}
  writeFileSync(counter, String(n + 1));
  if (n >= 2) throw new Error('flake');
  const e = total([{p:2,q:3}]); assert.strictEqual(total([{p:2,q:3}]), e);
});
`,
  });
  try {
    const r = run([d, '--runner=node']);
    assert.match(r.stdout, /1 test\(s\) unstable across identical reruns \(rerun instability, not a verdict\)/);
    assert.equal(r.status, 0, 'a flaky test is inconclusive, never a hollow verdict — must not force exit 1');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- side signal: two same-titled tests share one runner selection (ambiguousNames), so prove()
// fail-closes the probeable one straight to inconclusive with why starting 'ambiguous title'. The second
// block here uses a weak (non-value-pinning) assertion so it never itself reaches the ambiguous check —
// only the first block does, keeping the expected count at exactly 1 (mirrors how ambiguousNames marks
// the whole title, but only ELIGIBLE blocks are ever routed through the per-block ambiguous gate).
test('gutcheck reports the title-collision side-signal line', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function dbl(x){ return x * 2; }\n',
    'test/dup.test.mjs': `${head} import { dbl } from '../src/lib.mjs';
test('same title', () => { assert.strictEqual(dbl(3), 6); });
test('same title', () => { assert.ok(true); });
`,
  });
  try {
    const r = run([d, '--runner=node']);
    assert.match(r.stdout, /1 title collision\(s\) — colliding titles break per-test selection \(rename or qualify\)/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- formatMarkdown direct-call: a synthetic result object carrying both inconclusive buckets, so the
// markdown-variant wording for both signals is asserted without needing a real flaky/duplicate-title
// e2e run at --format=markdown (the two CLI-level tests above already prove the buckets fire for real).
test('formatMarkdown renders both side-signal lines between the table and the receipts line', () => {
  const synthetic = {
    scopeError: null,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'dbl', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'sound' }] } }],
    caught: 1,
    inconclusive: [
      { file: 'test/flaky.test.mjs', line: 5, name: 'flaky hollow', why: 'flaky baseline (unstable green) — not a reliable HOLLOW' },
      { file: 'test/dup.test.mjs', line: 2, name: 'same title', why: 'ambiguous title — another test in this file matches the same runner selection' },
    ],
  };
  const out = formatMarkdown(synthetic);
  assert.match(out, /⚠️ 1 test\(s\) were unstable across identical reruns — flaky, not verdicts\./);
  assert.match(out, /⚠️ 1 test title collision\(s\) — colliding titles also break per-test selection for humans \(rename or qualify\)\./);
  // between the table and the receipts line: both warnings must precede the "✓ verified" receipts line.
  const warnIdx = out.indexOf('⚠️');
  const receiptsIdx = out.indexOf('✓ 1 test verified');
  assert.ok(warnIdx > -1 && receiptsIdx > -1 && warnIdx < receiptsIdx, 'side-signal lines sit before the receipts line');
});

// ---- already-failing-at-HEAD signal, CONSISTENT across every machine surface (wild-pilot HEAD-rot
// finding; the human formatReport variant is tested in test/prove.test.mjs). One FAIL_PROJ shape: a
// sound test (scored>0 — the runner demonstrably works) + a test whose pinned assertion is simply wrong
// at HEAD (its baseline fails -> the `baseline Xp/Yf` inconclusive bucket). Language-universal: the
// bucket is built at prove.mjs's single baseline gate shared by every runner. ----
const FAIL_PROJ = {
  'package.json': '{"type":"module"}',
  'src/lib.mjs': 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\nexport function dbl(n){ return n*2; }\n',
  'test/t.test.mjs': `${head} import { total, dbl } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(dbl(2), 4); });\ntest('wrong at HEAD', () => { assert.strictEqual(total([{p:2,q:3}]), 999); });\n`,
};

test('gutcheck --format github: an already-failing test emits a ::warning annotation, exit 0 (no hollow)', () => {
  const d = project(FAIL_PROJ);
  try {
    const r = run([d, '--runner=node', '--format=github']);
    assert.match(r.stdout, /^::warning file=[^,]*t\.test\.mjs,line=\d+,title=[^:]*already failing[^:]*::/m, 'a GitHub warning annotation at the failing test');
    assert.doesNotMatch(r.stdout, /^::error /m, 'no hollow -> no error annotations');
    assert.equal(r.status, 0, 'already-failing is a warning — never an exit-code flip (CI’s own test run fails anyway)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --format sarif: an already-failing test is a warning-level result under its own rule, exit 0', () => {
  const d = project(FAIL_PROJ);
  try {
    const r = run([d, '--runner=node', '--format=sarif']);
    const sarif = JSON.parse(r.stdout);
    const res = sarif.runs[0].results;
    assert.equal(res.length, 1, `exactly the failing test: ${JSON.stringify(res)}`);
    assert.equal(res[0].ruleId, 'already-failing-test');
    assert.equal(res[0].level, 'warning');
    assert.match(res[0].locations[0].physicalLocation.artifactLocation.uri, /t\.test\.mjs$/);
    assert.ok(sarif.runs[0].tool.driver.rules.some((x) => x.id === 'already-failing-test'), 'rule declared');
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- the GitHub Action renders annotations/markdown/SARIF from ONE saved --json result (probing once,
// not once per surface) — so the tested formatters must be importable, not CLI-only. Direct-call test
// over a hand-built result object (same synthetic pattern as the formatMarkdown tests above). ----
test('formatGithub + formatSarif are importable and render from a saved JSON result (Action contract)', async () => {
  const { formatGithub, formatSarif } = await import('../mutation/gutcheck.mjs');
  const r = {
    hollow: [{ file: 'test/t.test.mjs', line: 4, name: 'echo', survivors: ['dbl'] }],
    inconclusive: [{ file: 'test/u.test.mjs', line: 9, name: 'broken', why: 'baseline 0p/1f' }],
  };
  const gh = formatGithub(r);
  assert.match(gh, /^::error file=test\/t\.test\.mjs,line=4,/m);
  assert.match(gh, /^::warning file=test\/u\.test\.mjs,line=9,/m);
  const sarif = JSON.parse(formatSarif(r));
  assert.equal(sarif.runs[0].results.length, 2);
});

test('formatGithub: prepends a ::notice coverage-denominator roll-up when changeSummary is present', async () => {
  const { formatGithub } = await import('../mutation/gutcheck.mjs');
  const r = { changeSummary: { fns: 3, proven: 1, hollow: 1, unverifiable: 1, untested: 1 } };
  const gh = formatGithub(r);
  assert.match(gh, /^::notice::gutcheck: of 3 function\(s\) changed — 1 proven, 1 with no binding test, 1 unverifiable\. \(npx gutcheck --explain <file:line> for a receipt\.\)/);
});

test('formatGithub: no ::notice roll-up when changeSummary has zero changed functions (doc-only diff)', async () => {
  const { formatGithub } = await import('../mutation/gutcheck.mjs');
  const r = { changeSummary: { fns: 0, proven: 0, hollow: 0, unverifiable: 0, untested: 0 } };
  const gh = formatGithub(r);
  assert.doesNotMatch(gh, /::notice/, 'a zero-function changeSummary (doc-only PR) is not worth a roll-up annotation');
});

// Task 7: the ::notice clones the hook's same-diff-oracle provenance + probe-cap-out-of-unverifiable
// fragments, rendered only when their count is > 0 (FACT-ONLY wording, never a judgment on intent).
test('formatGithub: the ::notice appends same-diff-oracle provenance and probe-cap fragments only when their counts are > 0', async () => {
  const { formatGithub } = await import('../mutation/gutcheck.mjs');
  const withProvenance = { changeSummary: { fns: 3, proven: 2, hollow: 0, unverifiable: 0, untested: 1, sameDiffProven: 2, notProbed: 0 } };
  assert.match(formatGithub(withProvenance), /^::notice::gutcheck: of 3 function\(s\) changed — 2 proven \(2 via tests changed in this diff\), 1 with no binding test\. \(npx gutcheck --explain <file:line> for a receipt\.\)/);
  const withCap = { changeSummary: { fns: 3, proven: 1, hollow: 0, unverifiable: 0, untested: 1, sameDiffProven: 0, notProbed: 1 } };
  assert.match(formatGithub(withCap), /^::notice::gutcheck: of 3 function\(s\) changed — 1 proven, 1 with no binding test, 1 not probed \(cap\)\. \(npx gutcheck --explain <file:line> for a receipt\.\)/);
  const neither = { changeSummary: { fns: 3, proven: 1, hollow: 1, unverifiable: 1, untested: 1 } };
  const gh = formatGithub(neither);
  assert.doesNotMatch(gh, /via tests changed in this diff/);
  assert.doesNotMatch(gh, /not probed \(cap\)/);
});

test('formatMarkdown renders the already-failing side-signal with an inline file:line list', () => {
  const synthetic = {
    scopeError: null,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'dbl', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'sound' }] } }],
    caught: 1,
    inconclusive: [
      { file: 'test/a.test.mjs', line: 7, name: 'broken', why: 'baseline 0p/1f' },
      { file: 'test/b.test.mjs', line: 12, name: 'did not run', why: 'did-not-run 0p/0f' },
    ],
  };
  const out = formatMarkdown(synthetic);
  assert.match(out, /⚠️ 1 probed test\(s\) already fail before any mutation — they verify nothing until they pass: test\/a\.test\.mjs:7/);
  assert.doesNotMatch(out, /test\/b\.test\.mjs:12/, 'a did-not-run row is never an accusation — the consumer filter (untouched) excludes it automatically');
});

// ---- Task 7 follow-up: a probe-cap fn is real reference evidence split OUT of `unverifiable` at the
// changeSummary level (mutation/changes.mjs), but the table still rendered its row with the plain
// STATUS_MD lookup — every probe-cap row is status:'unverifiable', so it kept reading "❔ unverifiable"
// with no header cell accounting for it, and the header's own unverifiable count no longer summed to the
// table's ❔ rows. Two changes rows here — one genuinely unverifiable, one probe-cap — make the
// reconciliation property checkable directly: the header's `unverifiable` count must equal the number of
// TABLE rows actually labeled "❔ unverifiable", with the capped row carrying its own distinct label. ----
test('formatMarkdown: header carries a not-probed(cap) cell, and the capped row is labeled distinctly from ❔ unverifiable', () => {
  const synthetic = {
    scopeError: null,
    changeSummary: { fns: 2, proven: 0, hollow: 0, unverifiable: 1, untested: 0, notProbed: 1 },
    changes: [
      { fn: 'mockOnly', file: 'src/lib.mjs', status: 'unverifiable', evidence: { reason: 'no-pin', reasons: { 'no-pin': 1 }, blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'mock-only test' }] } },
      { fn: 'capped', file: 'src/lib.mjs', status: 'unverifiable', evidence: { reason: 'probe-cap', reasons: { 'probe-cap': 1 }, blocks: [{ file: 'test/t.test.mjs', line: 9, name: 'capped test' }] } },
    ],
    caught: 0,
    inconclusive: [],
  };
  const out = formatMarkdown(synthetic);
  assert.match(out, /not probed \(cap\) 1/, 'the roll-up header carries a not-probed(cap) cell when notProbed > 0');
  const rowLines = out.split('\n').filter((l) => l.startsWith('| `'));
  assert.equal(rowLines.length, 2, 'both changed-function rows render');
  const cappedRow = rowLines.find((l) => l.includes('`capped`'));
  assert.doesNotMatch(cappedRow, /❔ unverifiable/, 'a probe-cap row must not render as ❔ unverifiable in the table');
  // the reconciliation property itself: the header's unverifiable count must equal the number of rows
  // the table actually labels ❔ unverifiable (not the raw count of status:'unverifiable' changes, which
  // would also include the probe-cap row and overstate it by one).
  const unverifiableRowCount = rowLines.filter((l) => l.includes('❔ unverifiable')).length;
  assert.equal(unverifiableRowCount, synthetic.changeSummary.unverifiable, "header's unverifiable count must sum to the table's own ❔ unverifiable rows");
});

// ---- Task 6: identity-stub advisory rendered per-function from weakSummary (audit-gated promotion —
// audit-gated promotion). Same synthetic-object pattern as the side-signal test above. ----
test('formatMarkdown renders the identity-stub advisory per-fn from weakSummary (hand-derived ratios)', () => {
  const synthetic = {
    scopeError: null,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'norm', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'fixed point' }] } }],
    caught: 1,
    inconclusive: [],
    // hand-derived: norm attempted twice, the identity stub survived once (1 of 2). echo was attempted
    // once and its stub was CAUGHT every time (0 of 1 survived) — a success story, not an advisory
    // (final-review wave, item 6): a passed:0 row must be omitted entirely, human and markdown alike.
    weak: [{ file: 'test/t.test.mjs', line: 3, name: 'fixed point', fn: 'norm' }],
    weakSummary: { norm: { stubbed: 2, passed: 1 }, echo: { stubbed: 1, passed: 0 } },
  };
  const out = formatMarkdown(synthetic);
  assert.match(out, /#### Identity-stub advisory \(--deep\)/);
  assert.match(out, /`norm`: 1 of 2 identity-stub probes passed/);
  assert.doesNotMatch(out, /`echo`/, 'a passed:0 fn is a success story — omitted, not advised against');
  assert.match(out, /no-op tests pass identity stubs by design/i);
  // sits between the side-signals/table and the receipts line
  const advIdx = out.indexOf('#### Identity-stub advisory');
  const receiptsIdx = out.indexOf('✓ 1 test verified');
  assert.ok(advIdx > -1 && receiptsIdx > -1 && advIdx < receiptsIdx, 'identity-stub section sits before the receipts line');
});

test('formatMarkdown: zero weak findings render no identity-stub section (golden untouched, no --deep)', () => {
  const synthetic = {
    scopeError: null,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'dbl', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'sound' }] } }],
    caught: 1,
    inconclusive: [],
    weak: [],
  };
  const out = formatMarkdown(synthetic);
  assert.doesNotMatch(out, /Identity-stub advisory/, 'weak: [] (no --deep) must render nothing new');
});

// ---- e2e: weakSummary counts round-trip through the CLI's --json --deep output. Reuses the deterministic
// fixed-point fixture from "PROVE --deep" (test/prove.test.mjs) verbatim, so the hand-derivation is the
// same one already vetted there. ----
test('gutcheck --deep --json reports weakSummary per-fn counts (deterministic fixed-point fixture)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': `export function norm(s){ return s.trim().toLowerCase(); }
export function echo(x){ return x; }
`,
    'test/t.test.mjs': `${head} import { norm, echo } from '../src/lib.mjs';
test('fixed point', () => { assert.strictEqual(norm('hello'), 'hello'); });
test('discriminating', () => { assert.strictEqual(norm('  Hi  '), 'hi'); });
test('identity ok', () => { assert.strictEqual(echo('a'), 'a'); });
`,
  });
  try {
    const r = run([d, '--runner=node', '--json', '--deep']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.caught, 3, '--deep does not change the gross verdict');
    // hand-derived (mirrors test/prove.test.mjs): norm is attempted for both the 'fixed point' and
    // 'discriminating' blocks (2 stubbed); the stub survives only 'fixed point' (1 passed). echo's body
    // already literally IS `return x` — passthroughBreak declines — so echo has no weakSummary entry.
    assert.deepEqual(parsed.weakSummary, { norm: { stubbed: 2, passed: 1 } });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --json without --deep omits weakSummary entirely', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function norm(s){ return s.trim().toLowerCase(); }\n',
    'test/t.test.mjs': `${head} import { norm } from '../src/lib.mjs';
test('fixed point', () => { assert.strictEqual(norm('hello'), 'hello'); });
`,
  });
  try {
    const r = run([d, '--runner=node', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal('weakSummary' in parsed, false, 'weakSummary must be entirely absent (not even undefined) from the JSON payload without --deep');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('space-form --since is accepted (the README hero command)', () => {
  const d = gitProject();
  const r = runCli(['--since', 'HEAD'], d);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.err}`);
  assert.ok(!/ENOENT/.test(r.err), 'no raw ENOENT stack trace');
});

test('a nonexistent path argument fails with a one-line error, not a stack trace', () => {
  const r = runCli(['/no/such/dir-gutcheck-test'], process.cwd());
  assert.equal(r.status, 2);
  assert.match(r.err, /path not found/);
  assert.ok(!/ENOENT[\s\S]*at /.test(r.err), 'no stack trace');
});

test('--json runs the self-check: stdout stays pure JSON, the check-mark goes to stderr', () => {
  const d = gitProject();
  const r = runCli(['--json'], d);
  assert.equal(r.status, 0);
  JSON.parse(r.out); // throws if a banner leaked into stdout
  assert.match(r.err, /self-check ✓/);
});

test('--no-self-check suppresses the self-check in machine mode', () => {
  const d = gitProject();
  const r = runCli(['--json', '--no-self-check'], d);
  assert.equal(r.status, 0);
  assert.ok(!/self-check/.test(r.err));
});

test('an empty --since diff says "nothing changed", and does not full-scan', () => {
  const d = gitProject();               // clean at HEAD
  const r = runCli(['--since=HEAD'], d);
  assert.equal(r.status, 0);
  assert.match(r.out, /no files changed since HEAD/);
  assert.ok(!/scanning the full suite/.test(r.out));
});

test('every-baseline-failed prints an actionable runner hint', () => {
  const d = _mkdtemp(_join(_tmp(), 'gc-hint-'));
  _write(_join(d, 'package.json'), '{"type":"module"}');
  _mkdir(_join(d, 'src')); _mkdir(_join(d, 'test'));
  _write(_join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  _write(_join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('red', () => { assert.strictEqual(dbl(3), 7); });\n");
  const r = runCli([], d);
  assert.match(r.out, /either these tests already fail, or the detected runner/);
});

test('--no-fallback suppresses the full-suite widening on an unprobeable --since scope', () => {
  const d = gitProject();
  // an uncommitted non-test change: the diff is non-empty but touches no probeable test
  _write(_join(d, 'notes.txt'), 'x');
  const withFallback = runCli(['--since=HEAD'], d);
  assert.match(withFallback.out, /scanning the full suite instead/);
  const without = runCli(['--since=HEAD', '--no-fallback'], d);
  assert.equal(without.status, 0);
  assert.ok(!/scanning the full suite/.test(without.out), 'fallback must not fire');
  // touches nothing probeable → still a diff-scoped run (r.changeSummary present, just fns:0) — the
  // "0 probed" evidence now lives in the trailing mechanics footnote, not a banner() preamble.
  assert.match(without.out, /gutcheck: 0 functions in this diff/);
  assert.match(without.out, /\(probed 0 fns · 0\/0 bound · 0 skipped · runner \S+\)/);
});

// --format=markdown IS the diff report — widening it to a full-suite scan would silently throw away the
// diff scope (formatMarkdown falls back to "no diff scope" prose once `changed` is dropped), so markdown
// must never trigger the fallback even when the --since diff is non-empty but touches nothing probeable
// (a docs-only diff). Truthful zero-state ("0 functions changed") beats a widened scan every time here.
test('--format=markdown never triggers the full-suite fallback (diff-centric by definition)', () => {
  const d = gitProject();
  _write(_join(d, 'docs.txt'), 'unrelated docs-only change\n'); // touches nothing probeable
  const r = run([d, '--runner=node', '--since=HEAD', '--format=markdown']);
  assert.match(r.stdout, /\*\*0 functions changed\*\*/, 'renders the truthful zero-state');
  assert.ok(!/scanning the full suite/.test(r.stdout), 'markdown must never widen to a full-suite scan');
  assert.ok(!/no diff scope/.test(r.stdout), 'the diff scope must survive — not dropped by a silent fallback');
});

test('human mode emits a progress line per probed block on stderr', () => {
  const d = gitProject();
  const r = runCli(['--no-self-check'], d);
  assert.match(r.err, /probing #1: /);
});

test('machine mode with non-TTY stderr emits no progress lines', () => {
  const d = gitProject();
  const r = runCli(['--json', '--no-self-check'], d);
  assert.ok(!/probing #/.test(r.err), `stderr should carry no progress lines, got: ${r.err}`);
  JSON.parse(r.out); // stdout stays pure JSON
});

// ---- FIX 3a (82dea50): bare npx defaults --max-probes to 40 so a big, no-flags first-contact run never
// looks hung; --max-probes=<n> overrides that default. Fixture: 45 independently-probeable functions, each
// with its own sound, value-pinning test (no hollow — the cap itself is what's under test here).
function manyFnsProject(n) {
  const lib = []; const imports = []; const tests = ["import { test } from 'node:test'; import assert from 'node:assert';"];
  for (let i = 0; i < n; i++) { lib.push(`export function f${i}(x){ return x + ${i}; }`); imports.push(`f${i}`); }
  tests.push(`import { ${imports.join(', ')} } from '../src/lib.mjs';`);
  for (let i = 0; i < n; i++) tests.push(`test('f${i} works', () => { assert.strictEqual(f${i}(1), ${i + 1}); });`);
  return project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': lib.join('\n') + '\n',
    'test/t.test.mjs': tests.join('\n') + '\n',
  });
}

test('gutcheck with no --max-probes caps at the default of 40 and reports the cap-reached note', () => {
  const d = manyFnsProject(45);
  try {
    const r = run([d, '--runner=node', '--no-self-check', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.probes, 40, 'default cap is 40');
    assert.equal(parsed.capped, 5, '5 of 45 eligible functions left unprobed');
    const human = run([d, '--runner=node', '--no-self-check']);
    assert.match(human.stdout, /5 block\(s\) not probed — probe cap or time budget reached/, 'the cap-reached note names the count and reason (both levers)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --max-probes=<big> overrides the default cap (no capping)', () => {
  const d = manyFnsProject(45);
  try {
    const r = run([d, '--runner=node', '--no-self-check', '--max-probes=100', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.probes, 45, 'all 45 functions probed, none capped');
    assert.equal(parsed.capped, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- wall-clock probe budget: a JVM/Gradle runner costs seconds-to-minutes per probe, so a fixed
// probe-count cap can't bound the hook's 120s timeout; --time-budget=<s> gates between probes ----
test('gutcheck --time-budget=<generous> behaves like no budget on the small fixture', () => {
  const d = manyFnsProject(45);
  try {
    const r = run([d, '--runner=node', '--no-self-check', '--max-probes=100', '--time-budget=600', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.probes, 45, 'all 45 functions probed under a generous time budget');
    assert.equal(parsed.capped, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gutcheck --time-budget is accepted as a value flag (no unknown-flag error)', () => {
  const d = manyFnsProject(1);
  try {
    const r = run([d, '--runner=node', '--no-self-check', '--time-budget=90', '--json']);
    assert.doesNotMatch(r.stderr || '', /unknown (flag|option)/, `--time-budget must not be rejected: ${r.stderr}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- FIX 3b (82dea50): an unresolvable --since ref is recovered gracefully instead of a cryptic exit-2
// scopeError. Two paths: (1) a resolvable stand-in exists (origin/HEAD → main → master → HEAD~1 merge-
// base) → re-run scoped to it, with a one-line notice on STDERR (all modes, so --json stdout stays valid
// JSON); (2) nothing in the chain resolves → one actionable stderr line + exit 2 (genuinely nothing to
// probe). The notice lives at the decision point ahead of every mode branch, never on stdout. ----

// A repo diverged from a local `main`: init on main with a committed SUT + sound test, branch to
// `feature`, commit a second function + its sound test. `--since=origin/does-not-exist` can't resolve, so
// the fallback lands on `main` and merge-base(HEAD, main) scopes the diff to the feature commit — a
// non-empty, fully-probeable diff, so stdout carries the normal report (not the empty "nothing changed").
function divergedFromMainProject() {
  const d = mkdtempSync(join(tmpdir(), 'gc-fallback-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('sound', () => { assert.strictEqual(dbl(3), 6); });\n");
  const g = (...c) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...c], { cwd: d, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'init');
  g('checkout', '-q', '-b', 'feature');
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\nexport function tripl(x){ return x * 3; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl, tripl } from '../src/lib.mjs';\n" +
    "test('sound', () => { assert.strictEqual(dbl(3), 6); });\n" +
    "test('triple', () => { assert.strictEqual(tripl(3), 9); });\n");
  g('add', '-A'); g('commit', '-qm', 'feature work');
  return d;
}
// A repo where NOTHING in the fallback chain resolves: a single commit (so HEAD~1 fails) on a branch that
// is neither `main` nor `master`, and no `origin` remote (so origin/HEAD fails).
function noResolvableRefProject() {
  const d = mkdtempSync(join(tmpdir(), 'gc-noref-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('sound', () => { assert.strictEqual(dbl(3), 6); });\n");
  const g = (...c) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...c], { cwd: d, stdio: 'ignore' });
  g('init', '-q', '-b', 'work'); g('add', '-A'); g('commit', '-qm', 'init');
  return d;
}

test('an unresolvable --since falls back to a resolvable ref with a one-line stderr notice, report on stdout (text mode)', () => {
  const d = divergedFromMainProject();
  try {
    const r = runCli(['--since=origin/does-not-exist', '--no-self-check'], d);
    assert.equal(r.status, 0, `graceful fallback is not exit 2, got ${r.status}\nstderr: ${r.err}`);
    assert.match(r.err, /--since=origin\/does-not-exist did not resolve — falling back to --since=/, 'the fallback notice is on stderr');
    assert.ok(r.out.trim().length > 0, 'stdout carries the normal report, not an empty/cryptic exit');
    assert.ok(!/scopeError/.test(r.out + r.err), 'never the cryptic raw scopeError');
    assert.match(r.out, /function in this diff|functions in this diff/, 'the diff-scoped report rendered against the fallback ref');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the --since fallback notice goes to stderr in --json mode — stdout stays valid JSON', () => {
  const d = divergedFromMainProject();
  try {
    const r = runCli(['--since=origin/does-not-exist', '--no-self-check', '--json'], d);
    assert.equal(r.status, 0);
    assert.match(r.err, /--since=origin\/does-not-exist did not resolve — falling back to --since=/, 'the notice is on stderr, never stdout');
    const parsed = JSON.parse(r.out); // throws if the notice leaked onto stdout
    assert.ok('changeSummary' in parsed, 'a real diff-scoped JSON result');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unresolvable --since with no fallback candidate is a clean exit 2 with an actionable stderr line (not a raw scopeError)', () => {
  const d = noResolvableRefProject();
  try {
    const r = runCli(['--since=origin/does-not-exist', '--no-self-check'], d);
    assert.equal(r.status, 2, 'nothing resolved — genuinely nothing to probe, exit 2');
    assert.match(r.err, /could not resolve --since=.* — fetch it/, 'the actionable hint, not the cryptic scopeError');
    assert.ok(!/not a git repo, or unknown ref/.test(r.out + r.err), 'the raw scopeError string is replaced, not surfaced');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
