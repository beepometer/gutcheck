import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prove, formatReport, eligibleFns, topLevelCallees, parseRun, nodeEffectiveCounts, parseBlocks, detectRunner, changedFilesSince, importMap, testCmdFor, RUNNERS, ambiguousNames, qualifiedName, residualAmbiguous, canonKey, toPosix, isTestPath, resolveRunnerBin, fallbackCmdFor, javaExe, gradleTaskInfo } from '../mutation/prove.mjs';

const FIX = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/runner-output', n), 'utf8');
const PROVE_CLI = resolve('mutation/prove.mjs'); // mirrors how the "PROVE CLI --json" test below locates the CLI
// mirrors prove.mjs's internal reEsc (not exported) — used only to build the expected mocha --grep arg.
const reEscForTest = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function project(files) {
  const d = mkdtempSync(join(tmpdir(), 'gc-prove-'));
  for (const [r, b] of Object.entries(files)) { const f = join(d, r); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, b); }
  return d;
}
// gated e2e fixtures need the runner package ITSELF resolvable from inside the fixture: mocha's
// describe()/it() are CLI-injected globals so it never needs this, but ava/vitest test files `import`
// their own package, and jest's worker pool needs a real local install to reliably pipe output back.
// Without this, `npx <runner>` (no --no-install in testCmdFor) silently falls back to fetching whatever
// is CURRENTLY LATEST off the registry (verified: mocha 11.7.6 / ava 8.0.1 — NOT our pinned devDependency
// majors) — slow, network-dependent, and not actually proving the version we ship against. Symlinking the
// repo's own node_modules into the fixture makes prove()'s own internal work-dir symlink
// (`work/node_modules -> dir/node_modules`) resolve our PINNED local install deterministically and offline.
function projectWithRunner(files) {
  const d = project(files);
  symlinkSync(resolve('node_modules'), join(d, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return d;
}

// REPO_ROOT has real vitest/jest/mocha/ava devDependencies installed (used both for the HAS_* gates
// below and the testCmdFor/resolveRunnerBin tests further down).
const REPO_ROOT = resolve('.');
const HAS_PY = (() => { try { execSync('python3 --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
// gated e2e runner availability: resolveRunnerBin walks node_modules for the package's own bin entry —
// the same resolution testCmdFor uses to spawn it — so the gate is a pure probe (no install attempt,
// no npx spawn) and works identically on every platform, including win32 where `npx` itself is
// unspawnable (see the root-cause comment on resolveRunnerBin above).
const HAS_MOCHA = resolveRunnerBin('mocha', REPO_ROOT) !== null;
const HAS_AVA = resolveRunnerBin('ava', REPO_ROOT) !== null;
const HAS_VITEST = resolveRunnerBin('vitest', REPO_ROOT) !== null;
const HAS_JEST = resolveRunnerBin('jest', REPO_ROOT) !== null;
// node's `--test-name-pattern` full-name (describe-path + title, joined) matching is a v22+ capability —
// measured on v20.20.2 vs v22.22.2 (node20-qualification branch): the identical qualifiedName()-built
// anchored pattern selects exactly 1 of 2 same-titled nested tests on v22, but 0 on v20 (both blocks
// report `# SKIP test name does not match pattern` — 0 pass/0 fail), because v20's matcher only ever
// compares a node's own single-level name, never a joined ancestor+own string (see the NODE VERSION
// CAVEAT comment on qualifiedName() in mutation/prove.mjs for the full evidence and why no sound
// alternative composition exists on v20). prove() still fails closed there (never a wrong verdict) — it
// just can't recover the collision, so the two node e2es below gate their expected shape on this.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

// ---- unit: the assertion-strength gate ----
test('eligibleFns: value-pinning assertions make the consumed fn eligible', () => {
  assert.deepEqual(eligibleFns('assert.strictEqual(add(2,3), 5);', ['add']), ['add']);
  assert.deepEqual(eligibleFns('expect(score(a,b)).toBe(1);', ['score']), ['score']);
});
test('eligibleFns: a one-variable hop is followed', () => {
  assert.deepEqual(eligibleFns('const s = score(a, b);\nexpect(s).toBeCloseTo(1.0, 2);', ['score']), ['score']);
});
test('topLevelCallees: only the value-producing outer call, not nested argument calls', () => {
  assert.deepEqual(topLevelCallees("run(['--config', join(ROOT, 'x')])"), ['run']);
  assert.deepEqual(topLevelCallees('compute(5)'), ['compute']);
  assert.deepEqual(topLevelCallees('wrap(a) + tag(b)'), ['wrap', 'tag']); // two top-level calls both count
});
test('eligibleFns: a nested incidental call in the hop RHS is NOT attributed', () => {
  // r is pinned via r.status; the RHS calls run(...) and incidental join(...). Only run is eligible.
  const body = "const r = run(['--config', join(ROOT,'x')]);\nassert.strictEqual(r.status, 2);";
  assert.deepEqual(eligibleFns(body, ['run', 'join']).sort(), ['run']);
});
// PRECISION (pre-existing bug, owner-authorised fix): the var-hop's `= <ws>` must not swallow a NEWLINE — a
// pinned var with a string/blank RHS (`let g = "hi"`, masks to whitespace) would otherwise absorb the NEXT
// statement's callee and credit it → gutting that unrelated fn while g is set independently → false HOLLOW.
test('eligibleFns: the var-hop stays same-line — a string-RHS var never absorbs the next line’s callee', () => {
  assert.deepEqual(eligibleFns('let g = "hi"\nconst svc = makeSvc(config())\nexpect(g).toBe("hi")', ['makeSvc']), []);
});
// PRECISION (pre-existing bug): a callee EMBEDDED in a short-circuit / conditional RHS may be on a dead
// branch — `provided || defaultPort()` with provided truthy never calls defaultPort; gutting it leaves a
// SOUND test green → false HOLLOW. The var-hop fails closed on a top-level `||`/`&&`/`??`/ternary. A
// non-short-circuit binary (`+`) still credits BOTH callees (both always evaluate — reach preserved).
test('eligibleFns: the var-hop fails closed on a short-circuit RHS but keeps a `+` binary (dead-branch guard)', () => {
  assert.deepEqual(eligibleFns('const port = provided || defaultPort()\nexpect(port).toBe(3000)', ['defaultPort']), []);
  assert.deepEqual(eligibleFns('const r = cond ? compute(x) : fallback\nexpect(r).toBe(v)', ['compute']), []);
  assert.deepEqual(eligibleFns('const r = a() ?? b()\nexpect(r).toBe(v)', ['a', 'b']), []);
  assert.deepEqual(eligibleFns('const r = wrap(a) + tag(b)\nexpect(r).toBe(v)', ['wrap', 'tag']).sort(), ['tag', 'wrap']);
});
// PRECISION (pre-existing bug, owner-authorised fix): the var-hop required `=` IMMEDIATELY after the
// captured name, so a TS type annotation (`const result: number = add(2, 3)`, idiomatic TS) broke the hop
// entirely — unannotated credited, annotated didn't. An optional `: TYPE` between the name and `=` closes
// this without widening reach: a plain `const x: number = 5` with no call still credits nothing.
test('eligibleFns: the var-hop reaches a TYPE-ANNOTATED declaration (TS)', () => {
  assert.deepEqual(eligibleFns('const result: number = add(2,3);\nassert.strictEqual(result, 5);', ['add']), ['add']);
});
test('eligibleFns: a type-annotated declaration with NO call on the RHS still credits nothing', () => {
  assert.deepEqual(eligibleFns('const x: number = 5;\nassert.strictEqual(x, 5);', ['add']), []);
});
// CRITICAL (reviewer finding, owner-authorised fix): a COMPOSITE type annotation containing a function-type
// member (`(x: number) => number`) broke the var-hop's annotation-skip group in the OTHER direction — the
// old group (`[^=\n]+?`) is a lazy non-`=` scan, and `=>` itself CONTAINS a bare `=` character, so the scan
// stopped mid-type, right after the arrow's `=`. The REST of the type then spilled into what the hop treats
// as the RHS — and if that leftover text happens to look like a call (`compute(): number`), the fn gets
// FALSE credit despite never being called anywhere. RED at e218c27: this returns ['compute'] (compute is
// never called — only `f.cb(1)` is, and `cb`'s value is `identity`, never invoked either).
test('eligibleFns: a composite type annotation with a function-type member does NOT leak method-signature text into the RHS scan (false-credit regression)', () => {
  const body = "const f: { cb: (x: number) => number, compute(): number } = { cb: identity };\nassert.strictEqual(f.cb(1), 1);";
  assert.deepEqual(eligibleFns(body, ['compute', 'identity']), []);
});
// Adversarial probe: a generic-typed annotation with no `=>` at all (`Array<typeof add>`) never exercised
// the old bug (no `=>`'s embedded `=` to false-stop on) — must stay refused before and after the fix.
test('eligibleFns: a generic-typed declaration (`Array<typeof add>`) with no call on the RHS still credits nothing', () => {
  assert.deepEqual(eligibleFns('const r: Array<typeof add> = []\nassert.strictEqual(r.length, 0);', ['add']), []);
});
// Adversarial probe: a SIMPLE function-type annotation (single `=>`, no composite braces) whose value
// genuinely DOES call the pinned fn — the arrow-aware fix must still correctly land on the real assignment
// `=` (not the type's `=>`) and credit `add`, which is actually invoked inside the arrow body.
test('eligibleFns: a simple function-type annotation (`(x: number) => number`) still credits a fn genuinely called in the value', () => {
  const body = 'const f: (x: number) => number = (x) => add(x, 1);\nassert.strictEqual(f(1), 2);';
  assert.deepEqual(eligibleFns(body, ['add']), ['add']);
});
// Perf sanity: the arrow-aware alternation must stay linear, not blow up on a large composite annotation
// (reviewer measured 43ms pre-fix on a 200k-char annotation; this must stay comfortably under 2s post-fix).
test('eligibleFns: a 200k-char composite annotation stays fast (no catastrophic backtracking)', () => {
  const bigType = '{ cb: (x: number) => number, '.repeat(7000) + 'z: number }'; // ~200k chars
  const body = `const f: ${bigType} = { z: 1 };\nassert.strictEqual(f.z, 1);`;
  const t0 = Date.now();
  const out = eligibleFns(body, ['add']);
  const elapsed = Date.now() - t0;
  assert.deepEqual(out, []);
  assert.ok(elapsed < 2000, `expected < 2000ms, got ${elapsed}ms`);
});
test('eligibleFns: weak assertions do NOT make a fn eligible (the navGraph FP class)', () => {
  assert.deepEqual(eligibleFns('expect(getNode(e.from)).toBeDefined();', ['getNode']), []);
  assert.deepEqual(eligibleFns('assert.ok(total(items) !== null);', ['total']), []);
  assert.deepEqual(eligibleFns('expect(a).not.toBe(b);\nexpect(getNode(x)).toBeTruthy();', ['getNode']), []);
});
test('eligibleFns: widened value-pin matchers make the consumed fn eligible', () => {
  assert.deepEqual(eligibleFns("expect(() => parse('x')).toThrow();", ['parse']), ['parse']);
  assert.deepEqual(eligibleFns("expect(tags(x)).toContain('a');", ['tags']), ['tags']);
  assert.deepEqual(eligibleFns('expect(build(1)).toMatchObject({id:1});', ['build']), ['build']);
  assert.deepEqual(eligibleFns('expect(list(x)).toHaveLength(3);', ['list']), ['list']);
  assert.deepEqual(eligibleFns('expect(slug(x)).to.equal("a-b");', ['slug']), ['slug']); // chai
});
test('eligibleFns: genuinely weak matchers still do NOT make a fn eligible', () => {
  assert.deepEqual(eligibleFns('expect(getNode(x)).toBeDefined();', ['getNode']), []);
  assert.deepEqual(eligibleFns('expect(getNode(x)).toBeTruthy();', ['getNode']), []);
});
test('eligibleFns: chai matchers that PASS against the numeric sentinel are NOT eligible (no false HOLLOW)', () => {
  assert.deepEqual(eligibleFns('expect(slug(x)).to.match(/^[a-z0-9-]+$/);', ['slug']), []);   // chai coerces → passes sentinel
  assert.deepEqual(eligibleFns("expect(num(x)).to.have.a('number');", ['num']), []);          // type-assertion passes for a number
  assert.deepEqual(eligibleFns("expect(num(x)).to.have.an('number');", ['num']), []);
});
test('eligibleFns: sound chai have-subforms remain eligible', () => {
  assert.deepEqual(eligibleFns('expect(list(x)).to.have.lengthOf(3);', ['list']), ['list']);
  assert.deepEqual(eligibleFns("expect(obj(x)).to.have.keys('a', 'b');", ['obj']), ['obj']);
});
// PRECISION (pre-existing bug, owner-authorised fix): chai's fluent no-op language chain (be/been/is/
// that/which/and/has/deep/same/an/a) may sit between `to`/`should` and the terminal matcher — idiomatic
// chai (`.to.be.equal(5)`, `.to.be.deep.equal(5)`) credited NOTHING while the equivalent `.to.equal(5)`
// did. `have` is deliberately excluded from the chain-word list (only `has` is), so the have-subform
// exclusion below is unaffected — `.to.have.property(...)` must still stay uncredited.
test('eligibleFns: chai language chains before a sound matcher still credit (.to.be.equal / .to.be.deep.equal)', () => {
  assert.deepEqual(eligibleFns('expect(add(2,3)).to.be.equal(5);', ['add']), ['add']);
  assert.deepEqual(eligibleFns('expect(add(2,3)).to.be.deep.equal(5);', ['add']), ['add']);
});
test('eligibleFns: chai language chains do NOT reopen the have.property exclusion', () => {
  assert.deepEqual(eligibleFns("expect(add(2,3)).to.be.have.property('toString');", ['add']), []);
});
// ---- unit: .resolves/.rejects pin vocabulary (Task A) — a .resolves/.rejects prefix before a sound
// VALUE_PIN matcher must credit the consumed fn: the existing gross-break mutant makes the async SUT
// resolve to (or throw/reject with) the numeric sentinel, so a sound `.resolves.toEqual(v)` /
// `.rejects.toThrow()` provably fails against it — same soundness discipline as the sync path.
test('eligibleFns: .resolves/.rejects prefix before a sound matcher credits the consumed fn', () => {
  assert.deepEqual(eligibleFns('await expect(decode(x)).resolves.toEqual({a:1});', ['decode']), ['decode']);
  assert.deepEqual(eligibleFns('await expect(parse(bad)).rejects.toThrow();', ['parse']), ['parse']);
  assert.deepEqual(eligibleFns('const p = fetchIt(u);\nawait expect(p).resolves.toBe(3);', ['fetchIt']), ['fetchIt']); // via existing var-hop
});
// Adversarial: weak/bare/negated forms after .resolves/.rejects must stay UNeligible — same discipline
// as the sync path (a weak matcher passes against the sentinel; .not. inverts the sound comparison).
test('eligibleFns: .resolves/.rejects — weak, bare, and negated forms do NOT credit (no false HOLLOW)', () => {
  assert.deepEqual(eligibleFns('await expect(decode(x)).resolves.toBeDefined();', ['decode']), []);   // weak
  assert.deepEqual(eligibleFns('await expect(decode(x)).resolves.toBeTruthy();', ['decode']), []);    // weak
  assert.deepEqual(eligibleFns('await expect(decode(x)).rejects;', ['decode']), []);                  // no matcher
  assert.deepEqual(eligibleFns('await expect(decode(x)).resolves.not.toEqual(v);', ['decode']), []);  // negated
});
test('eligibleFns: bare-path property existence is NOT eligible (autoboxing passes the numeric sentinel)', () => {
  assert.deepEqual(eligibleFns("expect(t(x)).toHaveProperty('toString');", ['t']), []);
  assert.deepEqual(eligibleFns("expect(t(x)).to.have.property('constructor');", ['t']), []);
});
test('eligibleFns: import-aware aliased assert member form (t.strictEqual)', () => {
  const body = "var t = require('assert');\nt.strictEqual(add(2,3), 5);";
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['t', 'assert']])), ['add']);
});
test('eligibleFns: import-aware destructured assert (bare strictEqual)', () => {
  const body = "const { strictEqual } = require('node:assert');\nstrictEqual(add(2,3), 5);";
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['strictEqual', 'node:assert']])), ['add']);
});
test('eligibleFns: an aliased assert bound to a NON-assert module is NOT recognized', () => {
  const body = "const t = require('lodash');\nt.equal(add(2,3), 5);"; // lodash, not assert
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['t', 'lodash']])), []);
});
test('eligibleFns: hybrid fallback pins X.strictEqual(a,b) when X is an undetectable alias', () => {
  const body = "t.strictEqual(add(2,3), 5);"; // t not in imports at all
  assert.deepEqual(eligibleFns(body, ['add'], new Map()), ['add']);
});
test('eligibleFns: fallback does NOT fire for a 1-arg method (chai .to.equal / set.equal)', () => {
  // chai: expect(...).to.equal(y) already handled by expect-path; the bare `to.equal(y)` is 1-arg → not an assert pin
  assert.deepEqual(eligibleFns("const s = other(); s.equal(add(1,2));", ['add'], new Map()), []); // 1 arg
});
test('eligibleFns: fallback does NOT fire when X is bound to a non-assert module', () => {
  const body = "const t = require('lodash');\nt.equal(add(2,3), 5);";
  assert.deepEqual(eligibleFns(body, ['add'], new Map([['t', 'lodash']])), []);
});
test('eligibleFns: fallback does not mis-pin jest toStrictEqual', () => {
  // expect(add(2,3)).toStrictEqual(5) IS already eligible via the expect/VALUE_PIN path — assert add still eligible,
  // but NOT via the assert fallback (toStrictEqual is not `.strictEqual` right after a dot).
  assert.deepEqual(eligibleFns("expect(add(2,3)).toStrictEqual(5);", ['add'], new Map()), ['add']);
});

// ---- unit: strings/comments are masked before the pin gate scans (no false HOLLOW from a code sample) ----
test('eligibleFns: an assertion inside a string literal does not pin (masking)', () => {
  const body = 'const code = "assert.equal(foo(2), 5)";\nassert.strictEqual(bar(1), 2);';
  assert.deepEqual(eligibleFns(body, ['foo', 'bar']).sort(), ['bar']); // foo referenced only in a string → NOT eligible
});
test('eligibleFns: the assert-fallback does not fire inside a string (masking)', () => {
  const body = 'const sample = "obj.equal(foo(2), bar)";\nassert.strictEqual(baz(1), 2);';
  assert.deepEqual(eligibleFns(body, ['foo', 'baz']).sort(), ['baz']);
});
test('eligibleFns: a commented-out assertion does not pin (masking)', () => {
  const body = '// assert.strictEqual(foo(2), 5)\nassert.strictEqual(bar(1), 2);';
  assert.deepEqual(eligibleFns(body, ['foo', 'bar']).sort(), ['bar']);
});
test('eligibleFns: a real assertion with a STRING expected value still pins (masking preserves real code)', () => {
  assert.deepEqual(eligibleFns('expect(slug(x)).to.equal("a-b");', ['slug']), ['slug']);
});

// ---- unit: standalone chai `should` chains (no `expect(...)` wrapper) ----
test('eligibleFns: chai should — direct call receiver', () => {
  assert.deepEqual(eligibleFns("add(2,3).should.equal(5);", ['add']), ['add']);
});
test('eligibleFns: chai should — via a one-variable hop', () => {
  assert.deepEqual(eligibleFns("const r = add(2,3);\nr.should.equal(5);", ['add']), ['add']);
});
test('eligibleFns: chai should — sound have-form (lengthOf)', () => {
  assert.deepEqual(eligibleFns("list(x).should.have.lengthOf(3);", ['list']), ['list']);
});
test('eligibleFns: chai should — UNSOUND forms are NOT eligible', () => {
  assert.deepEqual(eligibleFns("thing(x).should.have.property('id');", ['thing']), []);   // property autoboxes
  assert.deepEqual(eligibleFns("slug(x).should.match(/^[a-z]+$/);", ['slug']), []);        // match string-coerces
  assert.deepEqual(eligibleFns("flag(x).should.be.true;", ['flag']), []);                  // .be.* excluded
});

// ---- unit: import-aware SUT binding parses a test file's import bindings ----
test('importMap: relative, bare, builtin, default, namespace specifiers', () => {
  const code = `import { join } from 'node:path';
import { add, sub as minus } from '../src/math.mjs';
import flatten from 'lodash/flatten';
import * as utils from './utils.js';`;
  const m = importMap(code);
  assert.equal(m.get('join'), 'node:path');      // builtin
  assert.equal(m.get('add'), '../src/math.mjs'); // relative
  assert.equal(m.get('minus'), '../src/math.mjs'); // aliased
  assert.equal(m.get('flatten'), 'lodash/flatten'); // bare dep
  assert.equal(m.get('utils'), './utils.js');    // namespace
});

// ---- unit: result parsing never trusts the exit code ----
test('parseRun reads passed/failed from the runner summary', () => {
  assert.deepEqual(parseRun('vitest', ' Tests  1 passed | 14 skipped (15)'), { passed: 1, failed: 0 });
  assert.deepEqual(parseRun('vitest', ' Tests  2 failed | 13 passed (15)'), { passed: 13, failed: 2 });
  assert.deepEqual(parseRun('node', '# pass 5\n# fail 0\n'), { passed: 5, failed: 0 });
});
test('parseRun reads mocha TAP summary from a recorded fixture', () => {
  assert.deepEqual(parseRun('mocha', FIX('mocha-2pass-1fail.txt')), { passed: 2, failed: 1 });
});
test('parseRun reads ava TAP summary from a recorded fixture', () => {
  assert.deepEqual(parseRun('ava', FIX('ava-2pass-1fail.txt')), { passed: 2, failed: 1 });
});
// ---- unit: node's file-wrapper false-green is discounted at the runtime layer, not parseRun ----
// Oracle is the TAP stream itself, not the tool's own prior output: the zero-match fixture's plan
// line `1..0` (recorded before any test ran) proves node scheduled zero subtests, so its single
// `# pass 1` MUST be the file-wrapper point, never a real test — independent of what parseRun or
// nodeEffectiveCounts currently return.
test('parseRun alone is fooled by a node zero-match run (pins WHY the runtime helper is needed)', () => {
  const zeroOut = FIX('node-zero-match.txt');
  assert.ok(/^1\.\.0$/m.test(zeroOut), 'fixture must carry the TAP zero-subtests plan line');
  assert.deepEqual(parseRun('node', zeroOut), { passed: 1, failed: 0 },
    'parseRun reads the file-wrapper pass point as a real pass — this is the bug nodeEffectiveCounts must correct');
});
test('nodeEffectiveCounts discounts a node run whose only green is the file wrapper', () => {
  const zeroOut = FIX('node-zero-match.txt');
  const raw = parseRun('node', zeroOut);
  assert.deepEqual(nodeEffectiveCounts(raw, zeroOut, 'f.test.mjs'), { passed: 0, failed: 0 },
    'zero subtests scheduled (TAP `1..0`) — the wrapper-only pass must be discounted to 0p/0f');
});
test('nodeEffectiveCounts discounts a windows-shaped zero-match run (wrapper named by a path form the name-match cannot know)', () => {
  // Windows CI ground truth (run 29116683747): the wrapper subtest's printed name did NOT match either
  // rel-path form, so the name-based discount missed and a describe.skip fixture was minted HOLLOW.
  // The oracle is the TAP plan line — `1..0` at column 0 (zero subtests scheduled) is emitted before
  // the wrapper point on every zero-match run (see node-zero-match.txt) and is path-spelling-agnostic.
  // This synthetic output reproduces the windows shape: absolute backslash wrapper name + CRLF endings.
  const winOut = [
    'TAP version 13', '1..0', '# Subtest: D:\\a\\work\\test\\dead.test.mjs',
    'ok 1 - D:\\a\\work\\test\\dead.test.mjs', '  ---', '  duration_ms: 55.6', '  ...',
    '1..1', '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0',
  ].join('\r\n');
  assert.deepEqual(parseRun('node', winOut), { passed: 1, failed: 0 }, 'parseRun is fooled, as on posix');
  assert.deepEqual(nodeEffectiveCounts(parseRun('node', winOut), winOut, 'test/dead.test.mjs'), { passed: 0, failed: 0 },
    'the TAP 1..0 plan must discount the wrapper regardless of how the platform spells its path');
});
test('nodeEffectiveCounts does not over-coerce a real single-test pass', () => {
  const oneOut = FIX('node-one-match.txt');
  const raw = parseRun('node', oneOut);
  assert.deepEqual(raw, { passed: 1, failed: 0 });
  assert.deepEqual(nodeEffectiveCounts(raw, oneOut, 'f.test.mjs'), { passed: 1, failed: 0 },
    'a genuinely matched test must not be discounted');
});
test('detectRunner recognizes mocha and ava from deps, jest/vitest still take precedence', () => {
  const m = project({ 'package.json': '{"devDependencies":{"mocha":"^10"}}' });
  const a = project({ 'package.json': '{"devDependencies":{"ava":"^6"}}' });
  const j = project({ 'package.json': '{"devDependencies":{"jest":"^29","mocha":"^10"}}' });
  try {
    assert.equal(detectRunner(m), 'mocha');
    assert.equal(detectRunner(a), 'ava');
    assert.equal(detectRunner(j), 'jest', 'jest wins over mocha when both present');
  } finally { for (const d of [m, a, j]) rmSync(d, { recursive: true, force: true }); }
});
// ---- detectRunner: gradle + RUNNERS + javaExe (Task 2) ----
test('detectRunner: settings.gradle.kts → gradle', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-detect-'));
  writeFileSync(join(d, 'settings.gradle.kts'), 'rootProject.name="x"');
  try { assert.equal(detectRunner(d), 'gradle'); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('detectRunner: build.gradle → gradle', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-detect-'));
  writeFileSync(join(d, 'build.gradle'), 'plugins {}');
  try { assert.equal(detectRunner(d), 'gradle'); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('detectRunner: package.json runner beats a stray gradle file', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-detect-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'build.gradle'), '');
  try { assert.equal(detectRunner(d), 'vitest'); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('RUNNERS includes gradle', () => { assert.ok(RUNNERS.includes('gradle')); });
test('javaExe resolves or is null (never throws)', () => { const j = javaExe(); assert.ok(j === null || typeof j === 'string'); });
// REPO_ROOT (declared above) has real vitest/jest/mocha/ava devDependencies installed, so
// testCmdFor(..., REPO_ROOT) resolves a real bin and spawns it via process.execPath — no npx, no shim
// (win32 root cause B fix).
test('testCmdFor: mocha uses --reporter tap + --grep with a REGEX-escaped name (resolved bin, no npx)', () => {
  const spec = testCmdFor('mocha', 't.js', 'a.b(c)', REPO_ROOT);
  assert.equal(spec.cmd, process.execPath, 'spawns the resolved JS bin via process.execPath, never npx');
  assert.equal(spec.args[0], resolveRunnerBin('mocha', REPO_ROOT), 'first arg is the resolved bin path');
  assert.deepEqual(spec.args.slice(1), ['t.js', '--reporter', 'tap', '--grep', reEscForTest('a.b(c)')],
    'everything after the bin is IDENTICAL to the pre-fix npx args, minus the pkg name');
});
test('testCmdFor: ava uses --tap + -m with the RAW name (glob, not regex) (resolved bin, no npx)', () => {
  const spec = testCmdFor('ava', 't.js', 'a.b(c)', REPO_ROOT);
  assert.equal(spec.cmd, process.execPath, 'spawns the resolved JS bin via process.execPath, never npx');
  assert.equal(spec.args[0], resolveRunnerBin('ava', REPO_ROOT), 'first arg is the resolved bin path');
  assert.deepEqual(spec.args.slice(1), ['t.js', '--tap', '-m', 'a.b(c)'],
    'everything after the bin is IDENTICAL to the pre-fix npx args, minus the pkg name');
});
// ---- testCmdFor: describe-qualified selection (5th `qualified` param) — see prove()'s residualAmbiguous
// resolution. Only mocha's --grep needs to ANCHOR the qualified full name (empirically proven by the
// mocha e2e below: an anchored qualified pattern selects exactly one nested test); node is unconditionally
// anchored already regardless of the flag, and vitest/jest never read it (their qualified form stays
// unanchored — proven sufficient by their own e2es below).
test('testCmdFor: mocha qualified selection anchors --grep (^...$); unqualified stays unanchored', () => {
  const qualified = testCmdFor('mocha', 't.js', 'growth tier same title', REPO_ROOT, true);
  assert.deepEqual(qualified.args.slice(1), ['t.js', '--reporter', 'tap', '--grep', '^' + reEscForTest('growth tier same title') + '$']);
  const unqualified = testCmdFor('mocha', 't.js', 'growth tier same title', REPO_ROOT, false);
  assert.deepEqual(unqualified.args.slice(1), ['t.js', '--reporter', 'tap', '--grep', reEscForTest('growth tier same title')]);
});
// Specials-bearing qualified name: reEsc and the ^...$ anchor must COMPOSE — regex metacharacters from
// the describe title/test title arrive escaped INSIDE the anchors (hand-derived literal, not reEsc's own
// output round-tripped). The mocha e2e below proves the composed selector actually isolates at runtime.
test('testCmdFor: mocha qualified selector composes anchor + regex-escape — specials in the full name arrive escaped inside ^...$', () => {
  const spec = testCmdFor('mocha', 't.js', 'tier (x) costs $5', REPO_ROOT, true);
  assert.equal(spec.args[spec.args.length - 2], '--grep');
  assert.equal(spec.args[spec.args.length - 1], '^tier \\(x\\) costs \\$5$');
});
// Hand-derived expected argv per runner (never testCmdFor's own output compared to itself — a
// self-comparison here would trivially survive a gutted testCmdFor, exactly the shadow-oracle shape
// gutcheck's own probe is built to catch).
test('testCmdFor: the qualified flag is a no-op for vitest/jest/ava — only mocha reads it', () => {
  const vitestArgs = ['run', 't.js', '-t', reEscForTest('a b')];
  const jestArgs = ['t.js', '-t', reEscForTest('a b'), '--runInBand'];
  const avaArgs = ['t.js', '--tap', '-m', 'a b'];
  assert.deepEqual(testCmdFor('vitest', 't.js', 'a b', REPO_ROOT, true).args.slice(1), vitestArgs);
  assert.deepEqual(testCmdFor('vitest', 't.js', 'a b', REPO_ROOT, false).args.slice(1), vitestArgs);
  assert.deepEqual(testCmdFor('jest', 't.js', 'a b', REPO_ROOT, true).args.slice(1), jestArgs);
  assert.deepEqual(testCmdFor('jest', 't.js', 'a b', REPO_ROOT, false).args.slice(1), jestArgs);
  assert.deepEqual(testCmdFor('ava', 't.js', 'a b', REPO_ROOT, true).args.slice(1), avaArgs);
  assert.deepEqual(testCmdFor('ava', 't.js', 'a b', REPO_ROOT, false).args.slice(1), avaArgs);
});
test('testCmdFor: node is unconditionally anchored regardless of the qualified flag (it has no branch for it)', () => {
  const expected = { cmd: 'node', args: ['--test', '--test-reporter=tap', '--test-name-pattern', '^' + reEscForTest('a b') + '$', 't.js'] };
  assert.deepEqual(testCmdFor('node', 't.js', 'a b'), expected);
  assert.deepEqual(testCmdFor('node', 't.js', 'a b', process.cwd(), true), expected);
});
test('testCmdFor: node pins the tap reporter so parseRun reads counts on Node >=23 (default reporter flipped tap->spec, issue #4)', () => {
  // On Node >=23 `node --test` defaults to the spec reporter (`ℹ pass 1`, even non-TTY), which parseRun's
  // TAP regex (/# pass N/) cannot read — so every node-runner verdict parses 0p/0f, the self-check's
  // planted sound test is never caught, and gutcheck refuses to run (the Stop gate then fails open).
  // Pinning tap forces the format parseRun expects on every supported Node (>=20), mirroring how the
  // mocha (--reporter tap) and ava (--tap) branches already pin theirs.
  const { args } = testCmdFor('node', 't.js', 'a b');
  assert.ok(args.includes('--test-reporter=tap'), `node args must pin --test-reporter=tap; got ${JSON.stringify(args)}`);
});
test('parseRun reads Node\'s tap reporter but not its spec reporter — the reason the node branch must pin tap (issue #4)', () => {
  // Reproduction on the running Node, version-independent (both reporters forced explicitly): the spec
  // reporter (Node >=23's default, even non-TTY) prints `ℹ pass 1`, which parseRun's TAP regex can't read
  // -> {0,0}; tap prints `# pass 1` and reads correctly. This is exactly why testCmdFor pins tap.
  const d = project({ 'package.json': '{"type":"module"}',
    's.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "test('planted sound', () => { assert.strictEqual(1 + 1, 2); });\n" });
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // engine scrubs this too, so a nested node --test runs (prove.mjs runOne)
  const run = (reporter) => {
    const r = spawnSync('node', ['--test', `--test-reporter=${reporter}`, '--test-name-pattern=^planted sound$', join(d, 's.test.mjs')], { encoding: 'utf8', env });
    return (r.stdout || '') + (r.stderr || '');
  };
  try {
    assert.deepEqual(parseRun('node', run('spec')), { passed: 0, failed: 0 }); // the issue-#4 failure mode
    assert.equal(parseRun('node', run('tap')).passed, 1);                       // what the pin restores
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('testCmdFor: an unresolvable bin falls back to the previous npx form on non-win32 (args unchanged)', { skip: process.platform === 'win32' }, () => {
  const empty = mkdtempSync(join(tmpdir(), 'sk-noresolve-'));
  try {
    assert.deepEqual(testCmdFor('mocha', 't.js', 'a.b(c)', empty),
      { cmd: 'npx', args: ['mocha', 't.js', '--reporter', 'tap', '--grep', reEscForTest('a.b(c)')] });
    assert.deepEqual(testCmdFor('ava', 't.js', 'a.b(c)', empty),
      { cmd: 'npx', args: ['ava', 't.js', '--tap', '-m', 'a.b(c)'] });
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
// ---- gradleTaskInfo + testCmdFor gradle branch (Task 3, pure — argv only, no spawn) ----
test('gradleTaskInfo: plain-JVM module (no AGP) → test task', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'lib'), { recursive: true });
  writeFileSync(join(d, 'lib', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
  try {
    const gi = gradleTaskInfo(d, 'lib/src/test/kotlin/FooTest.kt');
    assert.equal(gi.taskPath, ':lib:test');
    assert.equal(gi.cleanPath, ':lib:cleanTest');
    assert.equal(gi.resultsDir, join('lib', 'build', 'test-results', 'test'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gradleTaskInfo: Android module (AGP) → testDebugUnitTest', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'app'), { recursive: true });
  writeFileSync(join(d, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application") }');
  try {
    const gi = gradleTaskInfo(d, 'app/src/test/java/com/x/FooTest.kt');
    assert.equal(gi.taskPath, ':app:testDebugUnitTest');
    assert.equal(gi.cleanPath, ':app:cleanTestDebugUnitTest');
    assert.equal(gi.resultsDir, join('app', 'build', 'test-results', 'testDebugUnitTest'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gradleTaskInfo: nested module path → colon-joined task', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'core', 'contract'), { recursive: true });
  writeFileSync(join(d, 'core', 'contract', 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
  try {
    const gi = gradleTaskInfo(d, 'core/contract/src/test/kotlin/CTest.kt');
    assert.equal(gi.taskPath, ':core:contract:test');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// WILD SPECIMEN (kotlin mini-pilot, lnxgod/friendorfoe): the MODERN new-project idiom declares AGP via a
// version-catalog alias — `alias(libs.plugins.android.application)` — so the literal plugin id lives in
// gradle/libs.versions.toml, never in the module build file. The literal-id grep then misses, gradleTaskInfo
// falls back to `test` (the AGP AGGREGATE lifecycle task, which rejects `--tests`) → every eligible block's
// baseline dies "Unknown command-line option '--tests'" → 0p/0f → inconclusive. Fail-closed (no false
// verdict) but a reach hole across exactly the young catalog-based Android population. The mandatory
// top-level `android { }` extension block is the declaration-style-independent AGP signal.
test('gradleTaskInfo: alias-declared AGP (version catalog) + android block → testDebugUnitTest', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'app'), { recursive: true });
  writeFileSync(join(d, 'app', 'build.gradle.kts'), [
    'plugins {',
    '    alias(libs.plugins.android.application)',
    '    alias(libs.plugins.kotlin.android)',
    '}',
    '',
    'android {',
    '    namespace = "com.x"',
    '    compileSdk = 35',
    '}',
    '',
  ].join('\n'));
  try {
    const gi = gradleTaskInfo(d, 'app/src/test/java/com/x/FooTest.kt');
    assert.equal(gi.taskPath, ':app:testDebugUnitTest');
    assert.equal(gi.resultsDir, join('app', 'build', 'test-results', 'testDebugUnitTest'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// Over-detection guard: `android` appearing only in a comment or a string must NOT flip a plain-JVM module
// to testDebugUnitTest (that task doesn't exist there → 0-match → inconclusive — precision-safe but a
// needless reach loss). The android-block scan is line-anchored: only a real top-level `android {` counts.
// Maven is now a real supported runner (mirrors gradle — see mutation/prove.mjs's testCmdFor/runOne
// 'maven' branches): detectRunner claims a pom.xml repo and prove() routes it through the normal probe
// path, never the old entry-level scopeError short-circuit. Without a resolvable mvn (this dev/CI
// environment has none on PATH, and this fixture carries no wrapper jar), testCmdFor's maven branch
// falls back to a deliberately-failing sentinel (see mavenBin) — a baseline naturally reads 0p/0f and
// the block lands inconclusive, the SAME fail-closed shape an absent gradle/java produces. Never a wrong
// verdict, never a crash.
test('a Maven project (pom.xml, no package.json/gradle) is now a real runner — no scopeError', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-maven-'));
  writeFileSync(join(d, 'pom.xml'), '<project></project>');
  mkdirSync(join(d, 'src', 'main', 'java', 'demo'), { recursive: true });
  writeFileSync(join(d, 'src', 'main', 'java', 'demo', 'Calc.java'), 'package demo;\npublic class Calc { public int one() { return 1; } }');
  mkdirSync(join(d, 'src', 'test', 'java', 'demo'), { recursive: true });
  writeFileSync(join(d, 'src', 'test', 'java', 'demo', 'FooTest.java'), 'package demo;\nclass FooTest { @Test void t() { assertEquals(1, new Calc().one()); } }');
  try {
    const r = prove(d, {});
    assert.equal(r.runner, 'maven');
    assert.ok(!r.scopeError, `no entry-level scopeError: ${r.scopeError}`);
    // No mvn resolvable in this environment/fixture → the eligible block's baseline can't run → it lands
    // inconclusive (0p/0f), never caught/hollow — the fail-closed shape, never a false verdict.
    assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// KMP jvmTest (wild specimen heypandax/cc-pocket, kotlin mini-pilot): a KMP module's JVM tests live in
// src/jvmTest/ and run via the `jvmTest` task — `test` and `testDebugUnitTest` both 0-match there, which
// previously burned a baseline per block and landed every one as inconclusive noise.
test('gradleTaskInfo: KMP src/jvmTest file → :module:jvmTest task, cleanJvmTest, jvmTest results dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'protocol'), { recursive: true });
  writeFileSync(join(d, 'protocol', 'build.gradle.kts'), 'plugins { kotlin("multiplatform") }');
  try {
    const gi = gradleTaskInfo(d, 'protocol/src/jvmTest/kotlin/FooTest.kt');
    assert.equal(gi.taskPath, ':protocol:jvmTest');
    assert.equal(gi.cleanPath, ':protocol:cleanJvmTest');
    assert.equal(gi.resultsDir, join('protocol', 'build', 'test-results', 'jvmTest'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gradleTaskInfo: src/jvmTest wins over android detection (a KMP module with an android target)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'shared'), { recursive: true });
  writeFileSync(join(d, 'shared', 'build.gradle.kts'), 'plugins { kotlin("multiplatform") }\n\nandroid {\n    namespace = "com.x"\n}\n');
  try {
    assert.equal(gradleTaskInfo(d, 'shared/src/jvmTest/kotlin/FooTest.kt').taskPath, ':shared:jvmTest');
    // and the module's plain-android unit tests still map to testDebugUnitTest
    assert.equal(gradleTaskInfo(d, 'shared/src/test/kotlin/BarTest.kt').taskPath, ':shared:testDebugUnitTest');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// Unsupported source sets fail closed BEFORE any gradle run: androidTest is instrumented (device or
// emulator — outside the probe's one-fast-rerun model); other KMP target sets (commonTest, iosTest, …)
// have no supported single-target task. Both were measured burning a baseline per block in the wild
// (gamedge: 9, cc-pocket mobile: 8) before this gate.
test('jvmSourceSetGate: test/jvmTest pass; androidTest and KMP target sets get explicit skip reasons', async () => {
  const { jvmSourceSetGate } = await import('../mutation/prove.mjs');
  assert.equal(jvmSourceSetGate('app/src/test/kotlin/T.kt'), null);
  assert.equal(jvmSourceSetGate('protocol/src/jvmTest/kotlin/T.kt'), null);
  assert.equal(jvmSourceSetGate('app/src/androidTest/java/T.kt'), 'instrumented-test');
  assert.equal(jvmSourceSetGate('shared/src/commonTest/kotlin/T.kt'), 'unsupported-source-set', 'no dir context -> fail closed');
  assert.equal(jvmSourceSetGate('shared/src/iosTest/kotlin/T.kt'), 'unsupported-source-set');
  assert.equal(jvmSourceSetGate('src/main/kotlin/T.kt'), null, 'main is not a test set — no gate opinion');
});

// commonTest is where the dominant KMP idiom keeps shared tests (wild specimen cc-pocket :protocol:
// commonMain + commonTest only, `jvm()` declared) — and those tests EXECUTE under the module's jvmTest
// task (the warm build writes their JUnit XML to test-results/jvmTest). So commonTest maps to jvmTest
// exactly when the module demonstrably has a JVM target; without one the task would 0-match, so the
// gate keeps the fail-closed skip.
test('commonTest with a JVM target maps to :module:jvmTest; without one it stays a clean skip', async () => {
  const { jvmSourceSetGate } = await import('../mutation/prove.mjs');
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'protocol'), { recursive: true });
  writeFileSync(join(d, 'protocol', 'build.gradle.kts'), 'plugins { kotlin("multiplatform") }\nkotlin {\n    jvm()\n    iosArm64()\n}\n');
  mkdirSync(join(d, 'noJvm'), { recursive: true });
  writeFileSync(join(d, 'noJvm', 'build.gradle.kts'), 'plugins { kotlin("multiplatform") }\nkotlin {\n    iosArm64()\n}\n');
  try {
    const gi = gradleTaskInfo(d, 'protocol/src/commonTest/kotlin/RoundTripTest.kt');
    assert.equal(gi.taskPath, ':protocol:jvmTest');
    assert.equal(gi.resultsDir, join('protocol', 'build', 'test-results', 'jvmTest'));
    assert.equal(jvmSourceSetGate('protocol/src/commonTest/kotlin/RoundTripTest.kt', d), null, 'jvm target present -> probeable');
    assert.equal(jvmSourceSetGate('noJvm/src/commonTest/kotlin/T.kt', d), 'unsupported-source-set', 'no jvm target -> clean skip');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('gradleTaskInfo: plain-JVM module mentioning android only in comments/strings stays `test`', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-gti-'));
  mkdirSync(join(d, 'lib'), { recursive: true });
  writeFileSync(join(d, 'lib', 'build.gradle.kts'), [
    'plugins { kotlin("jvm") }',
    '// TODO: maybe android { } support later',
    'val note = "android {"',
    '',
  ].join('\n'));
  try {
    const gi = gradleTaskInfo(d, 'lib/src/test/kotlin/FooTest.kt');
    assert.equal(gi.taskPath, ':lib:test');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('testCmdFor gradle: java-wrapper argv, no shell, offline', () => {
  const gi = { taskPath: ':app:testDebugUnitTest', cleanPath: ':app:cleanTestDebugUnitTest', resultsDir: 'app/build/test-results/testDebugUnitTest' };
  const { cmd, args } = testCmdFor('gradle', 'app/src/test/kotlin/CalcTest.kt', 'demo.CalcTest.testAdd', '/proj', false, gi);
  assert.match(cmd, /java$|java\b/);                 // javaExe() or 'java'
  assert.ok(args.includes('org.gradle.wrapper.GradleWrapperMain'));
  assert.ok(args.includes(':app:cleanTestDebugUnitTest') && args.includes(':app:testDebugUnitTest'));
  assert.ok(args.includes('--tests') && args.includes('demo.CalcTest.testAdd'));
  assert.ok(args.includes('--offline') && args.includes('--console=plain'));
  // NOT --build-cache (field report 2026-07-18: removed — its location-independent, content-addressable
  // reuse let a repeat probe invocation on an unchanged diff read a genuine survivor back as 'ungutable',
  // indistinguishable from the vfs-watch race mainCompileExecuted gates on). Regression guard: this flag
  // must never come back without also solving that cross-invocation collision.
  assert.ok(!args.includes('--build-cache'), `--build-cache must stay OUT of the gradle argv: ${JSON.stringify(args)}`);
  assert.ok(!args.some((a) => /gradlew/.test(a)));   // never the .bat/.sh script
});
// ---- resolveRunnerBin: fixture-driven unit coverage of every bin-field shape + the walk-up + the miss ----
test('resolveRunnerBin: bin as a plain string (jest shape)', () => {
  const d = project({ 'node_modules/jest/package.json': JSON.stringify({ bin: './bin/jest.js' }) });
  try {
    assert.equal(resolveRunnerBin('jest', d), resolve(d, 'node_modules/jest/bin/jest.js'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('resolveRunnerBin: bin as an object with a key matching the package name (vitest shape)', () => {
  const d = project({ 'node_modules/vitest/package.json': JSON.stringify({ bin: { vitest: 'vitest.mjs', other: 'x.js' } }) });
  try {
    assert.equal(resolveRunnerBin('vitest', d), resolve(d, 'node_modules/vitest/vitest.mjs'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('resolveRunnerBin: mocha bin object has BOTH mocha and _mocha — the exact "mocha" key wins', () => {
  const d = project({ 'node_modules/mocha/package.json': JSON.stringify({ bin: { mocha: './bin/mocha.js', _mocha: './bin/_mocha' } }) });
  try {
    assert.equal(resolveRunnerBin('mocha', d), resolve(d, 'node_modules/mocha/bin/mocha.js'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('resolveRunnerBin: bin as an object with NO key matching the package name falls back to the first value', () => {
  const d = project({ 'node_modules/ava/package.json': JSON.stringify({ bin: { cli: 'entrypoints/cli.mjs', other: 'x.js' } }) });
  try {
    assert.equal(resolveRunnerBin('ava', d), resolve(d, 'node_modules/ava/entrypoints/cli.mjs'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('resolveRunnerBin: walks up from a nested directory to an ancestor node_modules', () => {
  const d = project({ 'node_modules/vitest/package.json': JSON.stringify({ bin: { vitest: 'vitest.mjs' } }) });
  const nested = join(d, 'a', 'b', 'c');
  mkdirSync(nested, { recursive: true });
  try {
    assert.equal(resolveRunnerBin('vitest', nested), resolve(d, 'node_modules/vitest/vitest.mjs'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('resolveRunnerBin: no matching node_modules anywhere up to the filesystem root returns null', () => {
  const d = mkdtempSync(join(tmpdir(), 'sk-nobin-'));
  try {
    assert.equal(resolveRunnerBin('vitest', d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// fixture-free truth: the real installed packages this repo ships against, resolved live (no mocking).
// The four gated e2es below exercise these SAME resolved bins in an actual spawn; this is the unit-level
// half of that claim ("...they must stay green, now WITHOUT npx (assert via the unit layer...)").
test('resolveRunnerBin resolves all four real installed runner packages to their actual bin entry', () => {
  const known = { vitest: 'vitest.mjs', jest: 'jest.js', mocha: 'mocha.js', ava: 'cli.mjs' };
  for (const [runner, suffix] of Object.entries(known)) {
    const bin = resolveRunnerBin(runner, REPO_ROOT);
    assert.ok(bin && bin.endsWith(suffix), `${runner}: resolved bin should end with ${suffix}, got ${bin}`);
    assert.ok(existsSync(bin), `${runner}: resolved bin path must actually exist on disk`);
  }
});
// ---- fallbackCmdFor: the two platform shapes, isolated so BOTH are unit-testable on one host (no
// platform mocking/injection — see mutation/prove.mjs for the full rationale) ----
test('fallbackCmdFor: non-win32 returns the previous npx argv form (pkg name only — testCmdFor appends the rest)', () => {
  assert.deepEqual(fallbackCmdFor('vitest', false), { cmd: 'npx', args: ['vitest'] });
  assert.deepEqual(fallbackCmdFor('jest', false), { cmd: 'npx', args: ['jest'] });
});
test('fallbackCmdFor: win32 returns a crash-proof sentinel — never npx, never a shell', () => {
  assert.deepEqual(fallbackCmdFor('vitest', true), { cmd: process.execPath, args: ['-e', 'process.exit(1)'] });
  assert.deepEqual(parseRun('vitest', ''), { passed: 0, failed: 0 }, 'its empty output parses to 0p/0f — baseline-fail inconclusive, never a crash');
});
// ---- fail-closed ambiguity detection: could this block's runner selection ALSO match a sibling in the
// same file? (the exact cross-test misattribution that flipped a true HOLLOW into a false CAUGHT — see
// the recall investigation). Pure + unit-testable, no runner spawned.
test('ambiguousNames: node is anchored — only an EXACT duplicate title is ambiguous', () => {
  assert.deepEqual(ambiguousNames(['a', 'a', 'b'], 'node'), new Set(['a']));
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'node'), new Set());
});
test('ambiguousNames: vitest -t is substring-either-direction — a prefix pair is ambiguous', () => {
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'vitest'), new Set(['adds', 'adds two']));
});
test('ambiguousNames: jest, mocha and pytest use the same substring-either-direction rule', () => {
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'jest'), new Set(['adds', 'adds two']));
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'mocha'), new Set(['adds', 'adds two']));
  assert.deepEqual(ambiguousNames(['adds', 'adds two'], 'pytest'), new Set(['adds', 'adds two']));
});
test('ambiguousNames: ava -m follows matcher v5 — exact duplicates, `*` wildcard, and leading-`!` negation are ambiguous; `?[{` are literals', () => {
  assert.deepEqual(ambiguousNames(['a', 'a', 'b'], 'ava'), new Set(['a']));
  assert.deepEqual(ambiguousNames(['a*b', 'c'], 'ava'), new Set(['a*b']));
  assert.deepEqual(ambiguousNames(['!negated', 'c'], 'ava'), new Set(['!negated']));
  assert.deepEqual(ambiguousNames(['a?b[x]{y}', 'c'], 'ava'), new Set(), 'matcher treats ?[{ as plain literals — not ambiguous');
});
test('ambiguousNames: gradle --tests <FQN> is EXACT-match — prefix-related FQNs are NOT ambiguous (only a true duplicate is)', () => {
  // testCmdFor('gradle', …) emits `--tests <FQN>` with no wildcard, which Gradle matches EXACTLY — so a
  // prefix pair (testSave/testSaveAll, find/findById, add/addAll) shares no invocation and must not be
  // flagged. The JVM norm; the substring rule would falsely route BOTH to inconclusive → lost coverage.
  assert.deepEqual(ambiguousNames(['demo.T.testSave', 'demo.T.testSaveAll', 'demo.T.testFind'], 'gradle'), new Set());
  assert.deepEqual(ambiguousNames(['p.C.add', 'p.C.addAll'], 'gradle'), new Set());
  assert.deepEqual(ambiguousNames(['p.C.f', 'p.C.f', 'p.C.g'], 'gradle'), new Set(['p.C.f']), 'a genuine exact duplicate FQN is still ambiguous');
});
test('residualAmbiguous: gradle prefix-related FQNs never reach stage 2 (empty bare set → empty residual)', () => {
  const blocks = [{ name: 'demo.T.testSave' }, { name: 'demo.T.testSaveAll' }];
  const bare = ambiguousNames(blocks.map((b) => b.name), 'gradle');
  assert.deepEqual(residualAmbiguous(blocks, bare, 'gradle'), new Set());
});
// maven shares gradle's exact-match semantics (testCmdFor('maven', …) emits -Dtest=Class#method, no
// wildcard) — same collidesPair disjunct, same fixture shapes, just the other JVM runner ID.
test('ambiguousNames: maven -Dtest=Class#method is EXACT-match too — prefix-related FQNs are NOT ambiguous', () => {
  assert.deepEqual(ambiguousNames(['demo.T.testSave', 'demo.T.testSaveAll', 'demo.T.testFind'], 'maven'), new Set());
  assert.deepEqual(ambiguousNames(['p.C.add', 'p.C.addAll'], 'maven'), new Set());
  assert.deepEqual(ambiguousNames(['p.C.f', 'p.C.f', 'p.C.g'], 'maven'), new Set(['p.C.f']), 'a genuine exact duplicate FQN is still ambiguous');
});

// ---- Stage 2: qualifiedName + residualAmbiguous (describe-path qualification — see prove()'s per-block
// loop). Pure + unit-testable, no runner spawned; the runner e2es below (node/vitest/jest/mocha) prove the
// real invocation actually resolves as these unit tests predict.
test('qualifiedName: joins the describe-path chain + own title with a single space (Jest/Vitest/Mocha "full name" convention)', () => {
  assert.equal(qualifiedName({ path: ['a', 'b'], name: 'c' }), 'a b c');
  assert.equal(qualifiedName({ path: [], name: 'c' }), 'c');
  assert.equal(qualifiedName({ name: 'c' }), 'c', 'no `path` at all (pytest/pyAst blocks) degenerates to the bare name');
});
test('residualAmbiguous: a bare-title collision resolved by DIFFERENT describe paths is not residual', () => {
  const blocks = [{ name: 'x', path: ['a'] }, { name: 'x', path: ['b'] }];
  for (const runner of ['vitest', 'jest', 'mocha', 'node']) {
    const bare = ambiguousNames(blocks.map((b) => b.name), runner);
    assert.deepEqual(residualAmbiguous(blocks, bare, runner), new Set(), runner);
  }
});
test('residualAmbiguous: IDENTICAL describe path + title stays residual (both block indexes)', () => {
  const blocks = [{ name: 'x', path: ['a'] }, { name: 'x', path: ['a'] }];
  for (const runner of ['vitest', 'jest', 'mocha', 'node']) {
    const bare = ambiguousNames(blocks.map((b) => b.name), runner);
    assert.deepEqual(residualAmbiguous(blocks, bare, runner), new Set([0, 1]), runner);
  }
});
test('residualAmbiguous: ava never resolves — always residual (flat, no describe nesting; leave bare)', () => {
  const blocks = [{ name: 'x', path: [] }, { name: 'x', path: [] }];
  const bare = ambiguousNames(blocks.map((b) => b.name), 'ava');
  assert.deepEqual(residualAmbiguous(blocks, bare, 'ava'), new Set([0, 1]));
});
test('residualAmbiguous: pytest blocks carry no path — qualification is a provable no-op (stays residual)', () => {
  const blocks = [{ name: 'test_it' }, { name: 'test_it' }]; // no .path at all, like real pyAst blocks
  const bare = ambiguousNames(blocks.map((b) => b.name), 'pytest');
  assert.deepEqual(residualAmbiguous(blocks, bare, 'pytest'), new Set([0, 1]));
});
test('residualAmbiguous: a block whose bare name was never ambiguous is untouched', () => {
  const blocks = [{ name: 'unique1', path: [] }, { name: 'unique2', path: [] }];
  const bare = ambiguousNames(blocks.map((b) => b.name), 'vitest');
  assert.deepEqual(residualAmbiguous(blocks, bare, 'vitest'), new Set());
});
test('runner-completeness: every RUNNERS entry has a command spec and a parseRun branch that reads a fixture', () => {
  const FIXTURES = { // representative output + known counts per runner
    node:   { out: '# pass 2\n# fail 1\n', passed: 2, failed: 1 },
    vitest: { out: ' Tests  1 failed | 2 passed (3)', passed: 2, failed: 1 },
    jest:   { out: 'Tests: 1 failed, 2 passed, 3 total', passed: 2, failed: 1 },
    pytest: { out: '2 passed, 1 failed in 0.01s', passed: 2, failed: 1 },
    mocha:  { out: FIX('mocha-2pass-1fail.txt'), passed: 2, failed: 1 },
    ava:    { out: FIX('ava-2pass-1fail.txt'), passed: 2, failed: 1 },
  };
  for (const r of RUNNERS) {
    const spec = testCmdFor(r, 'x.test.js', 'my test');
    assert.ok(spec && spec.cmd && Array.isArray(spec.args) && spec.args.length > 0, `${r}: testCmdFor must return a non-empty {cmd,args}`);
    // gradle/maven have no text parseRun branch — their results come from parseGradleResults(dir)
    // reading JUnit XML (a directory, not stdout text), covered separately by
    // test/kind-gradle-results.test.mjs (shared) and test/maven-runner.test.mjs (maven's own
    // compiled-detection guard, mavenCompiled).
    if (r === 'gradle' || r === 'maven') continue;
    assert.ok(FIXTURES[r], `${r}: needs a parseRun fixture in the completeness test`);
    assert.deepEqual(parseRun(r, FIXTURES[r].out), { passed: FIXTURES[r].passed, failed: FIXTURES[r].failed }, `${r}: parseRun must read its output`);
  }
});
test('parseBlocks finds it()/test() names and bodies', () => {
  const b = parseBlocks("test('a', () => { foo(); });\nit('b', async () => { bar(); });", 'js');
  assert.deepEqual(b.map((x) => x.name), ['a', 'b']);
});
test('parseBlocks: function() callbacks and .only/.skip/.concurrent modifiers are found', () => {
  const code = [
    "it('arrow', () => { foo(); });",
    "it('fn', function () { bar(); });",
    "test.only('only', () => { baz(); });",
    "it.skip('skip', () => { qux(); });",
    "test.concurrent('conc', async () => { zap(); });",
  ].join('\n');
  assert.deepEqual(parseBlocks(code, 'js').map((b) => b.name), ['arrow', 'fn', 'only', 'skip', 'conc']);
});
// ---- parseBlocks: describe()/suite() path tracking (Task 1 — feeds qualifiedName/residualAmbiguous) ----
test('parseBlocks: a top-level it()/test() has an empty path', () => {
  const blocks = parseBlocks("it('a', () => { f(); });", 'js');
  assert.deepEqual(blocks[0].path, []);
});
test('parseBlocks: a single describe() wraps its it()s with a one-entry path', () => {
  const code = "describe('outer', () => {\n  it('a', () => { f(); });\n  it('b', () => { g(); });\n});";
  assert.deepEqual(parseBlocks(code, 'js').map((b) => ({ name: b.name, path: b.path })), [
    { name: 'a', path: ['outer'] },
    { name: 'b', path: ['outer'] },
  ]);
});
test('parseBlocks: nested describe()s accumulate the path outermost-first; siblings and top-level are unaffected', () => {
  const code = [
    "describe('outer', () => {",
    "  describe('inner', () => {",
    "    it('a', () => { x(); });",
    "  });",
    "  it('b', () => { y(); });",
    "});",
    "it('c', () => { z(); });",
  ].join('\n');
  assert.deepEqual(parseBlocks(code, 'js').map((b) => ({ name: b.name, path: b.path })), [
    { name: 'a', path: ['outer', 'inner'] },
    { name: 'b', path: ['outer'] },
    { name: 'c', path: [] },
  ]);
});
test('parseBlocks: two SEPARATE (non-nested) describe()s sharing a title produce independent path entries, not a merged scope', () => {
  const code = [
    "describe('growth tier', () => { it('same title', () => { f(); }); });",
    "describe('growth tier', () => { it('same title', () => { g(); }); });",
  ].join('\n');
  assert.deepEqual(parseBlocks(code, 'js').map((b) => b.path), [['growth tier'], ['growth tier']]);
});
test('parseBlocks: suite() and describe.only/.skip are recognized as scope, mirroring it/test modifiers', () => {
  assert.deepEqual(parseBlocks("suite.only('s', function () { it('x', function () { f(); }); });", 'js').map((b) => b.path), [['s']]);
  assert.deepEqual(parseBlocks("describe.skip('s', () => { it('x', () => { f(); }); });", 'js').map((b) => b.path), [['s']]);
});
test('parseBlocks: python blocks carry no `path` property at all (describe-nesting is a JS-only concept here)', () => {
  const blocks = parseBlocks('def test_a():\n    f()\n', 'python');
  assert.equal(blocks[0].path, undefined);
});
// ---- masking guard: a describe-shaped token inside a string/comment must open no phantom scope (a
// phantom scope leaks a bogus path onto the NEXT real block → corrupted qualified selector; on node a
// zero-match selected run still reports `# pass 1` — the file wrapper — so the corruption reads as a
// passing run, a false-HOLLOW vector). Both cases confirmed RED against the pre-fix code (the real
// block got path:['fake'] / ['cmt']). ----
test('parseBlocks: a describe-shaped token inside a STRING opens no phantom scope — the next real block keeps path []', () => {
  const code = 'const s = "describe(\'fake\', () => { it(\'...\', () => {";\n' +
    "it('real one', () => { f(); });\n";
  const real = parseBlocks(code, 'js').find((b) => b.name === 'real one');
  assert.deepEqual(real.path, [], 'no phantom [fake] scope from the string literal');
});
test('parseBlocks: a commented-out describe opens no phantom scope', () => {
  const code = "// describe('cmt', () => {\nit('second', () => { g(); });\n";
  const real = parseBlocks(code, 'js').find((b) => b.name === 'second');
  assert.deepEqual(real.path, [], 'no phantom [cmt] scope from the comment');
});
// Confirmatory audit batch B, row 9 (NoorDigitalAgency/Unfluffify): a test's own regex literal containing
// an UNMATCHED escaped brace (e.g. `/foo\{/`, one `\{`, zero `\}`) unbalances the raw-text brace-depth
// counter that finds a test block's end (mutation/prove.mjs's two loops, both formerly over raw `code`).
// The counter overshoots the real closing `}` and keeps consuming source until enough LATER `}` chars —
// borrowed from a subsequent sibling test — coincidentally rebalance it back to 0. The earlier test's
// captured `body` then swallows the sibling's SUT call verbatim, misattributing it to the wrong block.
test("parseBlocks: an unmatched escaped brace inside an EARLIER test's regex literal does not swallow a LATER sibling's body (confirmatory audit batch B, row 9)", () => {
  const code = "const src = 'foo{';\n"
    + "test('A: static regex check', () => { assert.match(src, /foo\\{/); });\n"
    + "test('B: calls target', () => { target(); });\n";
  const blocks = parseBlocks(code, 'js');
  const a = blocks.find((b) => b.name === 'A: static regex check');
  const b = blocks.find((b) => b.name === 'B: calls target');
  assert.ok(a && b, 'both blocks are found');
  assert.doesNotMatch(a.body, /target\(\)/, "A's captured body must not swallow B's target() call");
  assert.match(b.body, /target\(\)/, "B's own body correctly contains its target() call");
});

// ---- escape-aware title capture (Task 2): a naive `(['"`])(.*?)\1` backreference DOES eventually
// backtrack past an escaped quote onto the real closing quote (verified empirically — the MATCH itself
// is not truncated), but the text it captures still carries the raw backslash (`caught\'s edge`), which
// then never equals the runner's actual (unescaped) runtime title (`caught's edge`) — a silent selection
// mismatch (0 tests match, not a crash) that misreads as HOLLOW. This is the ledger's exact incident
// (a real regression): a test with an apostrophe in its title had to be rewritten
// with double quotes to dodge it, because prove.mjs itself was never fixed. RED case below: the exact shape.
test('parseBlocks: an escaped apostrophe inside a single-quoted title is captured as the REAL runtime title — no stray backslash, not truncated (the ledger case)', () => {
  const code = "it('caught\\'s edge', () => { f(); });";
  const b = parseBlocks(code, 'js');
  assert.equal(b.length, 1, 'the block is still found at all');
  assert.equal(b[0].name, "caught's edge", 'the unescaped runtime title the runner will actually report');
});
test('parseBlocks: an escaped double-quote inside a double-quoted title is captured correctly', () => {
  const code = 'it("a \\"quoted\\" word", () => { f(); });';
  const b = parseBlocks(code, 'js');
  assert.equal(b[0].name, 'a "quoted" word');
});
test('parseBlocks: an escaped backtick inside a non-interpolated template-literal title is captured correctly, and is NOT flagged dynamic', () => {
  const code = "it(`a \\`backtick\\` word`, () => { f(); });";
  const b = parseBlocks(code, 'js');
  assert.equal(b[0].name, 'a `backtick` word');
  assert.equal(b[0].dynamicTitle, false);
});
test('parseBlocks: common escape sequences (\\n, \\t, \\\\) unescape to their real runtime characters', () => {
  const code = "it('line1\\nline2\\ttabbed\\\\slash', () => { f(); });";
  const b = parseBlocks(code, 'js');
  assert.equal(b[0].name, 'line1\nline2\ttabbed\\slash');
});
// A template literal WITH `${...}` interpolation has a runtime-computed title — it must never be captured
// as if the literal `${...}` source text WERE the name (that string will never match anything a runner
// reports), and it must never silently vanish either — flagged `dynamicTitle` so prove() can skip it with
// an honest reason (see the PROVE-level test in this file).
test('parseBlocks: a template-literal title WITH ${...} interpolation is flagged dynamicTitle, not captured as a bogus literal name', () => {
  const code = "it(`user ${id} exists`, () => { f(); });";
  const b = parseBlocks(code, 'js');
  assert.equal(b.length, 1, 'the block is still found (so prove() can account for/skip it, not silently drop it)');
  assert.equal(b[0].dynamicTitle, true);
});
test('parseBlocks: an escaped apostrophe inside a describe() title is captured correctly and feeds the describe path (Task 1 + Task 2 combined)', () => {
  const code = "describe('starter tier\\'s config', () => { it('x', () => { f(); }); });";
  const b = parseBlocks(code, 'js');
  assert.deepEqual(b[0].path, ["starter tier's config"]);
});

// ---- integration: run the real probe over a synthetic node:test project ----
const SUT = `export function add(a, b){ return a + b; }
export function total(items){ return items.reduce((s, i) => s + i.p * i.q, 0); }
export function fmt(n){ return '$' + n.toFixed(2); }
`;
const head = "import { test } from 'node:test'; import assert from 'node:assert';";

test('PROVE: sound tests are caught, an imported-SUT shadow is HOLLOW, a weak assertion is not probed', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': SUT,
    'test/t.test.mjs': `${head} import { add, total, fmt } from '../src/lib.mjs';
test('add sound', () => { assert.strictEqual(add(2, 3), 5); });
test('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });
test('weak', () => { assert.ok(total([{p:1,q:2}]) !== null); });
test('fmt sound', () => { assert.strictEqual(fmt(13.5), '$13.50'); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'node');
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 2, 'add + fmt caught');
    assert.equal(r.hollow.length, 1, 'the shadow is the only hollow');
    assert.equal(r.hollow[0].name, 'shadow');
    assert.ok(r.hollow[0].survivors.includes('total'));
    // (fn, sutRel) pairs — the hook/--explain evidence fix (Task 4): disambiguates a same-named survivor
    // across files, the same pair shape blockRecords already carries for this verdict.
    assert.ok(Array.isArray(r.hollow[0].survivorPairs), 'r.hollow entries carry survivorPairs');
    const pair = r.hollow[0].survivorPairs.find((p) => p.fn === 'total');
    assert.ok(pair, 'a (fn, sutRel) pair exists for the survivor');
    assert.equal(pair.sutRel, 'src/lib.mjs', 'sutRel names the actual SUT file, not just the bare fn name');
    // the weak `assert.ok(... !== null)` block must NOT be flagged hollow — it is left unprobed
    assert.ok(!r.hollow.some((h) => h.name === 'weak'), 'weak block not flagged');
    assert.ok(r.skipped.some((s) => s.name === 'weak'), 'weak block skipped as non-pinning');
    assert.equal(r.scored, 3);
    // a RELATIVE dir must work too (else the node_modules symlink target resolves to itself)
    const rel = prove(relative(process.cwd(), d), { runner: 'node' });
    assert.equal(rel.caught, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- node file-wrapper false-HOLLOW vector: a describe.skip'd suite never registers its inner
// it(), so the runner selector zero-matches — but node still reports `# pass 1` for the file-
// wrapper subtest point. Oracle: the tool's own published fail-closed contract says a test that
// never executed must never be called hollow — this is independent of what the code currently
// does. A run that scheduled zero subtests (TAP `1..0`) proves the inner test never executed.
test('PROVE e2e: a describe.skip-buried test (never registered, zero-match run) must be inconclusive, never HOLLOW', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'sut.mjs': 'export function add(a, b) { return a + b; }\n',
    'test/dead.test.mjs': `import { describe, it } from 'node:test';
import assert from 'node:assert';
import { add } from '../sut.mjs';
describe.skip('dead suite', () => {
  it('pins add', () => { assert.strictEqual(add(2, 3), 5); });
});
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0, 'a test that never ran (describe.skip) must never be called hollow');
    const inc = r.inconclusive.find((x) => x.name === 'pins add');
    assert.ok(inc, 'the dead test must land in inconclusive');
    assert.match(inc.why, /^did-not-run 0p\/0f/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- did-not-run split (Task 1 — reproduced defect): a test.skip beside a scoring test must land
// inconclusive as 'did-not-run 0p/0f', never 'baseline 0p/0f'. No genuine failure ever reads 0
// failed (an import crash reports `fail 1` under node --test; JVM XML counts failures+errors), so a
// 0-failure baseline is never an accusation — every '/^baseline /' accusation surface (the Stop hook,
// the CLI's SARIF/GitHub/human formatters) must never see this bucket.
test('PROVE a skipped test lands inconclusive as did-not-run, never baseline-failed', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/dbl.mjs': 'export function dbl(x) { return x * 2; }\n',
    'test/t.test.mjs': `${head} import { dbl } from '../src/dbl.mjs';
test('dbl works', () => { assert.strictEqual(dbl(3), 6); });
test.skip('trp works', () => { assert.strictEqual(dbl(3), 6); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    const skipRow = r.inconclusive.find((i) => i.name === 'trp works');
    assert.ok(skipRow, JSON.stringify(r.inconclusive));
    assert.match(skipRow.why, /^did-not-run 0p\/0f$/);
    assert.ok(!r.inconclusive.some((i) => /^baseline /.test(i.why) && i.name === 'trp works'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE e2e: an unmatched escaped brace in an earlier test\'s regex literal must not misattribute a later sibling\'s SUT call (confirmatory audit batch B, row 9)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function target(x) { return x * 2; }\n',
    'test/t.test.mjs': `${head} import { target } from '../src/lib.mjs';
const src = 'foo{';
test('A: static regex check', () => { assert.match(src, /foo\\{/); });
test('B: calls target', () => { assert.strictEqual(target(3), 6); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 1, 'B genuinely catches the target mutation');
    assert.equal(r.hollow.length, 0, 'A (regex-only, no SUT call) must never be flagged hollow via a corrupted over-captured span');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('PROVE: a generator SUT is resolved and probed (not silently skipped)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/gen.mjs': 'export function* range(n){ for (let i = 0; i < n; i++) yield i; }\n',
    'test/g.test.mjs': `${head} import { range } from '../src/gen.mjs';
test('range', () => { const it = range(3); assert.strictEqual(it.next().value, 0); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 1, 'the generator test is probed and caught');
    assert.ok(!r.skipped.some((s) => s.name === 'range'), 'range not skipped — its SUT resolved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a test NAME containing shell-special characters must not corrupt the single-test run: the runner
// invocation is argv (execFileSync), never a shell string, so a backtick/`$(...)` in the name is inert. ----
test('PROVE: a test name with a backtick and $(...) is genuinely probed — no false HOLLOW from shell metacharacters', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': "export function wrap(x){ return '[' + x + ']'; }\n",
    'test/t.test.mjs': head + " import { wrap } from '../src/lib.mjs';\n"
      + "test('wraps `x` as $(literal)', () => { assert.strictEqual(wrap('a'), '[a]'); });\n",
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 1, 'gutting wrap() genuinely fails the backtick/$ named test');
    assert.equal(r.hollow.length, 0, 'must not be reported hollow — the shell never sees the name');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- depth tier: --deep exposes fixed-point-weak tests with an identity stub ----
test('PROVE --deep: a fixed-point input is flagged weak; a discriminating test and a true identity fn are not', () => {
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
    const base = prove(d, { runner: 'node' });
    assert.equal(base.caught, 3, 'all three are caught by gross gutting');
    assert.ok(!base.weak || base.weak.length === 0, 'the weak advisory is opt-in (off without --deep)');
    const deep = prove(d, { runner: 'node', deep: true });
    assert.equal(deep.caught, 3, '--deep does not change the gross verdict');
    assert.ok(deep.weak && deep.weak.some((w) => w.name === 'fixed point' && w.fn === 'norm'),
      'the fixed-point test is flagged weak');
    assert.ok(!deep.weak.some((w) => w.name === 'discriminating'), 'a discriminating test is not weak');
    assert.ok(!deep.weak.some((w) => w.name === 'identity ok'), 'a true identity fn is not weak (the guard holds)');
    // true denominators (Task 6): norm is attempted for BOTH the 'fixed point' and 'discriminating' blocks
    // (each broke under gross break, so each reaches the deep tier) — 2 stubbed. The identity stub survives
    // only 'fixed point' (norm('hello') is already trimmed+lowercased — a fixed point of the transform) —
    // 1 passed. echo's body already literally IS `return x`; passthroughBreak declines (nothing to expose),
    // so echo never gets attempted and carries no weakSummary entry at all.
    assert.deepEqual(deep.weakSummary, { norm: { stubbed: 2, passed: 1 } });
    assert.equal(base.weakSummary, undefined, 'weakSummary is opt-in (omitted without --deep)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- formatReport: the identity-stub advisory renders per-FUNCTION ratios from weakSummary, never a
// per-test list (audit-gated promotion) ----
test('formatReport renders the identity-stub advisory per-fn from weakSummary (hand-derived ratios)', () => {
  const r = {
    scopeError: null, scored: 2, caught: 2, hollow: [], skipped: [], inconclusive: [], probes: 5, runner: 'node', pct: 100,
    // hand-derived: norm was attempted 3x across the suite and the identity stub survived 2 of those 3;
    // echo was attempted once and the stub was CAUGHT every time (0 of 1 survived) — a success story, not
    // an advisory (final-review wave, item 6): a passed:0 row must be OMITTED, not rendered with the same
    // "may cover only fixed points" caveat that only applies when the stub actually survived.
    weak: [
      { file: 'test/t.test.mjs', line: 3, name: 'fixed point', fn: 'norm' },
      { file: 'test/t.test.mjs', line: 20, name: 'another fixed point', fn: 'norm' },
    ],
    weakSummary: { norm: { stubbed: 3, passed: 2 }, echo: { stubbed: 1, passed: 0 } },
  };
  const out = formatReport(r);
  assert.match(out, /identity-stub advisory \(--deep\): tests that pass when the function is replaced by a passthrough/);
  assert.match(out, /~ norm: 2 of 3 identity-stub probes passed — may cover only fixed points \(no-op tests do this by design\)/);
  assert.doesNotMatch(out, /~ echo:/, 'a passed:0 fn is a success story (every stub was caught) — omitted, not advised against');
  assert.doesNotMatch(out, /"fixed point"/, 'the per-test list is replaced by the per-fn form — no test names rendered');
});

test('formatReport: zero weak findings render no identity-stub section (byte-level null canary — no --deep)', () => {
  const r = { scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100, weak: [] };
  const out = formatReport(r);
  assert.doesNotMatch(out, /identity-stub advisory/, 'weak: [] (no --deep) must render nothing new');
});

// ---- formatReport: the "every baseline run failed" hint's runner-override list must mention gradle
// (Task 11 — gradle is a real detected/overridable runner now, so the hint should say so) ----
test('formatReport: all-baseline-fail hint lists gradle in the --runner override options', () => {
  const r = {
    scopeError: null, scored: 0, caught: 0, hollow: [], skipped: [],
    inconclusive: [{ file: 't.test.mjs', line: 1, name: 'x', why: 'did-not-run 0p/0f' }],
    probes: 1, runner: 'node', pct: null,
  };
  const out = formatReport(r);
  assert.match(out, /--runner=<[^>]*\bgradle\b[^>]*>/, 'runner override hint should list gradle as an option');
});

// ---- launch pre-mortem vector (reproduced by an external code review): a test whose OWN stdout
// contains summary-shaped lines (`# pass 1` / `# fail 0` progress logs, TAP-ish tool output) must not
// spoof the verdict — the runner's real summary is the LAST such line, not the first. Leftmost-match
// parsing turned a sound test into a false HOLLOW (the spoofed `# fail 0` masked the mutant's real
// failure) and could equally mint a false CAUGHT. ----
test('parseRun: summary-shaped test stdout cannot spoof the verdict (last match wins)', () => {
  const tap = '# pass 1\n# fail 0\nnot ok 1 - spoof\n# tests 1\n# pass 0\n# fail 1\n';
  assert.deepEqual(parseRun('node', tap), { passed: 0, failed: 1 }, 'the real end-of-run summary wins');
  const jest = 'console.log 1 passed\nTests: 1 failed, 0 passed\nTests: 1 failed, 1 total\n';
  const r = parseRun('jest', jest);
  assert.equal(r.failed, 1, 'non-TAP runners take the last summary too');
});

// ---- launch pre-mortem vector (reproduced): a same-named non-exported binding ABOVE the real export
// (`const formatters = { fmt: function (x) {…} }` before `export function fmt`) was gutted instead of
// the export — the test (sound, against the export) then survived → FALSE HOLLOW. locateBody must
// refuse a file with two declaration-shaped matches for the name (the JVM resolver's overload rule,
// applied to JS): grossBreak returns null → the block lands ungutable, never a verdict. ----
test('grossBreak: two declaration-shaped matches for the name in one file -> null (fail-closed)', async () => {
  const { grossBreak } = await import('../mutation/probe.mjs');
  const src = "const formatters = { fmt: function (x) { return 'legacy:' + x; } };\nexport function fmt(x) { return x * 2; }\n";
  assert.equal(grossBreak(src, 'fmt'), null, 'ambiguous declaration site must refuse, not guess');
  const single = 'export function fmt(x) { return x * 2; }\n';
  assert.ok(grossBreak(single, 'fmt').includes('987654321'), 'single declaration still guts (no over-fail)');
});

// ---- the "ungutable" mislabel: the same skip bucket was reached for two different reasons — (a) no
// eligible entry's body was EVER located/mutated (the ctor-name dead-end: `new X().m()` pins the ctor
// name X as a bare callee, X resolves as "eligible" via `class X`, but grossBreak(X) finds no guttable
// body — a class declaration is not a function signature — so the block never mutates anything), vs
// (b) a body WAS located and gutted but the compiler rejected the mutant (gradle compile-fail only).
// Only (b) is honestly "ungutable"; (a) never gutted anything, so it must read "sut-unresolved".
//
// `m` is declared TWICE in src (a free function plus the class's own instance method) so that T2's
// inline receiver-crediting (`jsCreditTypeMethod`'s guard (g), jsDeclSites(srcCode, 'm').length !== 1)
// ALSO refuses this exact shape — otherwise T2 would credit (m, src/lib.mjs) here and the block would
// score PROVEN instead of exercising the dead-end/mislabel path this test exists to lock. (The single-
// declaration version of this exact fixture is now covered as a POSITIVE T2 case — "T2 RED bite" tests
// in test/js-instance-reach.test.mjs.) ----
test('PROVE e2e: the ctor-name dead-end (inline `new X().m()`, no eligible body ever located) reports sut-unresolved, not ungutable', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function m(x) { return x; }\nexport class X { m() { return 5; } }\n',
    'test/t.test.mjs': `${head} import { X } from '../src/lib.mjs';
test('inline ctor dead end', () => { assert.strictEqual(new X().m(), 5); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 0);
    assert.equal(r.hollow.length, 0);
    const s = r.skipped.find((x) => x.name === 'inline ctor dead end');
    assert.ok(s, 'block lands in skipped, never a verdict');
    assert.equal(s.why, 'sut-unresolved', 'no eligible body was ever located/mutated — never the compile-fail label');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- formatReport: tests ALREADY FAILING at HEAD get a first-class side-signal (wild-pilot HEAD-rot
// finding: 5/9 driven repos had failing/non-compiling tests at HEAD, and a PARTIAL baseline-fail set was
// silent in the human report — only the all-fail case had a hint, and only as runner-override suspicion).
// A test that fails before any mutation can't verify anything; the reviewer should fix it first. Scope
// honesty: the signal speaks only about tests gutcheck PROBED (a baseline exists only for eligible blocks),
// never about the whole suite. ----
test('formatReport: partial baseline failures render the already-failing signal with file:line list', () => {
  const r = {
    scopeError: null, scored: 2, caught: 2, hollow: [], skipped: [],
    inconclusive: [
      { file: 'test/a.test.mjs', line: 7, name: 'broken at HEAD', why: 'baseline 0p/1f' },
      { file: 'test/b.test.mjs', line: 12, name: 'did not run', why: 'did-not-run 0p/0f' },
      { file: 'test/c.test.mjs', line: 3, name: 'flaky one', why: 'flaky baseline (unstable green) — not a reliable HOLLOW' },
    ],
    probes: 4, runner: 'node', pct: 100,
  };
  const out = formatReport(r);
  assert.match(out, /1 probed test\(s\) already fail before any mutation — they verify nothing until they pass:/);
  assert.match(out, /test\/a\.test\.mjs:7 {2}'broken at HEAD'/);
  assert.doesNotMatch(out, /test\/b\.test\.mjs:12/, 'a did-not-run row is never an accusation — it never earns the "already fail" label');
  assert.doesNotMatch(out, /c\.test\.mjs:3.*already fail/, 'the flaky bucket is a separate signal, not a baseline failure');
});
test('formatReport: zero baseline failures render no already-failing signal (canary)', () => {
  const r = { scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100 };
  assert.doesNotMatch(formatReport(r), /already fail before any mutation/);
});

// ---- release UX pass: the scored===0 headline must not claim "no value-pinning tests" when pinned
// tests WERE probed and merely ended inconclusive; and the skipped clause must not dangle at 0 ----
test('formatReport: scored=0 with probes/inconclusive says "no verdicts", not "no value-pinning tests"', () => {
  const r = { scopeError: null, scored: 0, caught: 0, hollow: [], skipped: [],
    inconclusive: [{ file: 't.mjs', line: 1, name: 'x', why: 'baseline 0p/1f' }, { file: 't.mjs', line: 5, name: 'y', why: 'baseline 0p/1f' }],
    probes: 2, runner: 'node', pct: null };
  const out = formatReport(r);
  assert.match(out, /no verdicts — 2 test\(s\) probed, all inconclusive/);
  assert.doesNotMatch(out, /no value-pinning tests to probe/);
});
test('formatReport: scored=0 with nothing probed keeps the no-value-pinning wording', () => {
  const r = { scopeError: null, scored: 0, caught: 0, hollow: [], skipped: [{ file: 't', line: 1, name: 'a', why: 'no-pin' }], inconclusive: [], probes: 0, runner: 'node', pct: null };
  assert.match(formatReport(r), /no value-pinning tests to probe/);
});
test('formatReport: the skipped clause appears only when something was skipped', () => {
  const clean = { scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100 };
  assert.doesNotMatch(formatReport(clean), /skipped \(see banner/);
  const some = { ...clean, skipped: [{ file: 't', line: 1, name: 'a', why: 'no-pin' }] };
  assert.match(formatReport(some), /1 test\(s\) skipped \(see banner for reasons\)/);
});
test('formatReport: the ALL-baseline-fail case keeps the runner-override hint, not the partial signal (no double-render)', () => {
  const r = {
    scopeError: null, scored: 0, caught: 0, hollow: [], skipped: [],
    inconclusive: [{ file: 't.test.mjs', line: 1, name: 'x', why: 'did-not-run 0p/0f' }],
    probes: 1, runner: 'node', pct: null,
  };
  const out = formatReport(r);
  assert.match(out, /every baseline run failed before any mutation/);
  assert.doesNotMatch(out, /probed test\(s\) already fail before any mutation/, 'all-fail keeps the runner-suspicion hint only');
});

// ---- release UX pass #2 (verdict truly first): on a diff-scoped run (r.changeSummary present) the
// verdict is LINE 1, the per-status detail sub-lists follow, and the whole-project probe mechanics —
// formerly the CLI's banner() preamble plus this function's own "X/Y tests fail" and "✓ N verified"
// lines — collapse into ONE parenthesized footnote at the very bottom. A full-suite run (no
// changeSummary) must render nothing new (byte-identical to the pre-existing format — see the canary
// test below, plus the CLI-level byte-identical pin in test/gutcheck-cli.test.mjs). ----
test('formatReport: diff-scoped run leads with the diff verdict, then per-status detail, then a single mechanics footnote', () => {
  const r = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 5, runner: 'node', pct: 100,
    changeSummary: { fns: 5, proven: 1, hollow: 0, unverifiable: 0, untested: 4 },
    changes: [
      { fn: 'a', file: 'src/a.mjs', status: 'proven', evidence: { blocks: [{ file: 't.test.mjs', line: 1, name: 'a sound' }] } },
      { fn: 'b', file: 'src/a.mjs', status: 'untested', evidence: {} },
      { fn: 'c', file: 'src/a.mjs', status: 'untested', evidence: {} },
      { fn: 'd', file: 'src/a.mjs', status: 'untested', evidence: {} },
      { fn: 'e', file: 'src/a.mjs', status: 'untested', evidence: {} },
    ],
  };
  const out = formatReport(r);
  const lines = out.split('\n');
  assert.equal(lines[0], 'gutcheck: 5 functions in this diff — 1 proven, 4 with no binding test, 0 hollow.', 'the diff verdict is line 1, exact wording');
  assert.match(out, /no binding test — no test names (it|them) \(4\):/, 'evidence-scoped untested header: name-search found nothing, not a break-catching claim');
  assert.doesNotMatch(out, /change verification:/, 'the redundant counts line is dropped — the lead line already states them');
  // the old whole-project "X/Y tests (Z%) fail..." line is gone entirely — its content now lives only
  // in the trailing mechanics footnote, in the new "caught/scored bound" phrasing.
  assert.doesNotMatch(out, /tests \(100%\) fail/, 'the demoted probe-mechanic sentence is not printed on its own anymore');
  assert.equal(lines[lines.length - 1], '  (probed 5 fns · 1/1 bound · 0 skipped · runner node)', 'the mechanics footnote is the LAST line, single-line, parenthesized');
  assert.ok(out.indexOf('(probed') > out.indexOf('functions in this diff'), 'the footnote trails the diff verdict');
});

test('formatReport: diff-scoped run with a hollow renders the count in CAPS, reordered right after "proven" for prominence', () => {
  const r = {
    scopeError: null, scored: 2, caught: 1, hollow: [{ file: 't.test.mjs', line: 8, name: 'echo', survivors: ['b'] }], skipped: [], inconclusive: [], probes: 2, runner: 'node', pct: 50,
    changeSummary: { fns: 5, proven: 1, hollow: 1, unverifiable: 0, untested: 3 },
    changes: [
      { fn: 'a', file: 'src/a.mjs', status: 'proven', evidence: { blocks: [{ file: 't.test.mjs', line: 1, name: 'a sound' }] } },
      { fn: 'b', file: 'src/a.mjs', status: 'hollow', evidence: { blocks: [{ file: 't.test.mjs', line: 8, name: 'echo' }] } },
      { fn: 'c', file: 'src/a.mjs', status: 'untested', evidence: {} },
      { fn: 'd', file: 'src/a.mjs', status: 'untested', evidence: {} },
      { fn: 'e', file: 'src/a.mjs', status: 'untested', evidence: {} },
    ],
  };
  const out = formatReport(r);
  assert.equal(out.split('\n')[0], 'gutcheck: 5 functions in this diff — 1 proven, 1 HOLLOW, 3 with no binding test.');
  assert.match(out, /hollow — the test passes even when the function is gutted; fix the test \(receipt: gutcheck --explain <file:line>\) \(1\):/, 'reworded, action-oriented hollow header with the --explain receipt pointer');
  // hollow is never demoted: the receipted ✗ file:line 'name' — survives gutting fn() line survives the
  // reorder, and sits between the verdict and the trailing footnote (never inside it).
  assert.match(out, /✗ t\.test\.mjs:8 {2}'echo' {2}— survives gutting b\(\)/, 'the ✗ file:line receipt line is kept, naming the changed fn as the survivor');
  const hollowIdx = out.indexOf('hollow — the test passes');
  const footIdx = out.indexOf('(probed');
  assert.ok(hollowIdx > 0 && footIdx > hollowIdx, 'the hollow section sits between the verdict and the footnote');
  assert.equal(out.split('\n')[out.split('\n').length - 1], '  (probed 2 fns · 1/2 bound · 0 skipped · runner node)', 'mechanics footnote trails everything, single line');
});

// ---- baseline-already-failing warnings stay prominent on a diff-scoped run too — never folded into the
// trailing mechanics footnote (they are actionable: a probed test failing at HEAD proves nothing). ----
test('formatReport: diff-scoped run keeps the baseline-already-failing warning prominent, not in the footnote', () => {
  const r = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [
      { file: 'test/a.test.mjs', line: 7, name: 'broken at HEAD', why: 'baseline 0p/1f' },
    ], probes: 2, runner: 'node', pct: 100,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'a', file: 'src/a.mjs', status: 'proven', evidence: { blocks: [{ file: 't.test.mjs', line: 1, name: 'a sound' }] } }],
  };
  const out = formatReport(r);
  assert.match(out, /⚠️ 1 probed test\(s\) already fail before any mutation — they verify nothing until they pass:/);
  assert.match(out, /test\/a\.test\.mjs:7 {2}'broken at HEAD'/);
  const warnIdx = out.indexOf('⚠️');
  const footIdx = out.indexOf('(probed');
  assert.ok(warnIdx > 0 && footIdx > warnIdx, 'the baseline warning precedes the footnote (prominent, not folded in)');
  assert.doesNotMatch(out.split('\n').pop(), /already fail/, 'the footnote itself carries no baseline-fail text');
});

test('formatReport: the diff verdict lead appends "· N unverifiable" only when unverifiable > 0', () => {
  const clean = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100,
    changeSummary: { fns: 2, proven: 1, hollow: 0, unverifiable: 0, untested: 1 }, changes: [],
  };
  assert.doesNotMatch(formatReport(clean), /unverifiable/, 'zero unverifiable renders no suffix in the lead line');
  const withUnverifiable = { ...clean, changeSummary: { fns: 3, proven: 1, hollow: 0, unverifiable: 2, untested: 0 } };
  const out = formatReport(withUnverifiable);
  assert.equal(out.split('\n')[0], 'gutcheck: 3 functions in this diff — 1 proven, 0 with no binding test, 0 hollow · 2 unverifiable.');
});

// ---- Task 7: same-diff-oracle provenance + probe-cap-out-of-unverifiable — both fragments render only
// when their count is > 0, FACT-ONLY wording (states what changed alongside what, never a verdict). ----
test('formatReport: the diff verdict lead appends the same-diff-oracle provenance count only when sameDiffProven > 0', () => {
  const base = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100,
    changeSummary: { fns: 2, proven: 1, hollow: 0, unverifiable: 0, untested: 1 }, changes: [],
  };
  assert.doesNotMatch(formatReport(base), /via tests changed in this diff/, 'zero sameDiffProven renders no fragment');
  const withProvenance = { ...base, changeSummary: { ...base.changeSummary, sameDiffProven: 1 } };
  const out = formatReport(withProvenance);
  assert.equal(out.split('\n')[0], 'gutcheck: 2 functions in this diff — 1 proven (1 via tests changed in this diff), 1 with no binding test, 0 hollow.');
});
test('formatReport: the diff verdict lead appends "N not probed (cap)" only when notProbed > 0', () => {
  const base = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100,
    changeSummary: { fns: 2, proven: 1, hollow: 0, unverifiable: 0, untested: 1 }, changes: [],
  };
  assert.doesNotMatch(formatReport(base), /not probed \(cap\)/, 'zero notProbed renders no fragment');
  const withCap = { ...base, changeSummary: { ...base.changeSummary, notProbed: 1 } };
  const out = formatReport(withCap);
  assert.equal(out.split('\n')[0], 'gutcheck: 2 functions in this diff — 1 proven, 1 with no binding test, 0 hollow · 1 not probed (cap).');
});
// The unverifiable DETAIL section: a probe-cap row moves out from under the "unverifiable —" header and
// under its own "not probed (cap) —" header instead, using the reference-evidence fn name only (no
// per-fn reason text needed — the section header already states the reason for every row in it).
test('formatReport: a probe-cap unverifiable row renders under its own "not probed (cap)" detail section, not under "unverifiable"', () => {
  const r = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100,
    changeSummary: { fns: 2, proven: 1, hollow: 0, unverifiable: 0, untested: 0, notProbed: 1 },
    changes: [
      { fn: 'a', file: 'src/a.mjs', status: 'proven', evidence: { blocks: [{ file: 't.test.mjs', line: 1, name: 'a sound' }] } },
      { fn: 'b', file: 'src/a.mjs', status: 'unverifiable', evidence: { reason: 'probe-cap', reasons: { 'probe-cap': 1 }, blocks: [{ file: 't.test.mjs', line: 5, name: 'b cap' }] } },
    ],
  };
  const out = formatReport(r);
  assert.doesNotMatch(out, /unverifiable — a test exists/, 'no genuinely-unverifiable row, so that header never renders');
  assert.match(out, /not probed \(cap\) — probe cap or time budget reached before these could be checked \(1\):/);
  assert.match(out, /  b/);
});

// ---- release UX pass #2: the unverifiable section is reworded to plain English — no raw why-codes
// (no-pin/sut-unresolved/…) in the reader-facing text. Each known code maps to a readable phrase; an
// inconclusive-flavored reason (baseline/flaky/ambiguous) reads as "the referencing test is
// inconclusive"; anything else falls back to the raw reason verbatim. ----
test('formatReport: the unverifiable section header and per-fn reason are plain English, not raw why-codes', () => {
  const r = {
    scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 2, runner: 'node', pct: 100,
    changeSummary: { fns: 2, proven: 1, hollow: 0, unverifiable: 1, untested: 0 },
    changes: [
      { fn: 'a', file: 'src/a.mjs', status: 'proven', evidence: { blocks: [{ file: 't.test.mjs', line: 1, name: 'a sound' }] } },
      { fn: 'saveOrder', file: 'src/order.mjs', status: 'unverifiable', evidence: { reason: 'no-pin', reasons: { 'no-pin': 1 }, blocks: [{ file: 't.test.mjs', line: 5, name: 'saveOrder persists' }] } },
    ],
  };
  const out = formatReport(r);
  assert.match(out, /unverifiable — a test exists but I can't confirm it binds the function \(1\):/, 'plain-English header, no jargon');
  assert.match(out, /saveOrder \(only checks a mock \/ no value pinned\)/, 'no-pin reads as a plain phrase, exact wording from spec');
  assert.doesNotMatch(out, /\(no-pin\)/, 'the raw why-code never leaks into the reader-facing text');
});
test('formatReport: every mapped unverifiable why-code reads as plain English (sut-unresolved/dynamic-title/ungutable/instrumented-test/unsupported-source-set), and an inconclusive-flavored reason reads as one readable phrase', () => {
  const mk = (reason) => ({
    scopeError: null, scored: 0, caught: 0, hollow: [], skipped: [], inconclusive: [], probes: 0, runner: 'node', pct: null,
    changeSummary: { fns: 1, proven: 0, hollow: 0, unverifiable: 1, untested: 0 },
    changes: [{ fn: 'x', file: 's.mjs', status: 'unverifiable', evidence: { reason, reasons: { [reason]: 1 }, blocks: [{ file: 't.mjs', line: 1, name: 't' }] } }],
  });
  assert.match(formatReport(mk('sut-unresolved')), /x \(can't locate the function from the test's imports\)/);
  assert.match(formatReport(mk('dynamic-title')), /x \(test name is computed at runtime\)/);
  assert.match(formatReport(mk('ungutable')), /x \(function body can't be safely mutated\)/);
  assert.match(formatReport(mk('instrumented-test')), /x \(needs a device\/emulator\)/);
  assert.match(formatReport(mk('unsupported-source-set')), /x \(unsupported Gradle source set\)/);
  assert.match(formatReport(mk('baseline 0p/1f')), /x \(the referencing test is inconclusive\)/, 'a baseline-flavored inconclusive reason reads as one readable phrase');
  assert.match(formatReport(mk('flaky baseline (unstable green) — not a reliable HOLLOW')), /x \(the referencing test is inconclusive\)/);
  assert.match(formatReport(mk('ambiguous title — another test in this file matches the same runner selection')), /x \(the referencing test is inconclusive\)/);
  assert.match(formatReport(mk('mutant ran 0 tests')), /x \(mutant ran 0 tests\)/, 'an unmapped reason falls back to the raw reason, verbatim, in parens');
});

test('formatReport: a full-scan run (no changeSummary) renders no diff-verdict lead — byte-identical to the pre-existing format', () => {
  const r = { scopeError: null, scored: 1, caught: 1, hollow: [], skipped: [], inconclusive: [], probes: 1, runner: 'node', pct: 100 };
  const out = formatReport(r);
  assert.equal(out, 'gutcheck: 1/1 tests (100%) fail when the function they test is broken.  [1 probes, runner: node]\n✓ 1 function verified: gutted each, its test went red.');
  assert.doesNotMatch(out, /in this diff/, 'no diff-verdict lead when there is no diff scope');
});

// ---- diff scope ----
const TWOFILE = {
  'package.json': '{"type":"module"}',
  'src/lib.mjs': SUT,
  'test/a.test.mjs': `${head} import { add } from '../src/lib.mjs';\ntest('a sound', () => { assert.strictEqual(add(1, 2), 3); });`,
  'test/b.test.mjs': `${head} import { fmt } from '../src/lib.mjs';\ntest('b sound', () => { assert.strictEqual(fmt(5), '$5.00'); });`,
};
test('PROVE --scope: only blocks whose test file OR a probed source file changed are probed', () => {
  const d = project(TWOFILE);
  try {
    // only test/a changed → b is out of scope
    const onlyA = prove(d, { runner: 'node', changed: new Set([resolve(d, 'test/a.test.mjs')]) });
    assert.equal(onlyA.caught, 1);
    assert.equal(onlyA.outOfScope, 1);
    // a shared SOURCE file changed → BOTH tests are in scope, even though neither test file changed
    const srcChanged = prove(d, { runner: 'node', changed: new Set([resolve(d, 'src/lib.mjs')]) });
    assert.equal(srcChanged.caught, 2);
    assert.equal(srcChanged.outOfScope, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// ---- ambiguity gates ONLY would-be-probed blocks: an out-of-scope ambiguous block must stay in its own
// bucket (outOfScope), never leak into inconclusive — otherwise every diff-scoped run (the Stop hook, the
// corpus re-drive) gets corrupted outOfScope/inconclusive denominators from files it didn't even touch. ----
test('PROVE: ambiguity applies only to would-be-probed blocks — out-of-scope ambiguous blocks stay outOfScope', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function add(a,b){ return a+b; }\nexport function dbl(x){ return x*2; }\n',
    'test/amb.test.mjs': `${head} import { add } from '../src/lib.mjs';
test('dup', () => { assert.strictEqual(add(1, 2), 3); });
test('dup', () => { assert.strictEqual(add(2, 2), 4); });
`,
    'test/other.test.mjs': `${head} import { dbl } from '../src/lib.mjs';
test('other', () => { assert.strictEqual(dbl(3), 6); });
`,
  });
  try {
    // only test/other changed → the ambiguous file is OUT of scope: counted there, never inconclusive
    const out = prove(d, { runner: 'node', changed: new Set([resolve(d, 'test/other.test.mjs')]) });
    assert.equal(out.outOfScope, 2, 'both out-of-scope ambiguous blocks count in outOfScope');
    assert.equal(out.inconclusive.length, 0, 'no ambiguity verdict on an out-of-scope block');
    assert.equal(out.caught, 1, 'the in-scope block is probed normally');
    // the ambiguous file itself changed → in scope → fail-closed to inconclusive with the exact reason
    const inn = prove(d, { runner: 'node', changed: new Set([resolve(d, 'test/amb.test.mjs')]) });
    assert.equal(inn.outOfScope, 1, 'the unrelated file is out of scope');
    assert.equal(inn.inconclusive.length, 2, 'both in-scope ambiguous blocks are fail-closed');
    assert.ok(inn.inconclusive.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'),
      'the exact contract string is reported');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// changedFilesSince returns canonKey'd absolute paths (win32: realpath.native'd + casefolded, so a raw
// forward-slash-anchored endsWith would never match a backslash-form key there) — the assertion side
// must build its expectation the SAME way, via canonKey, never a rendered '/'-joined string (comparison
// keys are never compared against display forms).
test('changedFilesSince: tracked edits and untracked new files since a ref', () => {
  const d = project({ 'package.json': '{"type":"module"}', 'src/lib.mjs': SUT });
  try {
    execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init', { cwd: d });
    writeFileSync(join(d, 'src/lib.mjs'), SUT + '\n// edit');
    writeFileSync(join(d, 'src/new.mjs'), 'export const x = 1;\n');
    const changed = changedFilesSince(d, 'HEAD');
    assert.ok(changed.has(canonKey(join(d, 'src/lib.mjs'))), 'tracked edit seen');
    assert.ok(changed.has(canonKey(join(d, 'src/new.mjs'))), 'untracked new file seen');
    assert.equal(changedFilesSince(d, 'no-such-ref'), null, 'bad ref → null');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a symlinked project path must not silently drop in-scope tests ----
// git resolves --show-toplevel to the CANONICAL path, so the changed-file set is canonical; if prove
// keeps a non-canonical (symlinked) dir, absTest never matches `changed` and every block is dropped as
// out-of-scope — a silent false negative (a real hollow test missed). prove must canonicalize its dir.
// symlinkSync(real, link) below creates a DIRECTORY symlink (real is a dir) — Windows gates directory
// symlink creation behind SeCreateSymbolicLinkPrivilege (admin, or Developer Mode enabled), which CI
// runners don't grant by default, so this is a privilege limitation of the test fixture, not a product
// behavior gap; canonKey's win32 path (Task 1) is exercised by the unix-runnable tests instead.
test('PROVE --since via a symlinked project path scopes correctly (canonical git root)', { skip: process.platform === 'win32' ? 'symlink creation is privilege-gated on Windows' : false }, () => {
  const real = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function total(items){ return items.reduce((s,i)=>s+i.p*i.q,0); }\n',
  });
  execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init', { cwd: real });
  mkdirSync(join(real, 'test'), { recursive: true }); // the agent "just wrote" an untracked hollow test
  writeFileSync(join(real, 'test/t.test.mjs'), `${head} import { total } from '../src/lib.mjs';
test('totals', () => { const e = total([{p:2,q:3}]); assert.strictEqual(total([{p:2,q:3}]), e); });
`);
  const link = `${real}-link`;
  symlinkSync(real, link);
  try {
    const r = prove(link, { runner: 'node', since: 'HEAD' });
    assert.equal(r.outOfScope, 0, 'the changed test is in scope despite the symlinked path');
    assert.equal(r.hollow.length, 1, 'the hollow test is found, not silently dropped');
  } finally { rmSync(link, { force: true }); rmSync(real, { recursive: true, force: true }); }
});

// ---- the probe cap bounds latency and is reported, never a silent truncation (R6) ----
test('PROVE maxProbes caps the probed blocks and reports the cap (no silent truncation)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function a(x){return x+1;}\nexport function b(x){return x+2;}\nexport function c(x){return x+3;}\n',
    'test/t.test.mjs': `${head} import { a, b, c } from '../src/lib.mjs';
test('a', () => { assert.strictEqual(a(1), 2); });
test('b', () => { assert.strictEqual(b(1), 3); });
test('c', () => { assert.strictEqual(c(1), 4); });
`,
  });
  try {
    const full = prove(d, { runner: 'node' });
    assert.equal(full.caught, 3, 'all three are probed without a cap');
    const capped = prove(d, { runner: 'node', maxProbes: 1 });
    assert.equal(capped.probes, 1, 'only one block probed under maxProbes:1');
    assert.equal(capped.capped, 2, 'the other two are reported as capped, not silently dropped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE capped blocks keep reference evidence in changeSummary — no false untested', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-caphonest-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
    // Oracles derived by arithmetic, independent of the implementations.
    writeFileSync(join(d, 'src/a.mjs'), 'export function add(x, y) { return x + y; }\n');
    writeFileSync(join(d, 'src/b.mjs'), 'export function mul(x, y) { return x * y; }\n');
    writeFileSync(join(d, 'test/a.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { add } from '../src/a.mjs';\n" +
      "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n");
    writeFileSync(join(d, 'test/b.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { mul } from '../src/b.mjs';\n" +
      "test('muls', () => { assert.strictEqual(mul(2, 3), 6); });\n");
    const changed = new Set([resolve(d, 'src/a.mjs'), resolve(d, 'src/b.mjs'), resolve(d, 'test/a.test.mjs'), resolve(d, 'test/b.test.mjs')]);
    const r = prove(d, { runner: 'node', maxProbes: 1, changed });
    assert.ok(r.capped >= 1, `the cap must bite for this test to mean anything: ${JSON.stringify({ capped: r.capped, probes: r.probes })}`);
    assert.equal(r.changeSummary.untested, 0,
      `a fn referenced only by a capped block must read unverifiable, not untested: ${JSON.stringify(r.changes)}`);
    assert.ok(r.changes.some((c) => c.status === 'unverifiable' && c.evidence.reason === 'probe-cap'),
      JSON.stringify(r.changes));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a wall-clock budget caps the probe pass the same way maxProbes does (JVM hook viability: a
// count cap can't bound a slow runner's wall-clock cost) — same honest-cap record, same vocabulary ----
test('PROVE timeBudgetMs caps remaining blocks honestly (probe-cap records, no false untested)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-timebudget-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'src/a.mjs'), 'export function add(x, y) { return x + y; }\n');
    writeFileSync(join(d, 'src/b.mjs'), 'export function mul(x, y) { return x * y; }\n');
    writeFileSync(join(d, 'test/a.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { add } from '../src/a.mjs';\n" +
      "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n");
    writeFileSync(join(d, 'test/b.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { mul } from '../src/b.mjs';\n" +
      "test('muls', () => { assert.strictEqual(mul(2, 3), 6); });\n");
    const changed = new Set([resolve(d, 'src/a.mjs'), resolve(d, 'src/b.mjs'), resolve(d, 'test/a.test.mjs'), resolve(d, 'test/b.test.mjs')]);
    // timeBudgetMs: -1 — already exceeded before the first probe, deterministically. Every eligible
    // block must land capped with a probe-cap record; nothing scored; nothing false.
    const r = prove(d, { runner: 'node', timeBudgetMs: -1, changed });
    assert.equal(r.scored, 0);
    assert.ok(r.capped >= 1);
    assert.equal(r.changeSummary.untested, 0, JSON.stringify(r.changes));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('PROVE a generous time budget changes nothing', () => {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-timebudget-ok-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'src/a.mjs'), 'export function add(x, y) { return x + y; }\n');
    writeFileSync(join(d, 'test/a.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { add } from '../src/a.mjs';\n" +
      "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n");
    const changed = new Set([resolve(d, 'src/a.mjs'), resolve(d, 'test/a.test.mjs')]);
    const r = prove(d, { runner: 'node', timeBudgetMs: 600000, changed });
    assert.ok(r.scored > 0);
    assert.equal(r.capped, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Task 6: diff-priority probe scheduling — under a probe cap, ORDER decides what gets verified.
// The wedge is agent-written tests, so a test file the diff touched must be probed before an untouched
// one that's merely in scope by referencing a changed SUT, regardless of where the filesystem walk
// happens to put them. Fixture: two SUT files, both changed (so neither test file is filtered out as
// out-of-scope); only test/b.test.mjs is itself a changed (diff-touched) test file — test/a.test.mjs is
// pre-existing and stays in scope solely because it references the changed src/a.mjs. `a` sorts first in
// fs/directory order (`test/a.test.mjs` < `test/b.test.mjs`). Under maxProbes:1 only ONE block can run;
// it must be b's — the diff's own test, not the untouched backlog.
function diffPriorityFixture() {
  return project({
    'package.json': '{"type":"module"}',
    'src/a.mjs': 'export function un(x) { return x + 1; }\n',
    'src/b.mjs': 'export function ch(x) { return x + 2; }\n',
    'test/a.test.mjs': `${head} import { un } from '../src/a.mjs';
test('un', () => { assert.strictEqual(un(1), 2); });
`,
    'test/b.test.mjs': `${head} import { ch } from '../src/b.mjs';
test('ch', () => { assert.strictEqual(ch(1), 3); });
`,
  });
}
function diffPriorityChanged(d) {
  return new Set([resolve(d, 'src/a.mjs'), resolve(d, 'src/b.mjs'), resolve(d, 'test/b.test.mjs')]);
}
test('PROVE: under a probe cap, a changed test file is probed before an unchanged one', () => {
  const d = diffPriorityFixture();
  try {
    const r = prove(d, { runner: 'node', maxProbes: 1, changed: diffPriorityChanged(d) });
    assert.equal(r.outOfScope, 0, 'both blocks stay in scope (a via its changed SUT, b as a changed test file)');
    assert.equal(r.probes, 1, 'the cap allows exactly one block to run');
    assert.equal(r.capped, 1, 'the other block is capped, not silently dropped');
    // `ch` (src/b.mjs, changed, referenced by the changed test/b.test.mjs) must come back PROVEN — the
    // single available probe was spent on the diff's own test. `un` (src/a.mjs, changed, but referenced
    // only by the pre-existing untouched test/a.test.mjs) must be the one that got capped instead.
    const chChange = r.changes.find((c) => c.fn === 'ch');
    const unChange = r.changes.find((c) => c.fn === 'un');
    assert.ok(chChange && unChange, `expected change entries for both ch and un: ${JSON.stringify(r.changes)}`);
    assert.equal(chChange.status, 'proven',
      `the diff's own test (b) must be probed under the cap, not the untouched backlog (a): ${JSON.stringify(r.changes)}`);
    assert.equal(unChange.status, 'unverifiable', `the untouched backlog test (a) must be the one capped, not proven: ${JSON.stringify(r.changes)}`);
    assert.equal(unChange.evidence.reason, 'probe-cap', JSON.stringify(r.changes));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('PROVE: diff-priority probe order is deterministic across repeated runs', () => {
  const d = diffPriorityFixture();
  try {
    const changed = diffPriorityChanged(d);
    const r1 = prove(d, { runner: 'node', maxProbes: 1, changed });
    const r2 = prove(d, { runner: 'node', maxProbes: 1, changed });
    // Substantive content first (r1===r2 alone is trivially true of a stubbed/broken prove() that always
    // returns the same constant shape — the real claim here is that THIS specific, correct shape repeats).
    const chChange1 = r1.changes.find((c) => c.fn === 'ch');
    assert.ok(chChange1 && chChange1.status === 'proven', `expected ch proven on run 1: ${JSON.stringify(r1.changes)}`);
    assert.equal(r1.capped, 1, 'expected exactly one capped block on run 1');
    assert.equal(JSON.stringify(r1), JSON.stringify(r2),
      'two identical runs over the same fixture/opts must produce byte-identical JSON');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- a flaky test must never be reported HOLLOW (R5) ----
// The fixture passes its first two runs (the unmutated baseline, then the gutted mutant — its oracle
// re-runs the SUT so the gross break can't break it) and throws on its THIRD run. Without the flake
// guard prove sees baseline-green + mutant-survives and calls it HOLLOW; with the guard it re-runs the
// unmutated test before declaring HOLLOW, the third run fails, and the verdict is INCONCLUSIVE.
test('PROVE: a flaky test (unstable green) is INCONCLUSIVE, never a false HOLLOW', () => {
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
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0, 'a flaky test must not be reported HOLLOW');
    assert.ok(r.inconclusive.some((x) => /flaky/.test(x.why)), 'flaky test → inconclusive');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- ambiguous SUT resolution must never produce a false HOLLOW ----
test('PROVE: a fn name declared in two source files resolves to the IMPORTED one (no false HOLLOW)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/real.mjs': 'export function area(r){ return 3.14159 * r * r; }\n',
    'src/decoy.mjs': 'export function area(r){ return 0; }\n', // same name, NOT imported by the test
    'test/t.test.mjs': `${head} import { area } from '../src/real.mjs';
test('area', () => { assert.strictEqual(Math.round(area(2)), 13); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // import-aware binding resolves `area` to the IMPORTED real.mjs (decoy is ignored), so it is probed + caught
    assert.equal(r.caught, 1, 'the imported SUT is resolved and caught, not skipped');
    assert.ok(!r.hollow.some((h) => h.name === 'area'), 'still never a false hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// NOTE on this fixture: a second real, independently-resolvable SUT call in the same block (e.g. a `run()`
// imported from its own source file) would mask the bug under test — if THAT call genuinely breaks when
// gutted, the block is reported "caught" regardless of whether `join` is (mis)bound, because `prove()`
// ORs catch-status across every probed fn in a block. So `join` must be the ONLY probed/resolvable fn here
// for this test to actually discriminate buggy vs. fixed binding (verified empirically while implementing:
// the brief's original run()+join() combo produces hollow.length===0 under BOTH the buggy and the fixed
// resolver — it never bites).
test('PROVE: an incidental builtin call (path.join) is never bound to a same-named local helper (no false HOLLOW)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/util.mjs': "export const join = (t) => t.join('\\n');\n", // a LOCAL helper named join, NOT imported by the test
    'test/t.test.mjs': `${head} import { join } from 'node:path';
test('exits 2 when missing', () => { const status = ['--config', join('a', 'b'), 'missing'].includes('missing') ? 2 : 0; assert.strictEqual(status, 2); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.hollow.length, 0, 'a good test must not be flagged hollow for an incidental path.join');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python ast precision path: unittest self.assertEqual is recognized (the regex pinnedFragments misses it) ----
test('PROVE python: a unittest self.assertEqual block is probed (not skipped)', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': 'def add(a, b):\n    return a + b\n',
    'test_calc.py': 'import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n',
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.skipped.some((s) => s.name === 'test_add'), 'assertEqual block must be eligible, not skipped');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python precision-path REGRESSION: assertNotAlmostEqual is an INEQUALITY assertion — pinning it lets
// the gross sentinel (987654321) pass unchanged (still "not almost equal"), producing a false HOLLOW on a
// correct test. ----
test('PROVE python: assertNotAlmostEqual is never pinned (no false HOLLOW on a correct test)', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'near.py': 'def near(a, b):\n    return a + b\n',
    'test_near.py': 'import unittest\nfrom near import near\nclass T(unittest.TestCase):\n    def test_near(self):\n        self.assertNotAlmostEqual(near(2, 3), 999.0)\n',
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.hollow.some((h) => h.name === 'test_near'), 'an inequality assertion must never be pinned — no false HOLLOW');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python precision-path REGRESSION: an attribute/method call (`Service().process(...)`) must NOT be
// pinned under its bare attribute name — doing so lets the SUT resolver bind a same-named but unrelated
// free function (`from helpers import process`) and gut the WRONG file, producing a false HOLLOW. ----
test('PROVE python: an attribute call is not pinned under its bare name (no cross-file false HOLLOW)', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'helpers.py': 'def process(x):\n    return x * 3\n',
    'test_service.py': [
      'import unittest',
      'from helpers import process',
      '',
      'class Service:',
      '    def process(self, x):',
      '        return x * 2',
      '',
      'class T(unittest.TestCase):',
      '    def test_process(self):',
      '        self.assertEqual(Service().process(2), 4)',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.hollow.some((h) => h.name === 'test_process'), 'Service().process must not be mis-bound to the free helpers.process (no false HOLLOW)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Python precision-path REGRESSION: a module that binds NAME via BOTH `class Calc` and a same-named
// `def Calc(...)` factory rebinds the module-level name at import time — the CLASS (defined last) is what
// actually runs. `pins=['Calc']` resolves via resolvePySut's declRe (either alternative matches), but
// gut-time's jsSigRegex has no `class NAME` form, so it always guts the (dead, shadowed) factory — the
// mutant never touches the code the test actually exercises, so a SOUND test survives it → false HOLLOW.
// resolvePySut must refuse (return null) when both a `class NAME` and a def/assign-style declaration for
// NAME are present in the resolved module — mirrors the JVM same-file-overload ambiguity rule. ----
test('PROVE python: a class+factory name collision (`class Calc` + `def Calc`) refuses, not a false HOLLOW', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': [
      'def Calc(x=None):',
      '    return x',
      '',
      'class Calc:',
      '    def add(self, a, b):',
      '        return a + b',
      '',
    ].join('\n'),
    'test_calc.py': [
      'import unittest',
      'from calc import Calc',
      '',
      'class T(unittest.TestCase):',
      '    def test_add(self):',
      '        self.assertEqual(Calc().add(2, 3), 5)',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.ok(!r.hollow.some((h) => h.name === 'test_add'), 'class+factory collision must never mint a HOLLOW verdict');
    assert.ok(!r.caught, 'and must never mint a CAUGHT verdict either — this is a refusal, not a resolved probe');
    const s = r.skipped.find((x) => x.name === 'test_add');
    assert.ok(s, 'the block must land in skipped, never a verdict');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- node:test describe-qualified selection (Task 1 — recall recovery). Never gated: node IS the
// current runtime, always available. Empirically verified (manually, before writing this test) that
// node's --test-name-pattern matches PER-LEVEL: an anchored BARE pattern (`^same title$`) matches every
// nested test sharing that own name regardless of which describe it's under — so anchoring alone does not
// disambiguate, only the FULL describe-qualified name (still anchored) does. That per-level-matching fact
// is what this pair of tests proves end to end (not just doc-claimed).
test('PROVE node e2e: a bare-title collision across describes is resolved by describe-path qualification (recall recovery)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-node-qual-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), "export function makeSlug(x){ return String(x) + '-abc'; }\n");
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { describe, it } from 'node:test'; import assert from 'node:assert';\n" +
    "import { makeSlug } from '../src/lib.mjs';\n" +
    "describe('starter tier', () => { it('same title', () => { const slug1 = makeSlug(5); assert.strictEqual(slug1.split('-')[0], '5'); }); });\n" +
    "describe('growth tier', () => { it('same title', () => { const s1 = makeSlug(5); assert.strictEqual(makeSlug(5), s1); }); });\n");
  try {
    const r = prove(d, { runner: 'node' });
    if (NODE_MAJOR >= 22) {
      assert.equal(r.inconclusive.length, 0, 'no ambiguous-title inconclusive — qualification resolved it');
      assert.equal(r.probes, 3, 'both blocks were actually probed, isolated from each other');
      assert.equal(r.caught, 1, 'the starter-tier block (crashes under the mutation) is caught');
      assert.ok(r.hollow.some((h) => h.name === 'same title'), 'the growth-tier self-comparison block is HOLLOW');
      // path/qualified-name leakage check: the report entries never carry a `path` or qualified-name field —
      // qualification is a selection-only detail (see prove()'s per-block loop comment).
      assert.deepEqual(Object.keys(r.hollow[0]).sort(), ['file', 'line', 'name', 'survivorPairs', 'survivors']);
    } else {
      // Node <22: measured limitation (see NODE_MAJOR comment above) — the qualified pattern 0-matches on
      // this runtime, so both blocks correctly fail closed instead of recovering (never a wrong verdict).
      assert.equal(r.inconclusive.length, 2, 'Node <22: qualification cannot select either block — both stay fail-closed');
      assert.equal(r.probes, 0);
      assert.equal(r.caught, 0);
      assert.equal(r.hollow.length, 0);
      assert.ok(r.inconclusive.every((i) => i.why === 'did-not-run 0p/0f'));
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('PROVE node e2e: IDENTICAL describe path + title (residual ambiguity) still fails closed after qualification', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-node-residual-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), "export function makeSlug(x){ return String(x) + '-abc'; }\n");
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { describe, it } from 'node:test'; import assert from 'node:assert';\n" +
    "import { makeSlug } from '../src/lib.mjs';\n" +
    "describe('growth tier', () => { it('same title', () => { const slug1 = makeSlug(5); assert.strictEqual(slug1.split('-')[0], '5'); }); });\n" +
    "describe('growth tier', () => { it('same title', () => { const s1 = makeSlug(5); assert.strictEqual(makeSlug(5), s1); }); });\n");
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0); assert.equal(r.probes, 0, 'no probe wasted on a residual ambiguity');
    const named = r.inconclusive.filter((i) => i.name === 'same title');
    assert.equal(named.length, 2, 'both identical describe-path+title blocks stay fail-closed');
    assert.ok(named.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- escape-aware title capture, full round trip (Task 2): parseBlocks captures the REAL (unescaped)
// title, prove() selects by it via testCmdFor's reEsc, and the real runner reports back against it — a
// single JS regex-capture bug anywhere in this chain (the pre-fix truncation/stray-backslash class) would
// turn this into a silent selection mismatch (0 tests matched), which reads as HOLLOW, not a crash. Node is
// used because it's always available (no gating needed) and proves the same capture→select→run loop every
// other runner's e2e above already proves for plain titles.
test('PROVE node e2e: an escaped-quote test title round-trips through capture, selection, and the real runner (the ledger case)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-node-escq-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { it } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "it('caught\\'s edge', () => { assert.strictEqual(dbl(3), 6); });\n");
  try {
    const r = prove(d, { runner: 'node' });
    assert.equal(r.inconclusive.length, 0, 'the escaped-quote title selects cleanly — no baseline/selection mismatch');
    assert.equal(r.skipped.length, 0);
    assert.equal(r.probes, 1);
    assert.equal(r.caught, 1, 'gutting dbl() makes this test fail — the probe proved it genuinely tests dbl()');
    assert.equal(r.hollow.length, 0, 'must NOT misread as hollow — the pre-fix failure mode this test guards against');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// The describe-path qualification from Task 1 must also round-trip an escaped quote IN THE DESCRIBE
// TITLE: two describes share a bare test title ('same title'), and the FIRST describe's own title has an
// escaped apostrophe. qualifiedName() joins path+name for selection — if the describe title were still
// captured with a stray backslash (or truncated), the qualified selector would never match the real
// runtime full name, and the block would misattribute or go inconclusive instead of resolving cleanly.
test('PROVE node e2e: an escaped-quote DESCRIBE title still qualifies and disambiguates a colliding test title (qualification path round-trip)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-node-escq-qual-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), "export function makeSlug(x){ return String(x) + '-abc'; }\n");
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { describe, it } from 'node:test'; import assert from 'node:assert';\n" +
    "import { makeSlug } from '../src/lib.mjs';\n" +
    "describe('starter tier\\'s config', () => { it('same title', () => { const slug1 = makeSlug(5); assert.strictEqual(slug1.split('-')[0], '5'); }); });\n" +
    "describe('growth tier', () => { it('same title', () => { const s1 = makeSlug(5); assert.strictEqual(makeSlug(5), s1); }); });\n");
  try {
    const r = prove(d, { runner: 'node' });
    if (NODE_MAJOR >= 22) {
      assert.equal(r.inconclusive.length, 0, 'the escaped-quote describe title still qualifies and resolves the collision');
      assert.equal(r.probes, 3, 'both blocks isolated and probed');
      assert.equal(r.caught, 1, 'the starter-tier block (crashes under the mutation) is caught');
      assert.ok(r.hollow.some((h) => h.name === 'same title'), 'the growth-tier self-comparison block is HOLLOW');
    } else {
      // Node <22: same measured limitation as the plain-title e2e above (see NODE_MAJOR comment) — the
      // escaped-quote describe title round-trips fine (capture is not the issue here), but the qualified
      // pattern still 0-matches on this runtime, so both blocks fail closed instead of recovering.
      assert.equal(r.inconclusive.length, 2, 'Node <22: qualification cannot select either block — both stay fail-closed');
      assert.equal(r.probes, 0);
      assert.equal(r.caught, 0);
      assert.equal(r.hollow.length, 0);
      assert.ok(r.inconclusive.every((i) => i.why === 'did-not-run 0p/0f'));
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- gated end-to-end: the real mocha/ava binaries run against a synthetic project. Skips cleanly
// when the runner isn't installed (HAS_MOCHA/HAS_AVA above) — the fixture-based parseRun tests and
// the runner-completeness meta-test above carry the CI precision coverage for these runners. ----
test('PROVE mocha e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_MOCHA }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"mocha":"*"}}',
    'src/lib.js': 'function add(a,b){return a+b;} function total(x){return x.reduce((s,i)=>s+i,0);} module.exports={add,total};',
    'test/t.test.js': `const assert=require('node:assert');const {add,total}=require('../src/lib.js');
describe('s',function(){
  it('add sound',function(){ assert.strictEqual(add(2,3),5); });
  it('shadow',function(){ const e=total([1,2]); assert.strictEqual(total([1,2]),e); });
});`,
  });
  try {
    assert.equal(detectRunner(d), 'mocha');
    const r = prove(d, { runner: 'mocha' });
    assert.ok(r.caught >= 1, 'the sound add test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'shadow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'add sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// mocha is the one runner whose qualified selection must ANCHOR (^...$) — its default --grep is an
// unanchored regex, so an unqualified substring collision risk remains at the qualified-name level too
// without it (see testCmdFor / residualAmbiguous). Both properties proven end to end here.
test('PROVE mocha e2e: a bare-title collision across describes is resolved by describe-path qualification (recall recovery)', { skip: !HAS_MOCHA }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"mocha":"*"}}',
    'src/lib.js': "function makeSlug(x){ return String(x) + '-abc'; } module.exports = { makeSlug };\n",
    'test/t.test.js': `const assert=require('node:assert');const {makeSlug}=require('../src/lib.js');
describe('starter tier',function(){
  it('same title',function(){ const slug1=makeSlug(5); assert.strictEqual(slug1.split('-')[0],'5'); });
});
describe('growth tier',function(){
  it('same title',function(){ const s1=makeSlug(5); assert.strictEqual(makeSlug(5),s1); });
});`,
  });
  try {
    const r = prove(d, { runner: 'mocha' });
    assert.equal(r.inconclusive.length, 0, 'no ambiguous-title inconclusive — qualification resolved it');
    assert.equal(r.probes, 3);
    assert.equal(r.caught, 1, 'the starter-tier block (crashes under the mutation) is caught');
    assert.ok(r.hollow.some((h) => h.name === 'same title'), 'the growth-tier self-comparison block is HOLLOW');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('PROVE mocha e2e: IDENTICAL describe path + title (residual ambiguity) still fails closed after qualification', { skip: !HAS_MOCHA }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"mocha":"*"}}',
    'src/lib.js': "function makeSlug(x){ return String(x) + '-abc'; } module.exports = { makeSlug };\n",
    'test/t.test.js': `const assert=require('node:assert');const {makeSlug}=require('../src/lib.js');
describe('growth tier',function(){
  it('same title',function(){ const slug1=makeSlug(5); assert.strictEqual(slug1.split('-')[0],'5'); });
});
describe('growth tier',function(){
  it('same title',function(){ const s1=makeSlug(5); assert.strictEqual(makeSlug(5),s1); });
});`,
  });
  try {
    const r = prove(d, { runner: 'mocha' });
    assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0); assert.equal(r.probes, 0, 'no probe wasted on a residual ambiguity');
    const named = r.inconclusive.filter((i) => i.name === 'same title');
    assert.equal(named.length, 2, 'both identical describe-path+title blocks stay fail-closed');
    assert.ok(named.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// Proves the anchor itself is load-bearing, not just belt-and-suspenders: describe('b'){it('c')} qualifies
// to 'b c'; describe('a b'){it('c')} qualifies to 'a b c' — 'b c' IS a substring of 'a b c' (the prefix-
// nesting collision the ambiguousNames rationale warns about). An UNANCHORED qualified --grep 'b c' sweeps
// BOTH tests together (empirically confirmed manually before writing this test: 2 tests matched, one
// invocation) — exactly the misattribution bug this task fixes. The anchored form used here must isolate
// block A alone, recovering both verdicts correctly.
test('PROVE mocha e2e: a qualified-name PREFIX collision (describe "b" vs "a b") is resolved only because the qualified selection is anchored', { skip: !HAS_MOCHA }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"mocha":"*"}}',
    'src/lib.js': "function makeSlug(x){ return String(x) + '-abc'; } module.exports = { makeSlug };\n",
    'test/t.test.js': `const assert=require('node:assert');const {makeSlug}=require('../src/lib.js');
describe('b',function(){
  it('c',function(){ const slug1=makeSlug(5); assert.strictEqual(slug1.split('-')[0],'5'); });
});
describe('a b',function(){
  it('c',function(){ const s1=makeSlug(5); assert.strictEqual(makeSlug(5),s1); });
});`,
  });
  try {
    const r = prove(d, { runner: 'mocha' });
    assert.equal(r.inconclusive.length, 0, 'the prefix collision is resolved, not fail-closed');
    assert.equal(r.probes, 3, 'both blocks probed in isolation from each other');
    assert.equal(r.caught, 1, 'describe("b") block (crashes under the mutation) is caught');
    assert.ok(r.hollow.some((h) => h.name === 'c'), 'describe("a b") self-comparison block is HOLLOW');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// Specials-bearing qualified names: regex metacharacters in BOTH halves of the full name — `(x)` in the
// describe title, `$` in the colliding test title — must survive the reEsc + ^...$ anchor composition
// (mocha is the highest-risk runner: it's the only one where escaping AND anchoring compose). The unit
// test above pins the composed selector string; this proves it isolates at runtime with real mocha.
test('PROVE mocha e2e: specials-bearing qualified names ((x) in describe, $ in title) — reEsc + anchors compose, target isolated', { skip: !HAS_MOCHA }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"mocha":"*"}}',
    'src/lib.js': "function makeSlug(x){ return String(x) + '-abc'; } module.exports = { makeSlug };\n",
    'test/t.test.js': `const assert=require('node:assert');const {makeSlug}=require('../src/lib.js');
describe('tier (x)',function(){
  it('costs $5',function(){ const slug1=makeSlug(5); assert.strictEqual(slug1.split('-')[0],'5'); });
});
describe('other tier',function(){
  it('costs $5',function(){ const s1=makeSlug(5); assert.strictEqual(makeSlug(5),s1); });
});`,
  });
  try {
    const r = prove(d, { runner: 'mocha' });
    assert.equal(r.inconclusive.length, 0, 'the specials-bearing collision is resolved, not fail-closed');
    assert.equal(r.probes, 3, 'both blocks probed in isolation from each other');
    assert.equal(r.caught, 1, 'the tier (x) block (crashes under the mutation) is caught');
    assert.ok(r.hollow.some((h) => h.name === 'costs $5'), 'the other-tier self-comparison block is HOLLOW');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// NOTE on assertion style: ava's OWN `t.is()`/`t.deepEqual()` assertion API is not in pinnedFragments'
// value-pin vocabulary (only node assert / jest-vitest matchers / chai are recognized — see the
// ASSERTION-STRENGTH GATE comment at the top of prove.mjs), and ava's idiomatic concise-body arrow style
// (`t => t.is(...)`, no braces) isn't seen by parseBlocks at all (it requires a block body). A real ava
// suite written idiomatically would score 0 probeable tests — a genuine, pre-existing gap in mutation/'s
// eligibility layer, confirmed live and left unfixed here (mutation/ is out of scope for this task). This
// fixture instead uses node's `assert` (recognized vocabulary, same as the mocha fixture above) with
// block bodies — ava supports plain node assert in a test body; `ava.failWithoutAssertions:false` is
// required or ava fails the test with "finished without running any assertions" even though the node
// assert itself passed. This still genuinely exercises testCmdFor/parseRun/the real ava binary end-to-end.
test('PROVE ava e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_AVA }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"ava":"*"},"ava":{"failWithoutAssertions":false}}',
    'src/lib.js': 'export function add(a,b){return a+b;} export function total(x){return x.reduce((s,i)=>s+i,0);}',
    'test/t.test.js': `import test from 'ava';
import assert from 'node:assert';
import {add,total} from '../src/lib.js';
test('add sound', () => { assert.strictEqual(add(2,3),5); });
test('shadow', () => { const e=total([1,2]); assert.strictEqual(total([1,2]),e); });`,
  });
  try {
    assert.equal(detectRunner(d), 'ava');
    const r = prove(d, { runner: 'ava' });
    assert.ok(r.caught >= 1, 'the sound add test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'shadow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'add sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ava is deliberately left OUT of the describe-path qualification (Task 1): ava's own API has no
// describe()/suite() nesting at all — every test() is flat/top-level — so the pilot's "same title, two
// describes" collision cannot occur in ava's own idiom, and blocks.path is always [] for an ava file
// (qualifiedName degenerates to the bare name — see residualAmbiguous's early return for 'ava'). Separately
// verified here: ava enforces per-file title uniqueness ITSELF — an exact-duplicate title is a load-time
// error ("Duplicate test title"), so ambiguousNames' existing exact-match rule (unaffected by this task)
// already fails the block(s) closed before any runner is even spawned; nothing to recover, nothing to fix.
test('PROVE ava e2e: an exact-duplicate title is already fail-closed at stage 1 — describe-path qualification does not apply (documented, not coded around)', { skip: !HAS_AVA }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"ava":"*"},"ava":{"failWithoutAssertions":false}}',
    'src/lib.mjs': "export function makeSlug(x){ return String(x) + '-abc'; }\n",
    'test/t.test.js': `import test from 'ava';
import assert from 'node:assert';
import { makeSlug } from '../src/lib.mjs';
test('same title', () => { const slug1 = makeSlug(5); assert.strictEqual(slug1.split('-')[0], '5'); });
test('same title', () => { const s1 = makeSlug(5); assert.strictEqual(makeSlug(5), s1); });`,
  });
  try {
    const r = prove(d, { runner: 'ava' });
    assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0); assert.equal(r.probes, 0);
    const named = r.inconclusive.filter((i) => i.name === 'same title');
    assert.equal(named.length, 2, 'both exact-duplicate-titled blocks stay fail-closed, exactly as before this task');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE vitest e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_VITEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"vitest":"*"}}',
    'src/lib.mjs': 'export function dbl(x){ return x * 2; }\n',
    'test/t.test.mjs': `import { test, expect } from 'vitest';
import { dbl } from '../src/lib.mjs';
test('sound', () => { expect(dbl(3)).toBe(6); });
test('hollow', () => { const e = dbl(3); expect(dbl(3)).toBe(e); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'vitest');
    const r = prove(d, { runner: 'vitest' });
    assert.ok(r.caught >= 1, 'the sound test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'hollow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- .resolves pin vocabulary (Task A) e2e: before this task, `.resolves.toEqual(...)` was never
// recognized as a pin, so the block scored skipped/no-pin despite gutting `decode` failing the test —
// prove() must now report it CAUGHT.
test('PROVE vitest e2e: a .resolves.toEqual assertion is recognized as a pin and the block is CAUGHT', { skip: !HAS_VITEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"vitest":"*"}}',
    'src/api.mjs': 'export async function decode(x) { return { a: x * 2 }; }\n',
    'test/t.test.mjs': `import { test, expect } from 'vitest';
import { decode } from '../src/api.mjs';
test('decodes async', async () => { await expect(decode(2)).resolves.toEqual({ a: 4 }); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'vitest');
    const r = prove(d, { runner: 'vitest' });
    assert.ok(!r.skipped.some((s) => s.name === 'decodes async'), 'no longer skipped as no-pin');
    assert.ok(r.caught >= 1, 'the .resolves-pinned block is caught (gutted decode fails the assertion)');
    assert.ok(!r.hollow.some((h) => h.name === 'decodes async'), 'not false-flagged hollow');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- describe-qualified selection (Task 1 — recall recovery): mirrors the confirmed pilot-validity bug
// (from the recall investigation) — two it()s sharing an exact title in different
// describe()s collide under vitest's substring `-t` selection on the bare title, so one invocation used to
// run BOTH. The starter-tier sibling genuinely crashes under the gross-break sentinel (a `.split()` call
// on what's now a bare number literal); the growth-tier sibling is a pure self-comparison oracle that
// survives (HOLLOW) in isolation. Before describe-path qualification, the crash's failure got misattributed
// to the surviving sibling too, so BOTH blocks scored CAUGHT (verified against the pre-qualification code:
// caught:2, hollow:0 — the true hollow never surfaced; that was this exact test, pre-fix). Qualifying the
// selection with the enclosing describe path (path.join(' ') + ' ' + title) before falling back to
// fail-closed resolves the collision: each block now runs in isolation and gets its own correct verdict.
test('PROVE vitest e2e: a bare-title collision across describes is resolved by describe-path qualification (recall recovery)', { skip: !HAS_VITEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"vitest":"*"}}',
    'src/lib.mjs': "export function makeSlug(x){ return String(x) + '-abc'; }\n",
    'test/t.test.mjs': `import { describe, it, expect } from 'vitest';
import { makeSlug } from '../src/lib.mjs';
describe('starter tier', () => {
  it('same title', () => { const slug1 = makeSlug(5); expect(slug1.split('-')[0]).toBe('5'); });
});
describe('growth tier', () => {
  it('same title', () => { const s1 = makeSlug(5); expect(makeSlug(5)).toBe(s1); });
});
`,
  });
  try {
    assert.equal(detectRunner(d), 'vitest');
    const r = prove(d, { runner: 'vitest' });
    assert.equal(r.inconclusive.length, 0, 'no ambiguous-title inconclusive — qualification resolved it, recall recovered');
    assert.equal(r.probes, 3, 'both blocks were actually probed, isolated from each other');
    assert.equal(r.caught, 1, 'the starter-tier block (crashes under the mutation) is caught');
    assert.equal(r.hollow.length, 1, 'the growth-tier self-comparison block is HOLLOW — the previously-masked true hollow');
    assert.equal(r.hollow[0].name, 'same title');
    assert.deepEqual(r.hollow[0].survivors, ['makeSlug']);
    // path/qualified-name leakage check: the report entry never carries a `path` or qualified-name field —
    // qualification is a selection-only detail (see prove()'s per-block loop comment) and must never
    // surface in hollow/caught/inconclusive/skipped output.
    assert.deepEqual(Object.keys(r.hollow[0]).sort(), ['file', 'line', 'name', 'survivorPairs', 'survivors']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
// Residual ambiguity: qualification is a REFINEMENT, not a guarantee — two describe()s that ALSO share the
// exact same title (not just the inner it()'s title) produce IDENTICAL qualified full names, so the
// collision survives qualification. This must still fail closed exactly as before this task.
test('PROVE vitest e2e: IDENTICAL describe path + title (residual ambiguity) still fails closed after qualification', { skip: !HAS_VITEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"type":"module","devDependencies":{"vitest":"*"}}',
    'src/lib.mjs': "export function makeSlug(x){ return String(x) + '-abc'; }\n",
    'test/t.test.mjs': `import { describe, it, expect } from 'vitest';
import { makeSlug } from '../src/lib.mjs';
describe('growth tier', () => {
  it('same title', () => { const slug1 = makeSlug(5); expect(slug1.split('-')[0]).toBe('5'); });
});
describe('growth tier', () => {
  it('same title', () => { const s1 = makeSlug(5); expect(makeSlug(5)).toBe(s1); });
});
`,
  });
  try {
    const r = prove(d, { runner: 'vitest' });
    assert.equal(r.caught, 0, 'never a verdict on a residual ambiguity — must not land in caught');
    assert.equal(r.hollow.length, 0, 'never a verdict on a residual ambiguity — must not land in hollow either');
    assert.equal(r.probes, 0, 'no probe is wasted on a residual ambiguity');
    const named = r.inconclusive.filter((i) => i.name === 'same title');
    assert.equal(named.length, 2, 'both identical describe-path+title blocks are fail-closed to inconclusive');
    assert.ok(named.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'),
      'the exact contract string is reported');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- gated end-to-end, jest ----
// runOne captures stdout+stderr symmetrically on both the success and failure paths (jest writes its
// PASSING-run summary to stderr, not stdout), and testCmdFor passes --runInBand so jest's default
// worker-forking doesn't lose piped output — see mutation/prove.mjs.
test('PROVE jest e2e: a sound test is caught, a shadow oracle is HOLLOW', { skip: !HAS_JEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"jest":"*"}}',
    'src/lib.js': 'function dbl(x){ return x * 2; }\nmodule.exports = { dbl };\n',
    'test/t.test.js': `const assert = require('node:assert');
const { dbl } = require('../src/lib.js');
test('sound', () => { assert.strictEqual(dbl(3), 6); });
test('hollow', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });
`,
  });
  try {
    assert.equal(detectRunner(d), 'jest');
    const r = prove(d, { runner: 'jest' });
    assert.ok(r.caught >= 1, 'the sound test is caught');
    assert.ok(r.hollow.some((h) => h.name === 'hollow'), 'the shadow oracle is HOLLOW');
    assert.ok(!r.hollow.some((h) => h.name === 'sound'), 'the sound test is NOT false-flagged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE jest e2e: a bare-title collision across describes is resolved by describe-path qualification (recall recovery)', { skip: !HAS_JEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"jest":"*"}}',
    'src/lib.js': "function makeSlug(x){ return String(x) + '-abc'; }\nmodule.exports = { makeSlug };\n",
    'test/t.test.js': `const assert = require('node:assert');
const { makeSlug } = require('../src/lib.js');
describe('starter tier', () => {
  test('same title', () => { const slug1 = makeSlug(5); assert.strictEqual(slug1.split('-')[0], '5'); });
});
describe('growth tier', () => {
  test('same title', () => { const s1 = makeSlug(5); assert.strictEqual(makeSlug(5), s1); });
});
`,
  });
  try {
    const r = prove(d, { runner: 'jest' });
    assert.equal(r.inconclusive.length, 0, 'no ambiguous-title inconclusive — qualification resolved it');
    assert.equal(r.probes, 3);
    assert.equal(r.caught, 1, 'the starter-tier block (crashes under the mutation) is caught');
    assert.ok(r.hollow.some((h) => h.name === 'same title'), 'the growth-tier self-comparison block is HOLLOW');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('PROVE jest e2e: IDENTICAL describe path + title (residual ambiguity) still fails closed after qualification', { skip: !HAS_JEST }, () => {
  const d = projectWithRunner({
    'package.json': '{"devDependencies":{"jest":"*"}}',
    'src/lib.js': "function makeSlug(x){ return String(x) + '-abc'; }\nmodule.exports = { makeSlug };\n",
    'test/t.test.js': `const assert = require('node:assert');
const { makeSlug } = require('../src/lib.js');
describe('growth tier', () => {
  test('same title', () => { const slug1 = makeSlug(5); assert.strictEqual(slug1.split('-')[0], '5'); });
});
describe('growth tier', () => {
  test('same title', () => { const s1 = makeSlug(5); assert.strictEqual(makeSlug(5), s1); });
});
`,
  });
  try {
    const r = prove(d, { runner: 'jest' });
    assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0); assert.equal(r.probes, 0, 'no probe wasted on a residual ambiguity');
    const named = r.inconclusive.filter((i) => i.name === 'same title');
    assert.equal(named.length, 2, 'both identical describe-path+title blocks stay fail-closed');
    assert.ok(named.every((i) => i.why === 'ambiguous title — another test in this file matches the same runner selection'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// pytest is left OUT of describe-path qualification (Task 1 — JS-only parseBlocks change): pyBlocks/
// parseBlocks' python branch tracks no enclosing scope, so blocks.path is always undefined for a python
// file and qualifiedName degenerates to the bare name (residualAmbiguous is a provable no-op — see its
// unit test above). The only way to get a bare-name collision in python at all is two DIFFERENT
// unittest.TestCase classes sharing a method name (python itself forbids duplicate function names at
// module scope, so a flat `def test_x` collision literally cannot occur) — verified here: this already
// fails closed via the EXISTING pytest substring rule (ambiguousNames), unaffected by this task. Recovering
// it would need pyBlocks to capture the enclosing class (nodeid-exact `file::Class::method` selection
// instead of `-k`) — out of Task 1's JS-only scope, left as documented future work.
test('PROVE python e2e: a bare-name collision across two TestCase classes is (and remains) fail-closed — no path support, no regression', { skip: !HAS_PY }, () => {
  const d = project({
    'pyproject.toml': "[project]\nname='x'\nversion='0'\n",
    'calc.py': 'def add(a, b):\n    return a + b\n',
    'test_calc.py': [
      'import unittest',
      'from calc import add',
      'class A(unittest.TestCase):',
      '    def test_it(self):',
      '        self.assertEqual(add(2, 3), 5)',
      'class B(unittest.TestCase):',
      '    def test_it(self):',
      '        e = add(2, 3)',
      '        self.assertEqual(add(2, 3), e)',
      '',
    ].join('\n'),
  });
  try {
    const r = prove(d, { runner: 'pytest' });
    assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0); assert.equal(r.probes, 0);
    const named = r.inconclusive.filter((i) => i.name === 'test_it');
    assert.equal(named.length, 2, 'both same-named methods across classes stay fail-closed, exactly as before this task');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- CLI --json: machine-readable output (consumed by the Stop hook) ----
test('PROVE CLI --json: emits the machine-readable result with the hollow list', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': SUT,
    'test/t.test.mjs': `${head} import { add, total } from '../src/lib.mjs';
test('add sound', () => { assert.strictEqual(add(2, 3), 5); });
test('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });
`,
  });
  try {
    let out;
    try { out = execSync(`node ${JSON.stringify(resolve('mutation/prove.mjs'))} ${JSON.stringify(d)} --runner=node --json`, { encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '').toString(); } // exits 1 when a hollow test is present
    const r = JSON.parse(out);
    assert.equal(r.hollow.length, 1);
    assert.equal(r.hollow[0].name, 'shadow');
    assert.equal(r.caught, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE CLI: --max-probes is honored (the Stop-hook entry point)', () => {
  // project with TWO probeable blocks; cap at 1 → capped >= 1 in the JSON
  const d = mkdtempSync(join(tmpdir(), 'gc-maxp-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function a(x){ return x + 1; }\nexport function b(x){ return x + 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { a, b } from '../src/lib.mjs';\n" +
    "test('ta', () => { assert.strictEqual(a(1), 2); });\n" +
    "test('tb', () => { assert.strictEqual(b(1), 3); });\n");
  const out = execFileSync('node', [PROVE_CLI, d, '--max-probes=1', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.ok(r.capped >= 1, `expected capped >= 1, got ${JSON.stringify(r)}`);
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: .claude/ (session worktrees) is never walked — no double-reported findings', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-claude-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  const T = "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('hollow', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });\n";
  writeFileSync(join(d, 'test/t.test.mjs'), T);
  // a worktree copy under .claude/ that would double-report if walked
  mkdirSync(join(d, '.claude/worktrees/w1/test'), { recursive: true });
  mkdirSync(join(d, '.claude/worktrees/w1/src'), { recursive: true });
  writeFileSync(join(d, '.claude/worktrees/w1/package.json'), '{"type":"module"}');
  writeFileSync(join(d, '.claude/worktrees/w1/src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, '.claude/worktrees/w1/test/t.test.mjs'), T);
  const r = prove(d, { runner: 'node' });
  assert.equal(r.hollow.length, 1, `expected exactly one finding, got ${JSON.stringify(r.hollow)}`);
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: skip reasons distinguish no-pin from sut-unresolved', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-skipwhy-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { double } from 'some-external-pkg';\n" +           // pins a value, SUT not a relative import
    "test('pins but unresolvable', () => { assert.strictEqual(double(4), 8); });\n" +
    "test('no pin at all', () => { assert.ok(true); });\n");
  const r = prove(d, { runner: 'node' });
  const why = Object.fromEntries(r.skipped.map((s) => [s.name, s.why]));
  assert.equal(why['pins but unresolvable'], 'sut-unresolved');
  assert.equal(why['no pin at all'], 'no-pin');
  rmSync(d, { recursive: true, force: true });
});
// ---- dynamic (template-literal-interpolated) title (Task 2): `${...}` is a runtime-computed value, so
// no runner selection can ever target it — this must be skipped explicitly with its own `why`, taking
// priority over pin/eligibility (a dynamic block can otherwise pin a real value and resolve a real SUT —
// it is still never probeable), and never counted as a probe/caught/hollow.
test('PROVE: a dynamic (template-literal-interpolated) test title is skipped as "dynamic-title", even though it pins a real value and resolves a real SUT', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-dyntitle-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "const id = 3;\n" +
    "test(`dbl of ${id}`, () => { assert.strictEqual(dbl(id), 6); });\n");
  const r = prove(d, { runner: 'node' });
  assert.equal(r.probes, 0, 'never probed — the title has no statically-knowable runtime value');
  assert.equal(r.caught, 0); assert.equal(r.hollow.length, 0); assert.equal(r.inconclusive.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].why, 'dynamic-title');
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: a failing baseline carries the runner output tail (diagnosable)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-base-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { dbl } from '../src/lib.mjs';\n" +
    "test('red', () => { assert.strictEqual(dbl(3), 7); });\n");   // fails at baseline
  const r = prove(d, { runner: 'node' });
  assert.equal(r.inconclusive.length, 1);
  assert.ok(typeof r.inconclusive[0].detail === 'string' && r.inconclusive[0].detail.length > 0, 'runner output tail attached');
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: changedFileCount reports the size of the --since scope', () => {
  // reuse the gitProject-style fixture; committed clean tree → since HEAD sees 0 changed files
  const d = mkdtempSync(join(tmpdir(), 'gc-cc-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: d });
  const r = prove(d, { since: 'HEAD' });
  assert.equal(r.changedFileCount, 0);
  rmSync(d, { recursive: true, force: true });
});

test('PROVE: an unreadable subdirectory yields a friendly scopeError, not a stack trace', { skip: process.platform === 'win32' ? 'chmod 000 is a no-op on Windows' : (process.getuid && process.getuid() === 0 ? 'root ignores modes' : false) }, () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-eacces-'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  mkdirSync(join(d, 'locked'));
  writeFileSync(join(d, 'locked/x.txt'), 'x');
  chmodSync(join(d, 'locked'), 0o000);
  try {
    const r = prove(d, { runner: 'node' });
    assert.match(String(r.scopeError), /cannot read/);
  } finally { chmodSync(join(d, 'locked'), 0o755); rmSync(d, { recursive: true, force: true }); }
});

test('detectRunner prefers the package.json test script over devDependency runners', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-rpref-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' }, devDependencies: { vitest: '^3.0.0', jest: '^29.0.0' } }));
  assert.equal(detectRunner(d), 'node');
  rmSync(d, { recursive: true, force: true });
});

test('detectRunner: a test script naming no runner falls back to deps order', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-rfall-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo see-ci' }, devDependencies: { jest: '^29.0.0' } }));
  assert.equal(detectRunner(d), 'jest');
  rmSync(d, { recursive: true, force: true });
});

// ---- change classification e2e: --since drives changes/changeSummary through all four statuses ----
// base commit: src/lib.mjs declares 4 fns; test/lib.test.mjs pins the first (proven), circularly
// self-references the second (hollow), weakly asserts the third (unverifiable, no-pin), and never
// mentions the fourth at all (untested). The "agent commit" then edits ALL FOUR fn bodies (a same-line
// trailing-comment tweak — line count stable, so each edit lands in its own single-line git hunk) plus a
// trailing comment in the test file (brings the whole test file into the --since diff so its blocks are
// in scope even though the weak/untested ones have no eligible SUT of their own).
const CHANGES_LIB_BASE = `export function provenFn(x) {
  return x + 1;
}
export function hollowFn(x) {
  return x + 1;
}
export function unvFn(x) {
  return x + 1;
}
export function ghostFn(x) {
  return x + 1;
}
`;
const CHANGES_LIB_EDITED = `export function provenFn(x) {
  return x + 1; // touched
}
export function hollowFn(x) {
  return x + 1; // touched
}
export function unvFn(x) {
  return x + 1; // touched
}
export function ghostFn(x) {
  return x + 1; // touched
}
`;
const CHANGES_TEST_BASE = `${head}
import { provenFn, hollowFn, unvFn } from '../src/lib.mjs';
test('proven catches', () => { assert.strictEqual(provenFn(1), 2); });
test('circular hollow', () => { const e = hollowFn(1); assert.strictEqual(hollowFn(1), e); });
test('weak unv', () => { assert.ok(unvFn(1) !== undefined); });
`;
test('PROVE --since: changes/changeSummary classify all four statuses end-to-end', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': CHANGES_LIB_BASE,
    'test/lib.test.mjs': CHANGES_TEST_BASE,
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: d });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    // the "agent commit" — uncommitted edits to all four fn bodies + the test file (kept unstaged; --since
    // diffs the ref against the working tree, so committing is not required).
    writeFileSync(join(d, 'src/lib.mjs'), CHANGES_LIB_EDITED);
    writeFileSync(join(d, 'test/lib.test.mjs'), CHANGES_TEST_BASE + '// touched\n');

    const r = prove(d, { runner: 'node', since: baseSha });

    assert.equal(r.caught, 1, 'provenFn genuinely caught');
    assert.equal(r.hollow.length, 1, 'hollowFn survives gutting (circular self-reference)');
    assert.ok(r.hollow.some((h) => h.survivors.includes('hollowFn')));

    assert.ok(r.changes, 'changes is populated under --since');
    assert.ok(r.changeSummary, 'changeSummary is populated under --since');
    // sameDiffProven: 1 — the fixture's test file (test/lib.test.mjs) is ITSELF part of the diff (the
    // trailing "// touched" edit above), so provenFn's one binding block has testChanged: true.
    assert.deepEqual(r.changeSummary, { files: 1, fns: 4, proven: 1, hollow: 1, unverifiable: 1, untested: 1, notProbed: 0, sameDiffProven: 1 });

    const by = Object.fromEntries(r.changes.map((c) => [c.fn, c]));
    assert.equal(by.provenFn.status, 'proven');
    assert.equal(by.hollowFn.status, 'hollow');
    assert.equal(by.unvFn.status, 'unverifiable');
    assert.equal(by.unvFn.evidence.reason, 'no-pin');
    assert.equal(by.ghostFn.status, 'untested');
    assert.deepEqual(by.ghostFn.evidence, {});
    for (const c of r.changes) assert.equal(c.granularity, 'hunk', `${c.fn} row carries hunk granularity`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A SOURCE-ONLY diff must still classify a weakly-tested fn as unverifiable: the weak block's test file
// did not change, its `eligible` is empty (no value pin), so the scope gate drops it out of scope BEFORE
// any verdict push — without a block record there, the changed fn would misreport 'untested' ("no test
// mentions it"), which is false. The record must be captured before the outOfScope gate.
test('PROVE --since: a source-only diff classifies a weakly-tested fn unverifiable, not untested', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function f(x) {\n  return x + 1;\n}\n',
    'test/weak.test.mjs': `${head}\nimport { f } from '../src/lib.mjs';\ntest('weak only', () => { assert.ok(f(1) !== undefined); });\n`,
  });
  try {
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: d });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    writeFileSync(join(d, 'src/lib.mjs'), 'export function f(x) {\n  return x + 1; // touched\n}\n'); // src ONLY
    const r = prove(d, { runner: 'node', since: baseSha });
    assert.equal(r.outOfScope, 1, 'the weak block itself stays out of scope (unchanged bucket semantics)');
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].status, 'unverifiable', 'weakly-referenced changed fn is unverifiable, never untested');
    assert.equal(r.changes[0].evidence.reasons['no-pin'], 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The per-file `git diff -U0` catch branch: when the diff cannot be computed (here: a non-git dir with an
// explicitly supplied changed-set + since — note the review's deleted-file example never reaches this call,
// since a deleted file is absent from the srcFiles walk), classification falls back to ranges=null /
// granularity 'file' and never throws out of prove().
test('PROVE: git diff -U0 failure falls back to file granularity (catch branch, no throw)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': 'export function f(x) {\n  return x + 1;\n}\n',
  });
  try {
    const r = prove(d, { runner: 'node', changed: new Set([resolve(d, 'src/lib.mjs')]), since: 'HEAD' });
    assert.equal(r.scopeError, undefined, 'no scope error — the changed set was supplied directly');
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].granularity, 'file', 'diff failure degrades to file granularity');
    assert.equal(r.changes[0].status, 'untested');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- win32 path-identity discipline (Root A) — unix-runnable RED/GREEN layer; win32-only behavior
// (case-insensitive comparison, 8.3 short-name expansion) is validated by the CI push, not here. ----
test('toPosix: backslash separators become forward slashes; already-posix input is untouched', () => {
  assert.equal(toPosix('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(toPosix('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(toPosix('C:\\proj\\test\\t.test.mjs'), 'C:/proj/test/t.test.mjs');
});
test('canonKey: matches the native realpath, casefolded to lowercase on win32 only', () => {
  const d = mkdtempSync(join(tmpdir(), 'sk-canon-'));
  try {
    const f = join(d, 'MixedCase.txt');
    writeFileSync(f, 'x');
    // native: expands win32 8.3 short names (plain realpathSync does not) — the exact distinction canonKey exists for
    const real = (realpathSync.native || realpathSync)(f);
    const expected = process.platform === 'win32' ? real.toLowerCase() : real;
    assert.equal(canonKey(f), expected, 'comparison key is the native realpath, casefolded on win32 only');
    if (process.platform !== 'win32') {
      assert.notEqual(real.toLowerCase(), real, 'sanity: the fixture actually has case to fold (would falsely pass otherwise)');
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('canonKey: a nonexistent path falls back to resolve() instead of throwing (casefolded on win32 only)', () => {
  const p = join(tmpdir(), 'sk-canon-missing-' + Date.now(), 'nope.txt');
  assert.doesNotThrow(() => canonKey(p));
  const expected = process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  assert.equal(canonKey(p), expected);
});
// isTestPath is pure regex — the win32 direction (a real backslash-separated absolute path) is fully
// expressible and provable on unix, no filesystem or platform gate needed (evidence: diagnose run
// 28703534698 boundary A2, where the forward-slash-only dir clause never matched a real win32 path).
test('isTestPath: recognizes a Windows backslash-separated test path (pure regex, unix-runnable)', () => {
  assert.equal(isTestPath('C:\\x\\tests\\a.py'), true, 'python file under a backslash tests/ dir');
  assert.equal(isTestPath('C:\\x\\test_a.py'), true, 'python test_ prefix convention, backslash-anchored');
  // A plain .mjs file (no .test./.spec. in the name — the extension-only clause can't fire) that lives
  // under a backslash `test\` dir: this ONLY matches via the dir-boundary clause, so it genuinely
  // exercises separator tolerance rather than the always-slash-agnostic filename-suffix clause.
  assert.equal(isTestPath('C:\\proj\\test\\helpers.mjs'), true, 'plain .mjs under a backslash test\\ dir');
  assert.equal(isTestPath('C:\\proj\\src\\lib.mjs'), false, 'a non-test file under src\\ must not match');
});
test('PROVE --files: a forward-slash substring matches (baseline); a BACKslash-arg variant ALSO matches via toPosix — the unix-runnable proxy for the win32 direction', () => {
  const d = project(TWOFILE);
  try {
    const fwd = prove(d, { runner: 'node', files: ['test/a.test.mjs'] });
    assert.equal(fwd.scored, 1, 'only test/a is scored — test/b is filtered out by the substring');
    // An agent-supplied --files argument with backslashes (e.g. copy-pasted from a Windows path, or the
    // Stop hook passing a win32-shaped rel) must match too, since toPosix normalizes BOTH sides.
    const back = prove(d, { runner: 'node', files: ['test\\a.test.mjs'] });
    assert.equal(back.scored, 1, 'a backslash --files arg matches via toPosix on both sides');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- gross-survivor aggregation (measurement-gated promotion) ----
// Each eligible fn in a block gets its OWN separate mutant run (prove.mjs's per-fn for-loop), so a fn's
// survive/catch outcome is measured correctly even when a sibling fn's own run fails the same block. Today
// that measurement is collected into a local `survivors` array but discarded whenever the block's overall
// verdict is 'caught' (a sibling broke it) — never attached to blockRecords, never aggregated. These four
// tests hand-derive the fix: the caught-branch record keeps `survivors`, and a NEW `grossSurvivors` field
// aggregates per (sutRel, fn) across the whole run, suppressed wherever the fn is caught ANYWHERE.
//
// Shared shadow-oracle rig: `guard(v)` is a LOCAL (unimported) test helper — never resolvable to a SUT
// file, so it is never itself eligible/mutated — that reduces any truthy value to 'yes'. grossBreak
// replaces a gutted fn's body with `return 987654321;` (mutation/probe.mjs), a truthy number, so
// `guard(core(x))` reads 'yes' whether core runs for real or is gutted: core's OWN isolated mutant run
// SURVIVES this assertion regardless of what core actually computes. `other`, pinned by a literal
// (`other(3) === 6`), has no such shadow: gutting it breaks its own run for real.
const GROSS_SUT = 'export function core(x) { return x + 1; }\nexport function other(y) { return y * 2; }\n';
const guardHead = `${head}\nfunction guard(v) { return v ? 'yes' : 'no'; }`;

test('PROVE grossSurvivors: fnA survives block1 (sibling fnB caught there) but fnA is ALSO caught in block2 — suppression clause keeps grossSurvivors ABSENT', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': GROSS_SUT,
    'test/t.test.mjs': `${guardHead}
import { core, other } from '../src/lib.mjs';
test('mixed', () => {
  assert.strictEqual(guard(core(5)), 'yes');
  assert.strictEqual(other(3), 6);
});
test('core sound', () => { assert.strictEqual(core(5), 6); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // hand-derived: 'mixed' — core's own run (987654321, truthy) still satisfies guard(...)==='yes' → core
    // SURVIVES; other's own run breaks its literal pin → other is CAUGHT → anyBroke=true → block verdict
    // 'caught', caughtFns=['other'], survivors=['core'] (post-fix). 'core sound' — core is pinned directly
    // by a literal (5+1=6); gutting it to 987654321 !== 6 fails for real → block verdict 'caught',
    // caughtFns=['core']. Both blocks are verdict 'caught', so today's discard bug never even surfaces this
    // — the fix must ALSO apply the (sutRel,fn) suppression rule: core appears in survivors of 'mixed' but
    // ALSO in caughtFns of 'core sound' → 'F ∉ caughtFns of ANY probed block' fails → excluded. Nothing else
    // (other) ever survives anywhere, so the whole array is empty → field omitted, not `[]`.
    assert.equal(r.caught, 2, 'both blocks verdict caught');
    assert.equal(r.hollow.length, 0);
    assert.equal(r.grossSurvivors, undefined, 'core is legitimately caught elsewhere — must not be reported a gross-survivor');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE grossSurvivors: fnA surviving its ONLY probed block (sibling caught there) is reported, with the exact evidence shape', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': GROSS_SUT,
    'test/t.test.mjs': `${guardHead}
import { core, other } from '../src/lib.mjs';
test('mixed', () => {
  assert.strictEqual(guard(core(5)), 'yes');
  assert.strictEqual(other(3), 6);
});
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // hand-derived: same 'mixed' block as above, but with NO second block pinning core directly this time —
    // core is eligible in exactly one probed block, survives it (shadow-oracle rig), and is never caught
    // anywhere else. other is caught once, never survives (0 survivals — the rule requires >=1, so other
    // never qualifies regardless of the suppression clause). Evidence shape per the plan:
    // {file: sutRel, fn, survivedIn: [{file, line, name}], caughtIn: n}.
    assert.equal(r.caught, 1, 'the single block is verdict caught (other breaks it)');
    assert.equal(r.hollow.length, 0);
    assert.deepEqual(r.grossSurvivors, [
      { file: 'src/lib.mjs', fn: 'core', survivedIn: [{ file: 'test/t.test.mjs', line: 4, name: 'mixed' }], caughtIn: 0 },
    ]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE grossSurvivors: two same-named fns in DIFFERENT files never merge — a caught core in file B must not suppress a surviving core in file A', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/a.mjs': GROSS_SUT,
    'src/b.mjs': 'export function core(y) { return y * 3; }\n',
    'test/a.test.mjs': `${guardHead}
import { core, other } from '../src/a.mjs';
test('mixed-a', () => {
  assert.strictEqual(guard(core(5)), 'yes');
  assert.strictEqual(other(3), 6);
});
`,
    'test/b.test.mjs': `${head} import { core } from '../src/b.mjs';
test('core-b sound', () => { assert.strictEqual(core(2), 6); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // hand-derived: src/a.mjs's core survives 'mixed-a' exactly like the previous test and is never caught
    // in ANY block of src/a.mjs. src/b.mjs declares an UNRELATED core that IS genuinely, directly caught in
    // 'core-b sound' (2*3=6; gutted 987654321 !== 6). If aggregation keyed on bare fn name, the two would
    // merge into one 'core' entry with caughtIn>=1 from file B — wrongly suppressing file A's real finding
    // (a false negative). Keyed on (sutRel, fn), they must stay two independent entries: only file A's core
    // clears the rule (b's core has 0 survivals, so it never qualifies either way).
    assert.equal(r.caught, 2);
    assert.equal(r.hollow.length, 0);
    assert.deepEqual(r.grossSurvivors, [
      { file: 'src/a.mjs', fn: 'core', survivedIn: [{ file: 'test/a.test.mjs', line: 4, name: 'mixed-a' }], caughtIn: 0 },
    ]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Exclusion clause: grossSurvivors counts the NOVEL observation class ONLY — fns that survived their own
// mutant run inside a block whose overall verdict was 'caught' (a sibling broke it), i.e. survivals that
// are reported NOWHERE else. A hollow block's survivors are already surfaced via r.hollow at HIGHER
// severity (a hard finding, rendered, exit-code-relevant); re-listing them in grossSurvivors would
// double-count the same observation and contaminate the Task-3 corpus tally, whose whole point is to
// measure how often the probe sees something it currently reports nowhere.
test('PROVE grossSurvivors: a fn reported in r.hollow is ABSENT from grossSurvivors — novel observations only', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': GROSS_SUT + 'export function shady(z) { return z + 3; }\n',
    'test/t.test.mjs': `${guardHead}
import { core, other, shady } from '../src/lib.mjs';
test('mixed', () => {
  assert.strictEqual(guard(core(5)), 'yes');
  assert.strictEqual(other(3), 6);
});
test('shadow solo', () => { const e = shady(1); assert.strictEqual(shady(1), e); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // hand-derived: 'mixed' (line 4) — core survives (shadow rig), other caught → verdict 'caught',
    // survivors=['core'] persisted → core is a NOVEL observation (reported nowhere else) → in
    // grossSurvivors. 'shadow solo' (line 8) — shady is its only eligible fn and both assertion sides
    // route through shady, so its own mutant run survives; anyBroke=false → verdict 'hollow',
    // r.hollow=[{...survivors:['shady']}]. shady's survival IS observed, but it is already reported via
    // r.hollow — the corpus tally must count only what the probe reports nowhere else, so shady must NOT
    // also appear in grossSurvivors (and its absence must not disturb core's entry in the same run).
    assert.equal(r.caught, 1);
    assert.deepEqual(r.hollow, [{ file: 'test/t.test.mjs', line: 8, name: 'shadow solo', survivors: ['shady'], survivorPairs: [{ fn: 'shady', sutRel: 'src/lib.mjs' }] }]);
    assert.deepEqual(r.grossSurvivors, [
      { file: 'src/lib.mjs', fn: 'core', survivedIn: [{ file: 'test/t.test.mjs', line: 4, name: 'mixed' }], caughtIn: 0 },
    ], 'core only — shady is hollow-reported, so it must be excluded from the novel-class tally');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Fn-LEVEL exclusion (adjudicated): a fn reported hollow ANYWHERE is dropped from grossSurvivors even
// when it ALSO survived a caught block — a hollow-reported fn is already under audit, and its caught-block
// survivals are context for THAT audit, not novel yield for the corpus tally.
test('PROVE grossSurvivors: a fn surviving BOTH a caught block and a hollow block is in r.hollow and ABSENT from grossSurvivors (fn-level exclusion)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': GROSS_SUT,
    'test/t.test.mjs': `${guardHead}
import { core, other } from '../src/lib.mjs';
test('mixed', () => {
  assert.strictEqual(guard(core(5)), 'yes');
  assert.strictEqual(other(3), 6);
});
test('core shadow', () => { const e = core(1); assert.strictEqual(core(1), e); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // hand-derived: 'mixed' (line 4) — core survives (shadow rig), other caught → verdict 'caught' with
    // survivors=['core'] persisted. 'core shadow' (line 8) — core is the only eligible fn, both assertion
    // sides route through core → its own mutant run survives, anyBroke=false → verdict 'hollow',
    // survivors=['core']. Under block-level-only exclusion core would still surface in grossSurvivors
    // (its 'mixed' survival IS reported nowhere else) — but fn-level semantics say core is already under
    // audit via r.hollow; the 'mixed' survival is context for that audit, not a novel finding. Nothing
    // else survives anywhere (other is caught), so the whole field is omitted, not [].
    assert.equal(r.caught, 1);
    assert.deepEqual(r.hollow, [{ file: 'test/t.test.mjs', line: 8, name: 'core shadow', survivors: ['core'], survivorPairs: [{ fn: 'core', sutRel: 'src/lib.mjs' }] }]);
    assert.equal(r.grossSurvivors, undefined, 'core is hollow-reported — its caught-block survival must not be re-raised as novel');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Negative space of the fn-level filter, pinned as INTENDED behavior: hollow survivors are bare names
// (known limitation — r.hollow[].survivors carries no sutRel), so the filter matches on bare name and
// over-excludes in the rare cross-file same-name case. For a NOVELTY measurement that is conservative in
// the right direction: a dropped true observation costs one corpus data point; a double-counted one
// corrupts the tally. Pinned here so a future "fix" doesn't silently flip it without adjudication.
test('PROVE grossSurvivors: a same-named fn hollow-reported in a DIFFERENT file excludes file-A survivor too (conservative bare-name filter, intended)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/a.mjs': GROSS_SUT,
    'src/b.mjs': 'export function core(y) { return y * 3; }\n',
    'test/a.test.mjs': `${guardHead}
import { core, other } from '../src/a.mjs';
test('mixed-a', () => {
  assert.strictEqual(guard(core(5)), 'yes');
  assert.strictEqual(other(3), 6);
});
`,
    'test/b.test.mjs': `${head} import { core } from '../src/b.mjs';
test('core-b shadow', () => { const e = core(1); assert.strictEqual(core(1), e); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    // hand-derived: src/a.mjs's core survives 'mixed-a' (line 4, caught via other) and is never caught or
    // hollow-reported ITSELF — under (sutRel,fn) keying alone it would be reported (compare the non-merge
    // test above, where file B's same-named core was CAUGHT instead and file A's entry survived the
    // filter). Here file B's unrelated core is HOLLOW-reported ('core-b shadow', test/b.test.mjs line 2:
    // both assertion sides route through b's core) — and since hollow survivors are bare names, the
    // fn-level filter drops file A's entry too. Intended over-exclusion (see comment above the test);
    // nothing else qualifies, so the field is omitted.
    assert.equal(r.caught, 1, 'mixed-a is the only caught block');
    assert.deepEqual(r.hollow, [{ file: 'test/b.test.mjs', line: 2, name: 'core-b shadow', survivors: ['core'], survivorPairs: [{ fn: 'core', sutRel: 'src/b.mjs' }] }]);
    assert.equal(r.grossSurvivors, undefined, 'file-A core is bare-name-excluded by file-B hollow report — conservative, intended');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Regression oracle: the FULL result on the pre-existing hollow-pair fixture (the very first PROVE
// integration test above), captured field-by-field by running prove() BEFORE this change — an independent,
// pre-change snapshot, not derived from the post-change code under test — must stay byte-identical, and
// `grossSurvivors` must be ABSENT: total's only survivor evidence in this fixture is the 'shadow' block,
// whose verdict is 'hollow' — already reported via r.hollow, so it contributes nothing to the novel-class
// tally (exclusion clause above), and with nothing else surviving anywhere the field is omitted entirely.
// This is the plumbing-is-invisible case: a fixture with no caught-block survivor must produce a result
// byte-identical to the pre-change output, new field included (absent, not []).
// Task 4 (hook/--explain evidence fix) added `survivorPairs` alongside `survivors` on every r.hollow
// entry — the snapshot below is updated for that ADDITIVE shape change only; every other field is
// unchanged from the pre-Task-4 snapshot.
test('PROVE grossSurvivors: byte-identity regression — the hollow-pair fixture result is byte-identical, grossSurvivors absent', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/lib.mjs': SUT,
    'test/t.test.mjs': `${head} import { add, total, fmt } from '../src/lib.mjs';
test('add sound', () => { assert.strictEqual(add(2, 3), 5); });
test('shadow', () => { const e = total([{p:1,q:2}]); assert.strictEqual(total([{p:1,q:2}]), e); });
test('weak', () => { assert.ok(total([{p:1,q:2}]) !== null); });
test('fmt sound', () => { assert.strictEqual(fmt(13.5), '$13.50'); });
`,
  });
  try {
    const r = prove(d, { runner: 'node' });
    assert.deepEqual(r, {
      runner: 'node', scored: 3, caught: 2,
      hollow: [{ file: 'test/t.test.mjs', line: 3, name: 'shadow', survivors: ['total'], survivorPairs: [{ fn: 'total', sutRel: 'src/lib.mjs' }] }],
      weak: [], oneSided: [], oneSidedBlocks: 0, inconclusive: [],
      skipped: [{ file: 'test/t.test.mjs', line: 4, name: 'weak', why: 'no-pin' }],
      outOfScope: 0, probes: 4, capped: 0, envAborted: 0, pct: 67,
      changedFileCount: undefined, changes: null, changeSummary: null,
    }, 'the WHOLE result must match the snapshot (probes counts the hollow-confirmation mutant; the self-comparison survives both sentinels) — grossSurvivors absent (hollow-only survivor evidence is not novel)');
    assert.ok(!('grossSurvivors' in r), 'the key must be omitted entirely, not present-as-[] or present-as-undefined');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('PROVE: skip-dir names in ANCESTOR path segments never suppress the work-dir copy (clones under ~/.claude regression)', () => {
  // The confirmatory drive parked clones under ~/.claude/jobs/... and every baseline failed
  // "Could not find <test file>": the cpSync filter judged ABSOLUTE paths, so the '.claude'
  // ancestor segment matched SKIP_DIRS and the copy was empty. The filter must judge paths
  // relative to the copy root only. Oracle (hand-derived): a sound test in such a project
  // must score 1/1 caught — pre-fix it lands inconclusive 'did-not-run 0p/0f'.
  const parent = mkdtempSync(join(tmpdir(), 'sk-anc-'));
  const d = join(parent, '.claude', 'proj');
  mkdirSync(join(d, 'src'), { recursive: true }); mkdirSync(join(d, 'test'), { recursive: true });
  writeFileSync(join(d, 'package.json'), '{"type":"module"}');
  writeFileSync(join(d, 'src/lib.mjs'), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(join(d, 'test/t.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { add } from '../src/lib.mjs';\n" +
    "test('adds', () => { assert.strictEqual(add(2, 3), 5); });\n");
  const r = prove(d, { runner: 'node' });
  assert.equal(r.scored, 1, 'scored despite .claude ancestor segment');
  assert.equal(r.caught, 1, 'caught despite .claude ancestor segment');
  rmSync(parent, { recursive: true, force: true });
});

test('PROVE: skip-dir regex is literal — a source dir named "agit" is not eaten by ".git" (dot-escape regression)', () => {
  // Unescaped '.git' in the joined regex makes '.' a wildcard: a segment of shape <anychar>+'git'
  // (e.g. 'agit') matches sep+.git+sep and the SUT dir vanishes from the work copy. ('digit' does
  // NOT trigger it — the leading separator anchor blocks mid-segment matches; the specimen must be
  // exactly one wildcard char wide.) Oracle: sound test over agit/lib.mjs scores 1/1 caught.
  const d = project({
    'package.json': '{"type":"module"}',
    'agit/lib.mjs': 'export function mul(a, b) { return a * b; }\n',
    'test/t.test.mjs':
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { mul } from '../agit/lib.mjs';\n" +
      "test('multiplies', () => { assert.strictEqual(mul(3, 4), 12); });\n",
  });
  const r = prove(d, { runner: 'node' });
  assert.equal(r.scored, 1, 'scored with an agit/ source dir');
  assert.equal(r.caught, 1, 'caught with an agit/ source dir');
  rmSync(d, { recursive: true, force: true });
});

// ---- formatReport (diff mode): a hollow in the probed scope BEYOND the changed-function rows must
// render on the DEFAULT report — the exit code counts r.hollow across the whole probed scope (a touched
// test file is probed whole-file), so a report whose headline says "0 hollow" while the process exits 1
// is a silent false negative on the tool's core promise (public issue #1; the --format=markdown surface
// already reconciles via its extraHollow section — this pins the same invariant on the default surface).
// Oracle: the r object is hand-built to the shape prove() returns (changeSummary counts changed fns only;
// r.hollow carries the whole-scope execution finding) — never captured from formatReport's own output.
test('formatReport diff mode: whole-scope hollow beyond the changed functions is rendered, with a headline count', () => {
  const r = {
    runner: 'node', scored: 2, caught: 1, probes: 2, capped: 0, pct: 50, changedFileCount: 2,
    weak: [], inconclusive: [], skipped: [], outOfScope: 0,
    hollow: [{ file: 'test/all.test.mjs', line: 10, name: 'scale self-check', survivors: ['scale'], survivorPairs: [{ fn: 'scale', sutRel: 'src/b.mjs' }] }],
    changes: [{ file: 'src/a.mjs', fn: 'add', line: 1, status: 'proven', granularity: 'hunk', evidence: { blocks: [{ file: 'test/all.test.mjs', line: 3, name: 'add pins' }], sameDiffOracle: false } }],
    changeSummary: { files: 2, fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0, notProbed: 0, sameDiffProven: 0 },
  };
  const out = formatReport(r);
  assert.ok(out.includes('test/all.test.mjs:10'), 'the hollow block file:line must appear on the default surface');
  assert.ok(out.includes("'scale self-check'"), 'the hollow block name must appear');
  assert.ok(out.includes('still passes when scale() is gutted'), 'the receipt phrasing states what happened');
  assert.match(out, /1 HOLLOW beyond the diff/, 'the headline itself must carry the count — it is the line the contradiction lived on');
});

test('formatReport diff mode: a hollow already carried by a changed-function row is NOT double-rendered', () => {
  const blk = { file: 't/x.test.mjs', line: 7, name: 'circ' };
  const r = {
    runner: 'node', scored: 1, caught: 0, probes: 1, capped: 0, pct: 0, changedFileCount: 1,
    weak: [], inconclusive: [], skipped: [], outOfScope: 0,
    hollow: [{ ...blk, survivors: ['f'], survivorPairs: [{ fn: 'f', sutRel: 'src/f.mjs' }] }],
    changes: [{ file: 'src/f.mjs', fn: 'f', line: 1, status: 'hollow', granularity: 'file', evidence: { blocks: [blk] } }],
    changeSummary: { files: 1, fns: 1, proven: 0, hollow: 1, unverifiable: 0, untested: 0, notProbed: 0, sameDiffProven: 0 },
  };
  const out = formatReport(r);
  assert.ok(!/beyond the diff/.test(out), 'covered by the changed-fn hollow row — no extra section, no double count');
  assert.equal(out.split('t/x.test.mjs:7').length - 1, 1, 'the block file:line renders exactly once');
});

test('formatReport diff mode: empty whole-scope hollow renders byte-identically (no new section, no headline fragment)', () => {
  const r = {
    runner: 'node', scored: 1, caught: 1, probes: 1, capped: 0, pct: 100, changedFileCount: 1,
    weak: [], inconclusive: [], skipped: [], outOfScope: 0, hollow: [],
    changes: [{ file: 'src/a.mjs', fn: 'add', line: 1, status: 'proven', granularity: 'hunk', evidence: { blocks: [{ file: 't/t.test.mjs', line: 3, name: 'adds' }], sameDiffOracle: false } }],
    changeSummary: { files: 1, fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0, notProbed: 0, sameDiffProven: 0 },
  };
  assert.ok(!/beyond the diff/i.test(formatReport(r)), 'zero-state: no fragment, no section');
});

// ---- pin-unresolved (public issue #3, defect A): a test that pins literals through a DESTRUCTURING
// declaration (`const [a, b] = f(x)`) is invisible to the var-hop (its LHS is not a single identifier) —
// the block is rightly skipped, but 'no-pin' rendered as "only checks a mock / no value pinned" asserts
// something false about the test and sends its author to "fix" a sound oracle. The engine must state the
// two facts it actually established, separately: a pin exists ('pin-unresolved'), vs no pin found
// ('no-pin'). Oracle hand-derived from the fixture source: lo/hi ARE pinned to 2/3 by hand.
test('prove: a destructured pin skips as pin-unresolved — never the false "no value pinned" claim', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/box.mjs': 'export function box(n) { return [n + 1, n + 2]; }\n',
    'test/box.test.mjs':
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { box } from '../src/box.mjs';\n" +
      "test('box components', () => { const [lo, hi] = box(1); assert.strictEqual(lo, 2); assert.strictEqual(hi, 3); });\n",
  });
  const r = prove(d, { runner: 'node' });
  assert.equal(r.scored, 0, 'the block is not probeable — that part is unchanged');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].why, 'pin-unresolved', 'a pin exists and the scanner could not link it — say that, not no-pin');
  rmSync(d, { recursive: true, force: true });
});

test('prove: a weak-only block (no literal pin anywhere) still skips as no-pin (unchanged)', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/pos.mjs': 'export function isPositive(n) { return n > 0; }\n',
    'test/pos.test.mjs':
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { isPositive } from '../src/pos.mjs';\n" +
      "test('positive', () => { assert.ok(isPositive(5)); });\n",
  });
  const r = prove(d, { runner: 'node' });
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].why, 'no-pin', 'genuinely pin-free stays no-pin — the message is true there');
  rmSync(d, { recursive: true, force: true });
});

// The rendered message for the new reason must state only what the probe established — and the old
// mock/no-pin phrasing must never leak onto a pin-unresolved row.
test('formatReport diff mode: pin-unresolved renders its honest message, never the mock/no-pin claim', () => {
  const r = {
    runner: 'gradle', scored: 0, caught: 0, probes: 0, capped: 0, pct: null, changedFileCount: 1,
    weak: [], inconclusive: [], skipped: [{ file: 't/g.test.kt', line: 2, name: 'destructured', why: 'pin-unresolved' }], outOfScope: 0, hollow: [],
    changes: [{ file: 'src/geo.kt', fn: 'boundingBoxM', line: 1, status: 'unverifiable', granularity: 'file', evidence: { reason: 'pin-unresolved', reasons: { 'pin-unresolved': 1 }, blocks: [{ file: 't/g.test.kt', line: 2, name: 'destructured' }] } }],
    changeSummary: { files: 1, fns: 1, proven: 0, hollow: 0, unverifiable: 1, untested: 0, notProbed: 0, sameDiffProven: 0 },
  };
  const out = formatReport(r);
  assert.ok(out.includes("pins a value the probe can't tie to a called function"), 'states exactly the two established facts');
  assert.ok(!/only checks a mock/.test(out), 'the false claim must be gone from this row');
});

// ---- time budget must bound the ANALYSIS phase, not just probing. The only budget check used to sit
// AFTER the per-block eligibility work (whose JVM resolvers scan source files per candidate), so an
// unscoped run on a large repo ground CPU for 20+ minutes with zero probes, zero output, and the budget
// never consulted — the skip paths `continue` before reaching the check. Once the budget is exhausted,
// every remaining block must be recorded probe-cap WITHOUT running eligibility. Oracle hand-derived:
// a NEGATIVE budget is already in the past when the first check runs (truthy, and elapsed >= -1 always),
// so BOTH blocks cap deterministically on any machine — a 1ms budget flaked on a fast CI runner whose
// work-copy setup finished inside the millisecond, letting block 1 legally through eligibility.
// Under the old code the weak block still went through classification (skipped/no-pin).
test('prove: an exhausted time budget caps remaining blocks before analysis — never a silent grind', () => {
  const d = project({
    'package.json': '{"type":"module"}',
    'src/m.mjs': 'export function isPositive(n) { return n > 0; }\nexport function add(a, b) { return a + b; }\n',
    'test/m.test.mjs':
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { isPositive, add } from '../src/m.mjs';\n" +
      "test('weak', () => { assert.ok(isPositive(5)); });\n" +
      "test('sound', () => { assert.strictEqual(add(2, 3), 5); });\n",
  });
  const r = prove(d, { runner: 'node', timeBudgetMs: -1 });
  assert.equal(r.probes, 0, 'no probe ever started');
  assert.equal(r.capped, 2, 'both blocks report probe-cap — analysis itself is bounded');
  assert.equal(r.skipped.length, 0, 'no block reached eligibility classification after exhaustion');
  rmSync(d, { recursive: true, force: true });
});
