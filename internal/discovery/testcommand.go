package discovery

import (
	"path"
	"regexp"
)

// TestRunner is a test runner milestone 1 can run.
type TestRunner string

const (
	RunnerMocha    TestRunner = "mocha"
	RunnerNodeTest TestRunner = "node:test"
)

// Reason codes of a test command that cannot be run.
const (
	// CodeTestRunnerUnsupported is a runner the script names that is not
	// supported, such as Jest.
	CodeTestRunnerUnsupported = "test_runner_unsupported"
	// CodeTestCommandUnsupported is a script that is not a plain test runner
	// command: shell syntax, a wrapper script, an npm script.
	CodeTestCommandUnsupported = "test_command_unsupported"
)

// TestSetup is how a package runs its own tests, read from `scripts.test` or
// from a Mocha config file. It is what the project says; nothing was run.
type TestSetup struct {
	// Suites are the runner invocations of the package, in the order they run.
	// Empty when Unsupported is set.
	Suites []Suite
	// Script is the text of `scripts.test`, empty when the tests come from a
	// config file.
	Script string
	// Unsupported is set when the package has tests this release cannot run.
	Unsupported *Unsupported
	// LeftOut lists the steps of the test script chain that are not run
	// because another Check covers them: linters.
	LeftOut []LeftOutStep
}

// Suite is one runner invocation of a package's tests: from one test command
// or from one step of a chain.
type Suite struct {
	Runner TestRunner
	// Args are the arguments the project gives the runner: everything after
	// `mocha`, and everything after `node` for node:test, `--test` included.
	Args []string
	// Env holds the VAR=value assignments in front of the command and the ones
	// `cross-env` takes. They become container environment variables.
	Env map[string]string
	// Dropped is the leading `c8` or `nyc` with its own options, which the
	// tool does not run. Empty when there was none.
	Dropped string
	// Origin names the suite: the npm script its command is in, "scripts.test"
	// when that is the test script itself, or the name of the `.mocharc.*` file
	// that made the package a Mocha package. Suites that would share a name get
	// a number: "test:unit#1".
	Origin string
}

// placeholderTest is what `npm init` writes. It is a test script that runs no
// tests, so the package counts as having none.
var placeholderTest = regexp.MustCompile(`^echo\s+["']?Error: no test specified["']?\s*&&\s*exit\s+1$`)

var assignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// namedRunners are the test runners people use that this release does not
// run, by the word the script uses for them.
var namedRunners = map[string]string{
	"jest": "Jest", "vitest": "Vitest", "ava": "AVA", "tap": "tap", "jasmine": "Jasmine",
	"karma": "Karma", "playwright": "Playwright", "cypress": "Cypress", "tape": "tape",
	"uvu": "uvu", "lab": "lab", "mocha-parallel-tests": "mocha-parallel-tests",
}

// ParseTestScript resolves a package whose only script is `scripts.test`. See
// ResolveTestScript.
func ParseTestScript(script string) *TestSetup {
	return ResolveTestScript(map[string]string{"test": script})
}

func isWrapper(word string) bool {
	b := path.Base(word)
	return b == "c8" || b == "nyc"
}

func isMochaWord(word string) bool {
	b := path.Base(word)
	return b == "mocha" || b == "_mocha"
}

func isRunnerWord(word string) bool { return isMochaWord(word) || word == "node" }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
