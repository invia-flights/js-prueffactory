// Seam A tests of tests.existing for node:test suites and nested packages,
// with a real Docker daemon and the public npm registry (Go:
// tests_existing_nodetest_docker_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNothingLeft, copyProject, realRun } from "./realrun.testutil.ts";
import {
  artifactOf,
  counts,
  type Execution,
  executionsOf,
  type Finding,
  findingsOf,
  full,
  inventoryOf,
  oneExecution,
  passedTitles,
  testCasesOf,
  writeFiles,
} from "./suites.testutil.ts";

const existing = "tests.existing";

test("a node:test suite shows one failure and one todo with the same detail as Mocha", async (t) => {
  const original = copyProject(t, "node-test");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  assert.equal(e.outcome, "failed");
  assert.equal(e.gate, 1);
  assert.equal(e.tool?.name, "node:test");
  assert.equal(e.tool.exit_code, 1);
  assert.ok(
    e.command.length >= 3 && e.command[0] === "node",
    e.command.join(" "),
  );
  for (const want of [
    "--test",
    "--test-reporter=/jspf/node-test-reporter.js",
    "--test-reporter-destination=stdout",
  ]) {
    assert.ok(e.command.includes(want), `${e.command.join(" ")} lacks ${want}`);
  }

  const fs = findingsOf(s, existing);
  assert.equal(fs.length, 1, "exactly one (the todo test is not a failure)");
  const f = fs[0];
  assert.ok(f);
  assert.equal(f.rule_id, "test-failed");
  assert.ok(f.gate);
  assert.equal(f.confidence, "confirmed");
  assert.equal(f.expected, "2");
  assert.equal(f.actual, "8");
  assert.equal(f.locations.length, 1);
  assert.equal(f.locations[0]?.path, "test/math.test.js");
  assert.equal(f.locations[0].start?.line, 13);
  const repro = f.reproduction.test;
  assert.ok(repro);
  assert.equal(repro.runner, "node:test");
  assert.equal(repro.file, "test/math.test.js");
  assert.equal(repro.full_title, "math subtracts two numbers");
  assert.deepEqual(repro.native_command, [
    "node",
    "--test",
    "--test-name-pattern=^math subtracts two numbers$",
    "test/math.test.js",
  ]);
  const stack = f.evidence.find((x) => x.kind === "stack_trace")?.text ?? "";
  assert.ok(stack.includes("test/math.test.js:13"), stack);
  assert.ok(!stack.includes("/work/"), stack);

  const byTitle = new Map(testCasesOf(s, e.id).map((c) => [c.full_title, c]));
  const failed = byTitle.get("math subtracts two numbers");
  assert.equal(failed?.outcome, "failed");
  assert.deepEqual(failed.finding_ids, [f.id]);
  assert.deepEqual(failed.suite_path, ["math"]);
  assert.equal(failed.file, "test/math.test.js");
  const todo = byTitle.get("math multiplies two numbers");
  assert.equal(todo?.outcome, "todo");
  assert.deepEqual(todo.finding_ids, []);
  assert.deepEqual(passedTitles(r, s, e), ["math adds two numbers"]);
  assert.deepEqual(
    inventoryOf(s, e.context_id),
    counts(e.context_id, { found: 3, run: 2, passed: 1, failed: 1, todo: 1 }),
  );
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "test_command_override" &&
        l.check_id === existing &&
        l.message.includes("node --test"),
    ),
    JSON.stringify(s.limitations),
  );
  assert.ok(artifactOf(s, e, "test-output.log"));
  assertNothingLeft(r);
});

test("a nested package is installed and tested on its own with its own Context", async (t) => {
  const original = copyProject(t, "sub-package");

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 0, r.stderr);
  const s = full(r);
  const suites = executionsOf(s, existing);
  const installs = executionsOf(s, "package.install");
  assert.equal(suites.length, 2, JSON.stringify(suites));
  assert.equal(installs.length, 2, JSON.stringify(installs));
  const paths = new Map(s.contexts.map((c) => [c.id, c.path]));
  const byPath = new Map<string, Execution>();
  for (const e of suites) byPath.set(paths.get(e.context_id) ?? "", e);
  const root = byPath.get(".");
  const nested = byPath.get("tools/report");
  assert.ok(root && nested && root.context_id !== nested.context_id);
  for (const e of suites) {
    assert.equal(e.status, "completed");
    assert.equal(e.outcome, "passed");
  }
  assert.equal(root.tool?.name, "mocha");
  assert.equal(nested.tool?.name, "node:test");
  // Each suite ran its own tests and only those.
  assert.deepEqual(passedTitles(r, s, root), ["add adds two numbers"]);
  assert.deepEqual(passedTitles(r, s, nested), [
    "label counts several findings",
    "label names one finding",
  ]);
  assert.deepEqual(
    inventoryOf(s, nested.context_id),
    counts(nested.context_id, { found: 2, run: 2, passed: 2 }),
  );
  assertNothingLeft(r);
});

test("node:test hooks, load failures and exiting files are Gate Findings and never-run tests", async (t) => {
  const original = copyProject(t, "node-test");
  writeFiles(original, {
    "test/hook.test.js":
      "'use strict';\n\nconst { describe, it, before } = require('node:test');\n\ndescribe('guarded', () => {\n  before(() => {\n    throw new Error('the test database is not reachable');\n  });\n  it('needs the database', () => {});\n  it('needs it too', () => {});\n});\n",
    "test/broken.test.js":
      "'use strict';\n\nconst missing = require('./does-not-exist');\n",
    "test/exits.test.js":
      "'use strict';\n\nconst { it } = require('node:test');\n\nit('quits the process', () => {\n  process.exit(3);\n});\nit('would run after', () => {});\n",
  });

  const r = await realRun(t, ["test", original, "--only", existing]);

  assert.equal(r.code, 1, r.stderr);
  const s = full(r);
  const e = oneExecution(s, existing);
  assert.equal(e.status, "completed");
  // By rule, and by rule and file for the file failures.
  const rules = new Map<string, Finding>();
  for (const f of findingsOf(s, existing)) {
    if (f.rule_id !== null) {
      rules.set(f.rule_id, f);
      rules.set(f.rule_id + " " + (f.locations[0]?.path ?? ""), f);
    }
  }
  const hook = rules.get("hook-failed");
  assert.ok(hook, JSON.stringify([...rules.keys()]));
  assert.ok(hook.gate);
  assert.ok(hook.message.includes("the test database is not reachable"));
  assert.equal(hook.locations[0]?.path, "test/hook.test.js");
  assert.equal(hook.locations[0].start?.line, 7);
  const load = rules.get("test-file-load-failed test/broken.test.js");
  assert.ok(load, JSON.stringify([...rules.keys()]));
  assert.ok(load.gate);
  assert.equal(load.locations[0]?.start?.line, 3);
  const evidence = load.evidence[0]?.text ?? "";
  assert.ok(evidence.includes("does-not-exist"), evidence);
  assert.ok(!evidence.includes("/work/"), evidence);
  assert.ok(
    rules.has("test-run-aborted test/exits.test.js"),
    `no finding for the file that quits the process: ${[...rules.keys()].join(", ")}`,
  );
  let never = 0;
  for (const c of testCasesOf(s, e.id)) {
    if (c.outcome !== "never_run") continue;
    never++;
    assert.ok((c.never_run_reason ?? "") !== "", c.full_title);
    if (c.full_title.startsWith("guarded")) {
      assert.ok(c.never_run_reason?.includes("before"), c.full_title);
      assert.deepEqual(c.finding_ids, [hook.id], c.full_title);
    }
  }
  assert.ok(never >= 2, `never-run cases = ${String(never)}`);
  assert.ok(
    s.limitations.some(
      (l) =>
        l.reason_code === "tests_not_counted" &&
        l.message.includes("test/broken.test.js"),
    ),
    JSON.stringify(s.limitations),
  );
  assertNothingLeft(r);
});
