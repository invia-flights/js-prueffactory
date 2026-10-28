package engine

import (
	"fmt"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

// The names under which values are registered with the Redactor, for the
// diagnostics of a Report that fails validation.
const (
	gitleaksSource = "gitleaks (security.secrets)"
	npmrcSource    = ".npmrc"
)

// secretScan is what the Run knows about the secret scan once the Execution
// phase is over.
type secretScan struct {
	seen   bool
	status resultset.ExecStatus
	reason string
}

// takeSecretScan collects what redaction needs from the secret scan's result.
// The scan runs whether or not security.secrets is selected, because redaction
// depends on the values it finds. When the Check is deselected it is only a
// prerequisite: its Findings, Metrics and Limitations are dropped and the
// Report shows it as deselected, as for any Check left out.
func (r *run) takeSecretScan(res *execResult) *execResult {
	if res.p.entry.ID != checks.SecretsCheckID {
		return res
	}
	r.scan = secretScan{seen: true, status: res.exec.Status}
	if res.exec.Reason != nil {
		r.scan.reason = *res.exec.Reason
	}
	r.redactor.AddFrom(gitleaksSource, res.redact...)
	if !res.p.prerequisite {
		return res
	}
	r.prerequisites = append(r.prerequisites, res.p.entry.ID)
	r.log.Printf("%s is deselected and ran as a prerequisite of redaction: %s", res.p.entry.ID, res.exec.Status)
	stub := deselectedResult(res.p)
	stub.contextTools = res.contextTools
	return stub
}

// collectNpmrcSecrets adds the tokens and passwords of the project's .npmrc
// files to what is redacted. It reads the host-side Snapshot copy, so it has to
// run before cleanup removes it.
func (r *run) collectNpmrcSecrets() {
	if r.snap != nil {
		r.redactor.AddFrom(npmrcSource, redact.SnapshotNpmrcValues(r.snap.Dir)...)
	}
}

// redactText is what Checks use to remove the Run's known secrets from a text
// before it is cut or reshaped. It is safe for concurrent use.
func (r *run) redactText(s string) string {
	r.redactMu.Lock()
	defer r.redactMu.Unlock()
	out, _ := r.redactor.String(s)
	return out
}

// collectServiceSecrets adds the values of the project's .env file and of every
// Service's environment that look like secrets (redact.EnvRule) to what is
// redacted, with the forms a log can show them in. A Service's log can echo
// them into a reason in the Report. Like the .npmrc values they are redacted
// whatever the secret scan found, but only in texts: the values are not
// necessarily secrets, so they are never replaced inside a path, a Check or
// rule ID, a Service name or an image reference. The names of the variables
// whose values stay readable are kept for the Report's Limitation.
func (r *run) collectServiceSecrets() {
	if r.proj == nil {
		return
	}
	left, registered := map[string]bool{}, map[string]bool{}
	take := func(where string, env map[string]string) {
		sel := redact.SelectEnv(env)
		for _, v := range sel.Values {
			r.redactor.AddTextOnlyFrom(where+" "+sel.Sources[v], v)
		}
		for _, name := range sel.Left {
			left[name] = true
		}
		for name, v := range env {
			if redact.LooksLikeSecret(name, v) {
				registered[name] = true
			}
		}
	}
	take(".env", r.proj.DotEnv)
	for _, s := range r.proj.Services {
		take("Service "+s.Name+" environment", s.Env)
	}
	r.envLeft = nil
	for name := range left {
		if !registered[name] {
			r.envLeft = append(r.envLeft, name)
		}
	}
	sort.Strings(r.envLeft)
}

// maxNamedEnv is how many variable names the Limitation lists.
const maxNamedEnv = 10

// envRuleLimitation tells the reader which rule decided what was redacted of
// the project's environment values, when it left some readable. It returns nil
// when it left none.
func envRuleLimitation(left []string) *resultset.Limitation {
	if len(left) == 0 {
		return nil
	}
	names := left
	more := ""
	if len(names) > maxNamedEnv {
		more = fmt.Sprintf(" and %d more", len(names)-maxNamedEnv)
		names = names[:maxNamedEnv]
	}
	return &resultset.Limitation{
		ReasonCode: "env_values_left_readable",
		Message: redact.EnvRule + " Values of these variables were left readable: " + strings.Join(names, ", ") + more +
			". Secrets found by the secret scan and in .npmrc files are always redacted.",
	}
}

// redactSet removes every known secret from the result set and its artifacts
// and records what happened in report_completeness. It runs before Finalize,
// so digests, sizes and the capped evidence all come from redacted text.
func (r *run) redactSet(s *resultset.Set) {
	count := r.redactor.Apply(s)
	if l := envRuleLimitation(r.envLeft); l != nil {
		s.Limitations = append(s.Limitations, *l)
	}
	reason, _ := r.redactor.String(r.scan.reason)
	s.ReportCompleteness.Redaction = redactionOutcome(r.scan, reason, count)
	if !s.ReportCompleteness.Redaction.Applied {
		r.log.Printf("warning: secret redaction is incomplete: %s", *s.ReportCompleteness.Redaction.Reason)
	}
}

// explainInvalid adds to the error of a Report that failed its validation what
// redaction did to the failing fields: which fields it rewrote and which rule or
// source registered the values it replaced there, by name and never by value.
// A value that is also a word of the Report's own vocabulary is protected (see
// redact.VocabularyTag), so a rewritten field is a text or an identifier; the
// lines tell which.
func (r *run) explainInvalid(err *writer.InvalidReportError) {
	for _, line := range r.redactor.Explain(err.Problems) {
		err.Notes = append(err.Notes, "  "+line)
	}
}

// redactionOutcome says whether redaction was applied. It was only if the
// secret scan completed: otherwise secrets the scan would have found may still
// be in the Report. Values from .npmrc files and the .env and Service environment
// values that look like secrets (redact.EnvRule) are redacted in any case.
func redactionOutcome(scan secretScan, redactedReason string, count int) resultset.Redaction {
	out := resultset.Redaction{Count: count}
	if scan.seen && scan.status == resultset.StatusCompleted {
		out.Applied = true
		return out
	}
	var reason string
	if !scan.seen {
		reason = "no secret scan ran, so only values from .npmrc files and .env and Service environment values that look like secrets were redacted"
	} else {
		reason = fmt.Sprintf("the secret scan did not complete (%s), so only values from .npmrc files and .env and Service environment values that look like secrets were redacted", scan.status)
		if redactedReason != "" {
			reason += ": " + redactedReason
		}
	}
	out.Reason = &reason
	return out
}
