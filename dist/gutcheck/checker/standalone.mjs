// standalone.mjs — builds a runnable checker config for a project directory: auto-detects the
// language and test files, then points the source-discipline checks at the discovered test roots.
// Consumed by mutation/gutcheck.mjs's `gutcheck lint` path (no CLI entry point of its own).
import { readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { detect } from '../configure/detect.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', '.gradle', '.idea', 'target', 'vendor', '.venv',
  'venv', '__pycache__', 'dist', 'out', 'coverage', '.next',
]);

function walk(dir, acc = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// Discover the test files (so we don't depend on detect's narrow immediate-children probe), by name +
// extension. Returns the absolute test-file paths.
export function findTestFiles(files, ext) {
  if (ext === '.py') {
    return files.filter((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f) || (/\/tests?\//.test(f) && f.endsWith('.py')));
  }
  if (ext === '.kt' || ext === '.java') {
    // JVM: *Test/*Tests/*Spec/*IT by convention, or anything under a src/test (or androidTest) tree.
    return files.filter((f) => /(Test|Tests|Spec|IT)\.(kt|java)$/.test(f) || (/\/(test|androidTest)\//.test(f) && /\.(kt|java)$/.test(f)));
  }
  if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.c') {
    // C/C++: GoogleTest/Catch2 conventions (foo_test.cc, test_foo.cpp, FooTest.cpp) or a test/ tree.
    // C ships with C++ (CMake projects mix them; GoogleTest tests C too) — same check set + grammar.
    return files.filter((f) => /(_test|_tests|Test|Tests)\.(cpp|cc|cxx|c)$/.test(f) || /(^|\/)test_[^/]*\.(cpp|cc|cxx|c)$/.test(f) || (/\/(test|tests)\//.test(f) && /\.(cpp|cc|cxx|c)$/.test(f)));
  }
  if (ext === '.cs') {
    // C#: *Test.cs / *Tests.cs, or a Tests/ tree.
    return files.filter((f) => /(Test|Tests)\.cs$/.test(f) || (/\/([Tt]ests?)\//.test(f) && f.endsWith('.cs')));
  }
  if (ext === '.go') return files.filter((f) => /_test\.go$/.test(f)); // Go convention: *_test.go
  if (ext === '.rs') return files.filter((f) => /(^|\/)tests\//.test(f) && f.endsWith('.rs') || /_test(s)?\.rs$/.test(f));
  if (ext === '.swift') return files.filter((f) => /Tests?\.swift$/.test(f) || (/\/[Tt]ests?\//.test(f) && f.endsWith('.swift')));
  if (ext === '.rb') return files.filter((f) => /(_test|_spec)\.rb$/.test(f) || (/\/(test|spec)\//.test(f) && f.endsWith('.rb')));
  if (ext === '.php') return files.filter((f) => /Test\.php$/.test(f) || (/\/[Tt]ests?\//.test(f) && f.endsWith('.php')));
  if (ext === '.jl') return files.filter((f) => /(^|\/)(runtests|[^/]*_test|test_[^/]*)\.jl$/.test(f) || (/\/test\//.test(f) && f.endsWith('.jl')));
  if (ext === '.f90' || ext === '.f' || ext === '.f95') return files.filter((f) => /(_test|test_|_spec)\.(f90|f95|f)$/.test(f) || (/\/test\//.test(f) && /\.(f90|f95|f)$/.test(f)));
  if (ext === '.hs') return files.filter((f) => /(Spec|Test)\.hs$/.test(f) || (/\/test\//.test(f) && f.endsWith('.hs')));
  return files.filter((f) => /\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f) || (/\/(test|tests|__tests__|spec)\//.test(f) && /\.(jsx?|tsx?|mjs|cjs)$/.test(f)));
}

// Build a runnable config for a project dir: detect language/floor, then point the source checks at the
// auto-discovered test roots and use the dominant test-file extension (detect's single guess can mismatch,
// e.g. a tsconfig present but tests written in .js).
export function configForProject(dir) {
  const cfg = detect(dir);
  const ext0 = cfg.language.fileExt;
  if (!ext0) return { cfg: null, reason: 'no supported language detected (need package.json / pyproject.toml / setup.py)' };
  const all = walk(dir);
  let tf = findTestFiles(all, ext0);
  // dominant ext among discovered test files overrides detect's guess (lexer treats js/ts identically)
  if (tf.length) {
    const c = {};
    for (const f of tf) { const m = f.match(/\.[a-z]+$/); if (m) c[m[0]] = (c[m[0]] || 0) + 1; }
    const dom = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    if (dom && dom[0] !== ext0) { cfg.language.fileExt = dom[0]; tf = findTestFiles(all, dom[0]); }
  }
  if (!tf.length) return { cfg: null, reason: 'no test files found (looked for *.test.* / test_*.py under the tree)' };
  let testRoots = [...new Set(tf.map((f) => dirname(f)))];
  testRoots = testRoots.filter((d) => !testRoots.some((o) => o !== d && d.startsWith(o + '/'))); // top-level only
  const relTest = testRoots.map((d) => relative(dir, d));
  cfg.paths.srcRoots.test = relTest;
  cfg.checker.checks = cfg.checker.checks.map((c) => (c.id === 'external-citation-needs-url'
    ? { ...c, params: { ...c.params, scanRoots: relTest } } : c));
  return { cfg, testRoots, testFileCount: tf.length };
}
