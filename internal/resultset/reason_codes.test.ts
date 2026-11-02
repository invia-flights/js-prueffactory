import assert from "node:assert/strict";
import { test } from "node:test";

import { reasonCodes } from "./reason_codes.ts";

test("the reason codes are lower-case snake_case words, once each, in order", () => {
  for (const code of reasonCodes) {
    assert.match(code, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, code);
  }
  assert.equal(new Set(reasonCodes).size, reasonCodes.length, "a duplicate");
  assert.deepEqual([...reasonCodes], [...reasonCodes].sort());
});
