// runtime.unhandled-rejections (Go: runtime_unhandled_rejections.go): the
// suites run once more with --unhandled-rejections=strict, and the tests that
// only fail there are reported.
import { newFingerprint } from "../resultset/fingerprint.ts";
import { quote, withoutControls } from "../resultset/quote.ts";
import {
  ConfidenceLikely,
  type Evidence,
  type Finding,
  KindDefect,
  NotApplicable,
  SeverityWarning,
  StatusCompleted,
  StatusPartial,
  StatusUnsupported,
  TestFailed,
  TestNeverRun,
} from "../resultset/types.ts";
import { newFinding, newMetric } from "../resultset/zero.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import { type Check, register } from "./check.ts";
import { shorten, tail } from "./cut_text.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { selected } from "./selection.ts";
import { errText, type SuiteEvents, type TestErr } from "./test_events.ts";
import {
  errorEvidence,
  firstErrorLine,
  locate,
  nativeTestCommand,
  oneLine,
  projectFrames,
  relativeStack,
  runnerName,
  testFile,
} from "./test_report.ts";
import { perSuite, suiteCount } from "./test_suites.ts";
import { sharedSuite } from "./tests_coverage.ts";
import {
  capitalize,
  runnable,
  testRunApplicability,
  testsExisting,
  unsupportedTests,
} from "./tests_existing.ts";
import {
  flakyRepeats,
  nativeBaseOfSuite,
  repeatProblem,
  type RepeatCut,
  testsFlaky,
  testsFlakyID,
} from "./tests_flaky.ts";
import {
  flakyTestsSharedKey,
  type FlakyTests,
  type Observation,
  RepeatBudget,
  RepeatCancelled,
  RepeatDone,
  type RepeatEnd,
  runRepeat,
  serviceLimitations,
  SuiteRuns,
  testKeyInSuite,
} from "./tests_repeat.ts";

export const runtimeUnhandledRejectionsID = "runtime.unhandled-rejections";

/** strictRejectionsFlag is what the strict run adds to NODE_OPTIONS. */
export const strictRejectionsFlag = "--unhandled-rejections=strict";

// The rules of the Findings of runtime.unhandled-rejections. The Benchmark
// counts both.
const ruleUnhandledRejection = "unhandled-rejection";
const ruleUnhandledRejectionCrash = "unhandled-rejection-crash";

/**
 * runtimeUnhandledRejections runs every suite of a package once more with
 * --unhandled-rejections=strict and reports the tests that only fail there.
 * Mocha registers its own unhandledRejection listener and many projects add
 * one that only logs, so a floating promise that rejects during a test never
 * fails it; in strict mode Node raises the rejection as an uncaught
 * exception instead.
 *
 * The strict run is a repeat run (see runRepeat): it starts after the shared
 * first run, and after the repeat runs of tests.flaky when that Check is
 * selected. A test that passed in the first run and failed, or never ran
 * because of a failed hook, in the strict run is a warning Finding without a
 * Gate. The tests that tests.flaky reports as flaky are left out, because
 * their outcome differs between runs anyway, and counted in
 * explained_by_flakiness. Without tests.flaky a Limitation says the
 * differences may be flakiness.
 *
 * A strict run whose process stops before the run ends, such as for an
 * uncaught exception outside any test, is one Finding for the suite, and the
 * tests it kept from running are not reported on their own.
 */
export const runtimeUnhandledRejections: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "runtime.unhandled-rejections reruns the test suites of a package, and this is the project Context",
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

  runsAfter(c) {
    return testsFlaky.runsAfter?.(c) ?? [];
  },

  /**
   * orderedAfter: tests.flaky runs first when it is selected, and the Check
   * reads which tests it reported.
   */
  orderedAfter(c) {
    return runnable(c) ? [testsFlakyID] : [];
  },

  usesWorkingCopy() {
    return true;
  },

  /** usesServices: the strict run gets the project's test Services of its own. */
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

    let explained: FlakyTests = new Set();
    let flakyKnown = false;
    if (input.shared !== null) {
      const [v, ok] = input.shared.get(flakyTestsSharedKey(input.context.id));
      if (ok && v instanceof Set) {
        explained = v as FlakyTests;
        flakyKnown = true;
      }
    }

    const several = suiteCount(pkg) > 1;
    let cut: RepeatCut | null = null;
    const suites: SuiteRuns[] = [];
    let ran = 0;
    let left = 0;
    for (const [i, p] of perSuite(first).entries()) {
      const firstEvents = p.suite?.events;
      if (!firstEvents?.started) {
        continue; // the suite never got going, so there is nothing to compare
      }
      const bound = input.forSuite(i);
      const sr = new SuiteRuns(bound, bound.suite()?.origin ?? "");
      sr.add(1, p, firstEvents, true);
      ran++;

      const n = strictRunNumber(input);
      const [res, end] = await runRepeat(signal, bound, {
        checkID: runtimeUnhandledRejectionsID,
        number: n,
        nodeOptions: strictRejectionsFlag,
      });
      sr.readServices(runtimeUnhandledRejectionsID, p, [res]);
      suites.push(sr);
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

      // An uncaught exception outside any test ends the run early: the
      // process stops, or the runner records the error and ends the run. The
      // tests it kept from running belong to its one Finding. A problem that
      // the first run had too is no work of the flag, and tests.existing
      // reports it.
      const crash = findStrictCrash(firstEvents, ev, res, end);
      if (crash?.byFlag === true) {
        (out.findings ??= []).push(crashFinding(sr, crash, several));
      }
      if (ev?.started === true) {
        sr.add(n, res, ev, end === RepeatDone);
      }
      if (crash === null) {
        const c = repeatProblem(sr.name, n, res, ev, end);
        if (c !== null && cut === null) {
          cut = c;
        }
      }
      const [fs, skipped] = rejectionFindings(
        sr,
        crash !== null,
        explained,
        several,
      );
      (out.findings ??= []).push(...fs);
      left += skipped;
      if (end === RepeatBudget || end === RepeatCancelled) {
        break;
      }
    }

    if (ran === 0) {
      // No suite ran far enough to compare. The first run says why.
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
          check_id: runtimeUnhandledRejectionsID,
          path: null,
          message:
            "The test suite did not run, so there is nothing to compare the strict run with. tests.existing says why.",
        },
      ];
      return out;
    }

    (out.limitations ??= []).push(...serviceLimitations(suites));
    if (!flakyKnown) {
      let why = "tests.flaky is not selected";
      if (input.selection === null || selected(input.selection, testsFlakyID)) {
        why = "tests.flaky did not report for this package";
      }
      out.limitations.push({
        reason_code: "flakiness_not_excluded",
        check_id: runtimeUnhandledRejectionsID,
        path: input.manifestPath(),
        message: `${capitalize(why)}, so a test that fails in the strict run may be flaky and not affected by the flag. Run tests.flaky as well to leave out the tests that differ between runs anyway.`,
      });
    }
    out.metrics = [
      newMetric({ name: "explained_by_flakiness", value: left, unit: "tests" }),
    ];
    if (cut !== null) {
      out.status = StatusPartial;
      out.reasonCode = cut.code;
      out.reason = cut.reason;
      out.keepsStatus = cut.end !== RepeatCancelled;
    }
    return out;
  },
};

register(runtimeUnhandledRejectionsID, runtimeUnhandledRejections);

/**
 * strictRunNumber is the number of the strict run among the runs of a suite:
 * the first run is 1, and tests.flaky makes the next flakyRepeats when it is
 * selected.
 */
export function strictRunNumber(input: Input): number {
  if (input.selection === null || selected(input.selection, testsFlakyID)) {
    return 2 + flakyRepeats;
  }
  return 2;
}

/**
 * rejectionFindings turns the first run and the strict run of the suite into
 * Findings, and counts the tests it left out because tests.flaky explains
 * them. crashed says that the strict run's process stopped, which makes its
 * never-run tests part of the crash Finding.
 */
export function rejectionFindings(
  s: SuiteRuns,
  crashed: boolean,
  explained: FlakyTests,
  qualify: boolean,
): [Finding[], number] {
  const out: Finding[] = [];
  let left = 0;
  const first = s.runs[0];
  const strict = s.runs[1];
  if (first === undefined || strict === undefined) {
    return [out, 0]; // the strict run produced no events
  }
  for (const key of s.orderedKeys()) {
    const before = s.observe(first, key);
    const after = s.observe(strict, key);
    if (!before.found || before.unknown || before.outcome !== "passed") {
      continue;
    }
    if (!after.found || after.unknown) {
      continue;
    }
    switch (after.outcome) {
      case TestFailed:
        break;
      case TestNeverRun:
        if (crashed) {
          continue;
        }
        break;
      default:
        continue;
    }
    if (explained.has(testKeyInSuite(s.name, key))) {
      left++;
      continue;
    }
    out.push(rejectionFinding(s, after, qualify));
  }
  return [out, left];
}

function rejectionFinding(
  s: SuiteRuns,
  after: Observation,
  qualify: boolean,
): Finding {
  const input = s.input;
  const rec = after.rec;
  if (rec === null) {
    throw new Error("a found test has a record");
  }
  const file = testFile(rec.file);
  const title = rec.fullTitle;
  const rule = ruleUnhandledRejection;

  const what =
    after.outcome === TestNeverRun
      ? "never ran because of a failed hook"
      : "failed";
  let at = { path: file, line: 0, col: 0 };
  if (rec.err !== null) {
    const f = locate(projectFrames(input, rec.err.stack), file);
    if (f.path === file) {
      at = f;
    }
  }
  const f = newFinding({
    check_id: runtimeUnhandledRejectionsID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      runtimeUnhandledRejectionsID,
      rule,
      file,
      title,
    ),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceLikely,
    title:
      "Test fails with strict unhandled rejections: " +
      oneLine(withoutControls(title), 200),
    message: `The test ${quote(shorten(title, 200))} passed in the normal run and ${what} with ${strictRejectionsFlag}. The normal run hides a promise that rejects without a handler, such as one that is neither awaited nor returned, and the strict run turns it into an error. Await the promise, return it or give it a catch handler, then run the test again.`,
    locations: [input.location("primary", at.path, at.line, at.col)],
    reproduction: input.reproduction(runtimeUnhandledRejectionsID),
    limitations: [],
  });
  if (after.outcome === TestNeverRun) {
    let text = "never run in the strict run";
    if (rec.neverRunReason !== "") {
      text += ": " + rec.neverRunReason;
    }
    f.evidence = [untrusted("test_run", text, runnerName(input))];
  } else if (rec.err !== null) {
    f.evidence = errorEvidence(rec.err, runnerName(input));
  }
  f.reproduction.test = {
    runner: runnerName(input),
    file,
    full_title: title,
    native_command: strictNativeCommand(
      nativeTestCommand(input, nativeBaseOfSuite(input), file, title),
    ),
  };
  s.attachSuite(f, qualify);
  return f;
}

/**
 * mochaOutsideSuite is the title Mocha gives the failure of an uncaught
 * error that no test or hook was running for.
 */
export const mochaOutsideSuite = "Uncaught error outside test suite";

/**
 * StrictCrash is an uncaught exception outside any test that cut the strict
 * run short.
 */
export interface StrictCrash {
  /** err is the error the runner recorded for it, null when it recorded none. */
  err: TestErr | null;
  /** text is what the process or the test file's process printed. */
  text: string;
  /** exit is the exit code of a process that stopped, null when not known. */
  exit: number | null;
  /**
   * byFlag is false when the first run was cut short the same way, so that
   * the flag is not the cause.
   */
  byFlag: boolean;
}

/**
 * findStrictCrash looks for the uncaught exception outside any test that
 * ended the strict run early: the failure that Mocha records for an error
 * outside the suite, a test file whose process stopped (node:test), or a
 * process that stopped before the run ended. It returns null when the strict
 * run went through, or ended for another reason such as its time limit.
 */
export function findStrictCrash(
  first: SuiteEvents,
  ev: SuiteEvents | null,
  res: Result,
  end: RepeatEnd,
): StrictCrash | null {
  if (end !== RepeatDone || ev === null) {
    return null;
  }
  for (const t of ev.tests) {
    if (
      t.outcome !== TestFailed ||
      t.title !== mochaOutsideSuite ||
      t.err === null
    ) {
      continue;
    }
    const message = t.err.message;
    const hadIt = first.tests.some(
      (f) =>
        f.title === mochaOutsideSuite &&
        f.err !== null &&
        f.err.message === message,
    );
    if (!hadIt) {
      return { err: t.err, text: "", exit: null, byFlag: true };
    }
  }
  for (const f of ev.files) {
    if (!first.files.some((g) => g.file === f.file)) {
      return { err: f.err, text: f.text, exit: null, byFlag: true };
    }
  }
  if (res.status === StatusCompleted && !ev.ended) {
    return {
      err: null,
      text: suiteStderr(res),
      exit: res.tool?.exit_code ?? null,
      byFlag: first.ended,
    };
  }
  return null;
}

function suiteStderr(res: Result): string {
  return res.suite === null || res.suite === undefined
    ? ""
    : goString(res.suite.stderr);
}

/**
 * crashFinding is the one Finding of a strict run that an uncaught exception
 * outside any test ended early.
 */
export function crashFinding(
  s: SuiteRuns,
  c: StrictCrash,
  qualify: boolean,
): Finding {
  const input = s.input;
  const rule = ruleUnhandledRejectionCrash;
  let stack = "";
  let first = "";
  if (c.err !== null) {
    stack = c.err.stack;
    first = errText(c.err);
  }
  if (first === "") {
    first = firstErrorLine(c.text);
  }
  const at = locate(
    projectFrames(input, stack + "\n" + c.text),
    input.manifestPath(),
  );
  const exit =
    c.exit === null ? "" : ` The process exited with code ${String(c.exit)}.`;
  const f = newFinding({
    check_id: runtimeUnhandledRejectionsID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      runtimeUnhandledRejectionsID,
      rule,
      at.path,
      first,
    ),
    kind: KindDefect,
    severity: SeverityWarning,
    confidence: ConfidenceLikely,
    title: "The strict run ends early on an uncaught exception",
    message: `With ${strictRejectionsFlag} the run of the suite ${quote(s.name)} ended early on an uncaught exception outside any test, while the normal run went through.${exit} The usual cause is a promise that rejects without a handler outside any test, which Node raises as an uncaught exception in strict mode. The tests that never ran in the strict run are not reported on their own. The error is in the Evidence.`,
    locations: [input.location("primary", at.path, at.line, at.col)],
    reproduction: input.reproduction(runtimeUnhandledRejectionsID),
    limitations: [],
  });
  let evidence: Evidence[] = [];
  if (c.err !== null) {
    evidence = errorEvidence(c.err, runnerName(input));
  } else if (trimSpace(c.text) !== "") {
    evidence = [
      untrusted(
        "tool_output",
        relativeStack(tail(trimSpace(c.text), 6000)),
        runnerName(input),
      ),
    ];
  }
  if (evidence.length > 0) {
    f.evidence = evidence;
  }
  s.attachSuite(f, qualify);
  return f;
}

/**
 * strictNativeCommand puts the flag into the environment of the project's own
 * command for one test, which starts with `env K=V …` when the test command
 * sets variables. An existing NODE_OPTIONS gets the flag after its value.
 */
export function strictNativeCommand(cmd: readonly string[]): string[] {
  const name = "NODE_OPTIONS=";
  if (cmd.length > 0 && cmd[0] === "env") {
    const out = [...cmd];
    let i = 1;
    for (; i < out.length && isEnvAssignment(out[i] ?? ""); i++) {
      const arg = out[i] ?? "";
      if (arg.startsWith(name)) {
        out[i] = arg + " " + strictRejectionsFlag;
        return out;
      }
    }
    out.splice(1, 0, name + strictRejectionsFlag);
    return out;
  }
  return ["env", name + strictRejectionsFlag, ...cmd];
}

/** isEnvAssignment says whether an argument of env is NAME=value. */
function isEnvAssignment(arg: string): boolean {
  const eq = arg.indexOf("=");
  if (eq <= 0) {
    return false;
  }
  return /^[A-Za-z0-9_]+$/.test(arg.slice(0, eq));
}
