#!/usr/bin/env python3
# py_blocks.py — stdlib-`ast` precision helper for the gutcheck probe (mutation/prove.mjs).
#
# Two independent modes on argv:
#   1. `py_blocks.py <test.py>` — emits, on stdout, JSON:
#        {"imports": [{"local","module","level"}...],
#         "blocks": [{"name","line","endline","calls","pins","inst"}...]}
#   2. `py_blocks.py --member <src.py> <ClassName> <method>` — emits {"ok": true|false}: the SUT-side ast
#      validation for instance-receiver crediting (see resolvePyClassMember in mutation/prove.mjs). Any
#      parse error, any check failing, any exotic node -> {"ok": false} (fail-closed).
#
#   imports : `from MODULE import NAME [as ALIAS]` bindings — local name -> dotted module + relative level
#             (0 = absolute). `prove()` binds a pinned call name to its SUT file ONLY through these, so a
#             name the test did not import is never bound (no false HOLLOW). `import *` and plain `import M`
#             are intentionally omitted (they don't bind a callable name we can resolve precisely).
#   blocks  : every `def test*` / `async def test*` (methods inside a unittest.TestCase included), with the
#             SUT calls inside it (`calls`) and which of those have their RESULT VALUE-PINNED (`pins`), plus
#             the receiver'd instance calls it makes (`inst`, below).
#
# A call is PINNED when its result flows into an equality matcher whose check the gross sentinel
# (return 987654321) reliably FAILS: unittest's assertEqual family, or a bare `assert a == b`. Inequality
# / ordering / identity / membership compares (`!=`, `<`, `>`, `is`, `in`) are NOT pinned — the sentinel
# could pass them, which would be a false HOLLOW. Zero new dependency: stdlib ast/json/sys only.
#
# `inst` (new, T4, docs/plans/2026-07-09-inline-receiver-crediting.md): receiver'd instance calls in the
# SAME pin contexts `pin_calls_in` scans — `Calc().add(2,3)` (inline) and `c = Calc(); c.add(2,3)`
# (variable) — resolved to deduped, sorted `{"ctor","method"}` pairs. `pin_calls_in` is deliberately
# Name-only (see its own header below), so a receiver'd `.method(` call was NEVER pinned at all: the
# variable form landed 'no-pin', and the inline form's bare ctor name resolved as a dead-end eligible
# entry (`Calc` parses as a class declaration but is never guttable). `inst` is collected here, not in
# prove.mjs, because the file-wide mock-taint / ctor-rebind / whole-module receiver-binding rules need the
# WHOLE test file's ast — exactly where `inferReceiverTypeFromCtor` (prove.mjs, JS/JVM) holds the whole
# masked test file. prove.mjs's resolvePyClassMember then validates the SUT side (does `ctor` really
# declare a plain instance `method` — the `--member` mode above). `pins`/`calls`/`imports` are UNCHANGED
# byte-identical (the ctor name keeps appearing in `pins` — a harmless never-guttable residue, §7).
import ast, json, sys

# unittest equality assertions whose check the numeric gross sentinel fails (sound to probe).
# NOTE: inequality variants (assertNotAlmostEqual, assertNotEqual, ...) must NEVER be in this set —
# the sentinel still satisfies a "not equal" check, so the mutation would survive a correct test
# (false HOLLOW).
PIN = {'assertEqual', 'assertAlmostEqual',
       'assertListEqual', 'assertDictEqual', 'assertSequenceEqual',
       'assertTupleEqual', 'assertSetEqual', 'assertMultiLineEqual', 'assertCountEqual'}

# unittest.mock / mock / pytest_mock module names that taint the WHOLE file (mirrors prove.mjs's JS
# MOCK_TAINT gate's deliberate coarseness — a partial-mock spec can hide behind an otherwise-innocent call
# shape, so ANY mock-framework touch anywhere in the file refuses EVERY instance credit in it).
MOCK_MODULES = {'unittest.mock', 'mock', 'pytest_mock'}
MOCK_FIXTURE_PARAMS = {'monkeypatch', 'mocker'}


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
    # HOLLOW). Never widen this to Attribute calls. (The receiver'd `.method(` shape this excludes is what
    # `inst_calls_in`, below, captures separately and SAFELY — type-resolved, never bare-name-resolved.)
    return [n.func.id for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]


def _target_names(t):
    # Every plain Name bound by an assignment-style target, recursing through tuple/list/starred unpacking
    # (so `a, (b, c) = ...` reports {'a','b','c'}). Attribute/Subscript targets bind no NEW plain name (a
    # `c.attr = ...` mutates `c`'s state, it does not rebind the name `c` itself) — callers that care about
    # that taint (receiver_binding, below) check for it separately.
    if isinstance(t, ast.Name):
        return {t.id}
    if isinstance(t, (ast.Tuple, ast.List)):
        s = set()
        for e in t.elts:
            s |= _target_names(e)
        return s
    if isinstance(t, ast.Starred):
        return _target_names(t.value)
    return set()


def _fn_arg_names(n):
    args = n.args
    out = list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
    if args.vararg:
        out.append(args.vararg)
    if args.kwarg:
        out.append(args.kwarg)
    return out


def inst_calls_in(node):
    # Mirrors pin_calls_in's traversal shape, but captures the receiver'd `.method(` calls pin_calls_in
    # deliberately excludes — SAFELY, because these are resolved by TYPE (ctor), never by bare name.
    # Returns [(kind, ctor_or_receiver_name, method)] — kind is 'inline' (`X().m()`, ast shape
    # Call(func=Attribute(attr=m, value=Call(func=Name X)))) or 'variable' (`c.m()`, ast shape
    # Call(func=Attribute(attr=m, value=Name c))). Neither branch resolves anything (that's
    # receiver_binding / resolvePyClassMember's job) — this only recognizes the two shapes.
    #
    # Chain/builder refusal (`X().m().n()`, `X().build().m()`): a Call matching either shape whose OWN
    # PARENT node is itself an ast.Attribute (i.e. some outer expression accesses a member on THIS call's
    # result) is skipped outright — plan §5.1's chain row. This closes both halves without a special case:
    # `m` in `X().m().n()` is excluded here (its parent is the Attribute for `.n`); `n` is never even
    # SHAPE-matched (its receiver is `X().m()`, a Call whose func is an Attribute, not a direct `Call(func=
    # Name X))` or bare Name — the shape check below requires an IMMEDIATE ctor/variable receiver, exactly
    # the JS/JVM scanners' "only pairs a method with an immediately preceding ctor" discipline). Applied to
    # BOTH kinds uniformly (JVM/JS only special-case the inline ctor chain) — strictly safer, never an
    # over-credit: at worst this refuses a variable-chain shape (`c.m().n()`) plan §5.1 never rules on.
    out = []
    for n in ast.walk(node):
        if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)):
            continue
        if isinstance(getattr(n, 'parent', None), ast.Attribute):
            continue  # this call's result is itself member-accessed — chained/builder, refuse
        method = n.func.attr
        recv = n.func.value
        if isinstance(recv, ast.Call) and isinstance(recv.func, ast.Name):
            out.append(('inline', recv.func.id, method))
        elif isinstance(recv, ast.Name):
            out.append(('variable', recv.id, method))
    return out


def add_parents(tree):
    # ast gives no parent pointers; inst_calls_in's chain-refusal needs one. Set once, whole-module, before
    # any block processing (mirrors inferReceiverTypeFromCtor's own whole-file-first discipline).
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child.parent = node


def file_mock_taint(tree):
    # File-wide taint gate (mirrors prove.mjs's JS MOCK_TAINT): unittest.mock/mock/pytest_mock imported
    # ANYWHERE, a monkeypatch/mocker fixture parameter on ANY function (not just the credited block's own —
    # a shared fixture in another test can still be the mechanism), or an `@patch` decorator ANYWHERE.
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            if any(a.name in MOCK_MODULES for a in n.names):
                return True
        elif isinstance(n, ast.ImportFrom):
            mod = n.module or ''
            if mod in MOCK_MODULES:
                return True
            if mod == 'unittest' and any(a.name == 'mock' for a in n.names):
                return True
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(a.arg in MOCK_FIXTURE_PARAMS for a in _fn_arg_names(n)):
                return True
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for d in n.decorator_list:
                target = d.func if isinstance(d, ast.Call) else d
                name = target.id if isinstance(target, ast.Name) else (target.attr if isinstance(target, ast.Attribute) else None)
                if name == 'patch':
                    return True
    return False


def module_bound_names_excluding_import(tree):
    # Every name bound ANYWHERE in the module by any construct EXCEPT an Import/ImportFrom statement
    # (imports are the one binding form the §8.1 shadow guard, below, must ALLOW). Deliberately whole-tree
    # (not scoped to module-top-level statements) and deliberately including function/lambda parameters and
    # nested def/class names: Python has no block scoping to exploit for a tighter check, and the shadow
    # this guards against (`def test(): class Calc: ...` re-declaring the imported name in an inner scope)
    # is itself a nested binding — narrowing this to "module-level only" would miss exactly the case §8.1
    # exists for. Over-collecting here can only REFUSE a credit that would have been safe (a reach loss,
    # never a wrong one) — see jsCreditTypeMethod's own §8.1 comment in prove.mjs for the identical
    # JS-side discipline and its confirmed false-HOLLOW repro.
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            names |= {a.arg for a in _fn_arg_names(n)}
        if isinstance(n, ast.Assign):
            for t in n.targets:
                names |= _target_names(t)
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            names.add(n.target.id)
        elif isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name):
            names.add(n.target.id)
        elif isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name):
            names.add(n.target.id)
        elif isinstance(n, (ast.For, ast.AsyncFor)):
            names |= _target_names(n.target)
        elif isinstance(n, ast.comprehension):
            names |= _target_names(n.target)
        elif isinstance(n, ast.withitem) and n.optional_vars is not None:
            names |= _target_names(n.optional_vars)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            names.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            names |= set(n.names)
    return names


def receiver_binding(tree, name):
    # Return the single ctor X iff EVERY binding occurrence of `name` anywhere in the module (Python has no
    # block scoping to narrow this to "this test only" — same whole-module discipline as the rebind check
    # above) is a plain single-target `name = X()` call (the SAME X throughout — two DIFFERENT ctor types
    # is a genuine reassignment-to-unrelated-type ambiguity, refused; the SAME ctor twice is safe, mirrors
    # inferReceiverTypeFromCtor's own "two-ctor-types" — not "any reassignment" — failure mode), and no
    # `name.attr = ...` / `setattr(name, ...)` appears anywhere. Any parameter, for/with/comprehension/
    # except/tuple-or-multi-target-assign/AugAssign/walrus/global/nonlocal binding of `name` refuses
    # outright (plan §3). Returns None (refuse) when `name` is never actually bound this way anywhere
    # (e.g. a pytest fixture parameter — injected, never assigned in this module at all).
    ctor = None
    bound = False
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign):
            names_here = set()
            for t in n.targets:
                names_here |= _target_names(t)
                if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == name:
                    return None  # `name.attr = ...` taint
            if name in names_here:
                if len(n.targets) != 1:
                    return None  # multi-target assign (`a = name = X()`)
                t = n.targets[0]
                if not (isinstance(t, ast.Name) and t.id == name):
                    return None  # tuple/list/starred unpack target
                if not (isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name)):
                    return None  # non-ctor RHS (factory attribute call, literal, ...)
                this_ctor = n.value.func.id
                if ctor is not None and this_ctor != ctor:
                    return None  # reassigned to a DIFFERENT ctor type
                ctor = this_ctor
                bound = True
        elif isinstance(n, ast.AnnAssign):
            if isinstance(n.target, ast.Name) and n.target.id == name:
                return None
        elif isinstance(n, ast.AugAssign):
            if isinstance(n.target, ast.Name) and n.target.id == name:
                return None
        elif isinstance(n, ast.NamedExpr):
            if isinstance(n.target, ast.Name) and n.target.id == name:
                return None
        elif isinstance(n, (ast.For, ast.AsyncFor)):
            if name in _target_names(n.target):
                return None
        elif isinstance(n, ast.comprehension):
            if name in _target_names(n.target):
                return None
        elif isinstance(n, ast.withitem):
            if n.optional_vars is not None and name in _target_names(n.optional_vars):
                return None
        elif isinstance(n, ast.ExceptHandler):
            if n.name == name:
                return None
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            if any(a.arg == name for a in _fn_arg_names(n)):
                return None
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            if name in n.names:
                return None
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'setattr':
            if n.args and isinstance(n.args[0], ast.Name) and n.args[0].id == name:
                return None  # setattr(name, ...) taint
    return ctor if bound else None


def main(path):
    tree = ast.parse(open(path).read())
    add_parents(tree)
    mock_taint = file_mock_taint(tree)
    rebound = module_bound_names_excluding_import(tree)
    recv_cache = {}

    def resolved_receiver(name):
        if name not in recv_cache:
            recv_cache[name] = receiver_binding(tree, name)
        return recv_cache[name]

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
        raw_insts = []
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and callee(n) in PIN:
                for a in n.args:
                    pins += pin_calls_in(a)
                    raw_insts += inst_calls_in(a)
            # bare `assert a == b` (or chained `a == b == c`): equality only — never `<`, `>`, `!=`, `is`, `in`.
            if isinstance(n, ast.Assert) and isinstance(n.test, ast.Compare) \
                    and n.test.ops and all(isinstance(op, ast.Eq) for op in n.test.ops):
                pins += pin_calls_in(n.test.left)
                raw_insts += inst_calls_in(n.test.left)
                for c in n.test.comparators:
                    pins += pin_calls_in(c)
                    raw_insts += inst_calls_in(c)

        inst_set = set()
        if not mock_taint:
            for kind, a, method in raw_insts:
                ctor = a if kind == 'inline' else resolved_receiver(a)
                if not ctor or ctor in rebound:
                    continue
                inst_set.add((ctor, method))

        blocks.append({
            'name': fn.name,
            'line': fn.lineno,
            'endline': getattr(fn, 'end_lineno', fn.lineno),
            'calls': sorted(set(calls_in(fn))),
            'pins': sorted(set(pins)),
            'inst': [{'ctor': c, 'method': m} for c, m in sorted(inst_set)],
        })

    print(json.dumps({'imports': imports, 'blocks': blocks}))


def member_ok(path, cls, method):
    # `--member` mode (§6.2): the SUT-side ast validation resolvePyClassMember (prove.mjs) drives. Every
    # branch below is a refusal; the only success path is falling through to the final `return True`.
    try:
        tree = ast.parse(open(path).read())
    except Exception:
        return False
    module_body = tree.body
    class_defs = [n for n in module_body if isinstance(n, ast.ClassDef) and n.name == cls]
    if len(class_defs) != 1:
        return False  # 0: not a class here (or a `def cls(...)` factory); >=2: ambiguous redefinition
    target = class_defs[0]
    if target.decorator_list or target.keywords:
        return False  # decorated (@dataclass, ...) or has a metaclass= keyword — a decorator/metaclass
        # can replace/wrap members, so credit would risk gutting a declaration that never actually runs.
    # no other module-level binding of `cls` anywhere in the module (besides this one ClassDef) — a def/
    # class/assignment/import that also binds `cls` means the name is ambiguous or gets rebound at import
    # time (mirrors resolvePySut's own class+def collision guard, §8.2).
    for n in ast.walk(tree):
        if n is target:
            continue
        if isinstance(n, ast.ClassDef) and n.name == cls:
            return False
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == cls:
            return False
        if isinstance(n, ast.Assign):
            names = set()
            for t in n.targets:
                names |= _target_names(t)
            if cls in names:
                return False
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id == cls:
            return False
        if isinstance(n, ast.Import):
            if any((a.asname or a.name.split('.')[0]) == cls for a in n.names):
                return False
        if isinstance(n, ast.ImportFrom):
            if any((a.asname or a.name) == cls for a in n.names):
                return False
    # exactly one non-async, undecorated `def method` directly in the class's OWN body, first param
    # literally `self` (inherited-only members refuse: they simply never appear in `target.body`).
    m_defs = [n for n in target.body if isinstance(n, ast.FunctionDef) and n.name == method]
    if len(m_defs) != 1:
        return False
    mdef = m_defs[0]
    if mdef.decorator_list:
        return False  # @staticmethod/@classmethod/@property/anything — dispatch is no longer the plain instance member
    allargs = list(mdef.args.posonlyargs) + list(mdef.args.args)
    if not allargs or allargs[0].arg != 'self':
        return False
    # no other `def method` (sync or async) ANYWHERE in the module — a module-level free function or a
    # method on an unrelated class sharing the name means gut-time's regex-based site count (>1) would
    # ALSO refuse (pyDeclSiteCount, checked separately by the caller) but this ast check is the precise,
    # unambiguous version of the same rule.
    for n in ast.walk(tree):
        if n is mdef:
            continue
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == method:
            return False
    return True


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == '--member':
        try:
            ok = member_ok(sys.argv[2], sys.argv[3], sys.argv[4])
        except Exception:
            ok = False
        print(json.dumps({'ok': ok}))
    else:
        main(sys.argv[1])
