// Seam A with a real Docker daemon: the File class Documentation. A prose file
// or a non-code file below docs/ or doc/ is Documentation: its Findings carry
// in_documentation and none of them is a Gate. JavaScript below docs/ stays
// code, Test data wins over Documentation, and a prose file in a test folder is
// Documentation because no runner loads it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import {
  byPath,
  errorsIn,
  executionIn,
  findingsIn,
  gatesIn,
  parseReport,
  type ParseFinding,
  type ParseReport,
} from "./parse.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

// The made-up tokens of the documentation-files testdata project. They open
// nothing.
const tokens = {
  "README.md": "sk_prod_51Mn7XcWbRq4ZtLd9YgFkHa3JeUo8VpSi2TxCzNv6BlQrEyDw",
  "docs/how-to/deploy.md":
    "sk_prod_51Kd2VhNqXw8RtLb5YcFmPa9JeUo3ZgSi7TxCzMv4BlWrEyHn",
  "test/NOTES.md": "sk_prod_51Jt6WbPmQx3ZvLc8RdYgFhNa2KeUo7VnSi5TxCzMq9BlWrEy",
};

const checks = [
  "artifacts.structured",
  "api.lint",
  "security.secrets",
  "lint.correctness",
  "quality.size",
];

/** assertValuesInNoReportFile walks every file of the report folder and fails when one holds one of the values. */
function assertValuesInNoReportFile(dir: string, values: string[]): void {
  let files = 0;
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.isDirectory()) {
        walk(q);
        continue;
      }
      files++;
      const data = readFileSync(q, "latin1");
      for (const v of values) {
        assert.ok(
          !data.includes(v),
          `${relative(dir, q)} holds ${v.slice(0, 8)}...`,
        );
      }
    }
  };
  walk(dir);
  assert.ok(files >= 2, `only ${String(files)} file(s) in the report folder`);
}

/** only is the one Finding of a Check at a path; it fails the test when there is not exactly one. */
function only(s: ParseReport, check: string, path: string): ParseFinding {
  const found = findingsIn(s, check).filter(
    (f) => f.locations[0]?.path === path,
  );
  assert.equal(
    found.length,
    1,
    `${check} at ${path}: ${JSON.stringify(found.map((f) => f.rule_id))}`,
  );
  const f = found[0];
  assert.ok(f);
  return f;
}

test("Documentation Findings carry in_documentation and none of them is a Gate", async (t) => {
  const original = copyProject(t, "documentation-files");

  const r = await realRun(t, ["test", original, "--only", checks.join(",")]);

  assert.equal(r.code, 0, `no Gate, so exit 0\n${r.stderr}`);
  assertNothingLeft(r);
  const s = parseReport(r);
  assert.equal(s.summary.gates, 0);
  for (const id of checks) {
    const e = executionIn(s, id);
    assert.equal(e.status, "completed", `${id}: ${e.reason ?? ""}`);
  }

  // The tokens in README.md, in a how-to below docs/ and in a prose file in
  // test/ are Documentation, never Test code, and never a Gate.
  const secrets = byPath(findingsIn(s, "security.secrets"));
  assert.deepEqual(
    [...secrets.keys()].sort(),
    Object.keys(tokens).sort(),
    "one secret Finding per Documentation file",
  );
  for (const path of Object.keys(tokens)) {
    const f = secrets.get(path);
    assert.ok(f, path);
    assert.deepEqual(
      [f.in_documentation, f.in_test_code, f.in_test_data, f.gate],
      [true, false, false, false],
      `secret in ${path}`,
    );
    assert.ok(!f.message.includes("Test code"), `${path}: ${f.message}`);
  }

  // The broken example JSON below docs/ is an error without a Gate. The
  // fixture below fixtures/docs/ stays Test data: a note.
  const structured = byPath(findingsIn(s, "artifacts.structured"));
  assert.deepEqual(
    [...structured.keys()].sort(),
    ["docs/examples/response.json", "fixtures/docs/broken.json"],
    "broken files",
  );
  const example = structured.get("docs/examples/response.json");
  assert.ok(example);
  assert.deepEqual(
    [
      example.rule_id,
      example.severity,
      example.gate,
      example.in_documentation,
      example.in_test_data,
    ],
    ["invalid-json", "error", false, true, false],
  );
  const fixture = structured.get("fixtures/docs/broken.json");
  assert.ok(fixture);
  assert.deepEqual(
    [
      fixture.severity,
      fixture.gate,
      fixture.in_documentation,
      fixture.in_test_data,
    ],
    ["note", false, false, true],
  );
  assert.equal(gatesIn(s, "artifacts.structured").size, 0);
  assert.equal(errorsIn(s, "artifacts.structured").size, 1);

  // The API description below docs/ is still linted, and its errors are
  // Documentation Findings without a Gate.
  const api = findingsIn(s, "api.lint");
  assert.ok(api.length > 0, "api.lint reports the description in docs/");
  for (const f of api) {
    assert.deepEqual(
      [f.locations[0]?.path, f.gate, f.in_documentation, f.in_test_code],
      ["docs/openapi.yaml", false, true, false],
      f.rule_id ?? "",
    );
  }
  assert.ok(
    api.some((f) => f.severity === "error"),
    "the missing info.version is an error",
  );

  // The JavaScript example below docs/ is code: it is linted, and its Finding
  // is not Documentation.
  const lint = only(s, "lint.correctness", "docs/examples/client.js");
  assert.equal(lint.rule_id, "no-dupe-keys");
  assert.deepEqual(
    [lint.in_documentation, lint.in_test_code, lint.in_test_data],
    [false, false, false],
  );

  // quality.size reports the lines of Documentation as their own class:
  // README.md, the how-to, the example JSON, the OpenAPI file and the prose
  // file in test/. The JavaScript example is Source code, the fixture Test data.
  const size = (name: string): number | undefined =>
    s.inventory.size.find((x) => x.group === "file_class" && x.name === name)
      ?.lines;
  assert.equal(size("documentation"), 9 + 7 + 6 + 10 + 6);
  assert.equal(size("test_data"), 1);
  assert.equal(size("test_code"), undefined, "no Test code in the project");

  // report.md marks the Findings in Documentation, and not the ones in code.
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");
  let marked = 0;
  for (const f of s.findings) {
    const listed = md.split("\n").find((l) => l.startsWith(`- ${f.id} [`));
    if (listed === undefined) {
      continue;
    }
    assert.equal(
      listed.endsWith(" (in Documentation)"),
      f.in_documentation,
      listed,
    );
    marked += f.in_documentation ? 1 : 0;
  }
  assert.ok(marked > 0, "report.md lists a Finding in Documentation");

  // No token value is in any written file.
  assertValuesInNoReportFile(r.reportDir, Object.values(tokens));
});
