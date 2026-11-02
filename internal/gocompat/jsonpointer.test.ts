import assert from "node:assert/strict";
import { test } from "node:test";

import { unescapePointerToken } from "./jsonpointer.ts";

test("a pointer token is unescaped as RFC 6901 says", () => {
  assert.equal(unescapePointerToken("a~1b"), "a/b");
  assert.equal(unescapePointerToken("m~0n"), "m~n");
  assert.equal(unescapePointerToken("~01"), "~1", "~0 is undone after ~1");
  assert.equal(unescapePointerToken("plain"), "plain");
});
