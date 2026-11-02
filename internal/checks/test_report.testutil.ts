// Seam B helpers for the test runner step (Go: the helpers of
// test_report_test.go, test_suites_test.go, service_not_started_test.go and
// runtime_warnings_check_test.go): the event lines our reporters write go
// in, test cases, Findings and Inventory counts come out.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  discover,
  newSuite,
  RunnerMocha,
  RunnerNodeTest,
} from "../discovery/discovery.ts";
import { background } from "../gocompat/context.ts";
import type { Finding, Limitation } from "../resultset/types.ts";
import { StatusCompleted } from "../resultset/types.ts";
import { writeTree } from "./checks.testutil.ts";
import { Input, type Result, type SuiteTestCase } from "./input.ts";
import { useRunTestSuite } from "./runtime_warnings.ts";
import { Shared } from "./shared.ts";
import { parseTestEvents, type SuiteEvents } from "./test_events.ts";
import { type SuiteResults, suiteResults } from "./test_report.ts";
import { testsExisting } from "./tests_existing.ts";

/**
 * suiteInput is an Input for a package at the project root, with the given
 * project files in its Snapshot copy and a Mocha test script unless the
 * files bring their own package.json.
 */
export function suiteInput(
  t: TestContext,
  files: Record<string, string>,
): Input {
  const all = { "package.json": `{"scripts":{"test":"mocha"}}`, ...files };
  const root = writeTree(t, all);
  const proj = discover(root);
  const context = proj.contexts[1];
  assert.ok(context);
  return new Input({
    project: proj,
    context,
    originalPath: "/orig",
    snapshotDir: root,
  });
}

/** nodeTestInput is a package that runs `node --test`. */
export function nodeTestInput(
  t: TestContext,
  files: Record<string, string>,
): Input {
  return suiteInput(t, {
    ...files,
    "package.json": `{"scripts":{"test":"node --test"}}`,
  });
}

/** lines is an event file of the lines. */
export function lines(...l: string[]): Buffer {
  return Buffer.from(l.join("\n") + "\n");
}

export const foundAdd = `{"ev":"found","id":1,"file":"/work/test/add.test.js","title":"adds","fullTitle":"add adds","suitePath":["add"]}`;
export const foundSub = `{"ev":"found","id":2,"file":"/work/test/add.test.js","title":"subtracts","fullTitle":"add subtracts","suitePath":["add"]}`;
export const passedAdd = `{"ev":"result","id":1,"outcome":"passed","duration":3}`;
export const passedSub = `{"ev":"result","id":2,"outcome":"passed","duration":4}`;
export const failedSub = `{"ev":"result","id":2,"outcome":"failed","duration":5,"err":{"name":"AssertionError","message":"Expected values to be strictly equal:\\n\\n5 !== 6\\n","expected":"6","actual":"5","stack":"AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\\n\\n5 !== 6\\n\\n    at Context.<anonymous> (/work/test/add.test.js:9:12)\\n    at process.processImmediate (node:internal/timers:485:21)"}}`;
export const endOfSuite = `{"ev":"end"}`;

export const mochaNative = ["npx", "mocha"];
export const nodeNative = ["node", "--test"];

/** runTestsExisting is the Run of tests.existing in the Input's Context. */
export async function runTestsExisting(input: Input): Promise<Result> {
  const res = await testsExisting.run?.(background(), input);
  assert.ok(res);
  return res;
}

/** results is suiteResults over the event lines. */
export function results(
  input: Input,
  native: readonly string[],
  ...events: string[]
): SuiteResults {
  return suiteResults(input, parseTestEvents(lines(...events)), native);
}

export function findingOf(r: { findings?: Finding[] }, rule: string): Finding {
  const f = (r.findings ?? []).find((x) => x.rule_id === rule);
  assert.ok(f, `no ${rule} Finding in ${JSON.stringify(r.findings)}`);
  return f;
}

export function caseOf(
  r: { testCases?: SuiteTestCase[] },
  title: string,
): SuiteTestCase {
  const c = (r.testCases ?? []).find((x) => x.testCase.full_title === title);
  assert.ok(c, `no test case ${title}`);
  return c;
}

export function limitationsOfCode(
  res: { limitations?: Limitation[] },
  code: string,
): Limitation[] {
  return (res.limitations ?? []).filter((l) => l.reason_code === code);
}

/**
 * stubSuites replaces the run of one suite with a function of the suite the
 * Input is bound to and how many ran before, and records which runners
 * ran, in order. The real run comes back when the test ends.
 */
export function stubSuites(
  t: TestContext,
  run: (input: Input, ran: number) => Result,
): string[] {
  const order: string[] = [];
  const restore = useRunTestSuite((_signal, input) => {
    order.push(input.suite()?.runner ?? "");
    return Promise.resolve(run(input, order.length - 1));
  });
  t.after(restore);
  return order;
}

/** stubSuite replaces the test run with a canned result and counts the runs. */
export function stubSuite(t: TestContext, res: Result): { calls: number } {
  const counter = { calls: 0 };
  const restore = useRunTestSuite(() => {
    counter.calls++;
    return Promise.resolve(res);
  });
  t.after(restore);
  return counter;
}

/** finishedSuite is the result of a suite that ran to its end. */
export function finishedSuite(
  input: Input,
  ev: SuiteEvents,
  stderr: string,
  hung: boolean,
): Result {
  return {
    status: StatusCompleted,
    command: ["node", "x"],
    suite: {
      selected: true,
      stderr: Buffer.from(stderr),
      events: ev,
      hung,
      runner: input.suite()?.runner ?? RunnerMocha,
    },
  };
}

/** twoSuiteInput is a package with a Mocha suite and a node:test suite. */
export function twoSuiteInput(t: TestContext): Input {
  const input = suiteInput(t, { "test/a.test.js": "x", "src/index.js": "x" });
  input.shared = new Shared();
  const pkg = input.context.package;
  assert.ok(pkg?.tests);
  pkg.tests.suites = [
    newSuite({ runner: RunnerMocha, args: ["test/unit"], origin: "test:unit" }),
    newSuite({
      runner: RunnerNodeTest,
      args: ["--test", "test/api"],
      origin: "test:api",
    }),
  ];
  return input;
}

/** chainInput is a package that runs two Mocha suites, one per npm script. */
export function chainInput(t: TestContext): Input {
  const input = suiteInput(t, { "test/a.test.js": "x", "src/index.js": "x" });
  input.shared = new Shared();
  const pkg = input.context.package;
  assert.ok(pkg?.tests);
  pkg.tests.script = "npm run test:unit && npm run test:api";
  pkg.tests.suites = [
    newSuite({
      runner: RunnerMocha,
      args: ["--config", "test/config/mocha-unit.js"],
      origin: "test:unit",
    }),
    newSuite({
      runner: RunnerMocha,
      args: ["--config", "test/config/mocha-api.js"],
      origin: "test:api",
    }),
  ];
  return input;
}
