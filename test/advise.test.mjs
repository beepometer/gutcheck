// advise() is the diff-scoped, non-blocking checker line at an agent's done-claim. It never blocks and
// never mints a verdict — it only tells the agent what the deterministic checker sees in the test files
// THIS diff changed. These tests exist because that scoping (changed-only, not whole-repo) and the
// fail-closed/fail-open split (a broken meta-guard says so; any other throw is silent) are both easy to
// get backwards, and a wrong default in either direction either spams unrelated findings or goes quiet
// exactly when it should speak up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advise, changedPathsSince, ADVISE_KINDS } from '../mutation/advise.mjs';

const git = (d, ...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });

// advise() is STATIC — it never runs the project's tests — so these fixtures use jest-dialect matcher
// text that the checker's JS defaults understand without needing a runner that can execute it. The
// through-the-gate cases (test/gate-advisory.test.mjs) use the node:assert dialect instead, because
// there the fixture's tests really do get run.
//
// The import path is written WITHOUT a '.js' extension deliberately: magicLiteralGuard's
// messageDerivationSrc exemption (checker/kinds/magicLiteralGuard.mjs) reads a quoted string's dots as
// decimal points and slashes as division operators, so `'../src/lib.js'` sitting inside the 5-line
// window above an assertion reads as an embedded arithmetic derivation and wrongly exempts a real magic
// literal below it. These fixtures never execute (advise() only reads), so the extension is inert text
// either way — dropping it sidesteps the false exemption without touching production code.
// SHADOW-OK: SHADOW below is deliberately shaped like a shadow oracle — it is fixture text written
// into a temp repo (see repo() below) so the checker can catch it for real; it is not itself a live
// assertion in this suite.
const SHADOW = [
  "import { total } from '../src/lib';",
  'function recompute(){ return 1 * 2; }',
  "test('t', () => { expect(total()).toBe(recompute()); });",
  '',
].join('\n');
const GOLDEN = [
  "import { total } from '../src/lib';",
  "test('t', () => { expect(total()).toBe(78.539816); });",
  '',
].join('\n');
const CLEAN = [
  "import { total } from '../src/lib';",
  "test('t', () => { expect(total()).toBe(2); });",
  '',
].join('\n');

// A repo whose committed state is CLEAN and whose uncommitted change is `changed`.
function repo(changed, { committed = { 'test/base.test.js': CLEAN } } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'gc-advise-'));
  writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module"}');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/lib.js'), 'export function total(){ return 2; }\n');
  mkdirSync(join(d, 'test'), { recursive: true });
  for (const [rel, body] of Object.entries(committed)) writeFileSync(join(d, rel), body);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
  for (const [rel, body] of Object.entries(changed)) writeFileSync(join(d, rel), body);
  return d;
}

test('advise: the payload is the four earned kinds plus the two on the runway', () => {
  assert.deepEqual([...ADVISE_KINDS].sort(), [
    'assertionConsistency', 'derivationCoherence', 'fallbackCollapse',
    'magicLiteralGuard', 'shadowOracleGuard', 'testShapeGuard',
  ]);
  // Measured CYCLE-10 and deliberately not promoted (checker/kinds/index.mjs:11) — never on this line.
  assert.ok(!ADVISE_KINDS.has('selfComparisonOracle'));
  // High-recall by its own header; the probe is its decisive gate.
  assert.ok(!ADVISE_KINDS.has('weakOracleGuard'));
  assert.ok(!ADVISE_KINDS.has('assertionFreeTest'));
});

test('advise: reports findings in a test file the diff changed', () => {
  const d = repo({ 'test/new.test.js': SHADOW });
  try {
    const out = advise(d, 'HEAD');
    assert.ok(out, 'a changed test file with a shadow oracle must produce an advisory');
    assert.match(out, /^gutcheck lint: 1 finding\(s\)/);
    assert.match(out, /test\/new\.test\.js:3/, 'names the assertion line');
    assert.match(out, /js-shadow-oracle-guard/, 'names the check that fired');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: reports the uncited golden float — magicLiteralGuard on the runway', () => {
  const d = repo({ 'test/new.test.js': GOLDEN });
  try {
    const out = advise(d, 'HEAD');
    assert.ok(out);
    assert.match(out, /magic-literal-guard/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: is diff-scoped — a finding in an UNCHANGED test file is not reported', () => {
  // The offending file is COMMITTED; the only uncommitted change is a clean file.
  const d = repo({ 'test/new.test.js': CLEAN }, { committed: { 'test/old.test.js': SHADOW } });
  try {
    assert.equal(advise(d, 'HEAD'), null,
      'an unchanged file\'s finding must not surface at the done-claim');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: silent when the diff changed no test file', () => {
  const d = repo({ 'src/lib.js': 'export function total(){ return 3; }\n' });
  try {
    assert.equal(advise(d, 'HEAD'), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: silent on a clean changed test file', () => {
  const d = repo({ 'test/new.test.js': CLEAN });
  try {
    assert.equal(advise(d, 'HEAD'), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: caps the rendered list at three and counts the rest', () => {
  // The call argument varies per line (total([1]), total([2]), ...) so the four calls are textually
  // distinct. assertionConsistency (checker/kinds/assertionConsistency.mjs:29) strips comments but not
  // string contents, and flags the same pure call asserted to two different literals in one file — with
  // an identical call on every line this fixture would trip that rule on its own text, even though the
  // lines are inert strings inside this test file, not code the checker is meant to be scanning.
  // Varying the argument keeps the four calls distinct while each decimal is still long enough (3+
  // fractional digits) to trip magicLiteralGuard, which is what this test needs four of. Extensionless
  // import for the same reason as SHADOW/GOLDEN/CLEAN above (messageDerivationSrc false exemption).
  const many = [
    "import { total } from '../src/lib';",
    "test('a', () => { expect(total([1])).toBe(78.539816); });",
    "test('b', () => { expect(total([2])).toBe(12.345678); });",
    "test('c', () => { expect(total([3])).toBe(99.123456); });",
    "test('d', () => { expect(total([4])).toBe(11.222333); });",
    '',
  ].join('\n');
  const d = repo({ 'test/new.test.js': many });
  try {
    const out = advise(d, 'HEAD');
    assert.match(out, /^gutcheck lint: 4 finding\(s\)/, 'the count is the TOTAL, not the shown');
    assert.match(out, /\+1 more$/, 'and the unshown remainder is stated, never silently dropped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: a broken self-check says so instead of going quiet', () => {
  const d = repo({ 'test/new.test.js': SHADOW });
  try {
    // Sabotage the meta-guard through the config the module builds: a check whose must-flag fixture its
    // own detector cannot flag. Injected via the sabotageMetaGuard test seam, honored only in this test path.
    const out = advise(d, 'HEAD', { sabotageMetaGuard: true });
    assert.match(out, /self-check FAILED/);
    assert.match(out, /advisory suppressed/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: changedPathsSince includes tracked edits and untracked files, deduped', () => {
  const d = repo({ 'test/new.test.js': CLEAN, 'src/lib.js': 'export function total(){ return 3; }\n' });
  try {
    const got = changedPathsSince(d, 'HEAD').sort();
    assert.deepEqual(got, ['src/lib.js', 'test/new.test.js']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('advise: a non-repo directory is silent, not a throw', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-advise-norepo-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module"}');
    assert.equal(advise(d, 'HEAD'), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
