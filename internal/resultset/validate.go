package resultset

import (
	"fmt"
	"math"
)

// Validate checks the consistency rules the JSON Schema cannot express:
// every reference resolves, IDs are unique, counts match their lists, status
// and Outcome combinations are allowed and the benchmark section agrees with
// its Verdict. It returns one message per problem, empty when the set is sound.
func (s *Set) Validate() []string {
	v := validator{}
	v.references(s)
	v.executions(s)
	v.summary(s)
	v.benchmark(s)
	v.idFormats(s)
	v.evidenceRules(s)
	v.artifactRules(s)
	v.testCaseRules(s)
	v.consistency(s)
	if got := ExitCode(s); got != s.Run.ExitCode {
		v.addf("run.exit_code is %d but the results map to %d", s.Run.ExitCode, got)
	}
	return v.problems
}

type validator struct{ problems []string }

func (v *validator) addf(format string, args ...any) {
	v.problems = append(v.problems, fmt.Sprintf(format, args...))
}

func (v *validator) unique(kind string, ids []string) map[string]bool {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			v.addf("duplicate %s ID %q", kind, id)
		}
		seen[id] = true
	}
	return seen
}

func (v *validator) references(s *Set) {
	var ctxIDs, execIDs, findingIDs, artifactIDs, testIDs, metricIDs []string
	for _, c := range s.Contexts {
		ctxIDs = append(ctxIDs, c.ID)
	}
	for _, e := range s.Checks {
		execIDs = append(execIDs, e.ID)
	}
	for _, f := range s.Findings {
		findingIDs = append(findingIDs, f.ID)
	}
	for _, a := range s.Artifacts {
		artifactIDs = append(artifactIDs, a.ID)
	}
	for _, t := range s.TestCases {
		testIDs = append(testIDs, t.ID)
	}
	for _, m := range s.Metrics {
		metricIDs = append(metricIDs, m.ID)
	}
	ctx := v.unique("context", ctxIDs)
	exec := v.unique("execution", execIDs)
	finding := v.unique("finding", findingIDs)
	artifact := v.unique("artifact", artifactIDs)
	v.unique("test case", testIDs)
	v.unique("metric", metricIDs)

	execByID := map[string]Execution{}
	for _, e := range s.Checks {
		execByID[e.ID] = e
		if !ctx[e.ContextID] {
			v.addf("execution %s refers to unknown context %q", e.ID, e.ContextID)
		}
		for _, id := range e.FindingIDs {
			if !finding[id] {
				v.addf("execution %s lists unknown finding %q", e.ID, id)
			}
		}
		for _, id := range e.ArtifactIDs {
			if !artifact[id] {
				v.addf("execution %s lists unknown artifact %q", e.ID, id)
			}
		}
	}
	listed := map[string]string{}
	for _, e := range s.Checks {
		for _, id := range e.FindingIDs {
			listed[id] = e.ID
		}
	}
	for _, f := range s.Findings {
		if !exec[f.ExecutionID] {
			v.addf("finding %s refers to unknown execution %q", f.ID, f.ExecutionID)
		} else if !execByID[f.ExecutionID].Selected {
			v.addf("finding %s belongs to execution %s, which was not selected and may not report Findings", f.ID, f.ExecutionID)
		}
		if !ctx[f.ContextID] {
			v.addf("finding %s refers to unknown context %q", f.ID, f.ContextID)
		}
		if listed[f.ID] != f.ExecutionID {
			v.addf("finding %s is not listed by its execution %s", f.ID, f.ExecutionID)
		}
		for _, ev := range f.Evidence {
			if ev.ArtifactID != nil && !artifact[*ev.ArtifactID] {
				v.addf("finding %s evidence refers to unknown artifact %q", f.ID, *ev.ArtifactID)
			}
		}
	}
	for _, t := range s.TestCases {
		if !exec[t.ExecutionID] {
			v.addf("test case %s refers to unknown execution %q", t.ID, t.ExecutionID)
		}
		for _, id := range t.FindingIDs {
			if !finding[id] {
				v.addf("test case %s refers to unknown finding %q", t.ID, id)
			}
		}
	}
	for _, m := range s.Metrics {
		if !ctx[m.ContextID] {
			v.addf("metric %s refers to unknown context %q", m.ID, m.ContextID)
		}
	}
	for _, sv := range s.Services {
		for _, id := range sv.ContextIDs {
			if !ctx[id] {
				v.addf("service %s refers to unknown context %q", sv.ComposeService, id)
			}
		}
	}
}

func (v *validator) executions(s *Set) {
	gates := map[string]int{}
	for _, f := range s.Findings {
		if f.Gate {
			gates[f.ExecutionID]++
		}
	}
	for _, e := range s.Checks {
		if e.Gate != gates[e.ID] {
			v.addf("execution %s says gate=%d but has %d Gate Findings", e.ID, e.Gate, gates[e.ID])
		}
		if e.Applicability == NotApplicable && e.Status != StatusNotStarted {
			v.addf("execution %s is not applicable but has status %q", e.ID, e.Status)
		}
		if e.Selected && e.Applicability != NotApplicable && e.Status == StatusNotStarted {
			v.addf("execution %s was selected and applicable but never started and has no reason status", e.ID)
		}
		switch e.Outcome {
		case OutcomePassed:
			if e.Status != StatusCompleted || len(e.FindingIDs) > 0 {
				v.addf("execution %s has outcome passed with status %q and %d Findings", e.ID, e.Status, len(e.FindingIDs))
			}
		case OutcomeFailed:
			if e.Gate == 0 {
				v.addf("execution %s has outcome failed without a Gate", e.ID)
			}
		case OutcomeObservationsOnly:
			if e.Status != StatusCompleted || e.Gate > 0 {
				v.addf("execution %s has outcome observations_only with status %q and gate=%d", e.ID, e.Status, e.Gate)
			}
		case OutcomeUnknown:
			// Allowed for every status except that a Gate always means failed,
			// which the check after this switch covers.
		default:
			v.addf("execution %s has unknown outcome %q", e.ID, e.Outcome)
		}
		if e.Gate > 0 && e.Outcome != OutcomeFailed {
			v.addf("execution %s fired a Gate but has outcome %q", e.ID, e.Outcome)
		}
	}
}

func (v *validator) summary(s *Set) {
	var sev SeverityCounts
	gates := 0
	for _, f := range s.Findings {
		switch f.Severity {
		case SeverityError:
			sev.Error++
		case SeverityWarning:
			sev.Warning++
		default:
			sev.Note++
		}
		if f.Gate {
			gates++
		}
	}
	if s.Summary.Gates != gates {
		v.addf("summary.gates is %d but %d Findings are Gates", s.Summary.Gates, gates)
	}
	if s.Summary.FindingsBySeverity != sev {
		v.addf("summary.findings_by_severity %+v does not match the Findings %+v", s.Summary.FindingsBySeverity, sev)
	}
	var tc TestCounts
	for _, t := range s.TestCases {
		switch t.Outcome {
		case TestFailed:
			tc.Failed++
		case TestSkipped:
			tc.Skipped++
		case TestTodo:
			tc.Todo++
		case TestNeverRun:
			tc.NeverRun++
		}
	}
	got := s.Summary.TestCases
	if got.Failed != tc.Failed || got.Skipped != tc.Skipped || got.Todo != tc.Todo || got.NeverRun != tc.NeverRun {
		v.addf("summary.test_cases %+v does not match the test cases listed %+v", got, tc)
	}
}

func (v *validator) benchmark(s *Set) {
	b := s.Benchmark
	switch b.Status {
	case BenchmarkNotRequested:
		if b.Score != nil || b.Range != nil || b.Verdict != nil || b.ProfileID != nil {
			v.addf("benchmark is not_requested but has a score, range, verdict or profile")
		}
		if len(b.Areas) > 0 || len(b.GateFindingIDs) > 0 || len(b.SideIndicators) > 0 || b.Fingerprint != nil {
			v.addf("benchmark is not_requested but has areas, Gates, side indicators or a fingerprint")
		}
		if s.Profiles.BenchmarkProfile != nil {
			v.addf("benchmark is not_requested but profiles.benchmark_profile is %q", *s.Profiles.BenchmarkProfile)
		}
		if s.Run.Command == "benchmark" {
			v.addf("the benchmark command wrote no benchmark section: it is not_requested")
		}
	case BenchmarkComputed, BenchmarkIncomplete:
		v.benchmarkScore(s)
	default:
		v.addf("benchmark has unknown status %q", b.Status)
	}
}

// benchmarkScore checks a benchmark section that was requested: score,
// Verdict, range, Gates and the numbers behind the score agree.
func (v *validator) benchmarkScore(s *Set) {
	b := s.Benchmark
	if s.Run.Command != "benchmark" {
		v.addf("a test mode Report (command %q) has a benchmark section with status %s", s.Run.Command, b.Status)
	}
	if b.Verdict == nil {
		v.addf("benchmark %s has no verdict", b.Status)
		return
	}
	gates := 0
	gateIDs := map[string]bool{}
	for _, f := range s.Findings {
		if f.Gate {
			gates++
			gateIDs[f.ID] = true
		}
	}
	if gates != s.Summary.Gates {
		v.addf("summary counts %d Gates but %d Findings are Gates", s.Summary.Gates, gates)
	}
	if (gates > 0) != (*b.Verdict == VerdictFail) {
		v.addf("benchmark verdict %q disagrees with %d Gates", *b.Verdict, gates)
	}
	switch {
	case b.Score == nil && *b.Verdict == VerdictPass:
		v.addf("benchmark verdict is pass without a score")
	case b.Score != nil && *b.Verdict == VerdictIncomplete:
		v.addf("benchmark has an incomplete verdict but a score of %v", *b.Score)
	}
	switch {
	case b.Status == BenchmarkIncomplete && b.Score != nil:
		v.addf("benchmark is incomplete but has a score")
	case b.Status == BenchmarkComputed && b.Score == nil:
		v.addf("benchmark is computed but has no score")
	}
	if b.Score != nil && (*b.Score < 0 || *b.Score > 100) {
		v.addf("benchmark score %v is outside 0 to 100", *b.Score)
	}
	switch {
	case b.Range == nil:
		v.addf("benchmark has no range, which is always computed")
	case b.Range.Low < 0 || b.Range.High > 100 || b.Range.Low > b.Range.High:
		v.addf("benchmark range %v to %v is not inside 0 to 100 or is upside down", b.Range.Low, b.Range.High)
	}

	switch {
	case b.ProfileID == nil:
		v.addf("benchmark has no profile ID")
	case s.Profiles.BenchmarkProfile == nil || *s.Profiles.BenchmarkProfile != *b.ProfileID:
		v.addf("benchmark profile %q differs from profiles.benchmark_profile", *b.ProfileID)
	}

	listed := map[string]bool{}
	for _, id := range b.GateFindingIDs {
		listed[id] = true
	}
	if len(listed) != len(b.GateFindingIDs) || len(listed) != len(gateIDs) {
		v.addf("benchmark lists %d Gate Findings but %d Findings are Gates", len(b.GateFindingIDs), len(gateIDs))
	}
	for id := range listed {
		if !gateIDs[id] {
			v.addf("benchmark lists %s as a Gate, but it is not one", id)
		}
	}

	if len(b.Areas) == 0 {
		v.addf("benchmark has no areas")
	}
	if b.Fingerprint == nil {
		v.addf("benchmark has no fingerprint")
	}
	contribution := 0.0
	for _, a := range b.Areas {
		if a.Contribution != nil {
			contribution += *a.Contribution
		}
		if a.Contribution != nil && b.Score == nil {
			v.addf("benchmark area %s has a contribution but there is no score", a.ID)
		}
	}
	// Every contribution is rounded to one decimal, and so is the score.
	if b.Score != nil && len(b.Areas) > 0 && math.Abs(contribution-*b.Score) > 0.3 {
		v.addf("benchmark area contributions add up to %.1f, not to the score %.1f", contribution, *b.Score)
	}
}
