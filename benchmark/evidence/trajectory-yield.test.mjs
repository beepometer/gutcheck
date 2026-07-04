import { test } from 'node:test';
import assert from 'node:assert';
import { testFilesInPatch } from './trajectory-yield.mjs';

const MIXED_PATCH = `diff --git a/tests/test_foo.py b/tests/test_foo.py
index e69de29..4b825dc 100644
--- a/tests/test_foo.py
+++ b/tests/test_foo.py
@@ -0,0 +1,2 @@
+def test_foo():
+    assert True
diff --git a/src/bar.py b/src/bar.py
index e69de29..4b825dc 100644
--- a/src/bar.py
+++ b/src/bar.py
@@ -0,0 +1,2 @@
+def bar():
+    pass
`;

// A deleted test file's new-path header is `+++ /dev/null` — there is no b/<path> to extract, so
// it must never surface (and must never crash the parse of the rest of the patch).
const DEV_NULL_PATCH = `diff --git a/tests/test_old.py b/tests/test_old.py
deleted file mode 100644
index 4b825dc..0000000
--- a/tests/test_old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def test_old():
-    pass
diff --git a/src/baz.py b/src/baz.py
index e69de29..4b825dc 100644
--- a/src/baz.py
+++ b/src/baz.py
@@ -0,0 +1,1 @@
+def baz(): pass
`;

test('testFilesInPatch: a patch touching one test file and one source file returns exactly the test path', () => {
  assert.deepEqual(testFilesInPatch(MIXED_PATCH), ['tests/test_foo.py']);
});

test('testFilesInPatch: a deleted test file (+++ /dev/null new-file header) is not returned, and does not break parsing of the rest of the patch', () => {
  assert.deepEqual(testFilesInPatch(DEV_NULL_PATCH), []);
});

test('testFilesInPatch: an empty patch returns an empty array', () => {
  assert.deepEqual(testFilesInPatch(''), []);
});

test('testFilesInPatch: a nullish patch returns an empty array rather than throwing', () => {
  assert.deepEqual(testFilesInPatch(null), []);
  assert.deepEqual(testFilesInPatch(undefined), []);
});
