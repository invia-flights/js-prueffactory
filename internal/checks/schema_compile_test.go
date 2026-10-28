package checks

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func discoverFiles(t *testing.T, files map[string]string) (*discovery.Project, string) {
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
	return proj, dir
}

func targetPaths(targets []schemaTarget) map[string]string {
	out := map[string]string{}
	for _, tg := range targets {
		out[tg.Path] = tg.Draft
	}
	return out
}

func TestSchemaCompileIsImplementedForTheProjectContext(t *testing.T) {
	entry, ok := Lookup("schema.compile")
	if !ok || entry.Status != Implemented || entry.Scope != PerProject || !entry.CanFireGates {
		t.Fatalf("schema.compile = %+v, want implemented in the project Context and able to fire Gates", entry)
	}
}

func TestEveryJSONOrYAMLFileWhoseTopLevelSchemaNamesAKnownDraftIsATarget(t *testing.T) {
	proj, _ := discoverFiles(t, map[string]string{
		"package.json": `{"name":"x"}`,
		"d4.json":      `{"$schema":"http://json-schema.org/draft-04/schema#","type":"object"}`,
		"d6.json":      `{"$schema":"http://json-schema.org/draft-06/schema","type":"object"}`,
		"d7.json":      `{"$schema":"https://json-schema.org/draft-07/schema#"}`,
		"d2019.yaml":   "$schema: https://json-schema.org/draft/2019-09/schema\ntype: object\n",
		"d2020.yml":    "\"$schema\": \"https://json-schema.org/draft/2020-12/schema\"\ntype: string\n",
		// Not targets: no $schema, an unknown draft, $schema below the top
		// level, a file that is not an object, a file that does not parse.
		"plain.json":                   `{"type":"object"}`,
		"draft03.json":                 `{"$schema":"http://json-schema.org/draft-03/schema#"}`,
		"tsconfig.json":                `{"$schema":"https://json.schemastore.org/tsconfig"}`,
		"nested.json":                  `{"definitions":{"a":{"$schema":"http://json-schema.org/draft-07/schema#"}}}`,
		"list.json":                    `[{"$schema":"http://json-schema.org/draft-07/schema#"}]`,
		"broken.json":                  `{"$schema":"http://json-schema.org/draft-07/schema#",`,
		"notes.txt":                    `{"$schema":"http://json-schema.org/draft-07/schema#"}`,
		"node_modules/dep/schema.json": `{"$schema":"http://json-schema.org/draft-07/schema#"}`,
	})

	targets, _ := schemaTargets(proj)

	want := map[string]string{
		"d4.json": "draft-04", "d6.json": "draft-06", "d7.json": "draft-07",
		"d2019.yaml": "2019-09", "d2020.yml": "2020-12",
	}
	got := targetPaths(targets)
	if len(got) != len(want) {
		t.Fatalf("targets = %v, want %v", got, want)
	}
	for p, d := range want {
		if got[p] != d {
			t.Errorf("%s: draft = %q, want %q (targets %v)", p, got[p], d, got)
		}
	}
}

func TestAYAMLSchemaIsHandedOverAsJSON(t *testing.T) {
	proj, _ := discoverFiles(t, map[string]string{
		"s.yaml": "$schema: https://json-schema.org/draft/2020-12/schema\ntype: object\nrequired: [a]\nproperties:\n  a: {type: integer, default: 3}\n",
	})

	targets, _ := schemaTargets(proj)

	if len(targets) != 1 {
		t.Fatalf("targets = %+v", targets)
	}
	got := string(targets[0].Schema)
	for _, want := range []string{`"type":"object"`, `"required":["a"]`, `"default":3`} {
		if !strings.Contains(got, want) {
			t.Errorf("schema = %s, want it to contain %s", got, want)
		}
	}
}

func TestSchemaTargetsAreReadSafely(t *testing.T) {
	proj, dir := discoverFiles(t, map[string]string{
		"ok.json":  `{"$schema":"http://json-schema.org/draft-07/schema#"}`,
		"big.json": `{"$schema":"http://json-schema.org/draft-07/schema#","pad":"` + strings.Repeat("x", maxSchemaBytes) + `"}`,
	})
	outside := filepath.Join(t.TempDir(), "secret.json")
	if err := os.WriteFile(outside, []byte(`{"$schema":"http://json-schema.org/draft-07/schema#"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.json")); err != nil {
		t.Fatal(err)
	}
	// The Project was discovered without the link; add it as the Snapshot would list it.
	proj.Files = append(proj.Files, discovery.File{Path: "link.json", Class: discovery.Classify("link.json")})

	targets, _ := schemaTargets(proj)

	got := targetPaths(targets)
	if len(got) != 1 || got["ok.json"] == "" {
		t.Errorf("targets = %v, want only ok.json: a symbolic link and a file over the size cap are never read", got)
	}
}

func TestSchemaTargetsStayWithinTheTotalBudget(t *testing.T) {
	files := map[string]string{}
	for i := 0; i < maxSchemaFiles+5; i++ {
		files[fmt.Sprintf("s/%05d.json", i)] = `{"$schema":"http://json-schema.org/draft-07/schema#"}`
	}
	proj, _ := discoverFiles(t, files)

	targets, skipped := schemaTargets(proj)

	if len(targets) > maxSchemaFiles || len(targets)+len(skipped) != len(files) {
		t.Errorf("targets = %d, skipped = %d of %d files", len(targets), len(skipped), len(files))
	}
}

func TestSchemaCompileAppliesOnlyWhenTheProjectHasASchema(t *testing.T) {
	with, _ := discoverFiles(t, map[string]string{"s.json": `{"$schema":"http://json-schema.org/draft-07/schema#"}`})
	got, reason := Implementation("schema.compile").Applicability(with, &with.Contexts[0])
	if got != resultset.Applicable {
		t.Errorf("applicability = %v (%s)", got, reason)
	}

	without, _ := discoverFiles(t, map[string]string{"package.json": `{"name":"x"}`, "data.json": `{"a":1}`})
	got, reason = Implementation("schema.compile").Applicability(without, &without.Contexts[0])
	if got != resultset.NotApplicable || reason == "" {
		t.Errorf("applicability = %v (%q), want not_applicable with a reason", got, reason)
	}
}

func schemaInput(t *testing.T, files map[string]string) (*Input, []schemaTarget) {
	t.Helper()
	proj, dir := discoverFiles(t, files)
	targets, _ := schemaTargets(proj)
	return &Input{Project: proj, Context: &proj.Contexts[0], OriginalPath: "/original", SnapshotDir: dir}, targets
}

const draft07 = `{"$schema":"http://json-schema.org/draft-07/schema#"}`

func TestACompileFailureIsAGateAndAStrictModeOnlyProblemIsAWarning(t *testing.T) {
	in, _ := schemaInput(t, map[string]string{"broken.json": draft07, "loose.json": draft07, "fine.json": draft07})
	out := schemaCompileOutput{Version: "8.20.0", Schemas: []schemaCompileResult{
		{Path: "broken.json", Draft: "draft-04", Lax: &schemaProblem{Kind: "unresolved-ref", Message: "can't resolve reference #/definitions/x"}},
		{Path: "loose.json", Draft: "draft-07", Strict: &schemaProblem{Kind: "strict-mode", Message: `unknown keyword: "foo"`}},
		{Path: "fine.json", Draft: "2020-12"},
	}}

	res := interpretSchemaCompile(in, out)

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v, want one for each problem and none for the clean file", res.Findings)
	}
	byPath := map[string]resultset.Finding{}
	for _, f := range res.Findings {
		byPath[f.Locations[0].Path] = f
	}
	gate := byPath["broken.json"]
	if !gate.Gate || gate.Severity != resultset.SeverityError || gate.Confidence != resultset.ConfidenceConfirmed || *gate.RuleID != "unresolved-ref" {
		t.Errorf("a schema that does not compile is a confirmed Gate: %+v", gate)
	}
	if gate.Locations[0].FileSHA256 == "" || len(gate.Evidence) != 1 || gate.Evidence[0].Trust != resultset.TrustUntrusted {
		t.Errorf("location or evidence missing: %+v", gate)
	}
	warn := byPath["loose.json"]
	if warn.Gate || warn.Severity != resultset.SeverityWarning || *warn.RuleID != "strict-mode" {
		t.Errorf("a strict-mode-only problem is a warning and never a Gate: %+v", warn)
	}
	if res.Tool == nil || res.Tool.Name != "ajv" || res.Tool.Version == nil || *res.Tool.Version != "8.20.0" {
		t.Errorf("tool = %+v", res.Tool)
	}
	names := map[string]bool{}
	for _, tr := range res.ContextTools {
		names[tr.Name] = tr.Digest != nil && tr.Version != ""
	}
	for _, n := range []string{"ajv", "ajv-draft-04", "ajv-formats"} {
		if !names[n] {
			t.Errorf("context tools = %+v, missing %s", res.ContextTools, n)
		}
	}
}

func TestProblemsInTestDataAreOnlyNotes(t *testing.T) {
	in, _ := schemaInput(t, map[string]string{"test/fixtures/bad.json": draft07, "test/fixtures/loose.json": draft07})
	out := schemaCompileOutput{Version: "8.20.0", Schemas: []schemaCompileResult{
		{Path: "test/fixtures/bad.json", Draft: "draft-07", Lax: &schemaProblem{Kind: "invalid-schema", Message: "schema is invalid"}},
		{Path: "test/fixtures/loose.json", Draft: "draft-07", Strict: &schemaProblem{Kind: "strict-mode", Message: "unknown keyword"}},
	}}

	res := interpretSchemaCompile(in, out)

	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		if f.Gate || f.Severity != resultset.SeverityNote {
			t.Errorf("Test data only gets notes: %+v", f)
		}
	}
}

func TestARemoteReferenceThatWasNotFetchedMakesTheCheckPartialWithALimitation(t *testing.T) {
	in, _ := schemaInput(t, map[string]string{"r.json": draft07})
	out := schemaCompileOutput{Version: "8.20.0", Schemas: []schemaCompileResult{
		{Path: "r.json", Draft: "draft-07", Remote: []string{"http://remote.example/y.json"}},
	}}

	res := interpretSchemaCompile(in, out)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "remote_ref_not_fetched" {
		t.Fatalf("status = %s (%s), want partial", res.Status, res.ReasonCode)
	}
	if len(res.Findings) != 0 {
		t.Errorf("a remote reference that cannot be fetched is not a Finding: %+v", res.Findings)
	}
	if len(res.Limitations) != 1 || res.Limitations[0].Path == nil || *res.Limitations[0].Path != "r.json" ||
		!strings.Contains(res.Limitations[0].Message, "http://remote.example/y.json") {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}

func TestTheHelperGetsParsedSchemasAndNeverAProjectPath(t *testing.T) {
	_, targets := schemaInput(t, map[string]string{"-x.json": `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}`})

	raw := schemaHelperInput(targets)

	if !strings.Contains(string(raw), `"path":"-x.json"`) || !strings.Contains(string(raw), `"type":"object"`) || !strings.Contains(string(raw), `"modules":"/toolset/node_modules"`) {
		t.Errorf("input = %s", raw)
	}
}
