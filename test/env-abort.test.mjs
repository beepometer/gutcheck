import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prove, formatReport } from '../mutation/prove.mjs';

// Environment-abort fail-fast: a broken build / wrong runner makes EVERY baseline fail identically. The
// probe must stop after the first ENV_ABORT_THRESHOLD (10) baselines all fail with none passing, instead
// of grinding through hundreds of guaranteed-inconclusive baselines to report 0 verdicts (the motivating
// incident: a sandboxed shell broke Gradle → 604 baselines failed → ~35 min for "0 verdicts"). The
// oracle here is independent of the code's own output: 12 blocks that ALL fail baseline must yield
// exactly 10 inconclusive baseline rows and the rest aborted; 1 passing baseline disables the abort no
// matter how many failures follow.

const PROVE_CLI = resolve('mutation/prove.mjs');
const HEAD = "import { test } from 'node:test'; import assert from 'node:assert';";
const SUTADD = 'export function add(a, b) { return a + b; }\n';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-envabort-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}

// n blocks that each pin add() against an INDEPENDENTLY-chosen expected value. Every block pins a wrong
// value (add(i,1) === i+1, never 999999) so its baseline fails — EXCEPT block 0 when firstPasses, which
// pins the true value so its baseline passes and it is caught. No value is read back from the tool.
function failProject(n, { firstPasses = false } = {}) {
  const lines = [`${HEAD} import { add } from '../src/lib.mjs';`];
  for (let i = 0; i < n; i++) {
    const expected = (firstPasses && i === 0) ? i + 1 : 999999;
    lines.push(`test('t${i}', () => { assert.strictEqual(add(${i}, 1), ${expected}); });`);
  }
  return project({ 'package.json': '{"type":"module"}', 'src/lib.mjs': SUTADD, 'test/t.test.mjs': lines.join('\n') + '\n' });
}

// (a) MUST-FIRE: 12 all-failing baselines → exactly 10 inconclusive baseline rows, 2 aborted, no probes,
// no verdicts, and the report's wipeout hint carries the abort tail.
test('env-abort: 12 all-failing baselines → 10 inconclusive + 2 aborted, zero probes/verdicts, hint present', () => {
  const d = failProject(12);
  try {
    const r = prove(d, { runner: 'node' });
    const baselineRows = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
    assert.equal(baselineRows.length, 10, `first 10 baselines ran-and-failed, the rest aborted before running: ${JSON.stringify(r.inconclusive)}`);
    assert.equal(r.envAborted, 2, 'exactly the 2 blocks past the threshold are aborted');
    assert.equal(r.probes, 0, 'a broken-env run mutates nothing');
    assert.equal(r.scored, 0, 'no block is scored');
    assert.equal(r.caught, 0, 'no caught verdict is minted from an aborted run');
    assert.equal(r.hollow.length, 0, 'no hollow verdict is minted from an aborted run');
    const out = formatReport(r);
    assert.match(out, /every baseline run failed before any mutation/, 'the wipeout framing is kept');
    assert.match(out, /first 10/, 'the hint states the first 10 all failed');
    assert.match(out, /2 remaining block\(s\) not probed/, 'the hint states how many blocks were left unprobed');
    assert.match(out, /--runner=</, 'the hint tells the user to override the runner');
    // ONE coherent message: the abort tail lives inside the wipeout line, never a second contradictory line.
    assert.doesNotMatch(out, /probed test\(s\) already fail before any mutation/, 'the partial-fail signal must not also render');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (b) MUST-NOT-FIRE: one passing baseline first, then 12 failing → NO abort ever, prior behavior intact
// (invariant 5: mixed results never abort, no matter how many failures follow the pass).
test('env-abort: a single passing baseline disables the abort even past the threshold', () => {
  const d = failProject(13, { firstPasses: true });
  try {
    const r = prove(d, { runner: 'node' });
    assert.ok(!r.envAborted, `no block is aborted once any baseline passed: envAborted=${r.envAborted}`);
    const baselineRows = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
    assert.equal(baselineRows.length, 12, 'all 12 failing baselines are reported as inconclusive, none aborted');
    assert.equal(r.caught, 1, 'the one sound test is still probed and caught');
    assert.equal(r.scored, 1, 'the passing baseline keeps normal scoring alive');
    const out = formatReport(r);
    assert.doesNotMatch(out, /remaining block\(s\) not probed/, 'no abort tail when a baseline passed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (c) the JSON surface (consumed by the Stop hook) carries the abort reason as a machine-readable count.
test('env-abort: the --json surface carries envAborted', () => {
  const d = failProject(12);
  try {
    let out;
    try { out = execFileSync('node', [PROVE_CLI, d, '--runner=node', '--json'], { encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '').toString(); }
    const r = JSON.parse(out);
    assert.equal(r.envAborted, 2, `the JSON result reports the aborted-block count: ${out}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
