// Seam A with a real Docker daemon: Coverage leaves the Test code the runner
// loads out and still counts the Source code next to it (the tests.coverage
// part of TestFilesTheRunnerLoadsAreTestCode... in
// colocated_tests_docker_test.go). The other parts of that test are in
// colocated_tests.docker.test.ts and belong to the tickets of their Checks;
// this one has its own file so that those tickets do not meet here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import { artifactOf, full, oneExecution } from "./suites.testutil.ts";

test("Coverage leaves the files the runner loads out and still counts the Source code next to them", async (t) => {
  const original = copyProject(t, "colocated-tests");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "package.install,tests.coverage",
  ]);

  assert.ok(r.code === 0 || r.code === 1, r.stderr);
  assertNothingLeft(r);
  const s = full(r);
  const cov = oneExecution(s, "tests.coverage");
  assert.equal(cov.status, "completed", JSON.stringify(cov));
  const a = artifactOf(s, cov, `${cov.context_id}-files.json`);
  assert.ok(
    a,
    `no per-file coverage artifact in ${JSON.stringify(s.artifacts)}`,
  );
  const doc = JSON.parse(readFileSync(join(r.reportDir, a.path), "utf8")) as {
    files: { path: string }[];
  };
  const covered = new Set(doc.files.map((f) => f.path));
  assert.ok(
    !covered.has("src/a.spec.js") &&
      !covered.has("src/setup.js") &&
      covered.has("src/index.js") &&
      covered.has("src/ab-test.js"),
    `coverage files ${[...covered].join(", ")}, want the Source code (src/index.js, src/ab-test.js) and neither the spec nor the setup file`,
  );
});
