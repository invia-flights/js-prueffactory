package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

func TestTheOutdatedDependenciesTableIsListedAsAnArtifactInBothReports(t *testing.T) {
	s := handMade()
	s.Artifacts = append(s.Artifacts, resultset.Artifact{
		ID: "A-9001", Path: "artifacts/deps.outdated/C-0002-dependencies.json", MediaType: "application/json",
		SHA256: resultsettest.SHA, Size: 812, CheckID: "deps.outdated",
	})

	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("schema problems: %v", problems)
	}
	if !strings.Contains(string(data), `"path": "artifacts/deps.outdated/C-0002-dependencies.json"`) {
		t.Error("report.json does not list the artifact")
	}
	md := string(render.Markdown(s))
	if !strings.Contains(md, "[artifacts/deps.outdated/C-0002-dependencies.json](artifacts/deps.outdated/C-0002-dependencies.json) (application/json, 812 bytes") {
		t.Errorf("report.md does not list the artifact:\n%s", md)
	}
}
