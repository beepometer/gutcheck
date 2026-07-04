// mutation/confirm.mjs — turn the high-recall static candidates (weak/shadow-oracle flags) into
// EXECUTION-confirmed verdicts. For each candidate the checker nominated, find the production function
// feeding the flagged test, run the mutation probe (gut it, run only that test file), and reclassify:
//   SOUND        → the static flag was a false positive (a real, discriminating test) — cleared
//   HOLLOW       → the oracle genuinely does not check the SUT — confirmed (promoted to a hard finding)
//   INCONCLUSIVE → couldn't resolve / baseline / run — left as the original advisory
// This is precision WITHOUT a parser: the probe RUNS the test, so assertion dialect and multi-line shape
// never matter. JS/TS only for now (the probe's default `node --test <file>` runs a single JS test file);
// other languages return unsupported and their candidates stay advisory.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { codeOnly } from '../checker/lexer.mjs';
import { walkFiles } from '../checker/corpus.mjs';
import { testBlocks, FRAMEWORK } from '../checker/kinds/weakOracleGuard.mjs';
import { probe } from './probe.mjs';

const JS_EXT = /\.(?:m|c)?[jt]sx?$/;
const KEYWORD = /^(?:if|for|while|switch|catch|return|await|new|typeof|function|async|do|else|throw)$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// weak-oracle / shadow-oracle / assertion-free findings are probe-confirmable (each nominates a SUT call
// to gut). The id may be language-prefixed (js-weak-oracle-guard, shadow-oracle-guard, js-assertion-free-test).
const PROBE_KIND = /(?:^|-)(?:weak-oracle-guard|shadow-oracle-guard|assertion-free-test)$/;

export const isJsTs = (ext) => JS_EXT.test(ext || '');

// candidate SUT function names CALLED inside a test block (non-framework, non-keyword, non-method calls).
export function sutFnsIn(body) {
  const names = [];
  // Lookbehind (non-consuming) so adjacent calls aren't skipped: `eq(compute(5))` → [eq, compute].
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$]\w*)\s*\(/g)) {
    const id = m[1];
    if (!FRAMEWORK.has(id) && !KEYWORD.test(id) && !names.includes(id)) names.push(id);
  }
  return names;
}

// the it()/test() callback body whose source span contains a 1-based line (fall back to the whole file).
function bodyForLine(code, lineNo) {
  for (const b of testBlocks(code)) {
    const start = code.slice(0, b.index).split('\n').length;
    const end = start + (b.body.match(/\n/g) || []).length;
    if (lineNo >= start && lineNo <= end + 1) return b.body;
  }
  return code;
}

function declRe(fn) {
  const e = esc(fn);
  return new RegExp(
    `\\b(?:function|class)\\s+${e}\\b`
    + `|\\bfunction\\s*\\*\\s*${e}\\b`
    + `|\\b(?:const|let|var)\\s+${e}\\b`
    + `|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`,
  );
}

// a NON-test source file under the main roots that declares fn, as a path relative to dir; null if none.
function resolveSutFile(dir, mainRoots, ext, fn, isTest) {
  const re = declRe(fn);
  const roots = (mainRoots && mainRoots.length ? mainRoots : ['']).map((r) => join(dir, r));
  for (const root of roots) {
    for (const abs of walkFiles(root, ext)) {
      const rel = relative(dir, abs);
      if (isTest(rel)) continue;
      let code; try { code = codeOnly(readFileSync(abs, 'utf8'), 'typescript'); } catch { continue; }
      if (re.test(code)) return rel;
    }
  }
  return null;
}

function confirmOne(dir, cfg, finding, ext, isTest) {
  let code;
  try { code = codeOnly(readFileSync(join(dir, finding.file), 'utf8'), 'typescript'); } catch { return { verdict: 'INCONCLUSIVE', why: 'cannot read test file' }; }
  const mainRoots = (cfg.paths && cfg.paths.srcRoots && cfg.paths.srcRoots.main) || [];
  const testCmd = `node --test ${finding.file}`;
  let anyResolved = false; let hollow = null;
  for (const fn of sutFnsIn(bodyForLine(code, finding.line))) {
    const sutFile = resolveSutFile(dir, mainRoots, ext, fn, isTest);
    if (!sutFile) continue;
    anyResolved = true;
    const { verdict } = probe(dir, { testFile: finding.file, sutFile, sutFn: fn, testCmd });
    // any gutted SUT fn that BREAKS the test ⇒ the test discriminates something real ⇒ SOUND (cleared).
    if (verdict === 'SOUND') return { verdict: 'SOUND', sutFn: fn, sutFile, why: `gutting ${fn}() failed the test — a real oracle` };
    if (verdict === 'HOLLOW') hollow = { verdict: 'HOLLOW', sutFn: fn, sutFile, why: `gutting ${fn}() left the test green — the oracle does not check it` };
  }
  if (hollow) return hollow; // all resolved SUT fns survived gutting ⇒ confirmed hollow
  return { verdict: 'INCONCLUSIVE', why: anyResolved ? 'no SUT function could be baselined (deps/env?)' : 'no SUT function resolved to a source file' };
}

// confirm(dir, cfg, findings) → { supported, results:[{ finding, verdict, sutFn, sutFile, why }], counts }
export function confirm(dir, cfg, findings) {
  const ext = cfg.language.fileExt;
  if (!isJsTs(ext)) return { supported: false };
  const isTest = (rel) => {
    const p = rel.replace(/\\/g, '/');
    return /\.(?:test|spec)\.[a-z]+$/.test(p) || /(?:^|\/)(?:test|tests|__tests__|spec)\//.test(p);
  };
  const results = findings
    .filter((f) => PROBE_KIND.test(f.check))
    .map((finding) => ({ finding, ...confirmOne(dir, cfg, finding, ext, isTest) }));
  const counts = { hollow: 0, sound: 0, inconclusive: 0 };
  for (const r of results) counts[r.verdict.toLowerCase()]++;
  return { supported: true, results, counts };
}
