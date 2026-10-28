package resultsettest

import "github.com/invia-flights/jscript-bench/internal/resultset"

// Finding returns a valid syntax.parse Finding for the execution Minimal
// builds. It carries no ID of its own: Finalize assigns IDs after sorting.
// Callers change the fields they care about, append it to Set.Findings and call
// Finalize again.
func Finding(path, title string, gate bool) resultset.Finding {
	rule := "SyntaxError"
	sev := resultset.SeverityNote
	if gate {
		sev = resultset.SeverityError
	}
	return resultset.Finding{
		ID: "tmp-" + path + "-" + title, CheckID: "syntax.parse", ExecutionID: "E-0001", ContextID: "C-0002", RuleID: &rule,
		Fingerprint: resultset.NewFingerprint("syntax.parse", rule, path, title),
		Kind:        resultset.KindDefect, Severity: sev, Confidence: resultset.ConfidenceConfirmed, Gate: gate,
		Title: title, Message: "node --check reports a syntax error in this file.",
		Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: path, FileSHA256: SHA,
			Start: &resultset.Position{Line: 1}}},
		Reproduction: resultset.Reproduction{
			Rerun: []string{"js-prueffactory", "test", "/work/demo", "--only", "syntax.parse"}, VerifiedBy: []string{"syntax.parse"}},
	}
}
