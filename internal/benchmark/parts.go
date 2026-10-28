package benchmark

import (
	"regexp"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// partInput is what a part's measure sees: the Findings of the completed
// executions of the part's Checks, and the Contexts those ran in. Executions
// that did not complete never get this far; the part is unknown or the
// project's fault before its measure runs.
type partInput struct {
	set      *resultset.Set
	findings []resultset.Finding
	contexts map[string]bool
	// metrics are the Metrics of the same executions, for parts that score a
	// measurement instead of counting Findings.
	metrics []resultset.Metric
}

// measurement is what a part's measure reports.
type measurement struct {
	// raw is the number the formula starts from.
	raw float64
	// nEff is the damped count, for parts that damp repeated hits. A count-based
	// part uses it in place of raw.
	nEff *float64
	// score is given by parts that are not count-based, such as the manifest.
	score *float64
	// fault is a reason code. The project is at fault and the part scores 0.
	fault string
}

func fixedScore(v float64) *float64 { return &v }

// --- the rules the scorer reads from other Checks ---
//
// These names are part of what those Checks report. A change there shows up
// in the Docker-backed tests of seam A, which score real projects.

const (
	ruleRunnerMissing  = "test-runner-not-installed"
	ruleFileLoadFailed = "test-file-load-failed"
	ruleLockfileAbsent = "lockfile-missing"
	ruleHelmTemplate   = "helm.template"
	ruleGitlabSchema   = "gitlab-ci.schema"
	ruleGitlabYAML     = "gitlab-ci.yaml"

	evidenceAdvisorySeverity = "advisory_severity"
	evidenceDependencyScope  = "dependency_scope"
)

func ruleOf(f *resultset.Finding) string {
	if f.RuleID == nil {
		return ""
	}
	return *f.RuleID
}

// primaryPath is the project path a Finding points at, or "" without one.
func primaryPath(f *resultset.Finding) string {
	if len(f.Locations) == 0 {
		return ""
	}
	return f.Locations[0].Path
}

// --- generic measures ---

// measureDampedHits counts the Findings that pass keep (all when nil), damps
// repeated hits of one rule, and scores n_eff.
func measureDampedHits(keep func(*resultset.Finding) bool) func(*partInput) measurement {
	return func(in *partInput) measurement {
		perRule := map[string]int{}
		hits := 0
		for i := range in.findings {
			f := &in.findings[i]
			if keep != nil && !keep(f) {
				continue
			}
			perRule[ruleOf(f)]++
			hits++
		}
		n := nEff(perRule)
		return measurement{raw: float64(hits), nEff: &n}
	}
}

// measureFiles counts the distinct files that the Findings passing keep point
// at. A Finding without a path counts as a file of its own.
func measureFiles(keep func(*resultset.Finding) bool) func(*partInput) measurement {
	return func(in *partInput) measurement {
		files := map[string]bool{}
		for i := range in.findings {
			f := &in.findings[i]
			if keep != nil && !keep(f) {
				continue
			}
			p := primaryPath(f)
			if p == "" {
				p = "finding:" + f.ID
			}
			files[p] = true
		}
		return measurement{raw: float64(len(files))}
	}
}

// --- Tests ---

// measurePassRate is the mean over the (suite, test file) pairs of
// passed/found, so a file two suites load counts once per suite. A focused
// test that passed counts as not passed. A file that failed to load counts as
// one pair with rate 0, and a suite that failed to load as one pair too. A missing runner, or no test at all, is the project's
// fault.
func measurePassRate(in *partInput) measurement {
	type fileKey struct{ ctx, suite, file string }
	type counts struct{ found, passed int }
	files := map[fileKey]counts{}

	for i := range in.findings {
		if ruleOf(&in.findings[i]) == ruleRunnerMissing {
			return measurement{fault: "test_runner_not_installed"}
		}
	}
	for _, tf := range in.set.Inventory.TestFiles {
		if in.contexts[tf.ContextID] && tf.Found > 0 {
			files[fileKey{tf.ContextID, tf.Suite, tf.File}] = counts{tf.Found, max(tf.Passed-tf.PassedFocused, 0)}
		}
	}
	for i := range in.findings {
		f := &in.findings[i]
		if ruleOf(f) != ruleFileLoadFailed {
			continue
		}
		suite := ""
		if f.Suite != nil {
			suite = *f.Suite
		}
		k := fileKey{f.ContextID, suite, primaryPath(f)}
		if _, known := files[k]; !known {
			files[k] = counts{found: 1}
		}
	}
	if len(files) == 0 {
		return measurement{fault: "no_tests"}
	}
	sum := 0.0
	for _, c := range files {
		sum += float64(c.passed) / float64(c.found)
	}
	pct := 100 * sum / float64(len(files))
	return measurement{raw: pct, score: &pct}
}

// --- Validity ---

// measureManifest scores the worst package: broken or inconsistent is 0, a
// missing lockfile is 50, otherwise 100.
func measureManifest(in *partInput) measurement {
	broken, missing := 0, 0
	for i := range in.findings {
		f := &in.findings[i]
		switch {
		case f.Gate:
			broken++
		case ruleOf(f) == ruleLockfileAbsent:
			missing++
		}
	}
	switch {
	case broken > 0:
		return measurement{raw: float64(broken), score: fixedScore(0)}
	case missing > 0:
		return measurement{raw: float64(missing), score: fixedScore(50)}
	}
	return measurement{score: fixedScore(100)}
}

// measureInstall scores 0 when an install failed because of the project.
func measureInstall(in *partInput) measurement {
	failures := 0
	for i := range in.findings {
		if in.findings[i].Gate {
			failures++
		}
	}
	if failures > 0 {
		return measurement{raw: float64(failures), score: fixedScore(0)}
	}
	return measurement{score: fixedScore(100)}
}

var helmChartInMessage = regexp.MustCompile(`chart in (.+?) does not render with its `)

// measureHelm counts the charts that fail to render, with any values file. The
// chart is named in the Finding's message; without that, its folder is taken
// from the Finding's path.
func measureHelm(in *partInput) measurement {
	charts := map[string]bool{}
	for i := range in.findings {
		f := &in.findings[i]
		if !f.Gate || ruleOf(f) != ruleHelmTemplate {
			continue
		}
		chart := ""
		if m := helmChartInMessage.FindStringSubmatch(f.Message); m != nil {
			chart = m[1]
		}
		if chart == "" {
			chart = dir(primaryPath(f))
		}
		charts[chart] = true
	}
	return measurement{raw: float64(len(charts))}
}

// measureGitlabCI counts the invalid files and the other problems that make
// GitLab reject the pipeline: a missing local include, and a reference to a
// job or stage that does not exist. A file with several schema errors counts
// once. Notes, such as references while an include is unresolved, never count.
func measureGitlabCI(in *partInput) measurement {
	problems := map[string]bool{}
	for i := range in.findings {
		f := &in.findings[i]
		if !f.Gate {
			continue
		}
		switch ruleOf(f) {
		case ruleGitlabSchema, ruleGitlabYAML:
			problems["file:"+primaryPath(f)] = true
		default:
			problems["finding:"+f.Fingerprint.Value] = true
		}
	}
	return measurement{raw: float64(len(problems))}
}

// measureKubernetes counts the invalid resources. The Check merges one
// resource that several values files render into one Gate Finding, so the
// Gates are the resources. Notes never count.
func measureKubernetes(in *partInput) measurement {
	n := 0
	for i := range in.findings {
		if in.findings[i].Gate {
			n++
		}
	}
	return measurement{raw: float64(n)}
}

// measureCompose counts the compose sets that `docker compose config` rejects.
// The Check reports at most one Gate per set, because compose stops at its
// first error. A missing variable is a warning and never counts.
func measureCompose(in *partInput) measurement {
	n := 0
	for i := range in.findings {
		if in.findings[i].Gate {
			n++
		}
	}
	return measurement{raw: float64(n)}
}

func dir(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "."
}

// --- Security ---

// measureSecrets scores 0 for any secret outside Test data and Test code. A
// secret in Test code is still reported, but tests that use made-up tokens are
// normal, so it does not decide the Security area.
func measureSecrets(in *partInput) measurement {
	n := 0
	for i := range in.findings {
		if f := &in.findings[i]; !f.InTestData && !f.InTestCode {
			n++
		}
	}
	if n > 0 {
		return measurement{raw: float64(n), score: fixedScore(0)}
	}
	return measurement{score: fixedScore(100)}
}

// Weights of the vulnerability value V.
var (
	severityWeight = map[string]float64{"critical": 10, "high": 5, "moderate": 2, "low": 0.5}
	scopeWeight    = map[string]float64{"prod": 1.0, "dev": 0.25}
)

// measureVulnerabilities is V, the sum over the merged advisories of severity
// weight times scope weight. An advisory that states no severity counts as
// moderate and one without a scope as production, the way the Check reports
// them.
func measureVulnerabilities(in *partInput) measurement {
	v := 0.0
	for i := range in.findings {
		f := &in.findings[i]
		sev, scope := "moderate", "prod"
		for _, ev := range f.Evidence {
			switch ev.Kind {
			case evidenceAdvisorySeverity:
				if _, known := severityWeight[ev.Text]; known {
					sev = ev.Text
				}
			case evidenceDependencyScope:
				if _, known := scopeWeight[ev.Text]; known {
					scope = ev.Text
				}
			}
		}
		v += severityWeight[sev] * scopeWeight[scope]
	}
	return measurement{raw: v}
}

// --- Code correctness ---

// measureSuppressions counts the Suppression comments in Source code and Test
// code, which is all the Check records.
func measureSuppressions(in *partInput) measurement {
	n := 0
	for _, s := range in.set.Inventory.Suppressions {
		if s.FileClass == "source" || s.FileClass == "test_code" {
			n += s.Count
		}
	}
	return measurement{raw: float64(n)}
}

// measureTypeCoverage is the type coverage percentage over Source code, as it
// is: the score is the percentage. With several packages it is the mean of
// their percentages weighted by their identifier counts, which is the share of
// typed identifiers over all of them; without counts it is the plain mean. A
// package without identifiers is fully covered.
func measureTypeCoverage(in *partInput) measurement {
	type pkg struct{ percent, identifiers *float64 }
	byContext := map[string]*pkg{}
	for _, m := range in.metrics {
		if m.Value == nil {
			continue
		}
		p := byContext[m.ContextID]
		if p == nil {
			p = &pkg{}
			byContext[m.ContextID] = p
		}
		switch m.Name {
		case "type_coverage_percent":
			p.percent = m.Value
		case "type_coverage_identifiers":
			p.identifiers = m.Value
		}
	}
	sum, weight, plainSum, n := 0.0, 0.0, 0.0, 0
	for _, p := range byContext {
		if p.percent == nil {
			continue
		}
		plainSum += *p.percent
		n++
		if p.identifiers != nil {
			sum += *p.percent * *p.identifiers
			weight += *p.identifiers
		}
	}
	pct := 100.0
	switch {
	case weight > 0:
		pct = sum / weight
	case n > 0:
		pct = plainSum / float64(n)
	}
	return measurement{raw: pct, score: &pct}
}

// sortedKeys returns the keys of a set in order.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
