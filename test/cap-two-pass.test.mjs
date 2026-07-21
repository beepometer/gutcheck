// Cap two-pass — corpus-pilot catch (strata shape): relational fns in an EARLY mixed block must not
// eat --max-probes budget that a LATER value block's hollow needs. Oracle hand-derived from the fix
// contract: capped-run hollows ⊇ old-engine capped-run hollows.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prove } from '../mutation/prove.mjs';

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-cap2-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}

// a_mixed.test.mjs sorts before b_hollow.test.mjs (fs order): the mixed block's ONE value fn is
// caught (1 probe), and its THREE relational fns each cost a probe inline on the buggy engine —
// exhausting maxProbes=4 before b_hollow's echo block can gut(1)+confirm(1).
const FILES = {
  'src/lib.mjs': `export function scaleV(x) { return x * 2 }
export function relA(x) { return x + 1 }
export function relB(x) { return x + 2 }
export function relC(x) { return x + 3 }
export function echoLike(x) { return x }
`,
  'test/a_mixed.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { scaleV, relA, relB, relC } from '../src/lib.mjs';
test('mixed', () => {
  assert.strictEqual(scaleV(2), 4);
  assert.ok(relA(1) > 0);
  assert.ok(relB(1) > 0);
  assert.ok(relC(1) > 0);
});
`,
  'test/b_hollow.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { echoLike } from '../src/lib.mjs';
test('echo hollow', () => { assert.strictEqual(echoLike(5), echoLike(5)); });
`,
};

test('capped run never loses the old-engine hollow to relational budget theft', () => {
  const d = project(FILES);
  try {
    const r = prove(d, { runner: 'node', maxProbes: 4 });
    // THE oracle: b_hollow's accusation must survive the cap — value work first, run-wide.
    assert.equal(r.hollow.length, 1, `hollow lost to relational displacement: ${JSON.stringify({ hollow: r.hollow, capped: r.capped, probes: r.probes })}`);
    assert.equal(r.hollow[0].name, 'echo hollow');
    // The mixed block's value fn is still caught.
    assert.ok(r.caught >= 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('uncapped run keeps full combined semantics — relational fns still probe and prove', () => {
  const d = project(FILES);
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 1);
    assert.equal(r.hollow[0].name, 'echo hollow');
    // relA/relB/relC probed on leftover budget: red under + (x+1 with +sentinel > 0 passes... they
    // SURVIVE + and go red under −, i.e. one-sided) or bound — either way they are EVIDENCED, not capped.
    assert.equal(r.capped, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Reviewer-found critical: ONE block mixes a hollow-shaped value assert (assert.strictEqual(echoLike(5),
// echoLike(5)) — always passes, any-mutant-survives) with a relational assert (assert.ok(boundedFn(5) <
// 100) — red under the +987654321 sentinel). At maxProbes=1, pass 1's value loop guts echoLike (1 probe,
// survives — accusation-shaped: nothing has broken yet) and defers boundedFn (relational). If the block
// is deferred wholesale, pass 2 finds probes already at the cap and starves boundedFn with ZERO attempts
// — but ctx.anyGutted is already true (echoLike ran), so the old starved-guard (anyGutted===false) never
// fires, and foldBlock mints a HOLLOW from partial (value-only) evidence. The base engine (no per-fn
// budget gate inside a block's own gut loop) always guts both fns in one shot regardless of maxProbes,
// so it never accuses here: caught=1, hollow=0. A capped run must never accuse where an uncapped run
// (or the base engine) would catch.
test('accusation-shaped mixed block never accuses on rel-starved partial evidence', () => {
  const d = project({
    'src/lib.mjs': `export function echoLike(x) { return x }
export function boundedFn(x) { return x }
`,
    'test/mixed.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert';
import { echoLike, boundedFn } from '../src/lib.mjs';
test('mixed accusation', () => {
  assert.strictEqual(echoLike(5), echoLike(5));
  assert.ok(boundedFn(5) < 100);
});
`,
  });
  try {
    const r = prove(d, { runner: 'node', maxProbes: 1 });
    assert.equal(r.hollow.length, 0, `false hollow minted on rel-starved partial evidence: ${JSON.stringify({ hollow: r.hollow, caught: r.caught, capped: r.capped, probes: r.probes })}`);
    assert.ok(r.caught >= 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
