import assert from "node:assert/strict";
import { test } from "node:test";

import { quote } from "./quote.ts";

// Expected values are what Go's strconv.Quote (fmt's %q) prints.
test("quote escapes like Go's %q and keeps printable non-ASCII", () => {
  const cases: [string, string][] = [
    ["", `""`],
    ["plain", `"plain"`],
    [`a"b\\c`, `"a\\"b\\\\c"`],
    ["\x07\b\f\n\r\t\v", `"\\a\\b\\f\\n\\r\\t\\v"`],
    ["\x00\x1f\x7f", `"\\x00\\x1f\\x7f"`],
    ["äöü €", `"äöü €"`],
    [" ", `"\\u00a0"`],
    ["​", `"\\u200b"`],
    ["\u{1F600}", `"😀"`],
    ["\u{E0001}", `"\\U000e0001"`],
    ["\ud800", `"\\ufffd"`],
    ["/Users/me/project", `"/Users/me/project"`],
    ["A=B --privileged", `"A=B --privileged"`],
  ];
  for (const [input, want] of cases) {
    assert.equal(quote(input), want, JSON.stringify(input));
  }
});
