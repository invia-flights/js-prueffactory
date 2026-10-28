package engine

import (
	"context"
	"io"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

// A Check names its artifacts by keys of its own and lets Evidence refer to
// them. The engine gives the artifacts their IDs and carries the links over.

type fakeLinker struct{}

func (fakeLinker) Applicability(*discovery.Project, *discovery.Context) (resultset.Applicability, string) {
	return resultset.Applicable, ""
}

func (fakeLinker) Run(context.Context, *checks.Input) *checks.Result {
	known, unknown := "diff-one", "diff-nowhere"
	return &checks.Result{
		Status: resultset.StatusCompleted,
		Artifacts: []resultset.Artifact{
			{ID: "log", Path: "artifacts/x/log.txt", Content: []byte("log")},
			{ID: known, Path: "artifacts/x/one.diff", Content: []byte("diff")},
		},
		Findings: []resultset.Finding{{
			Title: "linked",
			Evidence: []resultset.Evidence{
				{Kind: "diff", Text: "diff", ArtifactID: &known},
				{Kind: "diff", Text: "other", ArtifactID: &unknown},
				{Kind: "text", Text: "plain"},
			},
		}},
	}
}

func TestEvidenceKeepsItsLinkToAnArtifactTheCheckKeyed(t *testing.T) {
	r := &run{
		log:  progress.New(io.Discard, nil),
		snap: &snapshot.Snapshot{Dir: t.TempDir()},
		proj: &discovery.Project{},
	}
	p := &planned{
		key: "x9", entry: checks.Entry{ID: "schema.drift", Family: "schema"}, check: fakeLinker{},
		context:       &discovery.Context{Context: resultset.Context{ID: "C-0002"}},
		applicability: resultset.Applicable,
	}

	res := r.execute(context.Background(), context.Background(), p, false)

	if len(res.artifacts) != 2 || res.artifacts[1].ID == "one" || res.artifacts[1].ID == "diff-one" {
		t.Fatalf("artifacts = %+v, want report IDs", res.artifacts)
	}
	ev := res.findings[0].Evidence
	if ev[0].ArtifactID == nil || *ev[0].ArtifactID != res.artifacts[1].ID {
		t.Errorf("evidence 0 links to %v, want the artifact %q", ev[0].ArtifactID, res.artifacts[1].ID)
	}
	if ev[1].ArtifactID != nil {
		t.Errorf("evidence 1 links to %q, but no artifact has that key", *ev[1].ArtifactID)
	}
	if ev[2].ArtifactID != nil {
		t.Errorf("evidence 2 links to %q", *ev[2].ArtifactID)
	}
}
