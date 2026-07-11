// The GitHub Action (action.yml + ci/action-render.mjs): the probe runs ONCE (--json), and every surface
// (annotations, sticky-comment markdown, SARIF, the fail gate) renders from that saved result — probing
// once per surface would multiply CI minutes. action-render.mjs is exercised for REAL (execFile over a
// hand-built result fixture); action.yml is contract-checked at the text level (zero-dep repo: no YAML
// parser — the checks pin the load-bearing strings, not the full schema).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = join(ROOT, 'ci', 'action-render.mjs');

const FIXTURE = {
  scopeError: null,
  changeSummary: { fns: 3, proven: 1, hollow: 1, unverifiable: 0, untested: 1 },
  changes: [
    { fn: 'dbl', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'sound' }] } },
    { fn: 'total', file: 'src/cart.mjs', status: 'hollow', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 8, name: 'echo' }] } },
    { fn: 'ghost', file: 'src/lib.mjs', status: 'untested', evidence: {} },
  ],
  caught: 1,
  hollow: [{ file: 'test/t.test.mjs', line: 8, name: 'echo', survivors: ['total'] }],
  inconclusive: [{ file: 'test/u.test.mjs', line: 9, name: 'broken', why: 'baseline 0p/1f' }],
};

function render(mode, fixture = FIXTURE) {
  const d = mkdtempSync(join(tmpdir(), 'gc-action-'));
  try {
    const f = join(d, 'r.json');
    writeFileSync(f, JSON.stringify(fixture));
    return execFileSync('node', [RENDER, mode, f], { encoding: 'utf8' });
  } finally { rmSync(d, { recursive: true, force: true }); }
}

test('action-render: github mode emits ::error for hollow + ::warning for already-failing', () => {
  const out = render('github');
  assert.match(out, /^::error file=test\/t\.test\.mjs,line=8,/m);
  assert.match(out, /^::warning file=test\/u\.test\.mjs,line=9,/m);
});

test('action-render: markdown mode renders the diff verification table + side-signal', () => {
  const out = render('markdown');
  assert.match(out, /diff verification report/);
  assert.match(out, /`total`.*❌ hollow/);
  assert.match(out, /already fail before any mutation/);
});

test('action-render: sarif mode emits both rules; count-hollow prints the number', () => {
  const sarif = JSON.parse(render('sarif'));
  assert.equal(sarif.runs[0].results.length, 2);
  assert.equal(render('count-hollow').trim(), '1');
});

test('action-render: unknown mode exits 2 with usage', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-action-'));
  try {
    const f = join(d, 'r.json'); writeFileSync(f, '{}');
    assert.throws(() => execFileSync('node', [RENDER, 'nope', f], { encoding: 'utf8', stdio: 'pipe' }), /status.*2|Command failed/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('action.yml: composite action contract (inputs, renderer wiring, branding)', () => {
  assert.ok(existsSync(join(ROOT, 'action.yml')), 'action.yml exists at the repo root');
  const y = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.match(y, /using:\s*['"]?composite/);
  for (const k of ['path:', 'since:', 'max-probes:', 'comment:', 'sarif-file:', 'fail-on-hollow:', 'node-version:']) {
    assert.ok(y.includes(k), `input declared: ${k}`);
  }
  assert.match(y, /mutation\/gutcheck\.mjs/, 'runs the probe from the action checkout');
  assert.match(y, /ci\/action-render\.mjs/, 'renders every surface from the saved JSON');
  assert.match(y, /GITHUB_STEP_SUMMARY/, 'writes the job summary');
  assert.match(y, /gutcheck-report/, 'sticky-comment marker present');
  assert.match(y, /branding:/);
  assert.match(y, /--max-probes="\$IN_MAX" --no-fallback/,
    'the action never silently widens an unscoped/failed --since to a full-suite run (CI must stay diff-scoped)');
});

test('ci/gutcheck.yml: every template invocation (Modes A/B/C) scopes with --no-fallback', () => {
  const y = readFileSync(join(ROOT, 'ci', 'gutcheck.yml'), 'utf8');
  assert.match(y, /--format sarif --no-fallback/, 'Mode A (SARIF) never widens to a full-suite scan');
  assert.match(y, /--format github --no-fallback/, 'Mode B (gate) never widens to a full-suite scan');
  assert.match(y, /--format=markdown --no-fallback/, 'Mode C (sticky comment) never widens to a full-suite scan');
});
