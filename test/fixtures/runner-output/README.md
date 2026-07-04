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
