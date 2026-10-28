//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/redact"
)

// The secret-looking value of the .env file of the ordinary-env-values
// testdata project. It is made up.
const envSecret = "Xk9fK3mQx7TzLw2VbN8s"

// identifierKeys are the fields of report.json that name a thing and are never
// redacted for a value of a .env file.
var identifierKeys = map[string]bool{
	"path": true, "rule_id": true, "check_id": true, "compose_service": true, "family": true,
	"image": true, "declared_image": true, "file": true,
}

// Seam A: a whole Run on a project whose .env file holds one secret-looking
// value and ordinary ones (a word, a host name, a path prefix), where a source
// file path and a Service name contain the ordinary values. The ordinary values
// stay readable, in paths and Service names first of all, and the secret is
// redacted everywhere, report.md included (ticket 35).
func TestOrdinaryEnvValuesStayInPathsAndServiceNamesAndOnlyTheSecretIsRedacted(t *testing.T) {
	original := copyProject(t, "ordinary-env-values")

	r := realRun(t, context.Background(), "test", original, "--only", "syntax.parse")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 (a parse error in Source code)\nstderr:\n%s", r.code, r.stderr)
	}

	// The path of the Finding and the Service name are intact.
	const brokenPath = "src/billing/hello-client.js"
	var broken bool
	for _, f := range findingsOf(&r.set, "syntax.parse") {
		if len(f.Locations) > 0 && f.Locations[0].Path == brokenPath {
			broken = true
			for _, ev := range f.Evidence {
				if strings.Contains(ev.Text, envSecret) {
					t.Errorf("the evidence holds the secret: %q", ev.Text)
				}
			}
		}
	}
	if !broken {
		t.Errorf("no syntax.parse Finding at %s: %+v", brokenPath, findingsOf(&r.set, "syntax.parse"))
	}
	if sv := serviceNamed(t, &r.set, "hello-store"); sv.ComposeService != "hello-store" || sv.Family != "valkey" {
		t.Errorf("service = %+v", sv)
	}

	// No identifier field of report.json holds a placeholder.
	walkJSON(r.report, "", func(key string, v string) {
		if identifierKeys[key] && strings.Contains(v, redact.Placeholder) {
			t.Errorf("%s = %q: an identifier was redacted", key, v)
		}
	})

	// The ordinary value stays readable in the quoted line, the secret does not.
	evidence := ""
	for _, f := range findingsOf(&r.set, "syntax.parse") {
		for _, ev := range f.Evidence {
			evidence += ev.Text + "\n"
		}
	}
	if !strings.Contains(evidence, `"hello"`) || !strings.Contains(evidence, redact.Placeholder) {
		t.Errorf("the quoted line should keep hello and redact the secret:\n%s", evidence)
	}

	// Redaction applied, with a count, and the Report says which rule decided.
	if red := r.set.ReportCompleteness.Redaction; !red.Applied || red.Count < 1 || red.Reason != nil {
		t.Errorf("redaction = %+v", red)
	}
	var limitation string
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "env_values_left_readable" {
			limitation = l.Message
		}
	}
	if !strings.Contains(limitation, redact.EnvRule) {
		t.Errorf("no Limitation states the rule: %q", limitation)
	}
	for _, name := range []string{"GREETING", "CACHE_HOST", "PATH_PREFIX"} {
		if !strings.Contains(limitation, name) {
			t.Errorf("the Limitation does not name %s: %q", name, limitation)
		}
	}
	if strings.Contains(limitation, "REPORT_SIGNING") {
		t.Errorf("the Limitation names the redacted variable: %q", limitation)
	}

	// report.json, report.md and every artifact: no secret, intact paths.
	for _, name := range []string{"report.json", "report.md"} {
		data, err := os.ReadFile(filepath.Join(r.reportDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), envSecret) {
			t.Errorf("%s holds the secret", name)
		}
		for _, want := range []string{brokenPath, "hello-store"} {
			if !strings.Contains(string(data), want) {
				t.Errorf("%s does not show %q", name, want)
			}
		}
	}
	md, _ := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if !strings.Contains(string(md), redact.Placeholder) {
		t.Errorf("report.md shows no redaction")
	}
	err := filepath.WalkDir(r.reportDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		if err == nil && strings.Contains(string(data), envSecret) {
			t.Errorf("%s holds the secret", p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	r.assertNothingLeft(t)
}

// The secret-looking value of the .env file of the placeholder-env-values
// testdata project. It is made up.
const placeholderEnvSecret = "Qm7vR2xKp9LzT4wYb8NcJ3dH"

// Seam A: a whole Run on a project whose .env file holds a placeholder under a
// secret-sounding name (SOME_SECRET_KEY=empty) and a real-looking secret, and
// whose failing test has a title that contains the placeholder word. The title
// and the command that re-runs the test by that title stay intact, the secret
// is redacted everywhere, report.md included, and the Limitation names the
// placeholder rule (ticket 10).
func TestAPlaceholderUnderASecretNameStaysReadableInTestTitlesAndRerunCommands(t *testing.T) {
	original := copyProject(t, "placeholder-env-values")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 (a failing test)\nstderr:\n%s", r.code, r.stderr)
	}
	const title = "store answers an empty list"
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 || fs[0].Reproduction.Test == nil {
		t.Fatalf("findings = %+v, want one with a test reproduction", fs)
	}
	repro := fs[0].Reproduction.Test
	if repro.FullTitle != title {
		t.Errorf("full title = %q, want %q", repro.FullTitle, title)
	}
	if want := []string{"npx", "mocha", "--fgrep", title, "test/store.test.js"}; !slices.Equal(repro.NativeCommand, want) {
		t.Errorf("native command = %q, want %q", repro.NativeCommand, want)
	}
	if !strings.Contains(fs[0].Title, "empty list") {
		t.Errorf("finding title = %q", fs[0].Title)
	}

	// The secret is redacted in every file, and the failure message shows where.
	for _, name := range []string{"report.json", "report.md"} {
		data, err := os.ReadFile(filepath.Join(r.reportDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), placeholderEnvSecret) {
			t.Errorf("%s holds the secret", name)
		}
		if !strings.Contains(string(data), "empty list") {
			t.Errorf("%s does not show the test title", name)
		}
		if name == "report.md" && !strings.Contains(string(data), "--fgrep") {
			t.Errorf("report.md does not show the re-run command")
		}
	}
	err := filepath.WalkDir(r.reportDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		if err == nil && strings.Contains(string(data), placeholderEnvSecret) {
			t.Errorf("%s holds the secret", p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}

	var limitation string
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "env_values_left_readable" {
			limitation = l.Message
		}
	}
	if !strings.Contains(limitation, "placeholder") || !strings.Contains(limitation, "SOME_SECRET_KEY") {
		t.Errorf("the Limitation does not name the placeholder rule and the variable: %q", limitation)
	}
	r.assertNothingLeft(t)
}

// walkJSON calls fn for every string of a decoded JSON document with the name of
// the object key it sits under, or of the nearest one for a list element.
func walkJSON(v any, key string, fn func(key, value string)) {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			walkJSON(e, k, fn)
		}
	case []any:
		for _, e := range x {
			walkJSON(e, key, fn)
		}
	case string:
		fn(key, x)
	}
}
