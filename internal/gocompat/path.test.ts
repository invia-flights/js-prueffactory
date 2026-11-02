import assert from "node:assert/strict";
import { test } from "node:test";

import { base, clean, dir, join, match } from "./path.ts";

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

test("match is Go's path.Match", () => {
  assert.equal(match("abc", "abc"), true);
  assert.equal(match("a*", "ab/c"), false);
  assert.equal(match("a*/b", "abc/b"), true);
  assert.equal(match("a[^a-c]*", "ad"), true);
  assert.equal(match("[\\]a]", "]"), true);
  assert.equal(match("a?b", "a\u00e9b"), true);
  assert.equal(match("*x", "xxx"), true);
  // ErrBadPattern
  assert.equal(match("[", "a"), undefined);
  assert.equal(match("a\\", "a"), undefined);
});

test("join, dir and base are Go's path functions", () => {
  assert.equal(join("a", "", "b/../c"), "a/c");
  assert.equal(join(), "");
  assert.equal(dir("/a/b"), "/a");
  assert.equal(dir("a"), ".");
  assert.equal(base("/a/b/"), "b");
  assert.equal(base(""), ".");
  assert.equal(base("///"), "/");
});
