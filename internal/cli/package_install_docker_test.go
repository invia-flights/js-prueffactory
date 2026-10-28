//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of package.install and deps.tree with a real Docker daemon and
// the public npm registry. The npm download cache volume is shared between
// Runs, so only the first install of a package is slow.

// executionsOf returns the applicable executions of a Check, in Context order.
func executionsOf(s *resultset.Set, check string) []resultset.Execution {
	var out []resultset.Execution
	for _, e := range s.Checks {
		if e.CheckID == check && e.Applicability != resultset.NotApplicable {
			out = append(out, e)
		}
	}
	return out
}

// withoutSecretScan drops security.secrets from prerequisites_run: every Run
// performs the secret scan for the sake of redaction, whatever is selected.
func withoutSecretScan(ids []string) []string {
	var out []string
	for _, id := range ids {
		if id != "security.secrets" {
			out = append(out, id)
		}
	}
	return out
}

func oneExecution(t *testing.T, s *resultset.Set, check string) resultset.Execution {
	t.Helper()
	got := executionsOf(s, check)
	if len(got) != 1 {
		t.Fatalf("%s executions = %+v, want one", check, got)
	}
	return got[0]
}

func artifactOf(s *resultset.Set, e resultset.Execution, name string) *resultset.Artifact {
	for _, id := range e.ArtifactIDs {
		for i := range s.Artifacts {
			if s.Artifacts[i].ID == id && strings.HasSuffix(s.Artifacts[i].Path, "/"+name) {
				return &s.Artifacts[i]
			}
		}
	}
	return nil
}

func TestInstallAndDepsTreeCompleteOnACleanProject(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	install := oneExecution(t, &r.set, "package.install")
	if !install.Selected || install.Status != resultset.StatusCompleted || install.Outcome != resultset.OutcomePassed {
		t.Errorf("package.install = %+v", install)
	}
	if got := strings.Join(install.Command, " "); got != "npm ci --no-audit --no-fund" {
		t.Errorf("command = %q, want npm ci with the bundled npm", got)
	}
	if install.Tool == nil || install.Tool.Name != "npm" || install.Tool.Version == nil || !strings.HasPrefix(*install.Tool.Version, "11.") {
		t.Errorf("tool = %+v, want the npm bundled with Node 24", install.Tool)
	}
	// The npm version is recorded in the Context.
	pkg := r.set.Contexts[1]
	if pkg.NPM == nil || install.Tool == nil || install.Tool.Version == nil || *pkg.NPM != *install.Tool.Version {
		t.Errorf("context npm_version = %v", pkg.NPM)
	}
	// The npm log is an artifact, saved in the report folder, with no lockfile
	// artifact because the project has its own lockfile.
	logArtifact := artifactOf(&r.set, install, "npm-install.log")
	if logArtifact == nil {
		t.Fatalf("no npm-install.log artifact: %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(logArtifact.Path)))
	if err != nil || !strings.Contains(string(data), "npm ci --no-audit --no-fund") || !strings.Contains(string(data), "registry.npmjs.org") {
		t.Errorf("npm log = %v %q", err, data)
	}
	if artifactOf(&r.set, install, "package-lock.json") != nil {
		t.Error("a package with a lockfile gets no lockfile artifact")
	}

	tree := oneExecution(t, &r.set, "deps.tree")
	if tree.Status != resultset.StatusCompleted || tree.Outcome != resultset.OutcomePassed {
		t.Errorf("deps.tree = %+v", tree)
	}
	if strings.Join(tree.Command, " ") != "npm ls --all --json" {
		t.Errorf("deps.tree command = %v", tree.Command)
	}
	if len(r.set.Findings) != 0 {
		t.Errorf("findings = %+v", r.set.Findings)
	}
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 0 {
		t.Errorf("both were selected, prerequisites_run = %v", r.set.Selection.PrerequisitesRun)
	}

	// node_modules never leaves the run volume: not in the Original, not in the
	// report folder.
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	_ = filepath.WalkDir(r.reportDir, func(p string, d os.DirEntry, _ error) error {
		if d.Name() == "node_modules" {
			t.Errorf("node_modules in the report folder: %s", p)
		}
		return nil
	})
	r.assertNothingLeft(t)
}

func TestTheNpmCacheVolumeCarriesTheCacheLabelAndSurvivesTheRun(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "package.install")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	out, err := exec.Command("docker", "volume", "inspect", "--format", "{{json .Labels}}", "jspf-cache-npm").Output()
	if err != nil {
		t.Fatalf("the npm cache volume is gone after the Run: %v", err)
	}
	var labels map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &labels); err != nil {
		t.Fatal(err)
	}
	if labels["js-prueffactory.cache"] != "npm" {
		t.Errorf("labels = %v, want the cache label", labels)
	}
	if _, runOwned := labels["js-prueffactory.run-id"]; runOwned {
		t.Errorf("the cache volume must not carry a run label: %v", labels)
	}
	r.assertNothingLeft(t)
}

func TestWithoutALockfileNpmInstallRunsAndTheLockfileIsSavedAsAnArtifact(t *testing.T) {
	original := copyProject(t, "no-lockfile")

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	install := oneExecution(t, &r.set, "package.install")
	if install.Status != resultset.StatusCompleted || strings.Join(install.Command, " ") != "npm install --no-audit --no-fund" {
		t.Errorf("package.install = %+v", install)
	}
	lock := artifactOf(&r.set, install, "package-lock.json")
	if lock == nil {
		t.Fatalf("no lockfile artifact: %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(lock.Path)))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		LockfileVersion int                       `json:"lockfileVersion"`
		Packages        map[string]map[string]any `json:"packages"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil || parsed.LockfileVersion < 2 || parsed.Packages["node_modules/mocha"] == nil {
		t.Errorf("the lockfile artifact is not the lockfile npm install wrote: %v\n%.300s", err, data)
	}
	if _, err := os.Stat(filepath.Join(original, "package-lock.json")); err == nil {
		t.Error("npm install wrote a lockfile into the Original")
	}
	if tree := oneExecution(t, &r.set, "deps.tree"); tree.Status != resultset.StatusCompleted {
		t.Errorf("deps.tree = %+v", tree)
	}
	r.assertNothingLeft(t)
}

func TestALockfileMismatchGetsTheInstallGateAndDepsTreeIsBlockedAsTheProjectsFault(t *testing.T) {
	original := copyProject(t, "lockfile-mismatch")

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	install := oneExecution(t, &r.set, "package.install")
	if install.Status != resultset.StatusCompleted || install.Outcome != resultset.OutcomeFailed || install.Gate != 1 {
		t.Errorf("package.install = %+v, want completed, failed, one Gate", install)
	}
	findings := findingsOf(&r.set, "package.install")
	if len(findings) != 1 || !findings[0].Gate || findings[0].RuleID == nil || *findings[0].RuleID != "lockfile-out-of-sync" {
		t.Fatalf("findings = %+v", findings)
	}
	if text := findings[0].Evidence[0].Text; !strings.Contains(text, "left-pad@1.3.0") || strings.Contains(text, "Usage:") {
		t.Errorf("evidence = %q", text)
	}
	if artifactOf(&r.set, install, "npm-install.log") == nil {
		t.Error("a failed install still saves the npm log")
	}

	tree := oneExecution(t, &r.set, "deps.tree")
	if tree.Status != resultset.StatusBlocked || tree.ReasonCode == nil || *tree.ReasonCode != "prerequisite_failed_project" || tree.Gate != 0 {
		t.Errorf("deps.tree = %+v, want blocked as the project's fault", tree)
	}
	r.assertNothingLeft(t)
}

func TestOnlyDepsTreeRunsTheInstallAsAPrerequisiteWithoutItsFindings(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original, "--only", "deps.tree")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	install := oneExecution(t, &r.set, "package.install")
	if install.Selected || install.Status != resultset.StatusCompleted {
		t.Errorf("package.install = %+v, want an unselected prerequisite that completed", install)
	}
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 1 || got[0] != "package.install" {
		t.Errorf("prerequisites_run = %v", got)
	}
	if got := r.set.Selection.EffectiveChecks; len(got) != 1 || got[0] != "deps.tree" {
		t.Errorf("effective = %v", got)
	}
	if tree := oneExecution(t, &r.set, "deps.tree"); !tree.Selected || tree.Status != resultset.StatusCompleted {
		t.Errorf("deps.tree = %+v", tree)
	}
	r.assertNothingLeft(t)
}

func TestAFailedPrerequisiteThatWasNotSelectedFiresNoGateButBlocksItsDependent(t *testing.T) {
	original := copyProject(t, "lockfile-mismatch")

	r := realRun(t, context.Background(), "test", original, "--only", "deps.tree")

	// Only deps.tree is selected. It is blocked, which is exit 2. The install
	// is not selected, so its Gate does not fire.
	if r.code != 2 {
		t.Fatalf("exit = %d, want 2\nstderr:\n%s", r.code, r.stderr)
	}
	if len(r.set.Findings) != 0 || r.set.Summary.Gates != 0 {
		t.Errorf("a prerequisite reports no Findings and fires no Gates: %+v", r.set.Findings)
	}
	install := oneExecution(t, &r.set, "package.install")
	if install.Selected || install.Gate != 0 || install.Outcome == resultset.OutcomePassed || install.Outcome == resultset.OutcomeFailed {
		t.Errorf("package.install = %+v", install)
	}
	if install.ReasonCode == nil || *install.ReasonCode != "prerequisite_failed_project" {
		t.Errorf("package.install must say that the project made it fail: %+v", install)
	}
	tree := oneExecution(t, &r.set, "deps.tree")
	if tree.Status != resultset.StatusBlocked || tree.ReasonCode == nil || *tree.ReasonCode != "prerequisite_failed_project" {
		t.Errorf("deps.tree = %+v", tree)
	}
	r.assertNothingLeft(t)
}

func TestEveryPackageInstallsInItsOwnContainerAndFolder(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	sub := filepath.Join(original, "tools", "extra")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "package.json"),
		[]byte(`{"name":"extra","version":"1.0.0","private":true,"dependencies":{"left-pad":"1.3.0"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	installs := executionsOf(&r.set, "package.install")
	if len(installs) != 2 {
		t.Fatalf("installs = %+v", installs)
	}
	commands := map[string]string{}
	for _, e := range installs {
		if e.Status != resultset.StatusCompleted {
			t.Errorf("%s = %+v", e.ContextID, e)
		}
		commands[e.ContextID] = strings.Join(e.Command, " ")
	}
	if commands["C-0002"] != "npm ci --no-audit --no-fund" || commands["C-0003"] != "npm install --no-audit --no-fund" {
		t.Errorf("commands = %v", commands)
	}
	for _, c := range r.set.Contexts[1:] {
		if c.NPM == nil {
			t.Errorf("context %s has no npm version", c.ID)
		}
	}
	for _, e := range executionsOf(&r.set, "deps.tree") {
		if e.Status != resultset.StatusCompleted {
			t.Errorf("deps.tree %s = %+v", e.ContextID, e)
		}
	}
	r.assertNothingLeft(t)
}

func TestDepsTreeTurnsAnExtraneousPackageIntoAWarning(t *testing.T) {
	original := copyProject(t, "install-script-stray")

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: a deps.tree problem is a warning and no Gate\nstderr:\n%s", r.code, r.stderr)
	}
	if install := oneExecution(t, &r.set, "package.install"); install.Status != resultset.StatusCompleted || install.Gate != 0 {
		t.Errorf("package.install = %+v", install)
	}
	tree := oneExecution(t, &r.set, "deps.tree")
	if tree.Status != resultset.StatusCompleted || tree.Outcome != resultset.OutcomeObservationsOnly || tree.Gate != 0 {
		t.Errorf("deps.tree = %+v", tree)
	}
	findings := findingsOf(&r.set, "deps.tree")
	if len(findings) != 1 {
		t.Fatalf("findings = %+v", findings)
	}
	f := findings[0]
	if f.RuleID == nil || *f.RuleID != "deps-extraneous" || f.Severity != resultset.SeverityWarning || f.Gate ||
		!strings.Contains(f.Message, "stray@1.0.0") || strings.Contains(f.Message, "/work") {
		t.Errorf("finding = %+v", f)
	}
	r.assertNothingLeft(t)
}

func TestAFailingLifecycleScriptIsTheProjectsFaultAndAGate(t *testing.T) {
	original := copyProject(t, "failing-install-script")

	r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	findings := findingsOf(&r.set, "package.install")
	if len(findings) != 1 || !findings[0].Gate || findings[0].RuleID == nil || *findings[0].RuleID != "lifecycle-script-failed" {
		t.Fatalf("findings = %+v", findings)
	}
	if text := findings[0].Evidence[0].Text; !strings.Contains(text, "command failed") {
		t.Errorf("evidence = %q", text)
	}
	if tree := oneExecution(t, &r.set, "deps.tree"); tree.Status != resultset.StatusBlocked ||
		tree.ReasonCode == nil || *tree.ReasonCode != "prerequisite_failed_project" {
		t.Errorf("deps.tree = %+v", tree)
	}
	r.assertNothingLeft(t)
}

func TestAPnpmOrYarnProjectIsUnsupportedForInstallAndDepsTreeWithTheReason(t *testing.T) {
	for _, c := range []struct{ lockfile, content, want string }{
		{"pnpm-lock.yaml", "lockfileVersion: '9.0'\n", "the package uses pnpm (pnpm-lock.yaml), and js-prueffactory supports only npm"},
		{"yarn.lock", "# yarn lockfile v1\n", "the package uses yarn (yarn.lock), and js-prueffactory supports only npm"},
	} {
		t.Run(c.lockfile, func(t *testing.T) {
			original := copyProject(t, "clean-mocha")
			// The project moved to another package manager: its lockfile replaced package-lock.json.
			if err := os.Remove(filepath.Join(original, "package-lock.json")); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(original, c.lockfile), []byte(c.content), 0o644); err != nil {
				t.Fatal(err)
			}

			r := realRun(t, context.Background(), "test", original, "--only", "package.install,deps.tree")

			if r.code != 2 {
				t.Fatalf("exit = %d, want 2\nstderr:\n%s", r.code, r.stderr)
			}
			for _, id := range []string{"package.install", "deps.tree"} {
				e := oneExecution(t, &r.set, id)
				if e.Status != resultset.StatusUnsupported || e.ReasonCode == nil || *e.ReasonCode != "package_manager_unsupported" ||
					e.Reason == nil || !strings.Contains(*e.Reason, c.want) {
					t.Errorf("%s = %+v, want unsupported with a reason that holds %q", id, e, c.want)
				}
			}
			r.assertNothingLeft(t)
		})
	}
}
