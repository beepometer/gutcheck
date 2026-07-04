// test/lexer-codeonly.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOnly, stripComments } from '../checker/lexer.mjs';

test('codeOnly blanks operators inside strings and comments, keeps code', () => {
  const src = 'const a = b >= 1; // c >= d\nconst s = "p >= q";';
  const out = codeOnly(src, 'javascript');
  assert.equal(out.length, src.length, 'length/offsets preserved');
  // exactly one ">=" remains — the code one
  assert.equal((out.match(/>=/g) || []).length, 1);
  assert.ok(out.startsWith('const a = b >= 1;'), 'code is preserved verbatim'); // offsets intact
});

test('stripComments default (2-arg) is unchanged — keeps string contents verbatim', () => {
  const src = 'const s = "x >= y"; // gone';
  assert.ok(stripComments(src, 'javascript').includes('"x >= y"'), 'strings still verbatim by default');
});
