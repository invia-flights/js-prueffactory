package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// structuredRun is one artifacts.structured execution on a made-up project.
type structuredRun struct {
	applicability resultset.Applicability
	reason        string
	result        *checks.Result
}

// runStructured writes the files into a new folder, runs discovery on it and
// runs the Check in the project Context, the way the engine does. The Check is
// native, so no Docker is involved.
func runStructured(t *testing.T, files map[string]string) *structuredRun {
	t.Helper()
	dir := t.TempDir()
	for rel, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
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
	impl := checks.Implementation("artifacts.structured")
	if impl == nil {
		t.Fatal("artifacts.structured has no implementation")
	}
	ctxt := &proj.Contexts[0]
	run := &structuredRun{}
	run.applicability, run.reason = impl.Applicability(proj, ctxt)
	if run.applicability == resultset.NotApplicable {
		return run
	}
	run.result = impl.Run(context.Background(), &checks.Input{
		Project: proj, Context: ctxt, OriginalPath: dir, SnapshotDir: dir,
	})
	return run
}

// findingFor returns the Finding whose primary location is the path.
func (r *structuredRun) findingFor(t *testing.T, path string) resultset.Finding {
	t.Helper()
	for _, f := range r.result.Findings {
		if len(f.Locations) > 0 && f.Locations[0].Path == path {
			return f
		}
	}
	t.Fatalf("no Finding for %s in %+v", path, r.result.Findings)
	return resultset.Finding{}
}

func (r *structuredRun) assertNoFindings(t *testing.T) {
	t.Helper()
	if r.result == nil {
		t.Fatalf("the Check was not applicable: %s", r.reason)
	}
	if r.result.Status != resultset.StatusCompleted || len(r.result.Findings) != 0 {
		var got []string
		for _, f := range r.result.Findings {
			got = append(got, f.Locations[0].Path+": "+f.Evidence[0].Text)
		}
		t.Fatalf("status %s (%s), findings %v", r.result.Status, r.result.Reason, got)
	}
}

func TestStructuredCheckIsImplementedForTheProjectContext(t *testing.T) {
	e, ok := checks.Lookup("artifacts.structured")
	if !ok {
		t.Fatal("artifacts.structured not in the Catalog")
	}
	if e.Status != checks.Implemented || e.Scope != checks.PerProject || !e.CanFireGates || e.Area != "validity" {
		t.Errorf("entry = %+v", e)
	}
}

func TestBrokenJSONIsAGateWithLineAndColumn(t *testing.T) {
	r := runStructured(t, map[string]string{
		"config/app.json": "{\n  \"name\": \"demo\",\n  \"port\": 80,\n}\n",
	})
	if r.result.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s: %s", r.result.Status, r.result.Reason)
	}
	f := r.findingFor(t, "config/app.json")
	if !f.Gate || f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceConfirmed || f.InTestData {
		t.Errorf("a broken file should be a confirmed Gate: %+v", f)
	}
	if f.CheckID != "artifacts.structured" || f.ContextID != "C-0001" {
		t.Errorf("check/context = %s/%s", f.CheckID, f.ContextID)
	}
	start := f.Locations[0].Start
	if start == nil || start.Line != 4 || start.Column == nil || *start.Column != 1 {
		t.Errorf("location = %+v, want 4:1 (the closing brace after the trailing comma)", start)
	}
	if f.Locations[0].FileSHA256 == "" || len(f.Evidence) == 0 || f.Evidence[0].Trust != resultset.TrustUntrusted {
		t.Errorf("hash/evidence missing: %+v", f)
	}
	if len(f.Reproduction.Rerun) == 0 {
		t.Error("no re-run command")
	}
}

const jsoncSample = "{\n  // a comment\n  \"compilerOptions\": { /* inline */ \"strict\": true },\n  \"url\": \"http://example.com//not-a-comment\"\n}\n"

func TestValidJSONPassesAndEmptyProjectIsNotApplicable(t *testing.T) {
	runStructured(t, map[string]string{
		"package.json":  `{"name":"demo"}`,
		"data/bom.json": "\xef\xbb\xbf[1, 2, 3]\n",
	}).assertNoFindings(t)

	r := runStructured(t, map[string]string{"index.js": "module.exports = 1;\n"})
	if r.applicability != resultset.NotApplicable || r.reason == "" {
		t.Errorf("applicability = %s (%q), want not_applicable with a reason", r.applicability, r.reason)
	}
}

func TestCommentsAreAcceptedOnlyInTheFilesThatAllowThem(t *testing.T) {
	allowed := []string{
		"tsconfig.json", "tsconfig.build.json", "packages/a/tsconfig.base.json", "jsconfig.json",
		".eslintrc.json", "biome.json", "biome.jsonc", ".devcontainer/devcontainer.json",
		".vscode/settings.json", "app/.vscode/launch.json",
	}
	files := map[string]string{}
	for _, p := range allowed {
		files[p] = jsoncSample
	}
	runStructured(t, files).assertNoFindings(t)

	for _, p := range []string{"package.json", "config.json", "vscode/settings.json", ".vscode/sub/settings.json", "mytsconfig.json"} {
		r := runStructured(t, map[string]string{p: jsoncSample})
		f := r.findingFor(t, p)
		s := f.Locations[0].Start
		if !f.Gate || s == nil || s.Line != 2 || s.Column == nil || *s.Column != 3 {
			t.Errorf("%s: comments are not allowed here, want a Gate at 2:3, got %+v", p, f)
		}
	}
}

func TestTrailingCommasAreAcceptedOnlyWhereTheToolsAcceptThem(t *testing.T) {
	const trailing = "{\n  \"a\": [1, 2,],\n  \"b\": 1, // note\n}\n"
	runStructured(t, map[string]string{"tsconfig.json": trailing, ".vscode/settings.json": trailing}).assertNoFindings(t)
	r := runStructured(t, map[string]string{"biome.json": trailing})
	r.findingFor(t, "biome.json")
}

const gitlabCI = `stages: [test]
.base:
  script:
    - echo base
test:
  script:
    - !reference [.base, script]
    - echo done
  variables:
    SECRET: !vault |
      $ANSIBLE_VAULT;1.1;AES256
`

func TestYAMLWithSeveralDocumentsAndCustomTagsIsAccepted(t *testing.T) {
	runStructured(t, map[string]string{
		".gitlab-ci.yml":    gitlabCI,
		"k8s/all.yaml":      "apiVersion: v1\nkind: A\n---\napiVersion: v1\nkind: B\n---\n",
		"empty.yaml":        "",
		"comments-only.yml": "# nothing here\n",
	}).assertNoFindings(t)
}

func TestBrokenYAMLIsAGateWithItsLine(t *testing.T) {
	r := runStructured(t, map[string]string{
		"ci/pipeline.yml": "stages:\n  - test\nbuild:\n  script: @run\n",
		"second.yaml":     "a: 1\n---\nb: [\n",
		"tabs.yaml":       "a:\n\t- b\n",
	})
	for path, wantLine := range map[string]int{"ci/pipeline.yml": 4, "second.yaml": 3, "tabs.yaml": 2} {
		f := r.findingFor(t, path)
		if !f.Gate || f.Title != "YAML file does not parse" || f.RuleID == nil || *f.RuleID != "invalid-yaml" {
			t.Errorf("%s: %+v", path, f)
		}
		if s := f.Locations[0].Start; s == nil || s.Line != wantLine {
			t.Errorf("%s: location = %+v, want line %d", path, s, wantLine)
		}
	}
}

// A UTF-8 text that was decoded as Windows-1252 once leaves U+009D in a
// description. The parser refuses it without saying where, so the Check finds
// the character itself.
func TestYAMLWithAControlCharacterIsAGateAtTheCharacter(t *testing.T) {
	r := runStructured(t, map[string]string{"api.yml": "a: 1\nb: x\nnote: \"say â€\u009dhi\"\n"})
	f := r.findingFor(t, "api.yml")
	if !f.Gate || f.RuleID == nil || *f.RuleID != "invalid-yaml" {
		t.Fatalf("want an invalid-yaml Gate: %+v", f)
	}
	if s := f.Locations[0].Start; s == nil || s.Line != 3 || s.Column == nil || *s.Column != 14 {
		t.Errorf("location = %+v, want line 3, column 14", s)
	}
	if got := f.Evidence[0].Text; !strings.Contains(got, "U+009D") {
		t.Errorf("evidence %q does not name the character", got)
	}
}

func TestYAMLErrorWithoutALineIsStillAGateAtTheFile(t *testing.T) {
	r := runStructured(t, map[string]string{"anchors.yaml": "x: 1\ny: *nope\n"})
	f := r.findingFor(t, "anchors.yaml")
	if !f.Gate || f.Locations[0].Start != nil || f.Locations[0].FileSHA256 == "" {
		t.Errorf("want a Gate that points at the file only: %+v", f)
	}
}

func TestBrokenFileInTestDataIsOnlyANote(t *testing.T) {
	r := runStructured(t, map[string]string{
		"test/fixtures/broken.json": "{",
		"testdata/bad.yaml":         "a:\n\t- b\n",
		"src/broken.json":           "{",
	})
	for _, p := range []string{"test/fixtures/broken.json", "testdata/bad.yaml"} {
		f := r.findingFor(t, p)
		if f.Gate || f.Severity != resultset.SeverityNote || !f.InTestData {
			t.Errorf("%s: a Test data file should be a note: %+v", p, f)
		}
	}
	if f := r.findingFor(t, "src/broken.json"); !f.Gate || f.InTestData {
		t.Errorf("src/broken.json should be a Gate: %+v", f)
	}
	gates := 0
	for _, f := range r.result.Findings {
		if f.Gate {
			gates++
		}
	}
	if gates != 1 {
		t.Errorf("gates = %d, want 1", gates)
	}
}

func TestBuildOutputAndHelmTemplatesAreSkippedAndListed(t *testing.T) {
	r := runStructured(t, map[string]string{
		"dist/bundle.json":              "{",
		"packages/ui/build/a.yaml":      "a:\n\t- b\n",
		"packages/ui/build/b.json":      "{",
		"deploy/chart/Chart.yaml":       "name: chart\nversion: 1.0.0\n",
		"deploy/chart/values.yaml":      "replicas: 2\n",
		"deploy/chart/templates/d.yaml": "kind: Deployment\nspec: {{ .Values.spec }}\n",
		"deploy/chart/templates/c.json": "{{ .Values.x }}",
		"templates/not-a-chart.json":    "{",
		"src/ok.json":                   "{}",
	})
	if r.result.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s: %s", r.result.Status, r.result.Reason)
	}
	if len(r.result.Findings) != 1 || r.result.Findings[0].Locations[0].Path != "templates/not-a-chart.json" {
		t.Fatalf("only the templates/ folder without a Chart.yaml is checked, got %+v", r.result.Findings)
	}
	skipped := map[string]string{}
	for _, l := range r.result.Limitations {
		skipped[*l.Path] = l.ReasonCode
		if l.CheckID == nil || *l.CheckID != "artifacts.structured" {
			t.Errorf("limitation without the Check ID: %+v", l)
		}
	}
	want := map[string]string{
		"dist":                   "build_output_skipped",
		"packages/ui/build":      "build_output_skipped",
		"deploy/chart/templates": "helm_templates_skipped",
	}
	for p, code := range want {
		if skipped[p] != code {
			t.Errorf("limitations = %v, want %s for %s", skipped, code, p)
		}
	}
}

func TestChartAtTheProjectRootSkipsItsTemplatesToo(t *testing.T) {
	runStructured(t, map[string]string{
		"Chart.yaml":          "name: chart\n",
		"templates/svc.yaml":  "a: {{ .x }}\n",
		"templates/_cfg.json": "{{ x }}",
	}).assertNoFindings(t)
}

func TestFindingsComeSortedByPathAndKeepStableFingerprints(t *testing.T) {
	files := map[string]string{"b/x.json": "{", "a/y.json": "{", "c/z.yaml": "a:\n\t- b\n"}
	r := runStructured(t, files)
	var paths []string
	for _, f := range r.result.Findings {
		paths = append(paths, f.Locations[0].Path)
	}
	if !slices.IsSorted(paths) || len(paths) != 3 {
		t.Errorf("paths = %v", paths)
	}
	again := runStructured(t, files)
	for i := range r.result.Findings {
		if r.result.Findings[i].Fingerprint != again.result.Findings[i].Fingerprint {
			t.Errorf("fingerprint of %s differs between runs", paths[i])
		}
	}
}

func TestUnterminatedCommentAndTruncatedFilesAreGatesAtTheRightPlace(t *testing.T) {
	r := runStructured(t, map[string]string{
		"tsconfig.json": "{\n  /* never closed\n  \"a\": 1\n}\n",
		"cut.json":      "{\n  \"héllo\": \"wörld\",\n  \"x\":",
		"wide.json":     "{\"ключ\": }",
		"empty.json":    "",
	})
	cases := map[string][2]int{
		"tsconfig.json": {2, 3},
		"cut.json":      {3, 7},
		"wide.json":     {1, 10},
		"empty.json":    {1, 1},
	}
	for p, want := range cases {
		s := r.findingFor(t, p).Locations[0].Start
		if s == nil || s.Line != want[0] || s.Column == nil || *s.Column != want[1] {
			t.Errorf("%s: location = %+v, want %d:%d", p, s, want[0], want[1])
		}
	}
}
