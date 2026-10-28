package benchmark

import (
	"fmt"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// index looks up executions and Findings of a result set once.
type index struct {
	set        *resultset.Set
	execsOf    map[string][]*resultset.Execution // by Check ID, in report order
	findingsOf map[string][]resultset.Finding    // by execution ID
}

func indexSet(s *resultset.Set) *index {
	idx := &index{set: s, execsOf: map[string][]*resultset.Execution{}, findingsOf: map[string][]resultset.Finding{}}
	for i := range s.Checks {
		e := &s.Checks[i]
		idx.execsOf[e.CheckID] = append(idx.execsOf[e.CheckID], e)
	}
	for _, f := range s.Findings {
		idx.findingsOf[f.ExecutionID] = append(idx.findingsOf[f.ExecutionID], f)
	}
	return idx
}

// execClass says what an execution means for the Benchmark.
type execClass int

const (
	// classMeasured: the execution was selected and completed.
	classMeasured execClass = iota
	// classFault: a prerequisite failed because of the project, so there was
	// nothing to examine.
	classFault
	// classUnknown: the Run did not measure it. That covers every status other
	// than completed, and Checks that were deselected.
	classUnknown
)

// reasonPrerequisiteFailedProject is the reason code the engine gives a
// dependent execution whose prerequisite failed because of the project.
const reasonPrerequisiteFailedProject = "prerequisite_failed_project"

func classify(e *resultset.Execution) execClass {
	switch {
	case e.Selected && e.Status == resultset.StatusBlocked && deref(e.ReasonCode) == reasonPrerequisiteFailedProject:
		return classFault
	case !e.Selected:
		return classUnknown
	case e.Status == resultset.StatusCompleted:
		return classMeasured
	}
	return classUnknown
}

// unknownReason says why the first unmeasured execution was not measured, with
// the number of the others.
func unknownReason(unknown []*resultset.Execution) string {
	e := unknown[0]
	reason := string(e.Status)
	switch {
	case !e.Selected && deref(e.ReasonCode) == resultset.ReasonDeselectedByFast:
		reason = resultset.PartReasonDeselectedByFast
	case !e.Selected:
		reason = "deselected"
	case e.ReasonCode != nil:
		reason += ": " + *e.ReasonCode
	}
	if len(unknown) > 1 {
		reason += fmt.Sprintf(" (and %d more)", len(unknown)-1)
	}
	return reason
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
