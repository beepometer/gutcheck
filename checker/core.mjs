// checker/core.mjs — config-driven check dispatch + self-test meta-guard + runner.
// A config `checker.checks[]` entry {id, kind, description, runtime?, selfTest, ...params} becomes a
// check object. Each KIND module exports detect(text,env) + corpus(spec,config,ctx) +
// runEnv(spec,config,ctx) + selfEnv(spec,config).
import { readFileSync, existsSync } from 'node:fs';
import * as KINDS from './kinds/index.mjs';
import { relPath, repoRootOf } from './corpus.mjs';

function makeCheck(spec, config) {
  const kind = KINDS[spec.kind];
  if (!kind) throw new Error(`unknown check kind: '${spec.kind}' (check '${spec.id}')`);
  return {
    id: spec.id,
    kind: spec.kind,
    description: spec.description,
    runtime: spec.runtime || null,
    // 'advisory' offenders are REPORTED but do not fail the run (exit stays 0). For high-recall candidate
    // generators (weakOracleGuard) whose precision is a probe's job, not a gate's. Default 'fail'.
    severity: spec.severity === 'advisory' ? 'advisory' : 'fail',
    detect: kind.detect,
    selfTest: { env: kind.selfEnv(spec, config), mustFlag: spec.selfTest.mustFlag, mustNotFlag: spec.selfTest.mustNotFlag },
    run(ctx) {
      if (this.runtime) {
        const pr = config.platform && config.platform.runtime;
        // A runtime-gated check with NO platform.runtime declared must fail loud, never silently green
        // (a silent skip masked by a green meta-guard is the false-confidence anti-pattern this tool catches).
        if (pr == null) return [{ line: 0, token: `runtime-gated check '${this.id}' (runtime: '${this.runtime}') but config.platform.runtime is unset — set platform.runtime or drop the runtime tag` }];
        if (this.runtime !== pr) return [];
      }
      const out = [];
      if (kind.preflight) out.push(...kind.preflight(spec, config, ctx).map((o) => ({ line: 0, ...o })));
      const env = kind.runEnv(spec, config, ctx);
      for (const file of kind.corpus(spec, config, ctx)) {
        if (!existsSync(file)) continue; // a corpus selector should not crash the runner on a missing file
        for (const o of kind.detect(readFileSync(file, 'utf8'), env)) out.push({ file: relPath(file, ctx), ...o });
      }
      return out;
    },
  };
}

export function buildChecks(config) {
  return ((config.checker && config.checker.checks) || []).map((spec) => makeCheck(spec, config));
}

// The keystone: refuse to run unless every check's detector flags all its must-flag fixtures and
// none of its must-not-flag fixtures. A check with no self-test is a hard failure.
export function runMetaGuard(checks) {
  const failures = [];
  for (const c of checks) {
    const st = c.selfTest;
    if (!st || !Array.isArray(st.mustFlag) || !st.mustFlag.length || !Array.isArray(st.mustNotFlag) || !st.mustNotFlag.length) {
      failures.push(`${c.id}: missing non-empty must-flag AND must-not-flag self-test`);
      continue;
    }
    for (const fx of st.mustFlag) {
      if (c.detect(typeof fx === 'string' ? fx : fx.text, st.env).length === 0)
        failures.push(`${c.id}: must-flag NOT flagged: ${JSON.stringify(fx)}`);
    }
    for (const fx of st.mustNotFlag) {
      if (c.detect(typeof fx === 'string' ? fx : fx.text, st.env).length > 0)
        failures.push(`${c.id}: must-not-flag WAS flagged: ${JSON.stringify(fx)}`);
    }
  }
  return failures;
}

export function normalizeCtx(config, ctx) {
  const harnessDir = ctx.harnessDir;
  return {
    ...ctx,
    harnessDir,
    repoRoot: ctx.repoRoot || repoRootOf(harnessDir),
    harnessDirs: (config.checker && config.checker.harnessDirs) || { skills: 'skills', agents: 'agents' },
    testSrcRoots: ctx.testSrcRoots || [],
  };
}

// Run a single check's detector against an in-memory string (no corpus/files). Valid for ctx-free
// kinds whose runEnv ignores ctx (testShapeGuard, magicLiteralGuard, forbiddenPattern) — used by the
// calibrate deterministic-coverage measurement.
export function detectText(spec, config, text) {
  const kind = KINDS[spec.kind];
  if (!kind) throw new Error(`unknown check kind: '${spec.kind}'`);
  return kind.detect(text, kind.runEnv(spec, config, {}));
}

export function runChecker(config, rawCtx) {
  const checks = buildChecks(config);
  const metaFailures = runMetaGuard(checks);
  if (metaFailures.length) return { ok: false, phase: 'meta-guard', failures: metaFailures, offenders: [], checkCount: checks.length };
  const ctx = normalizeCtx(config, rawCtx);
  const offenders = [];
  for (const c of checks) for (const o of c.run(ctx)) offenders.push({ check: c.id, kind: c.kind, severity: c.severity, ...o });
  // advisory offenders are surfaced (in `offenders`) but do NOT make the run fail — only 'fail'-severity does.
  const failing = offenders.filter((o) => o.severity !== 'advisory');
  return { ok: failing.length === 0, phase: 'scan', failures: [], offenders, checkCount: checks.length };
}
