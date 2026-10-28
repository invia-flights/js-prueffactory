package cli_test

import (
	"path/filepath"
	"strings"
	"testing"
)

// Seam A without Docker: list-checks says that types.javascript takes packages
// with TypeScript files, and which TypeScript packages it still leaves out.

func typesJavascriptApplicability(t *testing.T, project string) (applicability, reason string) {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", project))
	if err != nil {
		t.Fatal(err)
	}
	l := listChecksJSON(t, dir, "--format", "json")
	for _, a := range l.Checks[rowOf(t, l, "types.javascript")].Applicability {
		if a.Kind == "package" && a.Path == "." {
			return a.Applicability, a.Reason
		}
	}
	t.Fatal("types.javascript has no applicability for the package")
	return "", ""
}

func TestListChecksShowsTypesJavascriptApplicableForPackagesWithTypeScriptFiles(t *testing.T) {
	for _, project := range []string{"types-mixed-ts", "types-tsx", "typescript-source"} {
		t.Run(project, func(t *testing.T) {
			got, reason := typesJavascriptApplicability(t, project)
			if got != "applicable" || reason != "" {
				t.Errorf("applicability = %q (%s), want applicable and no unsupported reason", got, reason)
			}
		})
	}
}

func TestListChecksShowsTypesJavascriptUnsupportedForTypeScriptThatNeedsABuildStep(t *testing.T) {
	got, reason := typesJavascriptApplicability(t, "typescript-build-step")

	if got != "applicable" || !strings.HasPrefix(reason, "unsupported: ") ||
		!strings.Contains(reason, "build step") || !strings.Contains(reason, "outDir") || !strings.Contains(reason, "src/index.ts") {
		t.Errorf("applicability = %q (%s), want an unsupported reason that names the build step, its sign and the TypeScript file", got, reason)
	}
}
