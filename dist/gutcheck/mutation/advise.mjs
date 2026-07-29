// mutation/advise.mjs — the ADVISORY channel at the agent's done-claim: runs the deterministic checker
// over the test files THIS DIFF changed and renders one non-blocking line. It never blocks and never
// mints a verdict. The probe owns blocking (a confirmed hollow, and a changed test already failing);
// this owns static evidence the probe cannot reach — an unlocatable SUT, a mock-heavy suite, a diff with
// nothing probeable at all.
//
// Kind selection is the PROMOTION RUNWAY. The four LINT_KINDS earned a `fail` seat by corpus
// measurement. magicLiteralGuard and shadowOracleGuard ride here to be field-measured before any
// promotion. Three kinds stay off, on the record: selfComparisonOracle (measured CYCLE-10 — high base
// rate, ~zero defect yield; see checker/kinds/index.mjs), weakOracleGuard (high-recall by its own
// header; the probe is its decisive gate), assertionFreeTest (never swept).
//
// Deliberate limit: a probe failure does not by itself suppress the advisory. The gate calls this module
// whenever the probe returned a parseable payload, and a scopeError payload (a probe-lock refusal, an
// unresolvable scope) is parseable — the checker is independent of the probe and is the only signal
// available then, so it runs on purpose. The advisory IS suppressed when the probe produced no parseable
// payload at all (a crash with empty stdout): the gate returns before reaching this module in that case.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { configForProject, findTestFiles, toPosix } from '../checker/standalone.mjs';
import { runChecker } from '../checker/core.mjs';

export const ADVISE_KINDS = new Set([
  'derivationCoherence', 'assertionConsistency', 'testShapeGuard', 'fallbackCollapse', // earned
  'magicLiteralGuard', 'shadowOracleGuard',                                            // runway
]);

const MAX_SHOWN = 3;

// argv-form only, never a shell string — same discipline as mutation/gate.mjs's git plumbing.
function gitOutRaw(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }); }
  catch { return ''; }
}

// Repo-relative paths the diff touches: the tracked diff against `baseline` plus untracked files (an
// agent's brand-new test file is untracked, and it is the single most important case here). Any git
// failure yields an empty list, which makes advise() silent.
export function changedPathsSince(dir, baseline) {
  const tracked = gitOutRaw(dir, ['diff', '--name-only', baseline]).split('\n').filter(Boolean);
  const untracked = gitOutRaw(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

export function advise(dir, baseline, opts = {}) {
  const root = resolve(dir);
  const changed = changedPathsSince(root, baseline);
  if (!changed.length) return null;

  let built;
  try { built = configForProject(root); } catch { return null; }
  const { cfg, testRoots } = built;
  if (!cfg) return null; // no supported language, or no test files at all

  // Classify the changed paths with the CHECKER's own test-file classifier — one definition of "test
  // file", shared with the corpus the filter is about to scope.
  const changedTests = new Set(findTestFiles(changed, cfg.language.fileExt).map((f) => toPosix(join(root, f))));
  if (!changedTests.size) return null;

  cfg.checker.checks = (cfg.checker.checks || []).filter((c) => ADVISE_KINDS.has(c.kind));
  if (!cfg.checker.checks.length) return null; // no advisable kinds for this language
  if (opts.sabotageMetaGuard) {
    // TEST SEAM (test/advise.test.mjs): a check whose detector cannot flag its own must-flag fixture, so
    // the meta-guard fails and the fail-closed branch below is reachable without corrupting a shipped
    // fixture. Never set from the gate.
    const sabotaged = cfg.checker.checks[0];
    cfg.checker.checks = [{
      ...sabotaged,
      selfTest: { ...sabotaged.selfTest, mustFlag: ['inert prose no detector kind could ever flag'] },
    }];
  }

  let res;
  try {
    res = runChecker(cfg, {
      harnessDir: root,
      repoRoot: root,
      testSrcRoots: testRoots,
      // Absolute, posix-normalized on both sides: the corpus walk yields absolute native-separator
      // paths, so the comparison must normalize or it silently admits nothing on win32.
      fileFilter: (f) => changedTests.has(toPosix(f)),
    });
  } catch { return null; } // breakage fails OPEN — silence, never a guess

  // Degradation fails CLOSED: a checker that can no longer catch its own planted bug must say so.
  if (res.phase === 'meta-guard') {
    return 'gutcheck lint: self-check FAILED — a triage check no longer catches its own planted bug; advisory suppressed.';
  }

  if (!res.offenders.length) return null;
  const items = res.offenders.map((o) => `${o.file}:${o.line} [${o.check}]`);
  const shown = items.slice(0, MAX_SHOWN).join(', ');
  const more = items.length > MAX_SHOWN ? ` +${items.length - MAX_SHOWN} more` : '';
  return `gutcheck lint: ${res.offenders.length} finding(s) in test file(s) you changed: ${shown}${more}`;
}
