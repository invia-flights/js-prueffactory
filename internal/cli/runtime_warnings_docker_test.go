//go:build docker

package cli_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of runtime.warnings: a project goes in through the entry point,
// the Report comes out. The suite runs once for tests.existing and
// runtime.warnings together.

func ruleIs(f resultset.Finding, rule string) bool { return f.RuleID != nil && *f.RuleID == rule }

func checkLimitation(s *resultset.Set, check, code string) *resultset.Limitation {
	for i, l := range s.Limitations {
		if l.ReasonCode == code && l.CheckID != nil && *l.CheckID == check {
			return &s.Limitations[i]
		}
	}
	return nil
}

func TestANewBufferInTheSourceIsAProjectWarningFromTheSameRunAsTheTests(t *testing.T) {
	original := copyProject(t, "deprecations")

	r := realRun(t, context.Background(), "test", original, "--only", "runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0 (no Gates)\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "runtime.warnings")
	if !e.Selected || e.Status != resultset.StatusCompleted {
		t.Errorf("runtime.warnings = %+v", e)
	}
	fs := findingsOf(&r.set, "runtime.warnings")
	if len(fs) != 1 || !ruleIs(fs[0], "warning-from-project") || fs[0].Gate {
		t.Fatalf("findings = %+v", fs)
	}
	if !strings.Contains(fs[0].Title, "DEP0005") || !strings.Contains(fs[0].Message, "Buffer()") {
		t.Errorf("finding = %+v", fs[0])
	}
	if loc := fs[0].Locations[0]; loc.Path != "src/index.js" || loc.Start == nil || loc.Start.Line != 6 {
		t.Errorf("location = %+v, want src/index.js:6", loc)
	}
	// The tests ran inside runtime.warnings' own run: tests.existing is not
	// selected, so it does not appear with Findings, and the suite ran once.
	if tests := oneExecution(t, &r.set, "tests.existing"); tests.Selected {
		t.Errorf("tests.existing = %+v, want it deselected", tests)
	}
	if l := checkLimitation(&r.set, "runtime.warnings", "test_command_override"); l == nil || !strings.Contains(l.Message, "--trace-deprecation") {
		t.Errorf("limitations = %+v, want the NODE_OPTIONS override listed", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}

func TestWithBothChecksSelectedTheSuiteRunsOnceAndEachReportsItsOwn(t *testing.T) {
	original := copyProject(t, "deprecations")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	tests, warnings := oneExecution(t, &r.set, "tests.existing"), oneExecution(t, &r.set, "runtime.warnings")
	if tests.Status != resultset.StatusCompleted || warnings.Status != resultset.StatusCompleted {
		t.Errorf("statuses = %s, %s", tests.Status, warnings.Status)
	}
	if got := len(findingsOf(&r.set, "tests.existing")); got != 0 {
		t.Errorf("tests.existing has %d Findings, want none", got)
	}
	if got := len(findingsOf(&r.set, "runtime.warnings")); got != 1 {
		t.Errorf("runtime.warnings has %d Findings, want one", got)
	}
	if got := strings.Count(r.stderr, "running tests.existing") + strings.Count(r.stderr, "running runtime.warnings"); got != 2 {
		t.Errorf("both executions are logged, got %d", got)
	}
	// One container ran the tests: the suite's own artifact belongs to
	// tests.existing, and the passed test is counted once.
	if r.set.Summary.TestCases.Passed != 1 {
		t.Errorf("summary = %+v", r.set.Summary.TestCases)
	}
	r.assertNothingLeft(t)
}

func TestAMochaSuiteWithoutExitThatLeavesAServerOpenIsStoppedAfterTheGracePeriod(t *testing.T) {
	original := copyProject(t, "open-handles")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: the hang is no Gate\nstderr:\n%s", r.code, r.stderr)
	}
	tests := oneExecution(t, &r.set, "tests.existing")
	if tests.Status != resultset.StatusCompleted || tests.Outcome != resultset.OutcomePassed {
		t.Errorf("tests.existing = %+v, want completed and passed: every result was recorded", tests)
	}
	if tests.DurationMS == nil || *tests.DurationMS < 30_000 {
		t.Errorf("the suite took %v ms, it should have waited the 30 second grace period", tests.DurationMS)
	}
	if tests.Tool == nil || tests.Tool.ExitCode == nil || *tests.Tool.ExitCode == 0 {
		t.Errorf("tool = %+v, want the exit code of a stopped container", tests.Tool)
	}
	warnings := oneExecution(t, &r.set, "runtime.warnings")
	if warnings.Status != resultset.StatusCompleted {
		t.Errorf("runtime.warnings = %+v", warnings)
	}
	fs := findingsOf(&r.set, "runtime.warnings")
	if len(fs) != 1 || !ruleIs(fs[0], "process-did-not-exit") || fs[0].Title != "process did not exit after tests finished" {
		t.Fatalf("findings = %+v", fs)
	}
	if !strings.Contains(fs[0].Message, "TCPServerWrap") {
		t.Errorf("message %q does not list the open server", fs[0].Message)
	}
	if got := len(findingsOf(&r.set, "tests.existing")); got != 0 {
		t.Errorf("tests.existing has %d Findings, want none", got)
	}
	// The container's output has no trace of the marker.
	if log := artifactOf(&r.set, tests, "test-output.log"); log == nil {
		t.Error("no test output artifact")
	} else if text := string(mustRead(t, filepath.Join(r.reportDir, log.Path))); strings.Contains(text, "jspf-end") {
		t.Errorf("the end marker is in the test output:\n%s", text)
	}
	r.assertNothingLeft(t)
}

func TestAHungSuiteWithoutRuntimeWarningsSelectedIsStoppedAndSaysSoInALimitation(t *testing.T) {
	original := copyProject(t, "open-handles")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "tests.existing"); e.Status != resultset.StatusCompleted {
		t.Errorf("tests.existing = %+v", e)
	}
	if l := checkLimitation(&r.set, "tests.existing", "process_stopped_after_grace"); l == nil {
		t.Errorf("limitations = %+v", r.set.Limitations)
	}
	if got := len(findingsOf(&r.set, "runtime.warnings")); got != 0 {
		t.Errorf("runtime.warnings is not selected but has %d Findings", got)
	}
	r.assertNothingLeft(t)
}

func TestAServerLeftOpenUnderMochasExitIsOneOpenResourcesFindingAndNoStop(t *testing.T) {
	original := copyProject(t, "open-handles")
	writeFiles(t, original, map[string]string{".mocharc.json": `{"exit": true}` + "\n"})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	tests := oneExecution(t, &r.set, "tests.existing")
	if tests.DurationMS != nil && *tests.DurationMS >= 30_000 {
		t.Errorf("the forced exit ended the process, but the suite took %d ms", *tests.DurationMS)
	}
	fs := findingsOf(&r.set, "runtime.warnings")
	if len(fs) != 1 || !ruleIs(fs[0], "open-resources") || !strings.Contains(fs[0].Message, "TCPServerWrap") {
		t.Fatalf("findings = %+v", fs)
	}
	if strings.Contains(fs[0].Message, "PipeWrap") {
		t.Errorf("message %q lists the streams of stdout and stderr, which are not the project's", fs[0].Message)
	}
	r.assertNothingLeft(t)
}

func TestACleanSuiteHasNoRuntimeWarnings(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if fs := findingsOf(&r.set, "runtime.warnings"); len(fs) != 0 {
		t.Errorf("findings = %+v, want none: a forced exit with nothing open leaves nothing to report", fs)
	}
	r.assertNothingLeft(t)
}

func TestANodeTestSuiteReportsWarningsButNotOpenResourcesAndSaysSo(t *testing.T) {
	original := copyProject(t, "node-test")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,runtime.warnings")

	// The project has one failing test, so tests.existing fires a Gate: that
	// does not keep runtime.warnings from reading the same run.
	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "runtime.warnings"); e.Status != resultset.StatusCompleted {
		t.Errorf("runtime.warnings = %+v", e)
	}
	if l := checkLimitation(&r.set, "runtime.warnings", "open_resources_not_collected"); l == nil {
		t.Errorf("limitations = %+v", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}

// dependencyTarball is an npm package that calls the deprecated new Buffer().
func dependencyTarball(t *testing.T) []byte {
	t.Helper()
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	for name, content := range map[string]string{
		"package/package.json": `{"name":"old-buffer","version":"1.0.0","main":"index.js"}`,
		"package/index.js":     "'use strict';\nmodule.exports = (n) => new Buffer(n);\n",
	} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return raw.Bytes()
}

func TestAWarningFromCodeInNodeModulesIsADependencyWarning(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	// No lockfile, so the install resolves the tarball too.
	_ = os.Remove(filepath.Join(original, "package-lock.json"))
	writeFiles(t, original, map[string]string{
		"package.json":     `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"dependencies":{"old-buffer":"file:./old-buffer.tgz"},"devDependencies":{"mocha":"^10.8.2"}}` + "\n",
		"test/old.test.js": "'use strict';\n\nconst oldBuffer = require('old-buffer');\n\ndescribe('old', () => {\n  it('allocates', () => {\n    oldBuffer(4);\n  });\n});\n",
	})
	if err := os.WriteFile(filepath.Join(original, "old-buffer.tgz"), dependencyTarball(t), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	fs := findingsOf(&r.set, "runtime.warnings")
	if len(fs) != 1 || !ruleIs(fs[0], "warning-from-dependency") || !strings.Contains(fs[0].Message, "old-buffer") {
		t.Fatalf("findings = %+v", fs)
	}
	if fs[0].Severity != resultset.SeverityNote || fs[0].Gate {
		t.Errorf("finding = %+v", fs[0])
	}
	r.assertNothingLeft(t)
}

func TestRuntimeWarningsAloneStartsTheServicesOfTheSuiteItRuns(t *testing.T) {
	original := copyProject(t, "valkey-service")

	r := realRun(t, context.Background(), "test", original, "--only", "runtime.warnings")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if sv := serviceNamed(t, &r.set, "redis"); sv.Status != resultset.ServiceStarted {
		t.Errorf("service = %+v, want it started for the suite that runtime.warnings runs", sv)
	}
	r.assertNothingLeft(t)
}
