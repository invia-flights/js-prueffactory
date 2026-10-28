package checks

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// A suite whose tests need a compose Service the Run did not start (an unknown
// family, a private registry, a build section) fails for reasons outside the
// project. The Run cannot tell for sure what a test needs, so it marks a suite
// as "may need Service <name>" in two ways:
//
//   - static: the package's env files or Test code refer to the Service (see
//     discovery.ServiceRef). That is a heuristic.
//   - runtime: a failing test or hook shows a lookup or connection error for the
//     Service's name.
//
// A marked suite gets a Limitation per Service, its failed tests and hooks are
// no Gates and carry a note, and tests.existing is partial, so that the
// Benchmark does not measure the Pass rate (see runSuites). The Findings of
// runtime.warnings, runtime.unhandled-rejections and tests.flaky from a marked
// suite carry the note too and are suspected (see noteServicesNotStarted).
// runtime.warnings reads the marks of the run it shares with tests.existing; the
// other two apply the same rules to the runs they read (see servicesOfRuns) and
// report the Limitation themselves for a Service that only their own runs
// marked, so that every Finding that refers to service_not_started has one.

const serviceNotStarted = "service_not_started"

// serviceMark says why a suite may need a Service the Run did not start.
type serviceMark struct {
	Service string
	// Why the Run did not start it, from the compose file.
	NotStarted string
	// File and Line are where the package refers to the Service, for a static
	// mark. A runtime mark has no Line and its Evidence says what was seen.
	File   string
	Line   int
	Static bool
	// Seen is the error text of a runtime mark, as found in a Finding.
	Seen string
}

// notStartedServices are the compose Services the Run does not start for a
// reason of the compose file, by name. A Service that no suite needed is not
// among them: "no suite ran" is a decision of the Run, not of the compose file.
func (in *Input) notStartedServices() map[string]string {
	out := map[string]string{}
	for _, s := range in.Project.Services {
		if s.NotStarted != nil {
			out[s.Name] = s.NotStarted.Reason
		}
	}
	return out
}

// lookupError matches the codes of a failed name lookup or connection.
var lookupError = regexp.MustCompile(`\b(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH)\b`)

// namesHost says whether text names the host, as a whole host name: not a
// longer name or a sub-domain of it.
func namesHost(text, host string) bool {
	return regexp.MustCompile("(?:^|[^A-Za-z0-9_.-])" + regexp.QuoteMeta(host) + "(?:$|[:/\\s'\"`)\\]},;]|\\.(?:\\s|$))").MatchString(text)
}

// findingText is everything a Finding says about its failure.
func findingText(f *resultset.Finding) string {
	var b strings.Builder
	b.WriteString(f.Message)
	for _, e := range f.Evidence {
		b.WriteString("\n" + e.Text)
	}
	return b.String()
}

func findingRule(f *resultset.Finding) string {
	if f.RuleID == nil {
		return ""
	}
	return *f.RuleID
}

// isTestFailure says whether a Finding is a failed test or hook, which an
// affected suite does not blame on the project.
func isTestFailure(f *resultset.Finding) bool {
	r := findingRule(f)
	return r == "test-failed" || r == "hook-failed"
}

// isStopFailure says whether a Finding is a file that did not load or a run
// that stopped, which only a lookup or connection error ties to a Service.
func isStopFailure(f *resultset.Finding) bool {
	r := findingRule(f)
	return r == "test-file-load-failed" || r == "test-run-aborted"
}

// codeDefect matches the error texts of a file that cannot load because of the
// code itself, not because a Service is missing: a syntax error or a module
// that does not resolve. Such a failure stays a Gate in an affected suite.
var codeDefect = regexp.MustCompile(`\b(?:SyntaxError|ReferenceError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION)\b|Cannot find (?:module|package)`)

// serviceMarks is every way the suite of the Result may need a Service that was
// not started, in Service name order, one mark per Service: the static ones
// first, then the runtime ones for the Services not already marked.
func (in *Input) serviceMarks(res *Result) []serviceMark {
	missing := in.notStartedServices()
	if len(missing) == 0 {
		return nil
	}
	var marks []serviceMark
	seen := map[string]bool{}
	for _, ref := range in.Context.Package.ServiceRefs {
		if why, ok := missing[ref.Service]; ok && !seen[ref.Service] {
			seen[ref.Service] = true
			marks = append(marks, serviceMark{Service: ref.Service, NotStarted: why, File: ref.File, Line: ref.Line, Static: true})
		}
	}
	for i := range res.Findings {
		f := &res.Findings[i]
		if !isTestFailure(f) && !isStopFailure(f) {
			continue
		}
		text := findingText(f)
		code := lookupError.FindString(text)
		if code == "" {
			continue
		}
		for _, name := range sortedNames(missing) {
			if !seen[name] && namesHost(text, name) {
				seen[name] = true
				marks = append(marks, serviceMark{Service: name, NotStarted: missing[name], Seen: code + " for " + name + " in the failing test or hook: " + resultset.Quote(oneLine(f.Title, 120))})
			}
		}
	}
	return marks
}

func sortedNames(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// stopMayComeFromService says whether a file that did not load, or a run that
// stopped, may come from a Service that was not started. A lookup or connection
// error says so. In a suite that refers to the Service by name (a static mark)
// a plain error thrown by a setup file counts too, because the project's own
// error text often hides the lookup error, unless the text shows a defect of the
// code itself.
func stopMayComeFromService(text string, static bool) bool {
	if lookupError.MatchString(text) {
		return true
	}
	return static && !codeDefect.MatchString(text)
}

// markServicesNotStarted applies the marks to the result of one suite and
// returns the names of the Services the suite may need. It adds a Limitation per
// Service, takes the Gate from the failures of the suite that can come from the
// missing Service and adds the note to them. It touches a suite that ran and
// nothing else.
func (in *Input) markServicesNotStarted(res *Result) []string {
	if res.Status != resultset.StatusCompleted || in.suite() == nil {
		return nil
	}
	marks := in.serviceMarks(res)
	if len(marks) == 0 {
		return nil
	}
	names := make([]string, len(marks))
	for i, m := range marks {
		names[i] = m.Service
	}
	note := serviceNote(in.suite().Origin, names, "failure") + " It is not a Gate."
	static := false
	for _, m := range marks {
		static = static || m.Static
	}
	for i := range res.Findings {
		f := &res.Findings[i]
		demote := isTestFailure(f) || isStopFailure(f) && stopMayComeFromService(findingText(f), static)
		if !demote || !f.Gate {
			continue
		}
		f.Gate, f.Confidence = false, resultset.ConfidenceSuspected
		f.Message += " " + note
		f.Limitations = append(f.Limitations, serviceNotStarted)
	}
	for _, m := range marks {
		res.Limitations = append(res.Limitations, in.serviceLimitation(testsExistingID, m, "",
			"Its failed tests and hooks are not Gates and carry a note, and tests.existing is partial, so the Benchmark does not measure the Pass rate."))
	}
	return names
}

// serviceLimitation is the Limitation of one mark of the suite, reported by the
// Check checkID. where says in which run a runtime mark was seen, empty for the
// first run, and effect what the mark does to the Check's results.
func (in *Input) serviceLimitation(checkID string, m serviceMark, where, effect string) resultset.Limitation {
	id, path := checkID, in.manifestPath()
	var how string
	if m.Static {
		path = m.File
		how = fmt.Sprintf("The file %s refers to it in line %d. That is a heuristic over env files and Test code, and it may be wrong.", resultset.Quote(m.File), m.Line)
	} else {
		how = "A test of the suite failed with " + m.Seen + where + "."
	}
	return resultset.Limitation{
		ReasonCode: serviceNotStarted, CheckID: &id, Path: &path,
		Message: fmt.Sprintf("The suite %s may need the compose Service %s, which the Run did not start: %s. %s %s",
			resultset.Quote(in.suite().Origin), m.Service, m.NotStarted, how, effect),
	}
}

// servicesOfRuns is what the suite may need of the Services the Run did not
// start, by the marks of the runs a Check made or read itself
// (runtime.unhandled-rejections, tests.flaky): the static marks always, and the
// runtime marks of a lookup or connection error in any of the runs, the first
// run of the suite before the Check's own. The names are in the order the marks
// were first found.
//
// The Findings that carry the note refer to the Limitation service_not_started.
// tests.existing reports it for the Services the first run marked (see
// markServicesNotStarted), so limits are the Limitations the Check reports for
// the others, when one of its Findings carries the note (see attachSuite).
func (in *Input) servicesOfRuns(checkID string, first *Result, own []*Result) (names []string, limits []resultset.Limitation) {
	effect := fmt.Sprintf("The Findings of %s from the suite carry a note and are suspected.", checkID)
	for i, r := range append([]*Result{first}, own...) {
		where := ""
		if i > 0 {
			where = " in a run " + checkID + " made"
		}
		for _, m := range in.serviceMarks(r) {
			if slices.Contains(names, m.Service) {
				continue
			}
			names = append(names, m.Service)
			if !slices.Contains(first.mayNeed, m.Service) {
				limits = append(limits, in.serviceLimitation(checkID, m, where, effect))
			}
		}
	}
	return names, limits
}

// serviceNote says that a Finding of the suite may come from the Services it
// may need and the Run did not start. what names the Finding: "failure",
// "warning", "note".
func serviceNote(suite string, services []string, what string) string {
	return fmt.Sprintf("The suite %s may need the compose Service %s, which the Run did not start, so this %s may come from that and not from the project.",
		resultset.Quote(suite), strings.Join(services, ", "), what)
}

// noteServicesNotStarted marks a Finding of runtime.warnings,
// runtime.unhandled-rejections or tests.flaky from a suite that may need
// Services the Run did not start: the note, worded for a warning or a note,
// confidence suspected and the Limitation reference. These Findings are no
// Gates and their scoring does not change. Without services it does nothing.
func noteServicesNotStarted(f *resultset.Finding, suite string, services []string) {
	if len(services) == 0 {
		return
	}
	what := "warning"
	if f.Severity == resultset.SeverityNote {
		what = "note"
	}
	f.Message += " " + serviceNote(suite, services, what)
	f.Confidence = resultset.ConfidenceSuspected
	f.Limitations = append(f.Limitations, serviceNotStarted)
}

// serviceNotStartedStatus makes tests.existing partial when a suite may need a
// Service that was not started, unless the package's run already ended in
// another way that says more.
func serviceNotStartedStatus(res *Result, bySuite map[string][]string, order []string) {
	if len(bySuite) == 0 || res.Status != resultset.StatusCompleted {
		return
	}
	var parts []string
	for _, suite := range order {
		if names := bySuite[suite]; len(names) > 0 {
			parts = append(parts, fmt.Sprintf("%s (Service %s)", resultset.Quote(suite), strings.Join(names, ", ")))
		}
	}
	res.Status, res.ReasonCode = resultset.StatusPartial, serviceNotStarted
	res.Reason = "tests of " + strings.Join(parts, ", ") + " may need a compose Service the Run did not start, so their failures are not Gates and the Pass rate is not measured"
}
