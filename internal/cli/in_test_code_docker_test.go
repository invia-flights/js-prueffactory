//go:build docker

package cli_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon: in_test_code says whether a Finding's
// primary location is Test code, whatever Check produced it. Test code is a
// folder named test, or a file the project's own Mocha loads; a test-like name
// alone is not.
func TestEveryFindingInTestCodeSaysSoInTheReportAndAFileWithATestLikeNameIsNot(t *testing.T) {
	original := copyProject(t, "secret-in-test-code")

	r := realRun(t, context.Background(), "test", original,
		"--only", "package.install,lint.correctness,security.secrets")
	if r.code != 0 && r.code != 1 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)

	type hit struct{ check, path string }
	got := map[hit]resultset.Finding{}
	for _, f := range r.set.Findings {
		if len(f.Locations) > 0 {
			got[hit{f.CheckID, f.Locations[0].Path}] = f
		}
	}
	md := string(mustRead(t, filepath.Join(r.reportDir, "report.md")))
	for _, c := range []struct {
		hit
		inTestCode bool
	}{
		{hit{"lint.correctness", "test/helpers.js"}, true},
		{hit{"security.secrets", "test/helpers.js"}, true},
		{hit{"security.secrets", "src/a.spec.js"}, true},
		{hit{"lint.correctness", "src/fare-ab-test.js"}, false},
	} {
		f, ok := got[c.hit]
		if !ok {
			t.Errorf("no %s Finding in %s", c.check, c.path)
			continue
		}
		if f.InTestCode != c.inTestCode || f.InTestData {
			t.Errorf("%s in %s: in_test_code = %v, in_test_data = %v, want %v and false", c.check, c.path, f.InTestCode, f.InTestData, c.inTestCode)
		}
		line := lineOf(md, "- "+f.ID+" [")
		if line == "" || strings.HasSuffix(line, " (in Test code)") != c.inTestCode {
			t.Errorf("report.md line of %s in %s: %q, want the Test code hint %v", f.ID, c.path, line, c.inTestCode)
		}
	}
}

// lineOf returns the first line of text that starts with prefix.
func lineOf(text, prefix string) string {
	for _, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(l, prefix) {
			return l
		}
	}
	return ""
}
