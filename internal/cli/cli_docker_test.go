//go:build docker

package cli_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/cli"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

// These tests are seam A with a real Docker daemon: they call the in-process
// entry point and look at what a user or agent can see. Run them with
//
//	go test -tags docker ./...
//
// With the tag, an unreachable daemon fails them loudly.

// copyProject copies a testdata project into a new folder, so the Original of a
// test is a throwaway copy and the checked-in files stay untouched.
func copyProject(t *testing.T, name string) string {
	t.Helper()
	src := filepath.Join("..", "..", "testdata", "projects", name)
	dst := filepath.Join(t.TempDir(), name)
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

// treeFingerprint hashes every file below dir by path, mode and content. It is
// written independently of the tool's own Snapshot hash.
func treeFingerprint(t *testing.T, dir string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		line := rel + "|" + info.Mode().String()
		if info.Mode().IsRegular() {
			data, _ := os.ReadFile(p)
			sum := sha256.Sum256(data)
			line += "|" + hex.EncodeToString(sum[:]) + "|" + info.ModTime().String()
		}
		lines = append(lines, line)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:])
}

// dockerLines runs the docker CLI and returns its non-empty output lines.
func dockerLines(t *testing.T, args ...string) []string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	var lines []string
	for _, l := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	return lines
}

// assertNoRunResources fails when a container, network or volume of the Run is
// left, found by its label and by its name prefix.
func assertNoRunResources(t *testing.T, runID string) {
	t.Helper()
	label := "label=js-prueffactory.run-id=" + runID
	name := "name=jspf-" + runID + "-"
	for _, kind := range [][]string{
		{"ps", "-a", "--format", "{{.Names}}"},
		{"network", "ls", "--format", "{{.Name}}"},
		{"volume", "ls", "--format", "{{.Name}}"},
	} {
		for _, filter := range []string{label, name} {
			args := append(append([]string{}, kind[:len(kind)-2]...), "--filter", filter, kind[len(kind)-2], kind[len(kind)-1])
			if left := dockerLines(t, args...); len(left) > 0 {
				t.Errorf("docker %s left %v", kind[0], left)
			}
		}
	}
}

// forceRemoveRun is a safety net so a failing test never leaves Docker resources.
func forceRemoveRun(runID string) {
	for _, args := range [][]string{
		{"ps", "-aq", "--filter", "label=js-prueffactory.run-id=" + runID},
	} {
		out, _ := exec.Command("docker", args...).Output()
		if ids := strings.Fields(string(out)); len(ids) > 0 {
			_ = exec.Command("docker", append([]string{"rm", "-f", "-v"}, ids...)...).Run()
		}
	}
	for _, kind := range []string{"network", "volume"} {
		out, _ := exec.Command("docker", kind, "ls", "-q", "--filter", "label=js-prueffactory.run-id="+runID).Output()
		if ids := strings.Fields(string(out)); len(ids) > 0 {
			_ = exec.Command("docker", append([]string{kind, "rm"}, ids...)...).Run()
		}
	}
}

// dockerRun is the result of one Run through the entry point.
type dockerRun struct {
	result
	tmp       string
	reportDir string
	report    map[string]any
	set       resultset.Set
	runID     string
}

// realRun calls the entry point against the real Docker daemon.
func realRun(t *testing.T, ctx context.Context, args ...string) *dockerRun {
	t.Helper()
	return realRunHooked(t, ctx, nil, args...)
}

// lineHook is an io.Writer that calls fn for every complete line written to it,
// before the Run continues. Tests use it to act at a known point of a Run.
type lineHook struct {
	buf  bytes.Buffer
	rest []byte
	fn   func(line string)
}

func (h *lineHook) Write(p []byte) (int, error) {
	h.buf.Write(p)
	h.rest = append(h.rest, p...)
	for {
		i := bytes.IndexByte(h.rest, '\n')
		if i < 0 {
			return len(p), nil
		}
		line := string(h.rest[:i])
		h.rest = h.rest[i+1:]
		if h.fn != nil {
			h.fn(line)
		}
	}
}

// realRunHooked is realRun with a hook on the lines the Run writes to stderr.
func realRunHooked(t *testing.T, ctx context.Context, onStderrLine func(line string), args ...string) *dockerRun {
	t.Helper()
	tmp := t.TempDir()
	env := map[string]string{
		"PATH": os.Getenv("PATH"), "HOME": os.Getenv("HOME"), "TMPDIR": tmp,
		"XDG_STATE_HOME": t.TempDir(),
		"DOCKER_HOST":    os.Getenv("DOCKER_HOST"), "DOCKER_CONTEXT": os.Getenv("DOCKER_CONTEXT"),
		"DOCKER_CONFIG": os.Getenv("DOCKER_CONFIG"),
	}
	var out bytes.Buffer
	errb := &lineHook{fn: onStderrLine}
	code := cli.Main(ctx, args, func(k string) string { return env[k] }, &out, errb)
	r := &dockerRun{result: result{code, out.String(), errb.buf.String()}, tmp: tmp}

	lines := strings.Split(strings.TrimRight(r.stdout, "\n"), "\n")
	if len(lines) == 1 && lines[0] != "" {
		r.reportDir = lines[0]
		r.runID = filepath.Base(r.reportDir)
		if strings.Contains(r.runID, "T") {
			t.Cleanup(func() { forceRemoveRun(r.runID) })
		}
		if data, err := os.ReadFile(filepath.Join(r.reportDir, "report.json")); err == nil {
			if problems := schema.Validate(data); len(problems) != 0 {
				t.Fatalf("report.json does not match its schema:\n%s", strings.Join(problems, "\n"))
			}
			_ = json.Unmarshal(data, &r.report)
			if err := json.Unmarshal(data, &r.set); err != nil {
				t.Fatal(err)
			}
			if problems := r.set.Validate(); len(problems) != 0 {
				t.Fatalf("report.json is inconsistent: %v", problems)
			}
			assertNamesNoMilestone(t, "report.json", string(data))
		}
		if md, err := os.ReadFile(filepath.Join(r.reportDir, "report.md")); err == nil {
			assertNamesNoMilestone(t, "report.md", string(md))
		}
	}
	return r
}

var progressLine = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \S`)

func (r *dockerRun) assertPlainProgress(t *testing.T) {
	t.Helper()
	if strings.ContainsRune(r.stderr, '\x1b') {
		t.Error("stderr contains ANSI escape codes")
	}
	for _, line := range strings.Split(strings.TrimRight(r.stderr, "\n"), "\n") {
		if !progressLine.MatchString(line) {
			t.Errorf("stderr line is not a plain timestamped line: %q", line)
		}
	}
}

func (r *dockerRun) assertNothingLeft(t *testing.T) {
	t.Helper()
	assertNoRunResources(t, r.set.Run.ID)
	if entries, _ := os.ReadDir(r.tmp); len(entries) != 0 {
		t.Errorf("the host-side Snapshot copy was not removed: %v", entries)
	}
}

func findingsOf(s *resultset.Set, check string) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range s.Findings {
		if f.CheckID == check {
			out = append(out, f)
		}
	}
	return out
}

func TestCleanMochaExitsZeroLeavesTheOriginalAloneAndCleansUp(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	// The report folder is the only line on stdout.
	if strings.Count(r.stdout, "\n") != 1 || !filepath.IsAbs(r.reportDir) {
		t.Fatalf("stdout = %q, want one absolute path", r.stdout)
	}
	for _, f := range []string{"report.json", "report.md", "report.schema.json"} {
		if _, err := os.Stat(filepath.Join(r.reportDir, f)); err != nil {
			t.Errorf("%s missing: %v", f, err)
		}
	}
	r.assertPlainProgress(t)

	// The Original is byte-for-byte unchanged, by the tool's account and by ours.
	if !r.set.Source.OriginalUnchanged || len(r.set.Source.ChangedPaths) != 0 {
		t.Errorf("source = %+v", r.set.Source)
	}
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	if r.set.Source.SnapshotAlgorithm != "sorted-path-sha256-v1" || r.set.Source.FileCount != 6 {
		t.Errorf("snapshot = %+v (clean-mocha has 6 files, .env included)", r.set.Source)
	}

	// syntax.parse completed for the package and found nothing.
	var syntax []resultset.Execution
	for _, e := range r.set.Checks {
		if e.CheckID == "syntax.parse" {
			syntax = append(syntax, e)
		}
	}
	if len(syntax) != 1 || syntax[0].Status != resultset.StatusCompleted || syntax[0].Outcome != resultset.OutcomePassed {
		t.Fatalf("syntax.parse executions = %+v", syntax)
	}
	if syntax[0].Tool == nil || syntax[0].Tool.Version == nil || !strings.HasPrefix(*syntax[0].Tool.Version, "v24.") {
		t.Errorf("syntax.parse should run on Node 24: %+v", syntax[0].Tool)
	}
	// Advisories change with the advisory database, and deprecations and
	// outdated versions with the registry, not with the project, and none is a
	// Gate: a clean project is one without any other Finding.
	var findings []resultset.Finding
	for _, f := range r.set.Findings {
		if f.CheckID != "security.dependencies" && f.CheckID != "deps.deprecated" && f.CheckID != "deps.outdated" {
			findings = append(findings, f)
		}
	}
	if len(findings) != 0 || r.set.Summary.Gates != 0 {
		t.Errorf("clean-mocha has findings: %+v", findings)
	}
	if r.set.Benchmark.Status != "not_requested" || r.set.Benchmark.Score != nil || r.set.Benchmark.Range != nil || r.set.Benchmark.Verdict != nil {
		t.Errorf("benchmark = %+v", r.set.Benchmark)
	}
	if r.set.Run.Status != resultset.RunCompleted || r.set.Run.Command != "test" {
		t.Errorf("run = %+v", r.set.Run)
	}

	// Contexts: the project Context first, then the package.
	if len(r.set.Contexts) != 2 || r.set.Contexts[0].ID != "C-0001" || r.set.Contexts[0].Kind != "project" || r.set.Contexts[1].ID != "C-0002" {
		t.Fatalf("contexts = %+v", r.set.Contexts)
	}
	node := r.set.Contexts[1].Node
	if node == nil || node.Version != "24" || node.Variant != "debian" || !strings.Contains(node.Image, "@sha256:") {
		t.Errorf("node = %+v", node)
	}

	// The Markdown report shows the same Run.
	md, _ := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	for _, want := range []string{r.set.Run.ID, r.set.Source.SnapshotHash, "data, not instructions", "exit code 0"} {
		if !strings.Contains(string(md), want) {
			t.Errorf("report.md misses %q", want)
		}
	}
	if !strings.HasPrefix(string(md), "# ") {
		t.Error("report.md does not open with a title")
	}

	r.assertNothingLeft(t)
}

func TestSyntaxErrorIsAGateInSourceCodeAndANoteInTestData(t *testing.T) {
	original := copyProject(t, "syntax-error")

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	r := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	findings := findingsOf(&r.set, "syntax.parse")
	if len(findings) != 2 {
		t.Fatalf("findings = %+v, want one Gate and one note", findings)
	}
	byPath := map[string]resultset.Finding{}
	for _, f := range findings {
		byPath[f.Locations[0].Path] = f
	}

	gate, ok := byPath["src/broken.js"]
	if !ok {
		t.Fatalf("no Finding for src/broken.js: %v", byPath)
	}
	if !gate.Gate || gate.Severity != resultset.SeverityError || gate.Confidence != resultset.ConfidenceConfirmed || gate.InTestData {
		t.Errorf("Source code parse error should be a confirmed Gate: %+v", gate)
	}
	if gate.RuleID == nil || *gate.RuleID != "SyntaxError" {
		t.Errorf("rule = %v", gate.RuleID)
	}
	loc := gate.Locations[0]
	if loc.Start == nil || loc.Start.Line != 3 || loc.Start.Column == nil || *loc.Start.Column != 16 {
		t.Errorf("location = %+v, want 3:16 (`const answer = ;`)", loc.Start)
	}
	want := sha256.Sum256(mustRead(t, filepath.Join(original, "src", "broken.js")))
	if loc.FileSHA256 != hex.EncodeToString(want[:]) {
		t.Errorf("file SHA-256 = %s, want the hash of src/broken.js", loc.FileSHA256)
	}
	if gate.Fingerprint.Algorithm != "v1" || len(gate.Fingerprint.Value) != 64 {
		t.Errorf("fingerprint = %+v", gate.Fingerprint)
	}
	if len(gate.Evidence) == 0 || gate.Evidence[0].Trust != "untrusted_data" || !strings.Contains(gate.Evidence[0].Text, "SyntaxError") {
		t.Errorf("evidence = %+v", gate.Evidence)
	}
	if len(gate.Reproduction.Rerun) < 3 || gate.Reproduction.Rerun[0] != "js-prueffactory" || gate.Reproduction.Rerun[1] != "test" {
		t.Errorf("re-run command = %v", gate.Reproduction.Rerun)
	}

	note, ok := byPath["test/fixtures/invalid.js"]
	if !ok {
		t.Fatalf("no Finding for the Test data file: %v", byPath)
	}
	if note.Gate || note.Severity != resultset.SeverityNote || !note.InTestData {
		t.Errorf("Test data parse error should be a note: %+v", note)
	}
	if r.set.Summary.Gates != 1 {
		t.Errorf("gates = %d, want 1", r.set.Summary.Gates)
	}

	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	if !strings.Contains(md, "exit code 1") || !strings.Contains(md, gate.ID) || !strings.Contains(md, "src/broken.js") {
		t.Errorf("report.md does not show the Gate:\n%s", md)
	}
	r.assertNothingLeft(t)
}

func TestFormatSelectionWritesOnlyWhatWasAsked(t *testing.T) {
	// The artifacts folder holds files the Report links to, such as the rule
	// list of lint.correctness, in every format.
	for format, want := range map[string][]string{
		"json":     {"artifacts", "report.json", "report.schema.json"},
		"markdown": {"artifacts", "report.md"},
	} {
		original := copyProject(t, "clean-mocha")
		out := filepath.Join(t.TempDir(), "out")
		r := realRun(t, context.Background(), "test", original, "--format", format, "--output-dir", out)
		if r.code != 0 {
			t.Fatalf("%s: exit %d\n%s", format, r.code, r.stderr)
		}
		if strings.TrimSpace(r.stdout) != out {
			t.Errorf("%s: stdout = %q, want %q", format, r.stdout, out)
		}
		entries, _ := os.ReadDir(out)
		var got []string
		for _, e := range entries {
			got = append(got, e.Name())
		}
		sort.Strings(got)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: files = %v, want %v", format, got, want)
		}
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestAChangedOriginalIsReportedWithoutChangingTheExitCode(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	// Change the Original right after the Snapshot was taken, as a concurrent
	// editor would.
	r := realRunHooked(t, context.Background(), func(line string) {
		if strings.Contains(line, "snapshot taken") {
			_ = os.WriteFile(filepath.Join(original, "added.txt"), []byte("new"), 0o644)
			_ = os.WriteFile(filepath.Join(original, "src", "index.js"), []byte("module.exports = {};\n"), 0o644)
		}
	}, "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: a changed Original never changes the exit code\n%s", r.code, r.stderr)
	}
	if r.set.Source.OriginalUnchanged {
		t.Error("original_unchanged is true")
	}
	if got := strings.Join(r.set.Source.ChangedPaths, ","); got != "added.txt,src/index.js" {
		t.Errorf("changed paths = %q", got)
	}
	found := false
	for _, l := range r.set.Limitations {
		found = found || l.ReasonCode == "original_changed"
	}
	if !found {
		t.Errorf("no original_changed Limitation: %+v", r.set.Limitations)
	}
	if !strings.Contains(r.stderr, "warning") || !strings.Contains(r.stderr, "added.txt") {
		t.Errorf("stderr does not warn about the change:\n%s", r.stderr)
	}
	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	if !strings.Contains(md, "added.txt") {
		t.Error("report.md does not list the changed paths")
	}
	r.assertNothingLeft(t)
}

func TestRunOwnedResourcesAreLabelledNamedAndIsolatedWhileTheRunIsInProgress(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	var runID string
	var inspected bool

	r := realRunHooked(t, context.Background(), func(line string) {
		if f := strings.Fields(line); len(f) > 3 && f[1] == "run" && f[3] == "started" {
			runID = f[2]
		}
		if !strings.Contains(line, "running syntax.parse") || inspected {
			return
		}
		inspected = true
		prefix := "jspf-" + runID + "-"
		nets := dockerLines(t, "network", "ls", "--filter", "name="+prefix, "--format", "{{.Name}}")
		vols := dockerLines(t, "volume", "ls", "--filter", "name="+prefix, "--format", "{{.Name}}")
		// The Snapshot volume and the Working copy that package.install writes
		// to are there. Other Checks may have volumes of their own by now.
		if len(nets) != 1 || nets[0] != prefix+"net" {
			t.Errorf("want the one network %snet while the Run is in progress, got %v", prefix, nets)
			return
		}
		for _, want := range []string{prefix + "snapshot", prefix + "work"} {
			if !slices.Contains(vols, want) {
				t.Errorf("volume %s is missing while the Run is in progress, got %v", want, vols)
			}
		}
		internal := dockerLines(t, "network", "inspect", "--format", "{{.Internal}}", nets[0])
		if len(internal) != 1 || internal[0] != "true" {
			t.Errorf("the Execution-phase network must be created with --internal, Internal = %v", internal)
		}
		inspects := [][]string{{"network", "inspect", "--format", "{{json .Labels}}", nets[0]}}
		for _, v := range vols {
			inspects = append(inspects, []string{"volume", "inspect", "--format", "{{json .Labels}}", v})
		}
		for _, res := range inspects {
			var labels map[string]string
			out := strings.Join(dockerLines(t, res...), "")
			if err := json.Unmarshal([]byte(out), &labels); err != nil {
				t.Errorf("%v: %v", res, err)
				continue
			}
			for _, key := range []string{"js-prueffactory.run-id", "js-prueffactory.host", "js-prueffactory.pid", "js-prueffactory.deadline"} {
				if labels[key] == "" {
					t.Errorf("%s %s lacks label %s: %v", res[0], res[len(res)-1], key, labels)
				}
			}
			if labels["js-prueffactory.run-id"] != runID {
				t.Errorf("run-id label = %q, want %q", labels["js-prueffactory.run-id"], runID)
			}
		}
	}, "test", original)

	if !inspected {
		t.Fatal("the hook never ran")
	}
	if r.code != 0 {
		t.Fatalf("exit = %d\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
}

func TestAPackageThatNeedsABuildStepIsUnsupportedAndTheRunIsIncomplete(t *testing.T) {
	original := copyProject(t, "needs-build")

	r := realRun(t, context.Background(), "test", original)

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", r.code, r.stderr)
	}
	var syntax *resultset.Execution
	for i, e := range r.set.Checks {
		if e.CheckID == "syntax.parse" {
			syntax = &r.set.Checks[i]
		}
	}
	if syntax == nil || syntax.Status != resultset.StatusUnsupported || syntax.Outcome != resultset.OutcomeUnknown {
		t.Fatalf("syntax.parse = %+v", syntax)
	}
	if syntax.ReasonCode == nil || *syntax.ReasonCode != "build_step_required" || syntax.Reason == nil || !strings.Contains(*syntax.Reason, ".babelrc") {
		t.Errorf("reason = %v / %v", syntax.ReasonCode, syntax.Reason)
	}
	if r.set.Run.Status != resultset.RunIncomplete {
		t.Errorf("run status = %q", r.set.Run.Status)
	}
	r.assertNothingLeft(t)
}

func TestBuildOutputIsSkippedAndListed(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	if err := os.MkdirAll(filepath.Join(original, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Build output may be anything, including code that does not parse.
	if err := os.WriteFile(filepath.Join(original, "dist", "bundle.js"), []byte("this is not ( javascript"), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: Build output is skipped\n%s", r.code, r.stderr)
	}
	found := false
	for _, l := range r.set.Limitations {
		found = found || (l.ReasonCode == "build_output_skipped" && l.Path != nil && *l.Path == "dist")
	}
	if !found {
		t.Errorf("Build output is not listed: %+v", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}
