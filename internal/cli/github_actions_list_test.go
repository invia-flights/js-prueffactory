package cli_test

import "testing"

// Seam A without Docker: list-checks says that repository.github-actions
// applies to a project with workflow files and not to one without.

func githubActionsApplicability(t *testing.T, project string) (applicability, reason string) {
	t.Helper()
	l := listChecksJSON(t, testdataProject(t, project), "--format", "json")
	row := l.Checks[rowOf(t, l, "repository.github-actions")]
	if row.Status != "implemented" {
		t.Errorf("status = %q, want implemented", row.Status)
	}
	for _, a := range row.Applicability {
		if a.Kind == "project" {
			return a.Applicability, a.Reason
		}
	}
	t.Fatal("repository.github-actions has no applicability for the project")
	return "", ""
}

func TestListChecksShowsGitHubActionsApplicableWithWorkflowFiles(t *testing.T) {
	if got, reason := githubActionsApplicability(t, "ci-files"); got != "applicable" || reason != "" {
		t.Errorf("applicability = %q (%s), want applicable", got, reason)
	}
}

func TestListChecksShowsGitHubActionsNotApplicableWithoutWorkflowFiles(t *testing.T) {
	got, reason := githubActionsApplicability(t, "clean-mocha")
	if got != "not_applicable" || reason == "" {
		t.Errorf("applicability = %q (%s), want not_applicable with a reason", got, reason)
	}
}
