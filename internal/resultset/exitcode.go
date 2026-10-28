package resultset

// Exit codes of js-prueffactory.
const (
	ExitOK            = 0
	ExitGate          = 1
	ExitIncomplete    = 2
	ExitInternalError = 3 // usage error, Docker unreachable, internal error
	ExitInterrupted   = 130
)

// ExitCode maps a finished result set to an exit code. Priority is 3, 1, 2, 0;
// code 3 never comes out of a result set because a Run that fails that way has
// no Report, so use CombineExitCodes for it. An interrupted Run is always 130.
//
// Only selected Checks count. Prerequisites that ran without being selected
// report no Gates and cannot make the Run incomplete, and deselected Checks
// never change the exit code.
func ExitCode(s *Set) int {
	if s.Run.Status == RunCancelled {
		return ExitInterrupted
	}
	code := ExitOK
	for _, e := range s.Checks {
		if !e.Selected {
			continue
		}
		if e.Gate > 0 {
			code = CombineExitCodes(code, ExitGate)
			continue
		}
		if e.Applicability != NotApplicable && e.Status != StatusCompleted {
			code = CombineExitCodes(code, ExitIncomplete)
		}
	}
	return code
}

// CombineExitCodes returns the code with the higher priority. The priority
// order is 3, 1, 2, 0. Code 130 is not part of the order and is handled by the
// caller.
func CombineExitCodes(a, b int) int {
	if priority(a) >= priority(b) {
		return a
	}
	return b
}

func priority(code int) int {
	switch code {
	case ExitInternalError:
		return 3
	case ExitGate:
		return 2
	case ExitIncomplete:
		return 1
	default:
		return 0
	}
}
