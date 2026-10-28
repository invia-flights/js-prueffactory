//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for the toolset volume and quality.clones.

func TestQualitySignalsReportsTheDeliberateCloneAsANoteAndTheSourceDuplicationAsAMetric(t *testing.T) {
	original := copyProject(t, "quality-signals")

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	r := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: clones are notes and never Gates\nstderr:\n%s", r.code, r.stderr)
	}

	var exec *resultset.Execution
	for i := range r.set.Checks {
		if r.set.Checks[i].CheckID == "quality.clones" {
			exec = &r.set.Checks[i]
		}
	}
	if exec == nil || exec.Status != resultset.StatusCompleted || exec.ContextID != "C-0001" {
		t.Fatalf("quality.clones execution = %+v, want completed in the project Context", exec)
	}
	if exec.Outcome == resultset.OutcomeFailed {
		t.Errorf("outcome = %s, a clone must never fail the Check", exec.Outcome)
	}
	if exec.Tool == nil || exec.Tool.Version == nil || *exec.Tool.Version != "5.4.2" {
		t.Errorf("tool = %+v, want jscpd 5.4.2", exec.Tool)
	}

	// One clone, between the two Source code files. The copies in test/fixtures
	// (Test data) and dist (Build output) are never scanned.
	found := findingsOf(&r.set, "quality.clones")
	if len(found) != 1 {
		t.Fatalf("clone findings = %+v, want exactly one", found)
	}
	f := found[0]
	if f.Gate || f.Severity != resultset.SeverityNote {
		t.Errorf("finding = %+v, want a note without a Gate", f)
	}
	var paths []string
	for _, l := range f.Locations {
		paths = append(paths, l.Path)
	}
	if strings.Join(paths, ",") != "src/invoice.js,src/order.js" {
		t.Errorf("locations = %v", paths)
	}
	if r.set.Summary.Gates != 0 {
		t.Errorf("gates = %d", r.set.Summary.Gates)
	}

	// The metric: jscpd counts 13 duplicated lines (src/invoice.js 3-15 and its
	// copy) among the 116 lines jscpd counts in the six Source code files, so
	// 13/116 = 11.21 percent. Files in test/fixtures and dist would change that.
	metrics := map[string]resultset.Metric{}
	for _, m := range r.set.Metrics {
		if m.CheckID == "quality.clones" {
			metrics[m.Name] = m
		}
	}
	src := metrics["duplication_percent_source"]
	if src.Value == nil || *src.Value < 11.20 || *src.Value > 11.22 || src.Unit != "percent" {
		var got float64
		if src.Value != nil {
			got = *src.Value
		}
		t.Errorf("source duplication = %v %s, want 11.21 percent", got, src.Unit)
	}
	if test := metrics["duplication_percent_test"]; test.Value == nil || *test.Value != 0 {
		t.Errorf("test duplication = %+v, want 0: the only test file has no clone", test)
	}

	// The project Context records the tool, and the Report the toolset version.
	var tools []string
	for _, tool := range r.set.Contexts[0].Tools {
		tools = append(tools, tool.Name+"@"+tool.Version)
	}
	if !contains(tools, "jscpd@5.4.2") {
		t.Errorf("project Context tools = %v", tools)
	}
	if r.set.Profiles.ToolsetVersion == "" {
		t.Error("the Report does not record the toolset version")
	}
	r.assertNothingLeft(t)
}

// The title of a clone does not name the File class, so report.md says
// "in Test code" once: through the hint the in_test_code flag adds.
func TestACloneInTestCodeSaysInTestCodeOnceAndASourceCloneNotAtAll(t *testing.T) {
	original := copyProject(t, "quality-signals")
	invoice := mustRead(t, filepath.Join(original, "src", "invoice.js"))
	for _, name := range []string{"copy-a.test.js", "copy-b.test.js"} {
		if err := os.WriteFile(filepath.Join(original, "test", name), invoice, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	r := realRun(t, context.Background(), "test", original, "--only", "quality.clones")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	byRule := map[string]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "quality.clones") {
		if f.RuleID != nil {
			byRule[*f.RuleID] = f
		}
	}
	source, okSource := byRule["clone.source"]
	test, okTest := byRule["clone.test"]
	if !okSource || !okTest {
		t.Fatalf("clone findings by rule = %+v, want one clone.source and one clone.test", byRule)
	}
	if test.Title != "Duplicated code" || !test.InTestCode {
		t.Errorf("clone.test: title %q, in_test_code %v; want \"Duplicated code\" and true", test.Title, test.InTestCode)
	}
	if source.Title != "Duplicated code" || source.InTestCode {
		t.Errorf("clone.source: title %q, in_test_code %v; want \"Duplicated code\" and false", source.Title, source.InTestCode)
	}

	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	lineOf := func(id string) string {
		for _, l := range strings.Split(md, "\n") {
			if strings.HasPrefix(l, "- "+id+" [") {
				return l
			}
		}
		return ""
	}
	if line := lineOf(test.ID); !strings.HasSuffix(line, ": Duplicated code (in Test code)") {
		t.Errorf("report.md line of the clone.test Finding = %q, want it to end with \"Duplicated code (in Test code)\"", line)
	}
	if line := lineOf(source.ID); !strings.HasSuffix(line, ": Duplicated code") {
		t.Errorf("report.md line of the clone.source Finding = %q, want it to end with \"Duplicated code\" and no hint", line)
	}
	if strings.Count(md, "in Test code") != 1 {
		t.Errorf("report.md says \"in Test code\" %d times, want once:\n%s", strings.Count(md, "in Test code"), md)
	}
	r.assertNothingLeft(t)
}

func TestFileNamesThatLookLikeOptionsAreScannedAsFilesNeverPassedAsOptions(t *testing.T) {
	original := copyProject(t, "quality-signals")
	// The names come from the project, which is untrusted. jscpd has options
	// such as -x and --exit-code, and a file called like one must not act as one.
	for _, name := range []string{"-x.js", "--exit-code.js"} {
		p := filepath.Join(original, "src", name)
		if err := os.WriteFile(p, []byte("'use strict';\n\nmodule.exports = { name: '"+name+"' };\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	r := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	for _, e := range r.set.Checks {
		if e.CheckID == "quality.clones" && e.Status != resultset.StatusCompleted {
			t.Fatalf("quality.clones = %s: %v", e.Status, e.Reason)
		}
	}
	if got := len(findingsOf(&r.set, "quality.clones")); got != 1 {
		t.Errorf("clone findings = %d, want the one deliberate clone", got)
	}
}

func TestASecondRunReusesTheToolsetVolumeAndLeavesItBehind(t *testing.T) {
	original := copyProject(t, "quality-signals")

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	first := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")
	second := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")

	for i, r := range []*dockerRun{first, second} {
		if r.code != 0 {
			t.Fatalf("run %d: exit = %d\nstderr:\n%s", i+1, r.code, r.stderr)
		}
		r.assertNothingLeft(t)
	}
	// Whether the first Run installed depends on the host: an earlier Run of the
	// same build may have filled the volume. The second Run never installs.
	if strings.Contains(second.stderr, "installing toolset") || !strings.Contains(second.stderr, "reusing toolset volume") {
		t.Errorf("the second Run should reuse the volume without installing:\n%s", second.stderr)
	}
	if first.set.Profiles.ToolsetVersion != second.set.Profiles.ToolsetVersion {
		t.Error("the toolset version differs between two Runs of one binary")
	}
	// That the volume outlives a Run is tested with Ensure, under a toolset
	// version of its own: here another Run of a different build on the same
	// Docker host may legitimately remove an unused volume of this version.
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
