// Repeat runs (Go: tests_repeat.go). tests.flaky and
// runtime.unhandled-rejections run a suite again after the shared first run.
// A repeat run is a new container on the package's Context image with the
// first run's runner, arguments, environment and overrides and our reporter,
// but without c8 and without the warning flags of runtime.warnings. It has
// its own network and fresh Services, exactly like a first run, and it runs
// in the package's Working copy, one after another.
import { isDeadline, withTimeout } from "../gocompat/context.ts";
import { join } from "../gocompat/path.ts";
import { type Duration, minute } from "../gocompat/time.ts";
import { fingerprintWithSuite } from "../resultset/fingerprint.ts";
import {
  type Finding,
  type Limitation,
  StatusBudgetExhausted,
  StatusCancelled,
  StatusInfrastructureError,
  StatusTimedOut,
  StatusToolError,
  TestNeverRun,
  type TestOutcome,
} from "../resultset/types.ts";
import type { Input, Result } from "./input.ts";
import { runTestSuite } from "./runtime_warnings.ts";
import {
  noteServicesNotStarted,
  type ServiceNeed,
  servicesOfRuns,
} from "./service_not_started.ts";
import type { SuiteEvents, TestRecord } from "./test_events.ts";
import { explainNeverRun } from "./test_report.ts";
import { testLogName } from "./test_suites.ts";
import { testsExistingID } from "./tests_existing.ts";

/**
 * SuiteRunTimeout is the time limit of one run of a suite, a repeat run
 * included. It is bounded by what is left of the Budget.
 */
export const SuiteRunTimeout: Duration = 30n * minute;

let repeatRunTimeout: Duration = SuiteRunTimeout;

/**
 * useRepeatRunTimeout shortens the time limit of a repeat run (Go: tests
 * assign repeatRunTimeout) and returns the function that restores it.
 */
export function useRepeatRunTimeout(d: Duration): () => void {
  const old = repeatRunTimeout;
  repeatRunTimeout = d;
  return () => {
    repeatRunTimeout = old;
  };
}

/** currentRepeatRunTimeout is the time limit a repeat run has now. */
export function currentRepeatRunTimeout(): Duration {
  return repeatRunTimeout;
}

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

/** RepeatEnd says how a repeat run ended, from the point of view of the Check. */
export const RepeatDone = "done";
export const RepeatTimedOut = "timed_out";
export const RepeatBudget = "budget";
export const RepeatCancelled = "cancelled";
export type RepeatEnd =
  | typeof RepeatDone
  | typeof RepeatTimedOut
  | typeof RepeatBudget
  | typeof RepeatCancelled;

/**
 * runRepeat performs one repeat run of the suite the Input is bound to,
 * within the suite time limit and the signal, and says how it ended. The
 * Result holds whatever the reporter recorded, however the run ended.
 */
export async function runRepeat(
  signal: AbortSignal,
  input: Input,
  r: RepeatRun,
): Promise<[Result, RepeatEnd]> {
  const rctx = withTimeout(signal, repeatRunTimeout);
  let res: Result;
  let rAborted: boolean;
  try {
    res = await runTestSuite(rctx.signal, forRepeat(input, r));
    rAborted = rctx.signal.aborted;
  } finally {
    rctx.cancel();
  }
  let end: RepeatEnd = RepeatDone;
  if (signal.aborted) {
    end = isDeadline(signal) ? RepeatBudget : RepeatCancelled;
  } else if (rAborted) {
    end = RepeatTimedOut;
  }
  return [res, end];
}

/**
 * ranToTheEnd says whether a run of a suite went on to the point where a
 * test without a result is a test that never ran, and not one the run had no
 * time for: the reporter wrote its end event, or the process died (a crash,
 * a call to process.exit(), the memory limit) with nothing cutting the run
 * short.
 */
export function ranToTheEnd(res: Result, ev: SuiteEvents): boolean {
  if (ev.ended) {
    return true;
  }
  switch (res.status) {
    case StatusTimedOut:
    case StatusBudgetExhausted:
    case StatusCancelled:
    case StatusInfrastructureError:
    case StatusToolError:
      return false;
  }
  return true;
}

// The runs of one suite, as tests.flaky and runtime.unhandled-rejections
// both read them.

/** RunRecord is what one run of a suite recorded. */
export interface RunRecord {
  number: number;
  events: SuiteEvents;
  /**
   * toTheEnd is true when a test without a result in this run is a test
   * that never ran. It is false for a run that was cut short, where such a
   * test is one the run had no time for, and takes part in no comparison.
   */
  toTheEnd: boolean;
  byKey: Map<string, TestRecord>;
}

/** Observation is what one run says about one test. */
export interface Observation {
  /** found is false when the run did not find the test. */
  found: boolean;
  /** unknown is true for a test without a result in a run that was cut short. */
  unknown: boolean;
  /** outcome is "" for a test the run did not find. */
  outcome: TestOutcome | "";
  rec: TestRecord | null;
}

/** keyOf is the key of a test of a run: file, full title and its ordinal. */
function keyOf(base: string, n: number): string {
  return `${base}\x00${String(n)}`;
}

/** SuiteRuns holds the runs of one suite, the first run first. */
export class SuiteRuns {
  /** input is bound to the suite. */
  readonly input: Input;
  readonly name: string;
  readonly runs: RunRecord[] = [];
  /** flakyKeys are the keys of the tests compare reported as Flaky tests. */
  flakyKeys = new Set<string>();
  /**
   * mayNeed are the Services the suite may need that the Run did not start
   * and the Init services whose Service it may use, by the marks of the runs
   * the Check read (see servicesOfRuns).
   */
  mayNeed: ServiceNeed[] = [];
  /**
   * serviceLimits are the Limitations for the Services of mayNeed that the
   * first run did not mark, and noted says that a Finding of the suite
   * carries the note, which makes the Check report them.
   */
  serviceLimits: Limitation[] = [];
  noted = false;

  constructor(input: Input, name: string) {
    this.input = input;
    this.name = name;
  }

  /**
   * readServices records what the suite may need of the Services the Run
   * did not start, by the first run and the Check's own runs of it.
   */
  readServices(checkID: string, first: Result, own: readonly Result[]): void {
    [this.mayNeed, this.serviceLimits] = servicesOfRuns(
      this.input,
      checkID,
      first,
      own,
    );
  }

  /** add records a run. whole is false when the run did not end by itself. */
  add(number: number, res: Result, ev: SuiteEvents, whole: boolean): void {
    const toTheEnd = whole && ranToTheEnd(res, ev);
    const byKey = new Map<string, TestRecord>();
    const ordinal = new Map<string, number>();
    const anyFocused = ev.tests.some((t) => t.focused);
    for (const t of ev.tests) {
      // The records of the first run are shared with the Checks that read
      // it, so the reason a test never ran is set on a copy.
      const cp: TestRecord = { ...t };
      if (cp.outcome === "" && toTheEnd) {
        explainNeverRun(
          this.input,
          cp,
          ev,
          ev.hooks.map(() => 0),
          anyFocused,
        );
      }
      const base = t.file + "\x00" + t.fullTitle;
      const n = (ordinal.get(base) ?? 0) + 1;
      ordinal.set(base, n);
      byKey.set(keyOf(base, n), cp);
    }
    this.runs.push({ number, events: ev, toTheEnd, byKey });
  }

  observe(r: RunRecord, key: string): Observation {
    const t = r.byKey.get(key);
    if (t === undefined) {
      return { found: false, unknown: !r.toTheEnd, outcome: "", rec: null };
    }
    if (t.outcome === "") {
      return r.toTheEnd
        ? { found: true, unknown: false, outcome: TestNeverRun, rec: t }
        : { found: true, unknown: true, outcome: "", rec: t };
    }
    return { found: true, unknown: false, outcome: t.outcome, rec: t };
  }

  /**
   * orderedKeys lists the keys of the tests of all runs, in the order they
   * were first announced.
   */
  orderedKeys(): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const r of this.runs) {
      const ordinal = new Map<string, number>();
      for (const t of r.events.tests) {
        const base = t.file + "\x00" + t.fullTitle;
        const n = (ordinal.get(base) ?? 0) + 1;
        ordinal.set(base, n);
        const key = keyOf(base, n);
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return keys;
  }

  /**
   * attachSuite marks a Finding with its suite, the way the Findings of a
   * package with several suites are: the fingerprint also depends on the
   * suite, because the same test can be flaky in two of them. A suite that
   * may need a Service the Run did not start adds its note.
   */
  attachSuite(f: Finding, qualify: boolean): void {
    f.suite = this.name;
    if (qualify) {
      f.fingerprint = fingerprintWithSuite(f.fingerprint, this.name);
    }
    noteServicesNotStarted(f, this.name, this.mayNeed);
    this.noted = this.noted || this.mayNeed.length > 0;
  }
}

/**
 * serviceLimitations are the Limitations that the noted Findings of the
 * suites refer to and no other Check reports.
 */
export function serviceLimitations(suites: readonly SuiteRuns[]): Limitation[] {
  const out: Limitation[] = [];
  for (const s of suites) {
    if (s.noted) {
      out.push(...s.serviceLimits);
    }
  }
  return out;
}

/**
 * FlakyTests are the tests tests.flaky reported in a Context: the suite and
 * the key of the test, as testKeyInSuite makes them.
 */
export type FlakyTests = Set<string>;

export function testKeyInSuite(suite: string, key: string): string {
  return suite + "\x00" + key;
}

/** flakyTestsSharedKey is where tests.flaky leaves its Flaky tests in Shared. */
export function flakyTestsSharedKey(contextID: string): string {
  return "tests.flaky/flaky-tests/" + contextID;
}
