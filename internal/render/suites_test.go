package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func handMadeTests(ctx string, found, passed, failed int) resultset.PackageTests {
	return resultset.PackageTests{ContextID: ctx, Found: found, Run: passed + failed, Passed: passed, Failed: failed}
}

func handMadeSuite(ctx, suite string, found, passed, failed int) resultset.SuiteTests {
	return resultset.SuiteTests{ContextID: ctx, Suite: suite, Found: found, Run: passed + failed, Passed: passed, Failed: failed}
}

// A Report of a package that runs several suites says which suite a test
// Finding came from and shows the counts per suite.

func TestMarkdownNamesTheSuiteOfAFindingAndShowsCountsPerSuite(t *testing.T) {
	s := handMade()
	s.Findings[0].Suite = ptr("test:api")
	s.Inventory.Tests = append(s.Inventory.Tests, handMadeTests("C-0002", 5, 4, 1))
	s.Inventory.TestSuites = append(s.Inventory.TestSuites,
		handMadeSuite("C-0002", "test:unit", 3, 3, 0), handMadeSuite("C-0002", "test:api", 2, 1, 1))

	md := string(render.Markdown(s))

	if gates := section(md, "## Gates"); !strings.Contains(gates, "Suite: `test:api`") {
		t.Errorf("the Gate does not name its suite:\n%s", gates)
	}
	inv := section(md, "## Inventory")
	for _, want := range []string{"| Context | Suite | Found |", "| C-0002 | `test:unit` | 3 |", "| C-0002 | `test:api` | 2 |"} {
		if !strings.Contains(inv, want) {
			t.Errorf("inventory misses %q:\n%s", want, inv)
		}
	}
}

func TestMarkdownLeavesOutThePerSuiteTableForPackagesWithOneSuite(t *testing.T) {
	s := handMade()
	s.Inventory.Tests = append(s.Inventory.Tests, handMadeTests("C-0002", 5, 4, 1))
	s.Inventory.TestSuites = append(s.Inventory.TestSuites, handMadeSuite("C-0002", "scripts.test", 5, 4, 1))

	inv := section(string(render.Markdown(s)), "## Inventory")

	if strings.Contains(inv, "| Suite |") {
		t.Errorf("one suite adds nothing to the package row:\n%s", inv)
	}
}
