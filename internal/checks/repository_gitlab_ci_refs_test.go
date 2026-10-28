package checks_test

import (
	"strings"
	"testing"
)

func TestReferencesToJobsAndHiddenJobsInAnyResolvedFileAreAccepted(t *testing.T) {
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml": `include: ci/jobs.yml
stages: [build, test]
.template:
  script: make
build:
  extends: [.template, .shared]
  stage: build
test:
  extends: .template
  stage: test
  dependencies: [build, packaged]
  needs:
    - build
    - job: packaged
      artifacts: true
`,
		"ci/jobs.yml": "packaged:\n  stage: build\n  script: make\n.shared:\n  variables:\n    A: b\n",
	})
	r.assertClean(t)
}

func TestNeedsDependenciesAndExtendsMustNameExistingJobs(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `stages: [build, test]
build:
  stage: build
  script: make
test:
  stage: test
  script: make test
  extends: .tmeplate
  dependencies: [buidl]
  needs:
    - buidl
    - job: bulid
      optional: true
    - job: elsewhere
      pipeline: "123"
`})
	got := r.byRule("gitlab-ci.unknown-job")
	if len(got) != 3 || r.gates() != 3 {
		t.Fatalf("want three Gates (extends, dependencies, needs), got %+v", r.result.Findings)
	}
	for i, want := range []struct {
		line int
		text string
	}{{8, ".tmeplate"}, {9, "buidl"}, {11, "buidl"}} {
		f := got[i]
		if f.Locations[0].Start.Line != want.line || !strings.Contains(f.Message, want.text) || !f.Gate {
			t.Errorf("finding %d: line %d, %q", i, f.Locations[0].Start.Line, f.Message)
		}
	}
	for _, key := range []string{"extends", "dependencies", "needs"} {
		found := false
		for _, f := range got {
			found = found || strings.Contains(f.Message, key)
		}
		if !found {
			t.Errorf("no Finding names the key %s", key)
		}
	}
}

func TestAStageMustBeDeclaredOrBeADefaultStage(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `stages: [build]
a:
  stage: build
  script: make
b:
  stage: deploy
  script: make
c:
  stage: .pre
  script: make
`})
	got := r.byRule("gitlab-ci.unknown-stage")
	if len(got) != 1 || !got[0].Gate || got[0].Locations[0].Start.Line != 6 || !strings.Contains(got[0].Message, "deploy") {
		t.Fatalf("want one Gate for stage deploy: %+v", r.result.Findings)
	}

	r = runGitlabCI(t, map[string]string{".gitlab-ci.yml": "a:\n  stage: test\n  script: make\nb:\n  stage: publish\n  script: make\n"})
	if got := r.byRule("gitlab-ci.unknown-stage"); len(got) != 1 || !strings.Contains(got[0].Message, "publish") {
		t.Fatalf("without stages the default stages apply, so only publish is unknown: %+v", r.result.Findings)
	}
}

func TestWhileAnIncludeIsUnresolvedUnknownJobsAreOnlyNotes(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `include:
  - remote: https://example.com/ci/shared.yml
stages: [build]
build:
  stage: build
  extends: .from-remote
  script: make
  needs: [from-remote]
  dependencies: [also-remote]
`})
	got := r.byRule("gitlab-ci.unknown-job")
	if len(got) != 3 || r.gates() != 0 {
		t.Fatalf("want three notes and no Gate: %+v", r.result.Findings)
	}
	for _, f := range got {
		if f.Severity != "note" {
			t.Errorf("severity = %s", f.Severity)
		}
	}
	if len(r.result.Limitations) != 1 || r.result.Status != "completed" {
		t.Errorf("status %s, limitations %+v", r.result.Status, r.result.Limitations)
	}
}

func TestWhileAnIncludeIsUnresolvedAStageIsOnlyANoteIfNoFileDeclaresStages(t *testing.T) {
	remote := "include:\n  - remote: https://example.com/ci/shared.yml\n"
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": remote + "a:\n  stage: from-remote\n  script: make\n"})
	if got := r.byRule("gitlab-ci.unknown-stage"); len(got) != 1 || got[0].Gate {
		t.Errorf("stages may come from the remote file, so a note: %+v", r.result.Findings)
	}
	r = runGitlabCI(t, map[string]string{".gitlab-ci.yml": remote + "stages: [build]\na:\n  stage: from-remote\n  script: make\n"})
	if got := r.byRule("gitlab-ci.unknown-stage"); len(got) != 1 || !got[0].Gate {
		t.Errorf("the project declares its stages, which win over included ones, so a Gate: %+v", r.result.Findings)
	}
}

func TestAMissingLocalIncludeDoesNotMakeReferencesNotes(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": "include: ci/missing.yml\na:\n  script: make\n  needs: [b]\n"})
	if got := r.byRule("gitlab-ci.unknown-job"); len(got) != 1 || !got[0].Gate {
		t.Errorf("a local include that is missing cannot hide a job, so a Gate: %+v", r.result.Findings)
	}
}

func TestStagesDeclaredInAnIncludeCountWhenTheMainFileDeclaresNone(t *testing.T) {
	r := runGitlabCI(t, map[string]string{
		".gitlab-ci.yml": "include: ci/stages.yml\na:\n  stage: lint\n  script: make\nb:\n  stage: other\n  script: make\n",
		"ci/stages.yml":  "stages: [lint]\n",
	})
	if got := r.byRule("gitlab-ci.unknown-stage"); len(got) != 1 || !strings.Contains(got[0].Message, "other") {
		t.Errorf("%+v", r.result.Findings)
	}
}

func TestVariablesAndMergeKeysDoNotBreakTheReferenceChecks(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `.defaults: &defaults
  stage: test
  script: make
default:
  image: node:24
build:
  <<: *defaults
  needs: ["$UPSTREAM"]
  stage: "${STAGE}"
test:
  <<: *defaults
  extends: build
`})
	r.assertClean(t)
}
