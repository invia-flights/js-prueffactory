// Seam A with a real Docker daemon: the Coverage and the open handles of a
// chain of npm scripts (Go: TestCoverageOfAChainIsTheUnionOverItsSuites...
// in npm_run_chain_docker_test.go). The rest of that file's tests are in
// npm_run_chain.docker.test.ts; this one has its own file so that the
// tickets that extend that file do not meet here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  artifactOf,
  findingsOf,
  full,
  oneExecution,
} from "./suites.testutil.ts";

test("the Coverage of a chain is the union over its suites and an open handle names its suite", async (t) => {
  const original = copyProject(t, "npm-run-chain");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "tests.existing,tests.coverage,runtime.warnings",
  ]);

  assert.equal(r.code, 1, `the api suite has a failing test\n${r.stderr}`);
  assertNothingLeft(r);
  const s = full(r);
  for (const id of ["tests.existing", "tests.coverage", "runtime.warnings"]) {
    assert.equal(oneExecution(s, id).status, "completed", id);
  }

  // Coverage is one report for the package over both suites: src/unit-only.js
  // is loaded by the unit suite alone and src/api-only.js by the api suite
  // alone, and both count as covered.
  const cov = oneExecution(s, "tests.coverage");
  const ms = s.metrics.filter((m) => m.check_id === "tests.coverage");
  assert.equal(ms.length, 3, JSON.stringify(ms));
  for (const m of ms) {
    assert.ok(
      m.value !== null && m.value > 0,
      `${m.name} = ${JSON.stringify(m)}, want a measured value`,
    );
  }
  const a = artifactOf(s, cov, `${cov.context_id}-files.json`);
  assert.ok(
    a,
    `no per-file coverage artifact in ${JSON.stringify(s.artifacts)}`,
  );
  const doc = JSON.parse(readFileSync(join(r.reportDir, a.path), "utf8")) as {
    files: {
      path: string;
      lines: { total: number; covered: number };
      untested_functions: { name: string }[];
    }[];
  };
  for (const f of doc.files) {
    if (f.path === "src/unit-only.js") {
      assert.deepEqual(
        f.untested_functions.map((u) => u.name),
        ["neverCalled"],
      );
    }
  }
  assert.deepEqual(
    doc.files.map((f) => f.path),
    ["src/api-only.js", "src/index.js", "src/unit-only.js"],
  );
  for (const f of doc.files) {
    assert.notEqual(
      f.lines.covered,
      0,
      `${f.path} has no covered lines, but a suite loads it: Coverage is the union over all suites`,
    );
  }

  // The unit suite leaves a server open, the api suite does not: the Finding
  // is the unit suite's alone.
  const fs = findingsOf(s, "runtime.warnings");
  assert.equal(
    fs.length,
    1,
    `want one open-resources Finding of test:unit: ${JSON.stringify(fs)}`,
  );
  assert.equal(fs[0]?.rule_id, "open-resources");
  assert.equal(fs[0].suite, "test:unit");
  assert.ok(fs[0].message.includes("TCPServerWrap"), fs[0].message);

  // The NODE_OPTIONS override is listed once, for both suites, although
  // runtime.warnings and tests.existing are selected.
  const nodeOptions = s.limitations.filter((l) =>
    l.message.includes("NODE_OPTIONS"),
  );
  assert.equal(nodeOptions.length, 1, JSON.stringify(nodeOptions));
  assert.ok(
    nodeOptions[0]?.message.includes("`test:unit`, `test:api`"),
    nodeOptions[0]?.message,
  );
  assert.equal(s.inventory.test_suites.length, 2);
});
