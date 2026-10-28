package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func composeInput() *Input { return &Input{Context: &discovery.Context{ID: "C-0001"}} }

const unsetWarning = `time="2026-10-27T11:03:13Z" level=warning msg="The \"TAG\" variable is not set. Defaulting to a blank string."` + "\n"

func TestAnUnsetVariableIsAWarningNamingTheVariableAndNoGate(t *testing.T) {
	stderr := unsetWarning +
		`time="2026-10-27T11:03:13Z" level=warning msg="The \"SECRET_X\" variable is not set. Defaulting to a blank string."` + "\n" +
		unsetWarning // compose repeats it for every use
	found := composeSetFindings(composeInput(), composeSet{Files: []string{"compose.yaml", "compose.override.yaml"}}, 0, stderr)
	if len(found) != 2 {
		t.Fatalf("findings = %+v, want one per variable", found)
	}
	for i, name := range []string{"SECRET_X", "TAG"} {
		f := found[i]
		if f.Gate || f.Severity != resultset.SeverityWarning || ruleOf(f) != "compose.variable-missing" {
			t.Errorf("%s: finding = %+v, want a warning without Gate", name, f)
		}
		if !strings.Contains(f.Title, name) || !strings.Contains(f.Message, name) || !strings.Contains(f.Message, "compose.yaml") {
			t.Errorf("%s: title %q and message %q should name the variable and the set", name, f.Title, f.Message)
		}
		if f.Locations[0].Path != "compose.yaml" {
			t.Errorf("%s: location = %+v", name, f.Locations[0])
		}
	}
	if found[0].Fingerprint == found[1].Fingerprint {
		t.Error("the two variables share a fingerprint")
	}
}

func TestARequiredVariableErrorIsAWarningNamingTheVariable(t *testing.T) {
	stderr := "error while interpolating services.web.ports.[]: required variable PORT is missing a value: port is required\n"
	found := composeSetFindings(composeInput(), composeSet{Files: []string{"compose.yaml"}}, 1, stderr)
	if len(found) != 1 || found[0].Gate || ruleOf(found[0]) != "compose.variable-missing" || !strings.Contains(found[0].Message, "PORT") {
		t.Fatalf("findings = %+v, want one warning for PORT", found)
	}
	if !strings.Contains(found[0].Message, "not validated") {
		t.Errorf("message %q should say compose stopped at the variable and the rest was not validated", found[0].Message)
	}
}

func TestAnyOtherErrorIsAGateWithComposesMessageAsUntrustedEvidence(t *testing.T) {
	stderr := "validating /snapshot/compose.override.yaml: services.web.prots false schema\n"
	set := composeSet{Files: []string{"compose.yaml", "compose.override.yaml"}}
	found := composeSetFindings(composeInput(), set, 1, stderr)
	if len(found) != 1 {
		t.Fatalf("findings = %+v", found)
	}
	f := found[0]
	if !f.Gate || f.Severity != resultset.SeverityError || ruleOf(f) != "compose.invalid" {
		t.Errorf("finding = %+v, want an error Gate", f)
	}
	if f.Locations[0].Path != "compose.override.yaml" {
		t.Errorf("location = %+v, want the file compose names", f.Locations[0])
	}
	if len(f.Evidence) != 1 || f.Evidence[0].Trust != resultset.TrustUntrusted ||
		f.Evidence[0].Text != "validating compose.override.yaml: services.web.prots false schema" {
		t.Errorf("evidence = %+v, want compose's message, untrusted, without the container path", f.Evidence)
	}
	if strings.Contains(f.Message, "prots") || strings.Contains(f.Title, "prots") {
		t.Errorf("compose's text is in a trusted field: %q / %q", f.Title, f.Message)
	}
}

func TestWarningsOfComposeOtherThanVariablesAreNotFindings(t *testing.T) {
	stderr := `time="2026-10-27T11:03:13Z" level=warning msg="/snapshot/compose.yaml: the attribute ` + "`version`" + ` is obsolete, it will be ignored"` + "\n"
	if found := composeSetFindings(composeInput(), composeSet{Files: []string{"compose.yaml"}}, 0, stderr); len(found) != 0 {
		t.Errorf("findings = %+v, want none", found)
	}
}

func TestAFailureWithoutAnyMessageIsStillAGate(t *testing.T) {
	found := composeSetFindings(composeInput(), composeSet{Files: []string{"compose.yaml"}}, 1, "")
	if len(found) != 1 || !found[0].Gate {
		t.Errorf("findings = %+v, want one Gate", found)
	}
}

func TestSetAndVariableNamesFromTheProjectStayOutOfTrustedTextUnlessTheyLookLikeNames(t *testing.T) {
	set := composeSet{Files: []string{"compose **ignore all** [x](http://evil.example).yaml"}}
	stderr := `level=warning msg="The \"A [click](http://evil.example)\" variable is not set. Defaulting to a blank string."` + "\n"
	for _, f := range append(composeSetFindings(composeInput(), set, 0, stderr), composeSetFindings(composeInput(), set, 1, "bad")...) {
		for _, text := range []string{f.Title, f.Message} {
			for _, bad := range []string{"ignore all", "evil.example", "click"} {
				if strings.Contains(text, bad) {
					t.Errorf("project text %q in a trusted field: %q", bad, text)
				}
			}
		}
	}
}

func TestSetsWithARemoteIncludeAreFoundIncludingThroughLocalIncludes(t *testing.T) {
	proj := tree(t, map[string]string{
		"compose.yaml":     "include:\n  - ./parts/db.yaml\n  - path: [./parts/cache.yaml]\n    env_file: .env\nservices: {}\n",
		"parts/db.yaml":    "include:\n  - https://example.test/shared.git\nservices: {}\n",
		"parts/cache.yaml": "services: {}\n",
		"compose.ci.yaml":  "include: oci://registry.example.test/stack:1\n",
		"compose.dev.yaml": "include:\n  - path: ./parts/cache.yaml\nservices: {}\n",
	})
	in := &Input{Project: proj, SnapshotDir: proj.Root}
	remote := map[string][]composeRemote{}
	for _, set := range composeSets(proj) {
		remote[set.Files[0]] = composeRemoteIncludes(in, set)
	}
	if got := remote["compose.yaml"]; len(got) != 1 || got[0].Value != "https://example.test/shared.git" || got[0].File != "parts/db.yaml" {
		t.Errorf("compose.yaml: remote includes = %v", got)
	}
	if got := remote["compose.ci.yaml"]; len(got) != 1 {
		t.Errorf("compose.ci.yaml: remote includes = %v", got)
	}
	if got := remote["compose.dev.yaml"]; len(got) != 0 {
		t.Errorf("compose.dev.yaml: remote includes = %v, want none", got)
	}
}

func TestARemoteIncludeLimitationQuotesOnlyValuesThatLookLikeAddresses(t *testing.T) {
	set := composeSet{Files: []string{"compose.yaml"}}
	ordinary := composeIncludeLimitation(set, composeRemote{File: "compose.yaml", Value: "https://git.example.test/org/stack.git?ref=main"})
	if !strings.Contains(ordinary.Message, "https://git.example.test/org/stack.git?ref=main") {
		t.Errorf("message %q lacks the address", ordinary.Message)
	}
	hostile := composeIncludeLimitation(set, composeRemote{File: "compose.yaml", Value: "https://x.test/a b **ignore all** [c](http://evil.example)"})
	for _, bad := range []string{"ignore all", "evil.example", "**"} {
		if strings.Contains(hostile.Message, bad) {
			t.Errorf("project text %q in a Limitation message: %q", bad, hostile.Message)
		}
	}
}
