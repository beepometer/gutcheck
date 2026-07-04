import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => spawnSync(process.execPath, [join(ROOT, 'checker', 'cli.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });

test('CLI exits 2 when the config is missing', () => {
  const r = run(['--config', join(ROOT, 'does-not-exist.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gutcheck check:/, 'CLI output must use the gutcheck-branded prefix');
  assert.doesNotMatch(r.stderr, /skeptic checker:/, 'CLI output must not leak the old skeptic-checker branding');
});
