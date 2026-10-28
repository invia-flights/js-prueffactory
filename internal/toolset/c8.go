package toolset

// c8 wraps the project's test runner and turns the V8 coverage of the run,
// child processes included, into Istanbul-style reports. It has no install
// script.
func init() {
	registerNPMTool(Tool{Name: "c8", Version: "12.0.0", License: "ISC", Package: "c8"})
}
