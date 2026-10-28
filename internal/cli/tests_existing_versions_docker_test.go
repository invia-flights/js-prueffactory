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

// Mocha 9, 10, 11 and 12 are supported. The same failing suite runs on the
// newest release of each major and has to give the same test cases, so the
// reporter works across the supported versions.
func TestEverySupportedMochaMajorGivesTheSameTestCases(t *testing.T) {
	for _, major := range []string{"9", "10", "11", "12"} {
		t.Run("mocha "+major, func(t *testing.T) {
			original := copyProject(t, "failing-test")
			writeFiles(t, original, map[string]string{
				"package.json": `{"name":"failing-test","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"devDependencies":{"mocha":"^` + major + `"}}` + "\n",
			})
			// No lockfile: npm install resolves the newest release of the major.
			if err := os.Remove(filepath.Join(original, "package-lock.json")); err != nil {
				t.Fatal(err)
			}

			r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

			if r.code != 1 {
				t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
			}
			e := oneExecution(t, &r.set, "tests.existing")
			if e.Status != resultset.StatusCompleted || e.Tool == nil || e.Tool.Version == nil || !strings.HasPrefix(*e.Tool.Version, major+".") {
				t.Fatalf("tests.existing = %+v, tool = %+v", e, e.Tool)
			}
			fs := findingsOf(&r.set, "tests.existing")
			if len(fs) != 1 || fs[0].Expected == nil || *fs[0].Expected != "2" || fs[0].Actual == nil || *fs[0].Actual != "-2" ||
				fs[0].Locations[0].Start == nil || fs[0].Locations[0].Start.Line != 13 {
				t.Errorf("findings = %+v", fs)
			}
			want := resultset.PackageTests{ContextID: e.ContextID, Found: 2, Run: 2, Passed: 1, Failed: 1}
			if got := inventoryOf(t, &r.set, e.ContextID); got != want {
				t.Errorf("inventory = %+v, want %+v", got, want)
			}
			r.assertNothingLeft(t)
		})
	}
}
