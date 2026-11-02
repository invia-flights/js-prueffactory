// Seam A tests of tests.coverage with a real Docker daemon and the public npm
// registry: c8 from the toolset wraps the project's own runner, so the one
// test run per suite also measures coverage (Go:
// tests_coverage_docker_test.go).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { DockerRun } from "./realrun.testutil.ts";
import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  artifactOf,
  type Execution,
  full,
  type Full,
  inventoryOf,
  oneExecution,
  passedTitles,
} from "./suites.testutil.ts";

const coverage = "tests.coverage";
const existing = "tests.existing";

function coverageMetrics(s: Full): Map<string, Full["metrics"][number]> {
  return new Map(
    s.metrics.filter((m) => m.check_id === coverage).map((m) => [m.name, m]),
  );
}

interface CoverageFiles {
  package: string;
  files: {
    path: string;
    functions: { total: number; covered: number; percent: number | null };
    untested_functions: { name: string; line: number }[];
  }[];
}

function coverageFilesOf(r: DockerRun, s: Full, e: Execution): CoverageFiles {
  const a = artifactOf(s, e, `${e.context_id}-files.json`);
  assert.ok(
    a,
    `no per-file coverage artifact in ${JSON.stringify(s.artifacts)}`,
  );
  return JSON.parse(
    readFileSync(join(r.reportDir, a.path), "utf8"),
  ) as CoverageFiles;
}

test("a Mocha suite has line, branch and function coverage and the untested function is in the artifact", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", coverage]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, coverage);
  assert.equal(e.selected, true);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "observations_only");
  assert.equal(e.gate, 0);
  // tests.existing was not asked for: it reports nothing, and the suite ran
  // for the coverage.
  assert.deepEqual(s.selection.effective_checks, [coverage]);
  assert.ok(
    s.inventory.tests.length === 0 || inventoryOf(s, e.context_id).found === 0,
    `tests.existing is not selected, but the Report counts its tests: ${JSON.stringify(s.inventory.tests)}`,
  );

  const ms = coverageMetrics(s);
  assert.equal(ms.size, 3, "lines, branches and functions");
  for (const name of ["lines", "branches", "functions"]) {
    const m = ms.get(name);
    assert.ok(m, name);
    assert.notEqual(m.value, null, name);
    assert.equal(m.unit, "percent");
    assert.equal(m.context_id, e.context_id);
    assert.equal(m.reason, null, name);
  }
  // add() is called, subtract() is not.
  assert.equal(
    ms.get("functions")?.value,
    50,
    "one of two functions is tested",
  );
  const lines = ms.get("lines")?.value;
  assert.ok(
    lines !== null && lines !== undefined && lines > 0 && lines < 100,
    `line coverage ${String(lines)}, want between 0 and 100`,
  );

  const doc = coverageFilesOf(r, s, e);
  assert.equal(doc.package, ".");
  assert.deepEqual(
    doc.files.map((f) => f.path),
    ["src/index.js"],
    "Test code and node_modules are excluded",
  );
  assert.deepEqual(doc.files[0]?.untested_functions, [
    { name: "subtract", line: 9 },
  ]);

  const ctx = s.contexts.find((c) => c.id === e.context_id);
  assert.ok(
    ctx?.tools.some((tool) => `${tool.name}@${tool.version}` === "c8@12.0.0"),
    `context tools ${JSON.stringify(ctx?.tools)}, want c8@12.0.0`,
  );
  assert.equal(e.tool?.name, "c8");
  assert.equal(e.tool.exit_code, 0);
  assertNothingLeft(r);
});

test("the suite runs once for tests.existing and tests.coverage and both read that run", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${coverage}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const suite = oneExecution(s, existing);
  const cov = oneExecution(s, coverage);
  assert.equal(suite.status, "completed", JSON.stringify(suite));
  assert.equal(cov.status, "completed", JSON.stringify(cov));
  // One run: the command is c8's with Mocha inside, for both.
  assert.ok(
    suite.command.length >= 6 &&
      suite.command[0] === "node" &&
      suite.command[1]?.endsWith("/c8/bin/c8.js") === true &&
      suite.command.includes("--") &&
      suite.command.includes("--no-bail"),
    `tests.existing command ${suite.command.join(" ")}, want Mocha wrapped by c8`,
  );
  assert.deepEqual(
    suite.command,
    cov.command,
    "the commands differ, so the suite ran twice",
  );
  assert.deepEqual(inventoryOf(s, suite.context_id), {
    context_id: suite.context_id,
    found: 1,
    run: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    todo: 0,
    focused: 0,
    never_run: 0,
  });
  assert.deepEqual(passedTitles(r, s, suite), ["add adds two numbers"]);
  assert.equal(coverageMetrics(s).get("functions")?.value, 50);
  assert.ok(
    artifactOf(s, suite, "test-output.log"),
    `no test output artifact in ${JSON.stringify(s.artifacts)}`,
  );
  assertNothingLeft(r);
});

test("when tests fail the coverage is still measured and every metric carries a note", async (t) => {
  const original = copyProject(t, "failing-test");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${coverage}`,
  ]);

  assert.equal(r.code, 1, `the failing test is a Gate\n${r.stderr}`);
  const s = full(r);
  const cov = oneExecution(s, coverage);
  assert.equal(cov.status, "completed");
  assert.equal(cov.gate, 0);
  assert.equal(cov.finding_ids.length, 0, "measurement only");
  const ms = coverageMetrics(s);
  assert.equal(ms.size, 3);
  for (const [name, m] of ms) {
    assert.notEqual(m.value, null, `${name} has no value`);
    assert.ok(
      m.reason?.includes("1 test failed"),
      `${name}: ${String(m.reason)}, want a note about the failing test`,
    );
  }
  assertNothingLeft(r);
});

test("a node:test suite has coverage from its child processes", async (t) => {
  const original = copyProject(t, "node-test");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${coverage}`,
  ]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const cov = oneExecution(s, coverage);
  assert.equal(cov.status, "completed", JSON.stringify(cov));
  const suite = oneExecution(s, existing);
  assert.deepEqual(suite.command, cov.command);
  assert.ok(
    suite.command.includes("--test") &&
      suite.command[1]?.endsWith("/c8/bin/c8.js") === true,
    `commands ${suite.command.join(" ")}, want one run of node --test wrapped by c8`,
  );
  const ms = coverageMetrics(s);
  // Each test file runs in a child process of node --test. Both functions of
  // src/index.js are called there, and nothing in the parent calls them.
  for (const name of ["functions", "lines"]) {
    const m = ms.get(name);
    assert.equal(m?.value, 100, name);
    assert.ok(
      m.reason?.includes("failed"),
      `${name}: ${String(m.reason)}, want the note of the failing test`,
    );
  }
  const doc = coverageFilesOf(r, s, cov);
  assert.deepEqual(
    doc.files.map((f) => f.path),
    ["src/index.js"],
  );
  assertNothingLeft(r);
});

test("a project's own c8 wrapper and config are not used and the Report says so", async (t) => {
  const original = copyProject(t, "clean-mocha");
  writeFileSync(
    join(original, "package.json"),
    `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"c8 --reporter=text mocha"},"devDependencies":{"mocha":"^10.8.2"}}`,
  );
  // If this configuration were read, no file would be measured.
  writeFileSync(
    join(original, ".c8rc.json"),
    `{"all":false,"include":["nothing/**"]}`,
  );

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    `${existing},${coverage}`,
  ]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  assert.equal(
    coverageMetrics(s).get("functions")?.value,
    50,
    "from our own configuration",
  );
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "test_wrapper_dropped" && l.message.includes("c8"),
    ),
    `the dropped c8 wrapper is listed: ${JSON.stringify(s.limitations)}`,
  );
  assertNothingLeft(r);
});
