// A suite whose tests need a compose Service the Run did not start (an
// unknown family, a private registry, a build section) fails for reasons
// outside the project (Go: service_not_started.go). The Run cannot tell for
// sure what a test needs, so it marks a suite as "may need Service <name>"
// in two ways:
//
//   - static: the package's env files or Test code refer to the Service (see
//     discovery ServiceRef). That is a heuristic.
//   - runtime: a failing test or hook shows a lookup or connection error for
//     the Service's name.
//
// A marked suite gets a Limitation per Service, its failed tests and hooks
// are no Gates and carry a note, and tests.existing is partial, so that the
// Benchmark does not measure the Pass rate (see runSuites). The Findings of
// runtime.warnings, runtime.unhandled-rejections and tests.flaky from a
// marked suite carry the note too and are suspected (see
// noteServicesNotStarted).
import { sortStrings } from "../gocompat/strings.ts";
import { quote } from "../resultset/quote.ts";
import {
  ConfidenceSuspected,
  type Finding,
  type Limitation,
  SeverityNote,
  StatusCompleted,
  StatusPartial,
} from "../resultset/types.ts";
import type { Input, Result } from "./input.ts";
import { shownName } from "./shown_text.ts";
import { oneLine } from "./test_report.ts";

export const serviceNotStarted = "service_not_started";

/**
 * shownService is a compose service name as trusted text allows it: the name
 * is the project's own, so one with unusual characters is replaced (hardening
 * beyond Go, which wrote it raw; plain names read the same).
 */
export function shownService(name: string): string {
  return shownName(name, "Service name");
}

const testsExistingID = "tests.existing";

/** ServiceMark says why a suite may need a Service the Run did not start. */
export interface ServiceMark {
  service: string;
  /** notStarted is why the Run did not start it, from the compose file. */
  notStarted: string;
  /**
   * file and line are where the package refers to the Service, for a static
   * mark. A runtime mark has no line and its Evidence says what was seen.
   */
  file: string;
  line: number;
  static: boolean;
  /** seen is the error text of a runtime mark, as found in a Finding. */
  seen: string;
}

/**
 * notStartedServices are the compose Services the Run does not start for a
 * reason of the compose file, by name.
 */
function notStartedServices(input: Input): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of input.project.services) {
    if (s.notStarted !== null) {
      out.set(s.name, s.notStarted.reason);
    }
  }
  return out;
}

/**
 * lookupError matches the codes of a failed name lookup or connection
 * (RE2's \b is ASCII, as JavaScript's without the u flag).
 */
const lookupError = /\b(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH)\b/;

/** hostChar: [A-Za-z0-9_.-], what a host name cannot be next to. */
function hostChar(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c === 0x2e ||
    c === 0x2d
  );
}

/** re2Space: RE2's \s, [\t\n\f\r ]. */
function re2Space(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

const afterHost = new Set(":/'\"`)]},;".split("").map((c) => c.charCodeAt(0)));

/**
 * namesHost says whether text names the host, as a whole host name: not a
 * longer name or a sub-domain of it. It is Go's
 * `(?:^|[^A-Za-z0-9_.-])` + QuoteMeta(host) + `(?:$|[:/\s'"`)\]},;]|\.(?:\s|$))`,
 * as a scan over the host's occurrences.
 */
export function namesHost(text: string, host: string): boolean {
  if (host === "") {
    return false;
  }
  for (let i = text.indexOf(host); i >= 0; i = text.indexOf(host, i + 1)) {
    if (i > 0 && hostChar(text.charCodeAt(i - 1))) {
      continue;
    }
    const j = i + host.length;
    if (j === text.length) {
      return true;
    }
    const c = text.charCodeAt(j);
    if (re2Space(c) || afterHost.has(c)) {
      return true;
    }
    if (
      c === 0x2e &&
      (j + 1 === text.length || re2Space(text.charCodeAt(j + 1)))
    ) {
      return true;
    }
  }
  return false;
}

/** findingText is everything a Finding says about its failure. */
function findingText(f: Finding): string {
  return f.message + f.evidence.map((e) => "\n" + e.text).join("");
}

/**
 * isTestFailure says whether a Finding is a failed test or hook, which an
 * affected suite does not blame on the project.
 */
function isTestFailure(f: Finding): boolean {
  return f.rule_id === "test-failed" || f.rule_id === "hook-failed";
}

/**
 * isStopFailure says whether a Finding is a file that did not load or a run
 * that stopped, which only a lookup or connection error ties to a Service.
 */
function isStopFailure(f: Finding): boolean {
  return (
    f.rule_id === "test-file-load-failed" || f.rule_id === "test-run-aborted"
  );
}

/**
 * codeDefect matches the error texts of a file that cannot load because of
 * the code itself, not because a Service is missing: a syntax error or a
 * module that does not resolve. Such a failure stays a Gate in an affected
 * suite.
 */
const codeDefect =
  /\b(?:SyntaxError|ReferenceError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION)\b|Cannot find (?:module|package)/;

/**
 * serviceMarks is every way the suite of the Result may need a Service that
 * was not started, one mark per Service: the static ones first, then the
 * runtime ones for the Services not already marked.
 */
export function serviceMarks(input: Input, res: Result): ServiceMark[] {
  const missing = notStartedServices(input);
  if (missing.size === 0) {
    return [];
  }
  const marks: ServiceMark[] = [];
  const seen = new Set<string>();
  for (const ref of input.context.package?.serviceRefs ?? []) {
    const why = missing.get(ref.service);
    if (why !== undefined && !seen.has(ref.service)) {
      seen.add(ref.service);
      marks.push({
        service: ref.service,
        notStarted: why,
        file: ref.file,
        line: ref.line,
        static: true,
        seen: "",
      });
    }
  }
  const names = sortStrings([...missing.keys()]);
  for (const f of res.findings ?? []) {
    if (!isTestFailure(f) && !isStopFailure(f)) {
      continue;
    }
    const text = findingText(f);
    const code = lookupError.exec(text)?.[0];
    if (code === undefined) {
      continue;
    }
    for (const name of names) {
      if (!seen.has(name) && namesHost(text, name)) {
        seen.add(name);
        marks.push({
          service: name,
          notStarted: missing.get(name) ?? "",
          file: "",
          line: 0,
          static: false,
          seen:
            code +
            " for " +
            shownService(name) +
            " in the failing test or hook: " +
            quote(oneLine(f.title, 120)),
        });
      }
    }
  }
  return marks;
}

/**
 * stopMayComeFromService says whether a file that did not load, or a run
 * that stopped, may come from a Service that was not started. A lookup or
 * connection error says so. In a suite that refers to the Service by name
 * (a static mark) a plain error thrown by a setup file counts too, because
 * the project's own error text often hides the lookup error, unless the
 * text shows a defect of the code itself.
 */
function stopMayComeFromService(text: string, isStatic: boolean): boolean {
  if (lookupError.test(text)) {
    return true;
  }
  return isStatic && !codeDefect.test(text);
}

/**
 * markServicesNotStarted applies the marks to the result of one suite and
 * returns the names of the Services the suite may need. It adds a
 * Limitation per Service, takes the Gate from the failures of the suite that
 * can come from the missing Service and adds the note to them. It touches a
 * suite that ran and nothing else.
 */
export function markServicesNotStarted(input: Input, res: Result): string[] {
  const suite = input.suite();
  if (res.status !== StatusCompleted || suite === null) {
    return [];
  }
  const marks = serviceMarks(input, res);
  if (marks.length === 0) {
    return [];
  }
  const names = marks.map((m) => m.service);
  const note =
    serviceNote(suite.origin, names, "failure") + " It is not a Gate.";
  const isStatic = marks.some((m) => m.static);
  for (const f of res.findings ?? []) {
    const demote =
      isTestFailure(f) ||
      (isStopFailure(f) && stopMayComeFromService(findingText(f), isStatic));
    if (!demote || !f.gate) {
      continue;
    }
    f.gate = false;
    f.confidence = ConfidenceSuspected;
    f.message += " " + note;
    f.limitations.push(serviceNotStarted);
  }
  for (const m of marks) {
    (res.limitations ??= []).push(
      serviceLimitation(
        input,
        testsExistingID,
        m,
        "",
        "Its failed tests and hooks are not Gates and carry a note, and tests.existing is partial, so the Benchmark does not measure the Pass rate.",
      ),
    );
  }
  return names;
}

/**
 * serviceLimitation is the Limitation of one mark of the suite, reported by
 * the Check checkID. where says in which run a runtime mark was seen, empty
 * for the first run, and effect what the mark does to the Check's results.
 */
export function serviceLimitation(
  input: Input,
  checkID: string,
  m: ServiceMark,
  where: string,
  effect: string,
): Limitation {
  let path = input.manifestPath();
  let how: string;
  if (m.static) {
    path = m.file;
    how = `The file ${quote(m.file)} refers to it in line ${String(m.line)}. That is a heuristic over env files and Test code, and it may be wrong.`;
  } else {
    how = "A test of the suite failed with " + m.seen + where + ".";
  }
  return {
    reason_code: serviceNotStarted,
    message: `The suite ${quote(input.suite()?.origin ?? "")} may need the compose Service ${shownService(m.service)}, which the Run did not start: ${m.notStarted}. ${how} ${effect}`,
    check_id: checkID,
    path,
  };
}

/**
 * servicesOfRuns is what the suite may need of the Services the Run did not
 * start, by the marks of the runs a Check made or read itself
 * (runtime.unhandled-rejections, tests.flaky): the static marks always, and
 * the runtime marks of a lookup or connection error in any of the runs, the
 * first run of the suite before the Check's own. The names are in the order
 * the marks were first found; limits are the Limitations the Check reports
 * for the Services the first run did not mark.
 */
export function servicesOfRuns(
  input: Input,
  checkID: string,
  first: Result,
  own: readonly Result[],
): [string[], Limitation[]] {
  const effect = `The Findings of ${checkID} from the suite carry a note and are suspected.`;
  const names: string[] = [];
  const limits: Limitation[] = [];
  for (const [i, r] of [first, ...own].entries()) {
    const where = i > 0 ? " in a run " + checkID + " made" : "";
    for (const m of serviceMarks(input, r)) {
      if (names.includes(m.service)) {
        continue;
      }
      names.push(m.service);
      if (!(first.mayNeed ?? []).includes(m.service)) {
        limits.push(serviceLimitation(input, checkID, m, where, effect));
      }
    }
  }
  return [names, limits];
}

/**
 * serviceNote says that a Finding of the suite may come from the Services
 * it may need and the Run did not start. what names the Finding: "failure",
 * "warning", "note".
 */
export function serviceNote(
  suite: string,
  services: readonly string[],
  what: string,
): string {
  return `The suite ${quote(suite)} may need the compose Service ${services.map(shownService).join(", ")}, which the Run did not start, so this ${what} may come from that and not from the project.`;
}

/**
 * noteServicesNotStarted marks a Finding of runtime.warnings,
 * runtime.unhandled-rejections or tests.flaky from a suite that may need
 * Services the Run did not start: the note, worded for a warning or a note,
 * confidence suspected and the Limitation reference. Without services it
 * does nothing.
 */
export function noteServicesNotStarted(
  f: Finding,
  suite: string,
  services: readonly string[],
): void {
  if (services.length === 0) {
    return;
  }
  const what = f.severity === SeverityNote ? "note" : "warning";
  f.message += " " + serviceNote(suite, services, what);
  f.confidence = ConfidenceSuspected;
  f.limitations.push(serviceNotStarted);
}

/**
 * serviceNotStartedStatus makes tests.existing partial when a suite may need
 * a Service that was not started, unless the package's run already ended in
 * another way that says more.
 */
export function serviceNotStartedStatus(
  res: Result,
  bySuite: ReadonlyMap<string, readonly string[]>,
  order: readonly string[],
): void {
  if (bySuite.size === 0 || res.status !== StatusCompleted) {
    return;
  }
  const parts: string[] = [];
  for (const suite of order) {
    const names = bySuite.get(suite) ?? [];
    if (names.length > 0) {
      parts.push(
        `${quote(suite)} (Service ${names.map(shownService).join(", ")})`,
      );
    }
  }
  res.status = StatusPartial;
  res.reasonCode = serviceNotStarted;
  res.reason =
    "tests of " +
    parts.join(", ") +
    " may need a compose Service the Run did not start, so their failures are not Gates and the Pass rate is not measured";
}
