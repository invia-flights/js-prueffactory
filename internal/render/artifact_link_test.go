package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Evidence that is the start of a file the Report keeps as an artifact, such as
// the diff of schema.drift, links to the artifact even though it records no
// original size.

func TestMarkdownLinksEvidenceToItsArtifactWithoutAnOriginalSize(t *testing.T) {
	s := handMade()
	s.Artifacts = append(s.Artifacts, resultset.Artifact{
		ID: "tmp-diff", Path: "artifacts/schema.drift/C-0002/ab12-user.json.diff", MediaType: "text/x-diff",
		Content: []byte("--- a/user.json\n+++ b/user.json\n"), CheckID: "syntax.parse",
	})
	key := "tmp-diff"
	s.Findings[0].Evidence = append(s.Findings[0].Evidence, resultset.Evidence{
		Kind: "diff", Text: "--- a/user.json\n+++ b/user.json\n", Origin: "schema.drift", Trust: resultset.TrustUntrusted, ArtifactID: &key,
	})
	s.Checks[0].ArtifactIDs = append(s.Checks[0].ArtifactIDs, key)
	s.Finalize()

	md := section(string(render.Markdown(s)), "## Gates")

	if !strings.Contains(md, "(Full text: [artifacts/schema.drift/C-0002/ab12-user.json.diff](artifacts/schema.drift/C-0002/ab12-user.json.diff).)") {
		t.Errorf("the Gate does not link the artifact of its Evidence:\n%s", md)
	}
}
