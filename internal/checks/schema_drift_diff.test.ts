// The unified diff of schema.drift (Go: schema_drift_diff_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { unifiedDiff } from "./schema_drift_diff.ts";

test("a unified diff shows changes with three lines of context and splits far-apart hunks", () => {
  const old: string[] = [];
  for (let i = 1; i <= 20; i++) {
    old.push(`line ${String.fromCharCode(0x61 + i - 1)}\n`);
  }
  const now = [...old];
  now[1] = "line B\n"; // line 2 changes
  now.splice(16, 0, "inserted\n"); // a line goes in after line 16
  now.splice(19, 1); // old line 19 goes

  const got = unifiedDiff("a/f.txt", "b/f.txt", old.join(""), now.join(""));

  assert.equal(
    got,
    `--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,5 @@
 line a
-line b
+line B
 line c
 line d
 line e
@@ -14,7 +14,7 @@
 line n
 line o
 line p
+inserted
 line q
 line r
-line s
 line t
`,
  );
});

test("the unified diff of equal texts is empty", () => {
  assert.equal(unifiedDiff("a", "b", "x\ny\n", "x\ny\n"), "");
});

test("the unified diff marks a missing final line feed", () => {
  assert.equal(
    unifiedDiff("a", "b", "x\ny", "x\ny\n"),
    "--- a\n+++ b\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+y\n",
  );
});

test("the unified diff of an empty and a filled text is one hunk", () => {
  assert.equal(
    unifiedDiff("a", "b", "", "x\ny\n"),
    "--- a\n+++ b\n@@ -0,0 +1,2 @@\n+x\n+y\n",
  );
});

test("the unified diff of texts far apart in edits still replaces and never loses a line", () => {
  let old = "";
  let now = "";
  for (let i = 0; i < 3000; i++) {
    old += "old " + "a".repeat(i % 7) + "\n";
    now += "new " + "b".repeat(i % 5) + "\n";
  }
  const got = unifiedDiff("a", "b", old, now);
  assert.equal(got.split("\n-old").length - 1, 3000);
  assert.equal(got.split("\n+new").length - 1, 3000);
});
