import assert from "node:assert/strict";
import { test } from "node:test";

import { errorMessage } from "./errors.ts";

test("errorMessage is the message of an Error and the text of anything else", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage(new RangeError("out")), "out");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
});
