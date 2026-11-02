import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  compareBytes,
  cutUTF8,
  fields,
  isControl,
  isPrint,
  isSpace,
  sortStrings,
  trimSpace,
  utf8Length,
} from "./strings.ts";

// What the Go standard library computes for the same inputs (see recordedFrom).
const oracle = JSON.parse(
  readFileSync(new URL("testdata/go-oracle.json", import.meta.url), "utf8"),
) as {
  classes: { CP: number; Space: boolean; Control: boolean; Print: boolean }[];
  fields: { In: string; Fields: string[]; TrimSpace: string }[];
  sortedStrings: string[];
};

describe("byte-wise string order", () => {
  test("sorts like Go's sort.Strings, also outside the Basic Multilingual Plane", () => {
    const shuffled = [...oracle.sortedStrings].reverse();
    assert.deepEqual(sortStrings(shuffled), oracle.sortedStrings);
  });

  test("puts U+1F600 after U+E000, where JavaScript's default order puts it before", () => {
    const emoji = "\u{1F600}";
    const privateUse = "\uE000";
    assert.ok(
      [emoji, privateUse].sort()[0] === emoji,
      "JavaScript's own order",
    );
    assert.ok(compareBytes(privateUse, emoji) < 0);
    assert.ok(compareBytes(emoji, privateUse) > 0);
    assert.equal(compareBytes("abc", "abc"), 0);
    assert.ok(compareBytes("ab", "abc") < 0);
    assert.ok(compareBytes("abc", "ab") > 0);
  });

  test("counts a lone surrogate as the U+FFFD it is written as", () => {
    assert.equal(compareBytes("\uD800", "\uFFFD"), 0);
    assert.equal(utf8Length("\uD800"), 3);
  });
});

describe("UTF-8 lengths and cuts", () => {
  test("measures bytes, not UTF-16 units", () => {
    assert.equal(utf8Length(""), 0);
    assert.equal(utf8Length("a\u00E9\u20AC\u{1F600}"), 1 + 2 + 3 + 4);
  });

  test("cuts at the last character boundary at or before the limit", () => {
    const euro = "\u20AC"; // 3 bytes
    assert.equal(cutUTF8("ab" + euro, 4), "ab");
    assert.equal(cutUTF8("ab" + euro, 5), "ab" + euro);
    assert.equal(cutUTF8("\u{1F600}\u{1F600}", 7), "\u{1F600}");
    assert.equal(cutUTF8("abc", 3), "abc");
    assert.equal(cutUTF8("abc", 0), "");
  });
});

describe("Go's character classes", () => {
  for (const c of oracle.classes) {
    test(`U+${c.CP.toString(16).toUpperCase().padStart(4, "0")}`, () => {
      assert.equal(isSpace(c.CP), c.Space, "unicode.IsSpace");
      assert.equal(isControl(c.CP), c.Control, "unicode.IsControl");
      assert.equal(isPrint(c.CP), c.Print, "strconv.IsPrint");
    });
  }

  for (const c of oracle.fields) {
    test(`strings.Fields and strings.TrimSpace of ${JSON.stringify(c.In)}`, () => {
      assert.deepEqual(fields(c.In), c.Fields);
      assert.equal(trimSpace(c.In), c.TrimSpace);
    });
  }
});
