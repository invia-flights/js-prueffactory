package checks

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A package's tests are an ordered list of suites (discovery.Suite). The three
// Checks that run or read the Suites go through the helpers here: one Input is
// bound to one suite, and the results of the suites are added up for the
// Checks that report the package as a whole.

// forSuite returns a copy of the Input bound to the i-th suite of the
// package's tests.
func (in *Input) forSuite(i int) *Input {
	bound := *in
	bound.suiteIndex = i
	return &bound
}

// suite is the suite the Input is bound to, or nil when the package has none
// (no tests, or tests this release cannot run).
func (in *Input) suite() *discovery.Suite {
	p := in.Context.Package
	if p == nil || p.Tests == nil || in.suiteIndex >= len(p.Tests.Suites) {
		return nil
	}
	return &p.Tests.Suites[in.suiteIndex]
}

// suiteCount is how many suites the package runs.
func suiteCount(p *discovery.Package) int {
	if p == nil || p.Tests == nil {
		return 0
	}
	return len(p.Tests.Suites)
}

// suiteSuffix ends the names of the containers, volumes and networks of the
// suite's run. The first suite keeps the plain Context name, so that a package
// with one suite is named as it always was.
func (in *Input) suiteSuffix() string {
	suffix := strings.ToLower(in.Context.ID)
	if in.suiteIndex > 0 {
		suffix += fmt.Sprintf("-s%d", in.suiteIndex+1)
	}
	if in.repeat != nil {
		suffix += fmt.Sprintf("-run%d", in.repeat.number)
	}
	return suffix
}

// testLogName is the file name of the suite's command log. A package with one
// suite has test-output.log. With several, the name holds the suite's place in
// the chain and its name, so the logs sort in chain order and say which suite
// each belongs to: test-output-2-test-integration.log.
func (in *Input) testLogName() string {
	s := in.suite()
	if s == nil || suiteCount(in.Context.Package) < 2 {
		return "test-output.log"
	}
	return fmt.Sprintf("test-output-%d-%s.log", in.suiteIndex+1, fileNameSlug(s.Origin))
}

// fileNameSlug turns a suite name such as test:unit into something safe in a
// file name: lower case letters, digits, dots and dashes.
func fileNameSlug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// runSuites performs the run of every suite of the package, one after the
// other in list order, each with the Input bound to it. Every suite runs
// whatever happened to the ones before it, until the context ends. The result
// of one suite is returned as it is.
func runSuites(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	n := suiteCount(pkg)
	if n == 0 || unsupportedTests(pkg) != nil {
		return runTestSuite(ctx, in.forSuite(0))
	}
	// All suites write their raw coverage into one location, and one report over
	// it is the package's Coverage.
	run := in.withCoverageLocation(ctx)
	var parts []*Result
	var names []string
	marked := map[string][]string{}
	for i := 0; i < n; i++ {
		bound := run.forSuite(i)
		part := runTestSuite(ctx, bound)
		bound.nameSuite(part, n > 1)
		if services := bound.markServicesNotStarted(part); len(services) > 0 {
			marked[bound.suite().Origin] = services
			part.mayNeed = services
		}
		parts = append(parts, part)
		names = append(names, bound.suite().Origin)
		if ctx.Err() != nil {
			break
		}
	}
	// A package with one suite keeps the suite's own result.
	res := parts[0]
	if n > 1 {
		res = mergeSuiteResults(parts, names)
	}
	serviceNotStartedStatus(res, marked, names)
	res.Limitations = append(res.Limitations, run.setupLimitations()...)
	res.coverage = run.sharedCoverage(ctx, parts)
	return res
}

// nameSuite marks everything the result holds for one suite with the suite's
// name: its Findings, test cases and Inventory rows, and adds the per-suite
// counts. qualify is true for a package with several suites, where a Finding's
// fingerprint also depends on the suite, because the same test can fail in
// two of them.
func (in *Input) nameSuite(res *Result, qualify bool) {
	name := in.suite().Origin
	for i := range res.Findings {
		res.Findings[i].Suite = &name
		if qualify {
			res.Findings[i].Fingerprint = res.Findings[i].Fingerprint.WithSuite(name)
		}
	}
	for i := range res.TestCases {
		res.TestCases[i].Suite = name
	}
	if res.Inventory == nil {
		return
	}
	inv := res.Inventory
	for _, t := range inv.Tests {
		inv.TestSuites = append(inv.TestSuites, resultset.SuiteTests{
			ContextID: t.ContextID, Suite: name, Found: t.Found, Run: t.Run, Passed: t.Passed, Failed: t.Failed,
			Skipped: t.Skipped, Todo: t.Todo, Focused: t.Focused, NeverRun: t.NeverRun,
		})
	}
	for i := range inv.TestFiles {
		inv.TestFiles[i].Suite = name
	}
}

// setupLimitations are the Limitations of how the project's test script was
// read: a chain runs every step, and its lint steps are not run.
func (in *Input) setupLimitations() []resultset.Limitation {
	pkg := in.Context.Package
	id, manifest := testsExistingID, in.manifestPath()
	var out []resultset.Limitation
	if n := suiteCount(pkg); n > 1 {
		names := make([]string, n)
		for i, s := range pkg.Tests.Suites {
			names[i] = s.Origin
		}
		out = append(out, resultset.Limitation{
			ReasonCode: "test_chain_all_steps_run", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("The test script chains %d steps with `&&`, which stops at the first step that fails. The tool ran every step as its own suite (%s), so one failing Suite does not hide the others.", n, quoteAll(names)),
		})
	}
	for _, l := range pkg.Tests.LeftOut {
		out = append(out, resultset.Limitation{
			ReasonCode: "test_step_left_out", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("The step %s of the script %s is not run: it is a linter, and lint.existing covers the project's linter.", resultset.Quote(l.Step), resultset.Quote(l.Script)),
		})
	}
	return out
}

// perSuite is the results of the package's suites, in list order. A result
// that was not merged is its own only suite.
func (r *Result) perSuite() []*Result {
	if len(r.parts) == 0 {
		return []*Result{r}
	}
	return r.parts
}

// mergeSuiteResults adds up the results of the suites of one package into the
// result tests.existing reports: Findings, test cases, counts, Limitations and
// Artifacts in suite order, and the first suite that did not complete decides
// the status. The parts stay readable for the Checks that need them apart.
//
// The Limitations that say how the run differs from the project's command are
// listed once per package, with the suites they apply to. names holds the
// suites' names in the order of parts.
func mergeSuiteResults(parts []*Result, names []string) *Result {
	out := &Result{Status: resultset.StatusCompleted, Command: parts[0].Command, Tool: parts[0].Tool, parts: parts}
	var counts *resultset.PackageTests
	var limitations suiteLimitations
	for pi, p := range parts {
		if out.Status == resultset.StatusCompleted && p.Status != resultset.StatusCompleted {
			out.Status, out.ReasonCode, out.Reason = p.Status, p.ReasonCode, p.Reason
		}
		offset := len(out.Findings)
		out.Findings = append(out.Findings, p.Findings...)
		for _, tc := range p.TestCases {
			tc.Findings = slices.Clone(tc.Findings)
			for i := range tc.Findings {
				tc.Findings[i] += offset
			}
			out.TestCases = append(out.TestCases, tc)
		}
		for _, l := range p.Limitations {
			limitations.add(l, names[pi], isOverride(l))
		}
		out.Artifacts = append(out.Artifacts, p.Artifacts...)
		out.ToolRefs = append(out.ToolRefs, p.ToolRefs...)
		out.ContextTools = append(out.ContextTools, p.ContextTools...)
		out.Redact = append(out.Redact, p.Redact...)
		if out.NPMVersion == "" {
			out.NPMVersion = p.NPMVersion
		}
		out.Services = mergeServices(out.Services, p.Services)
		if p.Inventory == nil {
			continue
		}
		if out.Inventory == nil {
			out.Inventory = &resultset.Inventory{}
		}
		out.Inventory.TestFiles = append(out.Inventory.TestFiles, p.Inventory.TestFiles...)
		out.Inventory.TestSuites = append(out.Inventory.TestSuites, p.Inventory.TestSuites...)
		for _, t := range p.Inventory.Tests {
			if counts == nil {
				c := t
				counts = &c
				continue
			}
			counts.Found, counts.Run, counts.Passed, counts.Failed = counts.Found+t.Found, counts.Run+t.Run, counts.Passed+t.Passed, counts.Failed+t.Failed
			counts.Skipped, counts.Todo, counts.Focused, counts.NeverRun = counts.Skipped+t.Skipped, counts.Todo+t.Todo, counts.Focused+t.Focused, counts.NeverRun+t.NeverRun
		}
	}
	if counts != nil {
		out.Inventory.Tests = []resultset.PackageTests{*counts}
	}
	out.Limitations = limitations.list()
	return out
}

// suiteLimitations collects the Limitations of the suites of one package. A
// Limitation that two suites share is listed once. One that says how the run
// differs from the project's command (or that holds for some suites only) names
// the suites it applies to.
type suiteLimitations struct {
	out    []resultset.Limitation
	naming map[string]int // key of a Limitation that names its suites -> its index in out
	suites map[string][]string
}

// add puts the Limitation of one suite in the list. naming says that the
// listed Limitation ends with the suites it applies to.
func (s *suiteLimitations) add(l resultset.Limitation, suite string, naming bool) {
	if !naming {
		if !slices.ContainsFunc(s.out, func(o resultset.Limitation) bool { return sameLimitation(o, l) }) {
			s.out = append(s.out, l)
		}
		return
	}
	if s.naming == nil {
		s.naming, s.suites = map[string]int{}, map[string][]string{}
	}
	key := l.ReasonCode + "\x00" + l.Message + "\x00" + derefString(l.CheckID) + "\x00" + derefString(l.Path)
	if _, seen := s.naming[key]; !seen {
		s.naming[key] = len(s.out)
		s.out = append(s.out, l)
	}
	if !slices.Contains(s.suites[key], suite) {
		s.suites[key] = append(s.suites[key], suite)
	}
}

// list is the collected Limitations, in the order they were first added.
func (s *suiteLimitations) list() []resultset.Limitation {
	for key, idx := range s.naming {
		s.out[idx].Message += " Applies to the suites: " + quoteAll(s.suites[key]) + "."
	}
	return s.out
}

// quoteAll is the names as code spans, separated by commas.
func quoteAll(names []string) string {
	q := make([]string, len(names))
	for i, n := range names {
		q[i] = resultset.Quote(n)
	}
	return strings.Join(q, ", ")
}

// isOverride says whether a Limitation tells how the run differs from the
// project's own test command.
func isOverride(l resultset.Limitation) bool {
	return l.ReasonCode == "test_command_override" || l.ReasonCode == "test_wrapper_dropped"
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func sameLimitation(a, b resultset.Limitation) bool {
	return a.ReasonCode == b.ReasonCode && a.Message == b.Message && ptrEq(a.CheckID, b.CheckID) && ptrEq(a.Path, b.Path)
}

func ptrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// mergeServices adds the Services of one suite to those of the ones before it:
// a Service the suites share is listed once, and a suite that did not get it
// started decides its status.
func mergeServices(have, more []resultset.Service) []resultset.Service {
	for _, s := range more {
		i := slices.IndexFunc(have, func(h resultset.Service) bool { return h.ComposeService == s.ComposeService })
		switch {
		case i < 0:
			have = append(have, s)
		case have[i].Status == resultset.ServiceStarted && s.Status != resultset.ServiceStarted:
			have[i].Status, have[i].Reason = s.Status, s.Reason
		}
	}
	return have
}
