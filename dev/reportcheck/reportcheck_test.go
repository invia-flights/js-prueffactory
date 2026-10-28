package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

func writeReport(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "run")
	if err := writer.Write(dir, resultsettest.Minimal(), writer.Formats{JSON: true, Markdown: true}); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAWrittenReportIsAccepted(t *testing.T) {
	if problems := Check(writeReport(t)); len(problems) != 0 {
		t.Fatalf("problems: %v", problems)
	}
}

func TestMissingReportFilesAreProblems(t *testing.T) {
	dir := writeReport(t)
	if err := os.Remove(filepath.Join(dir, "report.md")); err != nil {
		t.Fatal(err)
	}
	problems := strings.Join(Check(dir), "\n")
	if !strings.Contains(problems, "report.md") {
		t.Fatalf("problems do not name report.md: %q", problems)
	}
}

func TestAReportThatBreaksTheSchemaIsRejected(t *testing.T) {
	dir := writeReport(t)
	if err := os.WriteFile(filepath.Join(dir, "report.json"), []byte(`{"format":"nope"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if problems := Check(dir); len(problems) == 0 {
		t.Fatal("a report that does not match the schema was accepted")
	}
}

func TestAReportThatIsNotJSONIsRejected(t *testing.T) {
	dir := writeReport(t)
	if err := os.WriteFile(filepath.Join(dir, "report.json"), []byte(`not json`), 0o644); err != nil {
		t.Fatal(err)
	}
	if problems := Check(dir); len(problems) == 0 {
		t.Fatal("garbage was accepted")
	}
}

func TestAConsistencyViolationIsRejected(t *testing.T) {
	dir := writeReport(t)
	data, _ := os.ReadFile(filepath.Join(dir, "report.json"))
	// A second Context with the same ID as the first still fits the schema
	// but breaks the unique-ID rule.
	broken := strings.Replace(string(data), `"C-0002"`, `"C-0001"`, 1)
	if broken == string(data) {
		t.Fatal("fixture did not contain C-0002")
	}
	if err := os.WriteFile(filepath.Join(dir, "report.json"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	if problems := Check(dir); len(problems) == 0 {
		t.Fatal("an inconsistent report was accepted")
	}
}

// A Run with --format json writes no report.md. The checker can be told so, and
// then validates report.json alone.
func TestAJSONOnlyReportIsAcceptedWhenTheMarkdownIsNotExpected(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run")
	if err := writer.Write(dir, resultsettest.Minimal(), writer.Formats{JSON: true}); err != nil {
		t.Fatal(err)
	}
	if problems := Check(dir); len(problems) == 0 {
		t.Error("a folder without report.md was accepted although both files are expected")
	}
	if problems := CheckFiles(dir, false); len(problems) != 0 {
		t.Errorf("problems: %v", problems)
	}
}
