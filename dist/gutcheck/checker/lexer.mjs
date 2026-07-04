// Gutcheck SP-3 prototype — per-language comment stripper.
// Contract: blank COMMENTS to spaces; preserve everything
// else (code AND string/regex/heredoc/template contents) verbatim; preserve every newline
// so 1-based line numbers are stable (the offender-reporting invariant).
//
// The point of this prototype is to prove the SP-3 "biggest risk" cases are tractable:
//   JS regex-literal-vs-division, JS template literals, shell here-docs, shell single-quote
//   (no-escape), Python/Kotlin newline-spanning triple-quoted strings, // inside a string.

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'case', 'throw',
]);

export const GRAMMARS = {
  kotlin: {
    line: ['//'], block: [['/*', '*/']],
    strings: [
      { open: '"""', close: '"""', escape: false, multiline: true },
      { open: '"', close: '"', escape: true, multiline: false },
    ],
  },
  java: {
    line: ['//'], block: [['/*', '*/']],
    strings: [{ open: '"', close: '"', escape: true, multiline: false }],
  },
  python: {
    line: ['#'], block: [],
    strings: [
      { open: "'''", close: "'''", escape: true, multiline: true },
      { open: '"""', close: '"""', escape: true, multiline: true },
      { open: "'", close: "'", escape: true, multiline: false },
      { open: '"', close: '"', escape: true, multiline: false },
    ],
  },
  shell: {
    line: ['#'], block: [], hashNeedsBoundary: true, hereDoc: true,
    strings: [
      { open: "$'", close: "'", escape: true, multiline: true },
      { open: "'", close: "'", escape: false, multiline: true }, // NO escape processing
      { open: '"', close: '"', escape: true, multiline: true },
    ],
  },
  javascript: {
    line: ['//'], block: [['/*', '*/']], template: true, regex: true,
    strings: [
      { open: '"', close: '"', escape: true, multiline: false },
      { open: "'", close: "'", escape: true, multiline: false },
    ],
  },
};
GRAMMARS.typescript = GRAMMARS.javascript;
// C-family: // and /* */ comments, double-quoted strings (escape), single-quoted char literals (so a
// quote char like '"' does not start a phantom string). Raw/verbatim/interpolated strings get only basic
// handling — rare in asserted values.
GRAMMARS.cpp = {
  line: ['//'], block: [['/*', '*/']],
  strings: [
    { open: '"', close: '"', escape: true, multiline: false },
    { open: "'", close: "'", escape: true, multiline: false },
  ],
};
GRAMMARS.csharp = GRAMMARS.cpp;
// Additional languages (test-soundness scanning). Raw/interpolated/heredoc string forms get only basic
// handling — rare in asserted values. nestableBlock: true for languages whose block comments nest.
GRAMMARS.go = {
  line: ['//'], block: [['/*', '*/']],
  strings: [{ open: '"', close: '"', escape: true }, { open: '`', close: '`', escape: false, multiline: true }, { open: "'", close: "'", escape: true }],
};
GRAMMARS.rust = {
  line: ['//'], block: [['/*', '*/']], nestableBlock: true,
  strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
};
GRAMMARS.swift = {
  line: ['//'], block: [['/*', '*/']], nestableBlock: true,
  strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: '"', close: '"', escape: true }],
};
GRAMMARS.ruby = {
  line: ['#'], block: [],
  strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
};
GRAMMARS.php = {
  line: ['//', '#'], block: [['/*', '*/']],
  strings: [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }],
};
GRAMMARS.julia = {
  line: ['#'], block: [['#=', '=#']], nestableBlock: true,
  strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, { open: '"', close: '"', escape: true }],
};
GRAMMARS.fortran = {
  line: ['!'], block: [],
  strings: [{ open: '"', close: '"', escape: false }, { open: "'", close: "'", escape: false }],
};
GRAMMARS.haskell = {
  line: ['--'], block: [['{-', '-}']], nestableBlock: true,
  strings: [{ open: '"', close: '"', escape: true }],
};

const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const isExprEnder = (c) => c !== undefined && /[A-Za-z0-9_$)\]]/.test(c);
const isSep = (c) => c === undefined || /[\s;|&()<>]/.test(c);

export function stripComments(source, lang, opts = {}) {
  const blankStrings = opts.blankStrings === true;
  const keepComments = opts.keepComments === true; // blank strings but KEEP comments (citation provenance)
  const g = GRAMMARS[lang];
  if (!g) throw new Error(`no grammar for language '${lang}'`);
  const s = source;
  const out = [];
  let i = 0;
  let prevSig; // last significant code char emitted
  let prevWord; // last identifier/keyword token emitted

  const pushVerbatim = (from, to) => { for (let k = from; k < to; k++) out.push(s[k]); };
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out.push(s[k] === '\n' ? '\n' : ' ');
  };

  // sort string openers longest-first so """ beats " and $' beats '
  const strings = [...(g.strings || [])].sort((a, b) => b.open.length - a.open.length);

  const matchAt = (tok, at) => s.startsWith(tok, at);

  while (i < s.length) {
    const c = s[i];

    if (c === '\n') { out.push('\n'); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { out.push(c); i++; continue; }

    // 1) line comments
    let lineHit = null;
    for (const lc of g.line) if (matchAt(lc, i)) { lineHit = lc; break; }
    if (lineHit) {
      let ok = true;
      if (g.hashNeedsBoundary && lineHit === '#') {
        // shell: '#' is a comment only at a word boundary (start, or after a separator)
        ok = isSep(s[i - 1]);
      }
      if (ok) {
        let j = i;
        while (j < s.length && s[j] !== '\n') j++;
        if (keepComments) pushVerbatim(i, j); else blank(i, j);
        i = j;
        continue;
      }
    }

    // 2) block comments
    let blockHit = null;
    for (const [open, close] of g.block) if (matchAt(open, i)) { blockHit = [open, close]; break; }
    if (blockHit) {
      const [open, close] = blockHit;
      let j = i + open.length;
      let end;
      if (g.nestableBlock) { // Rust/Swift/Julia/Haskell: /* /* */ */ nests
        let depth = 1;
        while (j < s.length && depth > 0) {
          if (matchAt(open, j)) { depth++; j += open.length; } else if (matchAt(close, j)) { depth--; j += close.length; } else j++;
        }
        end = j;
      } else {
        while (j < s.length && !matchAt(close, j)) j++;
        end = j < s.length ? j + close.length : s.length;
      }
      if (keepComments) pushVerbatim(i, end); else blank(i, end);
      i = end;
      continue;
    }

    // 3) strings (verbatim, correctly bounded)
    let strHit = null;
    for (const spec of strings) if (matchAt(spec.open, i)) { strHit = spec; break; }
    if (strHit) {
      const end = consumeString(s, i, strHit);
      if (blankStrings) blank(i, end); else pushVerbatim(i, end);
      prevSig = ')'; prevWord = undefined; // a string literal is a value (expr-ender)
      i = end;
      continue;
    }

    // 4) shell here-doc (verbatim body)
    if (g.hereDoc && matchAt('<<', i)) {
      const hd = matchHereDoc(s, i);
      if (hd) {
        if (blankStrings) blank(i, hd.end); else pushVerbatim(i, hd.end);
        prevSig = ')'; prevWord = undefined;
        i = hd.end;
        continue;
      }
    }

    // 5) JS template literal (verbatim, incl. ${...})
    if (g.template && c === '`') {
      const end = consumeTemplate(s, i);
      if (blankStrings) blank(i, end); else pushVerbatim(i, end);
      prevSig = ')'; prevWord = undefined; // template literal is a value
      i = end;
      continue;
    }

    // 6) JS regex literal vs division
    if (g.regex && c === '/') {
      // not // or /* (those handled above), decide regex vs division
      const regexAllowed = prevSig === undefined
        || (prevWord && KEYWORDS_BEFORE_REGEX.has(prevWord))
        || !isExprEnder(prevSig);
      if (regexAllowed) {
        const end = consumeRegex(s, i);
        if (end > i) {
          if (blankStrings) blank(i, end); else pushVerbatim(i, end);
          prevSig = ')'; prevWord = undefined; // regex literal is a value
          i = end;
          continue;
        }
      }
      // else division
      out.push(c); prevSig = '/'; prevWord = undefined; i++;
      continue;
    }

    // 7) ordinary code char
    out.push(c);
    if (isWordChar(c)) {
      prevWord = (prevWord && isWordChar(prevSig)) ? prevWord + c : c;
    } else {
      prevWord = undefined;
    }
    prevSig = c;
    i++;
  }

  return out.join('');
}

function consumeString(s, start, spec) {
  let i = start + spec.open.length;
  while (i < s.length) {
    if (spec.escape && s[i] === '\\') { i += 2; continue; }
    if (s.startsWith(spec.close, i)) return i + spec.close.length;
    if (!spec.multiline && s[i] === '\n') return i; // unterminated single-line ends at NL
    i++;
  }
  return s.length;
}

function consumeTemplate(s, start) {
  let i = start + 1;
  let braceDepth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (braceDepth === 0 && c === '`') return i + 1;
    if (c === '$' && s[i + 1] === '{') { braceDepth++; i += 2; continue; }
    if (braceDepth > 0 && c === '}') { braceDepth--; i++; continue; }
    i++;
  }
  return s.length;
}

function consumeRegex(s, start) {
  let i = start + 1;
  let inClass = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') return start; // not a regex (no multi-line regex literals)
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < s.length && /[a-z]/i.test(s[i])) i++; // flags
      return i;
    }
    i++;
  }
  return start;
}

export function codeOnly(source, lang) {
  return stripComments(source, lang, { blankStrings: true });
}

// Join physical lines into LOGICAL lines so a multi-line call (a continued assertion) is scannable as one
// line. Input must already be comment/string-masked (so parens inside strings/comments are gone). Counts
// only ()/[] (NOT block {}), joins a line onto the next while its parens are unbalanced-open (cap 12 lines),
// and BLANKS the consumed continuation lines so 1-based line numbers — the offender-reporting invariant —
// are preserved: the joined statement reports on its START line. No-op for already-balanced single lines.
export function joinLogicalLines(maskedText) {
  const lines = maskedText.split('\n');
  const out = lines.slice();
  const deltas = (str) => { let p = 0, b = 0; for (const ch of str) { if (ch === '(' || ch === '[') p++; else if (ch === ')' || ch === ']') p--; else if (ch === '{') b++; else if (ch === '}') b--; } return { p, b }; };
  let i = 0;
  while (i < lines.length) {
    const d0 = deltas(lines[i]);
    // start a join only on a line with unbalanced-open parens that does NOT open a block — so a callback
    // header `test('x', () => {` (unbalanced '(' but opens '{') is left alone and its body stays separate.
    if (d0.p > 0 && d0.b <= 0) {
      const parts = [lines[i]]; let depth = d0.p; let j = i + 1;
      while (j < lines.length && depth > 0 && j - i < 12) {
        const dj = deltas(lines[j]);
        if (dj.b > 0) break; // a continuation that opens a block is a new statement — don't swallow it
        parts.push(lines[j].trimStart()); depth += dj.p; out[j] = ''; j++;
      }
      out[i] = parts.join(' ');
      i = j > i + 1 ? j : i + 1;
    } else i++;
  }
  return out.join('\n');
}

function matchHereDoc(s, start) {
  // <<[-] [quote]WORD[quote] ... \n ... \n  WORD
  const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(s.slice(start, start + 80));
  if (!m) return null;
  const dash = m[1] === '-';
  const word = m[3];
  let i = start + m[0].length;
  // advance to end of the start line
  while (i < s.length && s[i] !== '\n') i++;
  if (i < s.length) i++; // consume the newline
  // scan body lines until a terminator line == word (trimmed if dash)
  while (i < s.length) {
    let lineEnd = i;
    while (lineEnd < s.length && s[lineEnd] !== '\n') lineEnd++;
    const line = s.slice(i, lineEnd);
    const cmp = dash ? line.replace(/^\t+/, '') : line;
    if (cmp === word) { return { end: lineEnd < s.length ? lineEnd + 1 : lineEnd }; }
    i = lineEnd < s.length ? lineEnd + 1 : lineEnd;
  }
  return { end: s.length };
}
