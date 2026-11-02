import assert from "node:assert/strict";
import { test } from "node:test";

import { quoteMeta } from "./regexp.ts";

test("quoteMeta escapes exactly what Go's regexp.QuoteMeta escapes", () => {
  // Go: regexp.QuoteMeta(`--require evil a.b (1+1) [x] {y} $ ^ | \ * - , é`)
  assert.equal(
    quoteMeta("--require evil a.b (1+1) [x] {y} $ ^ | \\ * - , é"),
    "--require evil a\\.b \\(1\\+1\\) \\[x\\] \\{y\\} \\$ \\^ \\| \\\\ \\* - , é",
  );
  assert.equal(quoteMeta("?"), "\\?");
  assert.equal(quoteMeta(""), "");
});
