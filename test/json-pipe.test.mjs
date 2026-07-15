import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUT = resolve('mutation/gutcheck.mjs');
const head = "import { test } from 'node:test'; import assert from 'node:assert';";

// Machine consumers (the agent hook, the CI action) read --json through a PIPE. A JSON body larger
// than the 64KB pipe buffer must still arrive complete: process.exit() after console.log discards
// the undrained remainder — the consumer sees exit 0 with unterminated JSON and fails open.
// The fixture's ~900 no-pin skip rows push the report well past the buffer; zero probes run, so it
// stays fast (skips happen before any baseline).
test('--json survives a >64KB report through a pipe: complete JSON, exit 0', () => {
  const d = mkdtempSync(join(tmpdir(), 'gut-pipe-'));
  try {
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    mkdirSync(join(d, 'test'), { recursive: true });
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(d, 'test', `t${i}.test.mjs`),
        `${head}\n` +
        `test('alpha ${i}', () => { assert.ok(1); });\n` +
        `test('beta ${i}', () => { assert.ok(1); });\n` +
        `test('gamma ${i}', () => { assert.ok(1); });\n`);
    }
    const r = spawnSync(process.execPath, [GUT, d, '--json', '--runner=node'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `piped --json output must be complete, parseable JSON (got ${r.stdout.length} bytes ending ${JSON.stringify(r.stdout.slice(-40))})`);
    assert.ok(r.stdout.length > 70000,
      `fixture must push stdout past the 64KB pipe buffer to exercise the drain path — got ${r.stdout.length} bytes; grow the fixture if the format got terser`);
    assert.equal(r.status, 0, 'no hollow proven — exit 0');
    assert.equal(parsed.probes, 0, 'all blocks skip pre-baseline (no value-pinning assertion)');
    assert.ok((parsed.skipped || []).length >= 1200, 'the skip rows are the payload');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
