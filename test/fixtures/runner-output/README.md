# Recorded runner output fixtures

Real TAP output captured from a run of 2 passing + 1 failing test, used to pin `parseRun`.

- `mocha-2pass-1fail.txt` — captured via `npx mocha --reporter tap t.test.js` (mocha installed in a
  throwaway temp project, not a repo dependency) — expected `parseRun` → `{passed: 2, failed: 1}`.
  Summary lines: `# tests 3`, `# pass 2`, `# fail 1` (node-compatible format).
- `ava-2pass-1fail.txt` — captured via `npx ava --tap t.test.js` (ava installed in a throwaway
  temp project with `type: module`, not a repo dependency) — expected `parseRun` →
  `{passed: 2, failed: 1}`. Summary lines: `# tests 3`, `# pass 2`, `# fail 1` (node-compatible format).

Both fixtures were captured from this test source (adjusted per runner's `describe`/`test` API):

```js
// one -> passes, two -> passes, three -> fails
it/test('one',   () => assert/t.is(1, 1));
it/test('two',   () => assert/t.is(2, 2));
it/test('three', () => assert/t.is(1, 2));
```

Neither mocha nor ava is a dependency of this repo — they were installed only in `mktemp -d`
throwaway projects outside the repo tree to produce these fixtures.

- `node-zero-match.txt` — captured via `node --test --test-name-pattern '^phantom title$'
  f.test.mjs` (node v22.22.2) against a fixture file containing one real test titled `'real
  title'`. The pattern matches nothing, but the run still exits 0 and reports `# pass 1`: the TAP
  plan line `1..0` (zero subtests scheduled) proves no test ran — the single `ok 1 - f.test.mjs`
  point is node's own file-wrapper subtest, named after the file argument, not any test in it.
  Used to pin `nodeEffectiveCounts`'s wrapper-only discount.
- `node-one-match.txt` — same fixture file, captured via `node --test --test-name-pattern '^real
  title$' f.test.mjs` (node v22.22.2). The pattern matches the real test: `ok 1 - real title`,
  `# pass 1`, plan line `1..1` (one subtest scheduled). Used to confirm `nodeEffectiveCounts` does
  NOT discount a genuine single-test pass.
- `maven-compile-fail.txt` — captured via `mvn -o test -Dtest=demo.CalcTest#clampCeiling
  -Dsurefire.failIfNoSpecifiedTests=false` (Apache Maven 3.9.6, JDK 17) against a two-method
  JUnit 5 fixture (`demo.Calc`/`demo.CalcTest`, not a repo dependency — a throwaway Maven project
  outside the repo tree) after `clampScore`'s body was mutated to `return "not-an-int";` (a genuine
  type error). Prints `[ERROR] COMPILATION ERROR :` and `BUILD FAILURE`; no surefire XML is written.
  Used to pin the maven runner's compiled-detection to `false`.
- `maven-test-fail.txt` — same fixture and command, `-Dtest=demo.CalcTest#addsTwoNumbers`, after
  `add`'s body was mutated to `return 987654321;` (type-compatible — compiles fine, fails the
  pinned assertion). Prints `Tests run: 1, Failures: 1, …` and `BUILD FAILURE`, but never
  `COMPILATION ERROR`. Used to pin the maven runner's compiled-detection to `true` on a genuine test
  failure — the false-verdict guard this whole classification exists for (a `BUILD FAILURE` string
  match alone can't distinguish the two cases; both print it).
