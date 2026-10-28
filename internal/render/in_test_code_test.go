package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// The Test code hint is not a matter of one Check: any Finding marked
// in_test_code carries it, and one in Source code does not.
func TestMarkdownHintsTestCodeOnAFindingOfAnyCheck(t *testing.T) {
	s := resultsettest.Minimal()
	inTest := resultsettest.Finding("test/a.js", "in a test", false)
	inTest.InTestCode = true
	s.Findings = append(s.Findings, inTest, resultsettest.Finding("src/b.js", "in the source", false))
	s.Finalize()
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("fixture invalid: %v", problems)
	}
	md := string(render.Markdown(s))
	for _, f := range s.Findings {
		line := ""
		for _, l := range strings.Split(md, "\n") {
			if strings.HasPrefix(l, "- "+f.ID+" [") {
				line = l
			}
		}
		if line == "" || strings.HasSuffix(line, " (in Test code)") != f.InTestCode {
			t.Errorf("line of %s in %s: %q, want the hint %v", f.ID, f.Locations[0].Path, line, f.InTestCode)
		}
	}
}

// A Finding that lies in Test code and Test data says both, as the detail view
// does: a secret in a fixture that the project's tests load is both.
func TestMarkdownHintsTestCodeAndTestDataOnOneFinding(t *testing.T) {
	s := resultsettest.Minimal()
	both := resultsettest.Finding("test/fixtures/a.js", "in both", false)
	both.InTestCode, both.InTestData = true, true
	onlyData := resultsettest.Finding("test/fixtures/b.js", "in data", false)
	onlyData.InTestData = true
	s.Findings = append(s.Findings, both, onlyData)
	s.Finalize()
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("fixture invalid: %v", problems)
	}
	md := string(render.Markdown(s))
	for _, want := range []string{"in both (in Test data, in Test code)\n", "in data (in Test data)\n"} {
		if !strings.Contains(md, want) {
			t.Errorf("report.md lacks %q", want)
		}
	}
}
