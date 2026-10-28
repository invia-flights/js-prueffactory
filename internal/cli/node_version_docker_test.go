//go:build docker

package cli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// Seam A tests of the Node version and image variant with a real Docker daemon:
// the project's tests run on the version and variant discovery chose.

func packageContext(t *testing.T, s *resultset.Set) resultset.Context {
	t.Helper()
	for _, c := range s.Contexts {
		if c.Kind == "package" {
			return c
		}
	}
	t.Fatal("no package Context")
	return resultset.Context{}
}

// nodeVersionTest is a Mocha test that passes only on the given Node major.
func nodeVersionTest(major string) map[string]string {
	return map[string]string{
		"test/node-version.test.js": "'use strict';\n\nconst assert = require('node:assert');\n\n" +
			"describe('node', () => {\n  it('runs on Node " + major + "', () => {\n" +
			"    assert.strictEqual(process.version.split('.')[0], 'v" + major + "');\n  });\n});\n",
	}
}

func TestTestsRunOnTheNodeVersionOfNvmrc(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, nodeVersionTest("22"))
	writeFiles(t, original, map[string]string{".nvmrc": "v22.3.0\n"})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	n := packageContext(t, &r.set).Node
	img, _ := toolset.NodeImage(22, toolset.VariantDebian)
	if n == nil || n.Version != "22" || n.Source != "nvmrc" || n.Variant != "debian" || n.ImageDigest != img.Digest {
		t.Fatalf("node = %+v, want Node 22 from .nvmrc on the pinned debian image %s", n, img.Digest)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Outcome != resultset.OutcomePassed {
		t.Errorf("tests.existing = %+v: the version test passes only on Node 22", e)
	}
	r.assertNothingLeft(t)
}

func TestAnAlpineDockerfileRunsTheTestsOnAlpineAndAMissingProgramIsNamedInTheFinding(t *testing.T) {
	original := copyProject(t, "alpine-missing-program")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	n := packageContext(t, &r.set).Node
	img, _ := toolset.NodeImage(22, toolset.VariantAlpine)
	if n == nil || n.Version != "22" || n.Source != "dockerfile" || n.Variant != "alpine" || n.ImageDigest != img.Digest {
		t.Fatalf("node = %+v, want Node 22 from the Dockerfile on the pinned alpine image %s", n, img.Digest)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted {
		t.Fatalf("tests.existing = %+v", e)
	}
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want the one failing test", fs)
	}
	for _, want := range []string{"spawn git ENOENT", "`git`", "missing from the Node 22 alpine image"} {
		if !strings.Contains(fs[0].Message, want) {
			t.Errorf("message %q misses %q", fs[0].Message, want)
		}
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 2, Run: 2, Passed: 1, Failed: 1}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	r.assertNothingLeft(t)
}

func TestAnUnsupportedNodeVersionStartsNothingInThePackageAndSaysWhy(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, map[string]string{".nvmrc": "18\n"})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,syntax.parse")

	if c := packageContext(t, &r.set); c.Node != nil {
		t.Errorf("node = %+v, want none for an unsupported version", c.Node)
	}
	for _, id := range []string{"tests.existing", "syntax.parse"} {
		e := oneExecution(t, &r.set, id)
		if e.Status != resultset.StatusUnsupported || e.ReasonCode == nil || *e.ReasonCode != "node_version_unsupported" ||
			e.Reason == nil || !strings.Contains(*e.Reason, "Node 18") {
			t.Errorf("%s = %+v", id, e)
		}
	}
	r.assertNothingLeft(t)
}
