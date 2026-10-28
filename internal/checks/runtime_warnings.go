package checks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const runtimeWarningsID = "runtime.warnings"

func init() { Register(runtimeWarningsID, runtimeWarnings{}) }

// exitGrace is how long the test process gets to exit after the reporter wrote
// its end event. After that the container is stopped.
const exitGrace = 30 * time.Second

// runtimeWarnings reports what the test run of tests.existing showed about the
// process: warnings and deprecations Node printed, resources the tests left
// open, and a process that stayed alive after the tests finished. It does not
// run the tests a second time. Both Checks read one run of the suite (see
// sharedSuite), made with Node's warning flags when this Check is selected. It
// has no Gates.
type runtimeWarnings struct{}

func (runtimeWarnings) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "runtime.warnings reads the test run of a package, and this is the project Context"
	}
	if c.Package.Tests == nil {
		return resultset.NotApplicable, "the package has no test script and no Mocha config file, so there is no test run to read"
	}
	return testRunApplicability(c.Package)
}

// The Check needs what the test run needs.
func (runtimeWarnings) Prerequisites(c *discovery.Context) []string {
	return testsExisting{}.Prerequisites(c)
}
func (runtimeWarnings) UsesWorkingCopy() bool { return true }

// UsesServices: when this Check starts the shared run, the suite gets the
// project's test Services like it does for tests.existing.
func (runtimeWarnings) UsesServices(c *discovery.Context) bool {
	return testsExisting{}.UsesServices(c)
}
func (runtimeWarnings) Images(c *discovery.Context) []string {
	return testsExisting{}.Images(c)
}

func (runtimeWarnings) Run(ctx context.Context, in *Input) *Result {
	if u := unsupportedTests(in.Context.Package); u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	raw := in.sharedSuite(ctx)
	out := &Result{Command: raw.Command}
	if in.Selection != nil && !in.Selection.Selected(testsExistingID) && !in.Selection.Selected(testsCoverageID) {
		// Nothing else reports the run, so this Check reports its Services.
		out.Services = raw.Services
	}
	ran := 0
	for _, p := range raw.perSuite() {
		if p.suite != nil {
			ran++
		}
	}
	if ran == 0 {
		if raw.Status != resultset.StatusCompleted {
			out.Status, out.ReasonCode, out.Reason = raw.Status, raw.ReasonCode, raw.Reason
			return out
		}
		id := runtimeWarningsID
		out.Status = resultset.StatusCompleted
		out.Limitations = []resultset.Limitation{{
			ReasonCode: "tests_not_run", CheckID: &id,
			Message: "The test suite did not run, so there is no run to read warnings and open resources from. tests.existing says why.",
		}}
		return out
	}
	// A run that did not complete keeps its status, and whatever it printed
	// before it ended still counts. The partial status of a package with a
	// suite that may need a Service the Run did not start is about the Pass
	// rate, which this Check does not report, so it does not carry over.
	if raw.ReasonCode != serviceNotStarted {
		out.Status, out.ReasonCode, out.Reason = raw.Status, raw.ReasonCode, raw.Reason
	} else {
		out.Status = resultset.StatusCompleted
	}

	// Warnings and open resources are read per suite. In a package with several
	// suites the Findings name their suite, and so do the Limitations that hold
	// for the suites they are listed with.
	several := suiteCount(in.Context.Package) > 1
	var limitations suiteLimitations
	for i, p := range raw.perSuite() {
		if p.suite == nil {
			continue
		}
		bound := in.forSuite(i)
		warnings, cut := bound.warningFindings(p.suite.Stderr)
		findings := append(warnings, bound.suiteHealthFindings(p.suite.Events, p.suite.Hung)...)
		name := bound.suite().Origin
		for j := range findings {
			if several {
				findings[j].Suite = &name
				findings[j].Fingerprint = findings[j].Fingerprint.WithSuite(name)
			}
			// A suite that may need a Service the Run did not start can leave
			// failed lookups and sockets open because of it.
			noteServicesNotStarted(&findings[j], name, p.mayNeed)
		}
		out.Findings = append(out.Findings, findings...)
		for _, l := range bound.warningLimitations(p.suite, cut) {
			limitations.add(l, bound.suite().Origin, several)
		}
	}
	out.Limitations = limitations.list()
	return out
}

// warningLimitations lists where the Check's view of the run is incomplete.
func (in *Input) warningLimitations(suite *suiteRun, cut int) []resultset.Limitation {
	id, manifest := runtimeWarningsID, in.manifestPath()
	add := func(code, format string, a ...any) resultset.Limitation {
		return resultset.Limitation{ReasonCode: code, Message: fmt.Sprintf(format, a...), CheckID: &id, Path: &manifest}
	}
	var out []resultset.Limitation
	if in.Selection != nil && !in.Selection.Selected(testsExistingID) {
		// When tests.existing is selected it lists the override of NODE_OPTIONS
		// for the run both Checks read, so it is listed once.
		out = append(out, in.nodeOptionsLimitation(id))
	}
	if suite.Runner == string(discovery.RunnerNodeTest) {
		out = append(out, add("open_resources_not_collected",
			"Open resources are not collected for node:test suites, because node --test runs every test file in its own process and our reporter lives in the parent. A process that stays alive after the tests is still reported."))
	}
	if flag := in.suppressedWarnings(); flag != "" {
		out = append(out, add("warnings_suppressed",
			"The project's test command sets %s, so Node prints fewer or no warnings and this Check sees only what gets through.", flag))
	}
	if cut > 0 {
		out = append(out, add("warnings_truncated",
			"%d more distinct warnings were printed than the %d that are reported.", cut, maxWarningFindings))
	}
	return out
}

// nodeOptionsLimitation says that the run had Node's warning flags added.
func (in *Input) nodeOptionsLimitation(checkID string) resultset.Limitation {
	manifest := in.manifestPath()
	return resultset.Limitation{
		ReasonCode: "test_command_override", CheckID: &checkID, Path: &manifest,
		Message: "NODE_OPTIONS of the test run gets " + warningFlags + " after the project's own value, so that Node says where warnings come from.",
	}
}

// suppressedWarnings names what in the project's test command silences Node's
// warnings, or returns "".
func (in *Input) suppressedWarnings() string {
	tc := in.suite()
	if tc == nil {
		return ""
	}
	if v := tc.Env["NODE_NO_WARNINGS"]; v == "1" {
		return "NODE_NO_WARNINGS=1"
	}
	words := strings.Fields(tc.Env["NODE_OPTIONS"])
	for _, a := range discovery.ParseMochaArgs(tc.Args) {
		words = append(words, a.Words...)
	}
	for _, flag := range []string{"--no-warnings", "--no-deprecation"} {
		if slices.Contains(words, flag) || slices.Contains(tc.Args, flag) {
			return flag
		}
	}
	return ""
}

// --- one run of the suite for two Checks ---

// suiteRun is what a test run left for runtime.warnings: its stderr, its
// events and whether the process had to be stopped after the grace period.
type suiteRun struct {
	// Selected is true when runtime.warnings was selected, so that the run was
	// made with Node's warning flags.
	Selected bool
	Stderr   string
	Events   *suiteEvents
	// Hung is true when the process stayed alive for the whole grace period
	// after the end event and the container was stopped.
	Hung   bool
	Runner string
}

// runTestSuite performs the run of the project's test suite, for sharedSuite.
// Tests replace it.
var runTestSuite = func(ctx context.Context, in *Input) *Result {
	return testsExisting{}.runSuite(ctx, in)
}

// recordSuiteRun notes in the suite's result what runtime.warnings reads, and
// the Limitations that belong to the run whoever reports it: the Node flags
// added to the project's command, and a process that had to be stopped when
// nobody reports it as a Finding.
func (in *Input) recordSuiteRun(res *Result, ev *suiteEvents, c *docker.ContainerResult) {
	res.suite = in.suiteRunOf(ev, c)
	if in.repeat != nil {
		// A repeat run is read by the Check that made it. The Limitations of
		// the first run describe the first run.
		return
	}
	id, manifest := testsExistingID, in.manifestPath()
	switch {
	case res.suite.Selected:
		res.Limitations = append(res.Limitations, in.nodeOptionsLimitation(id))
	case res.suite.Hung:
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "process_stopped_after_grace", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("The test process was still running %d seconds after the tests finished, so the tool stopped the container. Every result was recorded. runtime.warnings is not selected, so this is not reported as a Finding.", int(exitGrace/time.Second)),
		})
	}
}

// addWarningsEnv adds to the environment of the test run what runtime.warnings
// and the exit watch need, and returns the marker that ends the run. When
// runtime.warnings is selected, Node's warning flags go into NODE_OPTIONS after
// any value from the test command. The end marker is added whatever the
// Selection, because a suite that keeps its process alive must not use up the
// Budget. Its text is new for every run, because the project's code sees the
// environment too.
func (in *Input) addWarningsEnv(env map[string]string) *docker.EndMarker {
	switch {
	case in.repeat != nil:
		// A repeat run gets no warning flags, only what its Check adds.
		if in.repeat.nodeOptions != "" {
			env["NODE_OPTIONS"] = strings.TrimSpace(env["NODE_OPTIONS"] + " " + in.repeat.nodeOptions)
		}
	case in.Selection == nil || in.Selection.Selected(runtimeWarningsID):
		env["NODE_OPTIONS"] = strings.TrimSpace(env["NODE_OPTIONS"] + " " + warningFlags)
	}
	var nonce [12]byte
	_, _ = rand.Read(nonce[:])
	marker := "@@jspf-end-" + hex.EncodeToString(nonce[:]) + "@@"
	env["JSPF_END_MARKER"] = marker
	return &docker.EndMarker{Text: marker, Grace: exitGrace}
}

// suiteRunOf records what the container left behind. c is nil when the
// container did not return a result, for example after a timeout.
func (in *Input) suiteRunOf(ev *suiteEvents, c *docker.ContainerResult) *suiteRun {
	run := &suiteRun{
		Selected: in.Selection == nil || in.Selection.Selected(runtimeWarningsID),
		Events:   ev, Runner: in.runnerName(),
	}
	if c != nil {
		run.Stderr, run.Hung = string(c.Stderr), c.StoppedAfterGrace
	}
	return run
}

// maxWarningFindings caps the distinct warnings one suite turns into Findings.
// The rest is counted and reported as a Limitation.
const maxWarningFindings = 100

// warningFlags are what the Check adds to NODE_OPTIONS, after any value from
// the test command. They only make Node say more: where a warning came from
// and which deprecations are coming.
const warningFlags = "--trace-warnings --trace-deprecation --pending-deprecation"

// nodeWarning is the first line of a warning that Node printed to stderr:
// "(node:7) [DEP0005] DeprecationWarning: message". The code is absent for
// warnings that have none.
var nodeWarning = regexp.MustCompile(`^\(node:\d+\) (?:\[([A-Za-z0-9_]+)\] )?([A-Za-z]*Warning): (.*)$`)

// stackLine is one "    at ..." line of a trace.
var stackLine = regexp.MustCompile(`^\s+at (.*)$`)

// framePath finds the file of a frame: the text in parentheses, or the whole
// text of a frame without a function name, minus its line and column.
var framePath = regexp.MustCompile(`^(?:.*\()?(.*?):\d+(?::\d+)?\)?$`)

// maxStackLines is how many frames of a trace the Evidence keeps.
const maxStackLines = 30

// rawWarning is a warning as it stands in stderr, before it becomes a Finding.
type rawWarning struct {
	Code, Name, Message string
	Stack               []string // the "at" lines, in order
	Count               int
}

// parseNodeWarnings reads the warnings Node printed, with their stack traces.
// A trace is the run of "at" lines right below the warning line; the hint line
// that Node prints without --trace-warnings ends it. The same warning at the
// same place is one entry with a count. Nothing but Node's own warning lines
// is read, so the project's test output does not get in.
func parseNodeWarnings(stderr string) []*rawWarning {
	var out []*rawWarning
	byKey := map[string]*rawWarning{}
	lines := strings.Split(stderr, "\n")
	for i := 0; i < len(lines); i++ {
		m := nodeWarning.FindStringSubmatch(strings.TrimRight(lines[i], "\r"))
		if m == nil {
			continue
		}
		w := &rawWarning{Code: m[1], Name: m[2], Message: strings.TrimSpace(m[3]), Count: 1}
		for ; i+1 < len(lines); i++ {
			s := stackLine.FindStringSubmatch(strings.TrimRight(lines[i+1], "\r"))
			if s == nil {
				break
			}
			w.Stack = append(w.Stack, s[1])
		}
		key := strings.Join([]string{w.Name, w.Code, w.Message, topFrameFile(w.Stack)}, "\x00")
		if seen := byKey[key]; seen != nil {
			seen.Count++
			continue
		}
		byKey[key] = w
		out = append(out, w)
	}
	return out
}

// frameFile is the file a frame points into, or "" for a frame that is not a
// file, such as "new Promise (<anonymous>)".
func frameFile(frame string) string {
	m := framePath.FindStringSubmatch(strings.TrimSpace(frame))
	if m == nil {
		return ""
	}
	return strings.TrimPrefix(m[1], "file://")
}

// isNodeInternal says whether a file belongs to Node itself.
func isNodeInternal(file string) bool {
	return strings.HasPrefix(file, "node:") || strings.HasPrefix(file, "internal/")
}

// topFrameFile is the file of the first frame that is not Node's own, or "".
func topFrameFile(stack []string) string {
	for _, f := range stack {
		if file := frameFile(f); file != "" && !isNodeInternal(file) {
			return file
		}
	}
	return ""
}

// dependencyOf names the package a path inside node_modules belongs to, or "".
func dependencyOf(file string) string {
	const marker = "/node_modules/"
	i := strings.LastIndex("/"+file, marker)
	if i < 0 {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(("/" + file)[i+len(marker):], "/"), "/")
	if strings.HasPrefix(parts[0], "@") && len(parts) > 1 {
		return parts[0] + "/" + parts[1]
	}
	return parts[0]
}

// warningFindings turns the warnings in the stderr of a test run into
// Findings, and says how many distinct warnings were left out because of the
// cap. A warning is from a dependency when the top frame that is not Node's
// own lies in node_modules, and from the project otherwise. None is a Gate.
func (in *Input) warningFindings(stderr string) (findings []resultset.Finding, cut int) {
	for _, w := range parseNodeWarnings(stderr) {
		if len(findings) >= maxWarningFindings {
			cut++
			continue
		}
		findings = append(findings, in.warningFinding(w))
	}
	return findings, cut
}

func (in *Input) warningFinding(w *rawWarning) resultset.Finding {
	top := topFrameFile(w.Stack)
	dep := dependencyOf(top)
	rule, severity, origin := "warning-from-project", resultset.SeverityWarning, "the project's own code"
	if dep != "" {
		rule, severity, origin = "warning-from-dependency", resultset.SeverityNote, "the dependency "+dep
	}
	kind := w.Name
	if w.Code != "" {
		kind += " " + w.Code
	}

	head := in.manifestPath()
	at := frame{Path: head}
	if frames := in.projectFrames(strings.Join(w.Stack, "\n")); len(frames) > 0 {
		at = frames[0]
	}

	message := fmt.Sprintf("Node printed the %s while the tests ran, and it comes from %s: %s", kind, origin, oneLine(w.Message, 400))
	if at.Path != head {
		message += fmt.Sprintf(" The first frame in the project is %s.", at.Path)
	}
	if w.Count > 1 {
		message += fmt.Sprintf(" It was printed %d times.", w.Count)
	}

	stack := w.Stack
	if len(stack) > maxStackLines {
		stack = stack[:maxStackLines]
	}
	text := w.Name + ": " + w.Message
	if len(stack) > 0 {
		text += "\n    at " + strings.Join(stack, "\n    at ")
	}
	return resultset.Finding{
		CheckID: runtimeWarningsID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(runtimeWarningsID, rule, at.Path, kind+" "+w.Message+" "+dep),
		Kind:        resultset.KindDefect, Severity: severity, Confidence: resultset.ConfidenceConfirmed,
		Title:        shorten(kind+": "+oneLine(w.Message, 140), 200),
		Message:      message,
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Evidence:     []resultset.Evidence{Untrusted("stack_trace", relativeStack(text), in.runnerName())},
		Reproduction: in.Reproduction(runtimeWarningsID),
		Limitations:  []string{},
	}
}

// --- resources left open ---

// resourceKinds explains the resource types process.getActiveResourcesInfo()
// returns, for the ones a test suite usually leaves open.
var resourceKinds = map[string]string{
	"TCPServerWrap": "a listening TCP server (net.Server, such as an HTTP server)",
	"TCPSocketWrap": "an open TCP socket or client connection",
	"Timeout":       "a pending timer (setTimeout or setInterval)",
	"Immediate":     "a pending setImmediate callback",
	"ProcessWrap":   "a running child process",
	"FSWatcher":     "a file watcher",
	"FSEvent":       "a file watcher",
	"UDPWrap":       "an open UDP socket",
	"PipeWrap":      "an open pipe or Unix socket",
	"TTYWrap":       "an open terminal stream",
}

// safeResourceName is what a resource type from the reporter must look like.
// The names come from the project's process, so anything else is left out.
var safeResourceName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,39}$`)

// describeResources turns the list of open resources into counted names, in
// the order they first appear, and says what the usual ones are.
func describeResources(resources []string) (counted, explained string) {
	order := []string{}
	counts := map[string]int{}
	for _, r := range resources {
		if !safeResourceName.MatchString(r) {
			continue
		}
		if counts[r] == 0 {
			order = append(order, r)
		}
		counts[r]++
	}
	var names, notes []string
	for i, r := range order {
		if i >= 20 {
			break
		}
		if counts[r] > 1 {
			names = append(names, fmt.Sprintf("%d x %s", counts[r], r))
		} else {
			names = append(names, r)
		}
		if what := resourceKinds[r]; what != "" {
			notes = append(notes, r+" is "+what)
		}
	}
	return strings.Join(names, ", "), strings.Join(notes, "; ")
}

// suiteHealthFindings are the Findings about how the test process ended. A
// process that stayed alive after the tests finished is one Finding that lists
// the open resources; otherwise open resources are one Finding of their own.
// A run that reported no list, such as a node:test run, has no resource
// Finding.
func (in *Input) suiteHealthFindings(ev *suiteEvents, hung bool) []resultset.Finding {
	counted, explained := "", ""
	if ev.ResourcesKnown {
		counted, explained = describeResources(ev.Resources)
	}
	manifest := in.manifestPath()
	runner := in.runnerName()
	fingerprintText := counted

	var rule, title, message string
	switch {
	case hung:
		rule, title = "process-did-not-exit", "process did not exit after tests finished"
		message = fmt.Sprintf("The test process was still running 30 seconds after the %s reporter wrote its end event, so the tool stopped the container. Every result was recorded, so the test counts are complete. A suite that keeps its process alive makes the project's own CI run hang unless it forces an exit.", runner)
		switch {
		case !ev.ResourcesKnown:
			message += " This runner does not list the resources that were open."
		case counted == "":
			message += " Node does not list any resource that keeps it running, so the cause may be a child process or a native module."
		default:
			message += " Open at the end: " + counted + "."
		}
		fingerprintText = "hung"
	case counted != "":
		rule, title = "open-resources", "Resources are still open after the tests"
		message = "When the test run ended, these resources were still open: " + counted + ". A forced exit (Mocha's `exit`) hides them, and they keep the process alive without it."
	default:
		return nil
	}
	if explained != "" {
		message += " " + explained + "."
	}
	return []resultset.Finding{{
		CheckID: runtimeWarningsID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(runtimeWarningsID, rule, manifest, fingerprintText),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning, Confidence: resultset.ConfidenceConfirmed,
		Title: title, Message: message,
		Locations:    []resultset.Location{in.Location("primary", manifest, 0, 0)},
		Reproduction: in.Reproduction(runtimeWarningsID),
		Limitations:  []string{},
	}}
}
