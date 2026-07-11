// KIND forbiddenPattern (lexer-aware) — a line matching patternSrc is an offender unless its
// ±window carries an exemption marker; an optional nearTokens conjunction narrows it (pattern AND
// a near-token in the window). strip=true comment-strips the source first (per-language lexer).
// scanRoots scans a source tree (else the harness markdown). Optional baseline = a down-only ratchet.
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { harnessMarkdown, walkFiles, relPath } from '../corpus.mjs';
import { basename } from 'node:path';

export function detect(text, env) {
  // blankStrings mode: blank STRING literals but KEEP comments — so a citation in an assertion MESSAGE
  // (`assertEquals("per IEC 61672 §5.4.6 …", …)`) is not a value citation, while a real `// per RFC …`
  // comment citation still fires. Else: strip comments, or scan raw. Logical-line-join the masked view so
  // a citation on a multi-line assertion is seen.
  let masked = null;
  if (env.blankStrings) masked = stripComments(text, env.lang, { blankStrings: true, keepComments: true });
  else if (env.strip) masked = stripComments(text, env.lang);
  const scanLines = (masked !== null ? joinLogicalLines(masked) : text).split('\n');
  const rawLines = text.split('\n');
  const pattern = new RegExp(env.patternSrc);
  const exempt = env.exemptSrc ? new RegExp(env.exemptSrc) : null;
  const lineExempt = env.lineExemptSrc ? new RegExp(env.lineExemptSrc) : null;
  const near = env.nearTokens ? new RegExp(env.nearTokens.join('|'), 'i') : null;
  const wb = env.windowBehind || 0, wa = env.windowAhead || 0;
  const offenders = [];
  scanLines.forEach((line, i) => {
    if (!pattern.test(line)) return;
    if (lineExempt && lineExempt.test(line)) return; // the match's OWN line is exempt (e.g. a test title)
    const win = rawLines.slice(Math.max(0, i - wb), i + 1 + wa).join('\n');
    if (near && !near.test(win)) return;
    if (exempt && exempt.test(win)) return;
    offenders.push({ line: i + 1 });
  });
  return offenders;
}

export function corpus(spec, config, ctx) {
  if (spec.params.scanRoots) {
    const ext = config.language.fileExt;
    const exclude = new Set(spec.params.selfExclude || []);
    return spec.params.scanRoots
      .flatMap((r) => walkFiles(join(ctx.repoRoot, r), ext))
      .filter((f) => !exclude.has(basename(f)));
  }
  return harnessMarkdown(ctx);
}

const envFor = (spec) => ({
  patternSrc: spec.params.patternSrc, exemptSrc: spec.params.exemptSrc, nearTokens: spec.params.nearTokens,
  lineExemptSrc: spec.params.lineExemptSrc,
  windowBehind: spec.params.windowBehind || 0, windowAhead: spec.params.windowAhead || 0,
  strip: spec.params.strip || false, blankStrings: spec.params.blankStrings || false, lang: spec.params.lang,
});
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
