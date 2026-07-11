#!/usr/bin/env python3
"""Translate MBPP (sanitized) problems into pilot task candidates via ast — mechanical + fail-closed.

A problem is JS-eligible only when EVERY test assert is `assert fn(<literals>) == <literal>` with
JSON-able literals (tuples become arrays), no sets, no floats anywhere, ints within JS safe range, and
dict keys all strings — anything else is rejected for JS rather than risking a wrong oracle.
Python-eligible keeps the original asserts verbatim (MBPP's own semantics, incl. set(...)==set(...)).
Output: JSON list of {task_id, prompt, entry, signature, js_ok, py_ok, js_oracle, py_oracle}.
"""
import ast, json, sys

MAX_SAFE = 2 ** 53 - 1


def literal_value(node):
    """ast node -> python value, or raise ValueError when not a pure literal."""
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [literal_value(e) for e in node.elts]
    if isinstance(node, ast.Dict):
        try:
            return {literal_value(k): literal_value(v) for k, v in zip(node.keys, node.values)}
        except TypeError as e:  # tuple-keyed dict -> converted key unhashable: not translatable, reject
            raise ValueError('unhashable dict key') from e
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant):
        v = node.operand.value
        if isinstance(v, (int, float)):
            return -v
    raise ValueError('not a literal')


def js_safe(v):
    """True iff v maps cleanly onto a JS value for deepStrictEqual (no floats, safe ints, str dict keys)."""
    if v is None or isinstance(v, (bool, str)):
        return True
    if isinstance(v, int):
        return abs(v) <= MAX_SAFE
    if isinstance(v, float):
        return False
    if isinstance(v, list):
        return all(js_safe(e) for e in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) for k in v) and all(js_safe(x) for x in v.values())
    return False


def parse_assert(line):
    """'assert fn(args)==expected' -> (fn, [arg values], expected value) or None."""
    try:
        tree = ast.parse(line.strip())
    except SyntaxError:
        return None
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Assert):
        return None
    t = tree.body[0].test
    if not (isinstance(t, ast.Compare) and len(t.ops) == 1 and isinstance(t.ops[0], ast.Eq)):
        return None
    call, expected_node = t.left, t.comparators[0]
    if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and not call.keywords):
        return None
    try:
        args = [literal_value(a) for a in call.args]
        expected = literal_value(expected_node)
    except ValueError:
        return None
    return call.func.id, args, expected


def signature_of(code, entry):
    for ln in code.splitlines():
        s = ln.strip()
        if s.startswith(f'def {entry}('):
            return s.rstrip(':')
    return f'def {entry}(...)'


def main(path):
    problems = json.load(open(path))
    out = []
    for p in sorted(problems, key=lambda x: x['task_id']):
        tests = p.get('test_list') or []
        if len(tests) < 2 or p.get('test_imports'):
            continue
        parsed = [parse_assert(t) for t in tests]
        entries = {pr[0] for pr in parsed if pr}
        # py-eligible: every assert must at least NAME one consistent entry fn (verbatim asserts kept).
        py_ok = len(entries) == 1 and all('assert' in t for t in tests)
        # js-eligible: every assert fully parsed AND every literal is js-safe.
        js_ok = all(parsed) and len(entries) == 1 and all(
            all(js_safe(a) for a in pr[1]) and js_safe(pr[2]) for pr in parsed if pr)
        if not (py_ok or js_ok):
            continue
        entry = entries.pop() if entries else None
        if not entry:
            continue
        js_oracle = []
        if js_ok:
            for fn, args, expected in parsed:
                js_args = ', '.join(json.dumps(a) for a in args)
                js_oracle.append(f'assert.deepStrictEqual({fn}({js_args}), {json.dumps(expected)});')
        out.append({
            'task_id': p['task_id'],
            'prompt': p['prompt'].strip(),
            'entry': entry,
            'signature': signature_of(p.get('code', ''), entry),
            'js_ok': js_ok,
            'py_ok': py_ok,
            'js_oracle': js_oracle,
            'py_oracle': [t.strip() for t in tests],
        })
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main(sys.argv[1])
