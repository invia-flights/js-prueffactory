//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func gatesByPath(s *resultset.Set, check string) map[string]resultset.Finding {
	out := map[string]resultset.Finding{}
	for _, f := range findingsOf(s, check) {
		if f.Gate {
			out[f.Locations[0].Path] = f
		}
	}
	return out
}

func executionOf(t *testing.T, s *resultset.Set, check string) resultset.Execution {
	t.Helper()
	for _, e := range s.Checks {
		if e.CheckID == check {
			return e
		}
	}
	t.Fatalf("no execution of %s", check)
	return resultset.Execution{}
}

func TestRepositoryFilesAreLintedWithTheirStandardToolsAndErrorsAreGates(t *testing.T) {
	original := copyProject(t, "repository-files")

	r := realRun(t, context.Background(), "test", original)

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	for _, id := range []string{"repository.dockerfile", "repository.shell", "api.lint"} {
		e := executionOf(t, &r.set, id)
		if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.ContextID != "C-0001" || e.Gate == 0 {
			t.Errorf("%s = status %s outcome %s context %s gates %d", id, e.Status, e.Outcome, e.ContextID, e.Gate)
		}
		if e.Tool == nil || e.Tool.Version == nil || *e.Tool.Version == "" {
			t.Errorf("%s: tool = %+v", id, e.Tool)
		}
	}

	// hadolint: the error is a Gate, the warning is not, Test data is left alone.
	docker := gatesByPath(&r.set, "repository.dockerfile")
	if f, ok := docker["Dockerfile"]; !ok || *f.RuleID != "DL3000" || f.Locations[0].Start.Line != 2 {
		t.Errorf("Dockerfile gates = %+v", docker)
	}
	var warned bool
	for _, f := range findingsOf(&r.set, "repository.dockerfile") {
		if f.Locations[0].Path == "test/fixtures/Dockerfile" {
			t.Errorf("Test data was linted: %+v", f)
		}
		warned = warned || (!f.Gate && f.Severity == resultset.SeverityWarning)
	}
	if !warned {
		t.Error("hadolint warnings should be reported as non-Gate warnings")
	}

	// ShellCheck: the parse error is a Gate. The script in the folder with
	// glob characters is checked and only has warnings.
	shell := gatesByPath(&r.set, "repository.shell")
	if f, ok := shell["scripts/broken.sh"]; !ok || !strings.HasPrefix(*f.RuleID, "SC") {
		t.Errorf("shell gates = %+v", shell)
	}
	if len(shell) != 1 {
		t.Errorf("only broken.sh has an error-level result: %+v", shell)
	}
	var globFolderChecked bool
	for _, f := range findingsOf(&r.set, "repository.shell") {
		if f.Locations[0].Path == "test/fixtures/broken.sh" {
			t.Errorf("Test data was linted: %+v", f)
		}
		if f.Locations[0].Path == "tools [x]/clean build.sh" {
			globFolderChecked = true
			if f.Gate {
				t.Errorf("warnings must not be Gates: %+v", f)
			}
		}
	}
	if !globFolderChecked {
		t.Error("the script in `tools [x]` was not checked")
	}

	// Redocly: the invalid file in a folder with glob characters is a Gate,
	// the valid file is clean and Test data is left alone.
	api := gatesByPath(&r.set, "api.lint")
	if f, ok := api["api [v1] {draft}*/openapi.yaml"]; !ok || *f.RuleID != "struct" {
		t.Errorf("api gates = %+v", api)
	}
	for _, f := range findingsOf(&r.set, "api.lint") {
		if f.Locations[0].Path != "api [v1] {draft}*/openapi.yaml" {
			t.Errorf("unexpected api.lint finding: %+v", f)
		}
	}

	// The project Context records the three tools with their image digests.
	tools := map[string]resultset.ToolRef{}
	for _, tr := range r.set.Contexts[0].Tools {
		tools[tr.Name] = tr
	}
	for _, name := range []string{"hadolint", "shellcheck", "redocly"} {
		tr, ok := tools[name]
		if !ok || tr.Version == "" || tr.Digest == nil || !strings.HasPrefix(*tr.Digest, "sha256:") {
			t.Errorf("project Context tool %s = %+v", name, tr)
		}
	}
	r.assertNothingLeft(t)
}

func TestARemoteRefMakesAnOpenAPIFilePartialWithALimitation(t *testing.T) {
	original := copyProject(t, "repository-files")
	remote := "openapi: 3.0.3\ninfo:\n  title: Remote\n  version: \"1\"\npaths:\n  /a:\n    $ref: \"https://example.com/a.yaml\"\n"
	if err := os.WriteFile(filepath.Join(original, "api", "remote.yaml"), []byte(remote), 0o644); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original)

	e := executionOf(t, &r.set, "api.lint")
	if e.Status != resultset.StatusPartial {
		t.Fatalf("api.lint status = %s, want partial", e.Status)
	}
	var limited bool
	for _, l := range r.set.Limitations {
		limited = limited || (l.CheckID != nil && *l.CheckID == "api.lint" && l.Path != nil && *l.Path == "api/remote.yaml")
	}
	if !limited {
		t.Errorf("no Limitation for api/remote.yaml: %+v", r.set.Limitations)
	}
	for _, f := range findingsOf(&r.set, "api.lint") {
		if f.Locations[0].Path == "api/remote.yaml" {
			t.Errorf("a remote $ref that cannot be fetched must not become a Finding: %+v", f)
		}
	}
	r.assertNothingLeft(t)
}

func TestAChartThatFailsToRenderWithOneValuesFileIsAGateAndTheDefaultRenderIsNot(t *testing.T) {
	original := copyProject(t, "repository-files")

	r := realRun(t, context.Background(), "test", original, "--only", "repository.helm")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := executionOf(t, &r.set, "repository.helm")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomeFailed || e.Gate != 1 || e.ContextID != "C-0001" {
		t.Fatalf("repository.helm = status %s outcome %s gates %d context %s", e.Status, e.Outcome, e.Gate, e.ContextID)
	}
	if e.Tool == nil || e.Tool.Name != "helm" || e.Tool.Version == nil || !strings.HasPrefix(*e.Tool.Version, "3.22.") {
		t.Errorf("tool = %+v", e.Tool)
	}
	gates := gatesByPath(&r.set, "repository.helm")
	f, ok := gates["charts/web/values-broken.yaml"]
	if !ok || len(gates) != 1 || *f.RuleID != "helm.template" || !strings.Contains(f.Evidence[0].Text, "service") {
		t.Fatalf("gates = %+v", gates)
	}
	for _, f := range findingsOf(&r.set, "repository.helm") {
		if f.Gate && f.Locations[0].Path != "charts/web/values-broken.yaml" {
			t.Errorf("the default render must not fail: %+v", f)
		}
		if f.Severity == resultset.SeverityError && !f.Gate && *f.RuleID != "helm.lint" {
			t.Errorf("unexpected error finding: %+v", f)
		}
	}

	// helm and the Alpine image it ran in are recorded in the project Context.
	tools := map[string]resultset.ToolRef{}
	for _, tr := range r.set.Contexts[0].Tools {
		tools[tr.Name] = tr
	}
	if tools["helm"].Version == "" || tools["alpine"].Digest == nil || !strings.HasPrefix(*tools["alpine"].Digest, "sha256:") {
		t.Errorf("project Context tools = %+v", r.set.Contexts[0].Tools)
	}
	r.assertNothingLeft(t)
}

func TestAChartWithUnvendoredDependenciesIsBlockedAndTheOtherChartsStillRun(t *testing.T) {
	original := copyProject(t, "repository-files")
	chart := filepath.Join(original, "charts", "needs-deps")
	if err := os.MkdirAll(filepath.Join(chart, "templates"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"Chart.yaml":        "apiVersion: v2\nname: needs-deps\nversion: 0.1.0\ndependencies:\n- name: nodejs\n  version: 1.2.3\n  repository: https://charts.example.com\n",
		"templates/cm.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(chart, filepath.FromSlash(name)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	r := realRun(t, context.Background(), "test", original, "--only", "repository.helm")

	e := executionOf(t, &r.set, "repository.helm")
	if e.Status != resultset.StatusPartial {
		t.Fatalf("status = %s, want partial", e.Status)
	}
	var limited bool
	for _, l := range r.set.Limitations {
		limited = limited || (l.ReasonCode == "chart_dependencies_not_vendored" && l.Path != nil && *l.Path == "charts/needs-deps/Chart.yaml")
	}
	if !limited {
		t.Errorf("no chart_dependencies_not_vendored Limitation: %+v", r.set.Limitations)
	}
	for _, f := range findingsOf(&r.set, "repository.helm") {
		if strings.HasPrefix(f.Locations[0].Path, "charts/needs-deps/") {
			t.Errorf("a blocked chart has no Findings: %+v", f)
		}
	}
	if gates := gatesByPath(&r.set, "repository.helm"); len(gates) != 1 {
		t.Errorf("the other chart still runs and fails once: %+v", gates)
	}
	r.assertNothingLeft(t)
}

func TestAProjectWithoutRepositoryFilesHasNothingToLint(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original)

	for _, id := range []string{"repository.dockerfile", "repository.shell", "api.lint"} {
		e := executionOf(t, &r.set, id)
		if e.Applicability != resultset.NotApplicable {
			t.Errorf("%s applicability = %s, want not_applicable", id, e.Applicability)
		}
	}
	// jscpd (quality.clones) and gitleaks (security.secrets) ran in the project
	// Context; the repository tools did not.
	for _, tool := range r.set.Contexts[0].Tools {
		if tool.Name != "jscpd" && tool.Name != "gitleaks" {
			t.Errorf("tools that did not run are not recorded: %+v", r.set.Contexts[0].Tools)
		}
	}
	r.assertNothingLeft(t)
}
