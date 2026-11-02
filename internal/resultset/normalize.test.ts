import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "./helpers.testutil.ts";
import { normalize } from "./normalize.ts";
import { minimal } from "./resultsettest/sample.testutil.ts";

// Go has no test of its own for Normalize; the golden reports cover it there.
test("normalize turns missing lists into empty ones, at every depth", () => {
  const s = minimal();
  const loose = s as unknown as Record<string, unknown>;
  loose.findings = null;
  (s.selection as unknown as Record<string, unknown>).only = undefined;
  (at(s.checks, 0) as unknown as Record<string, unknown>).command = null;
  (at(s.contexts, 0) as unknown as Record<string, unknown>).tools = null;
  normalize(s);
  assert.deepEqual(s.findings, []);
  assert.deepEqual(s.selection.only, []);
  assert.deepEqual(at(s.checks, 0).command, []);
  assert.deepEqual(at(s.contexts, 0).tools, []);
  assert.equal(s.source.git, null, "a missing pointer stays null");
});
