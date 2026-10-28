package checks

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

//go:embed js/mocha-reporter.js
var mochaReporterScript []byte

func init() { Register(testsExistingID, testsExisting{}) }

// Where things are in the test container. The events volume is separate from
// the Working copy, so that what the reporter recorded can be read after the
// container is gone, however the run ended.
const (
	reporterPath = "/jspf/mocha-reporter.js"
	eventsMount  = "/jspf-out"
	eventsFile   = eventsMount + "/events.jsonl"
)

// testsExisting runs the project's own test suite the way the project runs it,
// in a container of the package's Context on the Run's internal network, from
// the package folder of the Working copy, after package.install finished.
//
// Mocha runs from the package's own installed copy, with the project's
// arguments, plus our embedded reporter and --no-bail. The reporter's event
// file becomes test cases, Findings and the package's test counts (see
// suiteResults). Failed tests, failed hooks, files that fail to load and a
// missing runner are Gate Findings. Every override of the project's command is
// listed as a Limitation.
//
// The Working copy is mounted writable, because tests that write into their
// own project folder are common and must not fail for that. Whatever they leave
// behind stays in the Run's volume.
type testsExisting struct{}

func (testsExisting) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "tests.existing runs the tests of a package, and this is the project Context"
	}
	if c.Package.Tests == nil {
		return resultset.NotApplicable, "the package has no test script and no Mocha config file"
	}
	return testRunApplicability(c.Package)
}

// mochaVersionUnknown is why the Applicability of a Mocha package is unknown.
const mochaVersionUnknown = "the Mocha version is known only after the dependencies are installed"

// testRunApplicability is the Applicability of the Checks that read the test
// run of a package whose tests exist: unsupported tests are known now, and
// Mocha's version, which decides how its reporter is used, is known only from
// the installed dependencies (spec: Applicability that depends on installed
// dependencies is unknown). The Check runs either way.
func testRunApplicability(pkg *discovery.Package) (resultset.Applicability, string) {
	if reason := unsupportedTestsReason(pkg); reason != "" {
		return resultset.Applicable, "unsupported: " + reason
	}
	for _, s := range pkg.Tests.Suites {
		if s.Runner == discovery.RunnerMocha {
			return resultset.Unknown, mochaVersionUnknown
		}
	}
	return resultset.Applicable, ""
}

// unsupportedTests says why the package's tests cannot be run in this
// release, or returns nil when they can.
func unsupportedTests(pkg *discovery.Package) *discovery.Unsupported {
	switch {
	case pkg.Tests == nil:
		return &discovery.Unsupported{Code: "no_tests", Reason: "the package has no test script and no Mocha config file"}
	case pkg.Tests.Unsupported != nil:
		return pkg.Tests.Unsupported
	}
	for _, s := range pkg.Tests.Suites {
		if s.Runner != discovery.RunnerMocha && s.Runner != discovery.RunnerNodeTest {
			return &discovery.Unsupported{Code: "test_runner_not_implemented",
				Reason: fmt.Sprintf("tests run by %s are not supported yet", s.Runner)}
		}
	}
	return pkg.InstallUnsupported
}

func unsupportedTestsReason(pkg *discovery.Package) string {
	if u := unsupportedTests(pkg); u != nil {
		return u.Reason
	}
	return ""
}

// runnable says whether the Check will start a container in the Context.
func (testsExisting) runnable(c *discovery.Context) bool {
	return c.Package != nil && c.Node != nil && unsupportedTests(c.Package) == nil
}

// Prerequisites: the dependencies have to be installed first. A package whose
// tests cannot run has nothing to install for.
func (t testsExisting) Prerequisites(c *discovery.Context) []string {
	if !t.runnable(c) {
		return nil
	}
	return []string{packageInstallID}
}

func (testsExisting) UsesWorkingCopy() bool { return true }

// UsesServices: a suite that runs gets the project's test Services.
func (t testsExisting) UsesServices(c *discovery.Context) bool { return t.runnable(c) }

// Images tells the engine which image Run will use.
func (t testsExisting) Images(c *discovery.Context) []string {
	if !t.runnable(c) {
		return nil
	}
	return []string{c.Node.Image}
}

// runSuite performs the run of one suite of the package, the one the Input is
// bound to (see forSuite). It is called once per suite, Context and Run (see
// sharedSuite).
func (t testsExisting) runSuite(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := unsupportedTests(pkg); u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	if blocked := in.unresolvedServices(); blocked != nil {
		return blocked
	}
	tc := in.suite()
	if tc.Runner == discovery.RunnerNodeTest {
		return t.runNodeTest(ctx, in)
	}
	res := &Result{}
	image := in.Context.Node.Image
	suffix := in.suiteSuffix()

	install, err := in.probeMocha(ctx, image, suffix)
	if err != nil {
		return failedToRun(res, err)
	}
	if install.missing != "" {
		res.Status = resultset.StatusCompleted
		res.Findings = append(res.Findings, in.runnerMissingFinding(install.missing))
		return res
	}
	if !supportedMochaVersion(install.version) {
		res.Status, res.ReasonCode = resultset.StatusUnsupported, "test_runner_version_unsupported"
		res.Reason = fmt.Sprintf("Mocha %s is installed, and js-prueffactory supports Mocha 9 to 12", install.version)
		return res
	}

	plan := planMochaArgs(tc.Args, reporterPath)
	c, ev, done := in.launchSuite(ctx, res, suiteLaunch{
		cmd:              append([]string{"node", workPath(pkg) + "/node_modules/mocha/" + install.bin}, plan.Args...),
		native:           nativeBase(tc, plan),
		overrides:        in.commandOverrides(tc, plan),
		reporterPath:     reporterPath,
		reporter:         mochaReporterScript,
		eventLimitations: in.eventLimitations,
	})
	if done != nil {
		return done
	}

	exit := c.ExitCode
	res.Tool = &resultset.Tool{Name: "mocha", Version: &install.version, ExitCode: &exit}
	in.finishSuite(res, ev, c, suiteEnd{
		noEvents: "Mocha exited without running any test or writing any event; the project's arguments may make it print and stop, as --help does",
		notStarted: func() ([]resultset.Finding, []resultset.Limitation) {
			f, lim := in.loadFailure(c)
			return []resultset.Finding{f}, []resultset.Limitation{lim}
		},
		aborted: func() resultset.Finding { return in.abortFinding(c) },
	})
	return res
}

// mochaInstall is what the installed Mocha says about itself.
type mochaInstall struct {
	// missing is non-empty when Mocha is not installed, and says how that shows.
	missing string
	version string
	bin     string // path of the executable below node_modules/mocha
}

// probeMocha reads the installed Mocha's manifest from the Working copy.
func (in *Input) probeMocha(ctx context.Context, image, suffix string) (*mochaInstall, error) {
	pkg := in.Context.Package
	file := workPath(pkg) + "/node_modules/mocha/package.json"
	c, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "mochaprobe-" + suffix, Image: image, Cmd: []string{"cat", file}, Network: in.Network,
		Mounts: []docker.Mount{{Volume: in.WorkVolume, Path: workMount, ReadOnly: true}},
	})
	if err != nil {
		return nil, err
	}
	if c.ExitCode != 0 {
		return &mochaInstall{missing: "node_modules/mocha does not exist after the install"}, nil
	}
	var m struct {
		Version string          `json:"version"`
		Bin     json.RawMessage `json:"bin"`
	}
	if json.Unmarshal(c.Stdout, &m) != nil || m.Version == "" {
		return &mochaInstall{missing: "node_modules/mocha/package.json is not a package manifest"}, nil
	}
	return &mochaInstall{version: m.Version, bin: mochaBin(m.Bin)}, nil
}

// mochaBin is the executable of the Mocha package, from its `bin` field. It
// never leaves the package folder.
func mochaBin(raw json.RawMessage) string {
	const fallback = "bin/mocha.js"
	var s string
	var m map[string]string
	switch {
	case json.Unmarshal(raw, &s) == nil && s != "":
	case json.Unmarshal(raw, &m) == nil && m["mocha"] != "":
		s = m["mocha"]
	default:
		return fallback
	}
	s = path.Clean(strings.TrimPrefix(s, "./"))
	if path.IsAbs(s) || s == ".." || strings.HasPrefix(s, "../") {
		return fallback
	}
	return s
}

// supportedMochaVersion says whether the installed Mocha is one of 9 to 12.
func supportedMochaVersion(v string) bool {
	major, _, _ := strings.Cut(v, ".")
	n, err := strconv.Atoi(major)
	return err == nil && n >= 9 && n <= 12
}

// mochaPlan is how the project's Mocha arguments turn into a run.
type mochaPlan struct {
	// Args are the arguments of the run: the project's, without its reporter
	// and bail options, plus ours.
	Args []string
	// NativeOptions are the project's options for re-running one test: its
	// own, without its test files and without the ones we replaced.
	NativeOptions []string
	// Overrides lists the project's arguments that were removed.
	Overrides []string
}

// planMochaArgs keeps the project's arguments, takes out the ones that would
// replace our reporter or hide results (its reporter and options, and bail),
// and adds our reporter and --no-bail. A reporter option from a config file
// can beat the command line in Mocha 10, which is why the reporter learns its
// output path from the environment and not from a reporter option.
func planMochaArgs(args []string, reporter string) mochaPlan {
	var p mochaPlan
	for _, a := range discovery.ParseMochaArgs(args) {
		switch a.Name {
		case "reporter", "R", "reporter-option", "reporter-options", "O", "bail", "b":
			p.Overrides = append(p.Overrides, strings.Join(a.Words, " "))
			continue
		}
		p.Args = append(p.Args, a.Words...)
		if !a.File {
			p.NativeOptions = append(p.NativeOptions, a.Words...)
		}
	}
	p.Args = append(p.Args, "--reporter", reporter, "--no-bail")
	return p
}

// nativeBase is the start of the command that re-runs one test with the
// project's own tools: its environment variables, the runner and its options.
func nativeBase(tc *discovery.Suite, plan mochaPlan) []string {
	cmd := append(nativeEnvPrefix(tc), "npx", "mocha")
	return append(cmd, plan.NativeOptions...)
}

// commandOverrides lists every way the run differs from the project's own
// command, so nobody mistakes the Report for a run of `npm test`.
func (in *Input) commandOverrides(tc *discovery.Suite, plan mochaPlan) []resultset.Limitation {
	return in.overrideLimitations(tc,
		"Mocha runs with js-prueffactory's own reporter, which records every test, and with --no-bail, so that one failure does not hide the rest. `exit` stays as the project configured it.",
		"The project's argument %s is not passed on, because the reporter and bail settings are ours.",
		plan.Overrides)
}

// readEvents reads the reporter's event file from its volume. It does not
// depend on the Check's own context, because it is needed most after a timeout
// or a cancellation.
func (in *Input) readEvents(ctx context.Context, image, volume, suffix string) []byte {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	c, err := in.Docker.RunContainer(rctx, docker.ContainerSpec{
		Name: "events-" + suffix, Image: image, Cmd: []string{"cat", eventsFile},
		Mounts:  []docker.Mount{{Volume: volume, Path: eventsMount, ReadOnly: true}},
		Network: docker.NetworkNone,
	})
	if err != nil || c.ExitCode != 0 {
		return nil
	}
	return c.Stdout
}

// --- Findings of a suite that did not get going ---

func (in *Input) runnerMissingFinding(why string) resultset.Finding {
	rule := "test-runner-not-installed"
	manifest := in.manifestPath()
	tc := in.suite()
	where := "the test script"
	if tc.Origin != "scripts.test" {
		where = "the " + tc.Origin + " file"
	}
	return resultset.Finding{
		CheckID: testsExistingID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsExistingID, rule, manifest, "mocha"),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title: "test runner not installed",
		Message: fmt.Sprintf("%s runs Mocha, but %s. Add mocha to the dependencies or devDependencies of %s and update the lockfile.",
			capitalize(where), why, manifest),
		Locations:    []resultset.Location{in.Location("primary", manifest, 0, 0)},
		Reproduction: in.Reproduction(testsExistingID),
		Limitations:  []string{},
	}
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// outputText is what a finished container printed, for Evidence.
func outputText(c *docker.ContainerResult) string {
	return relativeStack(tail(strings.TrimSpace(string(c.Stderr)+"\n"+string(c.Stdout)), 6000))
}

// loadFailure is the Gate Finding of a run that stopped before any test ran.
// The usual cause is a test file that throws while it loads.
func (in *Input) loadFailure(c *docker.ContainerResult) (resultset.Finding, resultset.Limitation) {
	text := string(c.Stderr) + "\n" + string(c.Stdout)
	rule, title := "test-file-load-failed", "A test file fails to load"
	what := "Mocha stopped before it ran any test, and the usual cause is a test file that throws while it loads, such as a syntax error, a missing module or failing top-level code."
	if strings.Contains(text, "No test files found") {
		rule, title = "no-test-files-found", "Mocha finds no test files"
		what = "Mocha stopped because no file matches the test files the project's command names."
	}
	f := in.stopFinding(rule, title, fmt.Sprintf("%s Its exit code was %d.", what, c.ExitCode), c, text)
	id := testsExistingID
	message := "Mocha stopped before it reported any test, so the tests of the files that did not load are not counted."
	if s := in.suite(); s != nil && suiteCount(in.Context.Package) > 1 {
		message = fmt.Sprintf("In the suite %s, Mocha stopped before it reported any test, so the tests of the files that did not load are not counted.", resultset.Quote(s.Origin))
	}
	return f, resultset.Limitation{ReasonCode: "tests_not_counted", CheckID: &id, Message: message}
}

// abortFinding is the Gate Finding of a run that recorded some results and
// then stopped without finishing, for example because a test called
// process.exit().
func (in *Input) abortFinding(c *docker.ContainerResult) resultset.Finding {
	text := string(c.Stderr) + "\n" + string(c.Stdout)
	return in.stopFinding("test-run-aborted", "The test process stops before the suite is finished",
		fmt.Sprintf("The test process exited with code %d before Mocha finished. The tests not yet run are reported as never run.", c.ExitCode), c, text)
}

func (in *Input) stopFinding(rule, title, message string, c *docker.ContainerResult, text string) resultset.Finding {
	manifest := in.manifestPath()
	at := locate(in.projectFrames(text), manifest)
	return resultset.Finding{
		CheckID: testsExistingID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsExistingID, rule, at.Path, firstErrorLine(text)),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title:        title,
		Message:      message + " " + oneLine(firstErrorLine(text), 300),
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", outputText(c), in.runnerName())},
		Reproduction: in.Reproduction(testsExistingID),
		Limitations:  []string{},
	}
}

// firstErrorLine is the first line of output that looks like an error, or the
// first line.
func firstErrorLine(text string) string {
	first := ""
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		if first == "" {
			first = l
		}
		if strings.Contains(l, "Error") {
			return l
		}
	}
	return first
}
