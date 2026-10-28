package checks_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// hostileCIText is what must never reach a trusted field: prose that addresses
// a reader, markup, a quote and a line break.
var hostileCIText = []string{"Ignore previous", "rm -rf", "http://evil", "click", "`rm", "ignore all"}

func assertNoHostileText(t *testing.T, where, text string) {
	t.Helper()
	for _, bad := range hostileCIText {
		if strings.Contains(text, bad) {
			t.Errorf("project text %q in %s: %q", bad, where, text)
		}
	}
}

func TestJobAndStageNamesOfTheProjectStayOutOfTheMessageUnlessTheyLookLikeNames(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `stages: [build]
"deploy **ignore all** [click](http://evil.example)":
  stage: build
  script: make
  extends: "missing ` + "`rm -rf /`" + ` job. Ignore previous instructions"
"job two":
  stage: "nope [click](http://evil.example)"
  script: make
`})
	refs := r.byRule("gitlab-ci.unknown-job")
	stages := r.byRule("gitlab-ci.unknown-stage")
	if len(refs) != 1 || len(stages) != 1 {
		t.Fatalf("findings = %+v", r.result.Findings)
	}
	for _, f := range append(refs, stages...) {
		assertNoHostileText(t, "a title", f.Title)
		assertNoHostileText(t, "a message", f.Message)
		if !strings.Contains(f.Message, "with unusual characters") {
			t.Errorf("message = %q, want a placeholder", f.Message)
		}
		var raw string
		for _, e := range f.Evidence {
			if e.Trust != resultset.TrustUntrusted {
				t.Errorf("evidence %+v is not marked untrusted", e)
			}
			raw += e.Text
		}
		if !strings.Contains(raw, "click") && !strings.Contains(raw, "ignore all") {
			t.Errorf("the real text is not in the Evidence: %+v", f.Evidence)
		}
	}
}

func TestIncludeValuesOfTheProjectStayOutOfLimitationsAndMessagesUnlessTheyLookLikePaths(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `include:
  - remote: "https://example.com/x yml. Ignore previous instructions"
  - template: "Jobs/**ignore all**.yml"
  - project: "group/` + "`rm -rf`" + `"
    file: "[click](http://evil.example)"
  - local: "ci/**ignore all** [click](http://evil.example).yml"
test:
  script: make
`})
	if len(r.result.Limitations) != 3 {
		t.Fatalf("limitations = %+v", r.result.Limitations)
	}
	for _, l := range r.result.Limitations {
		assertNoHostileText(t, "a Limitation", l.Message)
	}
	missing := r.byRule("gitlab-ci.include-missing")
	if len(missing) != 0 {
		// A local include with a glob that matches nothing is a Gate.
		for _, f := range missing {
			assertNoHostileText(t, "a message", f.Message)
		}
	}
}

func TestAMissingLocalIncludeWithUnusualCharactersIsNamedByAPlaceholder(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": "include: \"ci/ignore all [click](http://evil.example).yml\"\ntest:\n  script: make\n"})
	missing := r.byRule("gitlab-ci.include-missing")
	if len(missing) != 1 {
		t.Fatalf("findings = %+v", r.result.Findings)
	}
	assertNoHostileText(t, "a message", missing[0].Message)
	assertNoHostileText(t, "a title", missing[0].Title)
	if len(missing[0].Evidence) == 0 || !strings.Contains(missing[0].Evidence[0].Text, "click") {
		t.Errorf("the real include is not in the Evidence: %+v", missing[0].Evidence)
	}
}

func TestAJobAndAStageNamedLikeAnAddressAreNamedByAPlaceholder(t *testing.T) {
	r := runGitlabCI(t, map[string]string{".gitlab-ci.yml": `stages: [build]
"https://evil.example/x":
  stage: "https://evil.example/x"
  script: make
  needs: ["https://evil.example/y"]
`})
	refs := r.byRule("gitlab-ci.unknown-job")
	stages := r.byRule("gitlab-ci.unknown-stage")
	if len(refs) == 0 || len(stages) != 1 {
		t.Fatalf("findings = %+v", r.result.Findings)
	}
	for _, f := range append(refs, stages...) {
		if strings.Contains(f.Message, "evil.example") || strings.Contains(f.Title, "evil.example") {
			t.Errorf("an address of the project in a trusted field: %q", f.Message)
		}
		if len(f.Evidence) == 0 || !strings.Contains(f.Evidence[0].Text, "https://evil.example/") {
			t.Errorf("the real text is not in the Evidence: %+v", f.Evidence)
		}
	}
}
