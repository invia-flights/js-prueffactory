package checks_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func TestAnErrorInALocalIncludeIsReportedInTheIncludedFile(t *testing.T) {
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml":   "include: ci/deploy.yml\n\nstages: [deploy]\n",
		"ci/deploy.yml":    "deploy:\n  stage: deploy\n  script: make\n  retry: lots\n",
		"ci/unrelated.yml": "this: [is, not, included",
	})
	got := r.byRule("gitlab-ci.schema")
	if len(got) != 1 || !got[0].Gate || got[0].Locations[0].Path != "ci/deploy.yml" || got[0].Locations[0].Start.Line != 4 {
		t.Fatalf("want one Gate in ci/deploy.yml at line 4: %+v", r.result.Findings)
	}
}

func TestEveryFormOfALocalIncludeIsResolvedRecursively(t *testing.T) {
	job := func(name string) string { return name + ":\n  script: make\n  retry: lots\n" }
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml": `include:
  - /ci/a.yml
  - local: ci/b.yml
  - local: ci/many/*.yml
  - ci/deep/**/*.yml
`,
		"ci/a.yml":              "include: 'ci/nested.yml'\n" + job("a"),
		"ci/nested.yml":         "include: ci/a.yml\n" + job("nested"), // a cycle
		"ci/b.yml":              job("b"),
		"ci/many/one.yml":       job("one"),
		"ci/many/two.yml":       job("two"),
		"ci/many/skip.txt":      "not yaml",
		"ci/many/sub/three.yml": "broken: [",
		"ci/deep/x/y/four.yml":  job("four"),
	})
	var paths []string
	for _, f := range r.byRule("gitlab-ci.schema") {
		paths = append(paths, f.Locations[0].Path)
	}
	want := "ci/a.yml ci/b.yml ci/deep/x/y/four.yml ci/many/one.yml ci/many/two.yml ci/nested.yml"
	if got := strings.Join(paths, " "); got != want {
		t.Errorf("files with schema errors = %q, want %q (ci/many/sub/three.yml is not matched by a single *)", got, want)
	}
}

func TestAMissingLocalIncludeIsAGateAtTheIncludeLine(t *testing.T) {
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml": "stages: [test]\ninclude:\n  - local: ci/there.yml\n  - local: ci/missing.yml\n  - ci/nothing/*.yml\n",
		"ci/there.yml":   "test:\n  script: make\n",
	})
	got := r.byRule("gitlab-ci.include-missing")
	if len(got) != 2 || r.gates() != 2 {
		t.Fatalf("want two missing-include Gates: %+v", r.result.Findings)
	}
	if loc := got[0].Locations[0]; loc.Path != ".gitlab-ci.yml" || loc.Start.Line != 4 || !strings.Contains(got[0].Message, "ci/missing.yml") {
		t.Errorf("first = %+v / %s", loc, got[0].Message)
	}
	if loc := got[1].Locations[0]; loc.Start.Line != 5 || !strings.Contains(got[1].Message, "ci/nothing/*.yml") {
		t.Errorf("second = %+v / %s", loc, got[1].Message)
	}
	if r.result.Status != resultset.StatusCompleted {
		t.Errorf("status = %s", r.result.Status)
	}
}

func TestIncludesOutsideTheSnapshotAreNeverFollowed(t *testing.T) {
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml": "include:\n  - local: ../../../../etc/passwd\n  - local: /../outside.yml\n",
	})
	if got := r.byRule("gitlab-ci.include-missing"); len(got) != 2 {
		t.Fatalf("want two missing-include Gates: %+v", r.result.Findings)
	}
}

func TestIncludesThatNeedTheNetworkAreLimitationsAndTheRunStaysCompleted(t *testing.T) {
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml": `include:
  - remote: https://example.com/ci/shared.yml
  - https://example.com/ci/plain.yml
  - project: group/templates
    ref: main
    file: /ci/build.yml
  - template: Jobs/Build.gitlab-ci.yml
  - component: example.org/group/components/lint@1.0
  - local: ci/${ENVIRONMENT}.yml
test:
  script: make
`,
	})
	if r.result.Status != resultset.StatusCompleted || len(r.result.Findings) != 0 {
		t.Fatalf("status %s, findings %+v", r.result.Status, r.result.Findings)
	}
	if len(r.result.Limitations) != 6 {
		t.Fatalf("limitations = %+v", r.result.Limitations)
	}
	for _, l := range r.result.Limitations {
		if l.ReasonCode != "include_not_resolved" || l.CheckID == nil || *l.CheckID != gitlabCIID || l.Path == nil || *l.Path != ".gitlab-ci.yml" {
			t.Errorf("limitation = %+v", l)
		}
	}
	for i, want := range []string{
		"https://example.com/ci/shared.yml", "https://example.com/ci/plain.yml", "group/templates", "Jobs/Build.gitlab-ci.yml",
		"example.org/group/components/lint@1.0", "ci/${ENVIRONMENT}.yml",
	} {
		if !strings.Contains(r.result.Limitations[i].Message, want) {
			t.Errorf("limitation %d = %q, want it to name %q", i, r.result.Limitations[i].Message, want)
		}
	}
}

func TestAReferenceTagIsReadAsAListOfStringsAndASchemaErrorAtItIsANote(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `.setup:
  script:
    - echo setup
test:
  script:
    - !reference [.setup, script]
    - echo done
  image: !reference [.setup, image]
`})
	notes := r.byRule("gitlab-ci.schema")
	if r.gates() != 0 || len(notes) != 1 {
		t.Fatalf("want exactly one note, for the !reference under image: %+v", r.result.Findings)
	}
	if notes[0].Severity != resultset.SeverityNote || notes[0].Locations[0].Start.Line != 8 {
		t.Errorf("note = %+v", notes[0])
	}
}
