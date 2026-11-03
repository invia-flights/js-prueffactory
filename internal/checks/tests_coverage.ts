// tests.coverage (Go: tests_coverage.go) and the one run of a package's
// suites that it shares with tests.existing.
import type { ContainerSpec } from "../docker/driver.ts";
import { NetworkNone } from "../docker/driver.ts";
import { background, withTimeout } from "../gocompat/context.ts";
import { minute, second } from "../gocompat/time.ts";
import {
  NotApplicable,
  StatusCompleted,
  StatusInfrastructureError,
  StatusToolError,
  StatusUnsupported,
  type Metric,
  type Tool,
} from "../resultset/types.ts";
import { newArtifact, newMetric } from "../resultset/zero.ts";
import { npmTool } from "../toolset/npmtools.ts";
import { MountPath } from "../toolvolume/toolvolume.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import { workMount, workPath } from "./package_install.ts";
import { selected } from "./selection.ts";
import { shownWord } from "./shown_text.ts";
import { Shared } from "./shared.ts";
import { runSuites, suiteCount } from "./test_suites.ts";
import {
  c8Bin,
  c8ConfigPath,
  coverageConfig,
  coverageFilesFile,
  coverageMount,
  coverageSummaryFile,
  suiteCoverageConfig,
  wrapWithC8,
} from "./tests_coverage_config.ts";
import {
  type Coverage,
  coverageKinds,
  interpretCoverage,
  noteFailures,
  testsCoverageID,
} from "./tests_coverage_report.ts";
import { runnable, testsExisting, testsExistingID } from "./tests_existing.ts";
import {
  type RawFile,
  requireShape,
  shape,
  ToolOutputs,
  UnreadableOutput,
} from "./tool_output.ts";
import { errorMessage } from "../gocompat/errors.ts";
import type { ReasonCode } from "../resultset/reason_codes.ts";

export { testsCoverageID };

/**
 * testsCoverage reports the line, branch and function Coverage of a
 * package's own test run. It does not run the suite a second time: the
 * suite's one run is shared with tests.existing (see sharedSuite), and when
 * tests.coverage is selected, c8 from the toolset wraps the runner of that
 * run. Whichever of the two Checks starts first performs the run; the other
 * reads its result.
 *
 * Coverage is a measurement. It has no Findings and no Gates. A suite with
 * failing tests still has coverage, and its metrics carry a note.
 */
export const testsCoverage: Check = {
  applicability(p, c) {
    if (c.package === null) {
      return [
        NotApplicable,
        "tests.coverage measures the tests of a package, and this is the project Context",
      ];
    }
    return testsExisting.applicability(p, c);
  },

  prerequisites(c) {
    return testsExisting.prerequisites?.(c) ?? [];
  },

  usesWorkingCopy() {
    return true;
  },

  images(c) {
    return testsExisting.images?.(c) ?? [];
  },

  /**
   * usesServices: when this Check performs the suite's run, the suite gets
   * the project's test Services like it does for tests.existing.
   */
  usesServices(c) {
    return testsExisting.usesServices?.(c) ?? false;
  },

  /** usesToolset says that c8 comes from the toolset volume. */
  usesToolset(c) {
    return runnable(c);
  },

  async run(signal, input) {
    return coverageResult(input, await sharedSuite(signal, input));
  },
};

register(testsCoverageID, testsCoverage);

/**
 * sharedSuite returns the one run of the package's suites in the Context
 * (all of them, in list order, see runSuites), performing it if neither
 * tests.existing nor tests.coverage has. Unlike a result that depends on the
 * caller's limit, the suite's result is kept even when the run was cut
 * short, because it says what the tests did, and running the tests again
 * would take as long again.
 */
export async function sharedSuite(
  signal: AbortSignal,
  input: Input,
): Promise<Result> {
  const shared = input.shared ?? new Shared();
  return shared.do(
    signal,
    "tests.existing/" + input.context.id,
    async (s): Promise<[Result, boolean]> => [await runSuites(s, input), true],
  );
}

/** CoverageRun is what a suite run recorded for coverage. */
export interface CoverageRun {
  /**
   * unavailable says why c8 could not wrap the run; the tests ran without
   * it. unavailableCode is the reason code of the Check then,
   * "toolset_unavailable" when empty.
   */
  unavailable: string;
  unavailableCode: ReasonCode | "";
  /**
   * summary and perFile are c8's JSON summary and per-file JSON, null when
   * c8 wrote none.
   */
  summary: Uint8Array | null;
  perFile: Uint8Array | null;
}

/**
 * wantsCoverage says whether the run is to be measured: tests.coverage is in
 * the Selection, and the run is not a repeat run.
 */
export function wantsCoverage(input: Input): boolean {
  if (input.repeat !== null) {
    return false; // a repeat run is never measured
  }
  return input.selection === null || selected(input.selection, testsCoverageID);
}

function unavailable(why: string, code: ReasonCode | "" = ""): CoverageRun {
  return {
    unavailable: why,
    unavailableCode: code,
    summary: null,
    perFile: null,
  };
}

/**
 * addCoverage puts c8 around the runner of a suite container when the run is
 * to be measured. The c8 of every suite adds its raw coverage to the
 * package's one coverage volume (see withCoverageLocation). It returns the
 * spec to run with what the run needs to remember (null when the run is not
 * measured).
 */
export function addCoverage(
  input: Input,
  spec: ContainerSpec,
): [ContainerSpec, CoverageRun | null] {
  if (!wantsCoverage(input)) {
    return [spec, null];
  }
  if (input.toolsetVolume === "") {
    return [
      spec,
      unavailable(
        "the toolset volume with c8 could not be prepared: " +
          input.toolsetError,
      ),
    ];
  }
  if (input.coverageVolume === "") {
    const why =
      input.coverageError === ""
        ? "there is no volume for the raw coverage"
        : input.coverageError;
    return [spec, unavailable(why, "coverage_location_unavailable")];
  }
  const pkg = input.context.package;
  if (pkg === null) {
    return [spec, unavailable("the Context has no package")];
  }
  return [
    {
      ...spec,
      cmd: wrapWithC8(spec.cmd ?? []),
      mounts: [
        ...(spec.mounts ?? []),
        { volume: input.toolsetVolume, path: MountPath, readOnly: true },
        { volume: input.coverageVolume, path: coverageMount },
      ],
      files: [
        ...(spec.files ?? []),
        {
          path: c8ConfigPath,
          mode: 0o644,
          content: suiteCoverageConfig(input.project, pkg),
        },
      ],
    },
    { unavailable: "", unavailableCode: "", summary: null, perFile: null },
  ];
}

/**
 * withCoverageLocation returns the Input for the run of all suites of the
 * package. When tests.coverage is selected it holds the one run-owned volume
 * that every suite writes its raw V8 coverage into, or says why there is
 * none.
 */
export async function withCoverageLocation(
  signal: AbortSignal,
  input: Input,
): Promise<Input> {
  const run = input.forSuite(input.suiteIndex);
  if (!wantsCoverage(input)) {
    return run;
  }
  try {
    run.coverageVolume = await hooks.createVolume(signal, input);
  } catch (err) {
    run.coverageError =
      "the volume for the raw coverage could not be created: " +
      errorMessage(err);
  }
  return run;
}

/**
 * sharedCoverage is what the runs of the suites recorded for coverage, as
 * one: when any suite was measured, one c8 report over the raw coverage of
 * all of them. It is null when no suite reached its tests. The report is
 * built whatever became of the suites, because their raw coverage is in the
 * volume however their runs ended.
 */
export async function sharedCoverage(
  signal: AbortSignal,
  input: Input,
  parts: readonly Result[],
): Promise<CoverageRun | null> {
  let measured = false;
  for (const p of parts) {
    const cov = p.coverage ?? null;
    if (cov === null) {
      continue;
    }
    if (cov.unavailable !== "") {
      return cov;
    }
    measured = true;
  }
  if (!measured) {
    return null;
  }
  const [summary, perFile] = await hooks.buildReport(signal, input);
  return { unavailable: "", unavailableCode: "", summary, perFile };
}

/**
 * CoverageHooks are the two steps of coverage that need a daemon. Tests
 * replace them with useCoverageHooks (Go: the createCoverageVolume and
 * buildCoverageReport variables).
 */
export interface CoverageHooks {
  createVolume: (signal: AbortSignal, input: Input) => Promise<string>;
  buildReport: (
    signal: AbortSignal,
    input: Input,
  ) => Promise<[Uint8Array | null, Uint8Array | null]>;
}

const hooks: CoverageHooks = {
  createVolume: createCoverageVolume,
  buildReport: buildCoverageReport,
};

/** useCoverageHooks replaces some hooks and returns the function that restores them. */
export function useCoverageHooks(replace: Partial<CoverageHooks>): () => void {
  const old = { ...hooks };
  Object.assign(hooks, replace);
  return () => {
    Object.assign(hooks, old);
  };
}

/**
 * createCoverageVolume makes the volume for the raw coverage of the suites
 * of one package.
 */
async function createCoverageVolume(
  signal: AbortSignal,
  input: Input,
): Promise<string> {
  if (input.docker === null) {
    throw new Error("there is no Docker driver");
  }
  return input.docker.createVolume(
    signal,
    "coverage-" + input.context.id.toLowerCase(),
  );
}

/**
 * coverageReportTimeout is how long the one c8 report over all suites gets.
 * It does not depend on the Check's own signal, like the reading of the
 * events: the raw coverage is there after a timeout as well.
 */
export const coverageReportTimeout = 5n * minute;

/**
 * buildCoverageReport runs `c8 report` over the raw coverage in the Input's
 * coverage volume, with the Working copy mounted read-only for the files no
 * suite loaded (--all), and reads the JSON summary and the per-file JSON.
 * Both are null when c8 wrote none.
 */
async function buildCoverageReport(
  _signal: AbortSignal,
  input: Input,
): Promise<[Uint8Array | null, Uint8Array | null]> {
  const pkg = input.context.package;
  const node = input.context.node;
  const drv = input.docker;
  if (pkg === null || node === null || drv === null) {
    return [null, null];
  }
  const image = node.image;
  const suffix = input.context.id.toLowerCase();
  const r = withTimeout(background(), coverageReportTimeout);
  try {
    const c = await drv.runContainer(r.signal, {
      name: "coveragereport-" + suffix,
      image,
      cmd: ["node", c8Bin, "report", "--config", c8ConfigPath],
      workDir: workPath(pkg),
      network: NetworkNone,
      mounts: [
        { volume: input.workVolume, path: workMount, readOnly: true },
        { volume: input.toolsetVolume, path: MountPath, readOnly: true },
        { volume: input.coverageVolume, path: coverageMount },
      ],
      files: [
        {
          path: c8ConfigPath,
          mode: 0o644,
          content: coverageConfig(input.project, pkg),
        },
      ],
    });
    if (c.exitCode !== 0) {
      return [null, null];
    }
  } catch {
    return [null, null];
  } finally {
    r.cancel();
  }
  const summary = await readVolumeFile(
    input,
    image,
    input.coverageVolume,
    "coverage-summary-" + suffix,
    coverageSummaryFile,
  );
  const perFile =
    summary === null
      ? null
      : await readVolumeFile(
          input,
          image,
          input.coverageVolume,
          "coverage-files-" + suffix,
          coverageFilesFile,
        );
  return [summary, perFile];
}

async function readVolumeFile(
  input: Input,
  image: string,
  volume: string,
  name: string,
  file: string,
): Promise<Buffer | null> {
  const drv = input.docker;
  if (drv === null) {
    return null;
  }
  const r = withTimeout(background(), 60n * second);
  try {
    const c = await drv.runContainer(r.signal, {
      name,
      image,
      cmd: ["cat", file],
      mounts: [{ volume, path: coverageMount, readOnly: true }],
      network: NetworkNone,
    });
    return c.exitCode === 0 ? c.stdout : null;
  } catch {
    return null;
  } finally {
    r.cancel();
  }
}

const coverageCountShape = shape.object({
  total: shape.number,
  covered: shape.number,
});

/**
 * coverageSummaryShape is what c8's json-summary reporter documents, as far
 * as the Check relies on it: a total with the counts of each measure. The
 * entries of the files are read by interpretCoverage.
 */
const coverageSummaryShape = shape.object({
  total: shape.object({
    lines: coverageCountShape,
    branches: coverageCountShape,
    functions: coverageCountShape,
  }),
});

/**
 * readCoverage reads what c8 wrote. When it cannot, it returns the fixed
 * sentence that says what about the files could not be read, never text of
 * the files: the shape of the summary is checked first, and a summary with
 * the total c8 documents but entries of files that have no counts is told
 * apart from one that has no total.
 */
function readCoverage(
  summary: Uint8Array,
  perFile: Uint8Array | null,
  workDir: string,
  pkgPath: string,
): Coverage | string {
  try {
    requireShape("c8", summary, coverageSummaryShape);
  } catch (err) {
    return err instanceof UnreadableOutput
      ? err.summary
      : "it is not the JSON summary that c8 documents";
  }
  const measured = interpretCoverage(summary, perFile, workDir, pkgPath);
  if (measured.err === "") {
    return measured;
  }
  return measured.err.endsWith("has no total")
    ? "its JSON summary has no total"
    : "the entries of its files do not have the counts c8 documents";
}

/** coverageResult is the result of tests.coverage, from the suite's one run. */
export function coverageResult(input: Input, suite: Result): Result {
  const res: Result = { status: StatusCompleted };
  if (suite.command !== undefined) {
    res.command = suite.command;
  }
  if (suite.tool !== undefined) {
    res.tool = suite.tool;
  }
  if (input.selection !== null && !selected(input.selection, testsExistingID)) {
    // Nothing else reports this run: its Services and the overrides of the
    // project's command are reported here.
    if (suite.services !== undefined) {
      res.services = suite.services;
    }
    if (suite.limitations !== undefined) {
      res.limitations = suite.limitations;
    }
  }
  const cov = suite.coverage ?? null;
  const fromSuite = (): void => {
    res.status = suite.status;
    if (suite.reasonCode !== undefined) {
      res.reasonCode = suite.reasonCode;
    }
    if (suite.reason !== undefined) {
      res.reason = suite.reason;
    }
  };
  if (suite.status === StatusUnsupported) {
    fromSuite();
    return res;
  }
  if (cov === null) {
    // The suite stopped before its tests were run: the runner is not
    // installed, the Services did not come up, or there was no container.
    fromSuite();
    let why = suite.reason ?? "";
    for (const f of suite.findings ?? []) {
      if (f.gate && why === "") {
        why = f.title;
      }
    }
    res.metrics = unmeasuredCoverage(
      "the tests did not run, so there is no coverage: " + why,
    );
    return res;
  }
  if (cov.unavailable !== "") {
    res.status = StatusInfrastructureError;
    res.reasonCode =
      cov.unavailableCode === "" ? "toolset_unavailable" : cov.unavailableCode;
    res.reason = cov.unavailable;
    return res;
  }
  res.tool = c8Tool(suite.tool ?? null);
  const tool = npmTool("c8");
  if (tool !== undefined) {
    res.contextTools = [
      { name: tool.name, version: tool.version, digest: tool.integrity },
    ];
  }

  if (cov.summary === null) {
    let reason = "c8 wrote no coverage report";
    if (suite.status !== StatusCompleted) {
      fromSuite();
      reason =
        "the test run did not finish, so c8 wrote no coverage report: " +
        (suite.reason ?? "");
    } else {
      res.status = StatusToolError;
      res.reasonCode = "no_coverage_output";
      res.reason = reason + " although the test run finished";
    }
    res.metrics = unmeasuredCoverage(reason);
    return res;
  }
  const pkg = input.context.package;
  if (pkg === null) {
    throw new Error("tests.coverage ran in a Context without a package");
  }
  // A summary that is not the JSON c8 documents says nothing about the
  // package: a tool problem, with the files c8 wrote kept as they are.
  const measured = readCoverage(
    cov.summary,
    cov.perFile,
    workPath(pkg),
    pkg.path,
  );
  if (typeof measured === "string") {
    const files: RawFile[] = [
      { name: "coverage-summary.json", content: cov.summary },
    ];
    if (cov.perFile !== null) {
      files.push({ name: "coverage-final.json", content: cov.perFile });
    }
    const outputs = new ToolOutputs(testsCoverageID, input.context.id);
    outputs.rejectFiles("c8", "c8", files, measured);
    outputs.apply(res);
    res.metrics = unmeasuredCoverage(
      `c8's JSON summary is not readable: ${measured}`,
    );
    return res;
  }
  const note = coverageNote(input, suite);
  if (note !== "") {
    noteFailures(measured, note);
  }
  res.status = StatusCompleted;
  res.metrics = measured.metrics;
  res.artifacts = [
    newArtifact({
      id: "files-" + input.context.id,
      path:
        "artifacts/" + testsCoverageID + "/" + input.context.id + "-files.json",
      media_type: "application/json",
      content: measured.filesDocument,
    }),
  ];
  return res;
}

/**
 * c8Tool is the Tool of the Check: c8, which returned the exit code of the
 * runner it wrapped.
 */
function c8Tool(suite: Tool | null): Tool {
  const tool = npmTool("c8");
  return {
    name: "c8",
    version: tool === undefined ? null : tool.version,
    exit_code: suite?.exit_code ?? null,
  };
}

/**
 * unmeasuredCoverage is the three metrics of a package that could not be
 * measured: null, with the reason, never a made-up number.
 */
function unmeasuredCoverage(reason: string): Metric[] {
  return coverageKinds.map((k) =>
    newMetric({ name: k.name, unit: "percent", reason }),
  );
}

/**
 * coverageNote says what is wrong with the runs that coverage was measured
 * on: the problems of the suites together (see suiteNote) and the suites of
 * a package with several that did not get as far as their tests, whose
 * coverage is missing from the union.
 */
function coverageNote(input: Input, suite: Result): string {
  const parts: string[] = [];
  const note = suiteNote(suite);
  if (note !== "") {
    parts.push(note);
  }
  const results = suite.parts ?? [];
  if (results.length > 1) {
    const suites = input.context.package?.tests?.suites ?? [];
    for (const [i, p] of results.entries()) {
      const s = suites[i];
      if (
        (p.coverage ?? null) === null &&
        i < suiteCount(input.context.package) &&
        s !== undefined
      ) {
        parts.push(
          shownWord(s.origin, "suite name") +
            " did not run its tests, so what only it reaches is not counted",
        );
      }
    }
  }
  return parts.join("; ");
}

/**
 * suiteNote says what is wrong with the run that coverage was measured on,
 * or "" when nothing is.
 */
export function suiteNote(suite: Result): string {
  const parts: string[] = [];
  let failed = 0;
  for (const p of suite.inventory?.tests ?? []) {
    failed += p.failed;
  }
  let gates = 0;
  for (const f of suite.findings ?? []) {
    if (f.gate) {
      gates++;
    }
  }
  if (failed === 1) {
    parts.push("1 test failed");
  } else if (failed > 1) {
    parts.push(`${String(failed)} tests failed`);
  } else if (gates > 0) {
    parts.push(
      "the suite has failures (a failed hook, a test file that fails to load or a run that stopped early)",
    );
  }
  if (suite.status !== StatusCompleted) {
    parts.push("the test run did not finish: " + (suite.reason ?? ""));
  }
  return parts.join("; ");
}
