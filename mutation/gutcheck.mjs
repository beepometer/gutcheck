#!/usr/bin/env node
// gutcheck — prove your AI-written tests actually test your code. It guts each tested function with a
// guaranteed-wrong return and reruns only that test; a survivor is re-gutted with the opposite-signed
// return before any accusation — green under BOTH is HOLLOW (it can't detect that function breaking),
// red under exactly one is one-sided (never a blocker). Default action: run the probe over your tests
// (scope with --since) and report the hollow ones. Fronted by a self-check ("won't run until it catches
// its own planted fake test").
import { readFileSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { prove, formatReport, parseBlocks, RUNNERS, extraHollowOf, oneSidedLines } from './prove.mjs';
import { selfCheck } from './selfcheck.mjs';
import { configForProject } from '../checker/standalone.mjs';
import { runChecker } from '../checker/core.mjs';
import { runGate } from './gate.mjs';

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();
const HELP = `gutcheck ${VERSION} — prove your AI-written tests actually test your code

  gutcheck [path] [--since <ref>]   gut each tested function and rerun its test; report the HOLLOW ones
                                    (--since scopes to tests touched since <ref>, falling back to a
                                    full-suite scan when that diff touches no probeable test; --files=a,b;
                                    --runner=R)
  (every value flag accepts both --k=v and --k v)
  gutcheck lint [path]              sub-second deterministic triage (derivation/assertion/shape/fallback-collapse oracles)
  gutcheck gate --harness=<h>       agent-loop gate: reads the harness Stop event on stdin, prints its response (used by the hook integrations)
  gutcheck --explain <file:line>    show the proof for one test: the mutation applied + before/after result
  gutcheck [path] --max-probes=<n>  cap the number of functions probed (default 40; bounds latency on a big diff)
  gutcheck [path] --time-budget=<s>   wall-clock cap for the probe pass; capped blocks report as unverifiable (probe-cap)
  gutcheck [path] --deep            costlier evidence, same coverage: both-sentinel checks extend to proven fns
                                    (one-direction-only proofs demote to one-sided) + the identity-stub advisory
  gutcheck [path] --no-fallback     never widen an empty --since scope to a full-suite scan (used by the agent hook)
  gutcheck [path] --format=sarif    SARIF 2.1.0 for CI code-scanning upload (no banners)
  gutcheck [path] --format=github   GitHub ::error inline PR annotations (no banners)
  gutcheck [path] --format=markdown PR-comment body: a table of changed functions + proof status (--since)
  gutcheck [path] --json            machine-readable result, no banners (for CI / the agent hook)
  gutcheck --demo                   run a planted example (no project needed) — see a real catch in seconds
  gutcheck --no-self-check          skip the startup self-check (probe mode only; not recommended)
  gutcheck --version | --help
`;

// "probed N · runner=X · M skipped · K out of diff scope" — every run says what it actually did, so a
// zero-finding run reads as "verified N bite", not "did nothing".
// Skip labels: known codes get the short human phrase; a code missing here renders VERBATIM rather than
// vanishing — the itemized counts must always sum to the skipped total (a hardcoded if-chain here once
// left a third of a wild run's skips unattributed).
const SKIP_LABELS = new Map([
  ['no-pin', 'no value-pinning assertion'],
  ['sut-unresolved', 'tested function not locatable'],
  ['ungutable', 'function body not guttable'],
  ['dynamic-title', 'test title is dynamic (template interpolation)'],
  ['instrumented-test', 'instrumented androidTest (not supported)'],
  ['unsupported-source-set', 'unsupported KMP source set'],
  ['pin-unresolved', 'pin not tied to a called function'],
  ['relation-unbound', 'relational oracle (direction-only) — can\'t pin a value'],
  ['probe-cap', 'not probed (cap/time budget)'],
  ['env-abort', 'not probed (env abort)'],
]);
export function banner(r) {
  if (r.scopeError) return '';
  const bits = [`probed ${r.probes} function${r.probes === 1 ? '' : 's'}`, `runner=${r.runner}`];
  if (r.skipped && r.skipped.length) {
    const counts = new Map();
    for (const s of r.skipped) counts.set(s.why, (counts.get(s.why) || 0) + 1);
    const parts = [];
    for (const [why] of SKIP_LABELS) if (counts.has(why)) { parts.push(`${counts.get(why)} ${SKIP_LABELS.get(why)}`); counts.delete(why); }
    for (const why of [...counts.keys()].sort()) parts.push(`${counts.get(why)} ${why}`);
    bits.push(`${r.skipped.length} skipped (${parts.join(', ') || 'not probeable'})`);
  }
  if (r.outOfScope) bits.push(`${r.outOfScope} out of diff scope`);
  if (r.capped) bits.push(`${r.capped} not probed (cap)`);
  return bits.join(' · ');
}

const hollowMsg = (h) => `'${h.name}' passes even when ${(h.survivors || []).join(', ')}() is replaced with a wrong return value — it does not test that function.`;
// The `baseline Xp/Yf` inconclusive bucket = probed tests ALREADY FAILING before any mutation (wild-pilot
// HEAD-rot finding: common in the wild, previously silent outside --json). Shared by every renderer below
// so the signal is CONSISTENT across surfaces, and language-universal by construction — the bucket is
// built at prove()'s single baseline gate, the same code path for every runner (JS/TS, pytest, gradle).
// Always a WARNING, never an exit-code flip: CI's own test run fails on these anyway; gutcheck reports.
const baselineFailRows = (r) => (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
const alreadyFailingMsg = (i) => `'${i.name}' already fails before any mutation (${i.why}) — it verifies nothing until it passes.`;

// SARIF 2.1.0 over the hollow[] payload (errors) + already-failing baselines (warnings) — uploads as
// code-scanning annotations on the PR diff.
export function formatSarif(r) {
  const results = (r.hollow || []).map((h) => ({
    ruleId: 'hollow-test',
    level: 'error',
    message: { text: hollowMsg(h) },
    locations: [{ physicalLocation: { artifactLocation: { uri: h.file }, region: { startLine: h.line } } }],
  })).concat(baselineFailRows(r).map((i) => ({
    ruleId: 'already-failing-test',
    level: 'warning',
    message: { text: alreadyFailingMsg(i) },
    locations: [{ physicalLocation: { artifactLocation: { uri: i.file }, region: { startLine: i.line } } }],
  })));
  return JSON.stringify({
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{ tool: { driver: { name: 'gutcheck', version: VERSION, informationUri: 'https://github.com/beepometer/gutcheck',
      rules: [
        { id: 'hollow-test', shortDescription: { text: 'A test that stays green even when the function it covers is replaced with a wrong return value — it does not test that function.' } },
        { id: 'already-failing-test', shortDescription: { text: 'A probed test that fails before any mutation is applied — it verifies nothing until it passes.' } },
      ] } }, results }],
  }, null, 2);
}

// GitHub Actions workflow commands — inline ::error annotations for hollow tests, ::warning annotations
// for already-failing baselines, and a ::notice coverage-denominator roll-up when the diff touched at
// least one function. Properties escape ,/:/%/CR/LF; the message escapes %/CR/LF
// (https://docs.github.com/actions/using-workflows/workflow-commands).
export function formatGithub(r) {
  const eProp = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C').replace(/:/g, '%3A');
  const eData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const cs = r.changeSummary;
  // Same-diff-oracle provenance + probe-cap-out-of-unverifiable (Task 7): clones the hook's phrasing
  // (hooks/check-changed-tests) — both fragments render only when their count is > 0, FACT-ONLY wording.
  const provenPart = cs && (cs.sameDiffProven || 0) > 0 ? ` (${cs.sameDiffProven} via tests changed in this diff)` : '';
  const notProbedPart = cs && (cs.notProbed || 0) > 0 ? `, ${cs.notProbed} not probed (cap)` : '';
  const notice = (cs && cs.fns > 0) ? [`::notice::gutcheck: of ${cs.fns} function(s) changed — ${cs.proven} proven${provenPart}, ${cs.untested} with no binding test${(cs.unverifiable || 0) > 0 ? `, ${cs.unverifiable} unverifiable` : ''}${notProbedPart}. (npx gutcheck --explain <file:line> for a receipt.)`] : [];
  return notice.concat((r.hollow || [])
    .map((h) => `::error file=${eProp(h.file)},line=${h.line},title=${eProp('gutcheck: hollow test')}::${eData(hollowMsg(h))}`)
    .concat(baselineFailRows(r)
      .map((i) => `::warning file=${eProp(i.file)},line=${i.line},title=${eProp('gutcheck: test already failing')}::${eData(alreadyFailingMsg(i))}`)))
    .join('\n');
}

const STATUS_MD = { proven: '✅ proven', hollow: '❌ hollow', unverifiable: '❔ unverifiable', untested: '∅ untested' };
// Row-level status label: a probe-cap row is status:'unverifiable' (real reference evidence, just never
// run under the cap — see mutation/changes.mjs' PROBE-CAP OUT OF `unverifiable` comment), but the
// changeSummary header below splits it into its own `notProbed` count so it must never render as the
// plain "❔ unverifiable" STATUS_MD lookup would — that would contradict the header's own (smaller)
// unverifiable count on the very same report. `changes[].status` itself stays 'unverifiable' (JSON
// consumers unaffected); this override is markdown-rendering only.
function statusMd(c) {
  if (c.status === 'unverifiable' && c.evidence && c.evidence.reason === 'probe-cap') return '⏸ not probed';
  return STATUS_MD[c.status];
}
// Evidence cell text per status. proven/hollow are execution-backed (one deciding block, per
// classifyChanges' precedence) — cite it as file:line "name" + what happened. unverifiable/untested are
// name-search (no execution ran): unverifiable names the dominant why-reason; untested has none to name.
function evidenceMd(c) {
  if (c.status === 'hollow' && c.evidence.reason === 'wrong-layer-shadow') {
    const b = c.evidence.blocks[0];
    return `${b.file}:${b.line} '${b.name}' re-implements the logic and asserts it against a second copy of itself (zero production contact): \`${c.evidence.echo}\``;
  }
  if (c.status === 'proven' || c.status === 'hollow') {
    const b = c.evidence.blocks[0];
    return c.status === 'proven'
      ? `${b.file}:${b.line} '${b.name}' went red when gutted`
      : `${b.file}:${b.line} '${b.name}' still passes when gutted`;
  }
  if (c.status === 'unverifiable') return c.evidence.reason;
  return 'no test mentions it';
}

// gutcheck --format=markdown: a PR-comment-ready body over the diff verification report (r.changes/
// r.changeSummary from a --since run). No percentages — counts only, matching every other renderer.
export function formatMarkdown(r) {
  const lines = ['## gutcheck — diff verification report', ''];
  if (r.scopeError) { lines.push(`scopeError: ${r.scopeError}`); return lines.join('\n'); }
  if (!r.changeSummary) { lines.push('no diff scope (`--since=<ref>` required for markdown output).'); return lines.join('\n'); }
  const cs = r.changeSummary;
  // Same probe-cap-out-of-unverifiable split as formatReport's diff lead (mutation/prove.mjs
  // formatDiffReport) and formatGithub's ::notice above: only rendered when notProbed > 0, so an
  // older/hand-built changeSummary (or a run with no cap fired) renders byte-identical to before this
  // cell existed.
  const notProbedPart = (cs.notProbed || 0) > 0 ? ` · not probed (cap) ${cs.notProbed}` : '';
  lines.push(`**${cs.fns} function${cs.fns === 1 ? '' : 's'} changed** · proven ${cs.proven} · hollow ${cs.hollow} · unverifiable ${cs.unverifiable} · untested ${cs.untested}${notProbedPart}`);
  lines.push('');
  // Probe mechanics on the CI surface (field feedback): a reader deciding how much to trust the gate
  // as coverage needs the mutation/survivor counts and the skipped total HERE, not only in --json —
  // an area that is mostly unverifiable must be visible at a glance.
  lines.push(`*probed ${r.probes} fn${r.probes === 1 ? '' : 's'} · ${r.caught}/${r.scored} bound · ${(r.skipped || []).length} test${(r.skipped || []).length === 1 ? '' : 's'} skipped · runner ${r.runner}*`);
  lines.push('');
  lines.push('| Function | File | Status | Evidence |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of r.changes) lines.push(`| \`${c.fn}\` | ${c.file} | ${statusMd(c)} | ${evidenceMd(c)} |`);
  // Every hollow the run found must appear on THIS surface: the exit code counts r.hollow across the
  // whole probed scope (a touched test file is probed whole-file), so a hollow whose function is not a
  // changed-function row would otherwise fail the check with no visible receipt in the PR comment.
  // Same extraHollowOf set-subtraction the default report (prove.mjs formatDiffReport) renders.
  const extraHollow = extraHollowOf(r);
  if (extraHollow.length) {
    lines.push('');
    lines.push(`❌ ${extraHollow.length} hollow test(s) found in the probed scope beyond the changed functions:`);
    for (const h of extraHollow) lines.push(`- ${h.file}:${h.line} '${h.name}' — still passes when ${(h.survivors || []).join(', ')}() is gutted`);
  }
  // Side signals (same inconclusive buckets as formatReport's human variant, see mutation/prove.mjs):
  // probed tests already failing at HEAD (the most actionable — fix these first), a flaky test's
  // unstable-green rerun, and a title collision that breaks per-test selection for humans too (not just
  // the runner). Only when count > 0; sits between the table and the receipts line below.
  const bf = baselineFailRows(r);
  if (bf.length) { lines.push(''); lines.push(`⚠️ ${bf.length} probed test(s) already fail before any mutation — they verify nothing until they pass: ${bf.map((i) => `${i.file}:${i.line}`).join(', ')}`); }
  const flakyN = (r.inconclusive || []).filter((i) => /^flaky baseline/.test(i.why)).length;
  if (flakyN) { lines.push(''); lines.push(`⚠️ ${flakyN} test(s) were unstable across identical reruns — flaky, not verdicts.`); }
  const collisionN = (r.inconclusive || []).filter((i) => /^ambiguous title/.test(i.why)).length;
  if (collisionN) { lines.push(''); lines.push(`⚠️ ${collisionN} test title collision(s) — colliding titles also break per-test selection for humans (rename or qualify).`); }
  // Identity-stub advisory (--deep) — per-function ratios, mirroring formatReport's human variant. An
  // audit of 13 --deep survivors found 9/13 legitimate (intentional no-op branches or accidental
  // fixed-point inputs) and zero fully-fixed-point-covered functions, so survival alone never implies a
  // gap — advisory only. Sits between the side-signals above and the receipts line below.
  if (r.weak && r.weak.length) {
    lines.push('');
    lines.push('#### Identity-stub advisory (--deep)');
    lines.push('');
    // A passed:0 fn had every identity stub CAUGHT — a success story, not an advisory — so it is omitted
    // entirely (final-review wave, item 6). r.weak.length > 0 guarantees at least one fn has passed > 0.
    for (const fn of Object.keys(r.weakSummary || {})) {
      const { stubbed, passed } = r.weakSummary[fn];
      if (!passed) continue;
      lines.push(`- \`${fn}\`: ${passed} of ${stubbed} identity-stub probes passed`);
    }
    lines.push('');
    lines.push('_May cover only fixed points — no-op tests pass identity stubs by design._');
  }
  // Boundary-blind-spot aggregate over the one-sided tier — mirrors the diff surface's inline
  // headline (period form: the heading opens the section, the sentence closes it). Rows unchanged.
  if (r.oneSided && r.oneSided.length) {
    lines.push('');
    lines.push('#### Boundary blind spots');
    lines.push('');
    lines.push(oneSidedLines(r.oneSided, 'inline')[0].replace(/:$/, '.'));
    lines.push('');
    for (const o of r.oneSided) lines.push(`- ${o.file}:${o.line} '${o.name}' — \`${o.fn}\`() gutted: ${o.posRed ? 'red under the positive sentinel, passes under the negative one' : 'passes under the positive sentinel, red under the negative one'}`);
  }
  if (r.caught > 0) {
    lines.push('');
    lines.push(`✓ ${r.caught} test${r.caught === 1 ? '' : 's'} verified: gutted the function, the test went red.`);
  }
  lines.push('');
  lines.push('---');
  lines.push('*Evidence classes: **proven/hollow** are execution-backed (we mutated the function and reran its test). **unverifiable/untested** are name-search (a same-named function elsewhere can confuse them). Only value-pinning tests with locatable functions are probeable — the per-reason skip breakdown is in the default report and `--json` output.*');
  return lines.join('\n');
}

// gutcheck --explain <file:line>: re-run the probe scoped to that test file and explain the one block.
function explain(dir, target, runner) {
  const ci = target.lastIndexOf(':');
  const file = target.slice(0, ci); const line = Number(target.slice(ci + 1));
  if (ci < 0 || !Number.isInteger(line)) { process.stderr.write('usage: gutcheck --explain <file:line>\n'); return 2; }
  let code; try { code = readFileSync(resolve(dir, file), 'utf8'); } catch { process.stderr.write(`gutcheck --explain: cannot read ${file}\n`); return 2; }
  // Same extension→lang mapping prove()'s own file loop uses (mutation/prove.mjs, near its per-file
  // `lang` derivation) — this was hardcoded to 'js' for anything but .py, so parseBlocks below ran the
  // JS/TS it()/describe() regex over a Kotlin/Java file (no such calls exist there) and always came back
  // empty: EVERY Kotlin/Java --explain failed with "no test block at or before …", not just the
  // expression-bodied ones (Bug C's actual root cause; Bug B's parseBlocks fix is a separate, necessary-
  // but-not-sufficient piece — this file's own lang derivation was never passing 'kotlin'/'java' at all).
  const lang = file.endsWith('.py') ? 'python' : file.endsWith('.kt') ? 'kotlin' : file.endsWith('.java') ? 'java' : 'js';
  const blk = parseBlocks(code, lang).filter((b) => b.line <= line).sort((a, b) => b.line - a.line)[0];
  if (!blk) { process.stderr.write(`gutcheck --explain: no test block at or before ${file}:${line}\n`); return 2; }
  const r = prove(dir, { files: [file], runner });
  const hollow = r.hollow.find((h) => h.name === blk.name);
  const skip = (r.skipped || []).find((h) => h.name === blk.name);
  const incon = (r.inconclusive || []).find((h) => h.name === blk.name);
  const out = [`${file}:${blk.line} '${blk.name}'`];
  if (hollow) {
    // Same (fn, sutRel) disambiguation as the Stop hook's block reason, same fallback: an old-shape
    // result (survivorPairs absent) still names the bare fn.
    const pair = (hollow.survivorPairs || [])[0];
    const fn = pair ? pair.fn : ((hollow.survivors || [])[0] || 'the function');
    const label = pair && pair.sutRel ? `${fn}() (${pair.sutRel})` : `${fn}()`;
    out.push(`  → HOLLOW. gutcheck replaced ${label}'s body with \`return 987654321\` and reran only this test.`);
    out.push(`  before: PASS   after gutting ${label}: PASS  ← the test can't tell the function is broken.`);
    out.push('  Fix: assert the real expected value, not one re-derived from the function under test.');
    process.stdout.write(out.join('\n') + '\n'); return 1;
  }
  if (skip) {
    const msg = skip.why === 'sut-unresolved'
      ? 'not probed: the test pins a value, but the function it tests could not be located from the test file\'s imports (relative-import SUTs only).'
      : skip.why === 'ungutable'
        ? 'not probed: no compiling wrong-value sentinel for the tested function — a data-class/collection return type, or an unsupported body form.'
        : skip.why === 'dynamic-title'
          ? 'not probed: the title contains template-literal interpolation (`${...}`) — its runtime value can\'t be known statically, so no runner selection can target it.'
          : 'not probed: no value-pinning assertion (toBe/toEqual/strictEqual/===). gutcheck only probes tests that pin a value.';
    out.push(`  → ${msg}`); process.stdout.write(out.join('\n') + '\n'); return 0;
  }
  if (incon) {
    out.push(`  → inconclusive: ${incon.why}.`);
    if (incon.detail) out.push('  runner output (tail):\n    ' + String(incon.detail).trim().split('\n').join('\n    '));
    process.stdout.write(out.join('\n') + '\n'); return 0;
  }
  // Named receipt (field report 2026-07-22 §6): r.proven[] carries WHICH fn this block bound, same
  // (fn, sutRel) disambiguation as the hollow branch above — falls back to the generic line only for
  // an old-shape result (no r.proven at all, e.g. a stale hook-side cache of a pre-this-task run).
  const prov = (r.proven || []).find((p) => p.name === blk.name);
  if (prov) {
    const pair = (prov.pairs || [])[0];
    const fn = pair ? pair.fn : ((prov.fns || [])[0] || 'the function');
    const label = pair && pair.sutRel ? `${fn}() (${pair.sutRel})` : `${fn}()`;
    out.push(`  → PROVEN. gutcheck replaced ${label}'s body with a wrong-value sentinel and reran only this test: it FAILED — the test binds ${label} (binds, not certifies correct).`);
    process.stdout.write(out.join('\n') + '\n'); return 0;
  }
  out.push('  → PROVEN. gutting the function it tests makes this test FAIL — the test binds the function (binds, not certifies correct).');
  process.stdout.write(out.join('\n') + '\n'); return 0;
}

// gutcheck --demo: plant a tiny known example — one test that pins a real value, one whose "expected"
// value re-runs the function under test — and run the real probe over it. No project required, so the
// first invocation always shows a visible catch within seconds, before the caller has written anything.
function demo() {
  const d = mkdtempSync(join(tmpdir(), 'gutcheck-demo-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
    writeFileSync(join(d, 'src/lib.mjs'), 'export function dbl(x){ return x * 2; }\n');
    writeFileSync(join(d, 'test/s.test.mjs'),
      "import { test } from 'node:test'; import assert from 'node:assert';\n" +
      "import { dbl } from '../src/lib.mjs';\n" +
      "test('sound: pins a real value', () => { assert.strictEqual(dbl(3), 6); });\n" +
      "test('hollow: its oracle re-runs the function', () => { const e = dbl(3); assert.strictEqual(dbl(3), e); });\n");
    process.stdout.write('gutcheck --demo — a planted example (no project needed): one real test, one hollow test, run through the real probe.\n\n');
    const r = prove(d, { runner: 'node' });
    process.stdout.write(banner(r) + '\n');
    process.stdout.write(formatReport(r) + '\n');
    return r.hollow.length ? 1 : 0;
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// selfComparisonOracle is NOT in LINT_KINDS and NOT in the adopter-facing floor (pulled from
// configure/gutcheck.default.json / configure/checksets/python.mjs): measured CYCLE-10, high base rate,
// ~zero defect yield (intent-flagging = noise) — the mutation probe owns the harmful subset instead.
// The kind module stays, reachable only via an explicit checker config.
// fallbackCollapse is now PROMOTED after earning it via CYCLE-10 corpus measurement (16 TRUE / 0 FP post-tightening).
const LINT_KINDS = new Set(['derivationCoherence', 'assertionConsistency', 'testShapeGuard', 'fallbackCollapse']);

// gutcheck lint — a sub-second deterministic pass of the near-zero-FP triage oracles (derivation
// coherence, assertion consistency, hollow test shapes, fallback-collapse) for diffs with no probeable tests.
// Reuses the bundled checker filtered to those four kinds (which run the fail-closed meta-guard first).
function lint(dir) {
  dir = resolve(dir);
  let built; try { built = configForProject(dir); } catch (e) { process.stderr.write(`gutcheck lint: ${e && e.message}\n`); return 2; }
  const { cfg, reason, testRoots, testFileCount } = built;
  if (!cfg) { process.stderr.write(`gutcheck lint: nothing to scan — ${reason}\n`); return 2; }
  cfg.checker.checks = (cfg.checker.checks || []).filter((c) => LINT_KINDS.has(c.kind));
  if (!cfg.checker.checks.length) { process.stdout.write(`gutcheck lint: no triage checks for ${cfg.language.fileExt} (JS/TS + Python only)\n`); return 0; }
  let res; try { res = runChecker(cfg, { harnessDir: dir, repoRoot: dir, testSrcRoots: testRoots }); }
  catch (e) { process.stderr.write(`gutcheck lint: ${e && e.message}\n`); return 2; }
  if (res.phase === 'meta-guard') {
    process.stderr.write('gutcheck lint: self-check FAILED — a triage check no longer catches its own planted bug. Refusing to run.\n');
    for (const f of res.failures) process.stderr.write('  ✗ ' + f + '\n');
    return 2;
  }
  const findings = res.offenders.filter((o) => o.severity !== 'advisory');
  const srcLine = (file, n) => { for (const p of [join(dir, file), file]) { try { return (readFileSync(p, 'utf8').split('\n')[n - 1] || '').trim(); } catch {} } return ''; };
  if (!findings.length) { process.stdout.write(`gutcheck lint: OK — ${testFileCount} test file(s), ${res.checkCount} checks, 0 findings\n`); return 0; }
  process.stderr.write(`gutcheck lint: ${findings.length} finding(s):\n`);
  for (const f of findings) process.stderr.write(`  ✗ ${f.file}:${f.line}  [${f.check}]  ${srcLine(f.file, f.line).slice(0, 90)}\n`);
  return 1;
}

// Best-effort recovery when a --since=<ref> can't be resolved by git (prove.mjs's generic "not a git
// repo, or unknown ref" scopeError — most commonly an unfetched remote branch, e.g. the README's own
// `--since origin/main` before a `git fetch`). Tries, in order: origin/HEAD's branch (reads the locally
// recorded symbolic ref — no network), local `main`, local `master`, `HEAD~1` (only reachable with 2+
// commits). Returns the merge-base of HEAD and the first candidate that resolves, so the probe scopes to
// "since this branch diverged" (matching what --since=<upstream> is meant to express), paired with a
// human-readable label for the fallback note — or null when nothing resolves.
function resolveSinceFallback(dir) {
  const git = (args) => { try { return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
  const originHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  for (const cand of [originHead, 'main', 'master', 'HEAD~1'].filter(Boolean)) {
    if (!git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`])) continue;
    const base = git(['merge-base', 'HEAD', cand]);
    if (base) return { ref: base, label: cand };
  }
  return null;
}

// gutcheck gate --harness=<h>: reads the harness's Stop-event JSON from stdin, runs the shared gate core
// (mutation/gate.mjs), and prints its response payload when non-null. Always exits 0 (fail-open by
// contract — the gate never wants to be the reason an agent's turn errors out); an unknown --harness name
// degrades to silent no-op inside runGate itself.
function gate(opts) {
  const harnessName = opts.get('harness') || 'claude';
  let stdinText = '';
  try { stdinText = readFileSync(0, 'utf8'); } catch { stdinText = ''; }
  const out = runGate({ harnessName, dir: process.cwd(), stdinText, env: process.env });
  if (out) process.stdout.write(out + '\n');
  return 0;
}

// Flags that take a value. Both `--k=v` and `--k v` are accepted — the README quotes the space form.
const VALUE_FLAGS = new Set(['since', 'files', 'runner', 'format', 'max-probes', 'time-budget', 'explain', 'harness']);
export function parseArgs(argv) {
  const opts = new Map(); const flags = new Set(); const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { positionals.push(a); continue; }
    if (!a.startsWith('--')) { flags.add(a.slice(1)); continue; }
    const body = a.slice(2); const eq = body.indexOf('=');
    if (eq !== -1) { opts.set(body.slice(0, eq), body.slice(eq + 1)); continue; }
    if (VALUE_FLAGS.has(body) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) { opts.set(body, argv[++i]); continue; }
    flags.add(body);
  }
  return { opts, flags, positionals };
}

export function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }
  if (argv.includes('--version') || argv.includes('-v')) { process.stdout.write(`gutcheck ${VERSION}\n`); return 0; }
  if (argv.includes('--demo')) return demo();
  const { opts, flags, positionals } = parseArgs(argv);
  const runner = opts.get('runner');

  // Usage errors exit 2 BEFORE any probe runs: a CI typo must never silently pass, silently change
  // semantics, or pay the full probe cost for output that is then discarded.
  const KNOWN_FLAGS = new Set(['json', 'deep', 'no-fallback', 'no-self-check', 'explain', 'demo', 'help', 'version', 'h', 'v']);
  for (const f of flags) if (!KNOWN_FLAGS.has(f) && !VALUE_FLAGS.has(f)) { process.stderr.write(`gutcheck: unknown flag --${f} (see --help)\n`); return 2; }
  for (const k of opts.keys()) if (!VALUE_FLAGS.has(k)) { process.stderr.write(`gutcheck: unknown option --${k} (see --help)\n`); return 2; }
  const fmt = opts.get('format');
  if (fmt && !['sarif', 'github', 'markdown'].includes(fmt)) { process.stderr.write(`gutcheck: unknown --format: ${fmt} (sarif|github|markdown)\n`); return 2; }
  if (runner && !RUNNERS.includes(runner)) { process.stderr.write(`gutcheck: unknown --runner: ${runner} (${RUNNERS.join('|')})\n`); return 2; }
  if (fmt === 'markdown' && !opts.get('since')) { process.stderr.write('gutcheck: --format=markdown requires --since=<ref> (it reports the diff)\n'); return 2; }

  if (positionals[0] === 'lint') return lint(positionals[1] || process.cwd());
  if (positionals[0] === 'gate') return gate(opts);

  if (opts.has('explain') || flags.has('explain')) {
    const tgt = opts.get('explain');
    if (!tgt) { process.stderr.write('usage: gutcheck --explain <file:line>\n'); return 2; }
    return explain(positionals[0] || process.cwd(), tgt, runner);
  }

  const dirArg = positionals[0] || process.cwd();
  const dir = resolve(dirArg);
  let st = null; try { st = statSync(dir); } catch {}
  if (!st || !st.isDirectory()) { process.stderr.write(`gutcheck: path not found: ${dirArg}\n`); return 2; }

  const json = flags.has('json');
  const format = opts.get('format'); // 'sarif' | 'github' | 'markdown' (machine-readable, like --json: no banners)
  const machine = json || format === 'sarif' || format === 'github' || format === 'markdown';

  if (!flags.has('no-self-check')) {
    const sc = selfCheck();
    if (!sc.ok) { process.stderr.write(`gutcheck self-check FAILED — ${sc.detail}. Refusing to run.\n`); return 2; }
    (machine ? process.stderr : process.stdout).write('gutcheck self-check ✓ — caught its planted fake test, passed its planted real test\n');
  }

  // Progress: one stderr line per probed block — a long diff-scoped run must never look hung.
  // Human mode always; machine mode only on an interactive stderr (CI logs and the hook stay clean).
  const showProgress = !machine || process.stderr.isTTY === true;
  let probedCount = 0;
  const onProgress = showProgress ? ((p) => { probedCount++; process.stderr.write(`probing #${probedCount}: ${p.file} :: '${p.name}'\n`); }) : undefined;
  // Default cap 40 when --max-probes is absent: a bare `npx gutcheck` (or a big --since diff) on an
  // uncapped project must never look hung. The hook (--max-probes=20) and CI's action.yml (defaults to
  // 40 itself) always pass the flag explicitly, so this default is reached only on a first-contact,
  // no-flags run — exactly the case it protects.
  const proveOpts = { files: opts.get('files') ? opts.get('files').split(',') : undefined, runner, deep: flags.has('deep'), maxProbes: opts.get('max-probes') ? Number(opts.get('max-probes')) : 40, timeBudgetMs: opts.get('time-budget') ? Number(opts.get('time-budget')) * 1000 : undefined, onProgress };
  const since = opts.get('since');
  let r = prove(dir, { ...proveOpts, since });
  let fallback = '';
  // A --since ref git can't resolve (prove.mjs's generic "not a git repo, or unknown ref" scopeError —
  // most commonly an unfetched remote branch, e.g. the README's own `--since origin/main` before a
  // `git fetch`) is a first-run stumble worth recovering from automatically. Only when `dir` IS a git
  // repo (a genuinely non-git directory keeps the original cryptic scopeError/exit-2, unchanged below):
  // try a resolvable stand-in via resolveSinceFallback and re-run with it, noting the substitution; if
  // nothing resolves, one actionable stderr line replaces the raw scopeError (still exit 2 — there is
  // genuinely nothing to probe).
  if (since && r.scopeError && /not a git repo, or unknown ref/.test(r.scopeError)) {
    let isGitRepo = false;
    try { execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); isGitRepo = true; } catch {}
    if (isGitRepo) {
      const fb = resolveSinceFallback(dir);
      if (fb) {
        process.stderr.write(`gutcheck: --since=${since} did not resolve — falling back to --since=${fb.label} (merge-base with HEAD).\n`);
        r = prove(dir, { ...proveOpts, since: fb.ref });
      } else {
        process.stderr.write(`gutcheck: could not resolve --since=${since} — fetch it (git fetch), or try --since=HEAD~1.\n`);
        return 2;
      }
    }
  }
  // an empty --since scope (the diff touched no probeable test) is a silent loss on a first run — fall
  // back to a full-suite scan so the run always lands on something, and say so. --format=markdown is
  // exempt: it IS the diff report by definition (a full-suite scan drops `changed`, and formatMarkdown
  // then falls back to "no diff scope" prose instead of the truthful "0 functions changed" zero-state) —
  // so a docs-only diff renders the honest zero, never a silently widened scan.
  if (since && !r.scopeError && r.changedFileCount === 0) {
    if (!machine) { process.stdout.write(`gutcheck: no files changed since ${since} — nothing to probe.\n`); return 0; }
  } else if (since && !flags.has('no-fallback') && format !== 'markdown' && !r.scopeError && r.outOfScope > 0 && r.scored === 0 && r.probes === 0 && !(r.changeSummary && r.changeSummary.hollow > 0)) {
    // A wrongLayerShadow finding (static, JVM) makes scored/probes both 0 yet reports a real hollow via
    // changeSummary — without the trailing guard the "no probeable tests" fallback would drop the diff
    // scope and full-suite-rescan, silently discarding that hollow (the MINOR inconsistent-surfacing
    // vector: it showed in markdown/--no-fallback but vanished under the default fallback). Keep the diff
    // result when it carries a hollow.
    fallback = `--since=${since} touched no probeable tests — scanning the full suite instead.\n`;
    r = prove(dir, proveOpts);
  }
  // r.hollow is execution-based (a block the probe actually gutted and re-ran); r.changeSummary.hollow
  // ALSO counts a wrongLayerShadow finding (mutation/wrongLayerShadow.mjs), which is static and never runs
  // anything, so it never lands in r.hollow — checking both keeps the exit code truthful on a --since run
  // whose ONLY finding is a wrong-layer-shadow (report says hollow, exit code must agree). A no-diff-scope
  // run has r.changeSummary === null, so this is byte-identical to the old check there.
  const exit = () => (r.scopeError ? 2 : (r.hollow.length || (r.changeSummary && r.changeSummary.hollow > 0)) ? 1 : 0);
  if (format === 'sarif') { process.stdout.write(formatSarif(r) + '\n'); return exit(); }
  if (format === 'github') { const g = formatGithub(r); if (g) process.stdout.write(g + '\n'); return exit(); }
  if (format === 'markdown') { process.stdout.write(formatMarkdown(r) + '\n'); return exit(); }
  if (json) { process.stdout.write(JSON.stringify(r) + '\n'); return exit(); }
  if (fallback) process.stdout.write(fallback);
  // A diff-scoped run (r.changeSummary present, i.e. --since resolved) leads with formatReport's own
  // diff verdict and trails with its own mechanics footnote — the whole-project banner() preamble would
  // just re-bury that verdict under whole-probed-set detail, so it is skipped entirely here. A full-suite
  // run (no --since, or one that fell back to a full-suite scan above) keeps the original banner-then-
  // report shape byte-for-byte — see the "byte-identical to the release format" test.
  if (!r.changeSummary) process.stdout.write(banner(r) + '\n');
  process.stdout.write(formatReport(r) + '\n');
  return exit();
}

// realpathSync resolves the .bin/gutcheck symlink npm installs (argv[1] is the symlink, not this file).
function isMain(metaUrl) { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(metaUrl); } catch { return false; } }
// exitCode, never process.exit(): exit() discards stdout still draining into a pipe, so a --json
// report past the 64KB pipe buffer reaches the consumer (the agent hook, CI) truncated with exit 0.
// main() is fully synchronous, so the process ends as soon as the buffers flush.
if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
