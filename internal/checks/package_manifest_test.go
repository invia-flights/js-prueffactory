package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests run package.manifest natively, as the engine does: on a
// Snapshot folder, without Docker.

const lock3 = `{
  "name": "x", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "x", "dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}},
    "node_modules/a": {"version": "1.2.0"},
    "node_modules/b": {"version": "2.1.4", "dev": true}
  }
}`

const manifestOK = `{"name": "x", "dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}}`

// runManifest writes the files into a new project folder and runs
// package.manifest in the root package Context.
func runManifest(t *testing.T, files map[string]string) *checks.Result {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := proj.Contexts[1]
	impl := checks.Implementation("package.manifest")
	if impl == nil {
		t.Fatal("package.manifest is not implemented")
	}
	return impl.Run(context.Background(), &checks.Input{
		Project: proj, Context: &ctx, OriginalPath: "/original", SnapshotDir: dir,
	})
}

func ruleOf(f resultset.Finding) string {
	if f.RuleID == nil {
		return ""
	}
	return *f.RuleID
}

func findingsByRule(res *checks.Result) map[string][]resultset.Finding {
	out := map[string][]resultset.Finding{}
	for _, f := range res.Findings {
		out[ruleOf(f)] = append(out[ruleOf(f)], f)
	}
	return out
}

func TestPackageManifestIsImplementedNativeAndPerPackage(t *testing.T) {
	e, ok := checks.Lookup("package.manifest")
	if !ok || e.Status != checks.Implemented || e.Scope != checks.PerPackage || !e.CanFireGates {
		t.Fatalf("entry = %+v", e)
	}
	if _, runsContainers := checks.Implementation("package.manifest").(checks.ImageUser); runsContainers {
		t.Error("package.manifest runs natively and must not need an image")
	}
}

func TestPackageManifestOnlyAppliesToPackages(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	impl := checks.Implementation("package.manifest")
	if a, _ := impl.Applicability(proj, &proj.Contexts[0]); a != resultset.NotApplicable {
		t.Errorf("project Context: %s", a)
	}
	if a, _ := impl.Applicability(proj, &proj.Contexts[1]); a != resultset.Applicable {
		t.Errorf("package Context: %s", a)
	}
}

func TestConsistentManifestAndLockfileCompleteWithoutFindings(t *testing.T) {
	res := runManifest(t, map[string]string{"package.json": manifestOK, "package-lock.json": lock3})
	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 || len(res.Limitations) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if len(res.Metrics) != 1 || res.Metrics[0].Name != "package_manager" || res.Metrics[0].Reason == nil ||
		*res.Metrics[0].Reason != "npm (found by package-lock.json)" {
		t.Errorf("the detected package manager must be recorded: %+v", res.Metrics)
	}
}

func TestBrokenPackageJsonIsAGateWithItsPosition(t *testing.T) {
	res := runManifest(t, map[string]string{"package.json": "{\n  \"name\": \"x\",\n  \"version\": \n}\n", "package-lock.json": lock3})
	got := findingsByRule(res)["manifest-invalid"]
	if len(got) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	f := got[0]
	if !f.Gate || f.Severity != resultset.SeverityError || f.Locations[0].Path != "package.json" ||
		f.Locations[0].Start == nil || f.Locations[0].Start.Line != 4 || f.Locations[0].FileSHA256 == "" {
		t.Errorf("finding = %+v", f)
	}
	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s: the lockfile was still checked", res.Status)
	}
}

func TestBrokenLockfileIsAGate(t *testing.T) {
	res := runManifest(t, map[string]string{"package.json": manifestOK, "package-lock.json": "{\"lockfileVersion\": 3,"})
	got := findingsByRule(res)["lockfile-invalid"]
	if len(got) != 1 || !got[0].Gate || got[0].Locations[0].Path != "package-lock.json" {
		t.Fatalf("findings = %+v", res.Findings)
	}
}

func TestADependencyMissingFromTheLockfileIsAGateNamingIt(t *testing.T) {
	res := runManifest(t, map[string]string{
		"package.json":      `{"dependencies": {"a": "^1.0.0", "z": "^9.0.0"}, "devDependencies": {"b": "~2.1.0"}}`,
		"package-lock.json": lock3,
	})
	got := findingsByRule(res)["lockfile-missing-dependency"]
	if len(got) != 1 || !got[0].Gate || got[0].Expected == nil || *got[0].Expected != "^9.0.0" {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if got[0].Locations[0].Path != "package.json" || got[0].Reproduction.VerifiedBy[0] != "package.manifest" {
		t.Errorf("finding = %+v", got[0])
	}
}

func TestASpecifierThatDoesNotMatchTheLockfileIsAGate(t *testing.T) {
	res := runManifest(t, map[string]string{
		"package.json":      `{"dependencies": {"a": "^2.0.0"}, "devDependencies": {"b": "~2.1.0"}}`,
		"package-lock.json": lock3,
	})
	got := findingsByRule(res)["lockfile-specifier-mismatch"]
	if len(got) != 1 || !got[0].Gate || *got[0].Expected != "^2.0.0" || *got[0].Actual != "^1.0.0" {
		t.Fatalf("findings = %+v", res.Findings)
	}
}

func TestAMissingLockfileIsAWarningNotAGate(t *testing.T) {
	res := runManifest(t, map[string]string{"package.json": manifestOK})
	got := findingsByRule(res)["lockfile-missing"]
	if len(got) != 1 || got[0].Gate || got[0].Severity != resultset.SeverityWarning {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s", res.Status)
	}
}

func TestLockfilesOfSeveralManagersAreAWarning(t *testing.T) {
	res := runManifest(t, map[string]string{
		"package.json": manifestOK, "package-lock.json": lock3, "yarn.lock": "# yarn lockfile v1\n",
	})
	got := findingsByRule(res)["lockfile-multiple-managers"]
	if len(got) != 1 || got[0].Gate || got[0].Severity != resultset.SeverityWarning {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if len(got[0].Locations) != 2 {
		t.Errorf("both lockfiles should be located: %+v", got[0].Locations)
	}
}

func TestTwoNpmLockfilesAreNotSeveralManagers(t *testing.T) {
	res := runManifest(t, map[string]string{
		"package.json": manifestOK, "package-lock.json": lock3, "npm-shrinkwrap.json": lock3,
	})
	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v", res.Findings)
	}
}

func TestAVersion1LockfileMakesTheLockfileCheckUnsupportedWithItsReason(t *testing.T) {
	res := runManifest(t, map[string]string{
		"package.json": manifestOK, "package-lock.json": `{"lockfileVersion": 1, "dependencies": {}}`,
	})
	if len(res.Findings) != 0 {
		t.Errorf("a version 1 lockfile is not a defect: %+v", res.Findings)
	}
	if res.Status != resultset.StatusPartial || res.ReasonCode != "lockfile_version_unsupported" || res.Reason == "" {
		t.Errorf("status %s, code %q, reason %q", res.Status, res.ReasonCode, res.Reason)
	}
	if len(res.Limitations) != 1 || res.Limitations[0].ReasonCode != "lockfile_version_unsupported" {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}

func TestAPackageThatUsesAnotherManagerIsParsedButItsLockfileIsNotChecked(t *testing.T) {
	res := runManifest(t, map[string]string{"package.json": manifestOK, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"})
	if len(res.Findings) != 0 || res.Status != resultset.StatusPartial || res.ReasonCode != "package_manager_unsupported" {
		t.Fatalf("res = %+v", res)
	}
	if *res.Metrics[0].Reason != "pnpm (found by pnpm-lock.yaml)" {
		t.Errorf("metric = %+v", res.Metrics[0])
	}
}

func TestFindingsOfANestedPackageUseProjectRelativePaths(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "svc"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The root package is fine; the nested one has no lockfile.
	for name, content := range map[string]string{"package.json": "{}", "package-lock.json": `{"lockfileVersion": 3, "packages": {"": {}}}`, "svc/package.json": "{}"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := proj.Contexts[2]
	res := checks.Implementation("package.manifest").Run(context.Background(), &checks.Input{
		Project: proj, Context: &ctx, OriginalPath: "/original", SnapshotDir: dir,
	})
	got := findingsByRule(res)["lockfile-missing"]
	if len(got) != 1 || got[0].Locations[0].Path != "svc/package.json" {
		t.Fatalf("findings = %+v", res.Findings)
	}
}
