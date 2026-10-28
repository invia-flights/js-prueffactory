package checks

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests feed real tool output (captured from the pinned images) to the
// functions that turn it into Findings.

func repoInput(t *testing.T, files map[string]string) *Input {
	t.Helper()
	dir := t.TempDir()
	for rel, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &Input{
		OriginalPath: "/orig", SnapshotDir: dir,
		Context: &discovery.Context{Context: resultset.Context{ID: "C-0001", Kind: "project", Path: "."}},
	}
}

const hadolintOutput = `[{"code":"DL1000","column":5,"file":"/snapshot/weird [1] {a,b}*/Dockerfile","level":"error","line":3,"message":"missing whitespace"},
{"code":"DL3006","column":1,"file":"/snapshot/Dockerfile","level":"warning","line":1,"message":"Always tag the version of an image explicitly"},
{"code":"DL3015","column":1,"file":"/snapshot/Dockerfile","level":"info","line":2,"message":"Avoid additional packages by specifying ` + "`--no-install-recommends`" + `"},
{"code":"SC2086","column":9,"file":"/snapshot/Dockerfile","level":"style","line":4,"message":"Double quote to prevent globbing and word splitting."}]`

func TestHadolintErrorsAreGatesAndTheRestAreNot(t *testing.T) {
	in := repoInput(t, map[string]string{"Dockerfile": "FROM node\n", "weird [1] {a,b}*/Dockerfile": "FROM node\nRUN\n"})
	got, err := hadolintFindings(in, []byte(hadolintOutput))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d findings, want 4: %+v", len(got), got)
	}
	byRule := map[string]resultset.Finding{}
	for _, f := range got {
		byRule[*f.RuleID] = f
	}
	e := byRule["DL1000"]
	if !e.Gate || e.Severity != resultset.SeverityError || e.Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("error finding = gate %v severity %v confidence %v", e.Gate, e.Severity, e.Confidence)
	}
	loc := e.Locations[0]
	if loc.Path != "weird [1] {a,b}*/Dockerfile" || loc.PathBase != "project_root" || loc.Start == nil || loc.Start.Line != 3 || loc.FileSHA256 == "" {
		t.Errorf("location = %+v", loc)
	}
	if e.CheckID != "repository.dockerfile" || e.ContextID != "C-0001" || e.InTestData {
		t.Errorf("finding = %+v", e)
	}
	if e.Reproduction.Rerun[len(e.Reproduction.Rerun)-1] != "repository.dockerfile" {
		t.Errorf("rerun = %v", e.Reproduction.Rerun)
	}
	if f := byRule["DL3006"]; f.Gate || f.Severity != resultset.SeverityWarning {
		t.Errorf("warning finding = gate %v severity %v", f.Gate, f.Severity)
	}
	for _, rule := range []string{"DL3015", "SC2086"} {
		if f := byRule[rule]; f.Gate || f.Severity != resultset.SeverityNote {
			t.Errorf("%s = gate %v severity %v, want a note", rule, f.Gate, f.Severity)
		}
	}
	if len(e.Evidence) != 1 || e.Evidence[0].Trust != resultset.TrustUntrusted || e.Evidence[0].Origin != "hadolint" {
		t.Errorf("evidence = %+v", e.Evidence)
	}
}

func TestHadolintOutputThatIsNotJSONIsAnError(t *testing.T) {
	if _, err := hadolintFindings(repoInput(t, nil), []byte("hadolint: boom")); err == nil {
		t.Error("expected an error")
	}
}

const shellcheckOutput = `{"comments":[
{"file":"/snapshot/bad.sh","line":2,"endLine":2,"column":4,"endColumn":4,"level":"error","code":1073,"message":"Couldn't parse this test expression. Fix to allow more checks.","fix":null},
{"file":"/snapshot/bin/run","line":3,"endLine":3,"column":8,"endColumn":10,"level":"warning","code":2086,"message":"Double quote to prevent globbing and word splitting.","fix":null},
{"file":"/snapshot/bin/run","line":5,"endLine":5,"column":1,"endColumn":2,"level":"style","code":2250,"message":"Prefer putting braces around variable references.","fix":null},
{"file":"/snapshot/bin/run","line":6,"endLine":6,"column":1,"endColumn":2,"level":"info","code":2034,"message":"x appears unused.","fix":null}]}`

func TestShellCheckErrorsAreGatesAndRulesAreSCCodes(t *testing.T) {
	in := repoInput(t, map[string]string{"bad.sh": "x\n", "bin/run": "x\n"})
	got, err := shellcheckFindings(in, []byte(shellcheckOutput))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d findings", len(got))
	}
	byRule := map[string]resultset.Finding{}
	for _, f := range got {
		byRule[*f.RuleID] = f
	}
	e := byRule["SC1073"]
	if !e.Gate || e.Severity != resultset.SeverityError || e.CheckID != "repository.shell" {
		t.Errorf("error finding = %+v", e)
	}
	if e.Locations[0].Path != "bad.sh" || e.Locations[0].Start.Line != 2 || *e.Locations[0].Start.Column != 4 {
		t.Errorf("location = %+v", e.Locations[0])
	}
	if f := byRule["SC2086"]; f.Gate || f.Severity != resultset.SeverityWarning {
		t.Errorf("SC2086 = %+v", f)
	}
	for _, rule := range []string{"SC2250", "SC2034"} {
		if f := byRule[rule]; f.Gate || f.Severity != resultset.SeverityNote {
			t.Errorf("%s = gate %v severity %v", rule, f.Gate, f.Severity)
		}
	}
}

const redoclyStructError = `{"totals":{"errors":1,"warnings":1,"ignored":0},"version":"2.70.0","problems":[
{"ruleId":"struct","severity":"error","message":"The field ` + "`version`" + ` must be present on this level.","location":[{"source":{"ref":"api.yaml"},"pointer":"#/info","reportOnKey":true,"start":{"line":2,"col":1},"end":{"line":2,"col":5}}],"suggest":[]},
{"ruleId":"no-empty-servers","severity":"warn","message":"Servers must be present.","location":[{"source":{"ref":"api.yaml"},"pointer":"#/servers","start":{"line":1,"col":1}}],"suggest":[]}]}`

const redoclyRemoteRef = `{"totals":{"errors":1,"warnings":0,"ignored":0},"version":"2.70.0","problems":[
{"ruleId":"no-unresolved-refs","severity":"error","location":[{"source":{"ref":"remote.yaml"},"pointer":"#/paths/~1a","reportOnKey":false,"start":{"line":7,"col":5},"end":{"line":7,"col":39}}],"message":"Can't resolve $ref: fetch failed","reference":"https://redocly.com/docs/cli/rules/oas/no-unresolved-refs","suggest":[]}]}`

func TestRedoclyStructuralErrorsAreGates(t *testing.T) {
	in := repoInput(t, map[string]string{"weird [1]/api.yaml": "openapi: 3.0.0\n"})
	got, err := redoclyFindings(in, openAPITarget{Path: "weird [1]/api.yaml"}, []byte(redoclyStructError), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d findings", len(got))
	}
	e := got[0]
	if *e.RuleID != "struct" || !e.Gate || e.Severity != resultset.SeverityError || e.CheckID != "api.lint" {
		t.Errorf("error finding = %+v", e)
	}
	if e.Locations[0].Path != "weird [1]/api.yaml" || e.Locations[0].Start.Line != 2 || *e.Locations[0].Start.Column != 1 {
		t.Errorf("location = %+v", e.Locations[0])
	}
	if w := got[1]; w.Gate || w.Severity != resultset.SeverityWarning {
		t.Errorf("warning finding = %+v", w)
	}
}

func TestRedoclyUnresolvedRemoteRefsAreDroppedOnlyForFilesWithRemoteRefs(t *testing.T) {
	in := repoInput(t, map[string]string{"remote.yaml": "openapi: 3.0.0\n"})
	got, err := redoclyFindings(in, openAPITarget{Path: "remote.yaml", RemoteRef: true}, []byte(redoclyRemoteRef), nil)
	if err != nil || len(got) != 0 {
		t.Errorf("remote file: findings %v, err %v, want none", got, err)
	}
	got, err = redoclyFindings(in, openAPITarget{Path: "remote.yaml"}, []byte(redoclyRemoteRef), nil)
	if err != nil || len(got) != 1 || !got[0].Gate {
		t.Errorf("local-only file: findings %v, err %v, want one Gate", got, err)
	}
}

func TestRedoclyOutputThatIsNotJSONIsAnErrorThatQuotesWhatRedoclyPrinted(t *testing.T) {
	target := openAPITarget{Path: "a.yaml"}
	_, err := redoclyFindings(repoInput(t, nil), target, nil, []byte("Failed to parse a.yaml: unexpected character\n"))
	var noJSON *redoclyNoJSON
	if !errors.As(err, &noJSON) || !strings.Contains(err.Error(), "unexpected character") || strings.Contains(err.Error(), "JSON input") {
		t.Errorf("stderr: err = %v", err)
	}
	// Stdout is quoted when stderr is empty, and only its first 200 bytes.
	_, err = redoclyFindings(repoInput(t, nil), target, []byte("No APIs were provided."+strings.Repeat("x", 300)), nil)
	if !errors.As(err, &noJSON) || !strings.HasPrefix(noJSON.Output, "No APIs were provided.") || len(noJSON.Output) != 200 {
		t.Fatalf("stdout: err = %v", err)
	}
}

func TestAnUnparseableOpenAPIFileIsAGateWithRedoclysOutputAsEvidence(t *testing.T) {
	in := repoInput(t, nil)
	perr := &parseError{rule: ruleInvalidYAML, line: 5, message: "control characters are not allowed"}
	f := unparseableFinding(in, openAPITarget{Path: "api/openapi.yaml"}, perr, "Failed to parse api/openapi.yaml")
	if f.CheckID != "api.lint" || *f.RuleID != "unparseable" || !f.Gate || f.Severity != resultset.SeverityError {
		t.Errorf("finding = %+v", f)
	}
	if loc := f.Locations[0]; loc.Path != "api/openapi.yaml" || loc.Start.Line != 5 {
		t.Errorf("location = %+v", loc)
	}
	if len(f.Evidence) != 1 || f.Evidence[0].Text != "Failed to parse api/openapi.yaml" {
		t.Errorf("evidence = %+v", f.Evidence)
	}
}
