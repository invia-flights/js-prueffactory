package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

func TestTheSBOMIsListedAsAnArtifactInBothReportsAndHasNoFindings(t *testing.T) {
	s := handMade()
	s.Artifacts = append(s.Artifacts, resultset.Artifact{
		ID: "A-9002", Path: "artifacts/sbom.generate/C-0002-sbom.cdx.json", MediaType: "application/vnd.cyclonedx+json",
		SHA256: resultsettest.SHA, Size: 52311, CheckID: "sbom.generate",
	})

	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("schema problems: %v", problems)
	}
	if !strings.Contains(string(data), `"path": "artifacts/sbom.generate/C-0002-sbom.cdx.json"`) ||
		!strings.Contains(string(data), `"media_type": "application/vnd.cyclonedx+json"`) {
		t.Error("report.json does not list the artifact")
	}
	md := string(render.Markdown(s))
	if !strings.Contains(md, "[artifacts/sbom.generate/C-0002-sbom.cdx.json](artifacts/sbom.generate/C-0002-sbom.cdx.json) (application/vnd.cyclonedx+json, 52311 bytes") {
		t.Errorf("report.md does not list the artifact:\n%s", md)
	}
	for _, f := range s.Findings {
		if f.CheckID == "sbom.generate" {
			t.Errorf("finding of sbom.generate: %+v", f)
		}
	}
}
