// Seam A with a real Docker daemon: in_test_code says whether a Finding's
// primary location is Test code, whatever Check produced it. Test code is a
// folder named test, or a file the project's own Mocha loads; a test-like name
// alone is not (Go: in_test_code_docker_test.go). The Go test selected
// package.install, lint.correctness and security.secrets as well.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { lintReport } from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

/** lineOf returns the first line of text that starts with prefix. */
function lineOf(text: string, prefix: string): string {
  return text.split("\n").find((l) => l.startsWith(prefix)) ?? "";
}

test("every finding in Test code says so in the Report and a file with a test-like name is not Test code", async (t) => {
  const original = copyProject(t, "secret-in-test-code");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "package.install,lint.correctness,security.secrets",
  ]);

  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assertNothingLeft(r);
  const s = lintReport(r);
  const md = readFileSync(join(r.reportDir, "report.md"), "utf8");

  for (const [check, path, inTestCode] of [
    ["lint.correctness", "test/helpers.js", true],
    ["security.secrets", "test/helpers.js", true],
    ["security.secrets", "src/a.spec.js", true],
    ["lint.correctness", "src/fare-ab-test.js", false],
  ] as const) {
    const f = s.findings.find(
      (x) => x.check_id === check && x.locations[0]?.path === path,
    );
    assert.ok(f, `no ${check} Finding in ${path}`);
    assert.equal(f.in_test_code, inTestCode, `${check} in ${path}`);
    const line = lineOf(md, `- ${f.id} [`);
    assert.ok(
      line !== "" && line.endsWith(" (in Test code)") === inTestCode,
      `report.md line of ${f.id} in ${path}: ${line}, want the Test code hint ${String(inTestCode)}`,
    );
  }
});
