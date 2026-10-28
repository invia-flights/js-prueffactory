package discovery_test

import (
	"reflect"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// The files a `node --test` suite runs, from its file arguments or, without
// any, from Node's documented default patterns. The package files are given
// relative to the package folder.

func TestNodeTestWithoutFileArgumentsUsesNodesDefaultPatterns(t *testing.T) {
	files := []string{
		"index.js",
		"a.test.js", "b.test.mjs", "c.test.cjs",
		"d-test.js", "e_test.js", "test-f.js", "test.js",
		"src/g.test.js", "src/deep/h-test.mjs",
		"ab-test.txt",        // not a JavaScript file
		"fare-upgrade-ab.js", // no test in its name
		"latest.js",          // "test" only as a suffix of a word
		"contest.js",         // ends in "test" without a separator
		"test/helper.js",     // inside a folder named test: every JavaScript file
		"test/deep/more.cjs", // also nested
		"test/data.json",     // not JavaScript
		"src/test/inner.mjs", // a folder named test at any depth
		"node_modules/x/a.test.js",
		"testing/readme.js",
	}
	got := discovery.NodeTestFiles(files, []string{"--test"})
	want := []string{
		"a.test.js", "b.test.mjs", "c.test.cjs", "d-test.js", "e_test.js", "test-f.js", "test.js",
		"src/g.test.js", "src/deep/h-test.mjs", "test/helper.js", "test/deep/more.cjs", "src/test/inner.mjs",
	}
	if !reflect.DeepEqual(sorted(got), sorted(want)) {
		t.Errorf("files = %v\nwant    %v", sorted(got), sorted(want))
	}
}

func TestNodeTestWithFileArgumentsRunsExactlyThoseFiles(t *testing.T) {
	files := []string{"src/a.spec.js", "src/b.spec.js", "src/sub/c.spec.js", "src/ab-test.js", "test/x.js", "tools/run.js", "node_modules/m/m.spec.js"}
	cases := []struct {
		name string
		args []string
		want []string
	}{
		{"a file", []string{"--test", "src/a.spec.js"}, []string{"src/a.spec.js"}},
		{"a file with ./", []string{"--test", "./src/a.spec.js"}, []string{"src/a.spec.js"}},
		{"a glob", []string{"--test", "src/**/*.spec.js"}, []string{"src/a.spec.js", "src/b.spec.js", "src/sub/c.spec.js"}},
		{"a one-level glob", []string{"--test", "src/*.spec.js"}, []string{"src/a.spec.js", "src/b.spec.js"}},
		{"braces", []string{"--test", "src/{a,b}.spec.js"}, []string{"src/a.spec.js", "src/b.spec.js"}},
		{"two arguments", []string{"--test", "src/a.spec.js", "tools/run.js"}, []string{"src/a.spec.js", "tools/run.js"}},
		{"options with values are not files", []string{"--test", "--test-reporter", "spec", "--import", "./setup.js", "src/a.spec.js"}, []string{"src/a.spec.js"}},
		{"after a double dash", []string{"--test", "--", "src/b.spec.js"}, []string{"src/b.spec.js"}},
		{"a file that does not exist", []string{"--test", "src/missing.spec.js"}, nil},
		{"node_modules is not searched by a glob", []string{"--test", "**/*.spec.js"}, []string{"src/a.spec.js", "src/b.spec.js", "src/sub/c.spec.js"}},
		{"an explicit file argument is not named by its name", []string{"--test", "tools/run.js"}, []string{"tools/run.js"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := discovery.NodeTestFiles(files, c.args)
			if !reflect.DeepEqual(sorted(got), sorted(c.want)) {
				t.Errorf("files = %v, want %v", sorted(got), sorted(c.want))
			}
		})
	}
}

func TestNodeTestDefaultsAreTheSuitesOnlyAndOptionsDoNotCountAsFileArguments(t *testing.T) {
	// Without file arguments, only options: still the defaults.
	files := []string{"a.test.js", "plain.js"}
	got := discovery.NodeTestFiles(files, []string{"--test", "--test-concurrency=1", "--import", "./setup.js"})
	if !reflect.DeepEqual(got, []string{"a.test.js"}) {
		t.Errorf("files = %v, want the default match only", got)
	}
}

func sorted(s []string) []string {
	out := append([]string(nil), s...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
