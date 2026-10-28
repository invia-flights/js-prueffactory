package benchmark

// checkFlaky is the Check of the Flaky tests part, and ruleFlakyTest the rule
// of its Findings. tests.flaky also reports a note for a test that only some
// runs found, which is not a Flaky test and not counted.
const (
	checkFlaky    = "tests.flaky"
	ruleFlakyTest = "flaky-test"
)

// measureFlakyTests counts the Flaky tests, Mocha retry passes included. It
// does not damp repeated hits, because every Flaky test is its own unreliable
// test.
func measureFlakyTests(in *partInput) measurement {
	n := 0
	for i := range in.findings {
		if ruleOf(&in.findings[i]) == ruleFlakyTest {
			n++
		}
	}
	return measurement{raw: float64(n)}
}
