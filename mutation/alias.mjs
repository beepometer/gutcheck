// mutation/alias.mjs — static path-alias resolution for JS/TS SUT binding (makeResolver's
// non-relative fallback). Two sources, both declarative files the work copy always carries:
//
//   1. package.json `imports` — node's own subpath imports. Keys MUST start with '#' (node spec);
//      a conditions object takes its first string among default/node/import; targets must be './'-
//      relative to the package root. This is the shape the runtime itself resolves, so following it
//      is by construction what `node --test` does.
//   2. tsconfig.json / jsconfig.json `compilerOptions.paths` (+ `baseUrl`, one `extends` hop) — the
//      dominant TS alias idiom (`~/*`, `@/*`), honored at runtime by vite-tsconfig-paths and
//      friends. tsconfig is JSONC (comments + trailing commas legal): comments go through the
//      checker lexer's string-aware strip, then a trailing-comma pass only if plain JSON.parse
//      failed. A config that still doesn't parse contributes NO rules — refusal, never a guess.
//      tsconfig.json wins over jsconfig.json (TS ignores jsconfig when tsconfig exists), and the
//      first config file that exists ends the search either way.
//
// Matching mirrors the resolvers being imitated: an exact pattern beats every wildcard; among
// wildcards the longest matched prefix wins (tsc precedence); at most one '*' per pattern (a
// multi-star pattern contributes no rule). aliasBases() returns the ORDERED absolute base paths a
// matched spec maps to — the caller owns tsc's first-existing-target semantics, because "exists"
// there must mean on-disk existence, not srcFiles membership.
//
// Deliberately out of scope, refused by absence: code-based alias configs (vitest `resolve.alias`,
// jest `moduleNameMapper` in a .js config, webpack aliases) — a config computed by code cannot be
// read statically without guessing; nested `extends` chains beyond one hop; non-'#' `imports` keys.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { stripComments } from '../checker/lexer.mjs';

// JSONC → object. Trailing-comma removal runs ONLY after plain parse fails, and its regex can in
// principle corrupt a string literal containing ",}" — accepted: the corrupted parse then yields a
// nonexistent target path, which the existence gate downstream refuses (fail-closed, never a wrong
// existing file).
function parseJsonc(text) {
  let noComments;
  try { noComments = stripComments(text, 'typescript', { blankStrings: false }); } catch { return null; }
  try { return JSON.parse(noComments); } catch {}
  try { return JSON.parse(noComments.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

// One alias rule: pattern with at most one '*', targets anchored at the dir their config anchors to.
function rule(pattern, targets, anchor) {
  const stars = (pattern.match(/\*/g) || []).length;
  if (stars > 1) return null;
  const cut = pattern.indexOf('*');
  return {
    pattern,
    wildcard: stars === 1,
    prefix: stars ? pattern.slice(0, cut) : pattern,
    suffix: stars ? pattern.slice(cut + 1) : '',
    targets: targets.map((t) => ({ t, anchor })),
  };
}

// Per-dir memo: a prove() run reads one immutable work copy, and test fixtures use fresh mkdtemp dirs,
// so caching by dir can never serve stale rules within a process lifetime.
const rulesCache = new Map();
export function loadAliasesCached(dir) {
  if (!rulesCache.has(dir)) rulesCache.set(dir, loadAliases(dir));
  return rulesCache.get(dir);
}

export function loadAliases(dir) {
  const rules = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const imp = pkg && pkg.imports;
    if (imp && typeof imp === 'object') {
      for (const [key, val] of Object.entries(imp)) {
        if (!key.startsWith('#')) continue;
        const target = typeof val === 'string' ? val
          : (val && typeof val === 'object') ? ['default', 'node', 'import'].map((k) => val[k]).find((v) => typeof v === 'string')
          : undefined;
        if (!target || !target.startsWith('./')) continue;
        const r = rule(key, [target], dir);
        if (r) rules.push(r);
      }
    }
  } catch {}
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    let text; try { text = readFileSync(p, 'utf8'); } catch { break; }
    const cfg = parseJsonc(text);
    if (cfg) {
      let co = cfg.compilerOptions;
      let anchor = dir;
      // One extends hop, taken only when the config itself carries no paths. The parent's paths
      // anchor at the PARENT's dir/baseUrl — that is where tsc resolves them from.
      if (!(co && co.paths) && typeof cfg.extends === 'string' && /^\.\.?\//.test(cfg.extends)) {
        const pAbs = resolve(dir, cfg.extends);
        let pText = null;
        try { pText = readFileSync(pAbs, 'utf8'); } catch { try { pText = readFileSync(pAbs + '.json', 'utf8'); } catch {} }
        const parent = pText && parseJsonc(pText);
        if (parent && parent.compilerOptions && parent.compilerOptions.paths) { co = parent.compilerOptions; anchor = dirname(pAbs); }
      }
      if (co && co.paths && typeof co.paths === 'object') {
        const base = typeof co.baseUrl === 'string' ? resolve(anchor, co.baseUrl) : anchor;
        for (const [pat, targets] of Object.entries(co.paths)) {
          if (!Array.isArray(targets)) continue;
          const ts = targets.filter((t) => typeof t === 'string');
          const r = ts.length && rule(pat, ts, base);
          if (r) rules.push(r);
        }
      }
    }
    break; // a config FILE existed — parsed or not, the search ends here (malformed → no rules)
  }
  return rules;
}

// Ordered absolute base paths `spec` maps to, or null when no rule matches. Order preserves the
// config's own target order — the caller applies first-existing-wins.
export function aliasBases(spec, rules) {
  const exact = rules.find((r) => !r.wildcard && r.pattern === spec);
  if (exact) return exact.targets.map(({ t, anchor }) => resolve(anchor, t));
  let best = null;
  for (const r of rules) {
    if (!r.wildcard) continue;
    if (spec.length < r.prefix.length + r.suffix.length) continue;
    if (!spec.startsWith(r.prefix) || !spec.endsWith(r.suffix)) continue;
    if (!best || r.prefix.length > best.prefix.length) best = r;
  }
  if (!best) return null;
  const mid = spec.slice(best.prefix.length, spec.length - best.suffix.length);
  return best.targets.map(({ t, anchor }) => resolve(anchor, t.includes('*') ? t.replace('*', mid) : t));
}
