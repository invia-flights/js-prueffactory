//go:build docker

package cli_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of security.dependencies with a real Docker daemon. The advisory
// database lives in a cache volume that every Run on the host shares, so only
// the first Run of the day downloads it.

func TestAVulnerableLockedDependencyGetsOneFindingWithAdvisoryIDAndFix(t *testing.T) {
	original := copyProject(t, "vulnerable-dependency")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "security.dependencies")

	// Advisories are observations: no Gate, so the exit code stays 0.
	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "security.dependencies")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeObservationsOnly || e.Gate != 0 {
		t.Fatalf("security.dependencies = %+v", e)
	}
	if e.Tool == nil || e.Tool.Name != "osv-scanner" || e.Tool.Version == nil || *e.Tool.Version != "2.7.0" {
		t.Errorf("tool = %+v", e.Tool)
	}
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 0 {
		t.Errorf("a package with a lockfile needs no install, prerequisites_run = %v", got)
	}

	var found []resultset.Finding
	for _, f := range r.set.Findings {
		if f.CheckID == "security.dependencies" {
			found = append(found, f)
		}
	}
	if len(found) != 1 {
		t.Fatalf("findings = %+v, want exactly one for minimist 1.2.5", found)
	}
	f := found[0]
	if f.Gate || f.Severity != resultset.SeverityError || f.RuleID == nil || *f.RuleID != "GHSA-xvch-5gv4-984h" {
		t.Errorf("finding = %+v, want an error without Gate and the advisory ID as rule", f)
	}
	for _, want := range []string{"`minimist` 1.2.5", "GHSA-xvch-5gv4-984h", "CVE-2021-44906", "advisory severity critical", "prod dependency", "fixed in 1.2.6", "Advisory database of "} {
		if !strings.Contains(f.Message, want) {
			t.Errorf("message lacks %q: %s", want, f.Message)
		}
	}
	if f.Expected == nil || *f.Expected != "minimist 1.2.6 or later" || f.Actual == nil || *f.Actual != "minimist 1.2.5" {
		t.Errorf("expected/actual = %v / %v", f.Expected, f.Actual)
	}
	evidence := map[string]string{}
	for _, ev := range f.Evidence {
		evidence[ev.Kind] = ev.Text
	}
	if evidence["fixed_version"] != "1.2.6" || evidence["dependency_scope"] != "prod" || evidence["advisory_severity"] != "critical" ||
		!strings.Contains(evidence["advisory_ids"], "GHSA-xvch-5gv4-984h") {
		t.Errorf("evidence = %v", evidence)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "package-lock.json" || f.Locations[0].Start == nil {
		t.Errorf("locations = %+v, want the line of the lockfile entry", f.Locations)
	}

	// The Report records the date of the advisory database, and it is fresh.
	var date string
	for _, tool := range r.set.Contexts[1].Tools {
		if tool.Name == "osv-advisory-database" {
			date = tool.Version
		}
	}
	got, err := time.Parse(time.RFC3339, date)
	if err != nil || time.Since(got) > 25*time.Hour || got.After(time.Now().Add(time.Minute)) {
		t.Errorf("advisory database date = %q (%v)", date, err)
	}
	if evidence["advisory_database_date"] != date {
		t.Errorf("finding date %q != recorded date %q", evidence["advisory_database_date"], date)
	}

	// Packages from the public registry are all covered.
	var notCovered *float64
	for _, m := range r.set.Metrics {
		if m.CheckID == "security.dependencies" && m.Name == "not_covered_by_advisory_data" {
			notCovered = m.Value
		}
	}
	if notCovered == nil || *notCovered != 0 {
		t.Errorf("not_covered_by_advisory_data = %v, want 0", notCovered)
	}

	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestTheAdvisoryDatabaseVolumeIsACacheThatSurvivesTheRun(t *testing.T) {
	original := copyProject(t, "vulnerable-dependency")

	r := realRun(t, context.Background(), "test", original, "--only", "security.dependencies")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	out, err := exec.Command("docker", "volume", "inspect", "--format", `{{index .Labels "js-prueffactory.cache"}}|{{index .Labels "js-prueffactory.run-id"}}`, "jspf-cache-osv-db").Output()
	if err != nil {
		t.Fatalf("the advisory database volume is gone after the Run: %v", err)
	}
	if strings.TrimSpace(string(out)) != "osv-db|" {
		t.Errorf("labels = %q, want the cache label and no run label", out)
	}
	r.assertNothingLeft(t)
}

func TestAProjectOsvScannerConfigCannotSilenceAnAdvisory(t *testing.T) {
	original := copyProject(t, "vulnerable-dependency")
	config := "[[IgnoredVulns]]\nid = \"GHSA-xvch-5gv4-984h\"\nreason = \"trust me\"\n"
	if err := os.WriteFile(filepath.Join(original, "osv-scanner.toml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "security.dependencies")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	n := 0
	for _, f := range r.set.Findings {
		if f.CheckID == "security.dependencies" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("findings = %d, want the advisory reported although the project ignores it", n)
	}
	r.assertNothingLeft(t)
}

func TestAPackageWithoutALockfileIsScannedWithTheLockfileItsInstallProduced(t *testing.T) {
	original := copyProject(t, "no-lockfile")

	r := realRun(t, context.Background(), "test", original, "--only", "security.dependencies")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "security.dependencies")
	if e.Status != resultset.StatusCompleted {
		t.Fatalf("security.dependencies = %+v", e)
	}
	// The install ran as a prerequisite and its lockfile became an artifact.
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 1 || got[0] != "package.install" {
		t.Errorf("prerequisites_run = %v, want package.install", r.set.Selection.PrerequisitesRun)
	}
	install := oneExecution(t, &r.set, "package.install")
	if install.Selected || artifactOf(&r.set, install, "package-lock.json") == nil {
		t.Errorf("package.install = %+v, artifacts = %+v", install, r.set.Artifacts)
	}
	// Findings, if mocha's current dependencies have any, point at the package.json
	// because the Original has no lockfile.
	for _, f := range r.set.Findings {
		if f.CheckID == "security.dependencies" && f.Locations[0].Path != "package.json" {
			t.Errorf("finding location = %+v, want package.json", f.Locations[0])
		}
	}
	r.assertNothingLeft(t)
}

func TestPackagesFromOtherSourcesAreCountedAsNotCoveredAndNeverBreakTheScan(t *testing.T) {
	// The hand-written lockfile has git, file, URL and private-registry entries.
	original := copyProject(t, "lockfile-problems")

	r := realRun(t, context.Background(), "test", original, "--only", "security.dependencies")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "security.dependencies")
	if e.Status != resultset.StatusCompleted {
		t.Fatalf("security.dependencies = %+v", e)
	}
	var notCovered *float64
	for _, m := range r.set.Metrics {
		if m.CheckID == "security.dependencies" && m.Name == "not_covered_by_advisory_data" {
			notCovered = m.Value
		}
	}
	// file-dep, foreign-host, git-dep, http-dep, url-dep and the corp registry package.
	if notCovered == nil || *notCovered < 5 {
		t.Errorf("not_covered_by_advisory_data = %v, want the packages from other sources counted", notCovered)
	}
	// Gaps carry the same fact as a Limitation with the count and the hosts.
	var limitation *resultset.Limitation
	for i, l := range r.set.Limitations {
		if l.ReasonCode == "advisory_data_not_covering" {
			limitation = &r.set.Limitations[i]
		}
	}
	if limitation == nil || limitation.CheckID == nil || *limitation.CheckID != "security.dependencies" {
		t.Fatalf("no advisory_data_not_covering Limitation in %+v", r.set.Limitations)
	}
	if notCovered != nil && !strings.HasPrefix(limitation.Message, fmt.Sprintf("%.0f packages", *notCovered)) {
		t.Errorf("Limitation %q does not start with the count %v", limitation.Message, *notCovered)
	}
	if strings.Contains(limitation.Message, "://") {
		t.Errorf("Limitation %q must name hosts, not URLs", limitation.Message)
	}
	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	gaps, _, _ := strings.Cut(md[strings.Index(md, "## Gaps"):], "\n## Summary")
	if !strings.Contains(gaps, "advisory_data_not_covering") {
		t.Errorf("Gaps lack the Limitation:\n%s", gaps)
	}
	r.assertNothingLeft(t)
}
