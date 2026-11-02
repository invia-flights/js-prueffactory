// tests.coverage (Go: tests_coverage.go) and the one run of a package's
// suites that it shares with tests.existing. Ticket 14 of the port brings
// the shared run (sharedSuite) and the points where c8 joins it; ticket 15
// wraps the runner with c8 there and adds the Check's own Result.
import type { ContainerSpec } from "../docker/driver.ts";
import { NotApplicable } from "../resultset/types.ts";
import { type Check, register } from "./check.ts";
import type { Input, Result } from "./input.ts";
import { selected } from "./selection.ts";
import { Shared } from "./shared.ts";
import { runSuites } from "./test_suites.ts";
import { testsExisting } from "./tests_existing.ts";

export const testsCoverageID = "tests.coverage";

// testsCoverage measures the Coverage of the test run. The run arrives with
// ticket 15 of the port.
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
  unavailableCode: string;
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

/** notYet is why the TypeScript build does not measure a run yet. */
const notYet = "the TypeScript build does not measure coverage yet";

/**
 * addCoverage puts c8 around the runner of a suite container when the run
 * is to be measured, and returns the spec to run with what the run needs to
 * remember (null when the run is not measured). Until ticket 15 of the port
 * the run goes on without c8 and says so.
 */
export function addCoverage(
  input: Input,
  spec: ContainerSpec,
): [ContainerSpec, CoverageRun | null] {
  if (!wantsCoverage(input)) {
    return [spec, null];
  }
  return [
    spec,
    {
      unavailable: notYet,
      unavailableCode: "",
      summary: null,
      perFile: null,
    },
  ];
}

/**
 * withCoverageLocation returns the Input for the run of all suites of the
 * package. When tests.coverage is selected it holds the one run-owned
 * volume that every suite writes its raw V8 coverage into, or says why there
 * is none.
 */
export function withCoverageLocation(
  _signal: AbortSignal,
  input: Input,
): Promise<Input> {
  const run = input.forSuite(input.suiteIndex);
  if (wantsCoverage(input)) {
    run.coverageError = notYet;
  }
  return Promise.resolve(run);
}

/**
 * sharedCoverage is what the runs of the suites recorded for coverage, as
 * one: when any suite was measured, one c8 report over the raw coverage of
 * all of them. It is null when no suite reached its tests.
 */
export function sharedCoverage(
  _signal: AbortSignal,
  _input: Input,
  parts: readonly Result[],
): Promise<CoverageRun | null> {
  for (const p of parts) {
    const cov = p.coverage ?? null;
    if (cov !== null && cov.unavailable !== "") {
      return Promise.resolve(cov);
    }
  }
  return Promise.resolve(null);
}
