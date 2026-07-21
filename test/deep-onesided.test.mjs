import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prove, formatReport } from '../mutation/prove.mjs';
import { classifyChanges } from '../mutation/changes.mjs';
import { grossBreak, grossBreakOpposite, hasFirstParamIdentityBranch } from '../mutation/probe.mjs';

// Two-sentinel probe. The single extreme sentinel is direction-blind on one-sided comparison logic
// (field-observed: two mirror-image threshold tests once drew HOLLOW and PROVEN purely by sentinel
// sign, and the hollow copy contradicted its own receipt). Verdicts are a function of BOTH runs:
//   red under both        → proven (caught)
//   red under exactly one → one-sided (own tier, never blocks)
//   green under both      → hollow (the only blocker)
// DEFAULT (every run): confirm-before-accuse — only SURVIVORS (candidate hollows) get the opposite
// run; survivors are rare, so the cost is near zero and a hollow can never be a sign accident.
// --deep: the proven side is re-examined too (one-direction-only proofs demote to one-sided), plus
// the identity-stub advisory. A fn with no opposite mutant (string sentinel, compile-fail) keeps
// its single-sentinel verdict — no evidence, no reclassification.

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-onesided-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}

// --- grossBreakOpposite: the opposite-signed mutant, null when the sentinel has no direction ---

test('grossBreakOpposite: JS numeric gut gets the negative sentinel', () => {
  const out = grossBreakOpposite('export function f() { return 1; }', 'f', 'typescript');
  assert.ok(out && out.includes('-987654321'), `expected the negative sentinel, got: ${out}`);
});

test('grossBreakOpposite: Kotlin Float return gets the typed negative sentinel', () => {
  const out = grossBreakOpposite('fun t(): Float = 0.5f', 't', 'kotlin');
  assert.ok(out && out.includes('-987654321.0f'), `expected -987654321.0f, got: ${out}`);
});

test('grossBreakOpposite: a String return has no opposite direction — null, never a guess', () => {
  assert.equal(grossBreakOpposite('fun s(): String = "x"', 's', 'kotlin'), null);
});

test('grossBreakOpposite: mirrors grossBreak reach — an unlocatable fn is null in both', () => {
  assert.equal(grossBreak('const x = 1;', 'nope', 'typescript'), null);
  assert.equal(grossBreakOpposite('const x = 1;', 'nope', 'typescript'), null);
});

// --- hasFirstParamIdentityBranch: identity-stub suppression predicate ---

test('identity-branch detection: return-param, elvis, else-param, when-arrow forms', () => {
  assert.equal(hasFirstParamIdentityBranch(
    'export function fit(label, max) {\n  if (label.length <= max) return label;\n  return label.slice(0, max);\n}', 'fit', 'typescript'), true);
  assert.equal(hasFirstParamIdentityBranch(
    'fun key(n: String, a: String?): String = if (a.isNullOrBlank()) n else "$n#$a"', 'key', 'kotlin'), true);
  assert.equal(hasFirstParamIdentityBranch(
    'fun disp(label: String): String { return RX.matchEntire(label)?.value ?: label }', 'disp', 'kotlin'), true);
  assert.equal(hasFirstParamIdentityBranch(
    'fun combineIfFinite(a: Float, b: Float): Float = if (a.isFinite()) combine(a, b) else a', 'combineIfFinite', 'kotlin'), true);
});

test('identity-branch detection: a transform with no identity branch is NOT suppressed', () => {
  assert.equal(hasFirstParamIdentityBranch(
    'export function scale(x) { return x * 2; }', 'scale', 'typescript'), false);
});

// --- e2e: all four two-sentinel outcomes in one fixture ---
// A: 'low reading fails'   — threshold() flows through `<` → survives +, red −  → one-sided (ex-hollow)
// B: 'high reading passes' — mirror image             → red +, survives −      → one-sided (ex-proven)
// C: 'rate pinned'         — equality pin              → red under both         → proven
// D: 'echo'                — self-comparison           → green under both       → hollow (the only blocker)
// E: 'fit keeps short'     — pins the identity branch  → proven; identity-stub advisory SUPPRESSED
// F: 'scale zero'          — pins a fixed point        → proven; identity-stub advisory fires

const FIXTURE = {
  'package.json': '{"type":"module"}',
  'src/lib.mjs': [
    'export function threshold() { return 0.5; }',
    'export function rate() { return 0.25; }',
    'export function echoSum(a, b) { return a + b; }',
    'export function fit(label, max) {',
    '  if (label.length <= max) return label;',
    "  return label.slice(0, max) + '…';",
    '}',
    'export function scale(x) { return x * 2; }',
    '',
  ].join('\n'),
  'test/t.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { threshold, rate, echoSum, fit, scale } from '../src/lib.mjs';
const classify = (v, t) => (v < t ? 'FAIL' : 'PASS');
test('low reading fails', () => { assert.strictEqual(classify(0.40, threshold()), 'FAIL'); });
test('high reading passes', () => { assert.strictEqual(classify(0.60, threshold()), 'PASS'); });
test('rate pinned', () => { assert.strictEqual(rate(), 0.25); });
test('echo', () => { assert.strictEqual(echoSum(2, 3), echoSum(3, 2)); });
test('fit keeps short', () => { assert.strictEqual(fit('ab', 5), 'ab'); });
test('scale zero', () => { assert.strictEqual(scale(0), 0); });
`,
};

test('PROVE --deep: verdicts are a function of both sentinel runs — sign-independent', () => {
  const d = project(FIXTURE);
  try {
    const r = prove(d, { runner: 'node', deep: true });
    // The only blocker is the both-sentinel survivor.
    assert.equal(r.hollow.length, 1, `hollow must be only the both-green echo: ${JSON.stringify(r.hollow)}`);
    assert.equal(r.hollow[0].name, 'echo');
    // Both mirror-image threshold tests land in the SAME tier.
    const names = (r.oneSided || []).map((o) => o.name).sort();
    assert.deepEqual(names, ['high reading passes', 'low reading fails']);
    // Each row carries which side bit, as facts.
    const low = r.oneSided.find((o) => o.name === 'low reading fails');
    const high = r.oneSided.find((o) => o.name === 'high reading passes');
    assert.equal(low.posRed, false, 'low reading fails survived + and went red under −');
    assert.equal(high.posRed, true, 'high reading passes went red under + and survived −');
    // Accounting: 6 verdicts = 3 caught + 1 hollow + 2 one-sided.
    assert.equal(r.caught, 3);
    assert.equal(r.scored, 6);
    // Identity-stub advisory: fires for the fixed point (scale), suppressed for the identity branch (fit).
    const weakFns = (r.weak || []).map((w) => w.fn);
    assert.ok(weakFns.includes('scale'), `scale's fixed-point survivor is advised: ${JSON.stringify(r.weak)}`);
    assert.ok(!weakFns.includes('fit'), 'fit has a production identity branch — advisory suppressed');
    // Rendering: one-sided rows state the observed runs per side; the hollow row is a plain hollow.
    const report = formatReport(r);
    assert.match(report, /'high reading passes'.*red under the positive sentinel, passes under the negative one/);
    assert.match(report, /'low reading fails'.*passes under the positive sentinel, red under the negative one/);
    assert.match(report, /'echo'.*survives gutting echoSum\(\)(?!.*sentinel)/);
    // Aggregate header over the same rows (spec: boundary-blind-spot aggregate) — real engine output.
    assert.match(report, /^boundary blind spots: 2 one-sided test\(s\) — these bind one direction of error only; never a blocker:$/m);
    assert.match(report, /^ {2}bind only against too-high results \(1\): \S+ \(1\)$/m);
    assert.match(report, /^ {2}bind only against too-low results \(1\): \S+ \(1\)$/m);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE without --deep: accusations are confirmed — a candidate hollow red under the opposite sentinel is one-sided, never hollow', () => {
  const d = project(FIXTURE);
  try {
    const r = prove(d, { runner: 'node' });
    // The proven side is NOT re-examined by default: B stays caught on single-sentinel evidence.
    assert.equal(r.caught, 4, 'plain run: B/C/E/F caught on the positive sentinel');
    // Candidate hollow A goes red under the opposite sentinel → one-sided; only the both-green
    // echo remains hollow. The exit-1 surface (r.hollow) can never carry a sign accident.
    assert.equal(r.hollow.length, 1);
    assert.equal(r.hollow[0].name, 'echo');
    assert.deepEqual(r.oneSided.map((o) => o.name), ['low reading fails']);
    assert.equal(r.oneSided[0].posRed, false);
    assert.equal(r.scored, 6);
    assert.equal(r.weakSummary, undefined, 'the identity-stub advisory stays deep-only');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- diff classification: a one-sided block never mints proven or hollow for its fn ---

test('classifyChanges: a one-sided block classifies its fn unverifiable with the one-sided reason', () => {
  const blockRecords = [{
    file: 'test/t.test.mjs', line: 5, name: 'low reading fails', bodyMasked: 'threshold()',
    verdict: 'one-sided', oneSidedPairs: [{ fn: 'threshold', sutRel: 'src/lib.mjs' }],
  }];
  const changedByFile = [{ file: 'src/lib.mjs', granularity: 'file', decls: [{ fn: 'threshold', line: 1 }] }];
  const { changes } = classifyChanges(changedByFile, blockRecords);
  const row = changes.find((c) => c.fn === 'threshold');
  assert.ok(row, 'the changed fn is classified');
  assert.equal(row.status, 'unverifiable');
  assert.equal(row.evidence.reason, 'one-sided');
});
