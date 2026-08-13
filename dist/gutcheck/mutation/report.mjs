// mutation/report.mjs — verdict rendering: the per-function report, the one-sided advisory lines, and the
// static-hollow extras. prove.mjs re-exports every name here. Every string here is pinned by
// test/report-honesty.test.mjs and test/onesided-aggregate.test.mjs — a reworded line is a behavior
// change, not a cleanup.

// Plain-English translation of a skip/inconclusive why-code, for the unverifiable section only — a
// reader should never have to know what "sut-unresolved" means. A baseline/did-not-run/flaky/
// ambiguous-title inconclusive reason (free text, not a fixed code) reads as one generic readable
// phrase; anything truly unrecognized falls back to the raw reason verbatim rather than hiding it.
const UNVERIFIABLE_REASON_MSG = {
  'no-pin': 'only checks a mock / no value pinned',
  'one-sided': 'the binding test detects only one direction of error',
  'pin-unresolved': "pins a value the probe can't tie to a called function",
  'relation-unbound': "relational oracle — the mutant survived both extremes; the relation doesn't pin a value",
  'sut-unresolved': "can't locate the function from the test's imports",
  'dynamic-title': 'test name is computed at runtime',
  'ungutable': "no compiling wrong-value sentinel for this function (return type or body form)",
  'instrumented-test': 'needs a device/emulator',
  'unsupported-source-set': 'unsupported Gradle source set',
  'probe-cap': 'not probed — probe cap or time budget reached (raise --max-probes/--time-budget)',
  'env-abort': 'not probed — the run aborted after the first baselines all failed (likely wrong runner or broken build/environment)',
};
function readableUnverifiableReason(reason) {
  if (Object.prototype.hasOwnProperty.call(UNVERIFIABLE_REASON_MSG, reason)) return UNVERIFIABLE_REASON_MSG[reason];
  if (/^baseline |^did-not-run |^flaky baseline|^ambiguous title/.test(reason || '')) return 'the referencing test is inconclusive';
  if (/^runner-mismatch/.test(reason || '')) return "the detected runner can't run this test's language";
  return reason;
}

// r.hollow entries NOT already carried by a changed-function hollow row — the whole-scope findings every
// human diff surface must render (the exit code counts them; see formatDiffReport's comment). Shared by
// formatDiffReport here and formatMarkdown (mutation/gutcheck.mjs) so the two surfaces can never drift.
export function extraHollowOf(r) {
  const changeHollowBlocks = new Set((r.changes || []).filter((c) => c.status === 'hollow' && c.evidence && c.evidence.blocks)
    .flatMap((c) => c.evidence.blocks.map((b) => `${b.file}:${b.line}`)));
  return (r.hollow || []).filter((h) => !changeHollowBlocks.has(`${h.file}:${h.line}`));
}

// Boundary-blind-spot aggregate — a fold over r.oneSided rows, formatter-only (result shape, JSON,
// SARIF, exit codes untouched). Groups by the direction the test BINDS: posRed=true → red under the
// positive sentinel → binds only against too-high results; posRed=false → too-low. 'inline' = one
// header line (diff + markdown surfaces); 'breakdown' = header + per-direction file counts
// (full-scan surface, where volume lives). A single row always collapses to the singular inline form.
export function oneSidedLines(rows, style) {
  const n = rows.length;
  if (!n) return [];
  const hi = rows.filter((o) => o.posRed), lo = rows.filter((o) => !o.posRed);
  if (n === 1) return [`boundary blind spots: 1 one-sided test — binds only against ${hi.length ? 'too-high' : 'too-low'} results; never a blocker:`];
  const head = (txt) => `boundary blind spots: ${n} one-sided test(s) — ${txt}; never a blocker:`;
  if (style === 'breakdown') {
    const lines = [head('these bind one direction of error only')];
    for (const [group, label] of [[hi, 'too-high'], [lo, 'too-low']]) {
      if (!group.length) continue;
      const perFile = new Map();
      for (const o of group) perFile.set(o.file, (perFile.get(o.file) || 0) + 1);
      const files = [...perFile.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      lines.push(`  bind only against ${label} results (${group.length}): ${files.map(([f, c]) => `${f} (${c})`).join(', ')}`);
    }
    return lines;
  }
  if (!hi.length || !lo.length) return [head(`all bind only against ${hi.length ? 'too-high' : 'too-low'} results`)];
  return [head(`${hi.length} bind${hi.length === 1 ? 's' : ''} only against too-high results, ${lo.length} only against too-low`)];
}

// Sibling-binding context for a hollow row: live triage needs one fact the run already computed —
// whether ANOTHER probed test binds the same fn (an equivalence/determinism companion of a proven
// value-pin is one-sided by design; a fn whose self-comparison is its only probed coverage is the
// real gap). Joined against r.proven's execution evidence on the (fn, sutRel) PAIR — a bare name
// would cross-attribute a same-named fn in an unrelated file — at zero extra probe cost. FACT-ONLY:
// counts proofs, never renders a fix-now/by-design verdict. No survivorPairs (older or hand-built
// results) → no note, byte-identical to before the annotation existed.
function siblingNote(h, proven) {
  const notes = (h.survivorPairs || []).map(({ fn, sutRel }) => {
    const n = (proven || []).filter((p) => (p.pairs || []).some((q) => q.fn === fn && q.sutRel === sutRel)).length;
    return n > 0 ? `${fn}() is bound by ${n} other proven test${n === 1 ? '' : 's'}` : `no other probed test binds ${fn}()`;
  });
  return notes.length ? `  (${notes.join('; ')})` : '';
}

// Full-suite human report (no diff scope — r.changeSummary is null). Pinned byte-for-byte by the
// gutcheck-cli.test.mjs "byte-identical to the release format" test and mutation/gutcheck.mjs's own
// banner()-then-formatReport() call: this function must never reference r.changeSummary/r.changes.
function formatFullScanReport(r) {
  const lines = [];
  const scope = r.outOfScope ? ` (${r.outOfScope} test blocks outside the diff)` : '';
  if (r.scored === 0 && (r.probes > 0 || (r.inconclusive || []).length > 0)) lines.push(`gutcheck: no verdicts — ${r.probes} test(s) probed, all inconclusive (${r.inconclusive.length} inconclusive, ${r.skipped.length} skipped). Runner: ${r.runner}.`);
  else if (r.scored === 0) lines.push(`gutcheck: no value-pinning tests to probe${scope} (${r.skipped.length} skipped, ${r.inconclusive.length} inconclusive). Runner: ${r.runner}.`);
  else {
    // Denominator-first headline: when tests were skipped or inconclusive, the
    // one line that gets quoted must carry the coverage fraction — "verdicts on X of Y tests" — so it can
    // never read as a whole-suite claim. A clean run (nothing skipped, nothing inconclusive) keeps the
    // single-clause release format byte-for-byte: there the scored count IS the denominator.
    const total = r.scored + (r.skipped || []).length + (r.inconclusive || []).length;
    if (total > r.scored) lines.push(`gutcheck: verdicts on ${r.scored} of ${total} tests (${Math.round((r.scored / total) * 100)}%) — ${r.caught}/${r.scored} (${r.pct}%) fail when the function they test is broken.${scope}  [${r.probes} probes, runner: ${r.runner}]`);
    else lines.push(`gutcheck: ${r.caught}/${r.scored} tests (${r.pct}%) fail when the function they test is broken.${scope}  [${r.probes} probes, runner: ${r.runner}]`);
  }
  const baselineFailRows = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
  const baselineFails = baselineFailRows.length;
  // The wipeout check counts BOTH 'baseline' (ran-and-failed) and 'did-not-run' (skip/zero-match/
  // timeout) rows: a probe set where every baseline is still the classic wrong-runner
  // symptom (nothing legitimately ran), and this banner is advice ("...or the detected runner can't
  // run them"), never an accusation — unlike the per-row ✗ listing just below, which stays scoped to
  // baselineFailRows only, since a did-not-run row never earns the "already fail" label.
  const baselineOrDidNotRunCount = (r.inconclusive || []).filter((i) => /^(baseline|did-not-run) /.test(i.why)).length;
  const allBaselinesFailed = r.scored === 0 && baselineOrDidNotRunCount > 0 && baselineOrDidNotRunCount === (r.inconclusive || []).length && r.hollow.length === 0;
  // The env-abort fail-fast (prove()) and this wipeout hint compose into ONE line: when the run stopped
  // after the first N baselines all failed, the hint states that fact (first N failed, likely wrong runner
  // or broken build/environment, fix it or --runner=<r>, M remaining not probed) instead of the plain
  // "every baseline run failed" phrasing — never two contradictory messages. r.envAborted is undefined on
  // an older/hand-built result, so that path stays byte-identical.
  if (allBaselinesFailed && r.envAborted)
    lines.push(`every baseline run failed before any mutation — the first ${baselineOrDidNotRunCount} all failed, so probing stopped (likely the wrong runner or a broken build/environment). Fix it or pass --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>. ${r.envAborted} remaining block(s) not probed.`);
  else if (allBaselinesFailed)
    lines.push(`every baseline run failed before any mutation — either these tests already fail, or the detected runner (${r.runner}) can't run them. Override with --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>.`);
  // PARTIAL baseline failures — a first-class signal (wild-pilot HEAD-rot finding: failing-at-HEAD tests
  // are common in the wild, and a partial set was previously silent here). A test that fails before any
  // mutation can't verify anything; fix it first. Deliberately scoped to tests gutcheck PROBED (a baseline
  // exists only for eligible blocks), never a whole-suite claim. The all-fail case above keeps its
  // runner-suspicion framing instead (a total wipeout usually means the runner, not the tests).
  else if (baselineFails > 0) {
    lines.push('');
    lines.push(`⚠️ ${baselineFails} probed test(s) already fail before any mutation — they verify nothing until they pass:`);
    for (const i of baselineFailRows) lines.push(`  ✗ ${i.file}:${i.line}  '${i.name}'`);
  }
  if (r.capped) lines.push(`(${r.capped} block(s) not probed — probe cap or time budget reached; raise --max-probes/--time-budget or narrow --since.)`);
  if (r.hollow.length) {
    lines.push('');
    lines.push(`${r.hollow.length} test(s) pass even when their function is gutted — they don't actually test it:`);
    for (const h of r.hollow) lines.push(`  ✗ ${h.file}:${h.line}  '${h.name}'  — survives gutting ${h.survivors.join(', ')}()${siblingNote(h, r.proven)}`);
  } else if (r.scored > 0) lines.push(`✓ ${r.caught} function${r.caught === 1 ? '' : 's'} verified: gutted each, its test went red.${r.skipped.length ? ` ${r.skipped.length} test(s) skipped (see banner for reasons).` : ''}`);
  // Identity-stub advisory (--deep): per-FUNCTION ratios, not a per-test list — no-op tests pass identity
  // stubs by design (INTENTIONAL-NOOP / ACCIDENTAL-FIXED-POINT were the audit's two majority classes, and
  // zero of the 13 audited survivors were fully-fixed-point-covered), so naming individual tests reads as
  // an accusation the audit doesn't support. Never affects the exit code — advisory only.
  if (r.weak && r.weak.length) {
    lines.push('');
    lines.push('identity-stub advisory (--deep): tests that pass when the function is replaced by a passthrough (counts are stub probes, not all binding tests)');
    // A passed:0 fn had every identity stub CAUGHT — a success story, not an advisory — so it is omitted
    // entirely (final-review wave, item 6). r.weak.length > 0 guarantees at least one fn has passed > 0.
    for (const fn of Object.keys(r.weakSummary || {})) {
      const { stubbed, passed } = r.weakSummary[fn];
      if (!passed) continue;
      lines.push(`  ~ ${fn}: ${passed} of ${stubbed} identity-stub probes passed — may cover only fixed points (no-op tests do this by design)`);
    }
  }
  // One-sided tier (--deep): tests red under exactly one sentinel — they bind one direction of error
  // (threshold/comparison oracles). A verdict, never a blocker; each row states the two observed runs.
  if (r.oneSided && r.oneSided.length) {
    lines.push('');
    lines.push(...oneSidedLines(r.oneSided, 'breakdown'));
    for (const o of r.oneSided) lines.push(`  ~ ${o.file}:${o.line}  '${o.name}'  — ${o.fn}() gutted: ${o.posRed ? 'red under the positive sentinel, passes under the negative one' : 'passes under the positive sentinel, red under the negative one'}`);
  }
  // Side signals: two existing inconclusive buckets that were silent in the report — a flaky test
  // (unstable green re-run) and a title collision (two blocks share one runner selection). Neither is a
  // verdict on the test, so neither counts toward hollow/caught; surfaced as a one-line heads-up so a
  // reader doesn't read "0 hollow" as "everything sound" when some tests were simply unrunnable-as-a-
  // verdict. Only when count > 0 — a clean run (no such buckets) emits neither line (byte-for-byte no-op).
  const flakyN = (r.inconclusive || []).filter((i) => /^flaky baseline/.test(i.why)).length;
  if (flakyN) { lines.push(''); lines.push(`${flakyN} test(s) unstable across identical reruns (rerun instability, not a verdict)`); }
  const collisionN = (r.inconclusive || []).filter((i) => /^ambiguous title/.test(i.why)).length;
  if (collisionN) { lines.push(''); lines.push(`${collisionN} title collision(s) — colliding titles break per-test selection (rename or qualify)`); }
  return lines.join('\n');
}

// Diff-scoped human report (r.changeSummary present — a --since run). The verdict is the PRODUCT's
// answer ("what happened to the diff I just wrote") and leads unconditionally as line 1; hollow findings
// and already-failing baselines stay prominent right under it (never demoted); the whole-project probe
// mechanics — what mutation/gutcheck.mjs's CLI used to print as a banner() preamble ahead of everything,
// plus this function's own former "X/Y tests fail" and "✓ N verified" lines — collapse into ONE trailing
// parenthesized footnote, so a reader never has to wade through whole-probed-set detail to find the
// answer about their own diff. mutation/gutcheck.mjs's main() no longer calls banner() for this case.
function formatDiffReport(r) {
  const cs = r.changeSummary;
  const lines = [];
  // hollow>0 renders the count in CAPS and moves it right after "proven" for prominence.
  const fnsWord = `${cs.fns} function${cs.fns === 1 ? '' : 's'} in this diff`;
  const unverifiablePart = cs.unverifiable > 0 ? ` · ${cs.unverifiable} unverifiable` : '';
  // Same-diff-oracle provenance + probe-cap-out-of-unverifiable (Task 7): both FACT-ONLY, both rendered
  // only when their count is > 0 (undefined/0 on an older or hand-built changeSummary → no fragment,
  // byte-identical to before either field existed). "via tests changed in this diff" states a fact about
  // what changed alongside the proof, stated as fact, never as a verdict. "not probed (cap)" moves
  // probe-cap fns out of the unverifiable bucket at the summary level (row status is unaffected).
  const provenPart = (cs.sameDiffProven || 0) > 0 ? ` (${cs.sameDiffProven} via tests changed in this diff)` : '';
  const provenWord = `${cs.proven} proven${provenPart}`;
  const notProbedPart = (cs.notProbed || 0) > 0 ? ` · ${cs.notProbed} not probed (cap)` : '';
  // Whole-scope hollows the changed-function rows don't carry: the exit code counts r.hollow across the
  // WHOLE probed scope (a touched test file is probed whole-file), so a hollow whose survivor is not a
  // changed function would otherwise exit 1 with a headline reading "0 hollow" — a silent false negative
  // on THIS surface, the one a first-run user reads. extraHollowOf is the same set-subtraction
  // formatMarkdown (mutation/gutcheck.mjs) renders as its ❌ section; both the headline fragment and the
  // section below render only when non-empty, so a run with none stays byte-identical.
  const extraHollow = extraHollowOf(r);
  const extraHollowPart = extraHollow.length ? ` · ${extraHollow.length} HOLLOW beyond the diff` : '';
  const body = cs.hollow > 0
    ? `${provenWord}, ${cs.hollow} HOLLOW, ${cs.untested} with no binding test`
    : `${provenWord}, ${cs.untested} with no binding test, ${cs.hollow} hollow`;
  lines.push(`gutcheck: ${fnsWord} — ${body}${unverifiablePart}${notProbedPart}${extraHollowPart}.`);

  // Baseline-already-failing tests: prominent, never folded into the footnote — a probed test that fails
  // before any mutation verifies nothing until it passes, and the reviewer should fix it first.
  const baselineFailRows = (r.inconclusive || []).filter((i) => /^baseline /.test(i.why));
  // See formatFullScanReport's twin comment: the wipeout check widens to BOTH prefixes (a did-not-run
  // row is still the classic wrong-runner symptom), while the per-row ✗ listing below stays scoped to
  // baselineFailRows only — a did-not-run row never earns the "already fail" label.
  const baselineOrDidNotRunCount = (r.inconclusive || []).filter((i) => /^(baseline|did-not-run) /.test(i.why)).length;
  const allBaselinesFailed = r.scored === 0 && baselineOrDidNotRunCount > 0 && baselineOrDidNotRunCount === (r.inconclusive || []).length && r.hollow.length === 0;
  if (allBaselinesFailed && r.envAborted) {
    // See formatFullScanReport's twin: the env-abort tail folds INTO the wipeout hint, one coherent line.
    lines.push('');
    lines.push(`every baseline run failed before any mutation — the first ${baselineOrDidNotRunCount} all failed, so probing stopped (likely the wrong runner or a broken build/environment). Fix it or pass --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>. ${r.envAborted} remaining block(s) not probed.`);
  } else if (allBaselinesFailed) {
    lines.push('');
    lines.push(`every baseline run failed before any mutation — either these tests already fail, or the detected runner (${r.runner}) can't run them. Override with --runner=<vitest|jest|mocha|ava|pytest|node|gradle|maven>.`);
  } else if (baselineFailRows.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${baselineFailRows.length} probed test(s) already fail before any mutation — they verify nothing until they pass:`);
    for (const i of baselineFailRows) lines.push(`  ✗ ${i.file}:${i.line}  '${i.name}'`);
  }
  if (r.capped) { lines.push(''); lines.push(`(${r.capped} block(s) not probed — probe cap or time budget reached; raise --max-probes/--time-budget or narrow --since.)`); }

  // Per-status detail: hollow is NEVER demoted — its receipted ✗ file:line 'name' — survives gutting
  // fn() lines (plus the gutcheck --explain pointer) sit right under the verdict, same as the old
  // execution-based r.hollow list did, but attributed to the specific CHANGED function per row (more
  // precise than a bare survivors list when one block survives several changed functions).
  const byStatus = (s) => r.changes.filter((c) => c.status === s);
  const hollowFns = byStatus('hollow');
  if (hollowFns.length) {
    lines.push('');
    lines.push(`hollow — the test passes even when the function is gutted; fix the test (receipt: gutcheck --explain <file:line>) (${hollowFns.length}):`);
    for (const c of hollowFns) {
      const b = c.evidence && c.evidence.blocks && c.evidence.blocks[0];
      if (!b) continue;
      // wrongLayerShadow (JVM-only, static — mutation/wrongLayerShadow.mjs) never ran a mutant at all, so
      // it never earns "survives gutting" phrasing; it gets its own accurate tail instead.
      const tail = c.evidence.reason === 'wrong-layer-shadow'
        ? `re-implements the logic and asserts it against a second copy of itself (zero production contact): \`${c.evidence.echo}\``
        : `survives gutting ${c.fn}()`;
      lines.push(`  ✗ ${b.file}:${b.line}  '${b.name}'  — ${tail}`);
    }
  }
  if (extraHollow.length) {
    lines.push('');
    lines.push(`hollow beyond the changed functions — a touched test file is probed whole-file, and these tests pass even when the function they verify is gutted; fix the test (receipt: gutcheck --explain <file:line>) (${extraHollow.length}):`);
    for (const h of extraHollow) lines.push(`  ✗ ${h.file}:${h.line}  '${h.name}'  — still passes when ${(h.survivors || []).join(', ')}() is gutted`);
  }
  const untestedFns = byStatus('untested');
  if (untestedFns.length) {
    lines.push('');
    lines.push(`no binding test — no test names ${untestedFns.length === 1 ? 'it' : 'them'} (${untestedFns.length}):`);
    const names = untestedFns.map((c) => c.fn);
    const shown = names.slice(0, 10).join(', ');
    const more = names.length > 10 ? ` +${names.length - 10} more` : '';
    lines.push(`  ${shown}${more}`);
  }
  // probe-cap out of `unverifiable` (Task 7): split at the DETAIL level too, mirroring the summary split
  // above — a probe-cap row is real reference evidence, just never run under the cap, so it moves under
  // the existing "(N block(s) not probed …)" note's own vocabulary instead of sitting alongside a
  // genuinely-unverifiable (mock-only, etc.) row. Row status/reason are unchanged either way.
  const unverifiableFns = byStatus('unverifiable').filter((c) => c.evidence.reason !== 'probe-cap');
  if (unverifiableFns.length) {
    lines.push('');
    lines.push(`unverifiable — a test exists but I can't confirm it binds the function (${unverifiableFns.length}):`);
    lines.push('  ' + unverifiableFns.map((c) => `${c.fn} (${readableUnverifiableReason(c.evidence.reason)})`).join(', '));
  }
  const notProbedFns = byStatus('unverifiable').filter((c) => c.evidence.reason === 'probe-cap');
  if (notProbedFns.length) {
    lines.push('');
    lines.push(`not probed (cap) — probe cap or time budget reached before these could be checked (${notProbedFns.length}):`);
    lines.push('  ' + notProbedFns.map((c) => c.fn).join(', '));
  }

  // Identity-stub advisory (--deep): see formatFullScanReport's comment — same per-function ratios.
  if (r.weak && r.weak.length) {
    lines.push('');
    lines.push('identity-stub advisory (--deep): tests that pass when the function is replaced by a passthrough (counts are stub probes, not all binding tests)');
    for (const fn of Object.keys(r.weakSummary || {})) {
      const { stubbed, passed } = r.weakSummary[fn];
      if (!passed) continue;
      lines.push(`  ~ ${fn}: ${passed} of ${stubbed} identity-stub probes passed — may cover only fixed points (no-op tests do this by design)`);
    }
  }
  // One-sided tier (--deep): see formatFullScanReport's comment — same tier, same rows.
  if (r.oneSided && r.oneSided.length) {
    lines.push('');
    lines.push(...oneSidedLines(r.oneSided, 'inline'));
    for (const o of r.oneSided) lines.push(`  ~ ${o.file}:${o.line}  '${o.name}'  — ${o.fn}() gutted: ${o.posRed ? 'red under the positive sentinel, passes under the negative one' : 'passes under the positive sentinel, red under the negative one'}`);
  }
  // Side signals (flaky rerun instability / title collision) — see formatFullScanReport's comment.
  const flakyN = (r.inconclusive || []).filter((i) => /^flaky baseline/.test(i.why)).length;
  if (flakyN) { lines.push(''); lines.push(`${flakyN} test(s) unstable across identical reruns (rerun instability, not a verdict)`); }
  const collisionN = (r.inconclusive || []).filter((i) => /^ambiguous title/.test(i.why)).length;
  if (collisionN) { lines.push(''); lines.push(`${collisionN} title collision(s) — colliding titles break per-test selection (rename or qualify)`); }

  // The mechanics footnote: everything mutation/gutcheck.mjs's CLI used to print as a whole-probed-set
  // banner() preamble ahead of the report, PLUS this function's former "X/Y tests fail" and "✓ N
  // verified" lines, collapsed into one trailing line. The verdict above already answered "what happened
  // to my diff"; this is "how gutcheck got there" for anyone who wants the receipt.
  lines.push('');
  lines.push(`  (probed ${r.probes} fn${r.probes === 1 ? '' : 's'} · ${r.caught}/${r.scored} bound · ${r.skipped.length} skipped · runner ${r.runner})`);
  return lines.join('\n');
}

export function formatReport(r) {
  if (r.scopeError) return `gutcheck: ${r.scopeError}`;
  const body = r.changeSummary ? formatDiffReport(r) : formatFullScanReport(r);
  return r.scopeWarning ? `gutcheck: warning: ${r.scopeWarning}\n${body}` : body;
}
