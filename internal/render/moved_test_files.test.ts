import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "../resultset/finalize.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import { md, section } from "./render.testutil.ts";

// Go: TestMarkdownListsTheFilesTheProbeMovedWithTheirSuite.
test("the files the probe moved are listed with their suite", () => {
  const s = minimal();
  s.inventory.moved_test_files = [
    {
      context_id: "C-0002",
      path: "src/a|b.spec.js",
      suite: "test:unit",
      kind: "spec",
    },
    {
      context_id: "C-0002",
      path: "src/setup.js",
      suite: "test:unit",
      kind: "require",
    },
  ];
  finalize(s);
  const inv = section(md(s), "## Inventory");
  assert.notEqual(inv.trim(), "None.");
  for (const want of [
    "Moved test files",
    "`src/setup.js`",
    "test:unit",
    "require",
    "src/a\\|b.spec.js",
  ]) {
    assert.ok(inv.includes(want), `the Inventory lacks ${want}:\n${inv}`);
  }
});
