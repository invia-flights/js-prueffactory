package resultsettest

import (
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Golden returns the fixed result sets behind the golden files, by name. Each
// call builds new sets, finalized and valid.
func Golden() map[string]*resultset.Set {
	return map[string]*resultset.Set{
		"clean":   Minimal(),
		"hostile": Hostile(),
		"large":   Large(),
	}
}

// Hostile is a set whose project and tool text is as awkward as it gets, with
// cut evidence, passed, failed and never-run test cases, a blocked and a
// deselected execution and a Limitation.
func Hostile() *resultset.Set {
	s := Minimal()
	awkward := "line1\r\nline2\ttabbed | pipe <script>alert(1)</script> ``` fence ```` \x07bell \U0001F600\n# not a heading\n- not a list\n[link](http://example.invalid)"
	s.Checks = append(s.Checks,
		resultset.Execution{ID: "e2", CheckID: "tests.existing", Family: "tests", ContextID: "C-0002", Selected: true,
			Applicability: resultset.Applicable, Status: resultset.StatusBlocked,
			ReasonCode: ptr("missing_registry_credentials"), Reason: ptr("registry said 401 " + awkward)},
		resultset.Execution{ID: "e3", CheckID: "quality.size", Family: "quality", ContextID: "C-0001", Selected: false,
			Applicability: resultset.Applicable, Status: resultset.StatusNotStarted},
	)
	s.Selection.DeselectedChecks = []string{"quality.size"}

	gate := Finding("src/a|b.js", "Title with | pipe and <b>html</b>", true)
	gate.Message = awkward
	gate.Expected, gate.Actual = &awkward, ptr("`tick` and ``double`` and\ttab")
	gate.Evidence = []resultset.Evidence{
		{Kind: "tool_output", Text: awkward, Origin: "node --check", Trust: resultset.TrustUntrusted},
		{Kind: "tool_output", Text: strings.Repeat("0123456789abcdef", 600), Origin: "node --check", Trust: resultset.TrustUntrusted},
		{Kind: "stack_trace", Text: stackTrace(40), Origin: "mocha", Trust: resultset.TrustUntrusted},
	}
	note := Finding("test/fixtures/bad.js", "Note in test data", false)
	note.InTestData = true
	note.Evidence = []resultset.Evidence{{Kind: "tool_output", Text: strings.Repeat("\U0001F600", 1500), Origin: "node --check", Trust: resultset.TrustUntrusted}}
	s.Findings = []resultset.Finding{gate, note}

	passed := func(title string) resultset.TestCase {
		return resultset.TestCase{ID: "p-" + title, ExecutionID: "E-0001", File: "test/a.js", Suite: "scripts.test", FullTitle: title, SuitePath: []string{"a"},
			Outcome: resultset.TestPassed, Attempts: []resultset.TestAttempt{{Outcome: resultset.TestPassed, DurationMS: 4}}}
	}
	s.TestCases = []resultset.TestCase{
		passed("a one"), passed("a two"),
		{ID: "f", ExecutionID: "E-0001", File: "test/a.js", Suite: "scripts.test", FullTitle: "a three | fails", SuitePath: []string{"a"}, Outcome: resultset.TestFailed,
			Attempts: []resultset.TestAttempt{{Outcome: resultset.TestFailed, DurationMS: 9, Error: ptr("AssertionError\n" + awkward)}}},
		{ID: "n", ExecutionID: "E-0001", File: "test/b.js", Suite: "scripts.test", FullTitle: "b never ran", SuitePath: []string{"b"}, Outcome: resultset.TestNeverRun,
			NeverRunReason: ptr("a root hook failed"), Attempts: []resultset.TestAttempt{}},
	}
	s.Limitations = []resultset.Limitation{{ReasonCode: "build_output_skipped", Message: "3 files skipped " + awkward, CheckID: ptr("syntax.parse"), Path: ptr("dist")}}
	s.Metrics = []resultset.Metric{{ID: "m", CheckID: "syntax.parse", ContextID: "C-0002", Name: "files checked", Value: ptr(7.0), Unit: "files"}}
	s.Inventory.MovedTestFiles = []resultset.MovedTestFile{
		{ContextID: "C-0002", Path: "src/a|b.spec.js", Suite: "test:unit", Kind: "spec"},
		{ContextID: "C-0002", Path: "src/setup `x`.js", Suite: "test:unit", Kind: "require"},
	}
	s.Finalize()
	return s
}

func stackTrace(frames int) string {
	var b strings.Builder
	b.WriteString("Error: boom\n")
	for i := 0; i < frames; i++ {
		fmt.Fprintf(&b, "    at fn%d (/app/src/f%d.js:%d:1)\n", i, i, i+1)
	}
	return b.String()
}

// Large has more Findings of one Check than report.md shows in full.
func Large() *resultset.Set {
	s := Minimal()
	for i := 0; i < 53; i++ {
		s.Findings = append(s.Findings, Finding(fmt.Sprintf("src/file%03d.js", i), fmt.Sprintf("Problem %d", i), i < 2))
	}
	s.Finalize()
	return s
}
