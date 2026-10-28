package checks

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const testsExistingID = "tests.existing"

// SuiteTestCase is a test case of a suite execution. Findings are positions in
// the Result's Findings, because Finding IDs only exist once the engine has
// assigned them; the engine turns them into the test case's finding_ids.
type SuiteTestCase struct {
	resultset.TestCase
	Findings []int
}

// suiteResults is what the events of one suite turn into: the test cases, the
// Findings and the package's counts for the Inventory.
type suiteResults struct {
	Findings  []resultset.Finding
	TestCases []SuiteTestCase
	Inventory resultset.PackageTests
	// Files counts the tests of each test file, for the Benchmark's pass rate.
	Files []resultset.TestFileCount
}

// suiteResults turns the events of a finished or interrupted suite into test
// cases, Findings and counts. native is the start of the project's own command
// for re-running one test: the runner, with the project's options but without
// its test files.
//
// A failed test is a Gate Finding. A failed hook is one Gate Finding however
// many tests it affects, and those tests are never_run with the hook as the
// reason, not failures. A test that has no result is never_run: because of a
// hook, because a .only excluded it, or because the run stopped.
func (in *Input) suiteResults(ev *suiteEvents, native []string) *suiteResults {
	r := &suiteResults{Inventory: resultset.PackageTests{ContextID: in.Context.ID}}

	hookIndex := map[string]int{}
	hookOf := make([]int, len(ev.Hooks)) // hook failure -> index of its Finding
	for i, h := range ev.Hooks {
		key := strings.Join([]string{h.File, h.Scope, h.Type, h.Err.text()}, "\x00")
		idx, seen := hookIndex[key]
		if !seen {
			idx = len(r.Findings)
			hookIndex[key] = idx
			r.Findings = append(r.Findings, in.hookFinding(h, native))
		}
		hookOf[i] = idx
	}

	for _, f := range ev.Files {
		r.Findings = append(r.Findings, in.fileFailureFinding(f, ev.testsOf(f.File) > 0))
	}

	files := fileCounts{}
	anyFocused := false
	for _, t := range ev.Tests {
		anyFocused = anyFocused || t.Focused
	}
	for _, t := range ev.Tests {
		if t.Outcome == "" {
			in.explainNeverRun(t, ev, hookOf, anyFocused)
		}
		tc := SuiteTestCase{TestCase: resultset.TestCase{
			File: in.testFile(t.File), FullTitle: t.FullTitle, SuitePath: nonNilStrings(t.SuitePath),
			Outcome: t.Outcome, Attempts: []resultset.TestAttempt{}, FindingIDs: []string{},
		}}
		switch t.Outcome {
		case "":
			tc.Outcome = resultset.TestNeverRun
			reason := t.NeverRunReason
			tc.NeverRunReason = &reason
			if t.HookFinding >= 0 {
				tc.Findings = []int{t.HookFinding}
			}
		default:
			tc.Attempts = append(append(tc.Attempts, t.Attempts...), resultset.TestAttempt{
				Outcome: t.Outcome, DurationMS: t.DurationMS, Error: errorText(t.Err),
			})
			tc.Flaky = t.Outcome == resultset.TestPassed && len(t.Attempts) > 0
		}
		if t.Outcome == resultset.TestFailed {
			tc.Findings = []int{len(r.Findings)}
			r.Findings = append(r.Findings, in.testFinding(t, native))
		}
		r.TestCases = append(r.TestCases, tc)
		r.count(t, tc.Outcome)
		files.add(tc.File, t, tc.Outcome)
	}
	r.Files = files.sorted(in.Context.ID)
	return r
}

// fileCounts counts the tests of each test file, for the Benchmark's pass rate.
type fileCounts map[string]*resultset.TestFileCount

func (fc fileCounts) add(file string, t *testRecord, outcome resultset.TestOutcome) {
	c := fc[file]
	if c == nil {
		c = &resultset.TestFileCount{File: file}
		fc[file] = c
	}
	c.Found++
	if outcome == resultset.TestPassed {
		c.Passed++
		if t.Focused {
			c.PassedFocused++
		}
	}
}

func (fc fileCounts) sorted(contextID string) []resultset.TestFileCount {
	out := make([]resultset.TestFileCount, 0, len(fc))
	for _, c := range fc {
		c.ContextID = contextID
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].File < out[j].File })
	return out
}

func (r *suiteResults) count(t *testRecord, outcome resultset.TestOutcome) {
	inv := &r.Inventory
	inv.Found++
	if t.Focused {
		inv.Focused++
	}
	switch outcome {
	case resultset.TestPassed:
		inv.Run++
		inv.Passed++
	case resultset.TestFailed:
		inv.Run++
		inv.Failed++
	case resultset.TestSkipped:
		inv.Skipped++
	case resultset.TestTodo:
		inv.Todo++
	default:
		inv.NeverRun++
	}
}

// explainNeverRun sets why a test has no result, and which hook Finding is
// behind it when a hook is.
func (in *Input) explainNeverRun(t *testRecord, ev *suiteEvents, hookOf []int, anyFocused bool) {
	for i, h := range ev.Hooks {
		if isPrefix(h.ScopePath, t.SuitePath) {
			t.HookFinding = hookOf[i]
			t.NeverRunReason = fmt.Sprintf("the hook %s failed in %s: %s", h.Title, quoteScope(h.Scope), oneLine(h.Err.text(), 200))
			return
		}
	}
	for _, f := range ev.Files {
		if f.File == t.File {
			t.NeverRunReason = fmt.Sprintf("the process of its test file %s stopped before the test finished", in.testFile(f.File))
			return
		}
	}
	switch {
	case anyFocused && !t.Focused:
		t.NeverRunReason = "a test marked .only elsewhere excluded it"
	case ev.Ended:
		t.NeverRunReason = "the run finished without running it, for example because the runner's own filter such as --grep excluded it"
	default:
		t.NeverRunReason = "the test process stopped before this test started"
	}
}

func quoteScope(scope string) string {
	if scope == "" {
		return "the root scope"
	}
	return `"` + scope + `"`
}

func isPrefix(prefix, of []string) bool {
	if len(prefix) > len(of) {
		return false
	}
	for i := range prefix {
		if prefix[i] != of[i] {
			return false
		}
	}
	return true
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// oneLine puts text on one line, with runs of white space collapsed, cut to
// n bytes.
func oneLine(s string, n int) string { return shorten(strings.Join(strings.Fields(s), " "), n) }

// --- paths ---

// projectRel turns a path inside the container into a path relative to the
// project root, for a file of the Working copy.
func projectRel(containerPath string) (string, bool) {
	rest, ok := strings.CutPrefix(path.Clean(containerPath), workMount+"/")
	return rest, ok && rest != ""
}

// testFile is the project path of a test file the runner reported. A path
// outside the Working copy is kept as it is.
func (in *Input) testFile(containerPath string) string {
	if rel, ok := projectRel(containerPath); ok {
		return rel
	}
	return containerPath
}

// packageRel is a project path relative to the package folder, which is where
// the project's own commands run.
func (in *Input) packageRel(rel string) string {
	if p := in.Context.Package; p != nil && p.Path != "." {
		return strings.TrimPrefix(rel, p.Path+"/")
	}
	return rel
}

// frame is one position in a stack trace that lies in the project.
type frame struct {
	Path string // project path
	Line int
	Col  int
}

var stackFrame = regexp.MustCompile(`([^\s()'"]+?):(\d+)(?::(\d+))?`)

// scriptExtensions are the file extensions a stack frame's path must have when
// it is relative, so that "at 10:5" or "node:internal/x:1" is not a file.
var scriptExtensions = map[string]bool{
	".js": true, ".cjs": true, ".mjs": true, ".ts": true, ".cts": true, ".mts": true, ".jsx": true, ".tsx": true,
}

// projectFrames lists the frames of a stack trace or error output that lie in
// the project's own files, outside node_modules, in order. Mocha shortens the
// paths in a stack to the folder it runs in, so a frame is either an absolute
// path in the container or relative to the package.
func (in *Input) projectFrames(text string) []frame {
	var out []frame
	for _, m := range stackFrame.FindAllStringSubmatch(text, -1) {
		p := strings.TrimPrefix(m[1], "file://")
		var rel string
		switch {
		case strings.HasPrefix(p, "node:") || strings.Contains(p, "://"):
			continue
		case path.IsAbs(p):
			var ok bool
			if rel, ok = projectRel(p); !ok {
				continue
			}
		case scriptExtensions[path.Ext(p)]:
			rel = path.Clean(path.Join(in.packagePath(), p))
			if rel == ".." || strings.HasPrefix(rel, "../") {
				continue
			}
		default:
			continue
		}
		if strings.HasPrefix(rel, "node_modules/") || strings.Contains(rel, "/node_modules/") {
			continue
		}
		line, _ := strconv.Atoi(m[2])
		col, _ := strconv.Atoi(m[3])
		out = append(out, frame{Path: rel, Line: line, Col: col})
	}
	return out
}

// packagePath is the folder of the package in the project, "." for the root.
func (in *Input) packagePath() string {
	if p := in.Context.Package; p != nil {
		return p.Path
	}
	return "."
}

// locate picks the position of a Finding: the first frame in the given file,
// else the first project frame, else the file itself.
func locate(frames []frame, file string) frame {
	for _, f := range frames {
		if f.Path == file {
			return f
		}
	}
	if len(frames) > 0 {
		return frames[0]
	}
	return frame{Path: file}
}

// relativeStack shows container paths relative to the project, so a stack
// reads the same in every Run.
func relativeStack(text string) string { return strings.ReplaceAll(text, workMount+"/", "") }

// --- Findings ---

func (in *Input) manifestPath() string {
	p := "package.json"
	if pkg := in.Context.Package; pkg != nil && pkg.Path != "." {
		p = pkg.Path + "/package.json"
	}
	return p
}

// knownFile is the file to point at: the reported one when it lies in the
// project, else the package's manifest, which holds the test script.
func (in *Input) knownFile(containerPath string) string {
	if rel, ok := projectRel(containerPath); ok {
		return rel
	}
	return in.manifestPath()
}

func (in *Input) testFinding(t *testRecord, native []string) resultset.Finding {
	rule := "test-failed"
	file := in.knownFile(t.File)
	err := orEmpty(t.Err)
	at := locate(in.projectFrames(err.Stack), file)
	if at.Path != file {
		at = frame{Path: file}
	}
	msg := err.text()
	if msg == "" {
		msg = "the test failed without a message"
	}
	f := resultset.Finding{
		CheckID: testsExistingID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsExistingID, rule, file, t.FullTitle),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title:     "Test fails: " + shorten(t.FullTitle, 200),
		Message:   fmt.Sprintf("The test %q fails: %s", t.FullTitle, shorten(oneLine(msg, 400), 400)),
		Locations: []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Expected:  err.Expected, Actual: err.Actual,
		Reproduction: in.Reproduction(testsExistingID),
		Limitations:  []string{},
	}
	f.Evidence = errorEvidence(err, in.runnerName())
	f.Reproduction.Test = &resultset.TestRepro{
		Runner: in.runnerName(), File: file, FullTitle: t.FullTitle,
		NativeCommand: in.nativeTestCommand(native, file, &t.FullTitle),
	}
	if note := in.missingProgramNote(err.Message); note != "" {
		f.Message += " " + note
	}
	return f
}

var spawnENOENT = regexp.MustCompile(`spawn (\S+) ENOENT`)

// safeProgramName is what the note quotes from the error message. The name
// comes from the project's own test, so anything else is left out.
var safeProgramName = regexp.MustCompile(`^[A-Za-z0-9._+/@-]{1,64}$`)

// missingProgramNote explains a `spawn <program> ENOENT` failure: the program
// is missing from the image the tests ran in. The image is the one the Context
// recorded, so the note says which Node version and variant it was.
func (in *Input) missingProgramNote(message string) string {
	m := spawnENOENT.FindStringSubmatch(message)
	if m == nil {
		return ""
	}
	program := "that the test tries to start"
	if safeProgramName.MatchString(m[1]) {
		program = "`" + m[1] + "` that the test tries to start"
	}
	image := "Node image"
	if n := in.Context.Node; n != nil {
		image = fmt.Sprintf("Node %s %s image", n.Version, n.Variant)
	}
	return fmt.Sprintf("The program %s is missing from the %s the tests run in; the project's own Dockerfile may install it, and this tool does not run that Dockerfile.", program, image)
}

func (in *Input) hookFinding(h hookFailure, native []string) resultset.Finding {
	rule := "hook-failed"
	file := in.knownFile(h.File)
	at := locate(in.projectFrames(h.Err.Stack), file)
	msg := h.Err.text()
	f := resultset.Finding{
		CheckID: testsExistingID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsExistingID, rule, at.Path, h.Type+" "+h.Scope+" "+h.Err.Message),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title: "A test hook fails: " + shorten(h.Title, 200),
		Message: fmt.Sprintf("The hook %s failed in %s: %s. The tests it guards did not run; they are reported as never run, not as failures.",
			h.Title, quoteScope(h.Scope), oneLine(msg, 400)),
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Reproduction: in.Reproduction(testsExistingID),
		Limitations:  []string{},
	}
	f.Evidence = errorEvidence(&h.Err, in.runnerName())
	f.Reproduction.Test = &resultset.TestRepro{
		Runner: in.runnerName(), File: at.Path, FullTitle: h.Title,
		NativeCommand: in.nativeTestCommand(native, at.Path, nil),
	}
	return f
}

// errorEvidence is the error message and stack of a test or hook as Evidence.
func errorEvidence(e *testErr, origin string) []resultset.Evidence {
	var out []resultset.Evidence
	if m := strings.TrimSpace(e.Message); m != "" {
		out = append(out, Untrusted("assertion", relativeStack(m), origin))
	}
	if s := strings.TrimSpace(e.Stack); s != "" {
		out = append(out, Untrusted("stack_trace", relativeStack(s), origin))
	}
	return out
}

// runnerName is the test runner of the package, as the Report names it.
func (in *Input) runnerName() string {
	if s := in.suite(); s != nil && s.Runner != "" {
		return string(s.Runner)
	}
	return string(discovery.RunnerMocha)
}

// fileFailureFinding is the Gate Finding of a test file that failed as a
// whole. When none of its tests reported anything, the file did not load; the
// usual cause is a throw while it loads. Otherwise its process stopped before
// the file was finished.
func (in *Input) fileFailureFinding(f fileFailure, reportedTests bool) resultset.Finding {
	rule, title := "test-file-load-failed", "A test file fails to load"
	what := "The test file %s fails before any of its tests report. The usual cause is that it throws while it loads, such as a syntax error, a missing module or failing top-level code, and its tests are not counted."
	// A process that printed no error did not throw: it was stopped, for
	// example by a call to process.exit().
	if reportedTests || strings.TrimSpace(f.Text) == "" {
		rule, title = "test-run-aborted", "The test process stops before the file is finished"
		what = "The process of the test file %s stopped before the file was finished and printed no error, for example because a test or top-level code called process.exit(). Its tests that had no result are reported as never run."
	}
	file := in.knownFile(f.File)
	at := locate(in.projectFrames(f.Text), file)
	first := firstErrorLine(f.Text)
	if first == "" {
		first = f.Err.text()
	}
	out := resultset.Finding{
		CheckID: testsExistingID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(testsExistingID, rule, file, first),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
		Title:        title + ": " + file,
		Message:      strings.TrimSpace(fmt.Sprintf(what, file) + " " + oneLine(first, 300)),
		Locations:    []resultset.Location{in.Location("primary", at.Path, at.Line, at.Col)},
		Reproduction: in.Reproduction(testsExistingID),
		Limitations:  []string{},
	}
	if text := strings.TrimSpace(f.Text); text != "" {
		out.Evidence = []resultset.Evidence{Untrusted("tool_output", relativeStack(tail(text, 6000)), in.runnerName())}
	}
	return out
}

// nativeTestCommand is the project's own command for running one test or one
// file, as an argument array, run in the package folder. Mocha gets the title
// as --fgrep, node:test as --test-name-pattern with the escaped title between
// ^ and $. A title that looks like an option is passed in the --option=value
// form and a file name that does, with ./ in front, so neither can be read as
// an option.
func (in *Input) nativeTestCommand(base []string, file string, fullTitle *string) []string {
	cmd := append([]string{}, base...)
	if fullTitle != nil {
		switch {
		case in.runnerName() == string(discovery.RunnerNodeTest):
			cmd = append(cmd, "--test-name-pattern=^"+regexp.QuoteMeta(*fullTitle)+"$")
		case strings.HasPrefix(*fullTitle, "-"):
			cmd = append(cmd, "--fgrep="+*fullTitle)
		default:
			cmd = append(cmd, "--fgrep", *fullTitle)
		}
	}
	rel := in.packageRel(file)
	if strings.HasPrefix(rel, "-") {
		rel = "./" + rel
	}
	return append(cmd, rel)
}
