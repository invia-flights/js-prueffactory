package engine

import (
	"context"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The time limits of one Check execution. Each is bounded by what is left of
// the Budget.
const (
	installTimeout   = 15 * time.Minute
	testSuiteTimeout = checks.SuiteRunTimeout
	checkTimeout     = 10 * time.Minute
	// repeatRunsTimeout is the limit of a Check that runs suites several times,
	// such as tests.flaky. Each of its runs has testSuiteTimeout, which the
	// Check applies itself, so that a run that times out leaves the others; the
	// execution as a whole has only the Budget.
	repeatRunsTimeout = 24 * time.Hour
	// registryTimeout is the limit of the registry-data step, which the first
	// of deps.deprecated and deps.outdated of a package runs for both.
	registryTimeout = 5 * time.Minute
)

// reserve is the end of the Budget kept for writing the Report.
const reserve = 60 * time.Second

// maxParallel is the most Check executions that run at once.
const maxParallel = 4

// timeLimit is the time limit of one execution of a Check.
func timeLimit(checkID string) time.Duration {
	switch checkID {
	case "package.install":
		return installTimeout
	case "tests.existing", "tests.coverage", "runtime.warnings":
		// runtime.warnings may be the one that starts the suite both read.
		return testSuiteTimeout
	case "tests.flaky", "runtime.unhandled-rejections":
		return repeatRunsTimeout
	case "deps.deprecated", "deps.outdated":
		return registryTimeout
	}
	return checkTimeout
}

// isTestSuite says whether a Check runs the project's tests. Test suites take
// the longest, so they start first.
func isTestSuite(checkID string) bool {
	return timeLimit(checkID) == testSuiteTimeout || timeLimit(checkID) == repeatRunsTimeout
}

// parallelism is how many Check executions run at once: half the Docker
// daemon's CPUs, at most four, at least one.
func parallelism(daemonCPUs int) int {
	n := daemonCPUs / 2
	if n > maxParallel {
		n = maxParallel
	}
	if n < 1 {
		n = 1
	}
	return n
}

// reserveStart is when running executions are cancelled: the Budget minus the
// reserve for writing the Report.
func reserveStart(start time.Time, budget time.Duration) time.Time {
	return start.Add(budget - reserve)
}

// endReason says why an execution that did not complete ended, from the three
// contexts it ran in: the Run (cancelled by the user), the Budget (ends when
// the reserve starts) and the execution's own time limit. It returns the empty
// status when none of them ended, so the Check's own status stands.
func endReason(run, budget, own context.Context) resultset.ExecStatus {
	switch {
	case run.Err() != nil:
		return resultset.StatusCancelled
	case budget.Err() != nil:
		return resultset.StatusBudgetExhausted
	case own.Err() != nil:
		return resultset.StatusTimedOut
	}
	return ""
}
