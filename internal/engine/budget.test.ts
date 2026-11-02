import assert from "node:assert/strict";
import { test } from "node:test";

import { withCancel, withTimeout } from "../gocompat/context.ts";
import { minute } from "../gocompat/time.ts";
import {
  StatusBudgetExhausted,
  StatusCancelled,
  StatusTimedOut,
} from "../resultset/types.ts";
import {
  endReason,
  isTestSuite,
  parallelism,
  reserveStart,
  timeLimit,
} from "./budget.ts";

test("parallelism is half the daemon CPUs, up to four and at least one", () => {
  // Go: TestParallelismIsHalfTheDaemonCPUsUpToFourAndAtLeastOne
  const want = new Map([
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [6, 3],
    [8, 4],
    [9, 4],
    [64, 4],
  ]);
  for (const [cpus, n] of want) {
    assert.equal(parallelism(cpus), n, `parallelism(${String(cpus)})`);
  }
});

test("time limits", () => {
  // Go: TestTimeLimits, TestTheChecksThatRunTheRegistryDataStepHaveFiveMinutes
  assert.equal(timeLimit("package.install"), 15n * minute);
  assert.equal(timeLimit("tests.existing"), 30n * minute);
  assert.equal(timeLimit("syntax.parse"), 10n * minute);
  assert.equal(timeLimit("lint.existing"), 10n * minute);
  assert.equal(timeLimit("deps.deprecated"), 5n * minute);
  assert.equal(timeLimit("deps.outdated"), 5n * minute);
  assert.equal(timeLimit("tests.flaky"), 24n * 60n * minute);
  for (const id of [
    "tests.existing",
    "tests.coverage",
    "runtime.warnings",
    "tests.flaky",
    "runtime.unhandled-rejections",
  ]) {
    assert.ok(isTestSuite(id), id);
  }
  assert.ok(!isTestSuite("package.install"));
});

test("work ends when the reserve starts, sixty seconds before the Budget ends", () => {
  // Go: TestWorkEndsWhenTheReserveStartsSixtySecondsBeforeTheBudgetEnds
  const start = new Date(Date.UTC(2026, 9, 25, 10, 0, 0));
  assert.equal(
    reserveStart(start, 30n * minute),
    start.getTime() + 29 * 60_000,
  );
});

test("why an execution ended", async () => {
  // Go: TestWhyAnExecutionEnded
  const run = withCancel();
  const budget = withCancel(run.signal);
  const own = withTimeout(budget.signal, 1n);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(endReason(run.signal, budget.signal, own.signal), StatusTimedOut);
  budget.cancel();
  assert.equal(
    endReason(run.signal, budget.signal, own.signal),
    StatusBudgetExhausted,
  );
  run.cancel();
  assert.equal(
    endReason(run.signal, budget.signal, own.signal),
    StatusCancelled,
  );
  const fresh = withCancel();
  assert.equal(endReason(fresh.signal, fresh.signal, fresh.signal), null);
});
