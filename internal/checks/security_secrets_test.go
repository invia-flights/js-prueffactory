package checks

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Every secret in this file is made up.
const (
	patLine2   = "ghp_9fK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiA"
	stripeKey  = "sk_prod_51Hq9ZtLmNvXw3RbKd8YcFgPa7JeUo2VnSi4TxCzMh6QlWrEy"
	passwordV  = "xK3mQx7TzLw2VbN8sYc"
	apiKeyV    = "Zk3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiB"
	keyLine    = "MIIEowIBAAKCAQEAxK3mQx7TzLw2VbN8sYcR4dJhP6aEuG1oXiAfK3mQx7TzLw2V"
	privateKey = "-----BEGIN RSA PRIVATE KEY-----\n" + keyLine + "\n-----END RSA PRIVATE KEY-----"
)

func writeFiles(t *testing.T, files map[string]string) string {
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
	return dir
}

// gitleaksReport builds the JSON gitleaks prints with --redact. Its positions
// follow what gitleaks 8.30.1 really reports: columns are bytes, the first line
// counts from 1 and every later line is one column further right, and the end
// column is the last character, not the one after it.
func gitleaksReport(leaks ...string) []byte {
	return []byte("[" + strings.Join(leaks, ",") + "]")
}

func leak(rule, file string, startLine, startCol, endLine, endCol int) string {
	b, _ := json.Marshal(map[string]any{
		"RuleID": rule, "Description": "Uncovered " + rule + ".",
		"StartLine": startLine, "EndLine": endLine, "StartColumn": startCol, "EndColumn": endCol,
		"Match": "REDACTED", "Secret": "REDACTED", "File": "/snapshot/" + file,
	})
	return string(b)
}

func TestSecretsAreReadFromTheSnapshotByFileAndPosition(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"src/config.js":            "// made up\nconst token = \"" + patLine2 + "\";\n",
		"test/fixtures/creds.json": "{\"stripe\": \"" + stripeKey + "\"}\n",
		"deploy/key.pem":           privateKey + "\ntrailing\n",
		"cfg.yml":                  "password = \"" + passwordV + "\"\napi_key: \"" + apiKeyV + "\"\n",
	})
	in := &Input{SnapshotDir: dir, OriginalPath: "/work/demo"}

	report := gitleaksReport(
		leak("github-pat", "src/config.js", 2, 17, 2, 56),
		// The Stripe match ends with the closing quote.
		leak("stripe-access-token", "test/fixtures/creds.json", 1, 13, 1, 70),
		leak("private-key", "deploy/key.pem", 1, 1, 3, 30),
		leak("generic-api-key", "cfg.yml", 1, 1, 1, 32),
		leak("generic-api-key", "cfg.yml", 2, 2, 2, 47),
	)
	findings, values, err := interpretGitleaks(report, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 5 {
		t.Fatalf("findings = %d, want 5", len(findings))
	}

	have := map[string]bool{}
	for _, v := range values {
		have[v] = true
	}
	for _, want := range []string{patLine2, stripeKey, keyLine, passwordV, apiKeyV, privateKey} {
		if !have[want] {
			t.Errorf("value %q was not collected; got %q", want, values)
		}
	}

	f := findings[0]
	if f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceSuspected || f.Gate {
		t.Errorf("severity/confidence/gate = %s/%s/%v", f.Severity, f.Confidence, f.Gate)
	}
	if f.InTestData || !findings[1].InTestData {
		t.Errorf("in_test_data = %v, %v; want false, true", f.InTestData, findings[1].InTestData)
	}
	if f.Kind != resultset.KindSuspicion || f.RuleID == nil || *f.RuleID != "github-pat" {
		t.Errorf("kind/rule = %s/%v", f.Kind, f.RuleID)
	}
	loc := f.Locations[0]
	// The secret starts at column 16 of line 2, and ends before column 56.
	if loc.Path != "src/config.js" || loc.Start.Line != 2 || *loc.Start.Column != 16 || *loc.End.Column != 56 || loc.FileSHA256 == "" {
		t.Errorf("location = %+v start=%+v end=%+v", loc, loc.Start, loc.End)
	}
	if f.Locations[0].Role != "primary" || f.Reproduction.VerifiedBy[0] != "security.secrets" {
		t.Errorf("finding = %+v", f)
	}

	// The Findings themselves carry no value.
	doc, _ := json.Marshal(findings)
	for _, v := range values {
		if strings.Contains(string(doc), v) {
			t.Errorf("the findings contain %q", v)
		}
	}
}

func TestColumnsCountCodePointsInTheReport(t *testing.T) {
	// "é" and "ö" take two bytes each. gitleaks counts bytes, the Report counts
	// code points.
	line := "// héllo wörld \"" + patLine2 + "\"\n"
	dir := writeFiles(t, map[string]string{"a.js": "x\n" + line})
	in := &Input{SnapshotDir: dir}
	start := strings.Index(line, patLine2) + 1 + 1 // 1-based, and +1 for a later line
	end := start + len(patLine2) - 1
	findings, values, err := interpretGitleaks(gitleaksReport(leak("github-pat", "a.js", 2, start, 2, end)), in)
	if err != nil || len(findings) != 1 {
		t.Fatalf("err = %v, findings = %d", err, len(findings))
	}
	if len(values) == 0 || values[0] != patLine2 {
		t.Errorf("values = %q", values)
	}
	if col := *findings[0].Locations[0].Start.Column; col != 17 {
		t.Errorf("column = %d, want 17 code points", col)
	}
}

func TestFindingsOfOneRuleInOneFileKeepDistinctFingerprints(t *testing.T) {
	dir := writeFiles(t, map[string]string{"a.js": "x\nconst a = \"" + patLine2 + "\"\nconst b = \"" + patLine2 + "\"\n"})
	in := &Input{SnapshotDir: dir}
	findings, _, err := interpretGitleaks(gitleaksReport(
		leak("github-pat", "a.js", 2, 13, 2, 52),
		leak("github-pat", "a.js", 3, 13, 3, 52),
	), in)
	if err != nil || len(findings) != 2 {
		t.Fatalf("err = %v, findings = %d", err, len(findings))
	}
	if findings[0].Fingerprint == findings[1].Fingerprint {
		t.Error("two Findings share a fingerprint")
	}
}

func TestUnreadableFileStillGivesAFindingButNoValue(t *testing.T) {
	in := &Input{SnapshotDir: t.TempDir()}
	findings, values, err := interpretGitleaks(gitleaksReport(leak("github-pat", "gone.js", 1, 1, 1, 10)), in)
	if err != nil || len(findings) != 1 || len(values) != 0 {
		t.Fatalf("err = %v, findings = %d, values = %q", err, len(findings), values)
	}
	if findings[0].Locations[0].FileSHA256 != "" {
		t.Errorf("sha = %q", findings[0].Locations[0].FileSHA256)
	}
}

func TestAnEmptyReportHasNoFindings(t *testing.T) {
	for _, out := range []string{"", "[]", " null\n"} {
		findings, values, err := interpretGitleaks([]byte(out), &Input{SnapshotDir: t.TempDir()})
		if err != nil || len(findings) != 0 || len(values) != 0 {
			t.Errorf("%q: err = %v, findings = %d", out, err, len(findings))
		}
	}
	if _, _, err := interpretGitleaks([]byte("not json"), &Input{SnapshotDir: t.TempDir()}); err == nil {
		t.Error("garbage was accepted")
	}
}

func TestPathsOutsideTheSnapshotAreNotRead(t *testing.T) {
	outside := writeFiles(t, map[string]string{"secret.txt": "sensitive-value-123"})
	snap := t.TempDir()
	in := &Input{SnapshotDir: snap}
	rel, _ := filepath.Rel(snap, filepath.Join(outside, "secret.txt"))
	report := gitleaksReport(leak("x", "../"+rel, 1, 1, 1, 19), leak("x", "/etc/passwd", 1, 1, 1, 5))
	_, values, err := interpretGitleaks(report, in)
	if err != nil || len(values) != 0 {
		t.Errorf("err = %v, values = %q", err, values)
	}
}

func tarOf(names ...string) func(io.Writer) error {
	return func(w io.Writer) error {
		tw := tar.NewWriter(w)
		for _, n := range names {
			body := "content of " + n
			if err := tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))}); err != nil {
				return err
			}
			if _, err := tw.Write([]byte(body)); err != nil {
				return err
			}
		}
		return tw.Close()
	}
}

func TestTheScanCopyOmitsTheProjectsRootIgnoreFileOnly(t *testing.T) {
	// gitleaks reads <scan folder>/.gitleaksignore even with an explicit ignore
	// path, so the copy it scans must not have one. A nested file is never read.
	var buf bytes.Buffer
	err := copyTarWithout(tarOf("package.json", ".gitleaksignore", "src/.gitleaksignore", "src/a.js"), &buf, ".gitleaksignore")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	tr := tar.NewReader(&buf)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		if string(body) != "content of "+h.Name {
			t.Errorf("%s has body %q", h.Name, body)
		}
		names = append(names, h.Name)
	}
	if got := strings.Join(names, ","); got != "package.json,src/.gitleaksignore,src/a.js" {
		t.Errorf("entries = %s", got)
	}
}

func TestACopyThatFailsHalfWayReportsTheError(t *testing.T) {
	failing := func(w io.Writer) error {
		_ = tarOf("a")(w)
		return errors.New("disk on fire")
	}
	if err := copyTarWithout(failing, io.Discard, ".gitleaksignore"); err == nil || !strings.Contains(err.Error(), "disk on fire") {
		t.Errorf("err = %v", err)
	}
}

func TestSecretsCheckMetadata(t *testing.T) {
	e, ok := Lookup("security.secrets")
	if !ok || e.Status != Implemented || e.Scope != PerProject || e.CanFireGates {
		t.Errorf("entry = %+v", e)
	}
}
