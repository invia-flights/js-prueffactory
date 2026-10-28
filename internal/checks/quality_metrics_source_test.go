package checks

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam: what quality.metrics asks of the combined ESLint run. It measures
// functions in Source code only, so a long describe callback in Test code is
// not a long function. The run itself needs Docker (see internal/cli).

func TestTheMetricsGroupMeasuresSourceCodeOnlyAndTheHelperIsToldWhichFilesThoseAre(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json":   `{"name":"x","scripts":{"test":"mocha"}}`,
		"src/a.js":       "1;\n",
		"src/b.mjs":      "1;\n",
		"test/a.test.js": "describe('x', () => {});\n",
		"dist/bundle.js": "1;\n",
	})
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	group := eslintGroups["quality.metrics"]

	spec := group.spec(in)
	input, err := eslintHelperInput(in, []eslintGroup{group})
	if err != nil {
		t.Fatal(err)
	}

	if !spec.SourceOnly || spec.TestOnly {
		t.Errorf("spec = %+v, want Source code only", spec)
	}
	got := append([]string{}, input.SourceFiles...)
	sort.Strings(got)
	if !reflect.DeepEqual(got, []string{"src/a.js", "src/b.mjs"}) {
		t.Errorf("source files = %v, want the Source code files without the test file", got)
	}
	if !reflect.DeepEqual(input.TestFiles, []string{"test/a.test.js"}) {
		t.Errorf("test files = %v", input.TestFiles)
	}
	// The other groups keep their reach.
	if eslintGroups["lint.correctness"].spec(in).SourceOnly || eslintGroups["tests.smells"].spec(in).SourceOnly {
		t.Error("only the metrics group is limited to Source code")
	}
}

func TestTheMetricsCheckIsNotApplicableToAPackageWithoutJavaScriptInSourceCode(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{
		"package.json":   `{"name":"x","scripts":{"test":"mocha"}}`,
		"test/a.test.js": "describe('x', () => {});\n",
	})

	got, reason := Implementation("quality.metrics").Applicability(proj, packageContext(t, proj, "."))

	if got != resultset.NotApplicable || !strings.Contains(reason, "Source code") {
		t.Errorf("applicability = %v (%q), want not_applicable naming Source code", got, reason)
	}
}
