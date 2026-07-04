import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'skills', 'check', 'SKILL.md');

test('check SKILL.md exists with name + description frontmatter', () => {
  assert.ok(existsSync(SKILL), 'skills/check/SKILL.md missing');
  const head = readFileSync(SKILL, 'utf8').split('\n').slice(0, 15).join('\n');
  assert.match(head, /^---\s*$/m, 'no frontmatter fence');
  assert.match(head, /^name:\s*check\s*$/m, 'missing "name: check"');
  assert.match(head, /^description:\s*\S/m, 'missing non-empty description:');
});

test('check SKILL.md references the bundled checker + mutation probe + citation agent, and they resolve', () => {
  const body = readFileSync(SKILL, 'utf8');
  for (const ref of ['checker/cli.mjs', 'mutation/probe.mjs']) {
    assert.ok(body.includes(ref), `SKILL.md does not reference ${ref}`);
    assert.ok(existsSync(join(ROOT, ref)), `referenced path does not resolve: ${ref}`);
  }
  // The one discipline routes deep citation work to the opt-in citation-verifier agent.
  assert.ok(body.includes('citation-verifier'), 'SKILL.md must route abstract citations to the citation-verifier agent');
  assert.ok(existsSync(join(ROOT, 'agents', 'citation-verifier.md')), 'citation-verifier agent template missing');
});
