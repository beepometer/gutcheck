#!/usr/bin/env node
// gutcheck — prove your AI-written tests actually test your code. It guts each tested function with a
// guaranteed-wrong return and reruns only that test; a test that still passes is HOLLOW (it doesn't test
// that function). Default action: run the probe over your tests (scope with --since) and report the
// hollow ones. Fronted by a self-check ("won't run until it catches its own planted fake test").
import { readFileSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { prove, formatReport, parseBlocks } from './prove.mjs';
import { selfCheck } from './selfcheck.mjs';
import { configForProject } from '../checker/standalone.mjs';
import { runChecker } from '../checker/core.mjs';

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();
const HELP = `gutcheck ${VERSION} — prove your AI-written tests actually test your code

  gutcheck [path] [--since <ref>]   gut each tested function and rerun its test; report the HOLLOW ones
                                    (--since scopes to tests touched since <ref>, falling back to a
                                    full-suite scan when that diff touches no probeable test; --files=a,b;
                                    --runner=R)
  (every value flag accepts both --k=v and --k v)
  gutcheck lint [path]              sub-second deterministic triage (derivation/assertion/shape oracles)
  gutcheck --explain <file:line>    show the proof for one test: the mutation applied + before/after result
  gutcheck [path] --max-probes=<n>  cap the number of functions probed (bounds latency on a big diff)
  gutcheck [path] --no-fallback     never widen an empty --since scope to a full-suite scan (used by the agent hook)
  gutcheck [path] --format=sarif    SARIF 2.1.0 for CI code-scanning upload (no banners)
  gutcheck [path] --format=github   GitHub ::error inline PR annotations (no banners)
  gutcheck [path] --format=markdown PR-comment body: a table of changed functions + proof status (--since)
  gutcheck [path] --json            machine-readable result, no banners (for CI / the agent hook)
  gutcheck --demo                   run a planted example (no project needed) — see a real catch in seconds
  gutcheck --no-self-check          skip the startup self-check (applies to all modes; not recommended)
  gutcheck --version | --help
`;

// "probed N · runner=X · M skipped · K out of diff scope" — every run says what it actually did, so a
// zero-finding run reads as "verified N bite", not "did nothing".
function banner(r) {
  if (r.scopeError) return '';
  const bits = [`probed ${r.probes} function${r.probes === 1 ? '' : 's'}`, `runner=${r.runner}`];
  if (r.skipped && r.skipped.length) {
    const n = (w) => r.skipped.filter((s) => s.why === w).length;
    const parts = [];
    if (n('no-pin')) parts.push(`${n('no-pin')} no value-pinning assertion`);
    if (n('sut-unresolved')) parts.push(`${n('sut-unresolved')} tested function not locatable`);
    if (n('ungutable')) parts.push(`${n('ungutable')} function body not guttable`);
    bits.push(`${r.skipped.length} skipped (${parts.join(', ') || 'not probeable'})`);
  }
  if (r.outOfScope) bits.push(`${r.outOfScope} out of diff scope`);
  if (r.capped) bits.push(`${r.capped} not probed (cap)`);
  return bits.join(' · ');
}

const hollowMsg = (h) => `"${h.name}" passes even when ${(h.survivors || []).join(', ')}() is replaced with a wrong return value — it does not test that function.`;

// SARIF 2.1.0 over the hollow[] payload — uploads as code-scanning annotations on the PR diff.
function formatSarif(r) {
  const results = (r.hollow || []).map((h) => ({
    ruleId: 'hollow-test',
    level: 'error',
    message: { text: hollowMsg(h) },
    locations: [{ physicalLocation: { artifactLocation: { uri: h.file }, region: { startLine: h.line } } }],
  }));
  return JSON.stringify({
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{ tool: { driver: { name: 'gutcheck', version: VERSION, informationUri: 'https://github.com/beepometer/gutcheck',
      rules: [{ id: 'hollow-test', shortDescription: { text: 'A test that stays green even when the function it covers is replaced with a wrong return value — it does not test that function.' } }] } }, results }],
  }, null, 2);
}

// GitHub Actions workflow commands — inline ::error annotations on the PR. Properties escape ,/:/%/CR/LF;
// the message escapes %/CR/LF (https://docs.github.com/actions/using-workflows/workflow-commands).
function formatGithub(r) {
  const eProp = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C').replace(/:/g, '%3A');
  const eData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return (r.hollow || [])
    .map((h) => `::error file=${eProp(h.file)},line=${h.line},title=${eProp('gutcheck: hollow test')}::${eData(hollowMsg(h))}`)
    .join('\n');
}

const STATUS_MD = { proven: '✅ proven', hollow: '❌ hollow', unverifiable: '❔ unverifiable', untested: '∅ untested' };
// Evidence cell text per status. proven/hollow are execution-backed (one deciding block, per
// classifyChanges' precedence) — cite it as file:line "name" + what happened. unverifiable/untested are
// name-search (no execution ran): unverifiable names the dominant why-reason; untested has none to name.
function evidenceMd(c) {
  if (c.status === 'proven' || c.status === 'hollow') {
    const b = c.evidence.blocks[0];
    return c.status === 'proven'
      ? `${b.file}:${b.line} "${b.name}" went red when gutted`
      : `${b.file}:${b.line} "${b.name}" still passes when gutted`;
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
  lines.push(`**${cs.fns} function${cs.fns === 1 ? '' : 's'} changed** · proven ${cs.proven} · hollow ${cs.hollow} · unverifiable ${cs.unverifiable} · untested ${cs.untested}`);
  lines.push('');
  lines.push('| Function | File | Status | Evidence |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of r.changes) lines.push(`| \`${c.fn}\` | ${c.file} | ${STATUS_MD[c.status]} | ${evidenceMd(c)} |`);
  // Side signals (same two inconclusive buckets as formatReport's human variant, see mutation/prove.mjs):
  // a flaky test's unstable-green rerun, and a title collision that breaks per-test selection for humans
  // too (not just the runner). Only when count > 0; sits between the table and the receipts line below.
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
  if (r.caught > 0) {
    lines.push('');
    lines.push(`✓ verified ${r.caught} test${r.caught === 1 ? '' : 's'} genuinely catch${r.caught === 1 ? 'es' : ''} breaks (broke the function, the test went red).`);
  }
  lines.push('');
  lines.push('---');
  lines.push('*Evidence classes: **proven/hollow** are execution-backed (we mutated the function and reran its test). **unverifiable/untested** are name-search (a same-named function elsewhere can confuse them). Only value-pinning tests with locatable functions are probeable — skipped tests are counted in the run banner. Top-level functions only (JS/TS + Python).*');
  return lines.join('\n');
}

// gutcheck --explain <file:line>: re-run the probe scoped to that test file and explain the one block.
function explain(dir, target, runner) {
  const ci = target.lastIndexOf(':');
  const file = target.slice(0, ci); const line = Number(target.slice(ci + 1));
  if (ci < 0 || !Number.isInteger(line)) { process.stderr.write('usage: gutcheck --explain <file:line>\n'); return 2; }
  let code; try { code = readFileSync(resolve(dir, file), 'utf8'); } catch { process.stderr.write(`gutcheck --explain: cannot read ${file}\n`); return 2; }
  const lang = file.endsWith('.py') ? 'python' : 'js';
  const blk = parseBlocks(code, lang).filter((b) => b.line <= line).sort((a, b) => b.line - a.line)[0];
  if (!blk) { process.stderr.write(`gutcheck --explain: no test block at or before ${file}:${line}\n`); return 2; }
  const r = prove(dir, { files: [file], runner });
  const hollow = r.hollow.find((h) => h.name === blk.name);
  const skip = (r.skipped || []).find((h) => h.name === blk.name);
  const incon = (r.inconclusive || []).find((h) => h.name === blk.name);
  const out = [`${file}:${blk.line} "${blk.name}"`];
  if (hollow) {
    const fn = (hollow.survivors || [])[0] || 'the function';
    out.push(`  → HOLLOW. gutcheck replaced ${fn}()'s body with \`return 987654321\` and reran only this test.`);
    out.push(`  before: PASS   after gutting ${fn}(): PASS  ← the test can't tell the function is broken.`);
    out.push('  Fix: assert the real expected value, not one re-derived from the function under test.');
    process.stdout.write(out.join('\n') + '\n'); return 1;
  }
  if (skip) {
    const msg = skip.why === 'sut-unresolved'
      ? 'not probed: the test pins a value, but the function it tests could not be located from the test file\'s imports (relative-import SUTs only).'
      : skip.why === 'ungutable'
        ? 'not probed: the tested function\'s body could not be gutted (unsupported declaration form).'
        : 'not probed: no value-pinning assertion (toBe/toEqual/strictEqual/===). gutcheck only probes tests that pin a value.';
    out.push(`  → ${msg}`); process.stdout.write(out.join('\n') + '\n'); return 0;
  }
  if (incon) {
    out.push(`  → inconclusive: ${incon.why}.`);
    if (incon.detail) out.push('  runner output (tail):\n    ' + String(incon.detail).trim().split('\n').join('\n    '));
    process.stdout.write(out.join('\n') + '\n'); return 0;
  }
  out.push('  → SOUND. gutting the function it tests makes this test FAIL, so it genuinely tests it.');
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

const LINT_KINDS = new Set(['derivationCoherence', 'assertionConsistency', 'testShapeGuard']);

// gutcheck lint — a sub-second deterministic pass of the near-zero-FP triage oracles (derivation
// coherence, assertion consistency, hollow test shapes) for diffs with no probeable tests. Reuses the
// bundled checker filtered to those three kinds (which run the fail-closed meta-guard first).
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

// Flags that take a value. Both `--k=v` and `--k v` are accepted — the README quotes the space form.
const VALUE_FLAGS = new Set(['since', 'files', 'runner', 'format', 'max-probes', 'explain']);
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

  if (positionals[0] === 'lint') return lint(positionals[1] || process.cwd());

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
  const onProgress = showProgress ? ((p) => { probedCount++; process.stderr.write(`probing #${probedCount}: ${p.file} :: "${p.name}"\n`); }) : undefined;
  const proveOpts = { files: opts.get('files') ? opts.get('files').split(',') : undefined, runner, deep: flags.has('deep'), maxProbes: opts.get('max-probes') ? Number(opts.get('max-probes')) : undefined, onProgress };
  const since = opts.get('since');
  let r = prove(dir, { ...proveOpts, since });
  let fallback = '';
  // an empty --since scope (the diff touched no probeable test) is a silent loss on a first run — fall
  // back to a full-suite scan so the run always lands on something, and say so. --format=markdown is
  // exempt: it IS the diff report by definition (a full-suite scan drops `changed`, and formatMarkdown
  // then falls back to "no diff scope" prose instead of the truthful "0 functions changed" zero-state) —
  // so a docs-only diff renders the honest zero, never a silently widened scan.
  if (since && !r.scopeError && r.changedFileCount === 0) {
    if (!machine) { process.stdout.write(`gutcheck: no files changed since ${since} — nothing to probe.\n`); return 0; }
  } else if (since && !flags.has('no-fallback') && format !== 'markdown' && !r.scopeError && r.outOfScope > 0 && r.scored === 0 && r.probes === 0) {
    fallback = `--since=${since} touched no probeable tests — scanning the full suite instead.\n`;
    r = prove(dir, proveOpts);
  }
  const exit = () => (r.scopeError ? 2 : r.hollow.length ? 1 : 0);
  if (format === 'sarif') { process.stdout.write(formatSarif(r) + '\n'); return exit(); }
  if (format === 'github') { const g = formatGithub(r); if (g) process.stdout.write(g + '\n'); return exit(); }
  if (format === 'markdown') { process.stdout.write(formatMarkdown(r) + '\n'); return exit(); }
  if (json) { process.stdout.write(JSON.stringify(r) + '\n'); return exit(); }
  if (fallback) process.stdout.write(fallback);
  process.stdout.write(banner(r) + '\n');
  process.stdout.write(formatReport(r) + '\n');
  return exit();
}

// realpathSync resolves the .bin/gutcheck symlink npm installs (argv[1] is the symlink, not this file).
function isMain(metaUrl) { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(metaUrl); } catch { return false; } }
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
