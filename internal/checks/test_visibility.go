package checks

import (
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// eventLimitations are the Limitations a suite's events add to the Report:
// the project's own bail setting that the run switched off, and the counts the
// reporter could not see in full. The project's command line is known before
// the run, so its overrides are listed by commandOverrides; what a
// configuration file sets is only known to Mocha itself, and arrives as an
// event.
func (in *Input) eventLimitations(ev *suiteEvents) []resultset.Limitation {
	id, manifest := testsExistingID, in.manifestPath()
	var out []resultset.Limitation
	if ev.ProjectBail {
		out = append(out, resultset.Limitation{
			ReasonCode: "test_command_override", CheckID: &id, Path: &manifest,
			Message: "The project's Mocha configuration sets bail, which stops the run at the first failure. It is switched off with --no-bail, so that one failure does not hide the rest.",
		})
	}
	if ev.Partial != "" {
		out = append(out, resultset.Limitation{
			ReasonCode: "test_counts_lower_bound", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("%s The counts of found, never-run and focused tests are lower bounds.", partialReason(ev.Partial)),
		})
	}
	return out
}

// partialReason says why the reporter could not announce every test.
func partialReason(code string) string {
	if code == "parallel" {
		return "Mocha runs the test files in parallel worker processes, so the reporter sees a test only when it has run, and never sees the tests that a .only excluded or that a file which failed to load held."
	}
	return fmt.Sprintf("Mocha did not announce every test (%s).", code)
}
