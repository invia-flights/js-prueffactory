// runtime.warnings (Go: runtime_warnings.go) and what every first run of a
// suite records for it. Ticket 14 of the port brings the parts of the suite
// run (runTestSuite, recordSuiteRun, addWarningsEnv, suiteRunOf); ticket 15
// adds the Check's own reading of the run.
import { randomBytes } from "node:crypto";

import type { ContainerResult, EndMarker } from "../docker/driver.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { type Limitation, NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import { selected } from "./selection.ts";
import type { SuiteEvents } from "./test_events.ts";
import { runnerName } from "./test_report.ts";
import {
  runSuite,
  testRunApplicability,
  testsExistingID,
} from "./tests_existing.ts";

export const runtimeWarningsID = "runtime.warnings";

// runtimeWarnings reads deprecations, Node warnings and open resources from
// the test run. The run arrives with ticket 15 of the port.
export const runtimeWarnings: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "runtime.warnings reads the test run of a package, and this is the project Context",
      ];
    }
    if (c.package.tests === null) {
      return [
        NotApplicable,
        "the package has no test script and no Mocha config file, so there is no test run to read",
      ];
    }
    return testRunApplicability(c.package);
  },
};

register(runtimeWarningsID, runtimeWarnings);

/**
 * exitGraceMs is how long the test process gets to exit after the reporter
 * wrote its end event (Go: exitGrace, 30 seconds).
 */
export const exitGraceMs = 30_000;

/**
 * warningFlags are what the Check adds to NODE_OPTIONS, after any value from
 * the test command. They only make Node say more: where a warning came from
 * and which deprecations are coming.
 */
export const warningFlags =
  "--trace-warnings --trace-deprecation --pending-deprecation";

/** SuiteRun is what a test run left for the Checks that read the same run. */
export interface SuiteRun {
  /** selected is true when runtime.warnings is selected and the flags were added. */
  selected: boolean;
  /** stderr is what the run printed to stderr, as bytes (Go kept them raw). */
  stderr: Buffer;
  events: SuiteEvents;
  /**
   * hung is true when the process stayed alive for the whole grace period
   * after the end event and the container was stopped.
   */
  hung: boolean;
  runner: string;
}

/** SuiteRunner performs the run of one suite, the one the Input is bound to. */
export type SuiteRunner = (
  signal: AbortSignal,
  input: Input,
) => Promise<Result>;

let suiteRunner: SuiteRunner = (signal, input) => runSuite(signal, input);

/**
 * runTestSuite performs the run of the project's test suite, for
 * sharedSuite and the repeat runs. Tests replace it with useRunTestSuite.
 */
export function runTestSuite(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  return suiteRunner(signal, input);
}

/**
 * useRunTestSuite replaces the run of a suite (Go tests assign
 * runTestSuite) and returns the function that restores it.
 */
export function useRunTestSuite(fn: SuiteRunner): () => void {
  const old = suiteRunner;
  suiteRunner = fn;
  return () => {
    suiteRunner = old;
  };
}

/** warningsSelected says whether runtime.warnings is in the Selection. */
function warningsSelected(input: Input): boolean {
  return (
    input.selection === null || selected(input.selection, runtimeWarningsID)
  );
}

/**
 * recordSuiteRun notes in the suite's result what runtime.warnings reads,
 * and the Limitations that belong to the run whoever reports it: the Node
 * flags added to the project's command, and a process that had to be
 * stopped when nobody reports it as a Finding.
 */
export function recordSuiteRun(
  input: Input,
  res: Result,
  ev: SuiteEvents,
  c: ContainerResult | null,
): void {
  const run = suiteRunOf(input, ev, c);
  res.suite = run;
  if (input.repeat !== null) {
    // A repeat run is read by the Check that made it. The Limitations of
    // the first run describe the first run.
    return;
  }
  if (run.selected) {
    (res.limitations ??= []).push(
      nodeOptionsLimitation(input, testsExistingID),
    );
  } else if (run.hung) {
    (res.limitations ??= []).push({
      reason_code: "process_stopped_after_grace",
      message: `The test process was still running ${String(exitGraceMs / 1000)} seconds after the tests finished, so the tool stopped the container. Every result was recorded. runtime.warnings is not selected, so this is not reported as a Finding.`,
      check_id: testsExistingID,
      path: input.manifestPath(),
    });
  }
}

/**
 * addWarningsEnv adds to the environment of the test run what
 * runtime.warnings and the exit watch need, and returns the marker that ends
 * the run. When runtime.warnings is selected, Node's warning flags go into
 * NODE_OPTIONS after any value from the test command. The end marker is
 * added whatever the Selection, because a suite that keeps its process alive
 * must not use up the Budget. Its text is new for every run, because the
 * project's code sees the environment too.
 */
export function addWarningsEnv(
  input: Input,
  env: Record<string, string>,
): EndMarker {
  if (input.repeat !== null) {
    // A repeat run gets no warning flags, only what its Check adds.
    if (input.repeat.nodeOptions !== "") {
      env.NODE_OPTIONS = trimSpace(
        (env.NODE_OPTIONS ?? "") + " " + input.repeat.nodeOptions,
      );
    }
  } else if (warningsSelected(input)) {
    env.NODE_OPTIONS = trimSpace((env.NODE_OPTIONS ?? "") + " " + warningFlags);
  }
  const marker = "@@jspf-end-" + randomBytes(12).toString("hex") + "@@";
  env.JSPF_END_MARKER = marker;
  return { text: marker, graceMs: exitGraceMs };
}

/**
 * suiteRunOf records what the container left behind. c is null when the
 * container did not return a result, for example after a timeout.
 */
export function suiteRunOf(
  input: Input,
  ev: SuiteEvents,
  c: ContainerResult | null,
): SuiteRun {
  return {
    selected: warningsSelected(input),
    events: ev,
    runner: runnerName(input),
    stderr: c === null ? Buffer.alloc(0) : c.stderr,
    hung: c?.stoppedAfterGrace ?? false,
  };
}

/** nodeOptionsLimitation says that the run had Node's warning flags added. */
export function nodeOptionsLimitation(
  input: Input,
  checkID: string,
): Limitation {
  return {
    reason_code: "test_command_override",
    message:
      "NODE_OPTIONS of the test run gets " +
      warningFlags +
      " after the project's own value, so that Node says where warnings come from.",
    check_id: checkID,
    path: input.manifestPath(),
  };
}
