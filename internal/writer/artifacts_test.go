package writer_test

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

func withLongEvidence() *resultset.Set {
	s := resultsettest.Minimal()
	s.Findings = []resultset.Finding{{
		ID: "k", CheckID: "syntax.parse", ExecutionID: "E-0001", ContextID: "C-0002",
		RuleID:      ptr("SyntaxError"),
		Fingerprint: resultset.NewFingerprint("syntax.parse", "SyntaxError", "a.js", "m"),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityNote, Confidence: resultset.ConfidenceConfirmed,
		Title: "t", Message: "m",
		Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: "a.js", FileSHA256: resultsettest.SHA}},
		Evidence: []resultset.Evidence{{Kind: "tool_output", Text: strings.Repeat("long ", 2000), Origin: "node",
			Trust: resultset.TrustUntrusted}},
		Reproduction: resultset.Reproduction{Rerun: []string{"js-prueffactory"}, VerifiedBy: []string{"syntax.parse"}},
	}}
	s.Finalize()
	return s
}

func ptr[T any](v T) *T { return &v }

func TestWriterSavesArtifactsNextToTheReportsAndLinksThemFromMarkdown(t *testing.T) {
	s := withLongEvidence()
	dir := filepath.Join(t.TempDir(), "run")
	if err := writer.Write(dir, s, writer.Formats{JSON: true, Markdown: true}); err != nil {
		t.Fatal(err)
	}
	a := s.Artifacts[0]
	got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(a.Path)))
	if err != nil {
		t.Fatalf("artifact not written: %v", err)
	}
	if string(got) != strings.Repeat("long ", 2000) {
		t.Errorf("artifact holds %d bytes, not the full text", len(got))
	}
	md, _ := os.ReadFile(filepath.Join(dir, "report.md"))
	if !strings.Contains(string(md), "]("+a.Path+")") {
		t.Errorf("report.md does not link the artifact %s:\n%s", a.Path, md)
	}
	// Nothing temporary is left behind in the artifact folders.
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.Contains(info.Name(), ".tmp-") {
			t.Errorf("temporary file left behind: %s", p)
		}
		return nil
	})
}

func TestWriterWritesNoArtifactsForAnInvalidSet(t *testing.T) {
	s := withLongEvidence()
	s.Summary.Gates = 3
	dir := filepath.Join(t.TempDir(), "run")
	err := writer.Write(dir, s, writer.Formats{JSON: true, Markdown: true})
	var invalid *writer.InvalidReportError
	if !errors.As(err, &invalid) {
		t.Fatalf("err = %v, want InvalidReportError", err)
	}
	if got := names(t, dir); !slices.Equal(got, []string{"report.invalid.json"}) {
		t.Fatalf("files = %v, want only report.invalid.json", got)
	}
}

func TestWriterRefusesAnArtifactPathOutsideTheReportFolder(t *testing.T) {
	s := withLongEvidence()
	s.Artifacts[0].Path = "../escaped.txt"
	parent := t.TempDir()
	err := writer.Write(filepath.Join(parent, "run"), s, writer.Formats{JSON: true})
	var invalid *writer.InvalidReportError
	if !errors.As(err, &invalid) {
		t.Fatalf("err = %v, want InvalidReportError", err)
	}
	if _, statErr := os.Stat(filepath.Join(parent, "escaped.txt")); statErr == nil {
		t.Fatal("the writer wrote outside the report folder")
	}
}
