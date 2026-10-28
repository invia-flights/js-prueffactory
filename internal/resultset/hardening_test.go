package resultset_test

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func evidence(kind, text string) resultset.Evidence {
	return resultset.Evidence{Kind: kind, Text: text, Origin: "test tool", Trust: resultset.TrustUntrusted}
}

func artifactByID(s *resultset.Set, id string) *resultset.Artifact {
	for i := range s.Artifacts {
		if s.Artifacts[i].ID == id {
			return &s.Artifacts[i]
		}
	}
	return nil
}

func TestFinalizeCapsLongEvidenceAndKeepsTheFullTextInAnArtifact(t *testing.T) {
	cases := map[string]string{
		"ascii":       strings.Repeat("x", 10000),
		"astral":      strings.Repeat("\U0001F600", 3000), // 4 bytes each, so the cut falls on a boundary
		"split rune":  strings.Repeat("a", 4095) + "é" + strings.Repeat("b", 100),
		"exactly cap": strings.Repeat("y", resultset.MaxEvidenceBytes),
	}
	for name, full := range cases {
		t.Run(name, func(t *testing.T) {
			s := handMade()
			s.Findings[0].Evidence = []resultset.Evidence{evidence("tool_output", full)}
			s.Finalize()

			ev := onlyEvidence(t, s)
			if len(ev.Text) > resultset.MaxEvidenceBytes || !utf8.ValidString(ev.Text) || !strings.HasPrefix(full, ev.Text) {
				t.Fatalf("evidence text is %d bytes, valid=%v", len(ev.Text), utf8.ValidString(ev.Text))
			}
			if len(full) <= resultset.MaxEvidenceBytes {
				if ev.OriginalSize != nil || ev.ArtifactID != nil || s.ReportCompleteness.TruncatedEvidence != 0 {
					t.Fatalf("evidence within the cap must stay untouched: %+v", ev)
				}
				return
			}
			if ev.OriginalSize == nil || *ev.OriginalSize != len(full) {
				t.Fatalf("original size = %v, want %d", ev.OriginalSize, len(full))
			}
			if ev.ArtifactID == nil {
				t.Fatal("truncated evidence names no artifact")
			}
			a := artifactByID(s, *ev.ArtifactID)
			if a == nil || string(a.Content) != full || a.Size != int64(len(full)) || len(a.SHA256) != 64 {
				t.Fatalf("artifact does not hold the full text: %+v", a)
			}
			if !strings.HasPrefix(a.Path, "artifacts/evidence/") || a.CheckID != "syntax.parse" {
				t.Errorf("artifact path %q check %q", a.Path, a.CheckID)
			}
			if s.ReportCompleteness.TruncatedEvidence != 1 {
				t.Errorf("truncated evidence items = %d, want 1", s.ReportCompleteness.TruncatedEvidence)
			}
			listed := false
			for _, e := range s.Checks {
				for _, id := range e.ArtifactIDs {
					listed = listed || id == a.ID
				}
			}
			if !listed {
				t.Error("the producing execution does not list the artifact")
			}
			if problems := s.Validate(); len(problems) != 0 {
				t.Errorf("finalized set is invalid: %v", problems)
			}
		})
	}
}

// onlyEvidence returns the one evidence item in the set. Findings are sorted by
// Finalize, so a test cannot rely on their position.
func onlyEvidence(t *testing.T, s *resultset.Set) resultset.Evidence {
	t.Helper()
	var all []resultset.Evidence
	for _, f := range s.Findings {
		all = append(all, f.Evidence...)
	}
	if len(all) != 1 {
		t.Fatalf("want one evidence item, got %d", len(all))
	}
	return all[0]
}

func stackTrace(frames int) string {
	var b strings.Builder
	b.WriteString("Error: boom\n")
	for i := 0; i < frames; i++ {
		fmt.Fprintf(&b, "    at fn%d (/app/src/f%d.js:%d:1)\n", i, i, i+1)
	}
	return b.String()
}

func TestFinalizeKeepsAtMost30FramesOfAStackTrace(t *testing.T) {
	s := handMade()
	s.Findings[0].Evidence = []resultset.Evidence{evidence("stack_trace", stackTrace(45))}
	s.Findings[1].Evidence = []resultset.Evidence{evidence("stack_trace", stackTrace(30))}
	s.Finalize()

	var long, exact resultset.Evidence
	for _, f := range s.Findings {
		for _, ev := range f.Evidence {
			if ev.OriginalSize != nil {
				long = ev
			} else if strings.Contains(ev.Text, "fn29") {
				exact = ev
			}
		}
	}
	if got := strings.Count(long.Text, "\n    at "); got != 30 {
		t.Fatalf("long trace keeps %d frames, want 30:\n%s", got, long.Text)
	}
	if !strings.HasPrefix(long.Text, "Error: boom\n") {
		t.Error("the message line before the frames must stay")
	}
	if long.OriginalSize == nil || *long.OriginalSize != len(stackTrace(45)) || long.ArtifactID == nil {
		t.Errorf("cut trace records no original size or artifact: %+v", long)
	}
	if exact.Text == "" || exact.OriginalSize != nil {
		t.Errorf("a trace with exactly 30 frames is not truncated: %+v", exact)
	}
	if s.ReportCompleteness.TruncatedEvidence != 1 {
		t.Errorf("truncated items = %d, want 1", s.ReportCompleteness.TruncatedEvidence)
	}
}
