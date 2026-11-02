import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "../resultset/finalize.ts";
import { finding } from "../resultset/resultsettest/findings.testutil.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import { validate } from "../resultset/validate.ts";
import { md } from "./render.testutil.ts";

// Go: TestMarkdownHintsTestCodeOnAFindingOfAnyCheck. Any Finding marked
// in_test_code carries the hint, and one in Source code does not.
test("a Finding of any Check in Test code carries the hint", () => {
  const s = minimal();
  const inTest = finding("test/a.js", "in a test", false);
  inTest.in_test_code = true;
  s.findings.push(inTest, finding("src/b.js", "in the source", false));
  finalize(s);
  assert.deepEqual(validate(s), []);
  const out = md(s);
  for (const f of s.findings) {
    const line = out
      .split("\n")
      .filter((l) => l.startsWith("- " + f.id + " ["))
      .pop();
    assert.ok(line !== undefined, f.id);
    assert.equal(line.endsWith(" (in Test code)"), f.in_test_code, line);
  }
});

// Go: TestMarkdownHintsTestCodeAndTestDataOnOneFinding.
test("a Finding in Test code and Test data says both", () => {
  const s = minimal();
  const both = finding("test/fixtures/a.js", "in both", false);
  both.in_test_code = true;
  both.in_test_data = true;
  const onlyData = finding("test/fixtures/b.js", "in data", false);
  onlyData.in_test_data = true;
  s.findings.push(both, onlyData);
  finalize(s);
  assert.deepEqual(validate(s), []);
  const out = md(s);
  for (const want of [
    "in both (in Test data, in Test code)\n",
    "in data (in Test data)\n",
  ]) {
    assert.ok(out.includes(want), want);
  }
});
