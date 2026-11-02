// Seam A with a real Docker daemon: a test script that chains two npm scripts
// runs as two suites, every suite runs although the second one fails, and the
// Report names the suite everywhere, and Knip reports nothing false for it
// (Go: npm_run_chain_docker_test.go). The Go file's other test reads the
// Coverage and runtime.warnings of the chain (ticket 15), which adds it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { unusedSummary } from "./graph.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  artifactOf,
  counts,
  findingsOf,
  full,
  inventoryOf,
  oneExecution,
} from "./suites.testutil.ts";

const existing = "tests.existing";

test("a chain of npm scripts runs one suite per step and names the failing layer", async (t) => {
  const original = copyProject(t, "npm-run-chain");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, `the api suite has a failing test\n${r.stderr}`);
  assertNothingLeft(r);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.gate, 1);

  // Two suites ran, each with its own counts, and the package row adds them up.
  const suites = s.inventory.test_suites;
  assert.equal(suites.length, 2, "test:unit and test:api");
  const want = new Map([
    [
      "test:unit",
      {
        ...counts(e.context_id, { found: 2, run: 2, passed: 2 }),
        suite: "test:unit",
      },
    ],
    [
      "test:api",
      {
        ...counts(e.context_id, { found: 2, run: 2, passed: 1, failed: 1 }),
        suite: "test:api",
      },
    ],
  ]);
  for (const row of suites) {
    assert.deepEqual(row, want.get(row.suite));
  }
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 4, run: 4, passed: 3, failed: 1 }),
  );
  const files = s.inventory.test_files
    .map((f) => `${f.suite} ${f.file}`)
    .sort();
  assert.deepEqual(files, [
    "test:api test/api/sum.test.js",
    "test:unit test/unit/add.test.js",
  ]);

  // One Gate, from the api suite, with that suite's own re-run command.
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const f = fs[0];
  assert.ok(f);
  assert.ok(f.gate);
  assert.equal(f.suite, "test:api");
  const repro = f.reproduction.test;
  assert.ok(repro);
  assert.equal(repro.file, "test/api/sum.test.js");
  assert.equal(
    repro.full_title,
    "describeSum describes a sum with the wrong text",
  );
  assert.deepEqual(repro.native_command, [
    "npx",
    "mocha",
    "--config",
    "test/config/mocha-api.js",
    "--fgrep",
    "describeSum describes a sum with the wrong text",
    "test/api/sum.test.js",
  ]);
  for (const tc of s.test_cases) {
    assert.equal(
      tc.suite,
      "test:api",
      `only the api suite has tests that are not passed: ${JSON.stringify(tc)}`,
    );
  }

  // The Report says the tool ran every step.
  const chain = s.limitations.filter(
    (l) => l.reason_code === "test_chain_all_steps_run",
  );
  const override = s.limitations.filter(
    (l) => l.reason_code === "test_command_override",
  );
  assert.equal(chain.length, 1, JSON.stringify(chain));
  assert.ok(chain[0]?.message.includes("&&"));
  assert.equal(
    override.length,
    1,
    "one for the package that lists both suites",
  );
  assert.ok(override[0]?.message.includes("`test:unit`, `test:api`"));

  // Each suite has its own command log.
  for (const name of [
    "test-output-1-test-unit.log",
    "test-output-2-test-api.log",
  ]) {
    assert.ok(artifactOf(s, e, name), `no ${name} artifact`);
  }
});

// The configs of the chain name mocha-multi-reporters as the reporter and
// ci/test.sh is the only place that runs c8: Knip must not report either as
// unused, nor report an unresolved import in the configs and setup files, nor
// an unused dependency for Mocha itself.
test("Knip reports nothing false for a chain with a reporter plugin and a CI script", async (t) => {
  const original = copyProject(t, "npm-run-chain");

  const r = await realRun(t, ["test", original, "--only", "quality.unused"]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, "quality.unused");
  assert.equal(e.status, "completed", e.reason ?? "");
  // The only true finding is the export that no test calls (src/unit-only.js
  // keeps it for the Coverage test).
  assert.deepEqual(
    unusedSummary(s),
    ["unused-export neverCalled"],
    "mocha, mocha-multi-reporters and c8 are used",
  );
  assertNothingLeft(r);
});
