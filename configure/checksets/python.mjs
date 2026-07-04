// Python (pytest / unittest) source-discipline check set. The kinds (shadowOracleGuard /
// magicLiteralGuard / testShapeGuard) are already language-parameterized — only the assertion grammar
// differs — so this is pure config + self-test fixtures, no engine change. Each check carries its own
// must-flag / must-not-flag fixtures so the meta-guard proves the regexes still discriminate before any
// scan runs. Emitted for a python/pytest project alongside the three language-agnostic checks.
export const checks = [
  {
    id: 'py-test-shape-guards',
    kind: 'testShapeGuard',
    description: 'Python test source carries no length-tautology assertion (len(...) >= 0), no real-time time.sleep, and any skip carries a real reason — comment-stripped, # SHAPE-OK: opt-out respected',
    params: {
      lang: 'python',
      rules: [
        { id: 'py-tautology-len-ge-0',
          patternSrc: 'assert\\s+len\\([^)]*\\)\\s*>=\\s*0\\b|assertGreaterEqual\\(\\s*len\\([^)]*\\)\\s*,\\s*0\\b',
          exemptSrc: '# SHAPE-OK:', blankStrings: true },
        // Only time.sleep(): a real-time delay is a genuine flake/slowness smell wherever it appears.
        // datetime.now() and random.*() were dropped — real-repo finding (sortedcontainers/pyparsing)
        // showed they are overwhelmingly used to BUILD test input data, not as asserted oracles, so they
        // were ~all false positives / data-generation noise (60+ flags across the corpus).
        { id: 'py-time-leak',
          patternSrc: '\\btime\\.sleep\\(',
          exemptSrc: '# SHAPE-OK:', blankStrings: true },
      ],
      ignoreRule: {
        // skip-family only — a silently SKIPPED test hiding why is worth a nudge. xfail is dropped:
        // a bare @pytest.mark.xfail ("expected to fail") is idiomatic and the test name explains it,
        // and requiring a reason on every xfail floods (dateutil: 13 known-ambiguous-parse cases).
        annotations: ['@pytest.mark.skip', '@unittest.skip'],
        // Match ANY quoted string; the engine takes the LONGEST in the window as the reason. This
        // accepts a positional reason (skip("...")) and a reason= kwarg uniformly, and a short quoted
        // string in a skipif CONDITION (version < "2.7.1") cannot satisfy it — the real reason is long.
        annotationRegex: '[\'"]([^\'"]*)[\'"]',
        minReasonLen: 12,
        windowLines: 3,
      },
    },
    selfTest: {
      mustFlag: [
        'def test_rows():\n    assert len(rows) >= 0',
        'import time\ndef test_wait():\n    time.sleep(2)\n    assert ok',
        "@pytest.mark.skip(reason='wip')\ndef test_x():\n    assert run()",
        "@pytest.mark.skipif(sys.platform == 'win32', reason='wip')\ndef test_z():\n    assert run()",
        "@unittest.skip('wip')\ndef test_q():\n    pass",
      ],
      mustNotFlag: [
        'def test_rows():\n    assert len(rows) == 3',
        "@pytest.mark.skip(reason='blocked on upstream parser bug, see issue 4521')\ndef test_y():\n    pass",
        'assert len(items) >= 0  # SHAPE-OK: deliberate liveness probe',
        "@pytest.mark.skipif(dateutil_version < '2.7.1', reason='old tz database, 2018d needed')\ndef test_w():\n    pass",
        "@unittest.skip('blocked on upstream parser bug, see issue 4521')\ndef test_p():\n    pass",
        'data = {"ts": datetime.now()}\nassert load(data) == data',
        'from freezegun import freeze_time\n@freeze_time("2020-01-01")\ndef test_now():\n    assert clock() == datetime.now()',
      ],
    },
  },
  {
    id: 'py-magic-literal-guard',
    kind: 'magicLiteralGuard',
    description: 'an uncited expected-value float in a Python assertion (== with >=3 fractional digits / pytest.approx / assertAlmostEqual) must carry an inline derivation, a URL, or a # CLOSED-FORM-ORACLE: marker. Short decimals (version numbers like 1.0, 2.5) and numbers inside string literals are not flagged',
    params: {
      lang: 'python',
      assertionSrcs: [
        '==\\s*(-?\\d+\\.\\d{3,})\\b',
        '\\bapprox\\(\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b',
        '\\bassertAlmostEqual\\(\\s*[^,]+,\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
        '\\bassertEqual\\(\\s*[^,]+,\\s*(-?\\d+\\.\\d{3,})',
      ],
      derivationSrc: '#.*(?:https?://|[0-9].*[-+*/^].*[0-9]|=\\s*[-+(]?\\s*[0-9])',
      markers: ['# CLOSED-FORM-ORACLE:'],
    },
    selfTest: {
      mustFlag: [
        'assert price == 19.995',
        'assert rate == pytest.approx(0.0825)',
      ],
      mustNotFlag: [
        '# 1000 * 1.05 ** 2 = 1102.50\nassert fv == pytest.approx(1102.50)',
        '# CLOSED-FORM-ORACLE: derived from the spec table below\nassert x == 3.14159',
        'assert count == 1',
        'assert version == 1.5',
        'spec = Specifier("===1.0")',
      ],
    },
  },
  {
    id: 'py-shadow-oracle-guard',
    kind: 'shadowOracleGuard',
    description: 'a Python expected-value assertion (== / pytest.approx / assertEqual / assertAlmostEqual) must not take its expected value from a LOCALLY-DEFINED helper that re-derives a NUMERIC production value; an imported (independent) oracle, a fixture-builder/formatter that returns a dict/list/object, and a # INDEPENDENT-ORACLE: / # SHADOW-OK: marker are all exempt',
    params: {
      lang: 'python',
      defSrcs: ['def\\s+([A-Za-z_]\\w*)\\s*\\(', '([A-Za-z_]\\w*)\\s*=\\s*lambda\\b'],
      assertionSrcs: [
        '==\\s*([A-Za-z_]\\w*)\\s*\\(',
        '\\bapprox\\(\\s*([A-Za-z_]\\w*)\\s*\\(',
        '\\bassertEqual\\(\\s*[^,]+,\\s*([A-Za-z_]\\w*)\\s*\\(',
        '\\bassertAlmostEqual\\(\\s*[^,]+,\\s*([A-Za-z_]\\w*)\\s*\\(',
      ],
      varAssignSrcs: ['(?:^|;)\\s*([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)\\s*\\('],
      varAssertionSrcs: [
        '==\\s*([A-Za-z_]\\w*)\\b(?!\\s*[.\\(])',
        '\\bapprox\\(\\s*([A-Za-z_]\\w*)\\s*\\)',
        '\\bassertEqual\\(\\s*[^,]+,\\s*([A-Za-z_]\\w*)\\s*\\)',
        '\\bassertAlmostEqual\\(\\s*[^,]+,\\s*([A-Za-z_]\\w*)\\s*[,)]',
      ],
      markers: ['# INDEPENDENT-ORACLE:', '# SHADOW-OK:'],
    },
    selfTest: {
      mustFlag: [
        'def shadow():\n    return 142.50\nassert total == shadow()',
        'def recompute():\n    return 5\nassert out == pytest.approx(recompute())',
        'def recompute():\n    return 5\ne = recompute()\nassert out == e',
      ],
      mustNotFlag: [
        'assert area == pytest.approx(78.54)',
        'def indep():\n    return 142.50\n# INDEPENDENT-ORACLE: cross-checked vs the spec table\nassert total == indep()',
        'assert total == reference_total()',
        'e = reference_total()\nassert out == e',
        'def make_item():\n    return {"value": 3}\n\ndef test_x():\n    assert load(dump(make_item())) == make_item()',
        'def url_to_origin(u):\n    return URL(u)\n\ndef test_y():\n    assert pool.url == url_to_origin(expected)',
        'def f(x, y):\n    return x + y\n\nmf = memoize(f)\nassert mf(1, 2) == f(1, 2)',
      ],
    },
  },
  {
    id: 'py-derivation-coherence',
    kind: 'derivationCoherence',
    description: 'an inline # arithmetic derivation must actually compute the asserted value; a mismatch (derivation says X, assertion expects Y) is a real bug. Deterministically evaluated; variables/units are skipped',
    params: {
      lang: 'python',
      assertionSrcs: ['==\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)', '\\bapprox\\(\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)', '\\bassertAlmostEqual\\(\\s*[^,]+,\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)'],
    },
    selfTest: {
      mustFlag: [
        'assert area == 80.0  # 3.14159 * 5 * 5 = 78.54',
      ],
      mustNotFlag: [
        'assert area == pytest.approx(78.54)  # 3.14159 * 5 * 5 = 78.54',
        'assert x == 3.5  # rate * count, see spec',
        'assert n == 42',
      ],
    },
  },
  {
    id: 'py-assertion-consistency',
    kind: 'assertionConsistency',
    description: 'the same pure call asserted to two DIFFERENT literal values in one file is a contradiction — one test is wrong. Deterministic; calls with variable args are skipped',
    params: {
      lang: 'python',
      assertionSrcs: ['assert\\s+([A-Za-z_][\\w.]*\\([^()]*\\))\\s*==\\s*([^\\s#]+)', 'assertEqual\\(\\s*([^,]+),\\s*([A-Za-z_][\\w.]*\\([^()]*\\))'],
    },
    selfTest: {
      mustFlag: ['assert factorial(5) == 120\nassert factorial(5) == 121'],
      mustNotFlag: ['assert factorial(5) == 120\nassert factorial(5) == 120.0', 'assert factorial(5) == 120\nassert factorial(6) == 720', 'assert factorial(n) == 120\nassert factorial(n) == 121'],
    },
  },
];
