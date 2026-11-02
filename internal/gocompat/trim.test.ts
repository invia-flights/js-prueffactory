import assert from "node:assert/strict";
import { test } from "node:test";

import { trim, trimLeft, trimRight } from "./strings.ts";

test("trimRight, trimLeft and trim remove the characters of the cutset at the ends", () => {
  assert.equal(trimRight("abc\r\r\r", "\r"), "abc");
  assert.equal(trimRight("a\r\rb\r", "\r"), "a\r\rb");
  assert.equal(trimRight("0.5000", "0"), "0.5");
  assert.equal(trimRight("000", "0"), "");
  assert.equal(trimRight("", "0"), "");
  assert.equal(trimRight("x \t\r", " \t\r"), "x");
  assert.equal(trimLeft("//a//", "/"), "a//");
  assert.equal(trim("//a//", "/"), "a");
  assert.equal(trim("'\"x\"'", "\"'"), "x");
  assert.equal(trim("///", "/"), "");
  assert.equal(trim("a", "/"), "a");
});

test("they take linear time on a long run that is not at the end", () => {
  // /\r+$/ over this text takes quadratic time in a backtracking engine.
  const text = "\r".repeat(2_000_000) + "a";
  const start = Date.now();
  assert.equal(trimRight(text, "\r"), text);
  assert.equal(
    trimLeft("a" + "/".repeat(2_000_000) + "a", "/").length,
    2_000_002,
  );
  assert.ok(Date.now() - start < 2000, "slow");
});
