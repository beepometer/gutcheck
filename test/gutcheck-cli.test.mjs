import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync, execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    assert.equal(r.status, 1);
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
    assert.match(r.stdout, /verified \d+ function/, 'names what it actually verified');
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
    assert.match(r.stdout, /verified \d+ function/, 'the fallback scan still lands on the positive artifact');
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

test('human output renders the change-verification section on --since runs', () => {
  const d = gitProjectWithChange(); // helper below: base commit + edit to a tested fn and an untested fn
  const r = runCli(['--since=HEAD', '--no-self-check'], d);
  assert.match(r.out, /change verification: 2 functions changed/);
  assert.match(r.out, /untested \(no test mentions them\): 1/);
});

test('human output for a full-suite run is byte-identical to the pre-report format (changes null)', () => {
  const d = gitProject();
  const r = runCli(['--no-self-check'], d);
  // exact pre-feature output — reviewer byte-verified current==base 722ae0f; any drift in the null path must fail this
  assert.equal(r.out, 'probed 1 function · runner=node\ngutcheck: 1/1 tests (100%) fail when the function they test is broken.  [1 probes, runner: node]\n✓ verified 1 function your tests genuinely catch (broke each, the test went red). 0 test(s) skipped (see banner for reasons).\n');
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
  const receiptsIdx = out.indexOf('✓ verified');
  assert.ok(warnIdx > -1 && receiptsIdx > -1 && warnIdx < receiptsIdx, 'side-signal lines sit before the receipts line');
});

// ---- Task 6: identity-stub advisory rendered per-function from weakSummary (audit-gated promotion —
// see .superpowers/sdd/weak-audit.md). Same synthetic-object pattern as the side-signal test above. ----
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
  const receiptsIdx = out.indexOf('✓ verified');
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
  assert.match(without.out, /probed 0 functions/);
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
