import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginManifest } from '../scripts/build-plugin.mjs';
import { LINT_KINDS } from '../mutation/gutcheck.mjs';
import * as KINDS from '../checker/kinds/index.mjs';

// The editorial rule ("no effectiveness or outcome claims — mechanism and receipts only") was enforced
// only in review, and three shipped product descriptions drifted past it: marketplace.json, the npm
// package description, and the hardcoded literal in pluginManifest(). This gate covers the SHORT,
// machine-readable description fields plus the three highest-traffic surfaces a stranger reads first —
// the --help banner and its file header (mutation/gutcheck.mjs), the shipped CI template
// (ci/gutcheck.yml), and the agent-facing skill doc (skills/check/SKILL.md) — scanned whole-file since
// the breach in those three was prose, not a parsed field. README.md and docs/ stay review-enforced on
// purpose: a phrase blocklist over prose-heavy files is false-positive noise, and prose is not where
// either breach happened.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const FORBIDDEN = [
  { re: /prove\w*\s+your\b[^.]*tests?\s+actually\s+test/i,
    why: 'asserts the code is correct; README.md states proven means the tests BIND the function' },
  { re: /mutation score/i,
    why: 'a capped, diff-filtered denominator does not yield a score' },
  { re: /catch(?:es)?\s+hollow/i,
    why: 'an outcome claim; the mechanism and the receipt are the claim' },
];

const SUBJECTS = () => [
  ['marketplace.json plugin description', JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].description],
  ['package.json description', JSON.parse(read('package.json')).description],
  // Assert on the FUNCTION'S OUTPUT, not the file text: pluginManifest() is what actually ships into
  // dist/gutcheck/.claude-plugin/plugin.json, and it hardcodes the description rather than reading
  // package.json (only `version` comes from PKG).
  ['pluginManifest() description', JSON.parse(pluginManifest()).description],
  // action.yml is currently clean — included as a regression pin. Whole-file, not a parsed field: it is
  // short YAML with a folded block scalar, and no forbidden phrase belongs anywhere in it.
  ['action.yml', read('action.yml')],
  // The final-review wave found the rule enforced on four description fields while the --help banner, the
  // CI template, and the skill doc still carried the exact forbidden phrase — the most-read surfaces of
  // all. Whole-file, same reasoning as action.yml above.
  ['mutation/gutcheck.mjs', read('mutation/gutcheck.mjs')],
  ['ci/gutcheck.yml', read('ci/gutcheck.yml')],
  ['skills/check/SKILL.md', read('skills/check/SKILL.md')],
];

test('editorial: no product description makes an effectiveness or outcome claim', () => {
  const hits = [];
  for (const [name, text] of SUBJECTS()) {
    assert.ok(typeof text === 'string' && text.length > 0, `${name}: no text found`);
    for (const { re, why } of FORBIDDEN) {
      const m = text.match(re);
      if (m) hits.push(`${name}: ${JSON.stringify(m[0])} — ${why}`);
    }
  }
  assert.deepEqual(hits, [], `forbidden claim(s):\n  ${hits.join('\n  ')}`);
});

// P6 of the external review: both agent-facing docs claimed "three checker kinds" against a tree with
// ten. Three different real numbers exist (kinds implemented / kinds gutcheck lint selects / checks the
// emitted floor carries), so pin the DOCS to the CODE rather than to a literal — the same
// derivation-coherence discipline the checker itself enforces on test files.
test('editorial: the agent-facing docs state check counts that match the code', () => {
  const implemented = Object.keys(KINDS).length;
  const lintSelected = LINT_KINDS.size;
  const floorChecks = JSON.parse(read('configure/gutcheck.default.json')).checker.checks.length;

  // AGENTS.md is a symlink to CLAUDE.md (`ls -la AGENTS.md`), so this loop reads the same bytes twice —
  // it exists to catch a future de-symlinking that lets the two documents drift.
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    const text = read(doc);
    assert.ok(text.includes(`${implemented} checker kinds`),
      `${doc} must state "${implemented} checker kinds" (checker/kinds/index.mjs exports ${implemented})`);
    assert.ok(text.includes(`${lintSelected} that earned`),
      `${doc} must state "${lintSelected} that earned" (LINT_KINDS selects ${lintSelected})`);
    assert.ok(text.includes(`${floorChecks}-check floor`),
      `${doc} must state "${floorChecks}-check floor" (gutcheck.default.json carries ${floorChecks})`);
  }
});
