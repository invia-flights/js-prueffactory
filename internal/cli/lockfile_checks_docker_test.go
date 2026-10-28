//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of the lockfile Checks: a whole Run on the lockfile-problems
// testdata project, looked at through report.json. The Checks themselves need
// no container, but the Run also runs syntax.parse, so these need a Docker
// daemon.

func lockfileExecution(t *testing.T, s *resultset.Set, check string) resultset.Execution {
	t.Helper()
	var got []resultset.Execution
	for _, e := range s.Checks {
		if e.CheckID == check && e.Applicability != resultset.NotApplicable {
			got = append(got, e)
		}
	}
	if len(got) != 1 {
		t.Fatalf("%s executions = %+v, want one", check, got)
	}
	return got[0]
}

func countByRule(fs []resultset.Finding) map[string]int {
	out := map[string]int{}
	for _, f := range fs {
		if f.RuleID != nil {
			out[*f.RuleID]++
		}
	}
	return out
}

func TestLockfileProblemsProjectProvesEveryRuleAndCount(t *testing.T) {
	original := copyProject(t, "lockfile-problems")

	// The project's lockfile is hand-written and points at hosts that do not
	// exist, so it can never be installed. Leave the install out.
	r := realRun(t, context.Background(), "test", original, "--exclude", "package.install,deps.tree,quality.unused,modules.cycles,types.javascript,types.strictness,lint.typed,sbom.generate")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: the lockfile Checks only warn\nstderr:\n%s", r.code, r.stderr)
	}
	for _, id := range lockfileCheckIDs {
		if e := lockfileExecution(t, &r.set, id); e.Status != resultset.StatusCompleted || e.Gate != 0 {
			t.Errorf("%s = status %s, %d Gates", id, e.Status, e.Gate)
		}
	}

	want := map[string]int{
		"integrity-missing": 1, "integrity-weak": 2, "resolved-not-https": 1, "resolved-unexpected-host": 1,
		"dependency-git": 1, "dependency-file": 1, "dependency-http": 1, "dependency-url": 1,
	}
	got := countByRule(findingsOf(&r.set, "security.integrity"))
	for rule, n := range want {
		if got[rule] != n {
			t.Errorf("security.integrity %s = %d, want %d", rule, got[rule], n)
		}
	}
	if len(got) != len(want) {
		t.Errorf("security.integrity rules = %v", got)
	}
	for _, f := range findingsOf(&r.set, "security.integrity") {
		if f.Severity != resultset.SeverityWarning || f.Gate {
			t.Errorf("finding = %+v, want a warning without a Gate", f)
		}
	}

	if n := len(findingsOf(&r.set, "package.install-scripts")) + len(findingsOf(&r.set, "security.licenses")); n != 0 {
		t.Errorf("the side indicators reported %d findings", n)
	}

	licenses := map[string]float64{}
	var scripts []string
	for _, m := range r.set.Metrics {
		switch {
		case m.CheckID == "package.install-scripts" && strings.HasPrefix(m.Name, "install_script:"):
			scripts = append(scripts, strings.TrimPrefix(m.Name, "install_script:"))
		case m.CheckID == "package.install-scripts" && m.Name == "install_scripts":
			if m.Value == nil || *m.Value != 2 {
				t.Errorf("install_scripts = %+v, want 2", m)
			}
		case m.CheckID == "security.licenses" && m.Value != nil:
			licenses[strings.TrimPrefix(m.Name, "license:")] = *m.Value
		case m.CheckID == "package.install-scripts" && m.Name == "allow_scripts_policy":
			if m.Value == nil || *m.Value != 0 {
				t.Errorf("allow_scripts_policy = %+v, want 0", m)
			}
		}
	}
	if strings.Join(scripts, ",") != "node_modules/git-dep,node_modules/no-integrity" {
		t.Errorf("install script entries = %v", scripts)
	}
	for k, v := range map[string]float64{"MIT": 6, "ISC": 3, "(MIT OR Apache-2.0)": 1, "none_in_lockfile": 2} {
		if licenses[k] != v {
			t.Errorf("license %q = %v, want %v", k, licenses[k], v)
		}
	}
	r.assertNothingLeft(t)
}

func TestTheLockfileChecksOfAYarnPackageAreUnsupportedAndLeaveLockfileIntegrityUnknown(t *testing.T) {
	original := copyProject(t, "yarn-unsupported")

	r := realRun(t, context.Background(), "benchmark", original)

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2: an unsupported package manager leaves the Run incomplete\nstderr:\n%s", r.code, r.stderr)
	}
	install := lockfileExecution(t, &r.set, "package.install")
	for _, id := range lockfileCheckIDs {
		e := lockfileExecution(t, &r.set, id)
		if e.Status != resultset.StatusUnsupported || e.ReasonCode == nil || *e.ReasonCode != "package_manager_unsupported" {
			t.Errorf("%s = status %s, reason %v, want unsupported with package_manager_unsupported", id, e.Status, e.ReasonCode)
		}
		if e.Reason == nil || install.Reason == nil || *e.Reason != *install.Reason {
			t.Errorf("%s reason = %v, want the reason of package.install, %v", id, e.Reason, install.Reason)
		}
		if n := len(findingsOf(&r.set, id)); n != 0 {
			t.Errorf("%s has %d findings", id, n)
		}
	}
	p := benchmarkPart(t, &r.set, "lockfile_integrity")
	if p.State != resultset.PartUnknown || p.Score != nil {
		t.Errorf("lockfile integrity = %+v, want unknown", p)
	}
	r.assertNothingLeft(t)
}

func TestAVersion1LockfileMakesTheLockfileChecksUnsupportedInARun(t *testing.T) {
	original := copyProject(t, "lockfile-problems")
	v1 := `{"name": "lockfile-problems", "lockfileVersion": 1, "requires": true, "dependencies": {}}`
	if err := os.WriteFile(filepath.Join(original, "package-lock.json"), []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--exclude", "package.install,deps.tree,quality.unused,modules.cycles,types.javascript,types.strictness,lint.typed,sbom.generate")

	for _, id := range lockfileCheckIDs {
		e := lockfileExecution(t, &r.set, id)
		if e.Status != resultset.StatusUnsupported || e.ReasonCode == nil || *e.ReasonCode != "lockfile_version_unsupported" {
			t.Errorf("%s = status %s, reason %v", id, e.Status, e.ReasonCode)
		}
		if n := len(findingsOf(&r.set, id)); n != 0 {
			t.Errorf("%s has %d findings", id, n)
		}
	}
	r.assertNothingLeft(t)
}
