package resultset_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// exec builds a hand-made Check execution for the exit-code table.
func exec(selected bool, app resultset.Applicability, status resultset.ExecStatus, gates int) resultset.Execution {
	return resultset.Execution{
		CheckID: "syntax.parse", Family: "syntax", ContextID: "C-0002",
		Selected: selected, Applicability: app, Status: status, Gate: gates,
	}
}

func TestExitCodeMapping(t *testing.T) {
	const (
		app = resultset.Applicable
		na  = resultset.NotApplicable
		unk = resultset.Unknown
	)
	tests := []struct {
		name string
		run  resultset.RunStatus
		exec []resultset.Execution
		want int
	}{
		{"every selected applicable Check completed", resultset.RunCompleted,
			[]resultset.Execution{exec(true, app, resultset.StatusCompleted, 0)}, 0},
		{"nothing to check at all", resultset.RunCompleted, nil, 0},
		{"a Gate fires", resultset.RunCompleted,
			[]resultset.Execution{exec(true, app, resultset.StatusCompleted, 1)}, 1},
		{"a Gate in a partial execution still fails", resultset.RunIncomplete,
			[]resultset.Execution{exec(true, app, resultset.StatusPartial, 2)}, 1},
		{"Gate wins over an incomplete Check", resultset.RunIncomplete,
			[]resultset.Execution{
				exec(true, app, resultset.StatusCompleted, 1),
				exec(true, app, resultset.StatusTimedOut, 0)}, 1},
		{"incomplete applicable Check without Gate", resultset.RunIncomplete,
			[]resultset.Execution{exec(true, app, resultset.StatusBudgetExhausted, 0)}, 2},
		{"incomplete Check with unknown Applicability counts", resultset.RunIncomplete,
			[]resultset.Execution{exec(true, unk, resultset.StatusBlocked, 0)}, 2},
		{"unsupported counts as not completed", resultset.RunIncomplete,
			[]resultset.Execution{exec(true, app, resultset.StatusUnsupported, 0)}, 2},
		{"not applicable Checks never matter", resultset.RunCompleted,
			[]resultset.Execution{exec(true, na, resultset.StatusNotStarted, 0)}, 0},
		{"deselected Checks never change the exit code", resultset.RunCompleted,
			[]resultset.Execution{exec(false, app, resultset.StatusNotStarted, 0)}, 0},
		{"a prerequisite run without selection fires no Gates", resultset.RunCompleted,
			[]resultset.Execution{exec(false, app, resultset.StatusCompleted, 3)}, 0},
		{"a failed prerequisite does not make the Run incomplete by itself", resultset.RunCompleted,
			[]resultset.Execution{exec(false, app, resultset.StatusToolError, 0)}, 0},
		{"interrupted Run", resultset.RunCancelled,
			[]resultset.Execution{exec(true, app, resultset.StatusCancelled, 0)}, 130},
		{"interruption wins over a Gate", resultset.RunCancelled,
			[]resultset.Execution{exec(true, app, resultset.StatusCompleted, 1)}, 130},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := &resultset.Set{Run: resultset.Run{Status: tc.run}, Checks: tc.exec}
			if got := resultset.ExitCode(s); got != tc.want {
				t.Fatalf("ExitCode = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestExitCodePriorityIsThreeOneTwoZero(t *testing.T) {
	cases := []struct{ a, b, want int }{
		{resultset.ExitInternalError, resultset.ExitGate, 3},
		{resultset.ExitGate, resultset.ExitIncomplete, 1},
		{resultset.ExitIncomplete, resultset.ExitOK, 2},
		{resultset.ExitOK, resultset.ExitOK, 0},
	}
	for _, c := range cases {
		if got := resultset.CombineExitCodes(c.a, c.b); got != c.want {
			t.Errorf("CombineExitCodes(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
		}
		if got := resultset.CombineExitCodes(c.b, c.a); got != c.want {
			t.Errorf("CombineExitCodes(%d, %d) = %d, want %d", c.b, c.a, got, c.want)
		}
	}
}
