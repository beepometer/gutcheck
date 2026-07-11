import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

// win32: `npm` resolves to `npm.cmd`, and spawning a .cmd file without shell:true throws EINVAL on
// patched Node (the same class of bug as root cause B — see mutation/prove.mjs's resolveRunnerBin
// comment) — a test-harness limitation, not a packaging one. Packaging itself is platform-independent
// (the tarball's file list doesn't vary by OS) and is already verified on the ubuntu/macos legs.
test('npm pack ships exactly the runtime closure of the gutcheck bin', { skip: process.platform === 'win32' ? 'npm.cmd spawn needs shell:true on Windows; packaging is platform-independent — verified on the unix legs' : false }, () => {
  const out = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
  const files = new Set(out[0].files.map((f) => f.path));
  for (const must of ['mutation/gutcheck.mjs', 'mutation/prove.mjs', 'mutation/probe.mjs', 'mutation/confirm.mjs', 'mutation/selfcheck.mjs', 'mutation/py_blocks.py',
    'checker/standalone.mjs', 'checker/core.mjs', 'checker/lexer.mjs', 'checker/corpus.mjs', 'checker/cli.mjs',
    'configure/detect.mjs', 'configure/gutcheck.default.json', 'configure/checksets/index.mjs', 'configure/checksets/python.mjs',
    // hooks/session-start: the harness-agnostic SessionStart baseline recorder every non-Claude
    // integration's own SessionStart wiring invokes directly (see integrations/*/README.md) — the one
    // hooks/ file listed in package.json's `files`. hooks/README.md rides along automatically (npm
    // always includes a directory's README once any of its files are packed) — harmless documentation,
    // not code; no other hooks/* file (hooks.json, check-changed-tests, user-prompt-submit — the
    // Claude-Code-specific plugin wiring) is listed, so none of them travel.
    'hooks/session-start', 'hooks/README.md',
    'integrations/README.md', 'integrations/codex/hooks.json', 'integrations/codex/README.md',
    'integrations/aider/README.md',
    'integrations/cursor/hooks.json', 'integrations/cursor/README.md',
    'integrations/copilot/hooks/gutcheck.json', 'integrations/copilot/README.md',
    'integrations/antigravity/hooks.json', 'integrations/antigravity/README.md',
    'LICENSE', 'README.md'])
    assert.ok(files.has(must), `tarball is missing ${must}`);
  const HOOKS_ALLOW = new Set(['hooks/session-start', 'hooks/README.md']); // see comment above
  for (const f of files) {
    if (HOOKS_ALLOW.has(f)) continue;
    assert.ok(!/^(dist|hooks|skills|agents|test|docs|benchmark|scripts|ci)\//.test(f), `tarball leaks non-runtime file: ${f}`);
    assert.ok(!/skeptic/.test(f), `tarball leaks a legacy file: ${f}`);
  }
});
