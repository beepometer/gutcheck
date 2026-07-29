// mutation/python-resolve.mjs — Python block parsing (delegated to mutation/py_blocks.py) and SUT
// resolution, including class-member lookup. prove.mjs re-exports pyBlocks, resolvePySut,
// resolvePyClassMember, and pythonExe (imported back by prove.mjs and by runners.mjs — see both comments
// below); canonKey/toPosix stay module-private duplicates (mirrored in prove.mjs and jvm.mjs, never
// shared). py_blocks.py is resolved relative to THIS file's own URL, so the relative path resolves
// correctly regardless of which file imports it.
import { readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pyDeclSiteCount } from './probe.mjs';
import { reEsc, declRe, toPosix, canonKey } from './parse-utils.mjs';

// Python interpreter, resolved ONCE: some systems ship `python3` but no bare `python`. Used for BOTH the
// pytest command (runners.mjs's testCmdFor, which imports this back) and the stdlib-ast block helper
// below, so they agree. null when neither is on PATH (→ the Python ast precision path is skipped and the
// regex Python branch is used as the fallback).
let _pyExe; // memoized: 'python3' | 'python' | null
export function pythonExe() {
  if (_pyExe !== undefined) return _pyExe;
  _pyExe = null;
  for (const exe of ['python3', 'python']) {
    try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); _pyExe = exe; break; } catch {}
  }
  return _pyExe;
}

// Path to the stdlib-ast block-parsing helper pyBlocks/pyMemberOk invoke below. Same-directory relative
// URL, so this stays correct regardless of which module hosts it.
const PY_HELPER = fileURLToPath(new URL('./py_blocks.py', import.meta.url));

// ---- Python precision path (stdlib `ast`, zero new dependency) ----
// Run mutation/py_blocks.py over a test file → { imports:[{local,module,level}], blocks:[{name,line,
// endline,calls,pins}] }, or null when python3/python is absent or the helper fails (→ regex fallback).
// `pins` are the SUT calls whose RESULT is value-pinned by an equality matcher (assertEqual family /
// `assert ==`) — including unittest's `self.assertEqual(...)`, which the JS-oriented pinnedFragments misses.
export function pyBlocks(absTestFile) {
  const exe = pythonExe();
  if (!exe) return null;
  try {
    const out = execFileSync(exe, [PY_HELPER, absTestFile], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const parsed = JSON.parse(out);
    if (!parsed || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.imports)) return null;
    return parsed;
  } catch { return null; }
}
// Shared binding + module-file resolution for BOTH resolvePySut and resolvePyClassMember (T4, §6.3 — "one
// helper, two callers, no drift"): given a name bound via `from MODULE import NAME` in pyImports, resolve
// which of srcFiles it could mean. A relative import (`level`>0) climbs parents from the test file's dir;
// an absolute import resolves against the test file's dir (pytest prepends the test's rootdir to sys.path
// under the flat layout). Returns the matching srcFiles entries (module.py or module/__init__.py — at most
// one of those normally exists, but both candidates are checked so a case/symlink collision still
// matches), or null when the name isn't imported at all. Callers apply their own downstream ambiguity
// discipline over the returned list.
function resolvePyModuleFiles(name, pyImports, absTest, srcFiles) {
  const binding = pyImports.find((b) => b.local === name);
  if (!binding) return null;
  let base = dirname(absTest);
  for (let i = 1; i < (binding.level || 0); i++) base = dirname(base);
  const segs = binding.module ? binding.module.split('.') : [];
  const modBase = segs.length ? resolve(base, ...segs) : base;
  const cands = new Set([modBase + '.py', join(modBase, '__init__.py')].map(canonKey));
  return srcFiles.filter((f) => cands.has(canonKey(f)));
}
// Bind a pinned call name to its SUT .py file IMPORT-AWARE: only through a `from MODULE import fn` the test
// actually wrote (py_blocks emits those bindings) — a name the test did not import never binds, so no false
// HOLLOW. The resolved file must also DECLARE `def fn`. Returns the SUT path relative to dir, or null (→
// skip the block).
export function resolvePySut(fn, pyImports, absTest, srcFiles, dir) {
  const files = resolvePyModuleFiles(fn, pyImports, absTest, srcFiles);
  if (!files) return null;
  const re = declRe(fn);
  // Ambiguity guard, mirroring the JVM overload rule: a module that binds NAME via BOTH a `class NAME`
  // declaration and a def/assign-style declaration (`def NAME(` / `NAME = ...`) rebinds the module-level
  // name at import time — whichever comes LAST textually wins at runtime. Gut-time's jsSigRegex
  // (probe.mjs) has no `class NAME` alternative, so it always guts the def/assign form regardless of
  // which one the runtime actually binds. When the class is what runs, the def/assign mutant is dead
  // code — the mutant survives a sound test → false HOLLOW. Refuse rather than guess.
  const e = reEsc(fn);
  const classRe = new RegExp(`\\bclass\\s+${e}\\b`);
  const defAssignRe = new RegExp(`\\bdef\\s+${e}\\b|\\b${e}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`);
  for (const f of files) {
    try {
      const text = readFileSync(f, 'utf8');
      if (classRe.test(text) && defAssignRe.test(text)) return null;
      if (re.test(text)) return toPosix(relative(dir, f));
    } catch {}
  }
  return null;
}

// resolvePyClassMember(ctor, method, pyImports, absTest, srcFiles, dir) → sutRel | null (T4, §6.3). The
// Python instance-receiver counterpart of resolvePySut: shares resolvePyModuleFiles' binding + module-file
// resolution (one helper, two callers — no drift), then hands each candidate file to the py_blocks.py
// `--member` ast validator (§6.2: exactly one module-top-level `ClassDef ctor` with no decorator/metaclass,
// no other module-level binding of `ctor`, exactly one non-async undecorated `FunctionDef method` directly
// in `ctor`'s own body with first param literally `self`, no other `def method` anywhere in the module),
// then requires `pyDeclSiteCount(srcText, method) === 1` — gut-time regex parity (§6.4, mirrors jsDeclSites/
// jvmDeclSites), so a credited site is exactly the one grossBreak's Python pass 1 would actually gut. A
// python3-less environment (pythonExe() null) refuses every candidate (pyMemberOk returns false) — the
// pyAst caller in prove()'s block loop never even reaches here in that case (pyBlocks() itself already
// returns null with no interpreter, so `pyAst` is null and the whole T4 path is skipped — this is a second,
// independent fail-closed layer, not the only one).
const pyMemberCache = new Map();
function pyMemberOk(absSrc, ctor, method) {
  const key = absSrc + '::' + ctor + '::' + method;
  if (pyMemberCache.has(key)) return pyMemberCache.get(key);
  let ok = false;
  const exe = pythonExe();
  if (exe) {
    try {
      const out = execFileSync(exe, [PY_HELPER, '--member', absSrc, ctor, method], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      ok = JSON.parse(out).ok === true;
    } catch { ok = false; }
  }
  pyMemberCache.set(key, ok);
  return ok;
}
export function resolvePyClassMember(ctor, method, pyImports, absTest, srcFiles, dir) {
  const files = resolvePyModuleFiles(ctor, pyImports, absTest, srcFiles);
  if (!files) return null;
  for (const f of files) {
    if (!pyMemberOk(f, ctor, method)) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (pyDeclSiteCount(text, method) !== 1) continue;
    return toPosix(relative(dir, f));
  }
  return null;
}
