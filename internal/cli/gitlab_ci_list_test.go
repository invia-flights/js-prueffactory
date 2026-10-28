package cli_test

import "testing"

// Seam A without Docker: list-checks says that repository.gitlab-ci applies to
// the project when .gitlab-ci.yml is at its root.

func gitlabCIApplicability(t *testing.T, project string) (applicability, reason string) {
	t.Helper()
	l := listChecksJSON(t, testdataProject(t, project), "--format", "json")
	row := l.Checks[rowOf(t, l, "repository.gitlab-ci")]
	if row.Status != "implemented" {
		t.Errorf("status = %q, want implemented", row.Status)
	}
	for _, a := range row.Applicability {
		if a.Kind == "project" {
			return a.Applicability, a.Reason
		}
	}
	t.Fatal("repository.gitlab-ci has no applicability for the project")
	return "", ""
}

func TestListChecksShowsGitlabCIApplicableWithAPipelineFileAtTheRoot(t *testing.T) {
	for _, project := range []string{"ci-files", "broken-structured-files"} {
		if got, reason := gitlabCIApplicability(t, project); got != "applicable" || reason != "" {
			t.Errorf("%s: applicability = %q (%s), want applicable", project, got, reason)
		}
	}
}

func TestListChecksShowsGitlabCINotApplicableWithoutAPipelineFile(t *testing.T) {
	got, reason := gitlabCIApplicability(t, "clean-mocha")
	if got != "not_applicable" || reason == "" {
		t.Errorf("applicability = %q (%s), want not_applicable with a reason", got, reason)
	}
}
