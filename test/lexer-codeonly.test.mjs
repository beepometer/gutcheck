// test/lexer-codeonly.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOnly, stripComments } from '../checker/lexer.mjs';
import { grossBreak } from '../mutation/probe.mjs';

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

// KNOWN GAP, DELIBERATELY UNFIXED (pin, not a bug report): the regex-vs-division heuristic treats a `)`
// as an expression-ender, so a regex literal in legal STATEMENT position right after a `)` — the idiomatic
// `if (cond) /re/.test(x)` — is misread as division. The first quote inside the regex then opens a phantom
// string that blanks the rest of that physical line. Fixing the lexer's statement-position detection is
// deliberately OUT OF SCOPE here: the wrong fix (teaching it "regex after `)`/`]` is always legal") would
// make division-after-`)` (`(a + b) /c/.length`, a real expression) misread as a regex instead — trading
// one false read for another. This test pins the CURRENT behavior: the mask corrupts, but the corruption
// stays fail-closed downstream — a one-liner whose closing brace lands on the same corrupted line makes
// grossBreak's brace-balance scan fail (unbalanced braces → null), so the probe reports INCONCLUSIVE, never
// a wrong verdict.
test('codeOnly misreads a statement-position regex after `)` as division (KNOWN, masking-only) — but grossBreak fails closed on the one-liner variant', () => {
  const src = 'export function classify(s){ if (s.length) /["]/.test(s); return s.trim().toUpperCase(); }';
  const masked = codeOnly(src, 'javascript');
  // pin the corruption itself: the phantom string swallows the rest of the source (incl. the closing `}`)
  assert.ok(!masked.includes('}'), 'the phantom string blanks past the closing brace on this one-liner');
  // pin the fail-closed consequence: grossBreak can't balance braces on the corrupted mask → null (no verdict)
  assert.equal(grossBreak(src, 'classify', 'javascript'), null,
    'mask corruption must stay fail-closed (null/inconclusive), never mint a wrong verdict');
});
