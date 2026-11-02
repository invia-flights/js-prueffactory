import assert from "node:assert/strict";
import { test } from "node:test";

import { clean } from "./path.ts";

// The examples of Go's path.Clean documentation, and a few more edges.
test("clean is Go's path.Clean", () => {
  const cases: [string, string][] = [
    ["a/c", "a/c"],
    ["a//c", "a/c"],
    ["a/c/.", "a/c"],
    ["a/c/b/..", "a/c"],
    ["/../a/c", "/a/c"],
    ["/../a/b/../././/c", "/a/c"],
    ["", "."],
    [".", "."],
    ["./", "."],
    ["/", "/"],
    ["//", "/"],
    ["..", ".."],
    ["../..", "../.."],
    ["a/../..", ".."],
    ["../a/../b", "../b"],
    ["artifacts/", "artifacts"],
    ["./artifacts/x.txt", "artifacts/x.txt"],
    ["artifacts/evidence/x.txt", "artifacts/evidence/x.txt"],
  ];
  for (const [input, want] of cases) {
    assert.equal(clean(input), want, `clean(${JSON.stringify(input)})`);
  }
});
