// Fixture-driven pins for the non-claude harness adapters registered in mutation/gate.mjs's HARNESSES.
// Shared across the multi-harness gate tiers (Codex here; Cursor/Copilot/Antigravity extend this file in
// their own tasks). Each adapter is a pure protocol mapping over the SAME shared verdict logic
// (buildVerdict/buildResidue in mutation/gate.mjs) — these fixtures exist to pin each adapter's exact
// wire shape and its channel on/off truth table, not to re-test the verdict logic itself (that's
// test/gate-core.test.mjs's job, driven through the claude harness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGate, HARNESSES } from '../mutation/gate.mjs';

const GUTCHECK = fileURLToPath(new URL('../mutation/gutcheck.mjs', import.meta.url));

const SUT = 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n';
const H = "import { test } from 'node:test'; import assert from 'node:assert';";
const HOLLOW = `${H} import { total } from '../src/lib.mjs';\ntest('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });\n`;
const SOUND = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\n`;

const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
const stopEvent = (active = false) => JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: active });
const cursorEvent = (status = 'completed', loop_count = 0) => JSON.stringify({ status, loop_count });
const copilotEvent = (body = {}) => JSON.stringify({ event: 'agentStop', ...body });
const antigravityEvent = ({ terminationReason = 'model_stop', fullyIdle = true, workspacePaths } = {}) =>
  JSON.stringify({
    terminationReason,
    fullyIdle,
    conversationId: 'c1',
    ...(workspacePaths !== undefined ? { workspacePaths } : {}),
  });

// Same memo-path derivation as test/gate-core.test.mjs (kept independent, not imported) — needed to
// inspect the memo's blockedAt field directly rather than only behaviorally.
const gitDirOf = (d) => execFileSync('git', ['-C', d, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim().replace(/^(?!\/)/, d + '/');
const memoSuffix = (d) => execFileSync('git', ['hash-object', '--stdin'], { input: realpathSync(d), encoding: 'utf8' }).trim().slice(0, 12);
const memoPathFor = (d) => join(gitDirOf(d), `gutcheck-memo-${memoSuffix(d)}`);

// Same shapes as test/gate-core.test.mjs, kept independent (not imported) so this file stays a
// standalone oracle per adapter.
function repo({ testCode = HOLLOW } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-adapters-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), testCode);
  return d;
}
function changedFnRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gc-gate-adapters-changed-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, 'src/lib.mjs'), SUT.trimEnd() + ' // touched\n');
  return d;
}

test('gate-adapters: the codex harness is registered with the documented channels (block only)', () => {
  assert.ok(HARNESSES.codex, 'HARNESSES.codex must exist');
  assert.deepEqual(HARNESSES.codex.channels, { block: true, voice: false, residue: false });
});

// (a) hollow → codex block payload is EXACTLY {decision, reason} — no hookSpecificOutput — and the
// reason text is byte-identical to what the claude adapter produces for the same fixture content
// (buildVerdict computes `reason` purely from the probe JSON; the harness only wraps the envelope).
test('gate-adapters: codex block payload is exactly {decision, reason} — same reason text as claude, no hookSpecificOutput', () => {
  const dClaude = repo({ testCode: HOLLOW });
  const dCodex = repo({ testCode: HOLLOW });
  try {
    const claudeOut = runGate({ harnessName: 'claude', dir: dClaude, stdinText: stopEvent(false), env: {} });
    const codexOut = runGate({ harnessName: 'codex', dir: dCodex, stdinText: stopEvent(false), env: {} });
    assert.ok(claudeOut && codexOut, 'both harnesses must produce a block payload for a hollow fixture');
    const claudeR = JSON.parse(claudeOut);
    const codexR = JSON.parse(codexOut);
    assert.deepEqual(Object.keys(codexR).sort(), ['decision', 'reason'], 'codex payload must carry exactly decision+reason, nothing else');
    assert.equal(codexR.decision, 'block');
    assert.equal(codexR.reason, claudeR.reason, 'reason text must be identical to what the claude adapter produces');
    assert.ok(!('hookSpecificOutput' in codexR), 'codex payload must NOT carry hookSpecificOutput (Claude-Code-specific)');
  } finally {
    rmSync(dClaude, { recursive: true, force: true });
    rmSync(dCodex, { recursive: true, force: true });
  }
});

// (b) clean-probeable run → null: codex's voice channel is off (systemMessage on Stop-exit-0 is
// unconfirmed for Codex), so the same fixture that voices a coverage message for claude stays silent.
test('gate-adapters: codex clean-probeable run stays silent (voice channel off)', () => {
  const d = changedFnRepo();
  try {
    assert.equal(runGate({ harnessName: 'codex', dir: d, stdinText: stopEvent(false), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (c) stop_hook_active retry turn with a fresh memo carrying an unfixed hollow → null: codex's residue
// channel is off for the same reason as voice.
test('gate-adapters: codex retry turn (stop_hook_active) stays silent (residue channel off)', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const blockOut = runGate({ harnessName: 'codex', dir: d, stdinText: stopEvent(false), env: {} }); // block turn: writes the memo
    assert.ok(blockOut, 'the block turn must fire and write the memo');
    assert.equal(runGate({ harnessName: 'codex', dir: d, stdinText: stopEvent(true), env: {} }), null, 'residue is off for codex');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- cursor: re-prompt gate (followup_message), no native block channel ----

test('gate-adapters: the cursor harness is registered with the documented channels (block only) + the memo one-shot guard flag', () => {
  assert.ok(HARNESSES.cursor, 'HARNESSES.cursor must exist');
  assert.deepEqual(HARNESSES.cursor.channels, { block: true, voice: false, residue: false });
  assert.equal(HARNESSES.cursor.memoOneShot, true, 'cursor has no exclusive loop-guard flag — the memo guard is load-bearing here');
});

// (a) hollow + status=completed, loop_count=0 → exactly {followup_message: <reason>} — deep key check
// (no decision/hookSpecificOutput/systemMessage riding along).
test('gate-adapters: cursor hollow + {status:completed, loop_count:0} yields exactly {followup_message}', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const out = runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 0), env: {} });
    assert.ok(out, 'must produce a payload for a hollow fixture');
    const r = JSON.parse(out);
    assert.deepEqual(Object.keys(r).sort(), ['followup_message'], 'the payload must carry exactly followup_message, nothing else');
    assert.match(r.followup_message, /HOLLOW/);
    assert.match(r.followup_message, /shadow/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (b) loop_count > 0 — Cursor already auto-resubmitted our last followup_message once; behave like
// stop_hook_active and never force a second retry from this path.
test('gate-adapters: cursor loop_count > 0 (already re-prompted once) never blocks — null', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 1), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (c) status !== 'completed' (aborted/error) — not ours to re-prompt.
test('gate-adapters: cursor status=aborted or status=error stays silent regardless of hollowness', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('aborted', 0), env: {} }), null);
    assert.equal(runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('error', 0), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (d) MEMO ONE-SHOT GUARD: two stops on the SAME diff — the first blocks and stamps blockedAt on the
// memo, the second is refused even though loop_count is still 0 both times (simulating a later,
// independent stop event that still carries the same unfixed diff — the case Cursor's own loop_count
// cannot catch by itself).
test('gate-adapters: cursor one-shot memo guard — the SAME diff blocks once, then is refused', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const first = runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 0), env: {} });
    assert.ok(first, 'the first stop on a hollow diff must block');
    const memoText = readFileSync(memoPathFor(d), 'utf8');
    const payload = JSON.parse(memoText.slice(memoText.indexOf('\n') + 1));
    assert.equal(payload.blockedAt, memoText.slice(0, memoText.indexOf('\n')), 'the memo must record blockedAt == the current diff-hash after the block turn');
    const second = runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 0), env: {} });
    assert.equal(second, null, 'the SAME diff must never block a second time — the one-shot guard');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (e) the guard is scoped to the diff-hash, not permanent: once the diff actually changes, it blocks again.
test('gate-adapters: cursor one-shot guard resets once the diff changes', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const first = runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 0), env: {} });
    assert.ok(first, 'the first stop blocks');
    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// an edit that changes the diff-hash but is still hollow\n');
    const second = runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 0), env: {} });
    assert.ok(second, 'a changed diff must block again — the guard is per diff-hash, not a permanent latch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (f) cross-version: a memo written by a NON-one-shot harness (codex — never touches blockedAt) has no
// blockedAt field at all. Cursor reading that same memo (same repo, same unchanged diff) must still parse
// it and block normally — an absent field is never mistaken for "already blocked".
test('gate-adapters: cursor reads a pre-existing memo with no blockedAt field (written by codex) and blocks normally', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const codexOut = runGate({ harnessName: 'codex', dir: d, stdinText: stopEvent(false), env: {} });
    assert.ok(codexOut, 'codex writes the memo first, in the old (no-blockedAt) format');
    const memoText = readFileSync(memoPathFor(d), 'utf8');
    assert.ok(!('blockedAt' in JSON.parse(memoText.slice(memoText.indexOf('\n') + 1))), 'codex must never write blockedAt');
    const cursorOut = runGate({ harnessName: 'cursor', dir: d, stdinText: cursorEvent('completed', 0), env: {} });
    assert.ok(cursorOut, 'cursor must still parse the pre-existing old-format memo and block (absence of blockedAt is not a guard)');
    assert.match(JSON.parse(cursorOut).followup_message, /HOLLOW/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- copilot: GitHub Copilot coding agent's agentStop hook, {decision:"block", reason} ----

test('gate-adapters: the copilot harness is registered with the documented channels (block only) + the memo one-shot guard flag', () => {
  assert.ok(HARNESSES.copilot, 'HARNESSES.copilot must exist');
  assert.deepEqual(HARNESSES.copilot.channels, { block: true, voice: false, residue: false });
  assert.equal(HARNESSES.copilot.memoOneShot, true, 'copilot carries no loop-guard flag at all — the memo guard is the ONLY guard');
});

// (a) hollow → copilot block payload is EXACTLY {decision:"block", reason} — deep-key check, no
// hookSpecificOutput riding along (that field is Claude-Code-specific).
test('gate-adapters: copilot hollow diff yields exactly {decision:"block", reason}', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const out = runGate({ harnessName: 'copilot', dir: d, stdinText: copilotEvent(), env: {} });
    assert.ok(out, 'must produce a payload for a hollow fixture');
    const r = JSON.parse(out);
    assert.deepEqual(Object.keys(r).sort(), ['decision', 'reason'], 'the payload must carry exactly decision+reason, nothing else');
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /HOLLOW/);
    assert.match(r.reason, /shadow/);
    assert.ok(!('hookSpecificOutput' in r), 'copilot payload must NOT carry hookSpecificOutput (Claude-Code-specific)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (b) malformed/empty stdin → null: copilot's stdin has no field this adapter can lean on for a loop
// guard, so a bad parse must fail open exactly like every other adapter here.
test('gate-adapters: copilot malformed or empty stdin stays silent — null', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'copilot', dir: d, stdinText: '{not json', env: {} }), null);
    assert.equal(runGate({ harnessName: 'copilot', dir: d, stdinText: '', env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (c) MEMO ONE-SHOT GUARD: copilot has no loop-guard flag whatsoever, so the memo guard is the only
// thing preventing a second block on the exact same diff.
test('gate-adapters: copilot one-shot memo guard — the SAME diff blocks once, then is refused', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const first = runGate({ harnessName: 'copilot', dir: d, stdinText: copilotEvent(), env: {} });
    assert.ok(first, 'the first agentStop on a hollow diff must block');
    const second = runGate({ harnessName: 'copilot', dir: d, stdinText: copilotEvent(), env: {} });
    assert.equal(second, null, 'the SAME diff must never block a second time — copilot has no loop flag to lean on instead');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (d) the guard is scoped to the diff-hash, not permanent — once the diff changes, it blocks again.
test('gate-adapters: copilot one-shot guard resets once the diff changes', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const first = runGate({ harnessName: 'copilot', dir: d, stdinText: copilotEvent(), env: {} });
    assert.ok(first, 'the first stop blocks');
    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// an edit that changes the diff-hash but is still hollow\n');
    const second = runGate({ harnessName: 'copilot', dir: d, stdinText: copilotEvent(), env: {} });
    assert.ok(second, 'a changed diff must block again — the guard is per diff-hash, not a permanent latch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- antigravity: Google Antigravity's Stop hook, {decision:"continue", reason} ----

test('gate-adapters: the antigravity harness is registered with the documented channels (block only) + the memo one-shot guard flag', () => {
  assert.ok(HARNESSES.antigravity, 'HARNESSES.antigravity must exist');
  assert.deepEqual(HARNESSES.antigravity.channels, { block: true, voice: false, residue: false });
  assert.equal(HARNESSES.antigravity.memoOneShot, true, 'antigravity carries no loop-guard flag at all — the memo guard is the ONLY guard');
});

// (a) hollow + a clean, fully-idle stop → EXACTLY {decision:"continue", reason} — Antigravity's verb for
// "prevent the stop and inject this text" is continue, not block.
test('gate-adapters: antigravity clean stop (model_stop + fullyIdle) on a hollow diff yields exactly {decision:"continue", reason}', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const out = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent(), env: {} });
    assert.ok(out, 'must produce a payload for a hollow fixture');
    const r = JSON.parse(out);
    assert.deepEqual(Object.keys(r).sort(), ['decision', 'reason'], 'the payload must carry exactly decision+reason, nothing else');
    assert.equal(r.decision, 'continue', "antigravity's verb for block-the-stop is continue, not block");
    assert.match(r.reason, /HOLLOW/);
    assert.match(r.reason, /shadow/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (b) non-gate terminations: max_steps_exceeded, error, and fullyIdle:false must NEVER be re-entered —
// re-entering an already-broken loop from here is how a gate becomes a hang.
test('gate-adapters: antigravity never re-enters a non-clean stop — max_steps_exceeded, error, or not-fully-idle stay silent', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent({ terminationReason: 'max_steps_exceeded' }), env: {} }), null);
    assert.equal(runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent({ terminationReason: 'error' }), env: {} }), null);
    assert.equal(runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent({ fullyIdle: false }), env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (c) malformed stdin → null, same fail-open posture as every other adapter.
test('gate-adapters: antigravity malformed stdin stays silent — null', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    assert.equal(runGate({ harnessName: 'antigravity', dir: d, stdinText: '{not json', env: {} }), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (d) MEMO ONE-SHOT GUARD: antigravity has no loop-guard flag whatsoever, so the memo guard is the only
// thing preventing a second block on the exact same diff.
test('gate-adapters: antigravity one-shot memo guard — the SAME diff blocks once, then is refused', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const first = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent(), env: {} });
    assert.ok(first, 'the first clean stop on a hollow diff must block');
    const second = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent(), env: {} });
    assert.equal(second, null, 'the SAME diff must never block a second time — antigravity has no loop flag to lean on instead');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (e) the guard is scoped to the diff-hash, not permanent — once the diff changes, it blocks again.
test('gate-adapters: antigravity one-shot guard resets once the diff changes', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const first = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent(), env: {} });
    assert.ok(first, 'the first stop blocks');
    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// an edit that changes the diff-hash but is still hollow\n');
    const second = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent(), env: {} });
    assert.ok(second, 'a changed diff must block again — the guard is per diff-hash, not a permanent latch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (f) workspacePaths[0] overrides cwd as the gate dir: cwd points at a non-repo directory entirely, but
// the fixture repo is passed via workspacePaths — the gate must still find and probe it.
test('gate-adapters: antigravity workspacePaths[0] overrides the gate dir when cwd points elsewhere', () => {
  const d = repo({ testCode: HOLLOW }); // the real repo, reachable only via workspacePaths below
  const elsewhere = mkdtempSync(join(tmpdir(), 'gc-gate-adapters-elsewhere-')); // NOT a git repo
  try {
    const out = runGate({ harnessName: 'antigravity', dir: elsewhere, stdinText: antigravityEvent({ workspacePaths: [d] }), env: {} });
    assert.ok(out, 'workspacePaths[0] must override cwd — the gate must probe the fixture repo, not the non-repo elsewhere dir');
    const r = JSON.parse(out);
    assert.equal(r.decision, 'continue');
    assert.match(r.reason, /HOLLOW/);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// (g) defensive fallback: an absent, empty, non-string-entry, or non-array workspacePaths must fall back
// to cwd rather than throw or silently gate nothing. Each sub-case edits the diff first so the one-shot
// guard from the previous sub-case doesn't mask a fresh probe.
test('gate-adapters: antigravity workspacePaths defensive fallback — absent/empty/non-string/non-array all fall back to cwd', () => {
  const d = repo({ testCode: HOLLOW });
  try {
    const noField = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent(), env: {} });
    assert.ok(noField, 'no workspacePaths field at all must fall back to cwd (dir) and still gate normally');

    // Each rewrite below must change the untracked test file's SIZE (not just its trailing digit) —
    // the memo key hashes size+mtime-floored-to-the-second for untracked files, and same-length edits
    // inside the same wall-clock second would otherwise collide with the prior sub-case's diff-hash and
    // get refused by the one-shot guard instead of exercising a fresh probe.
    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// diff-2\n');
    const emptyArray = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent({ workspacePaths: [] }), env: {} });
    assert.ok(emptyArray, 'an empty workspacePaths array must fall back to cwd');

    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// diff-33\n');
    const nonStringEntry = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent({ workspacePaths: [123] }), env: {} });
    assert.ok(nonStringEntry, 'a non-string workspacePaths[0] must fall back to cwd, not throw or silently probe nothing');

    writeFileSync(join(d, 'test/t.test.mjs'), HOLLOW + '\n// diff-444\n');
    const nonArray = runGate({ harnessName: 'antigravity', dir: d, stdinText: antigravityEvent({ workspacePaths: 'not-an-array' }), env: {} });
    assert.ok(nonArray, 'a non-array workspacePaths value must fall back to cwd');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// (d) CLI-level: an unknown --harness name stays silent regardless of which harness names ARE
// registered — pinned here (not just in gate-core.test.mjs) because this file is the shared oracle for
// every future adapter task; each one should be able to add its own fixtures without re-deriving this.
test('gate-adapters: CLI --harness=<unknown> stays silent — empty stdout, exit 0', () => {
  const r = spawnSync(process.execPath, [GUTCHECK, 'gate', '--harness=nope'], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
