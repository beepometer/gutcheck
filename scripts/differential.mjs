// scripts/differential.mjs — dev-time differential oracle: checks the regex layer's two riskiest
// decisions against a real parser (@babel/parser, devDependency). Never shipped — not in the npm
// files whitelist, not copied into dist/gutcheck; consumed only by test/differential.test.mjs.
//
// Two checks, matching the two failure families the parse layer has actually produced:
//   diffGut  — a grossBreak mutant must (a) still parse, (b) leave the target's body as NOTHING but
//              the numeric sentinel (a partial gut — the arrowSite line-continuation class — leaves
//              original body text alive), and (c) confine its edits to the target's body (an
//              over-run alters a neighboring declaration).
//   diffMask — codeOnly must blank exactly the comment/string/template/regex ranges the parser
//              reports, whole literals including delimiters (the calibrated contract). Blanking real
//              code desyncs every downstream brace walk; leaking literal content feeds the scans
//              text they must never see.
import { parse } from '@babel/parser';

const PLUGINS = { '.tsx': ['typescript', 'jsx'], '.jsx': ['jsx'] };
function parseAny(code, ext) {
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: PLUGINS[ext] || ['typescript'],
  });
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) { if (c && typeof c === 'object') walk(c, visit); } }
    else if (v && typeof v === 'object') walk(v, visit);
  }
}

const FN_VALUE = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const ANY_FN = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ClassMethod', 'ObjectMethod', 'ClassPrivateMethod']);
function namedFns(ast, code) {
  const out = [];
  const allBodies = []; // EVERY function body range, named or not — for nesting detection
  const push = (name, fn, form) => {
    if (!fn || !fn.body) return; // TS overload signatures / ambient declares carry no body
    out.push({
      name,
      form,
      kind: fn.body.type === 'BlockStatement' ? 'block' : 'expr',
      bodyStart: fn.body.start,
      bodyEnd: fn.body.end,
      bodyText: code.slice(fn.body.start, fn.body.end),
    });
  };
  walk(ast, (n) => {
    if (ANY_FN.has(n.type) && n.body) allBodies.push([n.body.start, n.body.end]);
    if (n.type === 'FunctionDeclaration' && n.id) push(n.id.name, n, 'fn-decl');
    else if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && n.init && FN_VALUE.has(n.init.type)) push(n.id.name, n.init, 'var-fn');
    else if ((n.type === 'ClassMethod' || n.type === 'ObjectMethod') && n.key && n.key.type === 'Identifier' && !n.computed && n.kind !== 'constructor') push(n.key.name, n, n.type === 'ClassMethod' ? 'class-method' : 'object-method');
    else if ((n.type === 'ClassProperty' || n.type === 'PropertyDefinition') && n.key && n.key.type === 'Identifier' && !n.computed && n.value && FN_VALUE.has(n.value.type)) push(n.key.name, n.value, 'class-prop');
    else if (n.type === 'ObjectProperty' && n.key && n.key.type === 'Identifier' && !n.computed && n.value && FN_VALUE.has(n.value.type)) push(n.key.name, n.value, 'object-prop-fn');
  });
  // nested = the declaration lives inside SOME OTHER function's body (named or anonymous): the diff
  // report deliberately enumerates only diff-visible units — a hunk in a nested fn marks its encloser.
  for (const f of out) {
    f.nested = allBodies.some(([s, e]) => s < f.bodyStart && f.bodyEnd <= e && !(s === f.bodyStart && e === f.bodyEnd));
  }
  return out;
}

export function oracleFnBodies(code, ext) {
  return namedFns(parseAny(code, ext), code).map(({ name, form, nested, kind, bodyStart, bodyEnd }) => ({ name, form, nested, kind, bodyStart, bodyEnd }));
}

export function diffGut(code, ext, name, mutant) {
  let origAst; try { origAst = parseAny(code, ext); } catch (e) { return { ok: false, reason: `original does not parse: ${e && e.message}` }; }
  let mutAst; try { mutAst = parseAny(mutant, ext); } catch (e) { return { ok: false, reason: `mutant does not parse: ${e && e.message}` }; }
  const origTargets = namedFns(origAst, code).filter((f) => f.name === name);
  if (origTargets.length !== 1) return { ok: false, reason: `target ${name} is not uniquely declared in the original` };
  const mutTargets = namedFns(mutAst, mutant).filter((f) => f.name === name);
  if (mutTargets.length !== 1) return { ok: false, reason: `target ${name} is not uniquely present in the mutant` };
  const t = mutTargets[0];
  const pure = t.kind === 'expr'
    ? /^\d+$/.test(t.bodyText.trim())
    : /^\{\s*return\s+\d+;?\s*\}$/.test(t.bodyText.trim());
  if (!pure) return { ok: false, reason: `mutant body of ${name} is not the bare sentinel — partial gut: ${JSON.stringify(t.bodyText.slice(0, 80))}` };
  // Isolation: grossBreak is one splice, so the string-diff window between original and mutant must
  // lie entirely inside the target's body range per the ORIGINAL's AST. Nested named functions are
  // covered for free (a gutted parent legitimately deletes its inner functions; a gutted inner
  // function legitimately changes its ancestors' body text — both stay within the target's range).
  let p = 0;
  const maxP = Math.min(code.length, mutant.length);
  while (p < maxP && code[p] === mutant[p]) p++;
  let s = 0;
  const maxS = Math.min(code.length, mutant.length) - p;
  while (s < maxS && code[code.length - 1 - s] === mutant[mutant.length - 1 - s]) s++;
  let { bodyStart, bodyEnd } = origTargets[0];
  // A parenthesized expression body — `=> ({...})` — is correctly gutted WITH its wrapping parens,
  // but babel's body node excludes them. Widen the acceptable window over balanced wrapping parens.
  for (;;) {
    let a = bodyStart - 1; while (a >= 0 && (code[a] === ' ' || code[a] === '\t')) a--;
    let b = bodyEnd; while (b < code.length && (code[b] === ' ' || code[b] === '\t')) b++;
    if (a >= 0 && code[a] === '(' && code[b] === ')') { bodyStart = a; bodyEnd = b + 1; } else break;
  }
  if (p < bodyStart || code.length - s > bodyEnd) {
    return { ok: false, reason: `mutant edits extend beyond the body of ${name} ([${p}, ${code.length - s}) vs body [${bodyStart}, ${bodyEnd})) — another declaration was altered` };
  }
  return { ok: true, reason: '' };
}

export function diffMask(code, mask, ext) {
  if (mask.length !== code.length) {
    return [{ line: 1, dir: 'ate-code', snippet: `mask length ${mask.length} !== code length ${code.length}` }];
  }
  let ast; try { ast = parseAny(code, ext); } catch { return []; } // an unparseable original is the corpus's concern, not the mask's
  const expected = new Uint8Array(code.length);
  const mark = (s, e) => { for (let i = s; i < e; i++) expected[i] = 1; };
  for (const c of ast.comments || []) mark(c.start, c.end);
  const shebang = ast.program && ast.program.interpreter; // codeOnly rightly treats `#!...` as non-code
  if (shebang) mark(shebang.start, shebang.end);
  walk(ast, (n) => {
    if (n.type === 'StringLiteral' || n.type === 'TemplateLiteral' || n.type === 'RegExpLiteral' || n.type === 'DirectiveLiteral') mark(n.start, n.end);
  });
  const violations = [];
  let line = 1;
  for (let i = 0; i < code.length && violations.length < 20; i++) {
    if (code[i] === '\n') { line++; continue; }
    if (/\s/.test(code[i])) continue;
    const blanked = mask[i] !== code[i];
    const dir = blanked && !expected[i] ? 'ate-code' : !blanked && expected[i] ? 'leaked-literal' : null;
    if (!dir) continue;
    const last = violations[violations.length - 1];
    if (last && last.line === line && last.dir === dir) continue; // one report per line per direction
    violations.push({ line, dir, snippet: contextOf(code, i) });
  }
  return violations;
}

function contextOf(code, i) {
  const from = code.lastIndexOf('\n', i) + 1;
  const to = code.indexOf('\n', i);
  return code.slice(from, to === -1 ? undefined : to).trim().slice(0, 100);
}
