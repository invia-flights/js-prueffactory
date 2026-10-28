package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const gitlabCIID = "repository.gitlab-ci"

// gitlabRun is one repository.gitlab-ci execution on a made-up project. The
// Check is native, so no Docker is involved.
type gitlabRun struct {
	applicability resultset.Applicability
	reason        string
	result        *checks.Result
}

func runGitlabCI(t *testing.T, files map[string]string) *gitlabRun {
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
	impl := checks.Implementation(gitlabCIID)
	if impl == nil {
		t.Fatal("repository.gitlab-ci has no implementation")
	}
	ctxt := &proj.Contexts[0]
	run := &gitlabRun{}
	run.applicability, run.reason = impl.Applicability(proj, ctxt)
	if run.applicability == resultset.NotApplicable {
		return run
	}
	run.result = impl.Run(context.Background(), &checks.Input{
		Project: proj, Context: ctxt, OriginalPath: dir, SnapshotDir: dir,
	})
	return run
}

// byRule returns the Findings with the rule ID, in report order.
func (r *gitlabRun) byRule(rule string) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range r.result.Findings {
		if f.RuleID != nil && *f.RuleID == rule {
			out = append(out, f)
		}
	}
	return out
}

func (r *gitlabRun) gates() int {
	n := 0
	for _, f := range r.result.Findings {
		if f.Gate {
			n++
		}
	}
	return n
}

func (r *gitlabRun) assertClean(t *testing.T) {
	t.Helper()
	if r.result == nil {
		t.Fatalf("the Check was not applicable: %s", r.reason)
	}
	if r.result.Status != resultset.StatusCompleted || len(r.result.Findings) != 0 || len(r.result.Limitations) != 0 {
		t.Fatalf("status %s (%s), findings %+v, limitations %+v", r.result.Status, r.result.Reason, r.result.Findings, r.result.Limitations)
	}
}

const validPipeline = `stages:
  - build
  - test

build:
  stage: build
  script:
    - make

test:
  stage: test
  needs: [build]
  script:
    - make test
`

func TestGitlabCIIsAGateCheckInTheValidityAreaForTheProject(t *testing.T) {
	e, ok := checks.Lookup(gitlabCIID)
	if !ok {
		t.Fatal("repository.gitlab-ci not in the Catalog")
	}
	if e.Status != checks.Implemented || e.Scope != checks.PerProject || !e.CanFireGates || e.Area != "validity" {
		t.Errorf("entry = %+v", e)
	}
}

func TestGitlabCIAppliesOnlyWithAPipelineFileAtTheProjectRoot(t *testing.T) {
	if r := runGitlabCI(t, map[string]string{"package.json": "{}"}); r.applicability != resultset.NotApplicable {
		t.Errorf("without a pipeline file: %s", r.applicability)
	}
	if r := runGitlabCI(t, map[string]string{"ci/.gitlab-ci.yml": validPipeline}); r.applicability != resultset.NotApplicable {
		t.Errorf("a pipeline file below the root: %s", r.applicability)
	}
	if r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": validPipeline}); r.applicability != resultset.Applicable {
		t.Errorf("with a pipeline file: %s (%s)", r.applicability, r.reason)
	}
}

func TestAValidPipelineHasNoFindingsAndRecordsTheSchemaHash(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": validPipeline})
	r.assertClean(t)
	var schema *resultset.ToolRef
	for i := range r.result.ContextTools {
		if r.result.ContextTools[i].Name == "gitlab-ci-schema" {
			schema = &r.result.ContextTools[i]
		}
	}
	if schema == nil || schema.Digest == nil || len(*schema.Digest) != 64 || !strings.HasPrefix(schema.Version, "18.5.0") {
		t.Errorf("the Context tools should name the schema version and its SHA-256: %+v", r.result.ContextTools)
	}
}

func TestASchemaErrorIsAGateAtTheOffendingLine(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": "test:\n  script: make\n  allow_failure: perhaps\n"})
	got := r.byRule("gitlab-ci.schema")
	if len(got) != 1 {
		t.Fatalf("findings = %+v", r.result.Findings)
	}
	f := got[0]
	if !f.Gate || f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceConfirmed || f.CheckID != gitlabCIID {
		t.Errorf("want a confirmed Gate: %+v", f)
	}
	if loc := f.Locations[0]; loc.Path != ".gitlab-ci.yml" || loc.Start == nil || loc.Start.Line != 3 {
		t.Errorf("location = %+v, want line 3", loc)
	}
	if len(f.Evidence) == 0 || !strings.Contains(f.Evidence[0].Text, "/test/allow_failure") {
		t.Errorf("evidence should name the place in the document: %+v", f.Evidence)
	}
}
