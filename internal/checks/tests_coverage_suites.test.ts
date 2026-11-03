// tests.coverage of a package with several suites: every suite writes raw
// coverage into one run-owned location, and one report over it is the
// Coverage of the package (Go: tests_coverage_suites_test.go).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ContainerSpec } from "../docker/driver.ts";
import { background } from "../gocompat/context.ts";
import {
  StatusCompleted,
  StatusInfrastructureError,
} from "../resultset/types.ts";
import type { Input, Result } from "./input.ts";
import {
  selectionWithout,
  stubSuites,
  twoSuiteInput,
} from "./test_report.testutil.ts";
import {
  allNullWithReason,
  metricsByName,
  stubCoverageStore,
  summaryTwoFiles,
} from "./tests_coverage.testutil.ts";
import {
  addCoverage,
  type CoverageRun,
  testsCoverageID,
  useCoverageHooks,
} from "./tests_coverage.ts";
import { testsExisting } from "./tests_existing.ts";
import { runCheck } from "./tests_flaky.testutil.ts";

const measured: CoverageRun = {
  unavailable: "",
  unavailableCode: "",
  summary: null,
  perFile: null,
};

const runTestsCoverage = (input: Input): Promise<Result> =>
  runCheck(testsCoverageID, input);

test("coverage of several suites is one report over the raw coverage of all of them", async (t) => {
  const input = twoSuiteInput(t);
  const seen = new Map<string, string>();
  stubSuites(t, (i) => {
    seen.set(i.suite()?.origin ?? "", i.coverageVolume);
    return { status: StatusCompleted, coverage: { ...measured } };
  });
  const n = stubCoverageStore(t, summaryTwoFiles);

  const res = await runTestsCoverage(input);

  assert.equal(
    res.status,
    StatusCompleted,
    `${res.reasonCode ?? ""} ${res.reason ?? ""}`,
  );
  assert.equal(res.reasonCode, undefined);
  assert.deepEqual(
    [n.volumes, n.reports],
    [1, 1],
    "one location and one report for the package",
  );
  assert.equal(seen.get("test:unit"), "coverage-volume");
  assert.equal(seen.get("test:api"), "coverage-volume");
  const lines = metricsByName(res.metrics ?? []).get("lines");
  assert.ok(lines?.value !== null && lines?.value !== undefined);
  assert.ok(lines.value > 61.5 && lines.value < 61.6, String(lines.value));
  assert.equal(lines.reason, null);
});

test("the suites are run and measured once whichever Check asks first", async (t) => {
  const input = twoSuiteInput(t);
  stubSuites(t, () => ({ status: StatusCompleted, coverage: { ...measured } }));
  const n = stubCoverageStore(t, summaryTwoFiles);

  await testsExisting.run(background(), input);
  await runTestsCoverage(input);

  assert.deepEqual([n.volumes, n.reports], [1, 1]);
});

test("without tests.coverage selected no location and no report are made", async (t) => {
  const input = twoSuiteInput(t);
  input.selection = selectionWithout(testsCoverageID);
  stubSuites(t, () => ({ status: StatusCompleted }));
  const n = stubCoverageStore(t, summaryTwoFiles);

  await testsExisting.run(background(), input);

  assert.deepEqual([n.volumes, n.reports], [0, 0]);
});

test("a coverage location that cannot be made is the reason of the Check", async (t) => {
  const input = twoSuiteInput(t);
  stubSuites(t, (i) => {
    const spec: ContainerSpec = { image: "x" };
    return { status: StatusCompleted, coverage: addCoverage(i, spec)[1] };
  });
  t.after(
    useCoverageHooks({
      createVolume: () => Promise.reject(new Error("boom")),
    }),
  );
  input.toolsetVolume = "toolset";

  const res = await runTestsCoverage(input);

  assert.equal(res.status, StatusInfrastructureError);
  assert.equal(res.reasonCode, "coverage_location_unavailable");
  assert.ok(res.reason?.includes("boom"), res.reason);
  assert.equal(res.metrics, undefined);
});

test("a suite that did not run is named in the note of the coverage", async (t) => {
  const input = twoSuiteInput(t);
  stubSuites(t, (_i, ran): Result => {
    if (ran === 1) {
      return {
        status: StatusInfrastructureError,
        reasonCode: "service_not_ready",
        reason: "Service db did not come up",
      };
    }
    return { status: StatusCompleted, coverage: { ...measured } };
  });
  stubCoverageStore(t, summaryTwoFiles);

  const res = await runTestsCoverage(input);

  assert.equal(res.metrics?.length, 3);
  for (const m of res.metrics ?? []) {
    assert.notEqual(m.value, null, m.name);
    assert.ok(
      m.reason?.includes("test:api did not run its tests"),
      `${m.name}: ${String(m.reason)}`,
    );
  }
});

test("when no suite reached its tests there is no report to build", async (t) => {
  const input = twoSuiteInput(t);
  stubSuites(t, () => ({
    status: StatusInfrastructureError,
    reasonCode: "service_not_ready",
    reason: "Service db did not come up",
  }));
  const n = stubCoverageStore(t, summaryTwoFiles);

  const res = await runTestsCoverage(input);

  assert.equal(n.reports, 0);
  allNullWithReason(res.metrics, "did not run");
});

test("addCoverage wraps the runner and mounts c8 and the shared volume only for a first run", (t) => {
  const input = twoSuiteInput(t);
  input.toolsetVolume = "toolset-volume";
  input.coverageVolume = "coverage-volume";
  const spec: ContainerSpec = { image: "x", cmd: ["node", "runner.js"] };

  const [wrapped, cov] = addCoverage(input, spec);

  assert.deepEqual(cov, measured);
  assert.deepEqual(wrapped.cmd?.slice(0, 5), [
    "node",
    "/toolset/node_modules/c8/bin/c8.js",
    "--config",
    "/jspf/c8.json",
    "--",
  ]);
  assert.deepEqual(wrapped.mounts, [
    { volume: "toolset-volume", path: "/toolset", readOnly: true },
    { volume: "coverage-volume", path: "/jspf-cov" },
  ]);
  assert.equal(wrapped.files?.[0]?.path, "/jspf/c8.json");

  const repeated = input.forSuite(0);
  repeated.repeat = { checkID: "tests.flaky", number: 2, nodeOptions: "" };
  const [same, none] = addCoverage(repeated, spec);
  assert.equal(none, null);
  assert.equal(same, spec);
});

test("addCoverage says why c8 cannot wrap the run", (t) => {
  const input = twoSuiteInput(t);
  const spec: ContainerSpec = { image: "x" };

  input.toolsetError = "no toolset";
  let [, cov] = addCoverage(input, spec);
  assert.deepEqual(cov, {
    ...measured,
    unavailable: "the toolset volume with c8 could not be prepared: no toolset",
  });

  input.toolsetVolume = "toolset";
  [, cov] = addCoverage(input, spec);
  assert.deepEqual(cov, {
    ...measured,
    unavailable: "there is no volume for the raw coverage",
    unavailableCode: "coverage_location_unavailable",
  });
});
