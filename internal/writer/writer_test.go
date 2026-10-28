package writer_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	slices.Sort(out)
	return out
}

func TestWritesBothReportsAndTheSchemaAtomically(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run")
	err := writer.Write(dir, resultsettest.Minimal(), writer.Formats{JSON: true, Markdown: true})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"report.json", "report.md", "report.schema.json"}
	if got := names(t, dir); !slices.Equal(got, want) {
		t.Fatalf("files = %v, want %v (no temporary files may remain)", got, want)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "report.json"))
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("report.json invalid: %v", problems)
	}
	shipped, _ := os.ReadFile(filepath.Join(dir, "report.schema.json"))
	if string(shipped) != string(schema.Report()) {
		t.Error("report.schema.json differs from the embedded schema")
	}
}

func TestFormatSelection(t *testing.T) {
	cases := map[string]struct {
		formats writer.Formats
		want    []string
	}{
		"json only":     {writer.Formats{JSON: true}, []string{"report.json", "report.schema.json"}},
		"markdown only": {writer.Formats{Markdown: true}, []string{"report.md"}},
	}
	for name, tc := range cases {
		dir := filepath.Join(t.TempDir(), "run")
		if err := writer.Write(dir, resultsettest.Minimal(), tc.formats); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := names(t, dir); !slices.Equal(got, tc.want) {
			t.Errorf("%s: files = %v, want %v", name, got, tc.want)
		}
	}
}

func TestInconsistentSetIsKeptAsInvalidAndNothingElseIsWritten(t *testing.T) {
	s := resultsettest.Minimal()
	s.Summary.Gates = 5 // contradicts the empty list of Findings
	dir := filepath.Join(t.TempDir(), "run")

	err := writer.Write(dir, s, writer.Formats{JSON: true, Markdown: true})

	var invalid *writer.InvalidReportError
	if !errors.As(err, &invalid) || len(invalid.Problems) == 0 {
		t.Fatalf("err = %v, want InvalidReportError with problems", err)
	}
	if got := names(t, dir); !slices.Equal(got, []string{"report.invalid.json"}) {
		t.Fatalf("files = %v, want only report.invalid.json", got)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "report.invalid.json"))
	if !json.Valid(data) {
		t.Error("report.invalid.json is not JSON")
	}
}

// A Report with one wrong field in every Finding location has thousands of
// problems. The message shows the first ones, says how many more there are,
// where the whole Report is kept, and adds the notes of the producer.
func TestTheMessageOfAnInvalidReportIsShortAndCarriesNotes(t *testing.T) {
	err := &writer.InvalidReportError{Path: "/out/report.invalid.json", Notes: []string{"note about the rule"}}
	for i := 0; i < 100; i++ {
		err.Problems = append(err.Problems, "/findings/"+strconv.Itoa(i)+"/title: wrong")
	}
	msg := err.Error()
	for _, want := range []string{"report.invalid.json", "/findings/0/title", "and 80 more problems", "note about the rule"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message lacks %q:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "/findings/50/title") {
		t.Errorf("message lists all 100 problems:\n%s", msg)
	}
	if len(err.Problems) != 100 {
		t.Errorf("the error lost problems: %d", len(err.Problems))
	}
}

func TestSchemaViolationIsRefusedToo(t *testing.T) {
	s := resultsettest.Minimal()
	s.Run.BudgetSource = "made-up"
	err := writer.Write(filepath.Join(t.TempDir(), "run"), s, writer.Formats{JSON: true})
	var invalid *writer.InvalidReportError
	if !errors.As(err, &invalid) {
		t.Fatalf("err = %v, want InvalidReportError", err)
	}
}
