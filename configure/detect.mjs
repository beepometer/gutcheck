// configure/detect.mjs — project-detection helper for the `configure` skill.
//
// Reads a project directory and returns a DRAFT gutcheck.config.json: every field it can
// infer is filled; every field it cannot is left null / [] for the owner to confirm. The
// configure skill NEVER silent-guesses — it presents this draft for confirmation, then the
// owner completes the non-inferable fields (projectName, productName, slugPrefix,
// the vocabularies, the calibrated constants) before the config is written.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_CHECKS_BY_BUILD } from './checksets/index.mjs';

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

// Single source of truth for the emitted checker floor: the shipped default config. Read once at
// import (deterministic; no subprocess) and clone per call so a caller can never mutate the floor.
const DEFAULT_CONFIG = JSON.parse(readFileSync(fileURLToPath(new URL('./gutcheck.default.json', import.meta.url)), 'utf8'));
// The language-agnostic check (no per-language lexer / assertion grammar) emitted for every project.
const LANG_AGNOSTIC_CHECK_IDS = ['external-citation-needs-url'];
// Lexer grammar per build system — used to give the (language-agnostic) citation check the right
// comment/string syntax so it can blank strings while keeping comments.
const LANG_FOR_BUILD = {
  node: 'javascript', python: 'python', gradle: 'kotlin', maven: 'kotlin', cmake: 'cpp', dotnet: 'csharp',
  go: 'go', cargo: 'rust', swift: 'swift', ruby: 'ruby', php: 'php', julia: 'julia', fortran: 'fortran', haskell: 'haskell',
};

// Source roots: immediate-children probe only (no up-walk, no subprocess → contamination-safe).
function detectSrcRoots(dir) {
  return {
    main: ['src', 'lib'].filter((r) => existsSync(join(dir, r))),
    test: ['test', 'tests', '__tests__', 'spec'].filter((r) => existsSync(join(dir, r))),
  };
}

// The emitted checker: the default config's envelope verbatim + a language-gated check list. node gets
// the full source-discipline floor (the default config IS the node floor); python gets the
// language-agnostic citation check plus the Python-flavoured source checks; every other build system gets
// only the language-agnostic citation check until the owner calibrates a source grammar in. Self-test
// fixtures travel with each check — the detector never silent-guesses a fixture.
function emitChecker(buildSystem, srcRoots) {
  const env = DEFAULT_CONFIG.checker;
  let gated;
  if (buildSystem === 'node') {
    gated = structuredClone(env.checks); // the default config is the node floor
  } else {
    gated = [
      ...structuredClone(env.checks).filter((c) => LANG_AGNOSTIC_CHECK_IDS.includes(c.id)),
      ...structuredClone(SOURCE_CHECKS_BY_BUILD[buildSystem] || []),
    ];
  }
  // Citations are scanned in the TEST tree only. Real-repo finding (N=10): widening to src/ flagged
  // standard NAMES in production docstrings (ISO-8601, RFC ...) at a ~94% false-positive rate — net
  // negative — and the test-value gating (nearTokens) is what actually scopes the check, not the roots.
  const scanRoots = srcRoots.test.length ? srcRoots.test : ['test'];
  // The citation check blanks STRING literals (so a standard named in an assertion message is not a value
  // citation) — that needs the project's comment/string grammar, so set its lang per build system.
  const citationLang = LANG_FOR_BUILD[buildSystem] || 'javascript';
  const checks = gated.map((c) => {
    if (c.id === 'external-citation-needs-url') return { ...c, params: { ...c.params, scanRoots, lang: citationLang } };
    return c;
  });
  return {
    harnessDirs: structuredClone(env.harnessDirs),
    docPrefixes: structuredClone(env.docPrefixes),
    placeholderTokens: structuredClone(env.placeholderTokens),
    historicalMarkers: structuredClone(env.historicalMarkers),
    externalMdAllowlist: structuredClone(env.externalMdAllowlist),
    checks,
  };
}

// Build system + language: first match wins, in rough order of disambiguating strength. Every
// build system below is still *detected* (so `gutcheck lint` can name it), but only `node` and
// `python` carry a source-discipline check set (see checksets/index.mjs) — the others fall back
// to the language-agnostic citation check alone until a check set is calibrated in.
function detectBuildAndLanguage(dir) {
  if (existsSync(join(dir, 'build.gradle.kts')) || existsSync(join(dir, 'build.gradle'))) {
    return {
      buildSystem: 'gradle',
      language: { fileExt: '.kt', declKeywords: ['fun', 'class', 'object', 'val'], docCommentForm: 'KDoc' },
      commands: { test: './gradlew test' },
    };
  }
  const pkgRaw = read(join(dir, 'package.json'));
  if (pkgRaw !== null) {
    let hasTestScript = false;
    try { hasTestScript = Boolean(JSON.parse(pkgRaw).scripts?.test); } catch { /* malformed → leave null */ }
    const ts = existsSync(join(dir, 'tsconfig.json'));
    return {
      buildSystem: 'node',
      language: { fileExt: ts ? '.ts' : '.js', declKeywords: ['function', 'class', 'const'], docCommentForm: 'JSDoc' },
      commands: { test: hasTestScript ? 'npm test' : null },
    };
  }
  if (existsSync(join(dir, 'pom.xml'))) {
    return {
      buildSystem: 'maven',
      language: { fileExt: '.java', declKeywords: ['class', 'interface', 'enum'], docCommentForm: 'Javadoc' },
      commands: { test: 'mvn test' },
    };
  }
  if (existsSync(join(dir, 'CMakeLists.txt'))) {
    return {
      buildSystem: 'cmake',
      language: { fileExt: '.cpp', declKeywords: ['class', 'struct', 'namespace'], docCommentForm: '///' },
      commands: { test: 'ctest' },
    };
  }
  const topEntries = (() => { try { return readdirSync(dir); } catch { return []; } })();
  if (topEntries.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) {
    return {
      buildSystem: 'dotnet',
      language: { fileExt: '.cs', declKeywords: ['class', 'struct', 'interface'], docCommentForm: '///' },
      commands: { test: 'dotnet test' },
    };
  }
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'setup.py'))) {
    return {
      buildSystem: 'python',
      language: { fileExt: '.py', declKeywords: ['def', 'class'], docCommentForm: 'docstring' },
      commands: { test: 'pytest' },
    };
  }
  if (existsSync(join(dir, 'Cargo.toml'))) {
    return {
      buildSystem: 'cargo',
      language: { fileExt: '.rs', declKeywords: ['fn', 'struct', 'impl', 'let'], docCommentForm: '///' },
      commands: { test: 'cargo test' },
    };
  }
  if (existsSync(join(dir, 'go.mod'))) {
    return {
      buildSystem: 'go',
      language: { fileExt: '.go', declKeywords: ['func', 'type', 'var'], docCommentForm: '//' },
      commands: { test: 'go test ./...' },
    };
  }
  if (existsSync(join(dir, 'Package.swift'))) {
    return { buildSystem: 'swift', language: { fileExt: '.swift', declKeywords: ['func', 'struct', 'class'], docCommentForm: '///' }, commands: { test: 'swift test' } };
  }
  if (existsSync(join(dir, 'composer.json'))) {
    return { buildSystem: 'php', language: { fileExt: '.php', declKeywords: ['function', 'class', 'trait'], docCommentForm: '/**' }, commands: { test: 'phpunit' } };
  }
  if (existsSync(join(dir, 'Project.toml')) || existsSync(join(dir, 'JuliaProject.toml'))) {
    return { buildSystem: 'julia', language: { fileExt: '.jl', declKeywords: ['function', 'struct', 'module'], docCommentForm: '"""' }, commands: { test: 'julia --project -e "using Pkg; Pkg.test()"' } };
  }
  if (existsSync(join(dir, 'Gemfile')) || topEntries.some((f) => f.endsWith('.gemspec'))) {
    return { buildSystem: 'ruby', language: { fileExt: '.rb', declKeywords: ['def', 'class', 'module'], docCommentForm: '#' }, commands: { test: 'bundle exec rake test' } };
  }
  if (existsSync(join(dir, 'stack.yaml')) || topEntries.some((f) => f.endsWith('.cabal'))) {
    return { buildSystem: 'haskell', language: { fileExt: '.hs', declKeywords: ['data', 'type', 'newtype'], docCommentForm: '-- |' }, commands: { test: 'stack test' } };
  }
  if (existsSync(join(dir, 'fpm.toml'))) {
    return { buildSystem: 'fortran', language: { fileExt: '.f90', declKeywords: ['subroutine', 'function', 'module'], docCommentForm: '!' }, commands: { test: 'fpm test' } };
  }
  return {
    buildSystem: null,
    language: { fileExt: null, declKeywords: [], docCommentForm: null },
    commands: { test: null },
  };
}

function detectRulesFile(dir) {
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    if (existsSync(join(dir, f))) return f;
  }
  return null;
}

// Default branch from .git/HEAD ONLY (no subprocess, no up-walk → deterministic for fixtures
// and contamination-free when the project sits inside another repo). Detached HEAD / packed
// refs / no .git → null (the skill asks the owner).
function detectDefaultBranch(dir) {
  const head = read(join(dir, '.git', 'HEAD'));
  if (head && head.startsWith('ref:')) {
    return head.slice(4).trim().replace('refs/heads/', '');
  }
  return null;
}

export function detect(projectDir) {
  const bl = detectBuildAndLanguage(projectDir);
  const rulesFile = detectRulesFile(projectDir);
  const srcRoots = detectSrcRoots(projectDir);
  return {
    _detected: { buildSystem: bl.buildSystem },
    identity: { projectName: null, productName: null, slugPrefix: null },
    commands: {
      test: bl.commands.test, testFast: null, testFull: null, check: null,
    },
    language: {
      fileExt: bl.language.fileExt, declKeywords: bl.language.declKeywords, visibilityKeyword: null,
      nullSentinel: null, placeholderStub: null, silentSkip: null, assertForm: null,
      failLoudForm: null, docCommentForm: bl.language.docCommentForm,
    },
    paths: { srcRoots },
    docs: {
      projectRulesFile: rulesFile, digestFiles: [],
      openCountHeading: null,
      defaultBranch: detectDefaultBranch(projectDir), branchNaming: null, commitTrailer: null,
    },
    checker: emitChecker(bl.buildSystem, srcRoots),
    platform: { runtime: 'claude-code' },
  };
}

// CLI: `node configure/detect.mjs <dir>` prints the draft as JSON.
// Robust main-module check: realpath both sides so symlinked paths (e.g. macOS /tmp ->
// /private/tmp) still compare equal, and importing this module never triggers the CLI.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  const dir = process.argv[2] || process.cwd();
  process.stdout.write(JSON.stringify(detect(dir), null, 2) + '\n');
}
