//go:build docker

package cli_test

import (
	"context"
	"testing"
)

// Seam A with a real Docker daemon: Mocha's globals in Test code of a package
// whose test script delegates to Mocha through `npm run`.

func TestMochaGlobalsAreKnownWhenTheTestScriptDelegatesThroughNpmRun(t *testing.T) {
	original := copyProject(t, "mocha-npm-run")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.correctness")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	var got []string
	for _, f := range findingsOf(&r.set, "lint.correctness") {
		if f.RuleID == nil || *f.RuleID != "no-undef" {
			t.Errorf("finding %+v, want only no-undef", f)
			continue
		}
		got = append(got, f.Locations[0].Path)
	}
	if len(got) != 1 || got[0] != "src/index.js" {
		t.Errorf("no-undef in %v, want src/index.js only: Mocha's globals must be known in Test code and a real no-undef in Source code reported", got)
	}
}
