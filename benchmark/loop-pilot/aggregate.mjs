// The frozen estimands (pre-reg §3, SIGNED 2026-07-07): paired bootstrap (10k, fixed seed) over per-task
// ΔG−P, per model. E-PRIMARY = proven-fraction over all changed fns; E-VALUE = the ENTRY fn's
// genuine rate (proven AND hidden-oracle-correct — the oracle exists for the entry fn, so E-VALUE is
// measured there; a granularity note, fixed before any data existed). E-GAMING = proven-but-wrong on the
// entry fn per arm. No Math.random anywhere — the seed is part of the registration.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(diffs, seed, n = 10000) {
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  if (!diffs.length) return { mean: null, lo: null, hi: null };
  const rnd = mulberry32(seed);
  const means = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[(rnd() * diffs.length) | 0];
    means[i] = s / diffs.length;
  }
  means.sort((a, b) => a - b);
  return { mean: mean(diffs), lo: means[Math.floor(0.025 * n)], hi: means[Math.ceil(0.975 * n) - 1] };
}

const frac = (arm) => (arm.fraction === null || arm.fraction === undefined ? 0 : arm.fraction);
const genuine = (arm) => (arm.entryProven && arm.entryCorrect ? 1 : 0);

export function aggregate(rows, { seed = 20260707 } = {}) {
  const perModel = {};
  for (const model of [...new Set(rows.map((r) => r.model))]) {
    const ms = rows.filter((r) => r.model === model);
    const gaming = {};
    for (const arm of ['B', 'P', 'G']) {
      const proven = ms.filter((r) => r[arm].entryProven);
      const wrong = proven.filter((r) => !r[arm].entryCorrect);
      gaming[arm] = { provenButWrong: wrong.length, provenTotal: proven.length, rate: proven.length ? wrong.length / proven.length : null };
    }
    perModel[model] = {
      n: ms.length,
      deltaGP: bootstrap(ms.map((r) => frac(r.G) - frac(r.P)), seed),
      deltaGP_value: bootstrap(ms.map((r) => genuine(r.G) - genuine(r.P)), seed + 1),
      deltaPB: bootstrap(ms.map((r) => frac(r.P) - frac(r.B)), seed + 2),
      deltaGB: bootstrap(ms.map((r) => frac(r.G) - frac(r.B)), seed + 3),
      means: {
        B: bootstrap(ms.map((r) => frac(r.B)), seed + 4).mean,
        P: bootstrap(ms.map((r) => frac(r.P)), seed + 5).mean,
        G: bootstrap(ms.map((r) => frac(r.G)), seed + 6).mean,
      },
      gaming,
    };
  }
  // Reconciliation gate (house rule): published totals must recount from the raw rows.
  const reconcile = { rows: rows.length, byModel: Object.fromEntries(Object.entries(perModel).map(([m, v]) => [m, v.n])) };
  if (Object.values(reconcile.byModel).reduce((a, b) => a + b, 0) !== rows.length) throw new Error('reconciliation failed');
  return { perModel, reconcile, seed };
}
