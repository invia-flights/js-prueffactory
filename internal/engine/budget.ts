// Time limits of the Check executions, the reserve for the Report and the
// number of executions that run at once (Go: budget.go).
import { type Duration, hour, minute, second } from "../gocompat/time.ts";
import {
  type ExecStatus,
  StatusBudgetExhausted,
  StatusCancelled,
  StatusTimedOut,
} from "../resultset/types.ts";

// The time limits of one Check execution. Each is bounded by what is left of
// the Budget.
export const installTimeout: Duration = 15n * minute;
/** testSuiteTimeout is the limit of one test suite run (Go: checks.SuiteRunTimeout). */
export const testSuiteTimeout: Duration = 30n * minute;
export const checkTimeout: Duration = 10n * minute;
/**
 * repeatRunsTimeout is the limit of a Check that runs suites several times,
 * such as tests.flaky. Each of its runs has testSuiteTimeout, which the Check
 * applies itself; the execution as a whole has only the Budget.
 */
export const repeatRunsTimeout: Duration = 24n * hour;
/**
 * registryTimeout is the limit of the registry-data step, which the first of
 * deps.deprecated and deps.outdated of a package runs for both.
 */
export const registryTimeout: Duration = 5n * minute;

/** reserve is the end of the Budget kept for writing the Report. */
export const reserve: Duration = 60n * second;

/** maxParallel is the most Check executions that run at once. */
export const maxParallel = 4;

/** timeLimit is the time limit of one execution of a Check. */
export function timeLimit(checkID: string): Duration {
  switch (checkID) {
    case "package.install":
      return installTimeout;
    case "tests.existing":
    case "tests.coverage":
    case "runtime.warnings":
      // runtime.warnings may be the one that starts the suite both read.
      return testSuiteTimeout;
    case "tests.flaky":
    case "runtime.unhandled-rejections":
      return repeatRunsTimeout;
    case "deps.deprecated":
    case "deps.outdated":
      return registryTimeout;
  }
  return checkTimeout;
}

/**
 * isTestSuite says whether a Check runs the project's tests. Test suites take
 * the longest, so they start first.
 */
export function isTestSuite(checkID: string): boolean {
  const limit = timeLimit(checkID);
  return limit === testSuiteTimeout || limit === repeatRunsTimeout;
}

/**
 * parallelism is how many Check executions run at once: half the Docker
 * daemon's CPUs (integer division), at most four, at least one.
 */
export function parallelism(daemonCPUs: number): number {
  return Math.max(1, Math.min(maxParallel, Math.trunc(daemonCPUs / 2)));
}

/**
 * reserveStart is when running executions are cancelled: the Budget minus
 * the reserve for writing the Report, in milliseconds since the epoch.
 */
export function reserveStart(start: Date, budget: Duration): number {
  return start.getTime() + Number((budget - reserve) / 1_000_000n);
}

/**
 * endReason says why an execution that did not complete ended, from the
 * three signals it ran under: the Run (cancelled by the user), the Budget
 * (ends when the reserve starts) and the execution's own time limit. It
 * returns null when none of them ended, so the Check's own status stands.
 */
export function endReason(
  run: AbortSignal,
  budget: AbortSignal,
  own: AbortSignal,
): ExecStatus | null {
  if (run.aborted) {
    return StatusCancelled;
  }
  if (budget.aborted) {
    return StatusBudgetExhausted;
  }
  if (own.aborted) {
    return StatusTimedOut;
  }
  return null;
}
