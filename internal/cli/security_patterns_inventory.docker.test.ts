// Seam A with a real Docker daemon: the Suppressions part of Go's
// TestSecurityPatternsFindInsecureSourceCodeFromBothRuleSetsAndNoSuppressionHidesAFinding
// (security_patterns_docker_test.go). security.docker.test.ts has the rest of
// that test, without the Inventory, which is quality.suppressions'.
import assert from "node:assert/strict";
import { test } from "node:test";

import { lintReport } from "./lint.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";

test("the nosemgrep comment is a Suppression and a Limitation names the line where it can hide an njsscan Finding", async (t) => {
  const original = copyProject(t, "security-patterns");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "security.patterns,quality.suppressions",
  ]);

  assert.equal(
    r.code,
    0,
    `pattern hits are warnings and never Gates\n${r.stderr}`,
  );
  assertNothingLeft(r);
  const s = lintReport(r);
  let got = 0;
  for (const x of s.inventory.suppressions) {
    if (x.kind === "nosemgrep" && x.file_class === "source") {
      got += x.count;
    }
  }
  assert.equal(got, 1, "nosemgrep Suppressions");
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "nosemgrep_comments" &&
        l.message.includes("src/app.js:23"),
    ),
    `no nosemgrep_comments Limitation naming src/app.js:23 in ${JSON.stringify(s.limitations)}`,
  );
});
