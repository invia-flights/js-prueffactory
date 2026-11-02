// How tests.coverage ends from what the suite's one run left behind. A number
// is only ever reported when c8 wrote one (Go: tests_coverage_result_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Finding,
  type Inventory,
  StatusCompleted,
  StatusInfrastructureError,
  StatusPartial,
  StatusTimedOut,
  StatusToolError,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import type { Input, Result } from "./input.ts";
import { suiteInput } from "./test_report.testutil.ts";
import {
  allNullWithReason,
  summaryTwoFiles,
} from "./tests_coverage.testutil.ts";
import {
  type CoverageRun,
  coverageResult,
  suiteNote,
} from "./tests_coverage.ts";

function coverageInput(t: Parameters<typeof suiteInput>[0]): Input {
  return suiteInput(t, { "src/index.js": "x" });
}

const run = (fields: Partial<CoverageRun> = {}): CoverageRun => ({
  unavailable: "",
  unavailableCode: "",
  summary: null,
  perFile: null,
  ...fields,
});

test("coverage of an unsupported suite is unsupported with the same reason", (t) => {
  const suite: Result = {
    status: StatusUnsupported,
    reasonCode: "test_runner_not_implemented",
    reason: "Jest is not supported",
  };

  const got = coverageResult(coverageInput(t), suite);

  assert.equal(got.status, StatusUnsupported);
  assert.equal(got.reasonCode, "test_runner_not_implemented");
  assert.equal(got.reason, "Jest is not supported");
  assert.equal(got.metrics, undefined);
});

test("coverage without the toolset is an infrastructure error and has no numbers", (t) => {
  const suite: Result = {
    status: StatusCompleted,
    coverage: run({
      unavailable: "the toolset volume with c8 could not be prepared: boom",
    }),
  };

  const got = coverageResult(coverageInput(t), suite);

  assert.equal(got.status, StatusInfrastructureError);
  assert.equal(got.reasonCode, "toolset_unavailable");
  assert.ok(got.reason?.includes("boom"));
  assert.equal(got.metrics, undefined);
});

test("coverage of a suite that never started has null metrics and the status of the suite", (t) => {
  const gate: Finding = newFinding({
    gate: true,
    title: "test runner not installed",
  });
  let got = coverageResult(coverageInput(t), {
    status: StatusCompleted,
    findings: [gate],
  });
  assert.equal(got.status, StatusCompleted);
  assert.equal(got.reasonCode, undefined);
  allNullWithReason(got.metrics, "test runner not installed");

  got = coverageResult(coverageInput(t), {
    status: StatusInfrastructureError,
    reasonCode: "service_not_ready",
    reason: "Service db did not come up",
  });
  assert.equal(got.status, StatusInfrastructureError);
  assert.equal(got.reasonCode, "service_not_ready");
  allNullWithReason(got.metrics, "Service db did not come up");
});

test("coverage of a run that timed out is timed out with null metrics", (t) => {
  const got = coverageResult(coverageInput(t), {
    status: StatusTimedOut,
    reasonCode: "timeout",
    reason: "the Check ran into its time limit",
    coverage: run(),
  });

  assert.equal(got.status, StatusTimedOut);
  assert.equal(got.reasonCode, "timeout");
  allNullWithReason(got.metrics, "did not finish");
});

test("coverage that c8 did not write after a finished run is a tool error with null metrics", (t) => {
  const got = coverageResult(coverageInput(t), {
    status: StatusCompleted,
    coverage: run(),
  });

  assert.equal(got.status, StatusToolError);
  assert.equal(got.reasonCode, "no_coverage_output");
  allNullWithReason(got.metrics, "no coverage report");
});

test("coverage output that cannot be read is a tool error with null metrics", (t) => {
  const got = coverageResult(coverageInput(t), {
    status: StatusCompleted,
    coverage: run({ summary: Buffer.from("{") }),
  });

  assert.equal(got.status, StatusToolError);
  assert.equal(got.reasonCode, "coverage_output_unreadable");
  allNullWithReason(got.metrics, "not readable");
});

test("coverage of a suite that stopped early is measured and says so", (t) => {
  const got = coverageResult(coverageInput(t), {
    status: StatusPartial,
    reasonCode: "out_of_memory",
    reason: "the test process ran out of memory",
    coverage: run({ summary: Buffer.from(summaryTwoFiles) }),
  });

  assert.equal(got.status, StatusCompleted);
  assert.equal(got.metrics?.length, 3);
  assert.equal(got.artifacts?.length, 1);
  for (const m of got.metrics ?? []) {
    assert.notEqual(m.value, null, m.name);
    assert.ok(
      m.reason?.includes("did not finish"),
      `${m.name}: ${String(m.reason)}`,
    );
  }
});

test("a measured run keeps c8 as the Tool with the runner's exit code, records c8 in the Context and names the artifact after the Context", (t) => {
  const input = coverageInput(t);
  const got = coverageResult(input, {
    status: StatusCompleted,
    tool: { name: "mocha", version: "11.0.0", exit_code: 3 },
    coverage: run({ summary: Buffer.from(summaryTwoFiles) }),
  });

  assert.equal(got.tool?.name, "c8");
  assert.equal(got.tool.exit_code, 3);
  assert.equal(got.contextTools?.[0]?.name, "c8");
  assert.ok(got.contextTools[0].digest?.startsWith("sha512-"));
  assert.equal(
    got.artifacts?.[0]?.path,
    `artifacts/tests.coverage/${input.context.id}-files.json`,
  );
  assert.equal(got.artifacts[0].media_type, "application/json");
});

test("the note of a failing suite counts failed tests and mentions other failures", () => {
  const gate = newFinding({ gate: true });
  const failed = (n: number): Inventory =>
    ({ tests: [{ failed: n }] }) as unknown as Inventory;
  const cases: [string, Result, string][] = [
    ["nothing wrong", { status: StatusCompleted }, ""],
    [
      "one test",
      { status: StatusCompleted, inventory: failed(1), findings: [gate] },
      "1 test failed",
    ],
    [
      "three tests",
      { status: StatusCompleted, inventory: failed(3) },
      "3 tests failed",
    ],
    [
      "a hook or a file that does not load",
      { status: StatusCompleted, findings: [gate] },
      "failed hook",
    ],
  ];
  for (const [name, suite, want] of cases) {
    const got = suiteNote(suite);
    if (want === "") {
      assert.equal(got, "", name);
    } else {
      assert.ok(got.includes(want), `${name}: note ${got} should hold ${want}`);
    }
  }
});
