package resultset

import (
	"fmt"
	"sort"
)

// Finalize brings a result set into its final, stable shape.
//
// Whoever builds the set (the engine, or a test) gives executions, Findings,
// test cases, metrics and artifacts temporary unique keys in their ID fields,
// and refers to them by those keys. Finalize sorts everything in an order that
// never depends on which worker finished first, assigns the final IDs
// (E-0001, F-0001, T-0001, A-0001, M-0001), rewrites every reference, derives
// each execution's Gate count and Outcome, and fills the summary, the Run
// status and the exit code. Context IDs are assigned by discovery and kept.
func (s *Set) Finalize() {
	s.capEvidence()
	s.movePassedTestCases()
	s.fillArtifactDigests()
	execMap := s.sortExecutions()
	artifactMap := s.sortArtifacts()
	findingMap := s.sortFindings(execMap, artifactMap)
	s.sortTestCases(execMap, findingMap)
	s.sortMetrics()
	s.sortLists()
	s.fillExecutionDerivedFields(artifactMap)
	s.fillSummary()
	s.fillRunStatus()
	s.countTruncatedEvidence()
	s.Normalize()
}

// countTruncatedEvidence fills report_completeness from the evidence items
// that record an original size, which means they were cut.
func (s *Set) countTruncatedEvidence() {
	n := 0
	for _, f := range s.Findings {
		for _, ev := range f.Evidence {
			if ev.OriginalSize != nil {
				n++
			}
		}
	}
	s.ReportCompleteness.TruncatedEvidence = n
}

func (s *Set) sortExecutions() map[string]string {
	sort.SliceStable(s.Checks, func(i, j int) bool {
		a, b := s.Checks[i], s.Checks[j]
		if a.CheckID != b.CheckID {
			return a.CheckID < b.CheckID
		}
		return a.ContextID < b.ContextID
	})
	m := make(map[string]string, len(s.Checks))
	for i := range s.Checks {
		id := fmt.Sprintf("E-%04d", i+1)
		m[s.Checks[i].ID] = id
		s.Checks[i].ID = id
		s.Checks[i].FindingIDs = []string{}
	}
	return m
}

func (s *Set) sortArtifacts() map[string]string {
	sort.SliceStable(s.Artifacts, func(i, j int) bool { return s.Artifacts[i].Path < s.Artifacts[j].Path })
	m := make(map[string]string, len(s.Artifacts))
	for i := range s.Artifacts {
		id := fmt.Sprintf("A-%04d", i+1)
		m[s.Artifacts[i].ID] = id
		s.Artifacts[i].ID = id
	}
	return m
}

func severityRank(sev Severity) int {
	switch sev {
	case SeverityError:
		return 0
	case SeverityWarning:
		return 1
	default:
		return 2
	}
}

func firstLocation(f Finding) (path string, line int) {
	if len(f.Locations) == 0 {
		return "", 0
	}
	l := f.Locations[0]
	if l.Start != nil {
		line = l.Start.Line
	}
	return l.Path, line
}

func (s *Set) sortFindings(execMap, artifactMap map[string]string) map[string]string {
	sort.SliceStable(s.Findings, func(i, j int) bool {
		a, b := s.Findings[i], s.Findings[j]
		if a.Gate != b.Gate {
			return a.Gate
		}
		if ra, rb := severityRank(a.Severity), severityRank(b.Severity); ra != rb {
			return ra < rb
		}
		if a.CheckID != b.CheckID {
			return a.CheckID < b.CheckID
		}
		pa, la := firstLocation(a)
		pb, lb := firstLocation(b)
		if pa != pb {
			return pa < pb
		}
		if la != lb {
			return la < lb
		}
		ra, rb := derefString(a.RuleID), derefString(b.RuleID)
		if ra != rb {
			return ra < rb
		}
		if a.Message != b.Message {
			return a.Message < b.Message
		}
		// Past the keys the spec names, every remaining field breaks ties, so
		// that the order never depends on arrival order.
		if a.ContextID != b.ContextID {
			return a.ContextID < b.ContextID
		}
		if a.Title != b.Title {
			return a.Title < b.Title
		}
		if a.Fingerprint.Value != b.Fingerprint.Value {
			return a.Fingerprint.Value < b.Fingerprint.Value
		}
		return canonical(a) < canonical(b)
	})
	m := make(map[string]string, len(s.Findings))
	byExec := make(map[string]*Execution, len(s.Checks))
	for i := range s.Checks {
		byExec[s.Checks[i].ID] = &s.Checks[i]
	}
	for i := range s.Findings {
		f := &s.Findings[i]
		id := fmt.Sprintf("F-%04d", i+1)
		m[f.ID] = id
		f.ID = id
		if newExec, ok := execMap[f.ExecutionID]; ok {
			f.ExecutionID = newExec
		}
		for k := range f.Evidence {
			if f.Evidence[k].ArtifactID != nil {
				if na, ok := artifactMap[*f.Evidence[k].ArtifactID]; ok {
					f.Evidence[k].ArtifactID = &na
				}
			}
		}
		if e := byExec[f.ExecutionID]; e != nil {
			e.FindingIDs = append(e.FindingIDs, id)
		}
	}
	return m
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Set) sortTestCases(execMap, findingMap map[string]string) {
	for i := range s.TestCases {
		if n, ok := execMap[s.TestCases[i].ExecutionID]; ok {
			s.TestCases[i].ExecutionID = n
		}
		ids := make([]string, 0, len(s.TestCases[i].FindingIDs))
		for _, f := range s.TestCases[i].FindingIDs {
			if n, ok := findingMap[f]; ok {
				f = n
			}
			ids = append(ids, f)
		}
		sort.Strings(ids)
		s.TestCases[i].FindingIDs = ids
	}
	sort.SliceStable(s.TestCases, func(i, j int) bool {
		a, b := s.TestCases[i], s.TestCases[j]
		if a.ExecutionID != b.ExecutionID {
			return a.ExecutionID < b.ExecutionID
		}
		if a.File != b.File {
			return a.File < b.File
		}
		if a.FullTitle != b.FullTitle {
			return a.FullTitle < b.FullTitle
		}
		if a.Suite != b.Suite {
			return a.Suite < b.Suite
		}
		if a.Outcome != b.Outcome {
			return a.Outcome < b.Outcome
		}
		return canonical(a) < canonical(b)
	})
	for i := range s.TestCases {
		s.TestCases[i].ID = fmt.Sprintf("T-%04d", i+1)
	}
}

func (s *Set) sortMetrics() {
	sort.SliceStable(s.Metrics, func(i, j int) bool {
		a, b := s.Metrics[i], s.Metrics[j]
		if a.CheckID != b.CheckID {
			return a.CheckID < b.CheckID
		}
		if a.ContextID != b.ContextID {
			return a.ContextID < b.ContextID
		}
		return a.Name < b.Name
	})
	for i := range s.Metrics {
		s.Metrics[i].ID = fmt.Sprintf("M-%04d", i+1)
	}
}

// DeriveOutcome applies the Outcome rules: failed when a Gate fired (even for
// a partial execution), passed for a completed execution without Findings,
// observations_only for a completed one with Findings or measurements but no
// Gate, unknown otherwise.
func DeriveOutcome(status ExecStatus, gates int, hasObservations bool) Outcome {
	switch {
	case gates > 0:
		return OutcomeFailed
	case status != StatusCompleted:
		return OutcomeUnknown
	case hasObservations:
		return OutcomeObservationsOnly
	default:
		return OutcomePassed
	}
}

func (s *Set) fillExecutionDerivedFields(artifactMap map[string]string) {
	type key struct{ check, ctx string }
	metricCount := map[key]int{}
	for _, m := range s.Metrics {
		metricCount[key{m.CheckID, m.ContextID}]++
	}
	byID := make(map[string]*Execution, len(s.Checks))
	for i := range s.Checks {
		byID[s.Checks[i].ID] = &s.Checks[i]
		s.Checks[i].Gate = 0
	}
	for _, f := range s.Findings {
		if e := byID[f.ExecutionID]; e != nil && f.Gate {
			e.Gate++
		}
	}
	for i := range s.Checks {
		e := &s.Checks[i]
		for k, a := range e.ArtifactIDs {
			if n, ok := artifactMap[a]; ok {
				e.ArtifactIDs[k] = n
			}
		}
		if e.ArtifactIDs == nil {
			e.ArtifactIDs = []string{}
		}
		observed := len(e.FindingIDs) > 0 || metricCount[key{e.CheckID, e.ContextID}] > 0
		e.Outcome = DeriveOutcome(e.Status, e.Gate, observed)
		if !e.Selected && e.Status == StatusCompleted && e.ReasonCode != nil && e.Outcome == OutcomePassed {
			// A prerequisite that ran without being selected reports no
			// Findings, so a failure it had left no Gate behind. Its reason code
			// says it failed, and "passed" would be wrong.
			e.Outcome = OutcomeUnknown
		}
	}
}

func (s *Set) fillSummary() {
	sum := &s.Summary
	sum.FindingsBySeverity = SeverityCounts{}
	sum.Gates = 0
	for _, f := range s.Findings {
		switch f.Severity {
		case SeverityError:
			sum.FindingsBySeverity.Error++
		case SeverityWarning:
			sum.FindingsBySeverity.Warning++
		default:
			sum.FindingsBySeverity.Note++
		}
		if f.Gate {
			sum.Gates++
		}
	}
	// Passed test cases live in an artifact, so Passed is set by whoever ran
	// the tests. The other counts always come from the list in the Report.
	sum.TestCases.Failed, sum.TestCases.Skipped, sum.TestCases.Todo, sum.TestCases.NeverRun = 0, 0, 0, 0
	for _, tc := range s.TestCases {
		switch tc.Outcome {
		case TestFailed:
			sum.TestCases.Failed++
		case TestSkipped:
			sum.TestCases.Skipped++
		case TestTodo:
			sum.TestCases.Todo++
		case TestNeverRun:
			sum.TestCases.NeverRun++
		}
	}
	sum.ScopeCompleteness, sum.StandardCompleteness = s.completeness()
}

// completeness counts the executions that had to complete: Scope completeness
// covers the selected applicable Checks, Standard completeness every
// applicable Check of the standard scope.
func (s *Set) completeness() (scope, standard Completeness) {
	for _, e := range s.Checks {
		if e.Applicability == NotApplicable {
			continue
		}
		standard.Required++
		if e.Status == StatusCompleted {
			standard.Completed++
		}
		if e.Selected {
			scope.Required++
			if e.Status == StatusCompleted {
				scope.Completed++
			}
		}
	}
	scope.Ratio = ratio(scope)
	standard.Ratio = ratio(standard)
	return scope, standard
}

func ratio(c Completeness) *float64 {
	if c.Required == 0 {
		return nil
	}
	r := float64(c.Completed) / float64(c.Required)
	return &r
}

func (s *Set) fillRunStatus() {
	if s.Run.Status != RunCancelled {
		s.Run.Status = RunCompleted
		for _, e := range s.Checks {
			if e.Selected && e.Applicability != NotApplicable && e.Status != StatusCompleted {
				s.Run.Status = RunIncomplete
				break
			}
		}
	}
	s.Run.ExitCode = ExitCode(s)
}
