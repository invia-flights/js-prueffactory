// Seam B for the Checks that repeat the runs of a suite (tests.flaky and
// runtime.unhandled-rejections): what the runs of a suite leave behind goes
// in, the Check's Result comes out. The containers are stubbed
// (useRunTestSuite); the Docker tests of the cli package cover the real runs
// (Go: the helpers of tests_flaky_test.go and
// runtime_unhandled_rejections_test.go).
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { background } from "../gocompat/context.ts";
import type { Finding } from "../resultset/types.ts";
import { StatusTimedOut } from "../resultset/types.ts";
import { type Check, implementation } from "./check.ts";
import type { Input, Result } from "./input.ts";
import { useRunTestSuite } from "./runtime_warnings.ts";
import { Shared } from "./shared.ts";
import { parseTestEvents } from "./test_events.ts";
import {
  endOfSuite,
  finishedSuite,
  foundAdd,
  foundSub,
  lines,
  suiteInput,
} from "./test_report.testutil.ts";

export const failedAdd = `{"ev":"result","id":1,"outcome":"failed","duration":5,"err":{"name":"Error","message":"counter was 2 and not 1","stack":"Error: counter was 2 and not 1\\n    at Context.<anonymous> (/work/test/add.test.js:11:5)"}}`;
export const retryAdd = `{"ev":"retry","id":1,"duration":4,"err":{"name":"Error","message":"socket hang up"}}`;
export const skippedAd = `{"ev":"result","id":1,"outcome":"skipped","duration":0}`;
export const todoAdd = `{"ev":"result","id":1,"outcome":"todo","duration":0}`;
export const skippedSub = `{"ev":"result","id":2,"outcome":"skipped","duration":0}`;

/**
 * suiteRunWith is the Result of one finished run of a suite that found the
 * two tests of add.test.js and recorded the given result lines.
 */
export function suiteRunWith(input: Input, ...results: string[]): Result {
  return finishedSuite(
    input,
    parseTestEvents(lines(foundAdd, foundSub, ...results, endOfSuite)),
    "",
    false,
  );
}

/** cutRunWith is a run the Check's time limit stopped: no end event. */
export function cutRunWith(input: Input, ...results: string[]): Result {
  const r = finishedSuite(
    input,
    parseTestEvents(lines(foundAdd, foundSub, ...results)),
    "",
    false,
  );
  r.status = StatusTimedOut;
  r.reasonCode = "timeout";
  return r;
}

/** untilAborted waits until the signal ends, like a real container that runs into its limit. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });
}

/**
 * stubRuns replaces the run of a suite with a function of the run's number:
 * 1 is the shared first run, 2 and 3 are the repeats. It records the runs as
 * "suite#number" in order.
 */
export function stubRuns(
  t: TestContext,
  run: (
    input: Input,
    number: number,
    signal: AbortSignal,
  ) => Result | Promise<Result>,
): string[] {
  const order: string[] = [];
  const restore = useRunTestSuite(async (signal, input) => {
    const n = input.repeat?.number ?? 1;
    order.push(`${input.suite()?.origin ?? ""}#${String(n)}`);
    return run(input, n, signal);
  });
  t.after(restore);
  return order;
}

/** threeRuns gives the Result of each of the three runs of a one-suite package. */
export function threeRuns(
  t: TestContext,
  first: (input: Input) => Result,
  second: (input: Input) => Result,
  third: (input: Input) => Result,
): string[] {
  return stubRuns(
    t,
    (input, n) =>
      [first, second, third][n - 1]?.(input) ?? {
        status: StatusTimedOut,
      },
  );
}

export function flakyInput(t: TestContext): Input {
  const input = suiteInput(t, {
    "test/add.test.js": "x",
    "src/index.js": "x",
  });
  input.shared = new Shared();
  return input;
}

export const ruleOf = (f: Finding): string => f.rule_id ?? "";

export function flakyFindings(res: Result): Finding[] {
  return (res.findings ?? []).filter((f) => ruleOf(f) === "flaky-test");
}

export function metricValue(res: Result, name: string): number {
  const m = (res.metrics ?? []).find((x) => x.name === name);
  assert.ok(m?.value !== null && m?.value !== undefined, `no metric ${name}`);
  return m.value;
}

/** checkOf is the registered Check of an ID. */
export function checkOf(id: string): Check {
  const c = implementation(id);
  assert.ok(c, `${id} is not registered`);
  return c;
}

/** runCheck is the Run of a Check in the Input's Context. */
export async function runCheck(
  id: string,
  input: Input,
  signal: AbortSignal = background(),
): Promise<Result> {
  const res = await checkOf(id).run?.(signal, input);
  assert.ok(res, `${id} has no run`);
  return res;
}

// rejectedAdd is how the strict run reports a test whose floating promise
// rejected: the uncaught exception fails the test that was running.
export const rejectedAdd = `{"ev":"result","id":1,"outcome":"failed","duration":4,"err":{"name":"Error","message":"connection refused","stack":"Error: connection refused\\n    at fetchUser (/work/src/user.js:7:11)\\n    at Context.<anonymous> (/work/test/add.test.js:12:5)"}}`;
export const hookFailed = `{"ev":"hook_fail","title":"\\"after each\\" hook","hookType":"after each","scope":"add","scopePath":["add"],"file":"/work/test/add.test.js","err":{"name":"Error","message":"connection refused"}}`;
export const crashStderr =
  "/work/src/user.js:7\n    throw new Error('connection refused');\n    ^\n\nError: connection refused\n    at fetchUser (/work/src/user.js:7:11)\n\nNode.js v22.11.0\n";

/** crashedRun is a run whose process died after the first test: no end event. */
export function crashedRun(input: Input, ...results: string[]): Result {
  const r = finishedSuite(
    input,
    parseTestEvents(lines(foundAdd, foundSub, ...results)),
    crashStderr,
    false,
  );
  r.tool = { name: "mocha", version: null, exit_code: 1 };
  return r;
}
