package cli_test

import "testing"

// Seam A without Docker: list-checks says that repository.kubernetes applies to
// a project with a Helm chart or a plain manifest.

func kubernetesApplicability(t *testing.T, project string) (applicability, reason string) {
	t.Helper()
	l := listChecksJSON(t, testdataProject(t, project), "--format", "json")
	row := l.Checks[rowOf(t, l, "repository.kubernetes")]
	if row.Status != "implemented" {
		t.Errorf("status = %q, want implemented", row.Status)
	}
	for _, a := range row.Applicability {
		if a.Kind == "project" {
			return a.Applicability, a.Reason
		}
	}
	t.Fatal("repository.kubernetes has no applicability for the project")
	return "", ""
}

func TestListChecksShowsKubernetesApplicableWithAChartOrAPlainManifest(t *testing.T) {
	for _, project := range []string{"ci-files", "repository-files"} {
		if got, reason := kubernetesApplicability(t, project); got != "applicable" || reason != "" {
			t.Errorf("%s: applicability = %q (%s), want applicable", project, got, reason)
		}
	}
}

func TestListChecksShowsKubernetesNotApplicableWithoutAChartOrManifest(t *testing.T) {
	got, reason := kubernetesApplicability(t, "clean-mocha")
	if got != "not_applicable" || reason == "" {
		t.Errorf("applicability = %q (%s), want not_applicable with a reason", got, reason)
	}
}
