import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
function runHook(d, stopHookActive = false, env = {}) {
  let out = '';
  try { out = execFileSync('bash', [HOOK], { cwd: d, input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: stopHookActive }), encoding: 'utf8', env: { ...process.env, ...env } }); }
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
function runPrompt(d, prompt, env = {}) {
  return execFileSync('bash', [PROMPT_HOOK], { cwd: d, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }), encoding: 'utf8', env: { ...process.env, ...env } });
}
const baselinePath = (d) => join(execFileSync('git', ['-C', d, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim().replace(/^(?!\/)/, d + '/'), 'gutcheck-baseline');
const gitDirOf = (d) => execFileSync('git', ['-C', d, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim().replace(/^(?!\/)/, d + '/');
// The hook keys its memo filename off the PHYSICAL cwd (`pwd -P`, not the possibly-symlinked path a
// caller passed in — e.g. macOS's /var/folders/... vs the real /private/var/folders/...), hashed with
// `git hash-object --stdin`. Replicated here independently (not by importing the hook) so the test is
// an oracle, not a mirror: shelling out to the SAME two primitives (`pwd -P`, `git hash-object`) the
// hook itself uses, rather than reimplementing or importing its logic.
const physicalDir = (d) => execFileSync('bash', ['-c', 'pwd -P'], { cwd: d, encoding: 'utf8' }).trim();
const memoSuffix = (d) => execFileSync('git', ['hash-object', '--stdin'], { input: physicalDir(d), encoding: 'utf8' }).trim().slice(0, 12);
const memoPathFor = (d) => join(gitDirOf(d), `gutcheck-memo-${memoSuffix(d)}`);

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
// The verification gate is ON by default: plugin enablement is the consent, the probe is diff-scoped
// (an untouched repo costs a git diff and exits), and the block fires only on receipted evidence. The
// context-costing extras (session skill, prompt cue) remain opt-in via marker CONTENT below — the
// dividing line is compute-only vs the user's context tokens.
test('agent-hook: no marker → the gate is ACTIVE by default (auto-on)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW, marker: false });
  try {
    const r = runHook(d, false);
    assert.ok(r && r.decision === 'block', 'a receipted hollow blocks with no marker present');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: a .gutcheck-off marker disables the gate', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW, marker: false });
  writeFileSync(join(d, '.gutcheck-off'), '');
  try { assert.equal(runHook(d, false), null); } finally { rmSync(d, { recursive: true, force: true }); }
});
// A self-contained probeable "package" lives ONE LEVEL DOWN from the git root, at <repoRoot>/src — the
// agent's cwd. Everything the probe needs (package.json, its own src/test) is committed there so the
// only uncommitted change is a TRACKED, same-line edit to the SUT (git diff is repo-root-relative
// regardless of cwd, so this reaches the probe whichever directory it runs from) — this sidesteps the
// separate, out-of-scope quirk where `git ls-files --others` resolves an UNTRACKED file's path relative
// to cwd, not the repo root. Without the up-tree fix this reliably still prints the coverage-voice
// systemMessage (proven RED below); the repo-root `.gutcheck-off` must silence it completely.
function upTreeOptOutRepo() {
  const outer = mkdtempSync(join(tmpdir(), 'gc-hook-uptree-'));
  const pkg = join(outer, 'src');
  mkdirSync(join(pkg, 'src'), { recursive: true }); writeFileSync(join(pkg, 'src/lib.mjs'), SUT);
  writeFileSync(join(pkg, 'package.json'), '{"type":"module"}');
  mkdirSync(join(pkg, 'test'), { recursive: true }); writeFileSync(join(pkg, 'test/t.test.mjs'), SOUND);
  git(outer, 'init', '-q'); git(outer, 'add', '-A'); git(outer, 'commit', '-qm', 'init');
  writeFileSync(join(pkg, 'src/lib.mjs'), SUT.trimEnd() + ' // touched\n'); // uncommitted, TRACKED, same-line edit
  return outer;
}

test('agent-hook: .gutcheck-off at the repo root disables the hook when cwd is a subdirectory', UNIX_ONLY, () => {
  const d = upTreeOptOutRepo();
  writeFileSync(join(d, '.gutcheck-off'), '');
  try {
    const r = runHookRaw(join(d, 'src'), false); // agent's cwd is a subdirectory of the repo, not the root
    assert.equal(r.out.trim(), '', 'a repo-root opt-out must be honored even when cwd is a subdirectory (stdout)');
    assert.equal(r.err.trim(), '', 'and stderr (fail-open/silent, same as the cwd-root opt-out case)');
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('agent-hook: GUTCHECK_HOOK=off disables the gate', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW, marker: false });
  try { assert.equal(runHook(d, false, { GUTCHECK_HOOK: 'off' }), null); } finally { rmSync(d, { recursive: true, force: true }); }
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

// ---- Task 4 (evidence in the block message): a bare survivor name (`total()`) is ambiguous across
// same-named helpers in different files — the agent can't tell WHICH `total` broke without fetching a
// receipt itself, and measured behavior shows agents act on what's IN the message. r.hollow now carries
// survivorPairs (fn, sutRel); the hook must render the file alongside the fn for cross-file disambiguation.
test('agent-hook: HOLLOW block reason names the survivor\'s SUT file, not just the bare fn name', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r = runHook(d, false);
    assert.ok(r && r.decision === 'block', 'blocks');
    assert.match(r.reason, /stays green even when \S+\(\) \(src\/[^)]+\)/,
      'the survivor is named as fn() (sutRel), disambiguating it from a same-named helper elsewhere');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The already-failing bucket's `why` is only `baseline Xp/Yf` — no clue WHAT failed. prove.mjs already
// captures the runner's own output tail in `detail` (inconclusive.push, mutation/prove.mjs); the hook
// must surface a sanitized slice of it so the agent sees the real assertion/failure text, not just counts.
test('agent-hook: already-failing block reason carries a fragment of the real runner output', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: MIXED_FAIL });
  try {
    const r = runHook(d, false);
    assert.ok(r && r.decision === 'block', 'blocks on a genuinely failing changed test');
    assert.match(r.reason, / — runner said: /, 'appends a labeled tail of the runner\'s own output');
    // node's built-in TAP reporter puts bookkeeping (`# pass`/`# fail`/`# skipped`/`# todo`/the `N..M`
    // plan line) at the very end of the stream — a naive last-3-non-empty-lines slice grabs ONLY that
    // bookkeeping, never the failure text. The hook filters those lines out first, so the tail this
    // fixture actually yields is the runner's own stack trace (real output, node:internal/test_runner
    // frames) rather than a pass/fail count — asserting on that path fragment fails pre-filter (the old
    // unfiltered tail is pure bookkeeping) and passes once bookkeeping is excluded from the slice.
    assert.match(r.reason, /node:internal\/test_runner/, 'the appended tail carries the runner\'s own failure/stack text, not TAP bookkeeping');
    assert.doesNotMatch(r.reason, /# (pass|fail|skipped|todo) \d+ \| # (pass|fail|skipped|todo) \d+/, 'the tail is not just TAP bookkeeping lines back to back');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Old-memo compatibility: a cached memo written before this fix has hollow entries with NO survivorPairs
// field at all — the hook must still render the bare-name form (no crash, no literal "undefined").
test('agent-hook: an old-shape cached memo (hollow entries with no survivorPairs) still renders the bare-name fallback, no crash', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const memoPath = memoPathFor(d);
    const r1 = runHookRaw(d, false);
    assert.equal(r1.status, 0);
    assert.ok(existsSync(memoPath), 'first run must write the memo');
    const [hash] = readFileSync(memoPath, 'utf8').split('\n', 1);
    const oldShape = JSON.stringify({
      scored: 1,
      hollow: [{ file: 'test/t.test.mjs', line: 1, name: 'shadow', survivors: ['total'] }], // no survivorPairs
      inconclusive: [],
    });
    writeFileSync(memoPath, hash + '\n' + oldShape);
    const r2 = runHookRaw(d, false);
    assert.equal(r2.status, 0);
    const parsed = JSON.parse(r2.out.trim());
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /stays green even when total\(\) returns a wrong value/, 'bare-name fallback, no crash');
    assert.doesNotMatch(parsed.reason, /undefined/, 'never renders literal undefined for a missing survivorPairs field');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Task 8 (RESIDUE SIGNAL): finishing with a flagged-and-unfixed hollow tells the user. The Stop
// hook's LOOP GUARD (stop_hook_active:true) gives the agent exactly one forced retry, then exits 0 —
// today totally silently even when the retry didn't fix anything. The retry turn must consult the
// memo the BLOCK turn wrote (never re-probe — this path must stay instant and must never itself
// trigger another block/retry cycle) and, when the memo is FRESH (same diff as the block turn — no
// fix was attempted), voice a NON-BLOCKING systemMessage naming the still-hollow test(s). A stale
// memo (diff changed => a fix WAS attempted) must stay silent, exactly as before this feature existed.
test('agent-hook: RESIDUE SIGNAL — retry turn with an unfixed hollow and an unchanged diff surfaces a non-blocking systemMessage naming it', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r1 = runHookRaw(d, false);                    // block turn: probes, blocks, writes the memo
    assert.equal(r1.status, 0);
    assert.equal(JSON.parse(r1.out.trim()).decision, 'block', 'the block turn must fire and write the memo');
    const r2 = runHookRaw(d, true);                      // retry turn: stop_hook_active true, SAME diff
    assert.equal(r2.status, 0);
    const parsed = JSON.parse(r2.out.trim());
    assert.equal(parsed.decision, undefined, 'the retry turn never blocks — the loop guard still holds');
    assert.match(parsed.systemMessage, /^gutcheck: finishing with 1 still-hollow test\(s\) flagged and not fixed: /,
      'names the count and the still-hollow test(s)');
    assert.match(parsed.systemMessage, /test\/t\.test\.mjs:\d+ 'shadow'/, 'lists file:line \'name\'');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('agent-hook: RESIDUE SIGNAL — a changed diff before the retry turn (a fix was attempted) stays silent (stale-memo guard)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r1 = runHookRaw(d, false);
    assert.equal(JSON.parse(r1.out.trim()).decision, 'block', 'the block turn must fire and write the memo');
    appendFileSync(join(d, 'test/t.test.mjs'), '\n// attempted fix, untracked-stat identity changes\n');
    const r2 = runHookRaw(d, true);
    assert.equal(r2.status, 0);
    assert.equal(r2.out.trim(), '', 'a changed diff must never replay the stale memo\'s accusation');
    assert.equal(r2.err.trim(), '', 'stays silent on stderr too');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('agent-hook: RESIDUE SIGNAL — no memo at all (e.g. the very first hook run is already a retry) stays silent', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r = runHookRaw(d, true);                       // stop_hook_active:true with no prior block turn
    assert.equal(r.status, 0);
    assert.equal(r.out.trim(), '', 'no memo to consult — nothing to voice');
    assert.equal(r.err.trim(), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The failing bucket must reuse the SAME /^baseline /-on-inconclusive-why filter (gated on scored>0)
// the block path uses — a did-not-run (test.skip) row must never surface as "still-hollow" residue.
test('agent-hook: RESIDUE SIGNAL — an already-failing changed test also counts toward the residue message (same filter as the block path)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: MIXED_FAIL });
  try {
    const r1 = runHookRaw(d, false);
    assert.equal(JSON.parse(r1.out.trim()).decision, 'block', 'the block turn must fire on the genuinely failing test');
    const r2 = runHookRaw(d, true);
    assert.equal(r2.status, 0);
    const parsed = JSON.parse(r2.out.trim());
    assert.equal(parsed.decision, undefined);
    assert.match(parsed.systemMessage, /^gutcheck: finishing with 1 still-hollow test\(s\) flagged and not fixed: /);
    assert.match(parsed.systemMessage, /'failing now'/, 'names the still-failing test');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('session-start records the HEAD baseline with NO marker (the gate needs it by default)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW, marker: false });
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

// The global kill switch must disable ALL THREE hooks, not just session-start and check-changed-tests.
// user-prompt-submit previously had no GUTCHECK_HOOK check at all, so the prompt-cue kept firing
// even with the switch set — an asymmetry a docs pass had documented rather than fixed.
test('user-prompt-submit: GUTCHECK_HOOK=off suppresses the prompt-cue entirely (kill switch parity with the other two hooks)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  writeFileSync(join(d, '.gutcheck'), 'prompt-cue\n');  // activation the other prompt-cue tests use
  try {
    const out = runPrompt(d, 'please implement the parser and verify it', { GUTCHECK_HOOK: 'off' });
    assert.equal(out.trim(), '', 'no context injection when the global kill switch is set');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('Stop hook probes work the agent COMMITTED during the session (baseline, not HEAD)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });           // hollow test written, uncommitted
  runSession(d, 'startup');                           // baseline = HEAD before the "agent" works
  git(d, 'add', '-A'); git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agent work'); // agent commits
  const out = runHook(d, false);                      // --since=HEAD would now see nothing
  assert.ok(out && out.decision === 'block', 'committed hollow test must still block');
});

// ---- already-failing changed tests (wild-pilot HEAD-rot finding): the agent-loop surface of the
// baseline-fail signal. Block ONLY when another block SCORED (scored > 0) — a working runner proves the
// failures are the tests' own; an ALL-baselines-failed wipeout usually means the runner can't run them
// (the same all-fail ambiguity formatReport frames as runner suspicion) and must never nag the agent. ----
const MIXED_FAIL = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\ntest('failing now', () => { assert.strictEqual(total([{p:2,q:3}]), 999); });\n`;
const ALL_FAIL = `${H} import { total } from '../src/lib.mjs';\ntest('failing now', () => { assert.strictEqual(total([{p:2,q:3}]), 999); });\n`;

test('agent-hook: a failing changed test blocks when another block scored (runner demonstrably works)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: MIXED_FAIL });
  try {
    const r = runHook(d);
    assert.ok(r && r.decision === 'block', 'blocks on a genuinely failing changed test');
    assert.match(JSON.stringify(r), /already fail/, 'says the test already fails before any mutation');
    assert.match(JSON.stringify(r), /failing now/, 'names the failing test');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('agent-hook: ALL baselines failing (runner-mismatch shape) never blocks', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: ALL_FAIL });
  try {
    assert.equal(runHook(d), null, 'a total wipeout reads as runner trouble, not agent-caused failures — no block');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- did-not-run split (Task 1 — reproduced defect): a test.skip beside a scoring test reads 0
// passed/0 failed at baseline — the runner-idiomatic "this never ran" shape, not a failure. Pre-fix,
// prove()'s single 'baseline' why-vocabulary made no distinction, so this hook's own /^baseline /
// filter (line 83, untouched by this fix) swept the never-ran test into decision:'block', telling
// the agent to "fix the failure" of a test that cannot be fixed because it never executed. The fix
// lands upstream (prove.mjs's why-vocabulary split) — this filter is unmodified proof that the
// consumer inherits correctness for free. runHookRaw (not runHook) so a false block is CAPTURED
// (raw stdout) rather than silently swallowed by a parse step.
const MIXED_SKIP = `${H} import { total } from '../src/lib.mjs';\ntest('sound', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\ntest.skip('not run yet', () => { assert.strictEqual(total([{p:1,q:2}]), 2); });\n`;
test('agent-hook: a test.skip beside a caught test never triggers the already-failing block', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: MIXED_SKIP });
  try {
    const r = runHookRaw(d);
    const out = r.out.trim();
    if (out) {
      const parsed = JSON.parse(out);
      assert.notEqual(parsed.decision, 'block', `a skipped test must never read as already-failing: ${out}`);
    }
    assert.doesNotMatch(out, /already fail before any mutation/, 'no accusation for a test that never ran');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- FIX 1 (82dea50): the clean-path voice. On the common clean run (no hollow, no already-failing) the
// hook used to be totally silent; now, when the agent actually changed probeable functions, it writes a
// NON-BLOCKING one-line coverage denominator as a `{"systemMessage": …}` JSON object on stdout (never a
// `decision` field — Claude Code renders systemMessage without treating it as a block) and leaves stderr
// empty — stderr is a discarded channel. Still exit 0, still never a decision:"block". No changed
// function stays exactly as silent as before.
// runHook() above only captures stdout (parsed JSON or null), so these need both streams separately.
function runHookRaw(d, stopHookActive = false, env = {}) {
  const r = spawnSync('bash', [HOOK], { cwd: d, input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: stopHookActive }), encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}
// SUT + a SOUND test both COMMITTED (a real baseline), then an UNCOMMITTED, behavior-identical edit to
// the SUT (trailing comment only) — a real changed function (hunk-level, --since=HEAD), no hollow, and
// the pre-existing sound test still proves it. The "clean but probeable diff" shape FIX 1 gives a voice to.
function changedFnRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gc-hook-changed-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, '.gutcheck'), '');
  writeFileSync(join(d, 'src/lib.mjs'), SUT.trimEnd() + ' // touched\n'); // uncommitted; same behavior
  return d;
}
// SUT + SOUND test both committed; the only uncommitted change is a doc file — touches no function at all.
function docOnlyRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gc-hook-doc-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, '.gutcheck'), '');
  writeFileSync(join(d, 'docs.txt'), 'unrelated docs-only change\n');
  return d;
}

test('agent-hook: a clean-but-probeable diff voices the coverage denominator as stdout JSON systemMessage', UNIX_ONLY, () => {
  const d = changedFnRepo();
  try {
    const r = runHookRaw(d, false);
    const parsed = JSON.parse(r.out.trim());
    assert.match(parsed.systemMessage, /gutcheck: of \d+ function\(s\) you changed — \d+ proven, \d+ with no binding test/,
      'the coverage denominator must ride a channel Claude Code actually delivers');
    assert.equal(parsed.decision, undefined, 'the clean voice never blocks');
    assert.equal(r.err.trim(), '', 'nothing on stderr — it is a discarded channel');
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Same-diff-oracle provenance + probe-cap-out-of-unverifiable (Task 7): the voice's two new fragments
// ride the memo-sentinel-doctoring technique above (memoized payload swapped for a hand-built
// changeSummary) so all three shapes — neither fragment, provenance only, cap only — are exercised
// without needing a real probe-cap or a real same-diff test fixture. FACT-ONLY wording: states what
// changed alongside what, never a verdict on intent.
test('agent-hook: voice renders same-diff-oracle provenance + probe-cap fragments only when their count is > 0', UNIX_ONLY, () => {
  const d = changedFnRepo();
  try {
    const memoPath = memoPathFor(d);
    const r1 = runHookRaw(d, false);
    assert.equal(r1.status, 0);
    assert.ok(existsSync(memoPath), 'first run must write the memo');
    const [hash] = readFileSync(memoPath, 'utf8').split('\n', 1);
    const voiceRegex = /^gutcheck: of \d+ function\(s\) you changed — \d+ proven( \(\d+ via tests changed in this diff\))?, \d+ with no binding test(, \d+ unverifiable)?(, \d+ not probed \(cap\))?\./;

    // Case A: neither field present (an old-shape changeSummary) — no fragment, old wording untouched.
    const none = JSON.stringify({ scored: 0, hollow: [], inconclusive: [], changeSummary: { files: 1, fns: 3, proven: 1, hollow: 0, unverifiable: 1, untested: 1 } });
    writeFileSync(memoPath, hash + '\n' + none);
    const msgNone = JSON.parse(runHookRaw(d, false).out.trim()).systemMessage;
    assert.match(msgNone, voiceRegex);
    assert.doesNotMatch(msgNone, /via tests changed in this diff/);
    assert.doesNotMatch(msgNone, /not probed \(cap\)/);

    // Case B: sameDiffProven > 0 — the provenance fragment renders right after the proven count.
    const provenanced = JSON.stringify({ scored: 0, hollow: [], inconclusive: [], changeSummary: { files: 1, fns: 3, proven: 2, hollow: 0, unverifiable: 0, untested: 1, sameDiffProven: 2, notProbed: 0 } });
    writeFileSync(memoPath, hash + '\n' + provenanced);
    const msgProven = JSON.parse(runHookRaw(d, false).out.trim()).systemMessage;
    assert.match(msgProven, voiceRegex);
    assert.match(msgProven, /2 proven \(2 via tests changed in this diff\), 1 with no binding test\./);

    // Case C: notProbed > 0 — the cap fragment renders as its own trailing clause.
    const capped = JSON.stringify({ scored: 0, hollow: [], inconclusive: [], changeSummary: { files: 1, fns: 3, proven: 1, hollow: 0, unverifiable: 0, untested: 1, sameDiffProven: 0, notProbed: 1 } });
    writeFileSync(memoPath, hash + '\n' + capped);
    const msgCap = JSON.parse(runHookRaw(d, false).out.trim()).systemMessage;
    assert.match(msgCap, voiceRegex);
    assert.match(msgCap, /1 proven, 1 with no binding test, 1 not probed \(cap\)\./);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('agent-hook: a diff that changes no functions (doc-only) stays fully silent', UNIX_ONLY, () => {
  const d = docOnlyRepo();
  try {
    const r = runHookRaw(d, false);
    assert.equal(r.out.trim(), '', 'empty stdout');
    assert.equal(r.err.trim(), '', 'no stderr voice when the agent changed no probeable function');
    assert.equal(r.status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('agent-hook: a hollow changed test still blocks on stdout (the new clean-path voice does not swallow the block path)', UNIX_ONLY, () => {
  const d = hookRepo({ testCode: HOLLOW });
  try {
    const r = runHookRaw(d, false);
    const parsed = JSON.parse(r.out.trim());
    assert.equal(parsed.decision, 'block', 'the hollow-blocking path is unbroken by the clean-run JSON voice');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- memoization: Stop fires every turn of a long session; an unchanged diff must be served from the
// $GITDIR/gutcheck-memo-<scope> cache instead of re-probing. Derive the memo path the same way the hook
// does (git rev-parse --git-dir, plus the per-cwd hash suffix via memoPathFor), not by hardcoding
// `.git`/`gutcheck-memo`, so this holds under worktrees too and under the scope-keyed filename.
test('agent-hook: memoizes per diff-hash — unchanged diff is served from cache; a new edit invalidates', UNIX_ONLY, () => {
  const d = changedFnRepo();
  try {
    const memoPath = memoPathFor(d);
    const r1 = runHookRaw(d, false);                    // first run: probes, writes the memo
    assert.equal(r1.status, 0);
    assert.ok(existsSync(memoPath), 'first run must write the memo');
    // Doctor the cached JSON payload (keep line 1, the hash) to a sentinel the probe could never produce.
    const [hash] = readFileSync(memoPath, 'utf8').split('\n', 1);
    const sentinel = JSON.stringify({ scored: 0, hollow: [], inconclusive: [], changeSummary: { files: 1, fns: 777, proven: 777, hollow: 0, unverifiable: 0, untested: 0 } });
    writeFileSync(memoPath, hash + '\n' + sentinel);
    const r2 = runHookRaw(d, false);
    assert.match(JSON.parse(r2.out.trim()).systemMessage, /of 777 function\(s\)/,
      'second run with an identical diff must be served from the memo (sentinel visible = no re-probe)');
    // Any new edit changes the diff-hash → re-probe, sentinel gone.
    appendFileSync(join(d, 'src/lib.mjs'), '\n// touch\n');
    const r3 = runHookRaw(d, false);
    assert.doesNotMatch(r3.out.trim(), /777/, 'a changed diff must invalidate the memo');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The memo key must also carry UNTRACKED-file identity — `git diff <baseline>` never sees an
// untracked file, so the key leans on the stat fallback chain (GNU `stat -c` first: on Linux
// `stat -f` is FILESYSTEM mode and can exit 0 printing fs junk for a file operand, starving the
// fallback and silently dropping the size/mtime signal; on macOS/BSD `stat -c` is an illegal
// option → non-zero, empty stdout → falls through). On ubuntu CI this test fails if the Linux
// stat path ever loses the untracked signal; on macOS it exercises the BSD fallback leg.
test('agent-hook: memo invalidates when an UNTRACKED test file is edited (stat identity in the key)', UNIX_ONLY, () => {
  const d = changedFnRepo();
  try {
    // Untracked BEFORE the first run, so its (path, size, mtime) identity is baked into the key.
    const untracked = join(d, 'test/extra.test.mjs');
    writeFileSync(untracked, SOUND);
    const memoPath = memoPathFor(d);
    const r1 = runHookRaw(d, false);                    // first run: probes, writes the memo
    assert.equal(r1.status, 0);
    assert.ok(existsSync(memoPath), 'first run must write the memo');
    // Doctor the cached JSON payload (keep line 1, the hash) to a sentinel the probe could never produce.
    const [hash] = readFileSync(memoPath, 'utf8').split('\n', 1);
    const sentinel = JSON.stringify({ scored: 0, hollow: [], inconclusive: [], changeSummary: { files: 1, fns: 777, proven: 777, hollow: 0, unverifiable: 0, untested: 0 } });
    writeFileSync(memoPath, hash + '\n' + sentinel);
    const r2 = runHookRaw(d, false);
    assert.match(JSON.parse(r2.out.trim()).systemMessage, /of 777 function\(s\)/,
      'untracked file unchanged — identical key must be served from the memo (sentinel visible)');
    // Edit the untracked file so its SIZE changes (mtime alone can land in the same second) —
    // the tracked diff is untouched, so ONLY the stat identity can invalidate the key.
    appendFileSync(untracked, '\n// edited untracked test\n');
    const r3 = runHookRaw(d, false);
    assert.doesNotMatch(r3.out.trim(), /777/, 'an untracked-file edit must invalidate the memo (miss → re-probe)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// One repo, two working directories (e.g. two Claude sessions in different packages of a monorepo):
// $GITDIR is shared, so a fixed `gutcheck-memo` filename means the second run's write clobbers the
// first's cache file outright — not just a diff-hash miss, but the SAME FILE. Each cwd needs its own
// probeable diff so each run actually writes a memo (a no-op run never touches the file).
function twoScopeRepo() {
  const d = mkdtempSync(join(tmpdir(), 'gc-hook-scope-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true }); writeFileSync(join(d, 'src/lib.mjs'), SUT);
  mkdirSync(join(d, 'test'), { recursive: true }); writeFileSync(join(d, 'test/t.test.mjs'), SOUND);
  mkdirSync(join(d, 'packages/a/src'), { recursive: true }); writeFileSync(join(d, 'packages/a/src/lib.mjs'), SUT);
  writeFileSync(join(d, 'packages/a/package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'packages/a/test'), { recursive: true }); writeFileSync(join(d, 'packages/a/test/t.test.mjs'), SOUND);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  writeFileSync(join(d, '.gutcheck'), '');
  // Uncommitted, behavior-identical edits — a real probeable diff reachable from EACH scope.
  writeFileSync(join(d, 'src/lib.mjs'), SUT.trimEnd() + ' // touched-root\n');
  writeFileSync(join(d, 'packages/a/src/lib.mjs'), SUT.trimEnd() + ' // touched-a\n');
  return d;
}

test("agent-hook: two working dirs in one repo do not clobber each other's memo", UNIX_ONLY, () => {
  const d = twoScopeRepo();
  try {
    const gitDir = gitDirOf(d);
    const r1 = runHookRaw(d, false);                        // session 1: probes from the repo root
    const r2 = runHookRaw(join(d, 'packages/a'), false);     // session 2: probes from a nested package
    assert.equal(r1.status, 0); assert.equal(r2.status, 0);
    const memos = readdirSync(gitDir).filter((f) => f.startsWith('gutcheck-memo'));
    assert.equal(memos.length, 2, `expected two distinct per-scope memo files, found: ${memos.join(', ') || '(none)'}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
