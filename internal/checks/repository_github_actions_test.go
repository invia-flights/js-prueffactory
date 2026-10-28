package checks

import (
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func TestWorkflowFilesAreTheYmlAndYamlFilesDirectlyInGithubWorkflows(t *testing.T) {
	proj := tree(t, map[string]string{
		".github/workflows/ci.yml":           "on: push\n",
		".github/workflows/release.yaml":     "on: push\n",
		".github/workflows/notes.md":         "not a workflow\n",
		".github/workflows/sub/nested.yml":   "on: push\n", // GitHub does not read subfolders
		".github/workflows/UPPER.YML":        "on: push\n", // GitHub reads .yml and .yaml only
		".github/dependabot.yml":             "version: 2\n",
		"packages/a/.github/workflows/x.yml": "on: push\n", // only the project root counts
		"workflows/ci.yml":                   "on: push\n",
		"weird [1] {a,b}*/ok.yml":            "x: 1\n",
	})
	want := []string{".github/workflows/ci.yml", ".github/workflows/release.yaml"}
	if got := workflowFiles(proj); !slices.Equal(got, want) {
		t.Errorf("workflow files = %q, want %q", got, want)
	}
}

func TestTheGitHubActionsCheckAppliesOnlyToProjectsWithWorkflowFiles(t *testing.T) {
	check := githubActionsCheck{}
	projectContext := &discovery.Context{Context: resultset.Context{ID: "C-0001", Kind: "project", Path: "."}}

	with := tree(t, map[string]string{".github/workflows/ci.yml": "on: push\n"})
	if got, reason := check.Applicability(with, projectContext); got != resultset.Applicable || reason != "" {
		t.Errorf("with a workflow: %s (%s), want applicable", got, reason)
	}
	without := tree(t, map[string]string{".github/workflows/readme.md": "x\n", "package.json": "{}\n"})
	if got, reason := check.Applicability(without, projectContext); got != resultset.NotApplicable || reason == "" {
		t.Errorf("without a workflow: %s (%s), want not_applicable with a reason", got, reason)
	}
	pkgContext := &discovery.Context{Context: resultset.Context{ID: "C-0002", Kind: "package", Path: "."}, Package: &discovery.Package{}}
	if got, _ := check.Applicability(with, pkgContext); got != resultset.NotApplicable {
		t.Errorf("in a package Context: %s, want not_applicable", got)
	}
}

func TestTheGitHubActionsCheckNeedsBothToolImagesInTheProjectContextOnly(t *testing.T) {
	check := githubActionsCheck{}
	got := check.Images(&discovery.Context{Context: resultset.Context{ID: "C-0001", Kind: "project"}})
	want := []string{toolset.Actionlint.Image.Ref(), toolset.Zizmor.Image.Ref()}
	if !slices.Equal(got, want) {
		t.Errorf("images = %v, want %v", got, want)
	}
	if got := check.Images(&discovery.Context{Package: &discovery.Package{}}); got != nil {
		t.Errorf("package Context images = %v, want none", got)
	}
}
