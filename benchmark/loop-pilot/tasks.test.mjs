// The FROZEN task set (pre-registration §5): well-formedness + the contamination invariant. Oracles are
// hand-derived contract checks, never pinned from the builder's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'tasks.jsonl');

const rows = () => readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('tasks.jsonl exists and carries >= 40 well-formed tasks across both languages', () => {
  assert.ok(existsSync(FILE), 'tasks.jsonl is the frozen artifact');
  const ts = rows();
  assert.ok(ts.length >= 40, `>= 40 tasks, got ${ts.length}`);
  const langs = new Set(ts.map((t) => t.language));
  assert.deepEqual([...langs].sort(), ['js', 'py']);
  for (const t of ts) {
    assert.ok(t.id && t.spec && t.entry && t.hidden_oracle, `complete: ${t.id}`);
    assert.ok(Array.isArray(t.hidden_oracle) && t.hidden_oracle.length >= 2, `>=2 oracle asserts: ${t.id}`);
    assert.ok(t.src_path && t.test_path, `path contract: ${t.id}`);
  }
});

test('contamination invariant: no spec leaks its own oracle text', () => {
  for (const t of rows()) {
    for (const a of t.hidden_oracle) {
      assert.ok(!t.spec.includes(a.trim()), `oracle assert leaked into spec: ${t.id}`);
    }
  }
});

test('JS tasks carry JS-syntax oracles; py tasks carry python asserts', () => {
  for (const t of rows()) {
    for (const a of t.hidden_oracle) {
      if (t.language === 'js') assert.match(a, /deepStrictEqual|strictEqual/, `js oracle shape: ${t.id}`);
      else assert.match(a, /^assert /, `py oracle shape: ${t.id}`);
    }
  }
});
