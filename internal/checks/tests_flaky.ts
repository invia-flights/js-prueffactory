// tests.flaky (Go: tests_flaky.go): every suite of a package runs two more
// times after the shared first run, and the tests whose outcome differs
// between the runs are reported.
import { RunnerNodeTest } from "../discovery/discovery.ts";
import { durationString } from "../gocompat/time.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import { quote } from "../resultset/quote.ts";
import {
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  KindHint,
  type Metric,
  NotApplicable,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  StatusUnsupported,
  TestFailed,
  TestNeverRun,
  type TestOutcome,
  TestPassed,
} from "../resultset/types.ts";
import { newFinding, newMetric } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { shorten } from "./cut_text.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import {
  planNodeTestArgs,
  nodeTestNativeBase,
  nodeTestReporterPath,
} from "./tests_existing_nodetest.ts";
import { errorText, type SuiteEvents, type TestErr } from "./test_events.ts";
import {
  locate,
  nativeTestCommand,
  oneLine,
  projectFrames,
  relativeStack,
  runnerName,
  testFile,
} from "./test_report.ts";
import { suiteCount, perSuite } from "./test_suites.ts";
import { sharedSuite } from "./tests_coverage.ts";
import {
  nativeBase,
  planMochaArgs,
  reporterPath,
  runnable,
  testRunApplicability,
  testsExisting,
  unsupportedTests,
} from "./tests_existing.ts";
import {
  currentRepeatRunTimeout,
  type FlakyTests,
  flakyTestsSharedKey,
  type Observation,
  ranToTheEnd,
  RepeatBudget,
  RepeatCancelled,
  type RepeatEnd,
  RepeatDone,
  RepeatTimedOut,
  runRepeat,
  serviceLimitations,
  SuiteRuns,
  testKeyInSuite,
} from "./tests_repeat.ts";
import { testsExistingID } from "./tests_existing.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";

export const testsFlakyID = "tests.flaky";

/** flakyRepeats is how many more times each suite runs after the shared first run. */
export const flakyRepeats = 2;

// The rules of the Findings of tests.flaky. The Benchmark counts the first.
const ruleFlakyTest = "flaky-test";
const ruleTestInSomeRuns = "test-in-some-runs";

/**
 * maxRunNotes caps the notes for tests that only some runs found. A project
 * that generates its tests at load time can have thousands.
 */
export const maxRunNotes = 50;

/**
 * testsFlaky runs every suite of a package two more times after the shared
 * first run (see sharedSuite) and reports the tests whose outcome differs
 * between the runs, and the tests that only passed after Mocha's own
 * retries. The repeat runs are made like the first run, in the same Working
 * copy, one after another, each with fresh Services on a network of its own
 * (see runRepeat).
 *
 * A test is identified by its file and full title. It is flaky when its
 * final outcome is passed in one run and failed, or never run because a hook
 * failed, in another. Skipped and todo tests take part in no comparison, and
 * a test that only some runs found is a note, not a Flaky test. Every Flaky
 * test is a warning Finding without a Gate: a test that fails in every run
 * is a failed test, which tests.existing reports.
 *
 * When a repeat run times out or the Budget ends, the comparisons that
 * finished are reported and the execution is partial.
 */
export const testsFlaky: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "tests.flaky repeats the test runs of a package, and this is the project Context",
      ];
    }
    if (c.package.tests === null) {
      return [
        NotApplicable,
        "the package has no test script and no Mocha config file, so there is no test run to repeat",
      ];
    }
    return testRunApplicability(c.package);
  },

  /**
   * The Check needs what the test run needs, and starts after the first run,
   * which it performs itself when nothing else has.
   */
  prerequisites(c) {
    return testsExisting.prerequisites?.(c) ?? [];
  },

  /**
   * runsAfter: the first run is made by tests.existing, even when the
   * Selection leaves that Check out, so the repeat runs are scheduled right
   * after it.
   */
  runsAfter(c) {
    return runnable(c) ? [testsExistingID] : [];
  },

  usesWorkingCopy() {
    return true;
  },

  /** usesServices: every repeat run gets the project's test Services of its own. */
  usesServices(c) {
    return testsExisting.usesServices?.(c) ?? false;
  },

  images(c) {
    return testsExisting.images?.(c) ?? [];
  },

  async run(signal, input) {
    const pkg = input.context.package;
    const u = pkg === null ? null : unsupportedTests(pkg);
    if (u !== null) {
      return {
        status: StatusUnsupported,
        reasonCode: u.code,
        reason: u.reason,
      };
    }
    const first = await sharedSuite(signal, input);
    const out: Result = { status: StatusCompleted };

    const suites: SuiteRuns[] = [];
    let cut: RepeatCut | null = null;
    for (const [i, p] of perSuite(first).entries()) {
      const pEvents = p.suite?.events;
      if (!pEvents?.started) {
        continue; // the suite never got going, so there is nothing to repeat
      }
      const bound = input.forSuite(i);
      const sr = new SuiteRuns(bound, bound.suite()?.origin ?? "");
      sr.add(1, p, pEvents, true);
      suites.push(sr);
      const own: Result[] = [];
      let stop = false;
      for (let n = 2; n <= 1 + flakyRepeats && !stop; n++) {
        const [res, end] = await runRepeat(signal, bound, {
          checkID: testsFlakyID,
          number: n,
          nodeOptions: "",
        });
        own.push(res);
        (out.artifacts ??= []).push(...(res.artifacts ?? []));
        if (out.command === undefined) {
          if (res.command !== undefined) {
            out.command = res.command;
          }
          if (res.tool !== undefined) {
            out.tool = res.tool;
          }
        }
        const ev = res.suite?.events ?? null;
        if (ev?.started === true) {
          sr.add(n, res, ev, end === RepeatDone);
        }
        const c = repeatProblem(sr.name, n, res, ev, end);
        if (c !== null && cut === null) {
          cut = c;
        }
        stop = end === RepeatBudget || end === RepeatCancelled;
      }
      sr.readServices(testsFlakyID, p, own);
      if (stop) {
        break;
      }
    }

    if (suites.length === 0) {
      // No suite ran far enough to repeat. The first run says why.
      if (first.status !== StatusCompleted) {
        return {
          status: first.status,
          reasonCode: first.reasonCode ?? "",
          reason: first.reason ?? "",
        };
      }
      out.limitations = [
        {
          reason_code: "tests_not_run",
          check_id: testsFlakyID,
          message:
            "The test suite did not run, so there is nothing to repeat. tests.existing says why.",
          path: null,
        },
      ];
      return out;
    }

    const several = suiteCount(input.context.package) > 1;
    let flaky = 0;
    let notes = 0;
    let omitted = 0;
    const explained: FlakyTests = new Set();
    for (const sr of suites) {
      const [fs, ns] = compare(sr, several);
      for (const key of sr.flakyKeys) {
        explained.add(testKeyInSuite(sr.name, key));
      }
      for (const f of fs) {
        flaky++;
        (out.findings ??= []).push(f);
      }
      for (const f of ns) {
        if (notes >= maxRunNotes) {
          omitted++;
          continue;
        }
        notes++;
        (out.findings ??= []).push(f);
      }
    }
    (out.limitations ??= []).push(...serviceLimitations(suites));
    if (omitted > 0) {
      out.limitations.push({
        reason_code: "notes_truncated",
        check_id: testsFlakyID,
        path: input.manifestPath(),
        message: `${String(omitted)} more tests were found in only some runs than the ${String(maxRunNotes)} that are reported as notes.`,
      });
    }
    if (input.shared !== null) {
      // runtime.unhandled-rejections leaves out the tests reported here.
      input.shared.put(flakyTestsSharedKey(input.context.id), explained);
    }
    const metric: Metric = newMetric({
      name: "flaky_tests",
      value: flaky,
      unit: "tests",
    });
    out.metrics = [metric];
    if (cut !== null) {
      out.status = StatusPartial;
      out.reasonCode = cut.code;
      out.reason = cut.reason;
      out.keepsStatus = cut.end !== RepeatCancelled;
    }
    return out;
  },
};

register(testsFlakyID, testsFlaky);

/**
 * RepeatCut says why a repeat run did not give what it should, which makes
 * the execution partial.
 */
export interface RepeatCut {
  code: ReasonCode;
  reason: string;
  end: RepeatEnd;
}

/**
 * repeatProblem says what was wrong with a repeat run, or returns null for a
 * run that went as it should.
 */
export function repeatProblem(
  suite: string,
  n: number,
  res: Result,
  ev: SuiteEvents | null,
  end: RepeatEnd,
): RepeatCut | null {
  const which = `Run ${String(n)} of the suite ${quote(suite)}`;
  switch (end) {
    case RepeatTimedOut:
      return {
        code: "repeat_run_timed_out",
        reason: `${which} ran into its time limit of ${durationString(currentRepeatRunTimeout())}. The comparisons that finished are reported.`,
        end,
      };
    case RepeatBudget:
      return {
        code: "budget_exhausted",
        reason: `The Budget ran out during ${which.slice(0, 1).toLowerCase() + which.slice(1)}. The comparisons that finished are reported.`,
        end,
      };
    case RepeatCancelled:
      return { code: "cancelled", reason: "the Run was cancelled", end };
  }
  if (!ev?.started) {
    let why = res.reason ?? "";
    if (why === "") {
      why = "the runner stopped before it ran any test";
    }
    return {
      code: "repeat_run_failed",
      reason: `${which} did not run: ${why}`,
      end,
    };
  }
  if (!ranToTheEnd(res, ev)) {
    return {
      code: "repeat_run_failed",
      reason: `${which} did not finish: ${res.reason ?? ""}`,
      end,
    };
  }
  return null;
}

// --- comparing the runs of one suite ---

/** compare finds the Flaky tests and the tests that only some runs found. */
export function compare(
  s: SuiteRuns,
  qualify: boolean,
): [flaky: Finding[], notes: Finding[]] {
  const flaky: Finding[] = [];
  const notes: Finding[] = [];
  if (s.runs.length < 2) {
    return [flaky, notes]; // a suite whose repeats did not run has nothing to compare
  }
  for (const key of s.orderedKeys()) {
    const obs: Observation[] = [];
    const inRuns: number[] = [];
    const notIn: number[] = [];
    for (const r of s.runs) {
      const o = s.observe(r, key);
      obs.push(o);
      if (o.found) {
        inRuns.push(r.number);
      } else if (!o.unknown) {
        notIn.push(r.number);
      }
    }
    if (notIn.length > 0 && inRuns.length > 0) {
      notes.push(noteFinding(s, obs, inRuns, notIn, qualify));
      continue;
    }
    if (isFlaky(obs)) {
      flaky.push(flakyFinding(s, obs, qualify));
      s.flakyKeys.add(key);
    }
  }
  return [flaky, notes];
}

/**
 * isFlaky applies the rule: a pass in one run and a failure in another,
 * where a test that never ran because a hook failed counts as failed, or a
 * pass that needed Mocha's retries in any run.
 */
function isFlaky(obs: readonly Observation[]): boolean {
  let passed = false;
  let failed = false;
  for (const o of obs) {
    switch (o.outcome) {
      case TestPassed:
        passed = true;
        if (o.rec !== null && o.rec.attempts.length > 0) {
          return true;
        }
        break;
      case TestFailed:
      case TestNeverRun:
        failed = true;
    }
  }
  return passed && failed;
}

/** outcomeWords describes an outcome the way a title and the Evidence do. */
function outcomeWords(o: Observation): string {
  if (!o.found && o.unknown) {
    return "no result";
  }
  if (!o.found) {
    return "not found";
  }
  if (o.unknown) {
    return "no result";
  }
  switch (o.outcome) {
    case TestNeverRun:
      return "never run";
    case TestPassed:
    case TestFailed: {
      const n = o.rec?.attempts.length ?? 0;
      if (n > 0) {
        return `${o.outcome} after ${String(n + 1)} attempts`;
      }
    }
  }
  return o.outcome;
}

/** runEvidence is the outcome, attempts and error of one run of a test. */
function runEvidence(number: number, o: Observation): string {
  let head = `run ${String(number)}`;
  if (number === 1) {
    head += " (first run)";
  }
  const rec = o.rec;
  if (!o.found || o.unknown || rec === null) {
    return head + ": " + outcomeWords(o);
  }
  switch (o.outcome) {
    case TestNeverRun: {
      let text = head + ": never run";
      if (rec.neverRunReason !== "") {
        text += ": " + rec.neverRunReason;
      }
      return text;
    }
    case TestPassed:
    case TestFailed:
      break;
    default:
      return head + ": " + o.outcome;
  }
  let text = head + ": " + outcomeWords(o);
  const total = rec.attempts.length + 1;
  if (o.outcome === TestPassed && total === 1) {
    return text;
  }
  for (const [i, a] of rec.attempts.entries()) {
    text += `\n  attempt ${String(i + 1)}: ${attemptText(a.outcome, a.error)}`;
  }
  text += `\n  attempt ${String(total)} (final): ${attemptText(o.outcome, errorText(rec.err))}`;
  return text;
}

function attemptText(outcome: TestOutcome, err: string | null): string {
  if (err === null || trimSpace(err) === "") {
    return outcome;
  }
  return outcome + ": " + oneLine(relativeStack(err), 400);
}

/** testIdentity is the file and full title of the test of a key. */
function testIdentity(
  s: SuiteRuns,
  obs: readonly Observation[],
): [file: string, fullTitle: string] {
  for (const o of obs) {
    if (o.rec !== null) {
      return [testFile(o.rec.file), o.rec.fullTitle];
    }
  }
  return ["", ""];
}

function flakyFinding(
  s: SuiteRuns,
  obs: readonly Observation[],
  qualify: boolean,
): Finding {
  const input = s.input;
  const [file, title] = testIdentity(s, obs);
  const rule = ruleFlakyTest;

  const words: string[] = [];
  const evidence: string[] = [];
  const passedIn: string[] = [];
  const failedIn: string[] = [];
  const retried: string[] = [];
  let failing: TestErr | null = null;
  for (const [i, o] of obs.entries()) {
    const n = s.runs[i]?.number ?? 0;
    words.push(outcomeWords(o));
    evidence.push(runEvidence(n, o));
    switch (o.outcome) {
      case TestPassed:
        passedIn.push(String(n));
        if ((o.rec?.attempts.length ?? 0) > 0) {
          retried.push(String(n));
        }
        break;
      case TestFailed:
      case TestNeverRun:
        failedIn.push(String(n));
        if (o.outcome === TestFailed && failing === null) {
          failing = o.rec?.err ?? null;
        }
    }
  }

  let message: string;
  if (failedIn.length > 0) {
    message = `The test ${quote(shorten(title, 200))} passed in run ${passedIn.join(", ")} and failed, or never ran because of a failed hook, in run ${failedIn.join(", ")}, of ${String(obs.length)} runs of the same Snapshot. `;
  } else {
    message = `The test ${quote(shorten(title, 200))} only passed after Mocha retried it, in run ${retried.join(", ")}. `;
  }
  message +=
    "Every run used the same Working copy and fresh Services, so the cause is in the test or in what it reads from outside, such as the clock, timers, random values, the order of files or leftovers in its own package folder. Find what differs between the runs before you change the code under test.";

  let at = { path: file, line: 0, col: 0 };
  if (failing !== null) {
    const f = locate(projectFrames(input, failing.stack), file);
    if (f.path === file) {
      at = f;
    }
  }
  const f = newFinding({
    check_id: testsFlakyID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(testsFlakyID, rule, file, title),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceConfirmed,
    title: shorten(
      `Flaky test: ${shorten(oneLine(title, 100), 100)} (runs: ${words.join(", ")})`,
      200,
    ),
    message,
    locations: [input.location("primary", at.path, at.line, at.col)],
    reproduction: input.reproduction(testsFlakyID),
    limitations: [],
  });
  f.evidence = evidence.map((text) =>
    untrusted("test_run", text, runnerName(input)),
  );
  f.reproduction.test = {
    runner: runnerName(input),
    file,
    full_title: title,
    native_command: nativeTestCommand(
      input,
      nativeBaseOfSuite(input),
      file,
      title,
    ),
  };
  s.attachSuite(f, qualify);
  return f;
}

/**
 * noteFinding is the note for a test that some runs found and others did
 * not. Tests generated at load time can differ this way, so it is no Flaky
 * test.
 */
function noteFinding(
  s: SuiteRuns,
  obs: readonly Observation[],
  inRuns: readonly number[],
  notIn: readonly number[],
  qualify: boolean,
): Finding {
  const input = s.input;
  const [file, title] = testIdentity(s, obs);
  const rule = ruleTestInSomeRuns;
  const runNumbers = (ns: readonly number[]): string =>
    ns.map((n) => String(n)).join(", ");
  const f = newFinding({
    check_id: testsFlakyID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(testsFlakyID, rule, file, title),
    kind: KindHint,
    severity: SeverityNote,
    confidence: ConfidenceConfirmed,
    title: shorten(
      "Test found in only some runs: " + shorten(oneLine(title, 100), 100),
      200,
    ),
    message: `The test ${quote(shorten(title, 200))} was found in run ${runNumbers(inRuns)} but not in run ${runNumbers(notIn)} of the same Snapshot. Tests that a file generates when it loads can differ between runs, so it is not reported as a Flaky test and its outcomes are not compared.`,
    locations: [input.location("primary", file, 0, 0)],
    reproduction: input.reproduction(testsFlakyID),
    limitations: [],
  });
  s.attachSuite(f, qualify);
  return f;
}

/**
 * nativeBaseOfSuite is the start of the command that re-runs one test of the
 * suite with the project's own tools, as the first run reports it.
 */
export function nativeBaseOfSuite(input: Input): string[] {
  const tc = input.suite();
  if (tc === null) {
    return [];
  }
  if (tc.runner === RunnerNodeTest) {
    return nodeTestNativeBase(
      tc,
      planNodeTestArgs(tc.args, nodeTestReporterPath),
    );
  }
  return nativeBase(tc, planMochaArgs(tc.args, reporterPath));
}
