// artifacts.structured is native, but the Run around it still goes through
// the whole command, so this test sits at seam A with the other Docker tests
// (Go: structured_docker_test.go). The Go test runs the default Selection;
// this one selects the Check, so the Gates counted are its own.
import assert from "node:assert/strict";
import { test } from "node:test";

import { byPath, findingsIn, parseReport } from "./parse.testutil.ts";
import {
  assertNothingLeft,
  copyProject,
  realRun,
  treeFingerprint,
} from "./realrun.testutil.ts";

test("broken structured files are Gates except in Test data", async (t) => {
  const original = copyProject(t, "broken-structured-files");
  const before = treeFingerprint(original);

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "artifacts.structured",
  ]);

  assert.equal(r.code, 1, r.stderr);
  const s = parseReport(r);
  const executions = s.checks.filter(
    (e) => e.check_id === "artifacts.structured",
  );
  assert.deepEqual(
    executions.map((e) => [e.context_id, e.status]),
    [["C-0001", "completed"]],
  );

  // tsconfig.json (JSONC) and .gitlab-ci.yml (!reference) are accepted, so
  // exactly these three files have a Finding.
  const found = byPath(findingsIn(s, "artifacts.structured"));
  assert.deepEqual([...found.keys()].sort(), [
    "config/settings.json",
    "deploy/values.yaml",
    "test/fixtures/invalid.json",
  ]);

  const json = found.get("config/settings.json");
  assert.deepEqual(
    [json?.gate, json?.severity, json?.in_test_data, json?.title],
    [true, "error", false, "JSON file does not parse"],
  );
  assert.deepEqual(json?.locations[0]?.start, { line: 4, column: 1 });

  const yaml = found.get("deploy/values.yaml");
  assert.deepEqual(
    [yaml?.gate, yaml?.title],
    [true, "YAML file does not parse"],
  );
  // The tab-indented line.
  assert.equal(yaml?.locations[0]?.start?.line, 3);

  const note = found.get("test/fixtures/invalid.json");
  assert.deepEqual(
    [note?.gate, note?.severity, note?.in_test_data],
    [false, "note", true],
  );
  assert.equal(s.summary.gates, 2);

  assert.equal(treeFingerprint(original), before, "the Original changed");
  assertNothingLeft(r);
});
