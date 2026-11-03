import assert from "node:assert/strict";
import { test } from "node:test";

import { finalize } from "../resultset/finalize.ts";
import { finding } from "../resultset/resultsettest/findings.testutil.ts";
import { minimal } from "../resultset/resultsettest/sample.testutil.ts";
import { validate } from "../resultset/validate.ts";
import { md } from "./render.testutil.ts";

const lines = (out: string, prefix: string): string[] =>
  out.split("\n").filter((l) => l.startsWith(prefix));

// A Finding in Documentation is marked the way one in Test data or Test code
// is: at the end of its line in the list of Findings, and next to the
// severity in the details that a Gate gets.
test("a Finding in Documentation carries the marker in the list", () => {
  const s = minimal();
  const inDocs = finding("docs/how-to.md", "in the docs", false);
  inDocs.in_documentation = true;
  s.findings.push(inDocs, finding("src/b.js", "in the source", false));
  finalize(s);
  assert.deepEqual(validate(s), []);
  const out = md(s);
  for (const f of s.findings) {
    const line = lines(out, "- " + f.id + " [").pop();
    assert.ok(line !== undefined, f.id);
    assert.equal(line.endsWith(" (in Documentation)"), f.in_documentation);
  }
});

test("a Finding in Documentation carries the marker next to the severity in the details", () => {
  const s = minimal();
  const inDocs = finding("docs/package.json", "in the docs", true);
  inDocs.in_documentation = true;
  s.findings.push(inDocs, finding("src/b.js", "in the source", true));
  finalize(s);
  const severity = lines(md(s), "- Severity: ");
  assert.equal(severity.length, 2);
  assert.equal(
    severity.filter((l) => l.endsWith(", in Documentation")).length,
    1,
    severity.join("\n"),
  );
  assert.ok(
    severity.every((l) => l.startsWith("- Severity: error, confidence: ")),
    severity.join("\n"),
  );
});

test("the markers of Test data, Test code and Documentation stand together in order", () => {
  const s = minimal();
  const listed = finding("docs/fixtures/a.md", "in all three", false);
  const gate = finding("docs/fixtures/b.md", "also in all three", true);
  for (const f of [listed, gate]) {
    f.in_test_data = true;
    f.in_test_code = true;
    f.in_documentation = true;
  }
  s.findings.push(listed, gate);
  finalize(s);
  const out = md(s);
  assert.ok(
    out.includes(
      "in all three (in Test data, in Test code, in Documentation)\n",
    ),
  );
  assert.ok(
    lines(out, "- Severity: ").every((l) =>
      l.endsWith(", in Test data, in Test code, in Documentation"),
    ),
    "the details say the same",
  );
});
