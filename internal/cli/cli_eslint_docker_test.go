//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for the combined ESLint run and
// lint.correctness.

const selfAssign = "'use strict';\n\nfunction reset(state) {\n  state.count = state.count;\n  return state;\n}\n\nmodule.exports = { reset };\n"

func TestLintCorrectnessFindsTheHitAndTheSameHitUnderADisableCommentAndNothingInTestDataOrBuildOutput(t *testing.T) {
	original := copyProject(t, "eslint-problems")
	// The project's own configuration turns the rule off. The run must not read it.
	own := filepath.Join(original, "eslint.config.js")
	if err := os.WriteFile(own, []byte("module.exports = [{ rules: { 'no-self-assign': 'off' } }];\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Names come from the project, which is untrusted: ESLint has options such
	// as -c, and its file arguments are globs. A file that is a link must never
	// be read, because it could point out of the Snapshot.
	for _, name := range []string{"-x.js", "[id].js"} {
		if err := os.WriteFile(filepath.Join(original, "src", name), []byte(selfAssign), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(original, "src", "link.js")); err != nil {
		t.Fatal(err)
	}

	// tests.existing is left out: the test script names Mocha, which this project does not install.
	r := realRun(t, context.Background(), "test", original, "--exclude", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: lint.correctness findings are warnings and never Gates\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)

	var exec *resultset.Execution
	for i := range r.set.Checks {
		if r.set.Checks[i].CheckID == "lint.correctness" && r.set.Checks[i].ContextID == "C-0002" {
			exec = &r.set.Checks[i]
		}
	}
	if exec == nil || exec.Status != resultset.StatusCompleted {
		t.Fatalf("lint.correctness in the package Context = %+v\nstderr:\n%s", exec, r.stderr)
	}
	if exec.Tool == nil || exec.Tool.Name != "eslint" || exec.Tool.Version == nil || *exec.Tool.Version != "10.13.0" {
		t.Errorf("tool = %+v, want ESLint 10.13.0", exec.Tool)
	}
	command := strings.Join(exec.Command, " ")
	for _, flag := range []string{"--no-config-lookup", "--no-inline-config", "--format json"} {
		if !strings.Contains(command, flag) {
			t.Errorf("command %q lacks %s", command, flag)
		}
	}

	var got []string
	var unused []string
	for _, f := range findingsOf(&r.set, "lint.correctness") {
		if f.RuleID != nil && *f.RuleID == "no-unused-vars" {
			unused = append(unused, f.Locations[0].Path+":"+f.Message)
			continue
		}
		if f.RuleID == nil || *f.RuleID != "no-self-assign" {
			t.Errorf("finding %+v, want only the planted rules: Mocha's globals and Node's must be known", f)
		}
		if f.Gate || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely {
			t.Errorf("finding %+v, want a warning with confidence likely and no Gate", f)
		}
		got = append(got, f.Locations[0].Path)
	}
	sort.Strings(got)
	want := "src/-x.js,src/[id].js,src/index.js,src/silenced.js"
	if strings.Join(got, ",") != want {
		t.Errorf("hits in %v, want %s: the disable comment and the project's config change nothing, Test data and Build output are not linted, the link is not read", got, want)
	}

	// The underscore name of the error handler is unused on purpose; the other
	// unused name in the same function is still reported.
	if len(unused) != 1 || !strings.HasPrefix(unused[0], "src/handler.js:") || !strings.Contains(unused[0], "'leftover'") {
		t.Errorf("no-unused-vars hits = %v, want only 'leftover' in src/handler.js and nothing for _next", unused)
	}

	// The rule list is an artifact of the Report, and its hash is the digest of
	// the generated config in the Context's tools, which the fingerprint reads.
	if len(exec.ArtifactIDs) != 1 {
		t.Fatalf("artifact IDs = %v, want the rule list", exec.ArtifactIDs)
	}
	var artifact resultset.Artifact
	for _, a := range r.set.Artifacts {
		if a.ID == exec.ArtifactIDs[0] {
			artifact = a
		}
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(artifact.Path)))
	if err != nil {
		t.Fatalf("the rule list artifact %+v is not in the report folder: %v", artifact, err)
	}
	var doc struct {
		Rules        []string `json:"rules"`
		Excluded     []string `json:"excluded_rules"`
		ConfigSHA256 string   `json:"config_sha256"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	// ESLint 10.13.0 has 59 non-deprecated core rules of type problem.
	if len(doc.Rules) != 57 || contains(doc.Rules, "no-await-in-loop") || contains(doc.Rules, "no-use-before-define") ||
		!contains(doc.Rules, "no-undef") || !contains(doc.Rules, "no-self-assign") || contains(doc.Rules, "no-unused-expressions") {
		t.Errorf("rules = %v", doc.Rules)
	}
	if strings.Join(doc.Excluded, ",") != "no-await-in-loop,no-use-before-define" {
		t.Errorf("excluded = %v", doc.Excluded)
	}
	var digest string
	for _, c := range r.set.Contexts {
		if c.ID != "C-0002" {
			continue
		}
		for _, tool := range c.Tools {
			if tool.Name == "eslint-config" && tool.Digest != nil {
				digest = *tool.Digest
			}
		}
	}
	if len(doc.ConfigSHA256) != 64 || digest != doc.ConfigSHA256 {
		t.Errorf("config hash in the artifact = %q, in the Context's tools = %q", doc.ConfigSHA256, digest)
	}
}
