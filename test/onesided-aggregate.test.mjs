// Boundary-blind-spot aggregate over r.oneSided — spec:
// docs/specs/2026-07-16-boundary-aggregate-and-relational-reach-design.md (Feature 1).
// Every expected string here is hand-derived from the spec, never captured from the code.
import { test } from 'node:test';
import assert from 'node:assert';
import { formatReport } from '../mutation/prove.mjs';
import { formatMarkdown } from '../mutation/gutcheck.mjs';

const base = {
  runner: 'node', scored: 0, caught: 0, hollow: [], weak: [], oneSided: [], oneSidedBlocks: 0,
  inconclusive: [], skipped: [], outOfScope: 0, probes: 0, capped: 0, envAborted: 0, pct: null,
  changedFileCount: undefined, changes: null, changeSummary: null,
};
const row = (file, name, posRed) => ({ file, line: 3, name, fn: 'calc', posRed });

test('full-scan aggregate: generic header + per-direction breakdown, files count-desc then path-asc', () => {
  const out = formatReport({
    ...base, scored: 7, caught: 2, pct: 29, probes: 9, oneSidedBlocks: 5,
    oneSided: [
      row('src/rt60.test.ts', 'clamps rt60 low', true),
      row('src/rt60.test.ts', 'clamps rt60 high', true),
      row('src/stipa.test.ts', 'stipa floor', true),
      row('src/levels.test.ts', 'level floor', false),
      row('src/levels.test.ts', 'level ceil', false),
    ],
  });
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.startsWith('boundary blind spots:'));
  assert.notEqual(i, -1, 'aggregate header renders');
  assert.equal(lines[i], 'boundary blind spots: 5 one-sided test(s) — these bind one direction of error only; never a blocker:');
  assert.equal(lines[i + 1], '  bind only against too-high results (3): src/rt60.test.ts (2), src/stipa.test.ts (1)');
  assert.equal(lines[i + 2], '  bind only against too-low results (2): src/levels.test.ts (2)');
  assert.match(lines[i + 3], /^ {2}~ src\/rt60\.test\.ts:3/, 'per-row lines follow, unchanged');
  assert.ok(!out.includes('one-sided: tests that bind exactly one direction'), 'old generic header replaced');
});

test('full-scan aggregate: single direction emits no empty group line', () => {
  const out = formatReport({
    ...base, scored: 3, caught: 1, pct: 33, probes: 4, oneSidedBlocks: 2,
    oneSided: [row('a.test.ts', 'x', true), row('a.test.ts', 'y', true)],
  });
  assert.ok(out.includes('boundary blind spots: 2 one-sided test(s) — these bind one direction of error only; never a blocker:'));
  assert.ok(out.includes('  bind only against too-high results (2): a.test.ts (2)'));
  assert.ok(!out.includes('too-low'), 'zero-row direction is omitted');
});

test('full-scan aggregate: a single row collapses to the singular inline form, no breakdown', () => {
  const out = formatReport({
    ...base, scored: 2, caught: 1, pct: 50, probes: 3, oneSidedBlocks: 1,
    oneSided: [row('a.test.ts', 'x', false)],
  });
  assert.ok(out.includes('boundary blind spots: 1 one-sided test — binds only against too-low results; never a blocker:'));
  assert.ok(!out.includes('bind only against too-low results (1):'), 'no breakdown line for a single row');
});

test('full-scan aggregate: zero rows emit nothing', () => {
  const out = formatReport({ ...base, scored: 2, caught: 2, pct: 100, probes: 2 });
  assert.ok(!out.includes('boundary blind spots'));
  assert.ok(!out.includes('one-sided'));
});

// Diff surface: changeSummary present → formatDiffReport. Minimal well-formed diff result.
const diffBase = {
  ...base,
  changes: [],
  changeSummary: { fns: 1, proven: 1, hollow: 0, untested: 0, unverifiable: 0 },
};

test('diff aggregate: split counts inline, too-high first, verb agrees with count 1', () => {
  const out = formatReport({
    ...diffBase, scored: 4, caught: 1, pct: 25, probes: 5, oneSidedBlocks: 3,
    oneSided: [row('a.test.ts', 'x', true), row('b.test.ts', 'y', false), row('b.test.ts', 'z', false)],
  });
  assert.ok(out.includes('boundary blind spots: 3 one-sided test(s) — 1 binds only against too-high results, 2 only against too-low; never a blocker:'));
  assert.ok(!out.includes('bind only against too-high results (1):'), 'diff surface never renders the breakdown lines');
  assert.ok(!out.includes('one-sided: tests that bind exactly one direction'), 'old generic header replaced');
});

test('diff aggregate: plural counts on both sides', () => {
  const out = formatReport({
    ...diffBase, scored: 5, caught: 1, pct: 20, probes: 6, oneSidedBlocks: 4,
    oneSided: [row('a.test.ts', 'w', true), row('a.test.ts', 'x', true), row('b.test.ts', 'y', false), row('b.test.ts', 'z', false)],
  });
  assert.ok(out.includes('boundary blind spots: 4 one-sided test(s) — 2 bind only against too-high results, 2 only against too-low; never a blocker:'));
});

test('diff aggregate: one direction collapses to "all bind"', () => {
  const out = formatReport({
    ...diffBase, scored: 3, caught: 1, pct: 33, probes: 4, oneSidedBlocks: 2,
    oneSided: [row('a.test.ts', 'x', true), row('b.test.ts', 'y', true)],
  });
  assert.ok(out.includes('boundary blind spots: 2 one-sided test(s) — all bind only against too-high results; never a blocker:'));
});

test('diff aggregate: single row uses the singular form; zero rows emit nothing', () => {
  const one = formatReport({ ...diffBase, scored: 2, caught: 1, pct: 50, probes: 3, oneSidedBlocks: 1, oneSided: [row('a.test.ts', 'x', true)] });
  assert.ok(one.includes('boundary blind spots: 1 one-sided test — binds only against too-high results; never a blocker:'));
  const zero = formatReport({ ...diffBase, scored: 2, caught: 2, pct: 100, probes: 2 });
  assert.ok(!zero.includes('boundary blind spots'));
});

// Markdown surface: same synthetic-result pattern as test/gutcheck-cli.test.mjs:438.
test('markdown aggregate: heading + inline headline (period form), rows unchanged, italic tail gone', () => {
  const synthetic = {
    scopeError: null,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'dbl', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'sound' }] } }],
    caught: 1,
    inconclusive: [],
    oneSided: [row('src/a.test.ts', 'clamps', true), row('src/b.test.ts', 'floors', false)],
  };
  const out = formatMarkdown(synthetic);
  assert.ok(out.includes('#### Boundary blind spots'));
  assert.ok(out.includes('boundary blind spots: 2 one-sided test(s) — 1 binds only against too-high results, 1 only against too-low; never a blocker.'));
  assert.ok(!out.includes('#### One-sided'), 'old heading replaced');
  assert.ok(!out.includes('_Binds exactly one direction'), 'italic tail subsumed by the headline');
  assert.match(out, /- src\/a\.test\.ts:3 'clamps' — `calc`\(\) gutted: red under the positive sentinel, passes under the negative one/);
});

test('markdown aggregate: zero rows emit no section', () => {
  const out = formatMarkdown({
    scopeError: null,
    changeSummary: { fns: 1, proven: 1, hollow: 0, unverifiable: 0, untested: 0 },
    changes: [{ fn: 'dbl', file: 'src/lib.mjs', status: 'proven', evidence: { blocks: [{ file: 'test/t.test.mjs', line: 3, name: 'sound' }] } }],
    caught: 1, inconclusive: [],
  });
  assert.ok(!out.includes('Boundary blind spots'));
  assert.ok(!out.includes('boundary blind spots'));
});
