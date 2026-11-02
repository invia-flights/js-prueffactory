// Seam A tests of quality.unused on a package whose Mocha configs live under
// test/config, with a real Docker daemon, the toolset volume and the public
// npm registry (Go: unused_mocha_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { unusedSummary } from "./graph.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import { full, oneExecution, writeFiles } from "./suites.testutil.ts";

void test("Knip knows what Mocha configs load and what CI scripts run", async (t) => {
  const original = copyProject(t, "mocha-config-unused");

  const r = await realRun(t, ["test", original, "--only", "quality.unused"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, "quality.unused");
  assert.equal(e.status, "completed", e.reason ?? "");
  // The setup files and the helper only they import are used, the reporter is
  // a dependency that is used, and so is c8, which only ci/test.sh runs. What
  // is really unused is still reported.
  assert.deepEqual(unusedSummary(s), [
    "unused-dependency is-odd",
    "unused-file src/unused.js",
  ]);
  for (const l of s.limitations) {
    assert.notEqual(
      l.check_id,
      "quality.unused",
      `a Limitation without a project Knip config: ${JSON.stringify(l)}`,
    );
  }
  assertNothingLeft(r);
});

// A test script that names folders, with `recursive` in the config, loads
// specs that Knip does not find. Without the correction it reports every one
// of them, and the sources only they import, as unused files.
void test("specs of a folder the test script names are not reported as unused files", async (t) => {
  const original = copyProject(t, "mocha-test-folder");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "quality.unused,tests.existing",
  ]);

  assert.equal(r.code, 0, r.stderr);
  const files = unusedSummary(full(r)).filter((l) =>
    l.startsWith("unused-file "),
  );
  assert.deepEqual(
    files,
    ["unused-file src/unused.js"],
    "the nested spec and src/lib/double.js are used",
  );
  assertNothingLeft(r);
});

void test("with the project's own Knip config the corrections hold and the Report says what it cannot see", async (t) => {
  const original = copyProject(t, "mocha-config-unused");
  writeFiles(original, { "knip.json": "{}\n" });

  const r = await realRun(t, ["test", original, "--only", "quality.unused"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  // No false unresolved imports, no unused setup files, no unused reporter or
  // c8. The helper that only the setup files import is still reported: the
  // project's own config is not rewritten, so Knip cannot be told.
  assert.deepEqual(unusedSummary(s), [
    "unused-dependency is-odd",
    "unused-file src/unused.js",
    "unused-file test/helpers/only-setup.js",
  ]);
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "mocha_loaded_files_not_traced" &&
        l.check_id === "quality.unused" &&
        l.message.includes("test/setup/base.js"),
    ),
    JSON.stringify(s.limitations),
  );
  assertNothingLeft(r);
});
