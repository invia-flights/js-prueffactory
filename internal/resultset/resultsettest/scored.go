package resultsettest

import (
	"fmt"
	"sort"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Project is a hand-made benchmark-mode result set of a small, clean project:
// every Check the Benchmark scores has completed in the Context it belongs to,
// without Findings. Tests change what they care about, add Findings and call
// Done. The Benchmark section is still not_requested; the scorer fills it.
type Project struct {
	Set *resultset.Set
	n   int
}

// scoredExecs lists the executions of the clean project: the Check, the
// Context it runs in and whether it has something to examine.
var scoredExecs = []struct {
	check, ctx string
	applicable bool
}{
	{"artifacts.structured", "C-0001", true},
	{"security.secrets", "C-0001", true},
	{"quality.suppressions", "C-0001", true},
	{"quality.size", "C-0001", true},
	{"quality.clones", "C-0001", true},
	{"api.lint", "C-0001", false},
	{"repository.dockerfile", "C-0001", false},
	{"repository.shell", "C-0001", false},
	{"repository.helm", "C-0001", false},
	{"repository.gitlab-ci", "C-0001", false},
	{"repository.kubernetes", "C-0001", false},
	{"repository.compose", "C-0001", false},
	{"repository.github-actions", "C-0001", false},
	{"schema.compile", "C-0001", false},
	{"package.manifest", "C-0002", true},
	{"package.install", "C-0002", true},
	{"syntax.parse", "C-0002", true},
	{"tests.existing", "C-0002", true},
	{"tests.smells", "C-0002", true},
	{"tests.flaky", "C-0002", true},
	{"runtime.unhandled-rejections", "C-0002", true},
	{"security.dependencies", "C-0002", true},
	{"security.integrity", "C-0002", true},
	{"security.patterns", "C-0002", true},
	{"security.licenses", "C-0002", true},
	{"package.install-scripts", "C-0002", true},
	{"lint.correctness", "C-0002", true},
	{"lint.existing", "C-0002", false},
	{"schema.drift", "C-0002", false},
	{"deps.tree", "C-0002", true},
	{"deps.engines", "C-0002", true},
	{"quality.metrics", "C-0002", true},
	{"quality.unused", "C-0002", true},
	{"modules.cycles", "C-0002", true},
	{"types.javascript", "C-0002", true},
}

// ScoredProject builds the clean project. Its one package has a test file with
// four tests that all passed.
func ScoredProject() *Project {
	s := Minimal()
	s.Run.Command = "benchmark"
	s.Checks = nil
	s.Selection.EffectiveChecks = nil
	s.Selection.DeselectedChecks = nil
	for i, e := range scoredExecs {
		ex := resultset.Execution{
			ID: fmt.Sprintf("e%d", i+1), CheckID: e.check, Family: family(e.check), ContextID: e.ctx, Selected: true,
			Applicability: resultset.Applicable, Status: resultset.StatusCompleted,
		}
		if !e.applicable {
			ex.Applicability, ex.Status = resultset.NotApplicable, resultset.StatusNotStarted
		}
		s.Checks = append(s.Checks, ex)
		s.Selection.EffectiveChecks = append(s.Selection.EffectiveChecks, e.check)
	}
	sort.Strings(s.Selection.EffectiveChecks)
	s.Selection.EffectiveChecks = unique(s.Selection.EffectiveChecks)

	digest := "sha256:" + SHA
	npm := "11.1.0"
	eslint := SHA
	rules := "cd" + SHA[2:]
	osv := time.Date(2026, 10, 26, 3, 0, 0, 0, time.UTC).Format(time.RFC3339)
	s.Contexts[1].Node = &resultset.NodeRuntime{Version: "24.1.0", Source: "default", Image: "node:24.1.0-bookworm-slim", ImageDigest: digest, Variant: "debian"}
	s.Contexts[1].NPM = &npm
	s.Contexts[1].Tools = []resultset.ToolRef{
		{Name: "eslint-config", Version: "abababababab", Digest: &eslint},
		{Name: "osv-advisory-database", Version: osv},
		{Name: "prueffactory-security-rules", Version: "cdcdcdcdcdcd", Digest: &rules},
	}
	s.Profiles.BenchmarkProfile = nil
	s.Inventory.Tests = []resultset.PackageTests{{ContextID: "C-0002", Found: 4, Run: 4, Passed: 4}}
	s.Inventory.TestSuites = []resultset.SuiteTests{{ContextID: "C-0002", Suite: "scripts.test", Found: 4, Run: 4, Passed: 4}}
	s.Inventory.TestFiles = []resultset.TestFileCount{{ContextID: "C-0002", Suite: "scripts.test", File: "test/a.test.js", Found: 4, Passed: 4}}
	return &Project{Set: s}
}

func family(check string) string {
	for i := 0; i < len(check); i++ {
		if check[i] == '.' {
			return check[:i]
		}
	}
	return check
}

func unique(sorted []string) []string {
	var out []string
	for i, v := range sorted {
		if i == 0 || v != sorted[i-1] {
			out = append(out, v)
		}
	}
	return out
}

// Execution returns the execution of a Check, to change its status or
// Applicability. It panics for a Check the project does not have.
func (p *Project) Execution(checkID string) *resultset.Execution {
	for i := range p.Set.Checks {
		if p.Set.Checks[i].CheckID == checkID {
			return &p.Set.Checks[i]
		}
	}
	panic("resultsettest: the scored project has no execution of " + checkID)
}

// Status gives a Check the status and reason code of a Check that did not
// complete.
func (p *Project) Status(checkID string, status resultset.ExecStatus, reasonCode string) {
	e := p.Execution(checkID)
	e.Status = status
	if reasonCode != "" {
		e.ReasonCode = &reasonCode
	}
}

// Applicable makes a Check that has nothing to examine applicable and completed.
func (p *Project) Applicable(checkID string) {
	e := p.Execution(checkID)
	e.Applicability, e.Status = resultset.Applicable, resultset.StatusCompleted
}

// NotApplicable makes a Check have nothing to examine.
func (p *Project) NotApplicable(checkID string) {
	e := p.Execution(checkID)
	e.Applicability, e.Status = resultset.NotApplicable, resultset.StatusNotStarted
}

// Deselect takes a Check out of the Selection.
func (p *Project) Deselect(checkID string) {
	e := p.Execution(checkID)
	e.Selected, e.Status = false, resultset.StatusNotStarted
	var effective []string
	for _, id := range p.Set.Selection.EffectiveChecks {
		if id != checkID {
			effective = append(effective, id)
		}
	}
	p.Set.Selection.EffectiveChecks = effective
	p.Set.Selection.DeselectedChecks = append(p.Set.Selection.DeselectedChecks, checkID)
	p.Set.Selection.IsStandardScope = false
}

// DeselectByFast takes a Check out of the Selection the way --fast does: it
// is deselected with the reason deselected_by_fast and the Selection records
// --fast.
func (p *Project) DeselectByFast(checkID string) {
	p.Deselect(checkID)
	code, reason := resultset.ReasonDeselectedByFast, "skipped by --fast"
	e := p.Execution(checkID)
	e.ReasonCode, e.Reason = &code, &reason
	p.Set.Selection.Fast = true
}

// Add adds a Finding of a Check. The mods change it before it is added.
func (p *Project) Add(checkID, rule string, gate bool, mods ...func(*resultset.Finding)) {
	e := p.Execution(checkID)
	p.n++
	r := rule
	sev := resultset.SeverityWarning
	if gate {
		sev = resultset.SeverityError
	}
	title := fmt.Sprintf("%s hit %d", rule, p.n)
	f := resultset.Finding{
		ID: fmt.Sprintf("tmp-%d", p.n), CheckID: checkID, ExecutionID: e.ID, ContextID: e.ContextID, RuleID: &r,
		Fingerprint: resultset.NewFingerprint(checkID, rule, "src/a.js", title),
		Kind:        resultset.KindDefect, Severity: sev, Confidence: resultset.ConfidenceLikely, Gate: gate,
		Title: title, Message: title,
		Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: "src/a.js", FileSHA256: SHA,
			Start: &resultset.Position{Line: p.n}}},
		Reproduction: resultset.Reproduction{
			Rerun: []string{"js-prueffactory", "benchmark", "/work/demo", "--only", checkID}, VerifiedBy: []string{checkID}},
	}
	for _, m := range mods {
		m(&f)
	}
	p.Set.Findings = append(p.Set.Findings, f)
}

// AtPath puts a Finding at another file.
func AtPath(path string) func(*resultset.Finding) {
	return func(f *resultset.Finding) { f.Locations[0].Path = path }
}

// InTestData marks a Finding as lying in Test data.
func InTestData(f *resultset.Finding) { f.InTestData = true }

// InTestCode marks a Finding as lying in Test code.
func InTestCode(f *resultset.Finding) { f.InTestCode = true }

// Evidence adds an evidence item to a Finding.
func Evidence(kind, text string) func(*resultset.Finding) {
	return func(f *resultset.Finding) {
		f.Evidence = append(f.Evidence, resultset.Evidence{Kind: kind, Text: text, Origin: "test", Trust: resultset.TrustUntrusted})
	}
}

// TestFiles replaces the package's per-file test counts, and the package's
// counts with them. The files belong to the package Context.
func (p *Project) TestFiles(files ...resultset.TestFileCount) {
	inv := &p.Set.Inventory.Tests[0]
	inv.Found, inv.Passed = 0, 0
	p.Set.Inventory.TestFiles = nil
	for _, f := range files {
		f.ContextID = "C-0002"
		if f.Suite == "" {
			f.Suite = "scripts.test"
		}
		p.Set.Inventory.TestFiles = append(p.Set.Inventory.TestFiles, f)
		inv.Found += f.Found
		inv.Passed += f.Passed
	}
	inv.Run = inv.Passed
	p.Set.Inventory.TestSuites = []resultset.SuiteTests{{ContextID: "C-0002", Suite: "scripts.test",
		Found: inv.Found, Run: inv.Run, Passed: inv.Passed}}
}

// AddExecution adds a completed, selected, applicable execution of a Check the
// project does not have yet, in the project Context or the package Context.
func (p *Project) AddExecution(checkID, contextID string) {
	p.Set.Checks = append(p.Set.Checks, resultset.Execution{
		ID: fmt.Sprintf("added-%s", checkID), CheckID: checkID, Family: family(checkID), ContextID: contextID, Selected: true,
		Applicability: resultset.Applicable, Status: resultset.StatusCompleted,
	})
	p.Set.Selection.EffectiveChecks = append(p.Set.Selection.EffectiveChecks, checkID)
	sort.Strings(p.Set.Selection.EffectiveChecks)
}

// Metric adds a measurement of a Check, in the Context of its execution.
func (p *Project) Metric(checkID, name string, value float64, unit string) {
	e := p.Execution(checkID)
	v := value
	p.n++
	p.Set.Metrics = append(p.Set.Metrics, resultset.Metric{
		ID: fmt.Sprintf("tmp-m%d", p.n), CheckID: checkID, ContextID: e.ContextID, Name: name, Value: &v, Unit: unit,
	})
}

// Done finalizes the set and returns it.
func (p *Project) Done() *resultset.Set {
	p.Set.Finalize()
	return p.Set
}
