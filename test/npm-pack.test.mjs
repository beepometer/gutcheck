import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

test('npm pack ships exactly the runtime closure of the gutcheck bin', () => {
  const out = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
  const files = new Set(out[0].files.map((f) => f.path));
  for (const must of ['mutation/gutcheck.mjs', 'mutation/prove.mjs', 'mutation/probe.mjs', 'mutation/confirm.mjs', 'mutation/selfcheck.mjs', 'mutation/py_blocks.py',
    'checker/standalone.mjs', 'checker/core.mjs', 'checker/lexer.mjs', 'checker/corpus.mjs', 'checker/cli.mjs',
    'configure/detect.mjs', 'configure/gutcheck.default.json', 'configure/checksets/index.mjs', 'configure/checksets/python.mjs',
    'LICENSE', 'README.md'])
    assert.ok(files.has(must), `tarball is missing ${must}`);
  for (const f of files) {
    assert.ok(!/^(dist|hooks|skills|agents|test|docs|benchmark|scripts|ci)\//.test(f), `tarball leaks non-runtime file: ${f}`);
    assert.ok(!/skeptic/.test(f), `tarball leaks a legacy file: ${f}`);
  }
});
