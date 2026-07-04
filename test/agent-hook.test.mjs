import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The hooks are bash and documented macOS/Linux-only; on Windows this whole surface is out of scope.
const UNIX_ONLY = { skip: process.platform === 'win32' ? 'hooks are unix-only (bash)' : false };

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'check-changed-tests');
const SUT = 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n';
const H = "import { test } from 'node:test'; import assert from 'node:assert';";
const HOLLOW = `${H} import { total } from '../src/lib.mjs';\ntest('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });\n`;
const SOUND = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\n`;

const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });

// A repo with a COMMITTED SUT and an UNCOMMITTED test — so `prove --since=HEAD` sees the test as the agent's change.
function hookRepo({ testCode = HOLLOW, marker = true, gitInit = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'gc-hook-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  if (gitInit) { git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); }
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), testCode);
  if (marker) writeFileSync(join(d, '.gutcheck'), '');
  return d;
}
// Run the hook from cwd=d with a Stop-hook stdin payload; return the parsed block object, or null if no block.
function runHook(d, stopHookActive = false) {
  let out = '';
  try { out = execFileSync('bash', [HOOK], { cwd: d, input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: stopHookActive }), encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '').toString(); }
  const line = out.trim();
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

const SESSION_HOOK = fileURLToPath(new URL('../hooks/session-start', import.meta.url));
const PROMPT_HOOK = fileURLToPath(new URL('../hooks/user-prompt-submit', import.meta.url));
function runSession(d, source) {
  return execFileSync('bash', [SESSION_HOOK], { cwd: d, input: JSON.stringify({ hook_event_name: 'SessionStart', source }), encoding: 'utf8' });
}
function runPrompt(d, prompt) {
  return execFileSync('bash', [PROMPT_HOOK], { cwd: d, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }), encoding: 'utf8' });
}
const baselinePath = (d) => join(execFileSync('git', ['-C', d, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim().replace(/^(?!\/)/, d + '/'), 'gutcheck-baseline');

test('agent-hook: a hollow changed test blocks the stop and names the test', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r = runHook(d, false);
    assert.ok(r && r.decision === 'block', 'blocks');
    assert.match(r.reason, /HOLLOW/, 'reason names it HOLLOW (proven by execution)');
    assert.match(JSON.stringify(r), /shadow/, 'names the hollow test');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: LOOP GUARD — stop_hook_active:true never blocks (one forced attempt)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try { assert.equal(runHook(d, true), null, 'no block when already continuing from a prior block'); }
  finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: a sound changed test does not block', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: SOUND });
  try { assert.equal(runHook(d, false), null); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: no .gutcheck marker → no block (opt-in)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW, marker: false });
  try { assert.equal(runHook(d, false), null); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: not a git repo → fail-open, no block', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW, gitInit: false });
  try { assert.equal(runHook(d, false), null); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: the block delivers the message via hookSpecificOutput.additionalContext', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r = runHook(d, false);
    assert.ok(r && r.decision === 'block', 'blocks');
    assert.ok(r.hookSpecificOutput && r.hookSpecificOutput.hookEventName === 'Stop', 'carries a Stop hookSpecificOutput');
    assert.match(r.hookSpecificOutput.additionalContext || '', /shadow/, 'the actionable message is on the delivered channel');
    assert.match(r.hookSpecificOutput.additionalContext || '', /assert the real expected value/, 'includes the concrete fix instruction');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('session-start records the HEAD baseline when the marker exists', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  runSession(d, 'startup');
  const rec = readFileSync(baselinePath(d), 'utf8').trim();
  const head = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(rec, head);
});

test('session-start never moves the baseline on compact', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  writeFileSync(baselinePath(d), 'sentinel-old-sha\n');
  runSession(d, 'compact');
  assert.equal(readFileSync(baselinePath(d), 'utf8').trim(), 'sentinel-old-sha');
});

test('session-start does NOT inject the skill unless .gutcheck contains session-skill', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });           // marker exists but is empty
  assert.equal(runSession(d, 'startup').trim(), '');  // no additionalContext JSON
  writeFileSync(join(d, '.gutcheck'), 'session-skill\n');
  assert.match(runSession(d, 'startup'), /additionalContext/);
});

test('user-prompt-submit is gated on the prompt-cue flag', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });           // empty marker → no cue
  assert.equal(runPrompt(d, 'please implement the parser and verify it').trim(), '');
  writeFileSync(join(d, '.gutcheck'), 'prompt-cue\n');
  assert.match(runPrompt(d, 'please implement the parser and verify it'), /additionalContext/);
});

test('Stop hook probes work the agent COMMITTED during the session (baseline, not HEAD)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });           // hollow test written, uncommitted
  runSession(d, 'startup');                           // baseline = HEAD before the "agent" works
  git(d, 'add', '-A'); git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agent work'); // agent commits
  const out = runHook(d, false);                      // --since=HEAD would now see nothing
  assert.ok(out && out.decision === 'block', 'committed hollow test must still block');
});
