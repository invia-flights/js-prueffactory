// The expected outputs are what `diff -u --label go --label ts` prints for the
// same inputs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { unifiedDiff } from "./diff.ts";

function diff(go: string, ts: string): string {
  return unifiedDiff("go", "ts", Buffer.from(go), Buffer.from(ts));
}

test("equal inputs give no diff", () => {
  assert.equal(diff("a\nb\n", "a\nb\n"), "");
});

test("distant changes give two hunks; a missing last newline is marked", () => {
  assert.equal(
    diff(
      "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n",
      "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn",
    ),
    `--- go
+++ ts
@@ -1,5 +1,5 @@
 a
-b
+B
 c
 d
 e
@@ -11,3 +11,4 @@
 k
 l
 m
+n
\\ No newline at end of file
`,
  );
});

test("changes six lines apart share one hunk", () => {
  assert.equal(
    diff("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nX\nc\nd\ne\nf\ng\nY\n"),
    `--- go
+++ ts
@@ -1,8 +1,8 @@
 a
-b
+X
 c
 d
 e
 f
 g
-h
+Y
`,
  );
});

test("an empty side names line 0", () => {
  assert.equal(diff("one\n", ""), "--- go\n+++ ts\n@@ -1 +0,0 @@\n-one\n");
});

test("content that is not UTF-8 text is compared by hash", () => {
  const got = unifiedDiff(
    "go",
    "ts",
    Buffer.from([0xff, 0x00]),
    Buffer.from([0xfe]),
  );
  assert.match(
    got,
    /^Binary files go \(SHA-256 [0-9a-f]{64}\) and ts \(SHA-256 [0-9a-f]{64}\) differ\n$/,
  );
});
