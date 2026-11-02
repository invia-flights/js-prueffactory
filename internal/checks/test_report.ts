// The test report (Go: test_report.go): the events of one suite become test
// cases, Findings and the package's counts, and a failed test or hook gets
// everything an agent needs to fix it, the project's own command to re-run
// it included.
import { RunnerMocha, RunnerNodeTest } from "../discovery/discovery.ts";
import { quote as goQuote } from "../gocompat/fmt.ts";
import { clean, ext, isAbs, join } from "../gocompat/path.ts";
import { quoteMeta } from "../gocompat/quotemeta.ts";
import { compareBytes, fields, trimSpace } from "../gocompat/strings.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import {
  ConfidenceConfirmed,
  type Evidence,
  type Finding,
  KindDefect,
  type PackageTests,
  SeverityError,
  type TestFileCount,
  TestFailed,
  TestNeverRun,
  type TestOutcome,
  TestPassed,
  TestSkipped,
  TestTodo,
} from "../resultset/types.ts";
import { newFinding, newTestCase } from "../resultset/zero.ts";
import { shorten, tail } from "./cut_text.ts";
import { shownPath } from "./shown_text.ts";
import { type Input, type SuiteTestCase, untrusted } from "./input.ts";
import { workMount } from "./package_install.ts";
import {
  errorText,
  errText,
  type FileFailure,
  type HookFailure,
  orEmpty,
  type SuiteEvents,
  type TestErr,
  type TestRecord,
} from "./test_events.ts";
import { atoiOrZero } from "../gocompat/strconv.ts";

const testsExistingID = "tests.existing";

/** oneLine is s on one line, its runs of white space as one space, cut to about n bytes. */
export function oneLine(s: string, n: number): string {
  return shorten(fields(s).join(" "), n);
}

/**
 * SuiteResults is what the events of one suite turn into: the test cases,
 * the Findings and the package's counts for the Inventory.
 */
export interface SuiteResults {
  findings: Finding[];
  testCases: SuiteTestCase[];
  inventory: PackageTests;
  /** files counts the tests of each test file, for the Benchmark's pass rate. */
  files: TestFileCount[];
}

/** newPackageTests is a zero count row of the Context. */
export function newPackageTests(contextID: string): PackageTests {
  return {
    context_id: contextID,
    found: 0,
    run: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    focused: 0,
    never_run: 0,
  };
}

/**
 * suiteResults turns the events of a finished or interrupted suite into
 * test cases, Findings and counts. native is the start of the project's own
 * command for re-running one test: the runner, with the project's options
 * but without its test files.
 *
 * A failed test is a Gate Finding. A failed hook is one Gate Finding however
 * many tests it affects, and those tests are never_run with the hook as the
 * reason, not failures. A test that has no result is never_run: because of
 * a hook, because a .only excluded it, or because the run stopped.
 */
export function suiteResults(
  input: Input,
  ev: SuiteEvents,
  native: readonly string[],
): SuiteResults {
  const r: SuiteResults = {
    findings: [],
    testCases: [],
    inventory: newPackageTests(input.context.id),
    files: [],
  };

  const hookIndex = new Map<string, number>();
  const hookOf: number[] = []; // hook failure -> index of its Finding
  for (const h of ev.hooks) {
    const key = [h.file, h.scope, h.type, errText(h.err)].join("\x00");
    let idx = hookIndex.get(key);
    if (idx === undefined) {
      idx = r.findings.length;
      hookIndex.set(key, idx);
      r.findings.push(hookFinding(input, h, native));
    }
    hookOf.push(idx);
  }

  for (const f of ev.files) {
    r.findings.push(fileFailureFinding(input, f, ev.testsOf(f.file) > 0));
  }

  const files = new Map<string, TestFileCount>();
  const anyFocused = ev.tests.some((t) => t.focused);
  for (const t of ev.tests) {
    if (t.outcome === "") {
      explainNeverRun(input, t, ev, hookOf, anyFocused);
    }
    const tc: SuiteTestCase = {
      testCase: newTestCase({
        file: testFile(t.file),
        full_title: t.fullTitle,
        suite_path: [...t.suitePath],
        outcome: t.outcome as TestOutcome,
        attempts: [],
        finding_ids: [],
      }),
      findings: [],
    };
    if (t.outcome === "") {
      tc.testCase.outcome = TestNeverRun;
      tc.testCase.never_run_reason = t.neverRunReason;
      if (t.hookFinding >= 0) {
        tc.findings = [t.hookFinding];
      }
    } else {
      tc.testCase.attempts.push(...t.attempts, {
        outcome: t.outcome,
        duration_ms: t.durationMS,
        error: errorText(t.err),
      });
      tc.testCase.flaky = t.outcome === TestPassed && t.attempts.length > 0;
    }
    if (t.outcome === TestFailed) {
      tc.findings = [r.findings.length];
      r.findings.push(testFinding(input, t, native));
    }
    r.testCases.push(tc);
    count(r.inventory, t, tc.testCase.outcome);
    addFileCount(files, tc.testCase.file, t, tc.testCase.outcome);
  }
  r.files = [...files.values()]
    .map((c) => ({ ...c, context_id: input.context.id }))
    .sort((a, b) => compareBytes(a.file, b.file));
  return r;
}

function addFileCount(
  files: Map<string, TestFileCount>,
  file: string,
  t: TestRecord,
  outcome: TestOutcome,
): void {
  let c = files.get(file);
  if (c === undefined) {
    c = {
      context_id: "",
      suite: "",
      file,
      found: 0,
      passed: 0,
      passed_focused: 0,
    };
    files.set(file, c);
  }
  c.found++;
  if (outcome === TestPassed) {
    c.passed++;
    if (t.focused) {
      c.passed_focused++;
    }
  }
}

function count(inv: PackageTests, t: TestRecord, outcome: TestOutcome): void {
  inv.found++;
  if (t.focused) {
    inv.focused++;
  }
  switch (outcome) {
    case TestPassed:
      inv.run++;
      inv.passed++;
      break;
    case TestFailed:
      inv.run++;
      inv.failed++;
      break;
    case TestSkipped:
      inv.skipped++;
      break;
    case TestTodo:
      inv.todo++;
      break;
    default:
      inv.never_run++;
  }
}

/**
 * explainNeverRun sets why a test has no result, and which hook Finding is
 * behind it when a hook is.
 */
export function explainNeverRun(
  input: Input,
  t: TestRecord,
  ev: SuiteEvents,
  hookOf: readonly number[],
  anyFocused: boolean,
): void {
  for (const [i, h] of ev.hooks.entries()) {
    if (isPrefix(h.scopePath, t.suitePath)) {
      t.hookFinding = hookOf[i] ?? -1;
      t.neverRunReason = `the hook ${h.title} failed in ${quoteScope(h.scope)}: ${oneLine(errText(h.err), 200)}`;
      return;
    }
  }
  for (const f of ev.files) {
    if (f.file === t.file) {
      t.neverRunReason = `the process of its test file ${shownPath(testFile(f.file))} stopped before the test finished`;
      return;
    }
  }
  if (anyFocused && !t.focused) {
    t.neverRunReason = "a test marked .only elsewhere excluded it";
  } else if (ev.ended) {
    t.neverRunReason =
      "the run finished without running it, for example because the runner's own filter such as --grep excluded it";
  } else {
    t.neverRunReason = "the test process stopped before this test started";
  }
}

function quoteScope(scope: string): string {
  return scope === "" ? "the root scope" : `"${scope}"`;
}

function isPrefix(prefix: readonly string[], of: readonly string[]): boolean {
  if (prefix.length > of.length) {
    return false;
  }
  return prefix.every((p, i) => p === of[i]);
}

// --- paths ---

/**
 * projectRel turns a path inside the container into a path relative to the
 * project root, for a file of the Working copy. It is undefined for a path
 * outside the Working copy.
 */
export function projectRel(containerPath: string): string | undefined {
  const c = clean(containerPath);
  const prefix = workMount + "/";
  if (!c.startsWith(prefix)) {
    return undefined;
  }
  const rest = c.slice(prefix.length);
  return rest === "" ? undefined : rest;
}

/**
 * testFile is the project path of a test file the runner reported. A path
 * outside the Working copy is kept as it is.
 */
export function testFile(containerPath: string): string {
  return projectRel(containerPath) ?? containerPath;
}

/**
 * packageRel is a project path relative to the package folder, which is
 * where the project's own commands run.
 */
function packageRel(input: Input, rel: string): string {
  const p = input.context.package;
  if (p !== null && p.path !== ".") {
    const prefix = p.path + "/";
    return rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
  }
  return rel;
}

/** Frame is one position in a stack trace that lies in the project. */
export interface Frame {
  path: string; // project path
  line: number;
  col: number;
}

/**
 * scriptExtensions are the file extensions a stack frame's path must have
 * when it is relative, so that "at 10:5" or "node:internal/x:1" is not a
 * file.
 */
const scriptExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".cts",
  ".mts",
  ".jsx",
  ".tsx",
]);

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** frameDelimiter: RE2's [\s()'"] (\s is [\t\n\f\r ]). */
function frameDelimiter(c: number): boolean {
  switch (c) {
    case 0x09:
    case 0x0a:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x28:
    case 0x29:
    case 0x27:
    case 0x22:
      return true;
  }
  return false;
}

/**
 * stackFrameMatches finds what Go's
 * `([^\s()'"]+?):(\d+)(?::(\d+))?` FindAllStringSubmatch finds, as a
 * linear scan: stderr can be 32 MiB, and the lazy pattern backtracks
 * quadratically in a regular expression engine over long tokens.
 */
export function stackFrameMatches(text: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (frameDelimiter(text.charCodeAt(i))) {
      i++;
      continue;
    }
    // A run of token characters from i to e.
    let e = i;
    while (e < n && !frameDelimiter(text.charCodeAt(e))) e++;
    // The lazy token ends at the first ":" after its first character that a
    // digit follows; the colon lies inside the run.
    let k = -1;
    for (let j = i + 1; j < e; j++) {
      if (text.charCodeAt(j) === 0x3a && isDigit(text.charCodeAt(j + 1))) {
        k = j;
        break;
      }
    }
    if (k < 0) {
      i = e;
      continue;
    }
    let d = k + 1;
    while (d < n && isDigit(text.charCodeAt(d))) d++;
    let col = "";
    let end = d;
    if (text.charCodeAt(d) === 0x3a && isDigit(text.charCodeAt(d + 1))) {
      let c = d + 1;
      while (c < n && isDigit(text.charCodeAt(c))) c++;
      col = text.slice(d + 1, c);
      end = c;
    }
    out.push([text.slice(i, k), text.slice(k + 1, d), col]);
    i = end;
  }
  return out;
}

/**
 * projectFrames lists the frames of a stack trace or error output that lie
 * in the project's own files, outside node_modules, in order. Mocha shortens
 * the paths in a stack to the folder it runs in, so a frame is either an
 * absolute path in the container or relative to the package.
 */
export function projectFrames(input: Input, text: string): Frame[] {
  const out: Frame[] = [];
  for (const [m1, m2, m3] of stackFrameMatches(text)) {
    const p = m1.startsWith("file://") ? m1.slice("file://".length) : m1;
    let rel: string;
    if (p.startsWith("node:") || p.includes("://")) {
      continue;
    } else if (isAbs(p)) {
      const r = projectRel(p);
      if (r === undefined) {
        continue;
      }
      rel = r;
    } else if (scriptExtensions.has(ext(p))) {
      rel = clean(join(packagePath(input), p));
      if (rel === ".." || rel.startsWith("../")) {
        continue;
      }
    } else {
      continue;
    }
    if (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) {
      continue;
    }
    out.push({ path: rel, line: atoiOrZero(m2), col: atoiOrZero(m3) });
  }
  return out;
}

/** packagePath is the folder of the package in the project, "." for the root. */
function packagePath(input: Input): string {
  return input.context.package?.path ?? ".";
}

/**
 * locate picks the position of a Finding: the first frame in the given
 * file, else the first project frame, else the file itself.
 */
export function locate(frames: readonly Frame[], file: string): Frame {
  return (
    frames.find((f) => f.path === file) ??
    frames[0] ?? { path: file, line: 0, col: 0 }
  );
}

/**
 * relativeStack shows container paths relative to the project, so a stack
 * reads the same in every Run.
 */
export function relativeStack(text: string): string {
  return text.replaceAll(workMount + "/", "");
}

// --- Findings ---

/**
 * knownFile is the file to point at: the reported one when it lies in the
 * project, else the package's manifest, which holds the test script.
 */
function knownFile(input: Input, containerPath: string): string {
  return projectRel(containerPath) ?? input.manifestPath();
}

function testFinding(
  input: Input,
  t: TestRecord,
  native: readonly string[],
): Finding {
  const rule = "test-failed";
  const file = knownFile(input, t.file);
  const err = orEmpty(t.err);
  let at = locate(projectFrames(input, err.stack), file);
  if (at.path !== file) {
    at = { path: file, line: 0, col: 0 };
  }
  let msg = errText(err);
  if (msg === "") {
    msg = "the test failed without a message";
  }
  const f = newFinding({
    check_id: testsExistingID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(testsExistingID, rule, file, t.fullTitle),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title: "Test fails: " + shorten(t.fullTitle, 200),
    message: `The test ${goQuote(t.fullTitle)} fails: ${shorten(oneLine(msg, 400), 400)}`,
    locations: [input.location("primary", at.path, at.line, at.col)],
    expected: err.expected,
    actual: err.actual,
    reproduction: input.reproduction(testsExistingID),
    limitations: [],
  });
  f.evidence = errorEvidence(err, runnerName(input));
  f.reproduction.test = {
    runner: runnerName(input),
    file,
    full_title: t.fullTitle,
    native_command: nativeTestCommand(input, native, file, t.fullTitle),
  };
  const note = missingProgramNote(input, err.message);
  if (note !== "") {
    f.message += " " + note;
  }
  return f;
}

/**
 * spawnENOENT finds Go's `spawn (\S+) ENOENT` (RE2 \S: not [\t\n\f\r ]).
 */
const spawnENOENT = /spawn ([^\t\n\f\r ]+) ENOENT/;

/**
 * safeProgramName is what the note quotes from the error message. The name
 * comes from the project's own test, so anything else is left out.
 */
const safeProgramName = /^[A-Za-z0-9._+/@-]{1,64}$/;

/**
 * missingProgramNote explains a `spawn <program> ENOENT` failure: the
 * program is missing from the image the tests ran in. The image is the one
 * the Context recorded, so the note says which Node version and variant it
 * was.
 */
export function missingProgramNote(input: Input, message: string): string {
  const m = spawnENOENT.exec(message);
  if (m === null) {
    return "";
  }
  const name = m[1] ?? "";
  let program = "that the test tries to start";
  if (safeProgramName.test(name)) {
    program = "`" + name + "` that the test tries to start";
  }
  let image = "Node image";
  const n = input.context.node;
  if (n !== null) {
    image = `Node ${n.version} ${n.variant} image`;
  }
  return `The program ${program} is missing from the ${image} the tests run in; the project's own Dockerfile may install it, and this tool does not run that Dockerfile.`;
}

function hookFinding(
  input: Input,
  h: HookFailure,
  native: readonly string[],
): Finding {
  const rule = "hook-failed";
  const file = knownFile(input, h.file);
  const at = locate(projectFrames(input, h.err.stack), file);
  const msg = errText(h.err);
  const f = newFinding({
    check_id: testsExistingID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      testsExistingID,
      rule,
      at.path,
      h.type + " " + h.scope + " " + h.err.message,
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title: "A test hook fails: " + shorten(h.title, 200),
    message: `The hook ${h.title} failed in ${quoteScope(h.scope)}: ${oneLine(msg, 400)}. The tests it guards did not run; they are reported as never run, not as failures.`,
    locations: [input.location("primary", at.path, at.line, at.col)],
    reproduction: input.reproduction(testsExistingID),
    limitations: [],
  });
  f.evidence = errorEvidence(h.err, runnerName(input));
  f.reproduction.test = {
    runner: runnerName(input),
    file: at.path,
    full_title: h.title,
    native_command: nativeTestCommand(input, native, at.path, null),
  };
  return f;
}

/** errorEvidence is the error message and stack of a test or hook as Evidence. */
export function errorEvidence(e: TestErr, origin: string): Evidence[] {
  const out: Evidence[] = [];
  const m = trimSpace(e.message);
  if (m !== "") {
    out.push(untrusted("assertion", relativeStack(m), origin));
  }
  const s = trimSpace(e.stack);
  if (s !== "") {
    out.push(untrusted("stack_trace", relativeStack(s), origin));
  }
  return out;
}

/** runnerName is the test runner of the package, as the Report names it. */
export function runnerName(input: Input): string {
  const s = input.suite();
  return s?.runner ?? RunnerMocha;
}

/**
 * firstErrorLine is the first line of output that looks like an error, or
 * the first line.
 */
export function firstErrorLine(text: string): string {
  let first = "";
  for (const raw of text.split("\n")) {
    const l = trimSpace(raw);
    if (l === "") {
      continue;
    }
    if (first === "") {
      first = l;
    }
    if (l.includes("Error")) {
      return l;
    }
  }
  return first;
}

/**
 * fileFailureFinding is the Gate Finding of a test file that failed as a
 * whole. When none of its tests reported anything, the file did not load;
 * the usual cause is a throw while it loads. Otherwise its process stopped
 * before the file was finished.
 */
function fileFailureFinding(
  input: Input,
  f: FileFailure,
  reportedTests: boolean,
): Finding {
  let rule = "test-file-load-failed";
  let title = "A test file fails to load";
  let what = (file: string): string =>
    `The test file ${file} fails before any of its tests report. The usual cause is that it throws while it loads, such as a syntax error, a missing module or failing top-level code, and its tests are not counted.`;
  // A process that printed no error did not throw: it was stopped, for
  // example by a call to process.exit().
  if (reportedTests || trimSpace(f.text) === "") {
    rule = "test-run-aborted";
    title = "The test process stops before the file is finished";
    what = (file) =>
      `The process of the test file ${file} stopped before the file was finished and printed no error, for example because a test or top-level code called process.exit(). Its tests that had no result are reported as never run.`;
  }
  const file = knownFile(input, f.file);
  const at = locate(projectFrames(input, f.text), file);
  let first = firstErrorLine(f.text);
  if (first === "") {
    first = errText(f.err);
  }
  const out = newFinding({
    check_id: testsExistingID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(testsExistingID, rule, file, first),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title: title + ": " + shownPath(file),
    message: trimSpace(what(shownPath(file)) + " " + oneLine(first, 300)),
    locations: [input.location("primary", at.path, at.line, at.col)],
    reproduction: input.reproduction(testsExistingID),
    limitations: [],
  });
  const text = trimSpace(f.text);
  if (text !== "") {
    out.evidence = [
      untrusted(
        "tool_output",
        relativeStack(tail(text, 6000)),
        runnerName(input),
      ),
    ];
  }
  return out;
}

/**
 * nativeTestCommand is the project's own command for running one test or
 * one file, as an argument array, run in the package folder. Mocha gets the
 * title as --fgrep, node:test as --test-name-pattern with the escaped title
 * between ^ and $. A title that looks like an option is passed in the
 * --option=value form and a file name that does, with ./ in front, so
 * neither can be read as an option.
 */
export function nativeTestCommand(
  input: Input,
  base: readonly string[],
  file: string,
  fullTitle: string | null,
): string[] {
  const cmd = [...base];
  if (fullTitle !== null) {
    if (runnerName(input) === RunnerNodeTest) {
      cmd.push("--test-name-pattern=^" + quoteMeta(fullTitle) + "$");
    } else if (fullTitle.startsWith("-")) {
      cmd.push("--fgrep=" + fullTitle);
    } else {
      cmd.push("--fgrep", fullTitle);
    }
  }
  let rel = packageRel(input, file);
  if (rel.startsWith("-")) {
    rel = "./" + rel;
  }
  cmd.push(rel);
  return cmd;
}
