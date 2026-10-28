package resultset

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"strings"
)

var contextIDPattern = regexp.MustCompile(`^C-[0-9]{4,}$`)

// sequence checks that the IDs of one kind are PREFIX-0001, PREFIX-0002 and so
// on in list order, which is how Finalize assigns them after sorting.
func (v *validator) sequence(prefix, kind string, ids []string) {
	for i, id := range ids {
		if want := fmt.Sprintf("%s-%04d", prefix, i+1); id != want {
			v.addf("%s number %d has ID %q, want %q", kind, i+1, id, want)
		}
	}
}

func (v *validator) idFormats(s *Set) {
	var ex, fi, tc, ar, me []string
	for _, e := range s.Checks {
		ex = append(ex, e.ID)
	}
	for _, f := range s.Findings {
		fi = append(fi, f.ID)
	}
	for _, t := range s.TestCases {
		tc = append(tc, t.ID)
	}
	for _, a := range s.Artifacts {
		ar = append(ar, a.ID)
	}
	for _, m := range s.Metrics {
		me = append(me, m.ID)
	}
	v.sequence("E", "execution", ex)
	v.sequence("F", "finding", fi)
	v.sequence("T", "test case", tc)
	v.sequence("A", "artifact", ar)
	v.sequence("M", "metric", me)
	for _, c := range s.Contexts {
		if !contextIDPattern.MatchString(c.ID) {
			v.addf("context ID %q is not of the form C-0001", c.ID)
		}
	}
}

// evidenceRules checks the caps on evidence and the bookkeeping of cut items.
func (v *validator) evidenceRules(s *Set) {
	artifacts := map[string]Artifact{}
	for _, a := range s.Artifacts {
		artifacts[a.ID] = a
	}
	cut := 0
	for _, f := range s.Findings {
		for k, ev := range f.Evidence {
			where := fmt.Sprintf("finding %s evidence %d", f.ID, k+1)
			if len(ev.Text) > MaxEvidenceBytes {
				v.addf("%s has %d bytes, over the cap of %d", where, len(ev.Text), MaxEvidenceBytes)
			}
			if ev.Kind == evidenceKindStackTrace {
				if n := countFrames(ev.Text); n > MaxStackFrames {
					v.addf("%s is a stack trace with %d frames, over the cap of %d", where, n, MaxStackFrames)
				}
			}
			if ev.OriginalSize == nil {
				continue
			}
			cut++
			if *ev.OriginalSize < len(ev.Text) {
				v.addf("%s records an original size of %d, smaller than its text of %d bytes", where, *ev.OriginalSize, len(ev.Text))
			}
			if ev.ArtifactID == nil {
				v.addf("%s was cut but names no artifact with the full text", where)
			} else if a, ok := artifacts[*ev.ArtifactID]; ok && a.Content != nil && len(a.Content) != *ev.OriginalSize {
				v.addf("%s records an original size of %d but its artifact has %d bytes", where, *ev.OriginalSize, len(a.Content))
			}
		}
	}
	if s.ReportCompleteness.TruncatedEvidence != cut {
		v.addf("report_completeness counts %d truncated evidence items but %d are cut", s.ReportCompleteness.TruncatedEvidence, cut)
	}
}

func (v *validator) artifactRules(s *Set) {
	paths := map[string]string{}
	for _, a := range s.Artifacts {
		p := a.Path
		switch {
		case p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, `\`) || path.Clean(p) != p || p == ".." || strings.HasPrefix(p, "../"):
			v.addf("artifact %s has the path %q, which is not a clean relative path inside the report folder", a.ID, p)
		case p == "report.json" || p == "report.md" || p == "report.schema.json" || p == "report.invalid.json":
			v.addf("artifact %s would overwrite %s", a.ID, p)
		}
		if other, dup := paths[p]; dup {
			v.addf("artifacts %s and %s share the path %q", other, a.ID, p)
		}
		paths[p] = a.ID
		if a.Content != nil {
			sum := sha256.Sum256(a.Content)
			if hex.EncodeToString(sum[:]) != a.SHA256 || int64(len(a.Content)) != a.Size {
				v.addf("artifact %s does not match its recorded SHA-256 and size", a.ID)
			}
		}
	}
}

func (v *validator) testCaseRules(s *Set) {
	for _, t := range s.TestCases {
		switch t.Outcome {
		case TestPassed:
			v.addf("test case %s passed, so it belongs in an artifact and not in the list", t.ID)
		case TestNeverRun:
			if t.NeverRunReason == nil || *t.NeverRunReason == "" {
				v.addf("test case %s never ran but gives no reason", t.ID)
			}
		case TestFailed, TestSkipped, TestTodo:
			if t.NeverRunReason != nil {
				v.addf("test case %s has a never-run reason but the outcome %q", t.ID, t.Outcome)
			}
		default:
			v.addf("test case %s has unknown outcome %q", t.ID, t.Outcome)
		}
	}
}

// consistency checks the rules that tie one part of the set to another.
func (v *validator) consistency(s *Set) {
	execByID := map[string]Execution{}
	for _, e := range s.Checks {
		execByID[e.ID] = e
	}
	limitations := map[string]bool{}
	for _, l := range s.Limitations {
		limitations[l.ReasonCode] = true
	}
	for _, f := range s.Findings {
		// A Finding names the reason codes of the Limitations that qualify it,
		// and the Report says what each one is.
		for _, code := range f.Limitations {
			if !limitations[code] {
				v.addf("finding %s refers to Limitation %q, but the Report has no Limitation with that reason code", f.ID, code)
			}
		}
		if e, ok := execByID[f.ExecutionID]; ok {
			if e.ContextID != f.ContextID {
				v.addf("finding %s is in context %s but its execution %s is in %s", f.ID, f.ContextID, e.ID, e.ContextID)
			}
			if e.CheckID != f.CheckID {
				v.addf("finding %s is of Check %s but its execution %s is of %s", f.ID, f.CheckID, e.ID, e.CheckID)
			}
		}
	}
	scope, standard := s.completeness()
	if !sameCompleteness(scope, s.Summary.ScopeCompleteness) {
		v.addf("summary.scope_completeness %+v does not match the executions %+v", s.Summary.ScopeCompleteness, scope)
	}
	if !sameCompleteness(standard, s.Summary.StandardCompleteness) {
		v.addf("summary.standard_completeness %+v does not match the executions %+v", s.Summary.StandardCompleteness, standard)
	}
	if s.Run.Status != RunCancelled {
		incomplete := false
		for _, e := range s.Checks {
			if e.Selected && e.Applicability != NotApplicable && e.Status != StatusCompleted {
				incomplete = true
			}
		}
		if incomplete != (s.Run.Status == RunIncomplete) {
			v.addf("run.status is %q but selected Checks incomplete is %v", s.Run.Status, incomplete)
		}
	}
	for _, e := range s.Checks {
		if e.ReasonCode != nil && *e.ReasonCode == ReasonDeselectedByFast && (e.Selected || !s.Selection.Fast) {
			v.addf("execution %s is deselected by --fast but selected is %v and selection.fast is %v", e.ID, e.Selected, s.Selection.Fast)
		}
	}
	effective := map[string]bool{}
	for _, id := range s.Selection.EffectiveChecks {
		effective[id] = true
	}
	for _, id := range s.Selection.DeselectedChecks {
		if effective[id] {
			v.addf("Check %s is both effective and deselected", id)
		}
	}
}

func sameCompleteness(a, b Completeness) bool {
	if a.Required != b.Required || a.Completed != b.Completed || (a.Ratio == nil) != (b.Ratio == nil) {
		return false
	}
	return a.Ratio == nil || *a.Ratio == *b.Ratio
}
