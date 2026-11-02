// The node:test run of tests.existing (Go: tests_existing_nodetest.go).
import { readFileSync } from "node:fs";

import {
  parseNodeTestArgs,
  RunnerNodeTest,
  type Suite,
} from "../discovery/discovery.ts";
import { quote } from "../resultset/quote.ts";
import { type Limitation, StatusCompleted } from "../resultset/types.ts";
import type { Input, Result } from "./input.ts";
import type { SuiteEvents } from "./test_events.ts";
import { testFile } from "./test_report.ts";
import {
  containerText,
  stopFinding,
  testsExistingID,
} from "./tests_existing.ts";
import {
  finishSuite,
  launchSuite,
  nativeEnvPrefix,
  overrideLimitations,
} from "./tests_existing_suite.ts";

/**
 * nodeTestReporterScript is js/node-test-reporter.js, byte for byte as Go
 * embeds it.
 */
export const nodeTestReporterScript = readFileSync(
  new URL("js/node-test-reporter.js", import.meta.url),
);

/** nodeTestReporterPath is where our reporter lies in the test container. */
export const nodeTestReporterPath = "/jspf/node-test-reporter.js";

/** NodeTestPlan is how the project's `node --test` arguments turn into a run. */
export interface NodeTestPlan {
  /**
   * args are the arguments of the run, after `node`: the project's, without
   * its reporters, plus ours.
   */
  args: string[];
  /**
   * nativeOptions are the project's options for re-running one test: its
   * own, without its test files, without the ones we replaced and without
   * name patterns, because the one test's pattern is added and patterns add
   * up.
   */
  nativeOptions: string[];
  /** overrides lists the project's arguments that were removed. */
  overrides: string[];
}

/**
 * planNodeTestArgs keeps the project's arguments, takes out its reporters
 * and their destinations, which would otherwise have to pair up with ours,
 * and adds our reporter through --test-reporter and
 * --test-reporter-destination. The reporter writes its events to the file
 * the JSPF_EVENTS variable names; the destination only carries the output
 * of the tests, which ends up in the suite's log.
 */
export function planNodeTestArgs(
  args: readonly string[],
  reporter: string,
): NodeTestPlan {
  const p: NodeTestPlan = { args: [], nativeOptions: [], overrides: [] };
  const ours = [
    "--test-reporter=" + reporter,
    "--test-reporter-destination=stdout",
  ];
  let inserted = false;
  const insert = (): void => {
    if (!inserted) {
      p.args.push(...ours);
      inserted = true;
    }
  };
  for (const a of parseNodeTestArgs(args)) {
    if (a.name === "test-reporter" || a.name === "test-reporter-destination") {
      p.overrides.push(a.words.join(" "));
      continue;
    }
    // Node reads its options only up to the first test file or `--`: what
    // follows is for the test files. Our reporter has to come before.
    if (a.file || a.name === "--") {
      insert();
    }
    p.args.push(...a.words);
    if (a.file || a.name === "--") {
      continue;
    }
    if (a.name !== "test-name-pattern" && a.name !== "test-skip-pattern") {
      p.nativeOptions.push(...a.words);
    }
  }
  insert();
  return p;
}

/**
 * runNodeTest runs a package whose test script is `node … --test …`: the
 * project's own arguments, with our reporter in place of its reporters.
 * Node itself is the runner, so there is nothing to probe or to install,
 * and the version is the Context's. The caller has already checked that the
 * project's test Services can be started; the suite gets its own, as the
 * Mocha path does.
 *
 * The events are the same as the Mocha reporter's, so they become the same
 * test cases, Findings and counts (suiteResults).
 */
export async function runNodeTest(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const res: Result = { status: StatusCompleted };
  const tc = input.suite();
  if (tc === null) {
    return res;
  }
  const plan = planNodeTestArgs(tc.args, nodeTestReporterPath);
  const launched = await launchSuite(signal, input, res, {
    cmd: ["node", ...plan.args],
    native: nodeTestNativeBase(tc, plan),
    overrides: nodeTestOverrides(input, tc, plan),
    reporterPath: nodeTestReporterPath,
    reporter: nodeTestReporterScript,
    eventLimitations: (ev) => nodeTestCountLimitations(input, tc, ev),
  });
  if (launched.done !== null) {
    return launched.done;
  }
  const { c, ev } = launched;

  const exit = c.exitCode;
  res.tool = {
    name: RunnerNodeTest,
    version: input.context.node?.version ?? "",
    exit_code: exit,
  };
  const text = containerText(c);
  finishSuite(input, res, ev, c, {
    noEvents:
      "node exited without running our reporter or writing any event; the project's arguments may make it print and stop, as --help does",
    notStarted: () => [
      [
        stopFinding(
          input,
          "test-run-did-not-start",
          "node --test stops before it runs any test",
          `node stopped before it ran any test, and the usual cause is an option or a module the project's command names that node cannot use. Its exit code was ${String(exit)}.`,
          c,
          text,
        ),
      ],
      [],
    ],
    aborted: () =>
      stopFinding(
        input,
        "test-run-aborted",
        "The test process stops before the suite is finished",
        `The test process exited with code ${String(exit)} before node --test finished. The tests not yet run are reported as never run.`,
        c,
        text,
      ),
  });
  return res;
}

/**
 * nodeTestNativeBase is the start of the command that re-runs one test with
 * the project's own tools: its environment variables, node and its options.
 */
export function nodeTestNativeBase(tc: Suite, plan: NodeTestPlan): string[] {
  return [...nativeEnvPrefix(tc), "node", ...plan.nativeOptions];
}

/**
 * nodeTestOverrides lists every way the run differs from the project's own
 * command, so nobody mistakes the Report for a run of `npm test`.
 */
function nodeTestOverrides(
  input: Input,
  tc: Suite,
  plan: NodeTestPlan,
): Limitation[] {
  return overrideLimitations(
    input,
    tc,
    "node --test runs with js-prueffactory's own reporter, which records every test, through --test-reporter and --test-reporter-destination.",
    (arg) =>
      `The project's argument ${arg} is not passed on, because the reporter is ours.`,
    plan.overrides,
  );
}

/**
 * nodeTestCountLimitations says where the counts of a node:test run cannot
 * be complete: tests that node leaves out before our reporter sees them, and
 * the tests of files that did not load.
 */
export function nodeTestCountLimitations(
  input: Input,
  tc: Suite,
  ev: SuiteEvents,
): Limitation[] {
  const manifest = input.manifestPath();
  const out: Limitation[] = [];
  for (const a of parseNodeTestArgs(tc.args)) {
    if (
      a.name === "test-only" ||
      a.name === "test-name-pattern" ||
      a.name === "test-skip-pattern"
    ) {
      out.push({
        reason_code: "test_counts_lower_bound",
        message: `The project's argument ${quote(a.words[0] ?? "")} makes node leave out tests before the reporter sees them, so the counts of found and never-run tests are lower bounds.`,
        check_id: testsExistingID,
        path: manifest,
      });
      break;
    }
  }
  for (const f of ev.files) {
    if (ev.testsOf(f.file) === 0) {
      out.push({
        reason_code: "tests_not_counted",
        message: `The test file ${testFile(f.file)} reported no test before its process failed, so its tests are not counted.`,
        check_id: testsExistingID,
        path: manifest,
      });
    }
  }
  return out;
}
