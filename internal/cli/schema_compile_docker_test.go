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

// Seam A with a real Docker daemon, for schema.compile.

func TestABrokenLocalRefInADraft04SchemaIsAGateAndValidSchemasCompile(t *testing.T) {
	original := copyProject(t, "repository-files")

	r := realRun(t, context.Background(), "test", original)

	e := executionOf(t, &r.set, "schema.compile")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.ContextID != "C-0001" || e.Gate != 1 {
		t.Fatalf("schema.compile = status %s outcome %s context %s gates %d\nstderr:\n%s", e.Status, e.Outcome, e.ContextID, e.Gate, r.stderr)
	}
	if e.Tool == nil || e.Tool.Version == nil || *e.Tool.Version == "" {
		t.Errorf("tool = %+v", e.Tool)
	}

	gates := gatesByPath(&r.set, "schema.compile")
	f, ok := gates["schemas/legacy.schema.json"]
	if !ok || len(gates) != 1 || *f.RuleID != "unresolved-ref" || !strings.Contains(f.Message, "draft-04") {
		t.Errorf("gates = %+v, want only the draft-04 schema with the broken local $ref", gates)
	}
	for _, f := range findingsOf(&r.set, "schema.compile") {
		if strings.HasPrefix(f.Locations[0].Path, "schemas/order") || strings.HasPrefix(f.Locations[0].Path, "schemas/item") {
			t.Errorf("a valid schema has a finding: %+v", f)
		}
	}

	// The project Context records the three tools with their integrity.
	tools := map[string]resultset.ToolRef{}
	for _, tr := range r.set.Contexts[0].Tools {
		tools[tr.Name] = tr
	}
	for _, name := range []string{"ajv", "ajv-draft-04", "ajv-formats"} {
		if tr, ok := tools[name]; !ok || tr.Version == "" || tr.Digest == nil {
			t.Errorf("project Context tool %s = %+v", name, tr)
		}
	}
	r.assertNothingLeft(t)
}

func TestSchemasResolveRelativeReferencesRemoteOnesAreNotFetchedAndTestDataOnlyGetsNotes(t *testing.T) {
	original := copyProject(t, "repository-files")
	files := map[string]string{
		// A relative reference between schemas without an id, in a folder with
		// glob characters, and a YAML schema.
		"api [v1] {draft}*/a.schema.json": `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"b":{"$ref":"b.schema.yaml"}}}`,
		"api [v1] {draft}*/b.schema.yaml": "$schema: https://json-schema.org/draft/2020-12/schema\ntype: integer\n",
		// A reference to another host: never fetched, so a Limitation and no Finding.
		"schemas/remote.schema.json": `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"x":{"$ref":"http://schemas.invalid/x.json"}}}`,
		// Only strict mode objects to the unknown keyword: a warning.
		"schemas/loose.schema.json": `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","x-internal":true,"frobnicate":1}`,
		// Test data is only ever a note.
		"test/fixtures/bad.schema.json": `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"nonsense"}`,
		// File names that look like options.
		"schemas/-x.schema.json": `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}`,
	}
	for name, content := range files {
		p := filepath.Join(original, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	r := realRun(t, context.Background(), "test", original)

	e := executionOf(t, &r.set, "schema.compile")
	if e.Status != resultset.StatusPartial {
		t.Fatalf("schema.compile status = %s (%v), want partial for the remote reference", e.Status, e.Reason)
	}
	byPath := map[string]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "schema.compile") {
		byPath[f.Locations[0].Path] = f
	}
	for p := range byPath {
		if strings.HasPrefix(p, "api [v1]") || p == "schemas/remote.schema.json" || p == "schemas/-x.schema.json" {
			t.Errorf("unexpected finding for %s: %+v", p, byPath[p])
		}
	}
	if f, ok := byPath["schemas/loose.schema.json"]; !ok || f.Gate || f.Severity != resultset.SeverityWarning || *f.RuleID != "strict-mode" {
		t.Errorf("loose schema = %+v, want a strict-mode warning", f)
	}
	if f, ok := byPath["test/fixtures/bad.schema.json"]; !ok || f.Gate || f.Severity != resultset.SeverityNote {
		t.Errorf("Test data schema = %+v, want a note", f)
	}
	if gates := gatesByPath(&r.set, "schema.compile"); len(gates) != 1 {
		t.Errorf("gates = %+v, want only the draft-04 schema", gates)
	}
	var limited bool
	for _, l := range r.set.Limitations {
		limited = limited || (l.CheckID != nil && *l.CheckID == "schema.compile" && l.Path != nil && *l.Path == "schemas/remote.schema.json")
	}
	if !limited {
		t.Errorf("no Limitation for schemas/remote.schema.json: %+v", r.set.Limitations)
	}
	r.assertNothingLeft(t)
}

func TestAProjectWithoutSchemasHasNothingToCompile(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original)

	if e := executionOf(t, &r.set, "schema.compile"); e.Applicability != resultset.NotApplicable {
		t.Errorf("schema.compile applicability = %s, want not_applicable", e.Applicability)
	}
	r.assertNothingLeft(t)
}
