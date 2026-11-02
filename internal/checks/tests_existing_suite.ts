// What the Mocha and the node:test run of tests.existing have in common
// (Go: tests_existing_suite.go): the container that runs the suite with our
// reporter, and the way the run ended.
import type { Suite } from "../discovery/discovery.ts";
import type { ContainerResult, ContainerSpec } from "../docker/driver.ts";
import { sortStrings } from "../gocompat/strings.ts";
import { quote } from "../resultset/quote.ts";
import {
  type Finding,
  type Limitation,
  StatusCompleted,
  StatusPartial,
  StatusToolError,
} from "../resultset/types.ts";
import { ContainerMemoryMB } from "../toolset/toolset.ts";
import { failedToRun } from "./helper_result.ts";
import type { Input, Result } from "./input.ts";
import { commandLogArtifact, workMount, workPath } from "./package_install.ts";
import { addWarningsEnv, recordSuiteRun } from "./runtime_warnings.ts";
import { startServices } from "./services.ts";
import { parseTestEvents, type SuiteEvents } from "./test_events.ts";
import { sourceSpecLimitations } from "./test_files_probe.ts";
import { suiteResults } from "./test_report.ts";
import { addCoverage } from "./tests_coverage.ts";
import {
  eventsFile,
  eventsMount,
  readEvents,
  testsExistingID,
} from "./tests_existing.ts";
import { testLogPath } from "./tests_repeat.ts";

/** SuiteLaunch is what differs between runners when the suite's container is started. */
export interface SuiteLaunch {
  /** cmd is the command of the run, before c8 is put around it. */
  cmd: string[];
  /**
   * native is the start of the command that re-runs one test with the
   * project's own tools.
   */
  native: string[];
  /** overrides are the Limitations for what differs from the project's command. */
  overrides: Limitation[];
  /** reporterPath and reporter are our reporter file and where it is copied. */
  reporterPath: string;
  reporter: Uint8Array;
  /** eventLimitations are further Limitations that depend on the events. */
  eventLimitations: ((ev: SuiteEvents) => Limitation[]) | null;
}

/**
 * Launched is how a launch ended: done is the Result to return when the run
 * could not be performed at all; otherwise c and ev are the container's
 * result and the events.
 */
export type Launched =
  | { done: Result; c?: undefined; ev?: undefined }
  | { done: null; c: ContainerResult; ev: SuiteEvents };

/**
 * launchSuite starts the project's Services, runs the suite in a container
 * with the reporter and reads what the reporter recorded, however the run
 * ended. It fills res with the command, Limitations, Services, coverage,
 * test cases, Findings and Inventory.
 */
export async function launchSuite(
  signal: AbortSignal,
  input: Input,
  res: Result,
  l: SuiteLaunch,
): Promise<Launched> {
  const pkg = input.context.package;
  const tc = input.suite();
  const node = input.context.node;
  const drv = input.docker;
  if (pkg === null || tc === null || node === null || drv === null) {
    return { done: failedToRun(res, new Error("there is no Docker driver")) };
  }
  const image = node.image;
  const suffix = input.suiteSuffix();
  res.command = l.cmd;
  res.limitations = l.overrides;

  // Fresh Services of the suite's own, on a network of their own.
  const services = await startServices(signal, input, suffix);
  try {
    res.services = services.reports;
    if (services.fail !== null) {
      services.fail.limitations = res.limitations;
      return { done: services.fail };
    }

    let events: string;
    try {
      events = await drv.createVolume(signal, "events-" + suffix);
    } catch (err) {
      return { done: failedToRun(res, err) };
    }
    const env: Record<string, string> = {};
    for (const k of sortStrings([...tc.env.keys()])) {
      env[k] = tc.env.get(k) ?? "";
    }
    env.JSPF_EVENTS = eventsFile;
    const endMarker = addWarningsEnv(input, env);
    const base: ContainerSpec = {
      name: "tests-" + suffix,
      image,
      cmd: l.cmd,
      env,
      workDir: workPath(pkg),
      network: services.network,
      mounts: [
        { volume: input.workVolume, path: workMount },
        { volume: events, path: eventsMount },
      ],
      files: [
        { path: l.reporterPath, mode: 0o644, content: Buffer.from(l.reporter) },
      ],
      endMarker,
    };
    // c8 around the runner when tests.coverage is selected
    const [spec, coverage] = addCoverage(input, base);
    res.coverage = coverage;
    res.command = [...(spec.cmd ?? [])];
    let c: ContainerResult | null = null;
    let runErr: unknown = null;
    try {
      c = await drv.runContainer(signal, spec);
    } catch (err) {
      runErr = err;
    }

    // Whatever the reporter recorded stays, however the run ended.
    const ev = parseTestEvents(await readEvents(input, image, events, suffix));
    recordSuiteRun(input, res, ev, c);
    const limitations = res.limitations;
    if (l.eventLimitations !== null) {
      limitations.push(...l.eventLimitations(ev));
    }
    limitations.push(...sourceSpecLimitations(input, ev));
    const sr = suiteResults(input, ev, l.native);
    res.findings = sr.findings;
    res.inventory = {
      tests: [sr.inventory],
      test_suites: [],
      test_files: sr.files,
      suppressions: [],
      file_hashes: [],
      size: [],
      moved_test_files: [],
    };
    res.testCases = sr.testCases;
    if (c === null) {
      return { done: failedToRun(res, runErr) };
    }
    return { done: null, c, ev };
  } finally {
    await services.stop();
  }
}

/**
 * SuiteEnd says how a suite run that did start ended, for the cases that
 * differ between runners.
 */
export interface SuiteEnd {
  /**
   * noEvents is the Reason when the runner exited cleanly without running
   * anything or writing an event.
   */
  noEvents: string;
  /**
   * notStarted gives the Findings and Limitations when the runner stopped
   * before it ran any test; aborted gives the Finding when it stopped later.
   */
  notStarted: () => [Finding[], Limitation[]];
  aborted: () => Finding;
}

/**
 * finishSuite adds the command log and sets the status of a finished run: a
 * run that ended its events is completed, an out-of-memory run is partial,
 * a run with no events is a tool error, and a run that stopped is a
 * Finding.
 */
export function finishSuite(
  input: Input,
  res: Result,
  ev: SuiteEvents,
  c: ContainerResult,
  end: SuiteEnd,
): void {
  (res.artifacts ??= []).push(
    commandLogArtifact(testLogPath(input), res.command ?? [], c),
  );
  res.status = StatusCompleted;
  if (ev.ended) {
    return;
  }
  if (c.oomKilled) {
    res.status = StatusPartial;
    res.reasonCode = "out_of_memory";
    res.reason = `the test process ran out of its ${String(ContainerMemoryMB)} MB of memory, so the tests not yet run are reported as never run`;
  } else if (!ev.started && c.exitCode === 0) {
    res.status = StatusToolError;
    res.reasonCode = "no_test_events";
    res.reason = end.noEvents;
  } else if (!ev.started) {
    const [findings, limitations] = end.notStarted();
    (res.findings ??= []).push(...findings);
    (res.limitations ??= []).push(...limitations);
  } else {
    (res.findings ??= []).push(end.aborted());
  }
}

/**
 * nativeEnvPrefix starts the command that re-runs one test with the
 * project's own tools: `env K=V …` for the environment variables of its test
 * command.
 */
export function nativeEnvPrefix(tc: Suite): string[] {
  if (tc.env.size === 0) {
    return [];
  }
  return [
    "env",
    ...sortStrings([...tc.env.keys()]).map(
      (k) => k + "=" + (tc.env.get(k) ?? ""),
    ),
  ];
}

/**
 * overrideLimitations lists every way a run differs from the project's own
 * command, so nobody mistakes the Report for a run of `npm test`: first the
 * general note, then each argument that was not passed on (perArgument gets
 * the argument as a code span), then a dropped wrapper such as c8.
 */
export function overrideLimitations(
  input: Input,
  tc: Suite,
  general: string,
  perArgument: (arg: string) => string,
  overrides: readonly string[],
): Limitation[] {
  const manifest = input.manifestPath();
  const add = (code: string, message: string): Limitation => ({
    reason_code: code,
    message,
    check_id: testsExistingID,
    path: manifest,
  });
  const out = [add("test_command_override", general)];
  for (const o of overrides) {
    out.push(add("test_command_override", perArgument(quote(o))));
  }
  if (tc.dropped !== "") {
    out.push(
      add(
        "test_wrapper_dropped",
        `The test script starts with ${quote(tc.dropped)}, which is not run: coverage is measured by tests.coverage.`,
      ),
    );
  }
  return out;
}
