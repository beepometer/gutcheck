// KIND testShapeGuard — over the adopter's test src roots (comment-stripped), apply a list of
// forbidden-shape rules (each with its own raw-line opt-out marker) PLUS the @Ignore-short-reason
// rule, in ONE pass per file. Self-excludes the meta-test tree (so a guard never trips on its own
// fixture strings — the meta-test tree is path-exempt). A rule may carry a `fileExemptSrc`: if the
// WHOLE file matches it, the rule is skipped for that file — e.g. the time-leak rule is suppressed in a
// file that controls the clock (MockDate / fake timers / freezegun), where a `new Date()`/`now()` is not
// a flaky leak. (Real-code finding: without this the rule over-fired on every clock-mocked datetime test.)
import { join } from 'node:path';
import { stripComments, joinLogicalLines } from '../lexer.mjs';
import { walkFiles } from '../corpus.mjs';

export function detect(text, env) {
  const offenders = [];
  const lang = env.lang || 'kotlin';
  const join = (t) => joinLogicalLines(t).split('\n');
  // Default surface keeps strings (so a rule like JS time-leak can see `Date.now()` INSIDE an expected
  // template, or substring-of-numeric see `.toContain('142')`). A rule that targets a real CALL — JVM/py
  // Thread.sleep / time.sleep / size>=0 tautology — sets blankStrings:true so a pattern inside a string
  // literal (e.g. a raw-string fixture feeding the detector its own input) is not a false call.
  const scanLines = env.strip === false ? join(text) : join(stripComments(text, lang));
  let scanLinesBlanked = null;
  const rawLines = text.split('\n');
  for (const rule of env.rules || []) {
    if (rule.fileExemptSrc && new RegExp(rule.fileExemptSrc).test(text)) continue; // file-level skip
    let lines = scanLines;
    if (rule.blankStrings && env.strip !== false) {
      if (!scanLinesBlanked) scanLinesBlanked = join(stripComments(text, lang, { blankStrings: true }));
      lines = scanLinesBlanked;
    }
    const pat = new RegExp(rule.patternSrc);
    const ex = rule.exemptSrc ? new RegExp(rule.exemptSrc) : null;
    lines.forEach((line, i) => {
      if (!pat.test(line)) return;
      if (ex && ex.test(rawLines[i])) return; // opt-out marker lives in a comment on the RAW line
      offenders.push({ line: i + 1, token: rule.id });
    });
  }
  if (env.ignoreRule) {
    const r = env.ignoreRule;
    rawLines.forEach((line, i) => {
      const t = line.trimStart();
      // annotation at line start (@Ignore, @pytest.mark.skip) OR nested in a C#-style attribute
      // (`[Fact(Skip = "…")]` — the line starts with `[` and contains the marker).
      if (!r.annotations.some((a) => t.startsWith(a) || (t.startsWith('[') && t.includes(a)))) return;
      const window = rawLines.slice(i, i + (r.windowLines || 5)).join('\n');
      // Take the LONGEST captured reason in the window. This accepts a positional reason
      // (skip("...")) and a reason= kwarg uniformly, and is not fooled by a SHORT quoted string in
      // a skipif CONDITION (e.g. version < "2.7.1") — the real reason is the long one.
      let reason = '';
      for (const mm of window.matchAll(new RegExp(r.annotationRegex, 'gs'))) {
        const cap = (mm[1] || '').trim();
        if (cap.length > reason.length) reason = cap;
      }
      if (reason.length < r.minReasonLen) offenders.push({ line: i + 1, token: 'ignore-short-reason' });
    });
  }
  return offenders;
}

export function corpus(spec, config, ctx) {
  const ext = config.language.fileExt;
  const roots = (ctx.testSrcRoots && ctx.testSrcRoots.length)
    ? ctx.testSrcRoots
    : (config.paths.srcRoots.test || []).map((r) => join(ctx.repoRoot, r));
  const exclude = spec.params.excludePathSubstrings || [];
  return roots.flatMap((r) => walkFiles(r, ext)).filter((f) => {
    const norm = f.replace(/\\/g, '/');
    return !exclude.some((sub) => norm.includes(sub));
  });
}

const envFor = (spec) => ({ rules: spec.params.rules || [], lang: spec.params.lang || 'kotlin', strip: spec.params.strip, ignoreRule: spec.params.ignoreRule });
export const runEnv = (spec) => envFor(spec);
export const selfEnv = (spec) => envFor(spec);
