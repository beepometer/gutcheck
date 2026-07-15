// Unit fixtures for the extracted gate CORE (mutation/gate.mjs) — drives runGate() directly, with no bash
// layer in between. The bash hook (hooks/check-changed-tests) is now a thin `exec node ... gate
// --harness=claude` caller; its own pinned behavior is proven unchanged by test/agent-hook.test.mjs and
// test/jvm-e2e.test.mjs (the equivalence oracle for this refactor — NOT edited here). These fixtures exist
// to unit-test the core logic in isolation (and to pin the NEW malformed-stdin/unknown-harness contracts
// that the harness-adapter interface introduces, which the bash hook never had a test for).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate, HARNESSES } from '../mutation/gate.mjs';
import { lockPathFor } from '../mutation/lock.mjs';

const SUT = 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n';
const H = "import { test } from 'node:test'; import assert from 'node:assert';";
const HOLLOW = `${H} import { total } from '../src/lib.mjs';\ntest('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });\n`;
const SOUND = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\n`;

const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
const stopEvent = (active = false) => JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: active });

// A repo with a COMMITTED SUT and an UNCOMMITTED test — so a --since=HEAD probe sees the test as the
// agent's change (same shape as agent-hook.test.mjs's hookRepo — kept independent, not imported, so this
// file stays a standalone oracle for the core).
function repo({ testCode = HOLLOW } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-core-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), testCode);
  return d;
}
// SUT + SOUND test both committed; an uncommitted, behavior-identical edit to the SUT — a real changed
// function, no hollow, still proven by the pre-existing sound test. The "clean but probeable diff" shape.
function changedFnRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-core-changed-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, 'src/lib.mjs'), SUT.trimEnd() + ' // touched\n');
  return d;
}
// SUT + SOUND test both committed; the only uncommitted change is a doc file — touches no function at all.
function docOnlyRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-core-doc-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, 'docs.txt'), 'unrelated docs-only change\n');
  return d;
}
const gitDirOf = (d) => execFileSync('git', ['-C', d, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim().replace(/^(?!\/)/, d + '/');
const memoSuffix = (d) => execFileSync('git', ['hash-object', '--stdin'], { input: realpathSync(d), encoding: 'utf8' }).trim().slice(0, 12);
const memoPathFor = (d) => join(gitDirOf(d), `gutcheck-memo-${memoSuffix(d)}`);

test('gate-core: the claude harness is registered with the documented channels', () => {
  assert.ok(HARNESSES.claude);
  assert.deepEqual(HARNESSES.claude.channels, { block: true, voice: true, residue: true });
});

// (a) hollow fixture → block JSON, exact current message shape.
test('gate-core: a hollow changed test yields a block payload naming the survivor and its SUT file', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} });
    assert.ok(out, 'must return a payload');
    const r = JSON.parse(out);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /HOLLOW/);
    assert.match(r.reason, /shadow/);
    assert.match(r.reason, /stays green even when total\(\) \(src\/lib\.mjs\) returns a wrong value/);
    assert.match(r.reason, /assert the real expected value/);
    assert.ok(r.hookSpecificOutput && r.hookSpecificOutput.hookEventName === 'Stop');
    assert.equal(r.hookSpecificOutput.additionalContext, r.reason);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (b) clean-probeable → voice JSON, never a decision.
test('gate-core: a clean, still-proven changed function yields a voice payload (never a decision)', () => {
  const d = changedFnRepo();
  try {
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} });
    assert.ok(out, 'must voice the coverage denominator');
    const r = JSON.parse(out);
    assert.equal(r.decision, undefined);
    assert.match(r.systemMessage, /gutcheck: of \d+ function\(s\) you changed — \d+ proven/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (c) nothing probeable (doc-only diff) → null.
test('gate-core: a doc-only diff (no probeable function changed) yields null (silence)', () => {
  const d = docOnlyRepo();
  try {
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (d) stop_hook_active + fresh memo carrying a hollow → residue JSON, never a decision.
test('gate-core: RESIDUE — retry turn with a fresh memo carrying an unfixed hollow voices the residue message', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const blockOut = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} }); // block turn: writes the memo
    assert.equal(JSON.parse(blockOut).decision, 'block', 'the block turn must fire and write the memo');
    const residueOut = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(true), env: {} }); // retry: same diff
    assert.ok(residueOut);
    const r = JSON.parse(residueOut);
    assert.equal(r.decision, undefined, 'the retry turn never blocks');
    assert.match(r.systemMessage, /^gutcheck: finishing with 1 still-hollow test\(s\) flagged and not fixed: /);
    assert.match(r.systemMessage, /test\/t\.test\.mjs:\d+ 'shadow'/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gate-core: RESIDUE — a changed diff before the retry turn stays silent (stale-memo guard)', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const blockOut = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} });
    assert.equal(JSON.parse(blockOut).decision, 'block');
    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// attempted fix\n');
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(true), env: {} }), null, 'a changed diff must never replay the stale memo');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gate-core: RESIDUE — no memo at all (first hook run is already a retry) stays silent', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(true), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (e) malformed stdin → null (fail-open; a NEW contract point the harness-adapter interface introduces —
// the bash hook never had a pinned test for this shape since Claude Code always sends valid JSON).
test('gate-core: malformed stdin fails open (null, never throws)', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: 'not json {{{', env: {} }), null);
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: '', env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (f) GUTCHECK_HOOK=off → null (global kill switch).
test('gate-core: GUTCHECK_HOOK=off disables the gate', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: { GUTCHECK_HOOK: 'off' } }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Additional fail-open coverage at the core level (mirrors the bash hook's truth table).
test('gate-core: .gutcheck-off at the repo root disables the gate', () => {
  const d = repo({ testCode: HOLLOW });
  writeFileSync(join(d, '.gutcheck-off'), '');
  try {
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gate-core: not a git repo fails open (null)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-core-nogit-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  try {
    assert.equal(runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gate-core: an unknown harness name fails open (null) — forward-compat with future harness adapters', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'nonexistent-harness', dir: d, stdinText: stopEvent(false), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- memo cross-version compatibility (both directions) ----
// The scenario deliberately has NO untracked files: the tracked `git diff <baseline>` output is the ONLY
// input to the key on both sides, so the untracked-file stat-format change (fs.statSync replacing bash's
// `stat -c || stat -f` dance — see mutation/gate.mjs) never engages, and the OLD-bash-pipeline key and the
// NEW-core key are byte-identical by construction. (Untracked-file identity is instead covered by the
// pre-existing, UNCHANGED test/agent-hook.test.mjs "memo invalidates when an UNTRACKED test file is
// edited" test, which pins INVALIDATION BEHAVIOR — a hash CHANGES on edit — never a literal hash value.)
test('gate-core: memo cross-version — a memo written in the OLD bash-pipeline key format is read by the new core', () => {
  const d = changedFnRepo();
  try {
    const memoPath = memoPathFor(d);
    // Reproduce the OLD bash key EXACTLY: `git diff HEAD | git hash-object --stdin` (no untracked files,
    // so `git ls-files --others --exclude-standard` contributes nothing on either side).
    const diffOut = execFileSync('git', ['-C', d, 'diff', 'HEAD'], { encoding: 'utf8' });
    const oldKey = execFileSync('git', ['hash-object', '--stdin'], { input: diffOut, encoding: 'utf8' }).trim();
    const sentinel = JSON.stringify({ scored: 0, hollow: [], inconclusive: [], changeSummary: { files: 1, fns: 555, proven: 555, hollow: 0, unverifiable: 0, untested: 0 } });
    writeFileSync(memoPath, `${oldKey}\n${sentinel}`);
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} });
    assert.ok(out, 'must read the OLD-format memo');
    assert.match(JSON.parse(out).systemMessage, /of 555 function\(s\)/, 'served from the OLD-written memo, not a fresh probe');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gate-core: memo cross-version — a memo the new core writes matches the key an OLD bash hook would compute (vice versa)', () => {
  const d = changedFnRepo();
  try {
    const memoPath = memoPathFor(d);
    const out = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} }); // writes a fresh memo
    assert.ok(out && existsSync(memoPath), 'the new core must write the memo');
    const [newLineKey] = readFileSync(memoPath, 'utf8').split('\n', 1);
    const diffOut = execFileSync('git', ['-C', d, 'diff', 'HEAD'], { encoding: 'utf8' });
    const oldStyleKey = execFileSync('git', ['hash-object', '--stdin'], { input: diffOut, encoding: 'utf8' }).trim();
    assert.equal(newLineKey, oldStyleKey, 'an old bash hook reading this new memo mid-upgrade must recognize it as fresh for this no-untracked-file diff');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- probe lock vs the gate (mutation/lock.mjs): while another gutcheck run holds the repo lock, the
// Stop hook must yield (no block, no collision) AND must NOT memoize the refusal — a cached "run didn't
// happen" keyed by this diff-hash would suppress every later gate on the same diff. Oracle: the same
// hollow fixture that blocks in test (a) must still block AFTER the lock clears.
test('gate-core: a held repo lock yields silently and is never memoized — the gate still blocks once the lock clears', () => {
  const d = repo({ testCode: HOLLOW });
  writeFileSync(lockPathFor(d), JSON.stringify({ pid: process.ppid, started: '2026-07-14T00:00:00Z' }));
  const whileHeld = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} });
  assert.equal(whileHeld, null, 'the gate yields to the active run — no block, no second Gradle');
  rmSync(lockPathFor(d), { force: true });
  const afterClear = runGate({ harnessName: 'claude', dir: d, stdinText: stopEvent(false), env: {} });
  assert.ok(afterClear !== null, 'the refusal was not cached — the hollow still blocks on the next stop');
  assert.match(afterClear, /stays green/, 'the block payload is the real verdict, not a residue of the refusal');
  rmSync(d, { recursive: true, force: true });
});
