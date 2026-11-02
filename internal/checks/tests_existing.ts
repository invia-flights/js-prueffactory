// tests.existing (Go: tests_existing.go): the project's own test suites,
// run the way the project runs them.
import { readFileSync } from "node:fs";

import type {
  Context,
  Package,
  Suite,
  Unsupported,
} from "../discovery/discovery.ts";
import {
  parseMochaArgs,
  RunnerMocha,
  RunnerNodeTest,
} from "../discovery/discovery.ts";
import { type ContainerResult, NetworkNone } from "../docker/driver.ts";
import { withTimeout } from "../gocompat/context.ts";
import { clean, isAbs } from "../gocompat/path.ts";
import { trimSpace } from "../gocompat/strings.ts";
import { second } from "../gocompat/time.ts";
import { type Schema, unmarshal } from "../gocompat/unmarshal.ts";
import { goString } from "../gocompat/utf8.ts";
import { newFingerprint } from "../resultset/fingerprint.ts";
import { quote } from "../resultset/quote.ts";
import {
  type Applicability,
  Applicable,
  ConfidenceConfirmed,
  type Finding,
  KindDefect,
  type Limitation,
  NotApplicable,
  SeverityError,
  StatusCompleted,
  StatusUnsupported,
  Unknown,
} from "../resultset/types.ts";
import { newFinding } from "../resultset/zero.ts";
import { type Check, register } from "./check.ts";
import { tail } from "./cut_text.ts";
import { failedToRun } from "./helper_result.ts";
import { type Input, type Result, untrusted } from "./input.ts";
import { packageInstallID, workMount, workPath } from "./package_install.ts";
import { shownPath, shownWord } from "./shown_text.ts";
import { unresolvedServices } from "./services.ts";
import { eventLimitations } from "./test_visibility.ts";
import {
  firstErrorLine,
  locate,
  oneLine,
  projectFrames,
  relativeStack,
  runnerName,
} from "./test_report.ts";
import { suiteCount } from "./test_suites.ts";
import { sharedSuite } from "./tests_coverage.ts";
import {
  finishSuite,
  launchSuite,
  nativeEnvPrefix,
  overrideLimitations,
} from "./tests_existing_suite.ts";
import { runNodeTest } from "./tests_existing_nodetest.ts";

export const testsExistingID = "tests.existing";

/**
 * mochaReporterScript is js/mocha-reporter.js, byte for byte as Go embeds
 * it.
 */
export const mochaReporterScript = readFileSync(
  new URL("js/mocha-reporter.js", import.meta.url),
);

// Where things are in the test container. The events volume is separate
// from the Working copy, so that what the reporter recorded can be read
// after the container is gone, however the run ended.
export const reporterPath = "/jspf/mocha-reporter.js";
export const eventsMount = "/jspf-out";
export const eventsFile = eventsMount + "/events.jsonl";

/** runnable says whether the Check will start a container in the Context. */
function runnable(c: Context): boolean {
  return (
    c.package !== null &&
    c.node !== null &&
    unsupportedTests(c.package) === null
  );
}

/**
 * testsExisting runs the project's own test suite the way the project runs
 * it, in a container of the package's Context on the Run's internal
 * network, from the package folder of the Working copy, after
 * package.install finished.
 *
 * Mocha runs from the package's own installed copy, with the project's
 * arguments, plus our reporter and --no-bail. The reporter's event file
 * becomes test cases, Findings and the package's test counts (see
 * suiteResults). Failed tests, failed hooks, files that fail to load and a
 * missing runner are Gate Findings. Every override of the project's command
 * is listed as a Limitation.
 *
 * The Working copy is mounted writable, because tests that write into their
 * own project folder are common and must not fail for that. Whatever they
 * leave behind stays in the Run's volume.
 */
export const testsExisting: Check = {
  applicability(_p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "tests.existing runs the tests of a package, and this is the project Context",
      ];
    }
    if (c.package.tests === null) {
      return [
        NotApplicable,
        "the package has no test script and no Mocha config file",
      ];
    }
    return testRunApplicability(c.package);
  },

  /**
   * prerequisites: the dependencies have to be installed first. A package
   * whose tests cannot run has nothing to install for.
   */
  prerequisites(c) {
    return runnable(c) ? [packageInstallID] : [];
  },

  usesWorkingCopy() {
    return true;
  },

  /** usesServices: a suite that runs gets the project's test Services. */
  usesServices(c) {
    return runnable(c);
  },

  /** images tells the engine which image run will use. */
  images(c) {
    return runnable(c) && c.node !== null ? [c.node.image] : [];
  },

  /** run of tests.existing is the suite's result, whoever performed the run. */
  async run(signal, input) {
    const r = { ...(await sharedSuite(signal, input)) };
    r.coverage = null;
    r.parts = [];
    return r;
  },
};

register(testsExistingID, testsExisting);

/** mochaVersionUnknown is why the Applicability of a Mocha package is unknown. */
export const mochaVersionUnknown =
  "the Mocha version is known only after the dependencies are installed";

/**
 * testRunApplicability is the Applicability of the Checks that read the test
 * run of a package whose tests exist: unsupported tests are known now, and
 * Mocha's version, which decides how its reporter is used, is known only from
 * the installed dependencies (spec: Applicability that depends on installed
 * dependencies is unknown). The Check runs either way.
 */
export function testRunApplicability(pkg: Package): [Applicability, string] {
  const reason = unsupportedTestsReason(pkg);
  if (reason !== "") {
    return [Applicable, "unsupported: " + reason];
  }
  for (const s of pkg.tests?.suites ?? []) {
    if (s.runner === RunnerMocha) {
      return [Unknown, mochaVersionUnknown];
    }
  }
  return [Applicable, ""];
}

/**
 * unsupportedTests says why the package's tests cannot be run in this
 * release, or returns null when they can.
 */
export function unsupportedTests(pkg: Package): Unsupported | null {
  if (pkg.tests === null) {
    return {
      code: "no_tests",
      reason: "the package has no test script and no Mocha config file",
    };
  }
  if (pkg.tests.unsupported !== null) {
    return pkg.tests.unsupported;
  }
  for (const s of pkg.tests.suites) {
    if (s.runner !== RunnerMocha && s.runner !== RunnerNodeTest) {
      return {
        code: "test_runner_not_implemented",
        reason: `tests run by ${s.runner} are not supported yet`,
      };
    }
  }
  return pkg.installUnsupported;
}

export function unsupportedTestsReason(pkg: Package): string {
  return unsupportedTests(pkg)?.reason ?? "";
}

/**
 * runSuite performs the run of one suite of the package, the one the Input
 * is bound to (see forSuite). It is called once per suite, Context and Run
 * (see sharedSuite), through runTestSuite.
 */
export async function runSuite(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const pkg = input.context.package;
  const u = pkg === null ? null : unsupportedTests(pkg);
  if (pkg === null || u !== null) {
    return {
      status: StatusUnsupported,
      reasonCode: u?.code ?? "no_tests",
      reason: u?.reason ?? "",
    };
  }
  const blocked = unresolvedServices(input);
  if (blocked !== null) {
    return blocked;
  }
  const tc = input.suite();
  const node = input.context.node;
  if (tc === null || node === null) {
    return failedToRun(
      { status: StatusUnsupported },
      new Error("the package has no suite and no Node image to run it in"),
    );
  }
  if (tc.runner === RunnerNodeTest) {
    return runNodeTest(signal, input);
  }
  const res: Result = { status: StatusCompleted };
  const suffix = input.suiteSuffix();

  let install: MochaInstall;
  try {
    install = await probeMocha(signal, input, node.image, suffix);
  } catch (err) {
    return failedToRun(res, err);
  }
  if (install.missing !== "") {
    res.status = StatusCompleted;
    res.findings = [runnerMissingFinding(input, install.missing)];
    return res;
  }
  if (!supportedMochaVersion(install.version)) {
    res.status = StatusUnsupported;
    res.reasonCode = "test_runner_version_unsupported";
    res.reason = `Mocha ${shownWord(install.version, "version")} is installed, and js-prueffactory supports Mocha 9 to 12`;
    return res;
  }

  const plan = planMochaArgs(tc.args, reporterPath);
  const launched = await launchSuite(signal, input, res, {
    cmd: [
      "node",
      workPath(pkg) + "/node_modules/mocha/" + install.bin,
      ...plan.args,
    ],
    native: nativeBase(tc, plan),
    overrides: commandOverrides(input, tc, plan),
    reporterPath,
    reporter: mochaReporterScript,
    eventLimitations: (ev) => eventLimitations(input, ev),
  });
  if (launched.done !== null) {
    return launched.done;
  }
  const { c, ev } = launched;

  res.tool = { name: "mocha", version: install.version, exit_code: c.exitCode };
  finishSuite(input, res, ev, c, {
    noEvents:
      "Mocha exited without running any test or writing any event; the project's arguments may make it print and stop, as --help does",
    notStarted: () => {
      const [f, lim] = loadFailure(input, c);
      return [[f], [lim]];
    },
    aborted: () => abortFinding(input, c),
  });
  return res;
}

/** MochaInstall is what the installed Mocha says about itself. */
interface MochaInstall {
  /** missing is non-empty when Mocha is not installed, and says how that shows. */
  missing: string;
  version: string;
  /** bin is the path of the executable below node_modules/mocha. */
  bin: string;
}

const mochaManifestSchema: Schema = {
  kind: "struct",
  type: 'struct { Version string "json:\\"version\\""; Bin json.RawMessage "json:\\"bin\\"" }',
  fields: [
    { name: "version", schema: { kind: "string" } },
    { name: "bin", schema: { kind: "raw" } },
  ],
};

/** probeMocha reads the installed Mocha's manifest from the Working copy. */
async function probeMocha(
  signal: AbortSignal,
  input: Input,
  image: string,
  suffix: string,
): Promise<MochaInstall> {
  const pkg = input.context.package;
  const drv = input.docker;
  if (pkg === null || drv === null) {
    throw new Error("there is no Docker driver");
  }
  const file = workPath(pkg) + "/node_modules/mocha/package.json";
  const c = await drv.runContainer(signal, {
    name: "mochaprobe-" + suffix,
    image,
    cmd: ["cat", file],
    network: input.network,
    mounts: [{ volume: input.workVolume, path: workMount, readOnly: true }],
  });
  if (c.exitCode !== 0) {
    return {
      missing: "node_modules/mocha does not exist after the install",
      version: "",
      bin: "",
    };
  }
  let m: { version: string; bin: Uint8Array | null };
  try {
    m = unmarshal(c.stdout, mochaManifestSchema) as typeof m;
  } catch {
    m = { version: "", bin: null };
  }
  if (m.version === "") {
    return {
      missing: "node_modules/mocha/package.json is not a package manifest",
      version: "",
      bin: "",
    };
  }
  return { missing: "", version: m.version, bin: mochaBin(m.bin) };
}

/**
 * mochaBin is the executable of the Mocha package, from its `bin` field. It
 * never leaves the package folder.
 */
export function mochaBin(raw: Uint8Array | null): string {
  const fallback = "bin/mocha.js";
  const decode = (schema: Schema): unknown => {
    try {
      return unmarshal(raw ?? new Uint8Array(0), schema);
    } catch {
      return undefined;
    }
  };
  let s = decode({ kind: "string" });
  if (typeof s !== "string" || s === "") {
    const m = decode({
      kind: "map",
      type: "map[string]string",
      elem: { kind: "string" },
    });
    s = m instanceof Map ? (m as Map<string, string>).get("mocha") : undefined;
    if (typeof s !== "string" || s === "") {
      return fallback;
    }
  }
  const bin = clean(s.startsWith("./") ? s.slice(2) : s);
  if (isAbs(bin) || bin === ".." || bin.startsWith("../")) {
    return fallback;
  }
  return bin;
}

/** supportedMochaVersion says whether the installed Mocha is one of 9 to 12. */
export function supportedMochaVersion(v: string): boolean {
  const dot = v.indexOf(".");
  const major = dot < 0 ? v : v.slice(0, dot);
  if (!/^[+-]?[0-9]+$/.test(major)) {
    return false;
  }
  const n = Number(major);
  return n >= 9 && n <= 12;
}

/** MochaPlan is how the project's Mocha arguments turn into a run. */
export interface MochaPlan {
  /**
   * args are the arguments of the run: the project's, without its reporter
   * and bail options, plus ours.
   */
  args: string[];
  /**
   * nativeOptions are the project's options for re-running one test: its
   * own, without its test files and without the ones we replaced.
   */
  nativeOptions: string[];
  /** overrides lists the project's arguments that were removed. */
  overrides: string[];
}

const replacedOptions = new Set([
  "reporter",
  "R",
  "reporter-option",
  "reporter-options",
  "O",
  "bail",
  "b",
]);

/**
 * planMochaArgs keeps the project's arguments, takes out the ones that would
 * replace our reporter or hide results (its reporter and options, and bail),
 * and adds our reporter and --no-bail. A reporter option from a config file
 * can beat the command line in Mocha 10, which is why the reporter learns
 * its output path from the environment and not from a reporter option.
 */
export function planMochaArgs(
  args: readonly string[],
  reporter: string,
): MochaPlan {
  const p: MochaPlan = { args: [], nativeOptions: [], overrides: [] };
  for (const a of parseMochaArgs(args)) {
    if (replacedOptions.has(a.name)) {
      p.overrides.push(a.words.join(" "));
      continue;
    }
    p.args.push(...a.words);
    if (!a.file) {
      p.nativeOptions.push(...a.words);
    }
  }
  p.args.push("--reporter", reporter, "--no-bail");
  return p;
}

/**
 * nativeBase is the start of the command that re-runs one test with the
 * project's own tools: its environment variables, the runner and its
 * options.
 */
export function nativeBase(tc: Suite, plan: MochaPlan): string[] {
  return [...nativeEnvPrefix(tc), "npx", "mocha", ...plan.nativeOptions];
}

/**
 * commandOverrides lists every way the run differs from the project's own
 * command, so nobody mistakes the Report for a run of `npm test`.
 */
function commandOverrides(
  input: Input,
  tc: Suite,
  plan: MochaPlan,
): Limitation[] {
  return overrideLimitations(
    input,
    tc,
    "Mocha runs with js-prueffactory's own reporter, which records every test, and with --no-bail, so that one failure does not hide the rest. `exit` stays as the project configured it.",
    (arg) =>
      `The project's argument ${arg} is not passed on, because the reporter and bail settings are ours.`,
    plan.overrides,
  );
}

/** readEventsTimeout bounds the reading of the event file. */
const readEventsTimeout = 60n * second;

/**
 * readEvents reads the reporter's event file from its volume. It does not
 * depend on the Check's own signal, because it is needed most after a
 * timeout or a cancellation.
 */
export async function readEvents(
  input: Input,
  image: string,
  volume: string,
  suffix: string,
): Promise<Buffer | null> {
  const drv = input.docker;
  if (drv === null) {
    return null;
  }
  const r = withTimeout(new AbortController().signal, readEventsTimeout);
  try {
    const c = await drv.runContainer(r.signal, {
      name: "events-" + suffix,
      image,
      cmd: ["cat", eventsFile],
      mounts: [{ volume, path: eventsMount, readOnly: true }],
      network: NetworkNone,
    });
    return c.exitCode === 0 ? c.stdout : null;
  } catch {
    return null;
  } finally {
    r.cancel();
  }
}

// --- Findings of a suite that did not get going ---

function runnerMissingFinding(input: Input, why: string): Finding {
  const rule = "test-runner-not-installed";
  const manifest = input.manifestPath();
  const tc = input.suite();
  let where = "the test script";
  if (tc !== null && tc.origin !== "scripts.test") {
    where = "the " + shownPath(tc.origin) + " file";
  }
  return newFinding({
    check_id: testsExistingID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(testsExistingID, rule, manifest, "mocha"),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title: "test runner not installed",
    message: `${capitalize(where)} runs Mocha, but ${why}. Add mocha to the dependencies or devDependencies of ${shownPath(manifest)} and update the lockfile.`,
    locations: [input.location("primary", manifest, 0, 0)],
    reproduction: input.reproduction(testsExistingID),
    limitations: [],
  });
}

/**
 * capitalize upper-cases the first byte of s as Go's
 * strings.ToUpper(s[:1]) + s[1:] does for the ASCII texts it gets.
 */
function capitalize(s: string): string {
  if (s === "") {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** outputText is what a finished container printed, for Evidence. */
export function outputText(c: ContainerResult): string {
  return relativeStack(
    tail(trimSpace(goString(c.stderr) + "\n" + goString(c.stdout)), 6000),
  );
}

/** containerText is the container's stderr and stdout, as Go joins them. */
export function containerText(c: ContainerResult): string {
  return goString(c.stderr) + "\n" + goString(c.stdout);
}

/**
 * loadFailure is the Gate Finding of a run that stopped before any test
 * ran. The usual cause is a test file that throws while it loads.
 */
export function loadFailure(
  input: Input,
  c: ContainerResult,
): [Finding, Limitation] {
  const text = containerText(c);
  let rule = "test-file-load-failed";
  let title = "A test file fails to load";
  let what =
    "Mocha stopped before it ran any test, and the usual cause is a test file that throws while it loads, such as a syntax error, a missing module or failing top-level code.";
  if (text.includes("No test files found")) {
    rule = "no-test-files-found";
    title = "Mocha finds no test files";
    what =
      "Mocha stopped because no file matches the test files the project's command names.";
  }
  const f = stopFinding(
    input,
    rule,
    title,
    `${what} Its exit code was ${String(c.exitCode)}.`,
    c,
    text,
  );
  let message =
    "Mocha stopped before it reported any test, so the tests of the files that did not load are not counted.";
  const s = input.suite();
  if (s !== null && suiteCount(input.context.package) > 1) {
    message = `In the suite ${quote(s.origin)}, Mocha stopped before it reported any test, so the tests of the files that did not load are not counted.`;
  }
  return [
    f,
    {
      reason_code: "tests_not_counted",
      message,
      check_id: testsExistingID,
      path: null,
    },
  ];
}

/**
 * abortFinding is the Gate Finding of a run that recorded some results and
 * then stopped without finishing, for example because a test called
 * process.exit().
 */
function abortFinding(input: Input, c: ContainerResult): Finding {
  return stopFinding(
    input,
    "test-run-aborted",
    "The test process stops before the suite is finished",
    `The test process exited with code ${String(c.exitCode)} before Mocha finished. The tests not yet run are reported as never run.`,
    c,
    containerText(c),
  );
}

export function stopFinding(
  input: Input,
  rule: string,
  title: string,
  message: string,
  c: ContainerResult,
  text: string,
): Finding {
  const manifest = input.manifestPath();
  const at = locate(projectFrames(input, text), manifest);
  return newFinding({
    check_id: testsExistingID,
    context_id: input.context.id,
    rule_id: rule,
    fingerprint: newFingerprint(
      testsExistingID,
      rule,
      at.path,
      firstErrorLine(text),
    ),
    kind: KindDefect,
    severity: SeverityError,
    confidence: ConfidenceConfirmed,
    gate: true,
    title,
    message: message + " " + oneLine(firstErrorLine(text), 300),
    locations: [input.location("primary", at.path, at.line, at.col)],
    evidence: [untrusted("tool_output", outputText(c), runnerName(input))],
    reproduction: input.reproduction(testsExistingID),
    limitations: [],
  });
}
