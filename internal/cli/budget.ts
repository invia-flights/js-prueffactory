import { quote } from "../gocompat/fmt.ts";
import { parseInt64 } from "../gocompat/strconv.ts";
import { trimSpace } from "../gocompat/strings.ts";
import {
  type Duration,
  durationString,
  hour,
  minute,
  parseDuration,
  second,
  wrapInt64,
} from "../gocompat/time.ts";
import { usageError } from "./usage.ts";

// Budget sources as the Report records them.
export const budgetDefault = "default";
export const budgetFastDefault = "fast_default";
export const budgetFlag = "flag";
export const budgetCIJobTimeout = "ci_job_timeout";

export const defaultBudget: Duration = 2n * hour;
/** fastBudget is the default Budget of a --fast Run. */
export const fastBudget: Duration = 30n * minute;
// What a Run leaves to the CI job around itself when the job timeout is what
// limits the Budget.
const ciJobTimeoutMargin: Duration = 5n * minute;

/**
 * BudgetValue is the --budget flag. It remembers whether the flag was given,
 * so `--budget ""` is a usage error rather than the default.
 */
export interface BudgetValue {
  set: boolean;
  raw: string;
}

export interface Budget {
  budget: Duration;
  source: string;
}

/**
 * resolveBudget settles the Budget of a Run and where it came from: an
 * explicit --budget, else the --fast default, else the normal default. A
 * CI_JOB_TIMEOUT (seconds, as GitLab sets it) shorter than the Budget replaces
 * it with the timeout minus five minutes. An unreadable CI_JOB_TIMEOUT is
 * ignored and reported through warn. It throws a usage error.
 */
export function resolveBudget(
  flag: BudgetValue,
  fast: boolean,
  getenv: (name: string) => string,
  warn: (message: string) => void,
): Budget {
  let budget = fast ? fastBudget : defaultBudget;
  let source = fast ? budgetFastDefault : budgetDefault;
  if (flag.set) {
    let d: Duration | undefined;
    try {
      d = parseDuration(flag.raw);
    } catch {
      d = undefined;
    }
    if (d === undefined || d <= 0n) {
      throw usageError(
        `--budget must be a positive duration such as 45m or 1h30m, got ${quote(flag.raw)}`,
      );
    }
    budget = d;
    source = budgetFlag;
  }

  const raw = trimSpace(getenv("CI_JOB_TIMEOUT"));
  if (raw === "") {
    return { budget, source };
  }
  let secs: bigint | undefined;
  try {
    secs = parseInt64(raw);
  } catch {
    secs = undefined;
  }
  if (secs === undefined || secs <= 0n) {
    warn(
      `warning: ignoring CI_JOB_TIMEOUT=${quote(raw)}, it is not a number of seconds`,
    );
    return { budget, source };
  }
  // time.Duration(secs) * time.Second: int64 arithmetic, which wraps.
  const timeout = wrapInt64(secs * second);
  if (timeout >= budget) {
    return { budget, source };
  }
  if (timeout <= ciJobTimeoutMargin) {
    throw usageError(
      `CI_JOB_TIMEOUT is ${durationString(timeout)}: too short for a Run, it needs more than ${durationString(ciJobTimeoutMargin)}`,
    );
  }
  return { budget: timeout - ciJobTimeoutMargin, source: budgetCIJobTimeout };
}
