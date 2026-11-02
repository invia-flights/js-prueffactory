// Seam A tests of tests.existing with a real Docker daemon and the public npm
// registry: the project's own Mocha suite runs in its package container, and
// every result lands in the Report (Go: tests_existing_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  artifactOf,
  counts,
  findingsOf,
  full,
  inventoryOf,
  oneExecution,
  passedTitles,
  testCasesOf,
  withoutSecretScan,
} from "./suites.testutil.ts";

const existing = "tests.existing";

test("a clean Mocha suite passes and --only tests.existing runs the install as a prerequisite", async (t) => {
  const original = copyProject(t, "clean-mocha");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.selected, true);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "passed");
  assert.equal(e.tool?.name, "mocha");
  assert.ok(e.tool.version?.startsWith("10."), "the project's own Mocha 10");
  assert.equal(e.tool.exit_code, 0);
  // The install ran as a prerequisite and the Report says so.
  const install = oneExecution(s, "package.install");
  assert.equal(install.selected, false);
  assert.equal(install.status, "completed");
  assert.deepEqual(withoutSecretScan(s.selection.prerequisites_run), [
    "package.install",
  ]);
  assert.deepEqual(s.selection.effective_checks, [existing]);
  // One test, passed: it is counted and listed in the artifact, not in test_cases.
  assert.deepEqual(s.test_cases, []);
  assert.equal(s.summary.test_cases.passed, 1);
  assert.deepEqual(passedTitles(r, s, e), ["add adds two numbers"]);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 1, run: 1, passed: 1 }),
  );
  // The Report lists the override of the project's command, and the suite's
  // output is saved.
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "test_command_override" && l.check_id === existing,
    ),
    JSON.stringify(s.limitations),
  );
  assert.ok(artifactOf(s, e, "test-output.log"), JSON.stringify(s.artifacts));
  assert.ok(
    e.command.length >= 3 && e.command[0] === "node",
    e.command.join(" "),
  );
  assert.ok(e.command[1]?.endsWith("/node_modules/mocha/bin/mocha.js"));
  assertNothingLeft(r);
});

test("a failing test is one Gate Finding with file, title, expected, actual and re-run commands", async (t) => {
  const original = copyProject(t, "failing-test");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "failed");
  assert.equal(e.gate, 1);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const f = fs[0];
  assert.ok(f);
  assert.ok(f.gate);
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.severity, "error");
  assert.equal(f.expected, "2");
  assert.equal(f.actual, "-2");
  assert.equal(f.locations.length, 1);
  assert.equal(f.locations[0]?.path, "test/add.test.js");
  assert.equal(f.locations[0].start?.line, 13);
  assert.equal(f.locations[0].file_sha256.length, 64);
  const repro = f.reproduction.test;
  assert.ok(repro);
  assert.equal(repro.runner, "mocha");
  assert.equal(repro.file, "test/add.test.js");
  assert.equal(repro.full_title, "add adds negative numbers");
  assert.deepEqual(repro.native_command, [
    "npx",
    "mocha",
    "--fgrep",
    "add adds negative numbers",
    "test/add.test.js",
  ]);
  assert.deepEqual(f.reproduction.rerun_command, [
    "js-prueffactory",
    "test",
    s.source.original_path,
    "--only",
    existing,
  ]);
  const stack = f.evidence.find((x) => x.kind === "stack_trace")?.text ?? "";
  assert.ok(stack.includes("test/add.test.js:13"), stack);
  assert.ok(!stack.includes("/work/"), stack);

  // The failed test is a test case linked to the Finding; the passed one is
  // only in the artifact.
  const cases = testCasesOf(s, e.id);
  assert.equal(cases.length, 1, JSON.stringify(cases));
  assert.equal(cases[0]?.outcome, "failed");
  assert.equal(cases[0].full_title, "add adds negative numbers");
  assert.deepEqual(cases[0].finding_ids, [f.id]);
  assert.deepEqual(cases[0].suite_path, ["add"]);
  assert.equal(cases[0].file, "test/add.test.js");
  assert.deepEqual(passedTitles(r, s, e), ["add adds two numbers"]);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 2, run: 2, passed: 1, failed: 1 }),
  );
  assert.equal(s.summary.test_cases.failed, 1);
  assert.equal(s.summary.test_cases.passed, 1);
  assertNothingLeft(r);
});

test("a failing root hook is one Finding and the tests it prevented are never run", async (t) => {
  const original = copyProject(t, "failing-root-hook");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, JSON.stringify(fs));
  const hook = fs[0];
  assert.ok(hook);
  assert.equal(hook.rule_id, "hook-failed");
  assert.ok(hook.gate);
  for (const want of ["before all", "the test database is not reachable"]) {
    assert.ok((hook.title + " " + hook.message).includes(want), want);
  }
  assert.equal(hook.locations[0]?.path, "test/setup.js");
  assert.equal(hook.locations[0].start?.line, 5);
  const e = oneExecution(s, existing);
  const cases = testCasesOf(s, e.id);
  assert.equal(cases.length, 3, JSON.stringify(cases));
  for (const tc of cases) {
    assert.equal(tc.outcome, "never_run", tc.full_title);
    assert.ok(tc.never_run_reason?.includes("before all"), tc.full_title);
    assert.deepEqual(tc.finding_ids, [hook.id], tc.full_title);
  }
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 3, never_run: 3 }),
  );
  assert.equal(s.summary.test_cases.failed, 0);
  assert.equal(s.summary.test_cases.never_run, 3);
  assertNothingLeft(r);
});

test("a Jest project is unsupported and no install runs for it", async (t) => {
  const original = copyProject(t, "jest-unsupported");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 2, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "unsupported");
  assert.equal(e.reason_code, "test_runner_unsupported");
  for (const want of [
    "Jest",
    "jest --ci",
    "js-prueffactory runs only `mocha …` and `node … --test …`",
  ]) {
    assert.ok(e.reason?.includes(want), `${e.reason ?? ""} lacks ${want}`);
  }
  assert.deepEqual(withoutSecretScan(s.selection.prerequisites_run), []);
  assert.deepEqual(s.findings, []);
  assertNothingLeft(r);
});

test("a failed install blocks the suite as the project's fault", async (t) => {
  const original = copyProject(t, "lockfile-mismatch");

  const r = await realRun(t, [
    "test",
    original,
    "--only",
    "package.install,tests.existing",
  ]);

  const e = oneExecution(full(r), existing);
  assert.equal(e.status, "blocked");
  assert.equal(e.reason_code, "prerequisite_failed_project");
  assertNothingLeft(r);
});
