import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from '../mutation/gate.mjs';

// The advisory rides the gate's EXISTING channels. It never creates a block, and for a memoOneShot
// harness it never creates a message at all — gate.mjs's stamp site treats any non-null output as a
// block, so an advisory-only message there would be stamped blockedAt and then suppress its own later
// message.
//
// These fixtures run the real probe, so their test files must actually pass under `node --test`: the
// findings here come from derivationCoherence, whose default config covers the node:assert dialect. The
// jest-dialect kinds are unit-tested statically in test/advise.test.mjs instead.
const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
const stopEvent = (active = false) => JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: active });
const cursorEvent = () => JSON.stringify({ status: 'completed', loop_count: 0 });

const SUT = 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n';
const H = "import { test } from 'node:test'; import assert from 'node:assert';";
// PASSES (total is 2), and its inline derivation says 3 — a real derivationCoherence finding.
const INCOHERENT = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); }); // 1 * 3 = 3\n`;
const SOUND = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\n`;
// Blocks (the shadow test is hollow) AND carries a finding, so the block-reason append has something to
// append. The finding needs its own line: derivationCoherence contradicts an asserted LITERAL, and the
// hollow assertion compares against a variable, so a derivation comment on that line has nothing to
// contradict. Both tests pass under `node --test`, keeping the block reason about the hollow alone.
const HOLLOW_AND_INCOHERENT = `${H} import { total } from '../src/lib.mjs';\ntest('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); }); // 1 * 3 = 3\n`;

// Committed SUT + committed sound test; the uncommitted change is `changed`.
function repo(changed) {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-adv-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  for (const [rel, body] of Object.entries(changed)) writeFileSync(join(d, rel), body);
  return d;
}

test('gate advisory: appended to the clean voice on a probeable diff', () => {
  // Both a function and its test changed: fns > 0 (clean voice fires) AND a changed test file carries a
  // finding (the advisory fires).
  const d = repo({ 'src/lib.mjs': SUT.trimEnd() + ' // touched\n', 'test/t.test.mjs': INCOHERENT });
  try {
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(), env: {} });
    assert.ok(out, 'a probeable clean diff must still speak');
    const msg = JSON.parse(out).systemMessage;
    assert.match(msg, /^gutcheck: of \d+ function\(s\) you changed/, 'the probe line still leads');
    assert.match(msg, /\ngutcheck lint: 1 finding\(s\)/, 'the advisory is a second line, not a rewrite');
    assert.match(msg, /js-derivation-coherence/);
    assert.equal(JSON.parse(out).decision, undefined, 'and it is NOT a block');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gate advisory: the clean voice is byte-identical when there is no finding', () => {
  const d = repo({ 'src/lib.mjs': SUT.trimEnd() + ' // touched\n' });
  try {
    const msg = JSON.parse(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(), env: {} })).systemMessage;
    // Hand-derived from gate.mjs's own template for this fixture: one changed function, proven by the
    // pre-existing sound test, nothing unverifiable, nothing capped.
    assert.equal(msg,
      'gutcheck: of 1 function(s) you changed — 1 proven, 0 with no binding test. (npx gutcheck --explain <file:line> for a receipt.)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gate advisory: appended to a block reason, never creating one', () => {
  const d = repo({ 'test/t.test.mjs': HOLLOW_AND_INCOHERENT });
  try {
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(), env: {} });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, 'block', 'the hollow still blocks');
    assert.match(parsed.reason, /are HOLLOW/, 'the hollow text is unchanged and leads');
    assert.match(parsed.reason, /\n\ngutcheck lint: /, 'the advisory is appended after a blank line');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gate advisory: speaks alone when only tests changed and the probe has nothing to say', () => {
  const d = repo({ 'test/t.test.mjs': INCOHERENT });
  try {
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(), env: {} });
    assert.ok(out, 'a test-only diff with a finding must not be silent — this is the case the checker exists for');
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, undefined, 'still not a block');
    assert.match(parsed.systemMessage, /^gutcheck lint: 1 finding\(s\)/, 'the advisory stands alone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Every memoOneShot harness, not just cursor: all three have channels.voice=false and memoOneShot=true.
// A standalone advisory for any of them would be stamped blockedAt by gate.mjs's stamp site — which reads
// any non-null output as a block — and would then suppress its own later message.
for (const [harnessName, event] of [
  ['cursor', cursorEvent()],
  ['copilot', JSON.stringify({ hook_event_name: 'Stop' })],
  ['antigravity', JSON.stringify({ terminationReason: 'model_stop', fullyIdle: true })],
]) {
  test(`gate advisory: ${harnessName} never gets an advisory-only message`, () => {
    const d = repo({ 'test/t.test.mjs': INCOHERENT });
    try {
      assert.equal(runGate({ harnessName, dir: d, stdinText: event, env: {} }), null);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}

test('gate advisory: the residue turn never runs the checker', () => {
  // The fixture carries a real finding, so advise() would return a non-null line here if the residue path
  // ever reached it — without that the assertion below passes vacuously.
  const d = repo({ 'test/t.test.mjs': HOLLOW_AND_INCOHERENT });
  try {
    runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} }); // writes the memo
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(true), env: {} });
    assert.ok(out, 'the residue notice still fires');
    assert.doesNotMatch(JSON.parse(out).systemMessage, /gutcheck lint/,
      'the residue path is memo-only — no checker text should appear in its message');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('gate advisory: an opted-out repo stays silent', () => {
  const d = repo({ 'test/t.test.mjs': INCOHERENT });
  try {
    writeFileSync(join(d, '.gutcheck-off'), '');
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(), env: {} }), null);
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(), env: { GUTCHECK_HOOK: 'off' } }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
