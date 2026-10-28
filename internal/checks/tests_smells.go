package checks

import (
	"context"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() {
	Register(testsSmellsID, testsSmells{})
	registerESLintGroup(eslintGroup{
		checkID: testsSmellsID, plugins: []string{"mocha"}, testOnly: true, partialOnUnparsed: true,
		rules: mochaSmellRules(),
		settings: func(*Input) map[string]any {
			return map[string]any{"mocha/additionalCustomNames": nodeTestNames()}
		},
	})
}

const testsSmellsID = "tests.smells"

// testsSmellsGate is the one smell that is a Gate: a focused test makes the
// suite skip every other test and is not meant to be committed.
const testsSmellsGate = "mocha/no-exclusive-tests"

// nodeTestNames makes the plugin see the node:test API. Mocha's BDD interface
// has describe and it, and test is added as a test-case name for global calls.
// node:test files import their functions, and the plugin follows only named
// imports of ES modules (the "require" interface), so those names are added for
// them. Files that get them from require() are not covered.
func nodeTestNames() []any {
	name := func(n, kind, iface string) any {
		return map[string]any{"name": n, "type": kind, "interface": iface}
	}
	return []any{
		name("test", "testCase", "BDD"),
		name("test", "testCase", "require"),
		name("it", "testCase", "require"),
		name("describe", "suite", "require"),
		name("suite", "suite", "require"),
	}
}

// mochaSmellRules are the eslint-plugin-mocha rules of the Check.
func mochaSmellRules() []eslintRuleSpec {
	var rules []eslintRuleSpec
	for _, name := range []string{
		"no-exclusive-tests", "no-pending-tests", "no-identical-title", "handle-done-callback", "no-done-twice",
		"no-async-and-done", "no-code-after-done", "no-return-and-done", "no-nested-tests", "no-async-suite",
		"no-async-in-sync-tests", "no-empty-title", "no-conditional-tests",
	} {
		rules = append(rules, eslintRuleSpec{Name: "mocha/" + name})
	}
	return rules
}

// testsSmells reports test smells in Test code with eslint-plugin-mocha rules
// of the combined ESLint run. A committed .only is a Gate and the other smells
// are warnings.
type testsSmells struct{}

func (testsSmells) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return smellsApplicability(c)
}

// smellsApplicability is eslintTestApplicability, widened for the test file
// probe: a package whose Mocha suites the probe asks may have Test code that
// discovery cannot see, so it stays applicable and Run decides with the
// classes the probe produced.
func smellsApplicability(c *discovery.Context) (resultset.Applicability, string) {
	app, reason := eslintTestApplicability(c)
	if app == resultset.Applicable || !HasTestFileProbe(c) {
		return app, reason
	}
	for _, s := range c.Package.Tests.Suites {
		if s.Runner == discovery.RunnerMocha {
			return resultset.Applicable, ""
		}
	}
	return app, reason
}

func (testsSmells) Images(c *discovery.Context) []string {
	if app, _ := smellsApplicability(c); app != resultset.Applicable {
		return nil
	}
	return eslintImages(c)
}

func (s testsSmells) UsesToolset(c *discovery.Context) bool { return len(s.Images(c)) > 0 }

func (testsSmells) Run(ctx context.Context, in *Input) *Result {
	// The Check waits for the test file probe, so in.Context has the files the
	// runner loads as Test code. When there are still none, there is nothing
	// to examine, and the ESLint run is not started for it.
	if app, reason := eslintTestApplicability(in.Context); app != resultset.Applicable {
		checkID := testsSmellsID
		return &Result{Status: resultset.StatusCompleted, Limitations: []resultset.Limitation{{
			ReasonCode: "no_test_code", CheckID: &checkID,
			Message: "The package has no Test code to examine, not even among the files its test suites load: " + reason + ".",
		}}}
	}
	run, failed := in.eslintRun(ctx)
	if failed != nil {
		return failed
	}
	return interpretTestsSmells(in, run)
}

func interpretTestsSmells(in *Input, run *eslintRun) *Result {
	res, _ := eslintHitsResult(in, run, testsSmellsID, func(rule string) string {
		if rule == testsSmellsGate {
			return "error"
		}
		return "warning"
	})
	return res
}
