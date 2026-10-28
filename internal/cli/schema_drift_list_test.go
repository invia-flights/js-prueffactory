package cli_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Seam A without Docker: list-checks says which packages have a generator
// script for schema.drift. A package without one is not applicable, with the
// reason no_generator_script.

func schemaDriftApplicability(t *testing.T, dir string) map[string][2]string {
	t.Helper()
	l := listChecksJSON(t, dir, "--format", "json")
	row := l.Checks[rowOf(t, l, "schema.drift")]
	if row.Status != "implemented" {
		t.Errorf("status = %q, want implemented", row.Status)
	}
	out := map[string][2]string{}
	for _, a := range row.Applicability {
		out[a.Path] = [2]string{a.Applicability, a.Reason}
	}
	return out
}

func TestListChecksShowsSchemaDriftApplicableForEveryPackageWithAGeneratorScript(t *testing.T) {
	got := schemaDriftApplicability(t, testdataProject(t, "schema-drift"))

	for _, path := range []string{".", "tools/legacy"} {
		if got[path][0] != "applicable" || got[path][1] != "" {
			t.Errorf("%s: applicability = %q (%s), want applicable", path, got[path][0], got[path][1])
		}
	}
}

func TestListChecksShowsSchemaDriftNotApplicableWithoutAGeneratorScript(t *testing.T) {
	cases := []struct{ name, scripts string }{
		{"no scripts", ``},
		{"a name that does not point to generation", `"lint": "node scripts/lint.js"`},
		{"a lifecycle name", `"build": "node scripts/generate-schema.js", "postinstall": "node scripts/schema.js"`},
		{"a command chain", `"gen:schema": "node a.js && node b.js"`},
		{"a command that is not node", `"gen:schema": "ts-node scripts/gen.ts", "generate": "sh gen.sh"`},
		{"a node option before the file", `"gen:schema": "node --require ./hook.js gen.js"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := project(t)
			manifest := `{"name":"demo","scripts":{` + c.scripts + `}}`
			if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o644); err != nil {
				t.Fatal(err)
			}

			got := schemaDriftApplicability(t, dir)["."]

			if got[0] != "not_applicable" || !strings.Contains(got[1], "no_generator_script") {
				t.Errorf("applicability = %q (%s), want not_applicable with no_generator_script", got[0], got[1])
			}
		})
	}
}

func TestListChecksShowsSchemaDriftApplicableForAPlainNodeGeneratorScript(t *testing.T) {
	dir := project(t)
	manifest := `{"name":"demo","scripts":{"swagger2schema":"API_HOST=localhost node ./tools/swagger2schema.js --out schemas"}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := schemaDriftApplicability(t, dir)["."]; got[0] != "applicable" {
		t.Errorf("applicability = %q (%s), want applicable", got[0], got[1])
	}
}
