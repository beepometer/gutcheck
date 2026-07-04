#!/usr/bin/env python3
# py_blocks.py — stdlib-`ast` precision helper for the gutcheck probe (mutation/prove.mjs).
#
# Reads a Python test file path on argv and emits, on stdout, JSON:
#   {"imports": [{"local","module","level"}...], "blocks": [{"name","line","endline","calls","pins"}...]}
#
#   imports : `from MODULE import NAME [as ALIAS]` bindings — local name -> dotted module + relative level
#             (0 = absolute). `prove()` binds a pinned call name to its SUT file ONLY through these, so a
#             name the test did not import is never bound (no false HOLLOW). `import *` and plain `import M`
#             are intentionally omitted (they don't bind a callable name we can resolve precisely).
#   blocks  : every `def test*` / `async def test*` (methods inside a unittest.TestCase included), with the
#             SUT calls inside it (`calls`) and which of those have their RESULT VALUE-PINNED (`pins`).
#
# A call is PINNED when its result flows into an equality matcher whose check the gross sentinel
# (return 987654321) reliably FAILS: unittest's assertEqual family, or a bare `assert a == b`. Inequality
# / ordering / identity / membership compares (`!=`, `<`, `>`, `is`, `in`) are NOT pinned — the sentinel
# could pass them, which would be a false HOLLOW. Zero new dependency: stdlib ast/json/sys only.
import ast, json, sys

# unittest equality assertions whose check the numeric gross sentinel fails (sound to probe).
# NOTE: inequality variants (assertNotAlmostEqual, assertNotEqual, ...) must NEVER be in this set —
# the sentinel still satisfies a "not equal" check, so the mutation would survive a correct test
# (false HOLLOW).
PIN = {'assertEqual', 'assertAlmostEqual',
       'assertListEqual', 'assertDictEqual', 'assertSequenceEqual',
       'assertTupleEqual', 'assertSetEqual', 'assertMultiLineEqual', 'assertCountEqual'}


def callee(node):
    f = node.func
    return f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else None)


def calls_in(node):
    return [callee(n) for n in ast.walk(node) if isinstance(n, ast.Call) and callee(n)]


def pin_calls_in(node):
    # PIN collection is intentionally Name-only: `f()` is a precise, unambiguous bind target via the
    # file's `from M import f` table. `obj.f()` / `mod.f()` (ast.Attribute) is NOT — `callee()` would
    # report it under the bare attribute name (e.g. `process`), and the SUT resolver could then bind a
    # same-named but unrelated free function from an unrelated import, gutting the wrong file (false
    # HOLLOW). Never widen this to Attribute calls.
    return [n.func.id for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]


def main(path):
    tree = ast.parse(open(path).read())

    imports = []
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            for a in n.names:
                if a.name == '*':
                    continue
                imports.append({'local': a.asname or a.name, 'module': n.module or '', 'level': n.level or 0})

    blocks = []
    for fn in [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith('test')]:
        pins = []
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and callee(n) in PIN:
                for a in n.args:
                    pins += pin_calls_in(a)
            # bare `assert a == b` (or chained `a == b == c`): equality only — never `<`, `>`, `!=`, `is`, `in`.
            if isinstance(n, ast.Assert) and isinstance(n.test, ast.Compare) \
                    and n.test.ops and all(isinstance(op, ast.Eq) for op in n.test.ops):
                pins += pin_calls_in(n.test.left)
                for c in n.test.comparators:
                    pins += pin_calls_in(c)
        blocks.append({
            'name': fn.name,
            'line': fn.lineno,
            'endline': getattr(fn, 'end_lineno', fn.lineno),
            'calls': sorted(set(calls_in(fn))),
            'pins': sorted(set(pins)),
        })

    print(json.dumps({'imports': imports, 'blocks': blocks}))


if __name__ == '__main__':
    main(sys.argv[1])
