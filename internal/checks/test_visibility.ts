// Settings that hide results (Go: test_visibility.go).
import type { Limitation } from "../resultset/types.ts";
import type { Input } from "./input.ts";
import type { SuiteEvents } from "./test_events.ts";

const testsExistingID = "tests.existing";

/**
 * eventLimitations are the Limitations a suite's events add to the Report:
 * the project's own bail setting that the run switched off, and the counts
 * the reporter could not see in full. The project's command line is known
 * before the run, so its overrides are listed by commandOverrides; what a
 * configuration file sets is only known to Mocha itself, and arrives as an
 * event.
 */
export function eventLimitations(input: Input, ev: SuiteEvents): Limitation[] {
  const manifest = input.manifestPath();
  const out: Limitation[] = [];
  if (ev.projectBail) {
    out.push({
      reason_code: "test_command_override",
      message:
        "The project's Mocha configuration sets bail, which stops the run at the first failure. It is switched off with --no-bail, so that one failure does not hide the rest.",
      check_id: testsExistingID,
      path: manifest,
    });
  }
  if (ev.partial !== "") {
    out.push({
      reason_code: "test_counts_lower_bound",
      message: `${partialReason(ev.partial)} The counts of found, never-run and focused tests are lower bounds.`,
      check_id: testsExistingID,
      path: manifest,
    });
  }
  return out;
}

/** partialReason says why the reporter could not announce every test. */
function partialReason(code: string): string {
  if (code === "parallel") {
    return "Mocha runs the test files in parallel worker processes, so the reporter sees a test only when it has run, and never sees the tests that a .only excluded or that a file which failed to load held.";
  }
  return `Mocha did not announce every test (${code}).`;
}
