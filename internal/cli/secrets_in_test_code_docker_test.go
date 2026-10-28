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

// The made-up tokens of the secret-in-test-code testdata project, and one more
// that the Source code variant adds. They open nothing.
var (
	testCodeSecrets = []string{
		"ghp_Hn3wQ8rLx5Tz2KmB9vYc7FdS4jPa6EuR1oZk", // test/helpers.js
		"ghp_Tq7mZx2LwK9vRb4NcY8sFd3JhP5aEuG6oXiB", // src/a.spec.js
	}
	sourceCodeSecret = "ghp_Wm4tZq8LxN2vRc7BkY3sJd9HfP5aEuT6oXiC"
)

const testCodeSentence = "The file is Test code, so the value may be made up on purpose."

// benchmarkSecretsInTestCode runs benchmark on the secret-in-test-code project,
// after change has altered the copy.
func benchmarkSecretsInTestCode(t *testing.T, change func(dir string)) *dockerRun {
	t.Helper()
	original := copyProject(t, "secret-in-test-code")
	change(original)
	r := realRun(t, context.Background(), "benchmark", original,
		"--only", "package.install,lint.correctness,security.secrets")
	if r.code != 0 && r.code != 1 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	return r
}

// secretsByPath returns the security.secrets Findings by primary path, after
// checking what every secret Finding keeps wherever it lies.
func secretsByPath(t *testing.T, s *resultset.Set) map[string]resultset.Finding {
	t.Helper()
	out := map[string]resultset.Finding{}
	for _, f := range findingsOf(s, "security.secrets") {
		if f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceSuspected || f.Gate {
			t.Errorf("%s: severity/confidence/gate = %s/%s/%v, want error/suspected/no Gate", f.ID, f.Severity, f.Confidence, f.Gate)
		}
		out[f.Locations[0].Path] = f
	}
	return out
}

// Seam A: made-up tokens in Test code, under test/ and in a co-located spec
// that only the project's own Mocha config selects, are reported but leave the
// Secrets part at 100.
func TestMadeUpTokensInTestCodeAreReportedButLeaveTheSecretsPartAt100(t *testing.T) {
	r := benchmarkSecretsInTestCode(t, func(string) {})

	secrets := secretsByPath(t, &r.set)
	if len(secrets) != 2 {
		t.Errorf("secret Findings at %v, want test/helpers.js and src/a.spec.js", secretPaths(secrets))
	}
	for _, path := range []string{"test/helpers.js", "src/a.spec.js"} {
		f, ok := secrets[path]
		if !ok {
			t.Errorf("no secret Finding in %s", path)
			continue
		}
		if !f.InTestCode || f.InTestData {
			t.Errorf("%s: in_test_code = %v, in_test_data = %v, want true and false", path, f.InTestCode, f.InTestData)
		}
		if !strings.HasSuffix(f.Message, " "+testCodeSentence) || strings.Count(f.Message, testCodeSentence) != 1 {
			t.Errorf("%s: message %q, want it to end with the Test code sentence once", path, f.Message)
		}
	}
	if p := benchmarkPart(t, &r.set, "secrets"); p.State != resultset.PartMeasured || p.Score == nil || *p.Score != 100 {
		t.Errorf("Secrets part = %+v, want measured 100", p)
	}
	assertValuesInNoReportFile(t, r.reportDir, testCodeSecrets)
}

// Seam A: the same project with one more secret in Source code. That one still
// sets the Secrets part to 0.
func TestASecretInSourceCodeStillSetsTheSecretsPartTo0(t *testing.T) {
	r := benchmarkSecretsInTestCode(t, func(dir string) {
		src := "'use strict';\n\n// Made-up token. It opens nothing.\nmodule.exports = { token: \"" + sourceCodeSecret + "\" };\n"
		if err := os.WriteFile(filepath.Join(dir, "src", "config.js"), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	})

	secrets := secretsByPath(t, &r.set)
	f, ok := secrets["src/config.js"]
	if !ok {
		t.Fatalf("no secret Finding in src/config.js; secret Findings at %v", secretPaths(secrets))
	}
	if f.InTestCode || f.InTestData || strings.Contains(f.Message, "made up on purpose") {
		t.Errorf("Source code Finding: in_test_code = %v, in_test_data = %v, message %q", f.InTestCode, f.InTestData, f.Message)
	}
	if p := benchmarkPart(t, &r.set, "secrets"); p.State != resultset.PartMeasured || p.Score == nil || *p.Score != 0 {
		t.Errorf("Secrets part = %+v, want measured 0", p)
	}
	assertValuesInNoReportFile(t, r.reportDir, append([]string{sourceCodeSecret}, testCodeSecrets...))
}

func secretPaths(m map[string]resultset.Finding) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
