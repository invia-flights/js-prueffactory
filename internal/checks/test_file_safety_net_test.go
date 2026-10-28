package checks

import (
	"errors"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// The safety net: the reporters record the files the runner really loaded, and
// a loaded spec file that is not Test code gets a Limitation, so a probe that
// missed a file or was not run does not pass unnoticed.

func foundIn(file string) string {
	return `{"ev":"found","id":1,"file":"` + file + `","title":"t","fullTitle":"t","suitePath":[]}`
}

func TestASpecFileTheRunnerLoadedThatIsSourceCodeGetsALimitationWithTheFileList(t *testing.T) {
	in := suiteInput(t, map[string]string{"src/a.spec.js": "x", "src/b.spec.js": "x", "test/c.js": "x", "test/fixtures/d.js": "x"})
	ev := parseTestEvents(lines(
		foundIn("/work/src/a.spec.js"), foundIn("/work/src/b.spec.js"), foundIn("/work/src/a.spec.js"),
		foundIn("/work/test/c.js"), foundIn("/work/test/fixtures/d.js"), foundIn("/work/node_modules/x/y.js"), foundIn("/elsewhere/e.js"),
		`{"ev":"hook_fail","title":"h","hookType":"before","scope":"{root}","file":"/work/src/b.spec.js","err":{"name":"E","message":"m"}}`,
	))

	got := in.sourceSpecLimitations(ev)

	if len(got) != 1 {
		t.Fatalf("limitations = %+v, want one", got)
	}
	l := got[0]
	if l.ReasonCode != "test_file_classified_as_source" || l.CheckID == nil || *l.CheckID != testsExistingID {
		t.Errorf("limitation = %+v", l)
	}
	for _, want := range []string{"src/a.spec.js", "src/b.spec.js"} {
		if !strings.Contains(l.Message, want) {
			t.Errorf("message lacks %s: %s", want, l.Message)
		}
	}
	for _, not := range []string{"test/c.js", "fixtures", "node_modules", "elsewhere"} {
		if strings.Contains(l.Message, not) {
			t.Errorf("message names %q, which is Test code, Test data or outside the project: %s", not, l.Message)
		}
	}
	if strings.Count(l.Message, "src/a.spec.js") != 1 {
		t.Errorf("a file is listed once: %s", l.Message)
	}
}

func TestTheSuiteOfALimitationIsQuotedAsACodeSpan(t *testing.T) {
	in := suiteInput(t, map[string]string{"src/a.spec.js": "x"})
	ev := parseTestEvents(lines(foundIn("/work/src/a.spec.js")))

	got := in.sourceSpecLimitations(ev)
	if len(got) != 1 || !strings.Contains(got[0].Message, "The runner of the suite `scripts.test` (mocha) loaded") {
		t.Errorf("limitations = %+v, want the suite as a code span", got)
	}

	failed := in.testFilesNotResolved(in.suite(), errors.New("boom"))
	if !strings.Contains(failed.Message, "The test files of the suite `scripts.test` (mocha) could not be read") {
		t.Errorf("message = %s, want the suite as a code span", failed.Message)
	}
}

func TestNoLimitationWhenEveryLoadedSpecFileIsTestCode(t *testing.T) {
	in := suiteInput(t, map[string]string{"src/a.spec.js": "x", "test/c.js": "x"})
	// The Project the Check sees has the file the probe found as Test code.
	in.Project = in.Project.WithTestFiles([]discovery.TestFile{{ContextID: in.Context.ID, Path: "src/a.spec.js", Suite: "scripts.test", Kind: "spec"}})
	in.Context = in.Project.ContextByID(in.Context.ID)
	ev := parseTestEvents(lines(foundIn("/work/src/a.spec.js"), foundIn("/work/test/c.js")))

	if got := in.sourceSpecLimitations(ev); len(got) != 0 {
		t.Errorf("limitations = %+v, want none", got)
	}
}
