#!/usr/bin/env node
// Build the FROZEN pilot task set from MBPP-sanitized (run ONCE; tasks.jsonl is the registered artifact).
// Deterministic: problems in task_id order; first 25 JS-eligible -> the JS arm, then the first 25
// remaining py-eligible -> the Python arm. Specs carry the MBPP prompt only — the driver owns the
// file-contract wording, and NOTHING here ever leaks an oracle into a spec.
// Usage: node build-tasks.mjs <mbpp.json> [--out=tasks.jsonl]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const mbpp = process.argv[2];
if (!mbpp || mbpp.startsWith('--')) { console.error('usage: build-tasks.mjs <mbpp.json> [--out=tasks.jsonl]'); process.exit(2); }

const candidates = JSON.parse(execFileSync('python3', [join(HERE, 'translate_mbpp.py'), mbpp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const JS_N = 25, PY_N = 25;
const js = candidates.filter((c) => c.js_ok).slice(0, JS_N);
const used = new Set(js.map((c) => c.task_id));
const py = candidates.filter((c) => c.py_ok && !used.has(c.task_id)).slice(0, PY_N);

const rows = [
  ...js.map((c) => ({
    id: `js-${c.task_id}`, language: 'js', entry: c.entry, signature: c.signature,
    spec: c.prompt, src_path: 'src/solution.mjs', test_path: 'test/solution.test.mjs',
    hidden_oracle: c.js_oracle,
  })),
  ...py.map((c) => ({
    id: `py-${c.task_id}`, language: 'py', entry: c.entry, signature: c.signature,
    spec: c.prompt, src_path: 'solution.py', test_path: 'test_solution.py',
    hidden_oracle: c.py_oracle,
  })),
];

const out = args.out || join(HERE, 'tasks.jsonl');
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`frozen ${rows.length} tasks (${js.length} js + ${py.length} py) -> ${out}`);
