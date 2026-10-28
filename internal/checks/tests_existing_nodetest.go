package checks

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

//go:embed js/node-test-reporter.js
var nodeTestReporterScript []byte

// nodeTestReporterPath is where our reporter lies in the test container.
const nodeTestReporterPath = "/jspf/node-test-reporter.js"

// nodeTestPlan is how the project's `node --test` arguments turn into a run.
type nodeTestPlan struct {
	// Args are the arguments of the run, after `node`: the project's, without
	// its reporters, plus ours.
	Args []string
	// NativeOptions are the project's options for re-running one test: its own,
	// without its test files, without the ones we replaced and without name
	// patterns, because the one test's pattern is added and patterns add up.
	NativeOptions []string
	// Overrides lists the project's arguments that were removed.
	Overrides []string
}

// planNodeTestArgs keeps the project's arguments, takes out its reporters and
// their destinations, which would otherwise have to pair up with ours, and adds
// our reporter through --test-reporter and --test-reporter-destination. The
// reporter writes its events to the file the JSPF_EVENTS variable names; the
// destination only carries the output of the tests, which ends up in the
// suite's log.
func planNodeTestArgs(args []string, reporter string) nodeTestPlan {
	var p nodeTestPlan
	ours := []string{"--test-reporter=" + reporter, "--test-reporter-destination=stdout"}
	inserted := false
	insert := func() {
		if !inserted {
			p.Args, inserted = append(p.Args, ours...), true
		}
	}
	for _, a := range discovery.ParseNodeTestArgs(args) {
		switch a.Name {
		case "test-reporter", "test-reporter-destination":
			p.Overrides = append(p.Overrides, strings.Join(a.Words, " "))
			continue
		}
		// Node reads its options only up to the first test file or `--`: what
		// follows is for the test files. Our reporter has to come before.
		if a.File || a.Name == "--" {
			insert()
		}
		p.Args = append(p.Args, a.Words...)
		if a.File || a.Name == "--" {
			continue
		}
		if a.Name != "test-name-pattern" && a.Name != "test-skip-pattern" {
			p.NativeOptions = append(p.NativeOptions, a.Words...)
		}
	}
	insert()
	return p
}

// runNodeTest runs a package whose test script is `node … --test …`: the
// project's own arguments, with our reporter in place of its reporters. Node
// itself is the runner, so there is nothing to probe or to install, and the
// version is the Context's. The caller has already checked that the project's
// test Services can be started; the suite gets its own, as the Mocha path does.
//
// The events are the same as the Mocha reporter's, so they become the same
// test cases, Findings and counts (suiteResults).
func (t testsExisting) runNodeTest(ctx context.Context, in *Input) *Result {
	res := &Result{}
	tc := in.suite()
	plan := planNodeTestArgs(tc.Args, nodeTestReporterPath)
	c, ev, done := in.launchSuite(ctx, res, suiteLaunch{
		cmd:          append([]string{"node"}, plan.Args...),
		native:       nodeTestNativeBase(tc, plan),
		overrides:    in.nodeTestOverrides(tc, plan),
		reporterPath: nodeTestReporterPath,
		reporter:     nodeTestReporterScript,
		eventLimitations: func(ev *suiteEvents) []resultset.Limitation {
			return in.nodeTestCountLimitations(tc, ev)
		},
	})
	if done != nil {
		return done
	}

	exit := c.ExitCode
	version := in.Context.Node.Version
	res.Tool = &resultset.Tool{Name: string(discovery.RunnerNodeTest), Version: &version, ExitCode: &exit}
	text := string(c.Stderr) + "\n" + string(c.Stdout)
	in.finishSuite(res, ev, c, suiteEnd{
		noEvents: "node exited without running our reporter or writing any event; the project's arguments may make it print and stop, as --help does",
		notStarted: func() ([]resultset.Finding, []resultset.Limitation) {
			return []resultset.Finding{in.stopFinding("test-run-did-not-start", "node --test stops before it runs any test",
				fmt.Sprintf("node stopped before it ran any test, and the usual cause is an option or a module the project's command names that node cannot use. Its exit code was %d.", exit), c, text)}, nil
		},
		aborted: func() resultset.Finding {
			return in.stopFinding("test-run-aborted", "The test process stops before the suite is finished",
				fmt.Sprintf("The test process exited with code %d before node --test finished. The tests not yet run are reported as never run.", exit), c, text)
		},
	})
	return res
}

// nodeTestNativeBase is the start of the command that re-runs one test with
// the project's own tools: its environment variables, node and its options.
func nodeTestNativeBase(tc *discovery.Suite, plan nodeTestPlan) []string {
	cmd := append(nativeEnvPrefix(tc), "node")
	return append(cmd, plan.NativeOptions...)
}

// nodeTestOverrides lists every way the run differs from the project's own
// command, so nobody mistakes the Report for a run of `npm test`.
func (in *Input) nodeTestOverrides(tc *discovery.Suite, plan nodeTestPlan) []resultset.Limitation {
	return in.overrideLimitations(tc,
		"node --test runs with js-prueffactory's own reporter, which records every test, through --test-reporter and --test-reporter-destination.",
		"The project's argument %s is not passed on, because the reporter is ours.",
		plan.Overrides)
}

// nodeTestCountLimitations says where the counts of a node:test run cannot be
// complete: tests that node leaves out before our reporter sees them, and the
// tests of files that did not load.
func (in *Input) nodeTestCountLimitations(tc *discovery.Suite, ev *suiteEvents) []resultset.Limitation {
	id, manifest := testsExistingID, in.manifestPath()
	var out []resultset.Limitation
	for _, a := range discovery.ParseNodeTestArgs(tc.Args) {
		if a.Name == "test-only" || a.Name == "test-name-pattern" || a.Name == "test-skip-pattern" {
			out = append(out, resultset.Limitation{
				ReasonCode: "test_counts_lower_bound", CheckID: &id, Path: &manifest,
				Message: fmt.Sprintf("The project's argument %s makes node leave out tests before the reporter sees them, so the counts of found and never-run tests are lower bounds.", resultset.Quote(a.Words[0])),
			})
			break
		}
	}
	for _, f := range ev.Files {
		if ev.testsOf(f.File) == 0 {
			out = append(out, resultset.Limitation{
				ReasonCode: "tests_not_counted", CheckID: &id, Path: &manifest,
				Message: fmt.Sprintf("The test file %s reported no test before its process failed, so its tests are not counted.", in.testFile(f.File)),
			})
		}
	}
	return out
}
