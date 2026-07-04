import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAMMARS, stripComments } from '../checker/lexer.mjs';

// The HONEST baseline = a naive C-family lexer applied to each language (line+block
// comments + simple "..."/'...' strings, NO regex/template/heredoc/multiline-string state).
// This proves the product's per-language ADDITIONS over the C-family baseline are each
// load-bearing: the C-family baseline MANGLES the construct; the real grammar preserves it.
GRAMMARS.naivejs = { line: ['//'], block: [['/*', '*/']],
  strings: [{ open: '"', close: '"', escape: true, multiline: false },
            { open: "'", close: "'", escape: true, multiline: false }] };
GRAMMARS.naivepy = { line: ['#'], block: [],
  strings: [{ open: "'", close: "'", escape: true, multiline: false },
            { open: '"', close: '"', escape: true, multiline: false }] };
GRAMMARS.naiveshell = { line: ['#'], block: [], hashNeedsBoundary: true,
  strings: [{ open: "'", close: "'", escape: true, multiline: false },
            { open: '"', close: '"', escape: true, multiline: false }] };

const baselineMangles = (out, tok, why) => assert.ok(!out.includes(tok), why);

test('ADDITION js regex: C-family sees /* in /[/*]/ and eats the rest', () => {
  const src = 'var re = /[/*]/.test(s);  var k = KEEP3;\nvar last = KEEP4;';
  const base = stripComments(src, 'naivejs');
  const real = stripComments(src, 'javascript');
  baselineMangles(base, 'KEEP3', 'C-family should phantom-comment from /* to EOF');
  baselineMangles(base, 'KEEP4', 'C-family should eat across the newline to EOF');
  assert.ok(real.includes('KEEP3') && real.includes('KEEP4'), 'real regex-aware grammar preserves both');
});

test('ADDITION js template: C-family treats // in `http://` as a comment', () => {
  const src = 'var t = `http://keepY ${x}`; var z = KEEP6;';
  const base = stripComments(src, 'naivejs');
  const real = stripComments(src, 'javascript');
  baselineMangles(base, 'KEEP6', 'C-family should comment-strip from // to EOL, eating KEEP6');
  assert.ok(real.includes('KEEP6') && real.includes('${x}'), 'real template grammar preserves the line');
});

test('ADDITION python triple-quote: C-family strips a # on a middle docstring line', () => {
  const src = 'def f():\n    """\n    middle # KEEPME1\n    spans KEEPME2\n    """\n    return 1';
  const base = stripComments(src, 'naivepy');
  const real = stripComments(src, 'python');
  // C-family: the opening """ mis-parses; line 3 is at CODE state so its # is a comment ->
  // KEEPME1 stripped. The real multiline-string grammar keeps the whole docstring verbatim.
  baselineMangles(base, 'KEEPME1', 'C-family should strip the # on the middle docstring line');
  assert.ok(real.includes('KEEPME1') && real.includes('KEEPME2'), 'real multiline grammar preserves docstring');
});

test('ADDITION shell heredoc: C-family treats # in the body as a comment', () => {
  const src = 'cat <<EOF\nbody # KEEPME3\nEOF\necho KEEP4';
  const base = stripComments(src, 'naiveshell');
  const real = stripComments(src, 'shell');
  baselineMangles(base, 'KEEPME3', 'C-family should comment-strip the # in the heredoc body');
  assert.ok(real.includes('KEEPME3') && real.includes('KEEP4'), 'real heredoc grammar preserves the body');
});
