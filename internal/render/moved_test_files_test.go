package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The files the probe moved from Source code to Test code are listed in the
// Inventory with the suite that loads them.

func TestMarkdownListsTheFilesTheProbeMovedWithTheirSuite(t *testing.T) {
	s := resultsettest.Minimal()
	s.Inventory.MovedTestFiles = []resultset.MovedTestFile{
		{ContextID: "C-0002", Path: "src/a|b.spec.js", Suite: "test:unit", Kind: "spec"},
		{ContextID: "C-0002", Path: "src/setup.js", Suite: "test:unit", Kind: "require"},
	}
	s.Finalize()

	md := string(render.Markdown(s))

	inv := section(md, "## Inventory")
	if strings.TrimSpace(inv) == "None." {
		t.Fatalf("the Inventory has moved test files and reads None:\n%s", inv)
	}
	for _, want := range []string{"Moved test files", "`src/setup.js`", "test:unit", "require", `src/a\|b.spec.js`} {
		if !strings.Contains(inv, want) {
			t.Errorf("the Inventory lacks %q:\n%s", want, inv)
		}
	}
}
