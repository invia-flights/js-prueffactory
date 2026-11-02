// Repeat runs (Go: tests_repeat.go). tests.flaky and
// runtime.unhandled-rejections run a suite again after the shared first run.
// A repeat run is a new container on the package's Context image with the
// first run's runner, arguments, environment and overrides and our reporter,
// but without c8 and without the warning flags of runtime.warnings. It has
// its own network and fresh Services, exactly like a first run.
//
// Only what the first run needs is here so far: the run's names and its
// command log. Ticket 15 of the port adds the repeat runs themselves.
import { join } from "../gocompat/path.ts";
import { type Duration, minute } from "../gocompat/time.ts";
import type { Input } from "./input.ts";
import { testLogName } from "./test_suites.ts";
import { testsExistingID } from "./tests_existing.ts";

/**
 * SuiteRunTimeout is the time limit of one run of a suite, a repeat run
 * included. It is bounded by what is left of the Budget.
 */
export const SuiteRunTimeout: Duration = 30n * minute;

/** RepeatRun says what a further run of a suite differs in. */
export interface RepeatRun {
  /**
   * checkID is the Check that makes the run. Its command log is one of that
   * Check's artifacts.
   */
  checkID: string;
  /**
   * number counts the runs of the suite: 1 is the shared first run, so the
   * first repeat is 2. It makes the names of the run's containers, volumes
   * and networks unique.
   */
  number: number;
  /** nodeOptions is added to NODE_OPTIONS after the project's own value. */
  nodeOptions: string;
}

/**
 * forRepeat returns a copy of the Input bound to a repeat run of the suite
 * it is bound to.
 */
export function forRepeat(input: Input, r: RepeatRun): Input {
  const bound = input.forSuite(input.suiteIndex);
  bound.repeat = r;
  return bound;
}

/**
 * testLogPath is the artifact path of the suite's command log. The first
 * run's log belongs to tests.existing, a repeat run's to the Check that made
 * it and names the run: test-output-run3.log.
 */
export function testLogPath(input: Input): string {
  if (input.repeat === null) {
    return join(
      "artifacts",
      testsExistingID,
      input.context.id,
      testLogName(input),
    );
  }
  const name =
    testLogName(input).replace(/\.log$/, "") +
    `-run${String(input.repeat.number)}.log`;
  return join("artifacts", input.repeat.checkID, input.context.id, name);
}
