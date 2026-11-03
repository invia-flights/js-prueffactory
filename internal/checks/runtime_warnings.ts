// runtime.warnings (Go: runtime_warnings.go) and what every first run of a
// suite records for it. The Check reads what the shared test run showed
// about the process; it does not run the tests a second time.
import { randomBytes } from "node:crypto";

import { parseMochaArgs, RunnerNodeTest } from "../discovery/discovery.ts";
import type { ContainerResult, EndMarker } from "../docker/driver.ts";
import { fields, trimRight, trimSpace } from "../gocompat/strings.ts";
import { goString } from "../gocompat/utf8.ts";
import {
  fingerprintWithSuite,
  newFingerprint,
} from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  type Limitation,
  NotApplicable,
  SeverityNote,
  SeverityWarning,
  StatusCompleted,
  StatusUnsupported,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { shorten } from "./cut_text.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { selected } from "./selection.ts";
import {
  initServiceNotStarted,
  noteServicesNotStarted,
  serviceNotStarted,
} from "./service_not_started.ts";
import { shownPackage, shownPath } from "./shown_text.ts";
import type { SuiteEvents } from "./test_events.ts";
import {
  type Frame,
  oneLine,
  projectFrames,
  relativeStack,
  runnerName,
} from "./test_report.ts";
import { perSuite, SuiteLimitations, suiteCount } from "./test_suites.ts";
import { sharedSuite, testsCoverageID } from "./tests_coverage.ts";
import {
  runSuite,
  testRunApplicability,
  testsExisting,
  testsExistingID,
  unsupportedTests,
} from "./tests_existing.ts";

export const runtimeWarningsID = "runtime.warnings";

/**
 * runtimeWarnings reports what the test run of tests.existing showed about
 * the process: warnings and deprecations Node printed, resources the tests
 * left open, and a process that stayed alive after the tests finished. It
 * does not run the tests a second time. Both Checks read one run of the
 * suite (see sharedSuite), made with Node's warning flags when this Check is
 * selected. It has no Gates.
 */
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

  /** The Check needs what the test run needs. */
  prerequisites(c) {
    return testsExisting.prerequisites?.(c) ?? [];
  },

  usesWorkingCopy() {
    return true;
  },

  /**
   * usesServices: when this Check starts the shared run, the suite gets the
   * project's test Services like it does for tests.existing.
   */
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
    const raw = await sharedSuite(signal, input);
    const out: Result = { status: StatusCompleted };
    if (raw.command !== undefined) {
      out.command = raw.command;
    }
    if (
      input.selection !== null &&
      !selected(input.selection, testsExistingID) &&
      !selected(input.selection, testsCoverageID)
    ) {
      // Nothing else reports the run, so this Check reports its Services.
      if (raw.services !== undefined) {
        out.services = raw.services;
      }
    }
    const parts = perSuite(raw);
    const ran = parts.filter((p) => p.suite != null).length;
    if (ran === 0) {
      if (raw.status !== StatusCompleted) {
        out.status = raw.status;
        out.reasonCode = raw.reasonCode ?? "";
        out.reason = raw.reason ?? "";
        return out;
      }
      out.status = StatusCompleted;
      out.limitations = [
        {
          reason_code: "tests_not_run",
          check_id: runtimeWarningsID,
          path: null,
          message:
            "The test suite did not run, so there is no run to read warnings and open resources from. tests.existing says why.",
        },
      ];
      return out;
    }
    // A run that did not complete keeps its status, and whatever it printed
    // before it ended still counts. The partial status of a package with a
    // suite that may need a Service the Run did not start (or that an Init
    // service prepares) is about the Pass rate, which this Check does not
    // report, so it does not carry over.
    if (
      raw.reasonCode !== serviceNotStarted &&
      raw.reasonCode !== initServiceNotStarted
    ) {
      out.status = raw.status;
      out.reasonCode = raw.reasonCode ?? "";
      out.reason = raw.reason ?? "";
    } else {
      out.status = StatusCompleted;
    }

    // Warnings and open resources are read per suite. In a package with
    // several suites the Findings name their suite, and so do the Limitations
    // that hold for the suites they are listed with.
    const several = suiteCount(pkg) > 1;
    const limitations = new SuiteLimitations();
    for (const [i, p] of parts.entries()) {
      const run = p.suite;
      if (run === undefined || run === null) {
        continue;
      }
      const bound = input.forSuite(i);
      const [warnings, cut] = warningFindings(bound, goString(run.stderr));
      const findings = [
        ...warnings,
        ...suiteHealthFindings(bound, run.events, run.hung),
      ];
      const name = bound.suite()?.origin ?? "";
      for (const f of findings) {
        if (several) {
          f.suite = name;
          f.fingerprint = fingerprintWithSuite(f.fingerprint, name);
        }
        // A suite that may need a Service the Run did not start can leave
        // failed lookups and sockets open because of it.
        noteServicesNotStarted(f, name, p.mayNeed ?? []);
      }
      (out.findings ??= []).push(...findings);
      for (const l of warningLimitations(bound, run, cut)) {
        limitations.add(l, name, several);
      }
    }
    out.limitations = limitations.list();
    return out;
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

/**
 * warningLimitations lists where the Check's view of the run is incomplete.
 */
export function warningLimitations(
  input: Input,
  suite: SuiteRun,
  cut: number,
): Limitation[] {
  const manifest = input.manifestPath();
  const add = (code: string, message: string): Limitation => ({
    reason_code: code,
    message,
    check_id: runtimeWarningsID,
    path: manifest,
  });
  const out: Limitation[] = [];
  if (input.selection !== null && !selected(input.selection, testsExistingID)) {
    // When tests.existing is selected it lists the override of NODE_OPTIONS
    // for the run both Checks read, so it is listed once.
    out.push(nodeOptionsLimitation(input, runtimeWarningsID));
  }
  if (suite.runner === RunnerNodeTest) {
    out.push(
      add(
        "open_resources_not_collected",
        "Open resources are not collected for node:test suites, because node --test runs every test file in its own process and our reporter lives in the parent. A process that stays alive after the tests is still reported.",
      ),
    );
  }
  const flag = suppressedWarnings(input);
  if (flag !== "") {
    out.push(
      add(
        "warnings_suppressed",
        `The project's test command sets ${flag}, so Node prints fewer or no warnings and this Check sees only what gets through.`,
      ),
    );
  }
  if (cut > 0) {
    out.push(
      add(
        "warnings_truncated",
        `${String(cut)} more distinct warnings were printed than the ${String(maxWarningFindings)} that are reported.`,
      ),
    );
  }
  return out;
}

/**
 * suppressedWarnings names what in the project's test command silences
 * Node's warnings, or returns "".
 */
export function suppressedWarnings(input: Input): string {
  const tc = input.suite();
  if (tc === null) {
    return "";
  }
  if (tc.env.get("NODE_NO_WARNINGS") === "1") {
    return "NODE_NO_WARNINGS=1";
  }
  const words = fields(tc.env.get("NODE_OPTIONS") ?? "");
  for (const a of parseMochaArgs(tc.args)) {
    words.push(...a.words);
  }
  for (const flag of ["--no-warnings", "--no-deprecation"]) {
    if (words.includes(flag) || tc.args.includes(flag)) {
      return flag;
    }
  }
  return "";
}

/**
 * maxWarningFindings caps the distinct warnings one suite turns into
 * Findings. The rest is counted and reported as a Limitation.
 */
export const maxWarningFindings = 100;

/**
 * maxStackLines is how many frames of a trace the Evidence keeps.
 */
const maxStackLines = 30;

/**
 * nodeWarning is the first line of a warning that Node printed to stderr:
 * "(node:7) [DEP0005] DeprecationWarning: message". The code is absent for
 * warnings that have none. RE2's `.` matches everything but a line feed, so
 * the `s` flag stands in for it: a line holds no line feed.
 */
const nodeWarning =
  /^\(node:\d+\) (?:\[([A-Za-z0-9_]+)\] )?([A-Za-z]*Warning): (.*)$/s;

/**
 * stackLine is one "    at ..." line of a trace (RE2's \s is
 * [\t\n\f\r ]).
 */
const stackLine = /^[\t\n\f\r ]+at (.*)$/s;

/**
 * framePath finds the file of a frame: the text in parentheses, or the whole
 * text of a frame without a function name, minus its line and column. It is
 * what Go's `^(?:.*\()?(.*?):\d+(?::\d+)?\)?$` captures, found by a linear
 * scan: the pattern backtracks quadratically in a regular expression
 * engine over a long line (a stack line can be as long as stderr), and RE2
 * does not. It returns null where the pattern does not match.
 */
export function framePath(frame: string): string | null {
  const s = frame;
  // The optional ")" at the end can only be matched by `\)?`.
  const t = s.endsWith(")") ? s.slice(0, -1) : s;
  let i2 = t.length;
  while (i2 > 0 && isDigit(t.charCodeAt(i2 - 1))) {
    i2--;
  }
  if (i2 === t.length || i2 === 0 || t[i2 - 1] !== ":") {
    return null; // no ":digits" at the end
  }
  const cB = i2 - 1; // the colon of the last number
  // A second number before it: ":digits:digits".
  let cA = -1;
  let i1 = cB;
  while (i1 > 0 && isDigit(t.charCodeAt(i1 - 1))) {
    i1--;
  }
  if (i1 < cB && i1 > 0 && t[i1 - 1] === ":") {
    cA = i1 - 1;
  }
  // `(?:.*\()?` is greedy: the last "(" that leaves room for the rest wins,
  // else the group is skipped.
  let p = 0;
  const q = t.lastIndexOf("(", cB - 1);
  if (q >= 0) {
    p = q + 1;
  }
  const c = cA >= p ? cA : cB;
  return t.slice(p, c);
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** RawWarning is a warning as it stands in stderr, before it becomes a Finding. */
export interface RawWarning {
  code: string;
  name: string;
  message: string;
  /** stack are the "at" lines, in order. */
  stack: string[];
  count: number;
}

/**
 * parseNodeWarnings reads the warnings Node printed, with their stack
 * traces. A trace is the run of "at" lines right below the warning line; the
 * hint line that Node prints without --trace-warnings ends it. The same
 * warning at the same place is one entry with a count. Nothing but Node's
 * own warning lines is read, so the project's test output does not get in.
 */
export function parseNodeWarnings(stderr: string): RawWarning[] {
  const out: RawWarning[] = [];
  const byKey = new Map<string, RawWarning>();
  const lines = stderr.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = nodeWarning.exec(trimRight(lines[i] ?? "", "\r"));
    if (m === null) {
      continue;
    }
    const w: RawWarning = {
      code: m[1] ?? "",
      name: m[2] ?? "",
      message: trimSpace(m[3] ?? ""),
      stack: [],
      count: 1,
    };
    for (; i + 1 < lines.length; i++) {
      const sm = stackLine.exec(trimRight(lines[i + 1] ?? "", "\r"));
      if (sm === null) {
        break;
      }
      w.stack.push(sm[1] ?? "");
    }
    const key = [w.name, w.code, w.message, topFrameFile(w.stack)].join("\x00");
    const seen = byKey.get(key);
    if (seen !== undefined) {
      seen.count++;
      continue;
    }
    byKey.set(key, w);
    out.push(w);
  }
  return out;
}

/**
 * frameFile is the file a frame points into, or "" for a frame that is not a
 * file, such as "new Promise (<anonymous>)".
 */
export function frameFile(frame: string): string {
  const m = framePath(trimSpace(frame));
  if (m === null) {
    return "";
  }
  return m.startsWith("file://") ? m.slice("file://".length) : m;
}

/** isNodeInternal says whether a file belongs to Node itself. */
function isNodeInternal(file: string): boolean {
  return file.startsWith("node:") || file.startsWith("internal/");
}

/** topFrameFile is the file of the first frame that is not Node's own, or "". */
export function topFrameFile(stack: readonly string[]): string {
  for (const f of stack) {
    const file = frameFile(f);
    if (file !== "" && !isNodeInternal(file)) {
      return file;
    }
  }
  return "";
}

/** dependencyOf names the package a path inside node_modules belongs to, or "". */
export function dependencyOf(file: string): string {
  const marker = "/node_modules/";
  const i = ("/" + file).lastIndexOf(marker);
  if (i < 0) {
    return "";
  }
  let rest = ("/" + file).slice(i + marker.length);
  while (rest.startsWith("/")) {
    rest = rest.slice(1);
  }
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  if (first.startsWith("@") && parts.length > 1) {
    return first + "/" + (parts[1] ?? "");
  }
  return first;
}

/**
 * warningFindings turns the warnings in the stderr of a test run into
 * Findings, and says how many distinct warnings were left out because of the
 * cap. A warning is from a dependency when the top frame that is not Node's
 * own lies in node_modules, and from the project otherwise. None is a Gate.
 */
export function warningFindings(
  input: Input,
  stderr: string,
): [Finding[], number] {
  const findings: Finding[] = [];
  let cut = 0;
  for (const w of parseNodeWarnings(stderr)) {
    if (findings.length >= maxWarningFindings) {
      cut++;
      continue;
    }
    findings.push(warningFinding(input, w));
  }
  return [findings, cut];
}

function warningFinding(input: Input, w: RawWarning): Finding {
  const top = topFrameFile(w.stack);
  const dep = dependencyOf(top);
  let rule = "warning-from-project";
  let severity: Finding["severity"] = SeverityWarning;
  let origin = "the project's own code";
  if (dep !== "") {
    rule = "warning-from-dependency";
    severity = SeverityNote;
    origin = "the dependency " + shownPackage(dep);
  }
  let kind = w.name;
  if (w.code !== "") {
    kind += " " + w.code;
  }

  const head = input.manifestPath();
  let at: Frame = { path: head, line: 0, col: 0 };
  const frames = projectFrames(input, w.stack.join("\n"));
  if (frames.length > 0 && frames[0] !== undefined) {
    at = frames[0];
  }

  let message = `Node printed the ${kind} while the tests ran, and it comes from ${origin}: ${oneLine(w.message, 400)}`;
  if (at.path !== head) {
    message += ` The first frame in the project is ${shownPath(at.path)}.`;
  }
  if (w.count > 1) {
    message += ` It was printed ${String(w.count)} times.`;
  }

  const stack =
    w.stack.length > maxStackLines ? w.stack.slice(0, maxStackLines) : w.stack;
  let text = w.name + ": " + w.message;
  if (stack.length > 0) {
    text += "\n    at " + stack.join("\n    at ");
  }
  return newFinding({
    check_id: runtimeWarningsID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      runtimeWarningsID,
      rule,
      at.path,
      kind + " " + w.message + " " + dep,
    ),
    kind: KindDefect,
    severity,
    confidence: ConfidenceConfirmed,
    title: shorten(kind + ": " + oneLine(w.message, 140), 200),
    message,
    locations: [input.location("primary", at.path, at.line, at.col)],
    evidence: [
      untrusted("stack_trace", relativeStack(text), runnerName(input)),
    ],
    reproduction: input.reproduction(runtimeWarningsID),
    limitations: [],
  });
}

// --- resources left open ---

/**
 * resourceKinds explains the resource types process.getActiveResourcesInfo()
 * returns, for the ones a test suite usually leaves open.
 */
const resourceKinds = new Map<string, string>([
  [
    "TCPServerWrap",
    "a listening TCP server (net.Server, such as an HTTP server)",
  ],
  ["TCPSocketWrap", "an open TCP socket or client connection"],
  ["Timeout", "a pending timer (setTimeout or setInterval)"],
  ["Immediate", "a pending setImmediate callback"],
  ["ProcessWrap", "a running child process"],
  ["FSWatcher", "a file watcher"],
  ["FSEvent", "a file watcher"],
  ["UDPWrap", "an open UDP socket"],
  ["PipeWrap", "an open pipe or Unix socket"],
  ["TTYWrap", "an open terminal stream"],
]);

/**
 * safeResourceName is what a resource type from the reporter must look like.
 * The names come from the project's process, so anything else is left out.
 */
const safeResourceName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * describeResources turns the list of open resources into counted names, in
 * the order they first appear, and says what the usual ones are.
 */
export function describeResources(
  resources: readonly string[],
): [counted: string, explained: string] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const r of resources) {
    if (!safeResourceName.test(r)) {
      continue;
    }
    const n = counts.get(r) ?? 0;
    if (n === 0) {
      order.push(r);
    }
    counts.set(r, n + 1);
  }
  const names: string[] = [];
  const notes: string[] = [];
  for (const [i, r] of order.entries()) {
    if (i >= 20) {
      break;
    }
    const n = counts.get(r) ?? 0;
    names.push(n > 1 ? `${String(n)} x ${r}` : r);
    const what = resourceKinds.get(r);
    if (what !== undefined) {
      notes.push(r + " is " + what);
    }
  }
  return [names.join(", "), notes.join("; ")];
}

/**
 * suiteHealthFindings are the Findings about how the test process ended. A
 * process that stayed alive after the tests finished is one Finding that
 * lists the open resources; otherwise open resources are one Finding of
 * their own. A run that reported no list, such as a node:test run, has no
 * resource Finding.
 */
export function suiteHealthFindings(
  input: Input,
  ev: SuiteEvents,
  hung: boolean,
): Finding[] {
  let counted = "";
  let explained = "";
  if (ev.resourcesKnown) {
    [counted, explained] = describeResources(ev.resources);
  }
  const manifest = input.manifestPath();
  const runner = runnerName(input);
  let fingerprintText = counted;

  let rule: string;
  let title: string;
  let message: string;
  if (hung) {
    rule = "process-did-not-exit";
    title = "process did not exit after tests finished";
    message = `The test process was still running 30 seconds after the ${runner} reporter wrote its end event, so the tool stopped the container. Every result was recorded, so the test counts are complete. A suite that keeps its process alive makes the project's own CI run hang unless it forces an exit.`;
    if (!ev.resourcesKnown) {
      message += " This runner does not list the resources that were open.";
    } else if (counted === "") {
      message +=
        " Node does not list any resource that keeps it running, so the cause may be a child process or a native module.";
    } else {
      message += " Open at the end: " + counted + ".";
    }
    fingerprintText = "hung";
  } else if (counted !== "") {
    rule = "open-resources";
    title = "Resources are still open after the tests";
    message =
      "When the test run ended, these resources were still open: " +
      counted +
      ". A forced exit (Mocha's `exit`) hides them, and they keep the process alive without it.";
  } else {
    return [];
  }
  if (explained !== "") {
    message += " " + explained + ".";
  }
  return [
    newFinding({
      check_id: runtimeWarningsID,
      context_id: input.context.id,
      rule_id: rule,
      fingerprint: newFingerprint(
        runtimeWarningsID,
        rule,
        manifest,
        fingerprintText,
      ),
      kind: KindDefect,
      severity: SeverityWarning,
      confidence: ConfidenceConfirmed,
      title,
      message,
      locations: [input.location("primary", manifest, 0, 0)],
      reproduction: input.reproduction(runtimeWarningsID),
      limitations: [],
    }),
  ];
}
