#!/usr/bin/env node
// The aggregator: rolls results.jsonl (the driven diffs) into the summary tables the kill-decision
// reads, plus renders report.md + receipts.md from all five evidence inputs (funnel, work, results,
// archaeology, trajectory-yield). Zero deps.
// Usage: node aggregate.mjs [--out=benchmark/evidence/results]
import { readJsonl } from './lib.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATUSES = ['ok', 'clone-failed', 'checkout-failed', 'install-failed', 'probe-error', 'timeout'];
const SKIP_REASONS = ['no-pin', 'sut-unresolved', 'ungutable'];

// THE deliverable: pure, rows = results.jsonl array. Never a silent drop — an unexpected status or
// skip reason still gets counted (as an extra key), it just isn't one of the contract's named ones.
export function aggregate(rows) {
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of rows) by_status[r.status] = (by_status[r.status] || 0) + 1;

  const okRows = rows.filter((r) => r.status === 'ok' && r.gutcheck);

  let diffs_with_probes = 0, total_probed = 0, zero_probeable_ok_diffs = 0;
  let caught = 0, hollow = 0, inconclusive = 0;
  const by_reason = Object.fromEntries(SKIP_REASONS.map((s) => [s, 0]));
  const hollow_list = [];

  for (const r of okRows) {
    const g = r.gutcheck;
    const probes = g.probes || 0;
    total_probed += probes;
    if (probes > 0) diffs_with_probes++; else zero_probeable_ok_diffs++;

    caught += g.caught || 0;
    hollow += (g.hollow || []).length;
    inconclusive += (g.inconclusive || []).length;

    for (const s of g.skipped || []) by_reason[s.why] = (by_reason[s.why] || 0) + 1;
    for (const h of g.hollow || []) hollow_list.push({ id: r.id, repo: r.repo, sha: r.sha, file: h.file, line: h.line, name: h.name, survivors: h.survivors });
  }

  return {
    diffs: { total: rows.length, by_status },
    probeable: { diffs_with_probes, total_probed, zero_probeable_ok_diffs },
    verdicts: { caught, hollow, inconclusive },
    skips: { by_reason },
    hollow_list,
  };
}

// ---- CLI: renders report.md + receipts.md from all five inputs (any may be absent). ----

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a (0 denominator)'; }

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

// Extracts the "KNOWN LIMITATION (audit gate...)" comment block from archaeology.mjs's own header,
// so the warning quoted in report.md can never drift out of sync with the source it describes.
export function extractAuditGateWarning(archaeologyMjsPath) {
  let text; try { text = readFileSync(archaeologyMjsPath, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('KNOWN LIMITATION'));
  if (start === -1) return null;
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].startsWith('//')) break;
    collected.push(lines[i].replace(/^\/\/\s?/, ''));
  }
  return collected.join(' ');
}

function renderFunnelSection(funnelRows, present) {
  if (!present) return '## Funnel\n\n`funnel.jsonl` not found — skipped.\n';
  if (!funnelRows.length) return '## Funnel\n\n`funnel.jsonl` present but empty — 0 candidates logged.\n';
  const queries = [...new Set(funnelRows.map((r) => r.query))];
  const reasons = [...new Set(funnelRows.map((r) => r.excluded))].sort();
  const rows = reasons.map((reason) => {
    const perQuery = queries.map((q) => String(funnelRows.filter((r) => r.excluded === reason && r.query === q).length));
    const total = funnelRows.filter((r) => r.excluded === reason).length;
    return [reason, ...perQuery, String(total)];
  });
  rows.push(['**Total**', ...queries.map((q) => String(funnelRows.filter((r) => r.query === q).length)), String(funnelRows.length)]);
  return `## Funnel\n\n${mdTable(['Reason', ...queries, 'Total'], rows)}\n`;
}

function renderDriveSection(summary, workRows, workPresent) {
  const rows = STATUSES.map((s) => [s, String(summary.diffs.by_status[s])]);
  const extra = Object.keys(summary.diffs.by_status).filter((s) => !STATUSES.includes(s));
  for (const s of extra) rows.push([s, String(summary.diffs.by_status[s])]);
  rows.push(['**Total**', String(summary.diffs.total)]);
  const coverage = workPresent
    ? `\nWork items harvested (\`work.jsonl\`): ${workRows.length}. Diffs driven: ${summary.diffs.total} (${pct(summary.diffs.total, workRows.length)} of harvested).\n`
    : '\n`work.jsonl` not found — harvested-vs-driven coverage skipped.\n';
  return `## Drive statuses\n\n${mdTable(['Status', 'Count'], rows)}\n${coverage}`;
}

function renderProbeableSection(summary) {
  const ok = summary.diffs.by_status.ok;
  return `## Probeable fraction\n\n`
    + `- Diffs with at least one probe: ${summary.probeable.diffs_with_probes} / ${ok} ok diffs (${pct(summary.probeable.diffs_with_probes, ok)})\n`
    + `- Total probes run across ok diffs: ${summary.probeable.total_probed}\n`
    + `- Ok diffs with zero probeable sites: ${summary.probeable.zero_probeable_ok_diffs}\n`;
}

function renderVerdictsSection(summary) {
  const rows = [
    ['caught', String(summary.verdicts.caught)],
    ['hollow', String(summary.verdicts.hollow)],
    ['inconclusive', String(summary.verdicts.inconclusive)],
  ];
  return `## Verdicts\n\n${mdTable(['Verdict', 'Count'], rows)}\n`;
}

function renderSkipsSection(summary) {
  const rows = Object.entries(summary.skips.by_reason).map(([reason, n]) => [reason, String(n)]);
  return `## Skip reasons\n\n${mdTable(['Reason', 'Count'], rows)}\n`;
}

function renderArchaeologySection(archRows, present) {
  if (!present) return '## Archaeology\n\n`archaeology.jsonl` not found — skipped.\n';
  if (!archRows.length) return '## Archaeology\n\n`archaeology.jsonl` present but empty — 0 candidates scanned.\n';
  const byStatus = {};
  for (const r of archRows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const statusRows = Object.entries(byStatus).sort((a, b) => a[0].localeCompare(b[0])).map(([s, n]) => [s, String(n)]);
  const warning = extractAuditGateWarning(join(REPO_ROOT, 'benchmark', 'evidence', 'archaeology.mjs'))
    || 'KNOWN LIMITATION (audit gate, do not trust hollow_hits unaudited) — warning text unavailable (archaeology.mjs not found or header changed).';
  const hits = archRows.filter((r) => (r.hollow_hits || []).length > 0);
  const hitLines = hits.length
    ? hits.flatMap((r) => r.hollow_hits.map((h) => `- \`${r.repo}\` @ \`${r.fix_sha}\`: \`${h.file}:${h.line}\` "${h.name}" — survives gutting ${h.survivors.join(', ')}()`))
    : ['(none — 0 hollow_hits across all scanned candidates)'];
  return `## Archaeology\n\n${mdTable(['Status', 'Count'], statusRows)}\n\n`
    + `> ${warning}\n\n`
    + `Hollow hits:\n\n${hitLines.join('\n')}\n`;
}

function renderTrajectorySection(yieldData, yieldPresent, correctionText) {
  let body;
  if (!yieldPresent || !yieldData) {
    body = '`trajectory-yield.json` not found — skipped.\n';
  } else if (yieldData.status === 'layout-defeated') {
    body = `layout-defeated: ${yieldData.notes || '(no notes)'}\n`;
  } else {
    const { submissions_checked = [], patches_scanned = 0, patches_touching_tests = 0 } = yieldData;
    body = `- Submissions checked: ${submissions_checked.join(', ') || '(none)'}\n`
      + `- Patches scanned: ${patches_scanned}\n`
      + `- Patches touching a test file: ${patches_touching_tests} / ${patches_scanned} (${pct(patches_touching_tests, patches_scanned)})\n`;
  }
  const correction = correctionText
    ? `\n---\n\n${correctionText}\n`
    : '';
  return `## Trajectory yield\n\n${body}${correction}`;
}

function renderProvenanceFooter(resultsRows) {
  const versions = [...new Set(resultsRows.map((r) => r.gutcheck_version).filter(Boolean))].sort();
  return `## Provenance\n\n- \`gutcheck_version\` values seen: ${versions.length ? versions.join(', ') : '(none)'}\n`
    + `- Generated: ${new Date().toISOString()}\n`;
}

export function renderReport({ summary, funnelRows, funnelPresent, workRows, workPresent, archRows, archPresent, yieldData, yieldPresent, correctionText, resultsRows }) {
  return [
    '# Evidence pilot — aggregate report',
    '',
    renderFunnelSection(funnelRows, funnelPresent),
    renderDriveSection(summary, workRows, workPresent),
    renderProbeableSection(summary),
    renderVerdictsSection(summary),
    renderSkipsSection(summary),
    renderArchaeologySection(archRows, archPresent),
    renderTrajectorySection(yieldData, yieldPresent, correctionText),
    renderProvenanceFooter(resultsRows),
  ].join('\n');
}

export function renderReceipts(hollow_list) {
  const header = '# Evidence pilot — hollow receipts\n\nEvery hollow verdict from a driven diff. None of these are a claim — each MUST be verified manually\n(re-run `gutcheck --explain` inside the clone) before any use.\n\n';
  if (!hollow_list.length) return `${header}(none — 0 hollow verdicts across all driven diffs)\n`;
  const lines = hollow_list.map((h) => `- \`${h.repo}@${h.sha}\` \`${h.file}:${h.line}\` "${h.name}" — survives gutting ${h.survivors.join(', ')} — VERIFY MANUALLY (--explain in the clone) before any use`);
  return header + lines.join('\n') + '\n';
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const outDir = args.out || 'benchmark/evidence/results';

  const resultsFile = join(outDir, 'results.jsonl');
  const funnelFile = join(outDir, 'funnel.jsonl');
  const archFile = join(outDir, 'archaeology.jsonl');
  const workFile = join(outDir, 'work.jsonl');
  const yieldFile = join(outDir, 'trajectory-yield.json');
  const correctionFile = join(outDir, 'trajectory-yield-correction.md');

  const resultsPresent = existsSync(resultsFile);
  const funnelPresent = existsSync(funnelFile);
  const archPresent = existsSync(archFile);
  const workPresent = existsSync(workFile);
  const yieldPresent = existsSync(yieldFile);

  const resultsRows = readJsonl(resultsFile);
  const funnelRows = readJsonl(funnelFile);
  const archRows = readJsonl(archFile);
  const workRows = readJsonl(workFile);
  let yieldData = null;
  if (yieldPresent) { try { yieldData = JSON.parse(readFileSync(yieldFile, 'utf8')); } catch { yieldData = null; } }
  const correctionText = existsSync(correctionFile) ? readFileSync(correctionFile, 'utf8').trimEnd() : null;

  if (!resultsPresent) console.log('aggregate: results.jsonl not found — verdicts/probeable/skips will all read zero');
  if (!funnelPresent) console.log('aggregate: funnel.jsonl not found — funnel section skipped');
  if (!archPresent) console.log('aggregate: archaeology.jsonl not found — archaeology section skipped');
  if (!workPresent) console.log('aggregate: work.jsonl not found — coverage line skipped');
  if (!yieldPresent) console.log('aggregate: trajectory-yield.json not found — trajectory section skipped');
  if (correctionText) console.log('aggregate: trajectory-yield-correction.md found — inlining verbatim under trajectory section');

  const summary = aggregate(resultsRows);
  const report = renderReport({ summary, funnelRows, funnelPresent, workRows, workPresent, archRows, archPresent, yieldData, yieldPresent, correctionText, resultsRows });
  const receipts = renderReceipts(summary.hollow_list);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.md'), report);
  writeFileSync(join(outDir, 'receipts.md'), receipts);
  console.log(`wrote ${join(outDir, 'report.md')} and ${join(outDir, 'receipts.md')}`);
}

if (process.argv[1] && process.argv[1].endsWith('aggregate.mjs')) await main();
