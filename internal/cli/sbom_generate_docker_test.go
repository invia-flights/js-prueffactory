//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of sbom.generate with a real Docker daemon. The Check reads the
// lockfile and needs no registry, except for a package without a lockfile,
// whose install does.

// sbomOf reads the SBOM artifact of the only sbom.generate execution.
func sbomOf(t *testing.T, r *dockerRun) (resultset.Execution, *resultset.Artifact, []byte) {
	t.Helper()
	e := oneExecution(t, &r.set, "sbom.generate")
	art := artifactOf(&r.set, e, "C-0002-sbom.cdx.json")
	if art == nil {
		t.Fatalf("artifacts of sbom.generate = %v, want the SBOM\nstatus %s, reason %v", e.ArtifactIDs, e.Status, e.Reason)
	}
	raw, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(art.Path)))
	if err != nil {
		t.Fatal(err)
	}
	return e, art, raw
}

// lockfileEntries counts the entries of the lockfile of a project but the root.
func lockfileEntries(t *testing.T, project string) int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(project, "package-lock.json"))
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Packages map[string]json.RawMessage `json:"packages"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		t.Fatal(err)
	}
	return len(lock.Packages) - 1
}

func TestTheSBOMOfACleanProjectIsACycloneDXArtifactWithOneComponentPerLockfileEntry(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "sbom.generate")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	e, art, raw := sbomOf(t, r)
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeObservationsOnly || e.Gate != 0 || len(e.FindingIDs) != 0 {
		t.Fatalf("sbom.generate = %+v, want completed, observations_only, no Gate and no Findings", e)
	}
	if got := findingsOf(&r.set, "sbom.generate"); len(got) != 0 {
		t.Errorf("findings = %+v, want none", got)
	}
	if art.MediaType != "application/vnd.cyclonedx+json" || art.Path != "artifacts/sbom.generate/C-0002-sbom.cdx.json" {
		t.Errorf("artifact = %+v", art)
	}

	var bom struct {
		BOMFormat  string            `json:"bomFormat"`
		Components []json.RawMessage `json:"components"`
	}
	if err := json.Unmarshal(raw, &bom); err != nil {
		t.Fatalf("the SBOM is no JSON: %v", err)
	}
	want := lockfileEntries(t, original)
	if bom.BOMFormat != "CycloneDX" || len(bom.Components) != want {
		t.Errorf("SBOM: format %q with %d components, want CycloneDX with %d (one per lockfile entry)", bom.BOMFormat, len(bom.Components), want)
	}
	var metric *resultset.Metric
	for i, m := range r.set.Metrics {
		if m.CheckID == "sbom.generate" {
			metric = &r.set.Metrics[i]
		}
	}
	if metric == nil || metric.Name != "sbom_components" || metric.Value == nil || int(*metric.Value) != want {
		t.Errorf("metric = %+v, want sbom_components %d", metric, want)
	}
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "sbom_entries_incomplete" {
			t.Errorf("limitation %+v: every entry of the lockfile has resolved and integrity", l)
		}
	}
	if e.Tool == nil || e.Tool.Name != "npm sbom" {
		t.Errorf("tool = %+v", e.Tool)
	}
	r.assertNothingLeft(t)
}

func TestLockfileEntriesWithoutResolvedOrIntegrityAreOneLimitationThatNamesThem(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	path := filepath.Join(original, "package-lock.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var lock map[string]any
	if err := json.Unmarshal(data, &lock); err != nil {
		t.Fatal(err)
	}
	entries := lock["packages"].(map[string]any)
	delete(entries["node_modules/ansi-regex"].(map[string]any), "integrity")
	delete(entries["node_modules/ansi-colors"].(map[string]any), "resolved")
	delete(entries["node_modules/ansi-colors"].(map[string]any), "integrity")
	if data, err = json.MarshalIndent(lock, "", "  "); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "sbom.generate")

	e, _, _ := sbomOf(t, r)
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeObservationsOnly {
		t.Fatalf("sbom.generate = %+v", e)
	}
	var got []resultset.Limitation
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "sbom_entries_incomplete" {
			got = append(got, l)
		}
	}
	if len(got) != 1 || got[0].CheckID == nil || *got[0].CheckID != "sbom.generate" || got[0].Path == nil || *got[0].Path != "package-lock.json" {
		t.Fatalf("limitations = %+v, want one sbom_entries_incomplete", r.set.Limitations)
	}
	for _, want := range []string{"2 lockfile entries", "`ansi-colors@4.1.3`", "`ansi-regex@5.0.1`"} {
		if !strings.Contains(got[0].Message, want) {
			t.Errorf("message lacks %q: %s", want, got[0].Message)
		}
	}
	if f := findingsOf(&r.set, "sbom.generate"); len(f) != 0 || r.code != 0 {
		t.Errorf("exit = %d, findings = %+v: incomplete entries are a Limitation, never a Finding or Gate", r.code, f)
	}
}

func TestAPackageWithoutALockfileGetsTheSBOMOfTheLockfileItsInstallProduced(t *testing.T) {
	original := copyProject(t, "no-lockfile")

	r := realRun(t, context.Background(), "test", original, "--only", "sbom.generate")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	e, _, raw := sbomOf(t, r)
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeObservationsOnly {
		t.Fatalf("sbom.generate = %+v", e)
	}
	if got := withoutSecretScan(r.set.Selection.PrerequisitesRun); len(got) != 1 || got[0] != "package.install" {
		t.Errorf("prerequisites_run = %v, want package.install", r.set.Selection.PrerequisitesRun)
	}
	var bom struct {
		Components []struct {
			Name string `json:"name"`
		} `json:"components"`
	}
	if err := json.Unmarshal(raw, &bom); err != nil {
		t.Fatal(err)
	}
	var mocha bool
	for _, c := range bom.Components {
		mocha = mocha || c.Name == "mocha"
	}
	if !mocha || len(bom.Components) < 20 {
		t.Errorf("SBOM has %d components and mocha = %v, want the mocha tree the install locked", len(bom.Components), mocha)
	}
}

func TestTheSBOMPassesThroughRedaction(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	if err := os.WriteFile(filepath.Join(original, ".env"), []byte("API_TOKEN="+envSecret+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// npm copies the description of package.json into the SBOM.
	path := filepath.Join(original, "package.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), "Made-up project", "Token "+envSecret+" in a made-up project", 1))
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "sbom.generate")

	_, art, raw := sbomOf(t, r)
	if strings.Contains(string(raw), envSecret) {
		t.Error("the SBOM artifact holds the secret value of the .env file")
	}
	if !art.Redacted || !strings.Contains(string(raw), redact.Placeholder) {
		t.Errorf("artifact = %+v, want it marked redacted with the placeholder in it", art)
	}
	r.assertNothingLeft(t)
}
