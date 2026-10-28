package benchmark

// checkUnhandledRejections is the Check of the Unhandled rejections part.
const checkUnhandledRejections = "runtime.unhandled-rejections"

// measureUnhandledRejections counts the Findings of runtime.unhandled-rejections:
// the tests that pass normally and fail only in the strict run, and the suites
// whose strict run crashes. The tests tests.flaky explains are no Findings, so
// they are not counted. It does not damp repeated hits, because every Finding is
// a promise of its own that nobody handles.
func measureUnhandledRejections(in *partInput) measurement {
	return measurement{raw: float64(len(in.findings))}
}
