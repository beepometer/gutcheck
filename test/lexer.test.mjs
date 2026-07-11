import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments, codeOnly } from '../checker/lexer.mjs';

// Helpers
const survives = (out, tok) => assert.ok(out.includes(tok), `expected SURVIVING token '${tok}' in:\n${out}`);
const blanked = (out, tok) => assert.ok(!out.includes(tok), `expected BLANKED token '${tok}' to be gone in:\n${out}`);
const lineStable = (src, out) =>
  assert.equal(out.split('\n').length, src.split('\n').length, 'newline count (line numbers) must be preserved');

test('kotlin: // in string, /* */ block, """ multiline raw string', () => {
  const src = [
    'val x = "http://not-a-comment"  // real-comment-KILLME',
    'val y = """',
    '  multi line raw with // not-a-comment KEEPME1',
    '"""',
    'val z = 5  /* block-KILLME2 */ + KEEPME2',
  ].join('\n');
  const out = stripComments(src, 'kotlin');
  survives(out, 'http://not-a-comment'); // // inside a "..." string is preserved
  survives(out, 'KEEPME1');              // // inside a """...""" multiline string is preserved
  survives(out, 'KEEPME2');              // code after a block comment survives
  blanked(out, 'KILLME');                // the real // comment is gone
  blanked(out, 'KILLME2');               // the /* */ block is gone
  lineStable(src, out);
});

test('kotlin: backtick-quoted identifier is OPAQUE — an apostrophe/quote inside is not a string open', () => {
  // `fun `it's ok`()` — the apostrophe is INSIDE a Kotlin backtick identifier (a NAME), not a char
  // literal. Without opacity, codeOnly's `'` char-literal spec would fire and mask the rest of the line
  // (dropping the name + body `{`) — desyncing mutation/prove.mjs parseBlocks (a false-verdict vector).
  const out = codeOnly("@Test fun `it's ok`() { assertEquals(1, x()) }", 'kotlin');
  survives(out, "`it's ok`");              // the backtick identifier is preserved verbatim
  survives(out, 'assertEquals(1, x())');   // the body after it is NOT masked away
  // a double-quote inside a backtick name is part of the NAME too, not a string open
  const out2 = codeOnly('fun `parses "x" ok`() { body() }', 'kotlin');
  survives(out2, '`parses "x" ok`');
  survives(out2, 'body()');
  // a REAL char literal outside a backtick name still masks (opacity is scoped to backtick identifiers)
  const out3 = codeOnly("val c = '{'  // x", 'kotlin');
  blanked(out3, "'{'");                    // char literal '{' still blanked (brace-desync guard intact)
});

test('python: # comment, # inside string, triple-quoted multiline docstring', () => {
  const src = [
    'x = "http://keep"  # real-comment-KILLME',
    'def f():',
    '    """',
    '    middle line # not-a-comment KEEPME1',  // # on a NON-opening docstring line
    '    spanning KEEPME2',
    '    """',
    '    return 1  # KILLME2',
  ].join('\n');
  const out = stripComments(src, 'python');
  survives(out, 'http://keep');
  survives(out, 'KEEPME1'); // # on a middle docstring line is preserved (multiline string state)
  survives(out, 'KEEPME2');
  blanked(out, 'KILLME');
  blanked(out, 'KILLME2');
  lineStable(src, out);
});

test('shell: # boundary rule, single-quote no-escape, here-doc body', () => {
  const src = [
    'echo "hi"  # real-comment-KILLME',
    "x='literal $no #expansion KEEPME1'",
    'url=http://x#frag-KEEPME2',  // '#' mid-word is NOT a comment in shell
    'cat <<EOF',
    'inside heredoc # not-a-comment KEEPME3',
    'EOF',
    'echo done KEEPME4  # KILLME2',
  ].join('\n');
  const out = stripComments(src, 'shell');
  survives(out, 'KEEPME1'); // single-quoted string preserved verbatim
  survives(out, 'frag-KEEPME2'); // # after non-separator is part of the word, not a comment
  survives(out, 'KEEPME3'); // here-doc body preserved (the # inside is not a comment)
  survives(out, 'KEEPME4');
  blanked(out, 'KILLME');
  blanked(out, 'KILLME2');
  lineStable(src, out);
});

test('shell: // is NOT a comment (shell has no //)', () => {
  const out = stripComments('echo http://keep // KEEPME', 'shell');
  survives(out, 'http://keep');
  survives(out, 'KEEPME'); // there is no // line comment in shell
});

test('js: regex char-class containing /* does not start a phantom block comment', () => {
  // /[/*]/ contains a literal "/*". A naive block-comment stripper starts a phantom comment
  // here and eats the rest of the file. A regex-aware lexer consumes the whole literal.
  const src = 'var re = /[/*]/.test(s);  var afterRegex = KEEP3;  // real-KILLME\nvar last = KEEP4;';
  const out = stripComments(src, 'javascript');
  survives(out, 'KEEP3');      // the regex did NOT consume the trailing code
  survives(out, 'KEEP4');      // and did NOT start a runaway block comment
  blanked(out, 'KILLME');      // the genuine // comment after the regex IS stripped
  lineStable(src, out);
});

test('js: regex with escaped slashes (\\/\\/) is consumed as one literal', () => {
  const src = 'var re = /https?:\\/\\/keep2/gi;  var afterRegex = KEEP3;';
  const out = stripComments(src, 'javascript');
  survives(out, 'keep2');
  survives(out, 'KEEP3');
});

test('js: division vs regex disambiguation', () => {
  const src = 'var d = a / b;  // division-KILLME\nvar q = "x" / 2;  /* blk-KILLME2 */ var ok = KEEP6;';
  const out = stripComments(src, 'javascript');
  survives(out, 'a / b');  // a / b is division, both operands preserved
  survives(out, '"x" / 2'); // string then / is division, not a regex swallowing the line
  survives(out, 'KEEP6');
  blanked(out, 'KILLME');
  blanked(out, 'KILLME2');
  lineStable(src, out);
});

test('js: regex after a keyword (return) is recognized', () => {
  const out = stripComments('function g(){ return /re KEEP7/; } // KILLME', 'javascript');
  survives(out, 'KEEP7');
  blanked(out, 'KILLME');
});

test('js: template literal preserves // and ${...}', () => {
  const src = 'var t = `template http://keep4 ${x} KEEP5`;  /* blk-KILLME3 */ var z = KEEP6;';
  const out = stripComments(src, 'javascript');
  survives(out, 'http://keep4'); // // inside a template literal preserved
  survives(out, 'KEEP5');
  survives(out, '${x}');         // interpolation preserved verbatim
  survives(out, 'KEEP6');
  blanked(out, 'KILLME3');
});

test('all languages: a bare // comment line is fully blanked but keeps the newline', () => {
  for (const lang of ['kotlin', 'java', 'javascript']) {
    const src = 'code1 KEEP\n// whole-line-KILLME\ncode2 KEEP';
    const out = stripComments(src, lang);
    survives(out, 'code1 KEEP');
    survives(out, 'code2 KEEP');
    blanked(out, 'KILLME');
    lineStable(src, out);
  }
});
