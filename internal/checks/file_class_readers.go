package checks

// The Checks that read the File class of files, and so wait for the test file
// probe (see FileClassReader): the Checks of the combined ESLint run, which
// lints Test code with Mocha's globals and apart from Source code, the size,
// metrics, clone, Suppression and unused-code Checks, the module cycle and
// types Checks, which examine Source code only, and the Checks that run the Suites,
// which exclude Test code from Coverage and compare the files the runner loaded
// with the classes. The Inventory's Test code hashes are part of
// quality.suppressions.
//
// A Check that reads only Test data or Build output, which the probe never
// changes, is not listed: syntax.parse, schema.compile, artifacts.structured,
// lint.existing, api.lint and the repository Checks.
func (qualityMetrics) ReadsFileClasses() bool      { return true }
func (qualitySize) ReadsFileClasses() bool         { return true }
func (clones) ReadsFileClasses() bool              { return true }
func (qualitySuppressions) ReadsFileClasses() bool { return true }
func (unused) ReadsFileClasses() bool              { return true }
func (cycles) ReadsFileClasses() bool              { return true }
func (typesJavascript) ReadsFileClasses() bool     { return true }
func (lintCorrectness) ReadsFileClasses() bool     { return true }
func (depsEngines) ReadsFileClasses() bool         { return true }
func (testsSmells) ReadsFileClasses() bool         { return true }
func (testsExisting) ReadsFileClasses() bool       { return true }
func (testsCoverage) ReadsFileClasses() bool       { return true }
func (runtimeWarnings) ReadsFileClasses() bool     { return true }
