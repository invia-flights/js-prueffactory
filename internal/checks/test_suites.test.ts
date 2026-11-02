// A package's tests are a list of suites (Go: test_suites_test.go,
// test_suites_names_test.go). These tests give the Checks a package with two
// suites and stub the run of each, so that the loop over the list is held to
// its contract; every record of a suite names the suite.
import assert from "node:assert/strict";
import { test } from "node:test";

import { background } from "../gocompat/context.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  StatusCompleted,
  StatusPartial,
  TestFailed,
} from "../resultset/types.ts";
import { newFinding, newTestCase } from "../resultset/zero.ts";
import { catalog } from "./catalog.ts";
import { resolve } from "./selection.ts";
import type { Input, Result } from "./input.ts";
import {
  nodeOptionsLimitation,
  runtimeWarningsID,
} from "./runtime_warnings.ts";
import { Shared } from "./shared.ts";
import { parseTestEvents } from "./test_events.ts";
import { suiteResults } from "./test_report.ts";
import {
  chainInput,
  endOfSuite,
  failedSub,
  finishedSuite,
  foundAdd,
  foundSub,
  limitationsOfCode,
  runTestsExisting,
  lines,
  passedAdd,
  stubSuites,
  suiteInput,
  twoSuiteInput,
} from "./test_report.testutil.ts";
import { sharedSuite } from "./tests_coverage.ts";
import { nativeBase, planMochaArgs, reporterPath } from "./tests_existing.ts";
import { overrideLimitations } from "./tests_existing_suite.ts";

const passedSuite = (input: Input): Result =>
  finishedSuite(
    input,
    parseTestEvents(lines(foundAdd, passedAdd, endOfSuite)),
    "",
    false,
  );

test("every suite of a package runs once in list order", async (t) => {
  const input = twoSuiteInput(t);
  const order = stubSuites(t, (i) => passedSuite(i));

  await runTestsExisting(input);
  // runtime.warnings reads the same run.
  await sharedSuite(background(), input);

  assert.equal(order.join(","), "mocha,node:test");
});

test("each suite gets container names of its own", (t) => {
  const input = twoSuiteInput(t);
  const first = input.forSuite(0).suiteSuffix();
  const second = input.forSuite(1).suiteSuffix();
  assert.equal(first, input.context.id.toLowerCase());
  assert.notEqual(second, first);
  assert.ok(second.startsWith(first));
});

test("suites that fail do not stop the ones after them", async (t) => {
  const input = twoSuiteInput(t);
  const order = stubSuites(t, (i, ran) =>
    ran === 0
      ? { status: StatusCompleted, findings: [newFinding({ gate: true })] }
      : passedSuite(i),
  );

  await runTestsExisting(input);

  assert.equal(order.length, 2);
});

test("tests.existing adds up the suites of a package", async (t) => {
  const input = twoSuiteInput(t);
  const id = input.context.id;
  const inventory = (
    found: number,
    passed: number,
    failed: number,
    file: string,
  ) => ({
    tests: [
      {
        context_id: id,
        found,
        run: found,
        passed,
        failed,
        skipped: 0,
        todo: 0,
        focused: 0,
        never_run: 0,
      },
    ],
    test_suites: [],
    test_files: [
      { context_id: id, suite: "", file, found, passed, passed_focused: 0 },
    ],
    suppressions: [],
    file_hashes: [],
    size: [],
    moved_test_files: [],
  });
  stubSuites(t, (_i, ran) => ({
    status: StatusCompleted,
    findings: [
      newFinding({
        title: ran === 0 ? "first suite finding" : "second suite finding",
      }),
    ],
    testCases: [{ testCase: newTestCase(), findings: [0] }],
    inventory:
      ran === 0
        ? inventory(2, 1, 1, "test/a.test.js")
        : inventory(3, 3, 0, "test/b.test.js"),
    limitations: [
      {
        reason_code: "test_command_override",
        message: "same",
        check_id: null,
        path: null,
      },
    ],
  }));

  const res = await runTestsExisting(input);

  assert.deepEqual(res.inventory?.tests, [
    {
      context_id: id,
      found: 5,
      run: 5,
      passed: 4,
      failed: 1,
      skipped: 0,
      todo: 0,
      focused: 0,
      never_run: 0,
    },
  ]);
  assert.equal(res.inventory.test_files.length, 2);
  assert.equal(res.findings?.length, 2);
  assert.deepEqual(
    res.testCases?.map((c) => c.findings),
    [[0], [1]],
    "test cases point at their own suite's Findings",
  );
  assert.equal(
    limitationsOfCode(res, "test_command_override").length,
    1,
    "a Limitation both suites share is listed once",
  );
  assert.equal(res.status, StatusCompleted);
});

test("the status of a package with several suites is the first one that did not complete", async (t) => {
  const input = twoSuiteInput(t);
  stubSuites(t, (_i, ran) =>
    ran === 1
      ? { status: StatusPartial, reasonCode: "out_of_memory", reason: "oom" }
      : { status: StatusCompleted },
  );

  const res = await runTestsExisting(input);

  assert.equal(res.status, StatusPartial);
  assert.equal(res.reasonCode, "out_of_memory");
});

/**
 * stubRealResults makes every suite report the same events the way
 * launchSuite does: through suiteResults.
 */
function stubRealResults(
  t: Parameters<typeof stubSuites>[0],
  events: string,
): void {
  stubSuites(t, (i) => {
    const suite = i.suite();
    assert.ok(suite);
    const sr = suiteResults(
      i,
      parseTestEvents(lines(foundAdd, foundSub, passedAdd, events, endOfSuite)),
      nativeBase(suite, planMochaArgs(suite.args, reporterPath)),
    );
    return {
      status: StatusCompleted,
      findings: sr.findings,
      testCases: sr.testCases,
      inventory: {
        tests: [sr.inventory],
        test_suites: [],
        test_files: sr.files,
        suppressions: [],
        file_hashes: [],
        size: [],
        moved_test_files: [],
      },
      limitations: overrideLimitations(
        i,
        suite,
        "general override",
        (arg) => `the argument ${arg} is dropped`,
        [],
      ),
    };
  });
}

test("test cases, Findings and Inventory rows name their suite", async (t) => {
  const input = chainInput(t);
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  assert.equal(res.findings?.length, 2);
  assert.equal(res.testCases?.length, 4);
  assert.deepEqual(
    res.findings.map((f) => f.suite),
    ["test:unit", "test:api"],
  );
  assert.deepEqual(
    res.testCases.map((c) => c.testCase.suite),
    ["test:unit", "test:unit", "test:api", "test:api"],
  );
  const rows = res.inventory?.test_suites ?? [];
  assert.equal(rows.length, 2);
  for (const [i, want] of ["test:unit", "test:api"].entries()) {
    const row = rows[i];
    assert.equal(row?.suite, want);
    assert.equal(row.found, 2);
    assert.equal(row.passed, 1);
    assert.equal(row.failed, 1);
    assert.equal(row.context_id, input.context.id);
  }
  const total = res.inventory?.tests ?? [];
  assert.equal(total.length, 1);
  assert.equal(total[0]?.found, 4);
  assert.equal(total[0].failed, 2);
  for (const f of res.inventory?.test_files ?? []) {
    assert.ok(
      f.suite === "test:unit" || f.suite === "test:api",
      JSON.stringify(f),
    );
  }
  assert.equal(
    res.inventory?.test_files.length,
    2,
    "a file two suites load is counted once per suite",
  );
});

test("the same failing test in two suites is two Findings", async (t) => {
  const input = chainInput(t);
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  assert.notDeepEqual(
    res.findings?.[0]?.fingerprint,
    res.findings?.[1]?.fingerprint,
  );
});

test("a package with one suite keeps its fingerprints and names the suite", async (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  input.shared = new Shared();
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  const f = res.findings?.[0];
  assert.deepEqual(
    f?.fingerprint,
    newFingerprint(
      "tests.existing",
      "test-failed",
      "test/add.test.js",
      "add subtracts",
    ),
  );
  assert.equal(f.suite, "scripts.test");
  assert.deepEqual(
    res.inventory?.test_suites.map((r) => r.suite),
    ["scripts.test"],
  );
  assert.equal(
    res.testCases?.find((c) => c.testCase.outcome === TestFailed)?.testCase
      .suite,
    "scripts.test",
  );
});

test("a chain says that every step ran, where, and stops at the first failure", async (t) => {
  const input = chainInput(t);
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  const got = limitationsOfCode(res, "test_chain_all_steps_run");
  assert.equal(got.length, 1);
  assert.ok((got[0]?.message ?? "").includes("&&"));
  assert.ok(
    (got[0]?.message ?? "").includes("`test:unit`, `test:api`"),
    got[0]?.message,
  );
});

test("a package with one suite has no chain Limitation", async (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  input.shared = new Shared();
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  assert.deepEqual(limitationsOfCode(res, "test_chain_all_steps_run"), []);
});

test("override Limitations are listed once per package with the suites they apply to", async (t) => {
  const input = chainInput(t);
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  const got = limitationsOfCode(res, "test_command_override");
  assert.equal(got.length, 1);
  assert.ok((got[0]?.message ?? "").includes("general override"));
  assert.ok((got[0]?.message ?? "").includes("`test:unit`, `test:api`"));
});

test("different overrides of two suites each name their suite", async (t) => {
  const input = chainInput(t);
  stubSuites(t, (i, ran) => {
    const suite = i.suite();
    assert.ok(suite);
    return {
      status: StatusCompleted,
      limitations: overrideLimitations(
        i,
        suite,
        "general override",
        (arg) => `the argument ${arg} is dropped`,
        [["--bail", "--reporter x"][ran] ?? ""],
      ),
    };
  });

  const res = await runTestsExisting(input);

  const dropped = limitationsOfCode(res, "test_command_override")
    .map((l) => l.message)
    .filter((m) => m.includes("is dropped"));
  assert.equal(dropped.length, 2);
  assert.ok((dropped[0] ?? "").includes("--bail"));
  assert.ok(
    (dropped[0] ?? "").endsWith("Applies to the suites: `test:unit`."),
    dropped[0],
  );
  assert.ok((dropped[1] ?? "").includes("--reporter x"));
  assert.ok(
    (dropped[1] ?? "").endsWith("Applies to the suites: `test:api`."),
    dropped[1],
  );
});

test("lint steps left out of the chain are listed", async (t) => {
  const input = chainInput(t);
  input.context.package?.tests?.leftOut.push({
    step: "eslint .",
    script: "test",
  });
  stubRealResults(t, failedSub);

  const res = await runTestsExisting(input);

  const got = limitationsOfCode(res, "test_step_left_out");
  assert.equal(got.length, 1);
  assert.ok((got[0]?.message ?? "").includes("eslint ."));
  assert.ok((got[0]?.message ?? "").includes("lint.existing"));
});

test("the NODE_OPTIONS override is listed once by tests.existing when both Checks are selected", async (t) => {
  const input = suiteInput(t, { "test/a.test.js": "x" });
  input.shared = new Shared();
  input.selection = resolve(
    catalog(),
    ["tests.existing", runtimeWarningsID],
    [],
  );
  stubSuites(t, (i) => {
    const res = passedSuite(i);
    res.limitations = [nodeOptionsLimitation(i, "tests.existing")];
    return res;
  });

  const res = await runTestsExisting(input);

  assert.equal(
    (res.limitations ?? []).filter((l) => l.message.includes("NODE_OPTIONS"))
      .length,
    1,
  );
});
