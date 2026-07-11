#!/usr/bin/env node
// Render a saved `gutcheck --json` result for the GitHub Action's surfaces WITHOUT re-running the probe
// (the Action probes once; annotations, the sticky-comment markdown, SARIF, and the fail gate all read
// the same saved result). Reuses the CLI's own tested formatters — never a re-implementation.
// Usage: node ci/action-render.mjs <github|markdown|sarif|count-hollow> <result.json>
import { readFileSync } from 'node:fs';
import { formatGithub, formatSarif, formatMarkdown } from '../mutation/gutcheck.mjs';

const [mode, file] = process.argv.slice(2);
const MODES = { github: formatGithub, markdown: formatMarkdown, sarif: formatSarif, 'count-hollow': (r) => String((r.hollow || []).length) };
if (!MODES[mode] || !file) {
  console.error('usage: action-render.mjs <github|markdown|sarif|count-hollow> <result.json>');
  process.exit(2);
}
const out = MODES[mode](JSON.parse(readFileSync(file, 'utf8')));
if (out) process.stdout.write(out + '\n');
