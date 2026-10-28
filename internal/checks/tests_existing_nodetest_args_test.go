package checks

import (
	"slices"
	"testing"
)

// The project's node:test arguments are kept, except the reporter options that
// would take our reporter's place. Each removal is reported as an override.

func TestNodeTestRunKeepsTheProjectsArgumentsAndAddsOurReporterThroughTheReporterOptions(t *testing.T) {
	p := planNodeTestArgs([]string{"--import", "./setup.mjs", "--test-concurrency=2", "--test", "test/api"}, "/jspf/node-test-reporter.js")

	// Node reads its options only up to the first test file; what follows is
	// for the test files, so our reporter goes in front of them.
	want := []string{"--import", "./setup.mjs", "--test-concurrency=2", "--test",
		"--test-reporter=/jspf/node-test-reporter.js", "--test-reporter-destination=stdout", "test/api"}
	if !slices.Equal(p.Args, want) {
		t.Errorf("args = %q, want %q", p.Args, want)
	}
	if len(p.Overrides) != 0 {
		t.Errorf("nothing of the project's was replaced: %q", p.Overrides)
	}
	// One test is re-run with the project's options and without its test files.
	if wantNative := []string{"--import", "./setup.mjs", "--test-concurrency=2", "--test"}; !slices.Equal(p.NativeOptions, wantNative) {
		t.Errorf("native options = %q, want %q", p.NativeOptions, wantNative)
	}
}

func TestNodeTestRunReplacesTheProjectsReportersAndSaysSo(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want []string // texts the overrides hold
	}{
		{"reporter with a value", []string{"--test", "--test-reporter", "spec", "test/"}, []string{"--test-reporter spec"}},
		{"reporter with equals", []string{"--test", "--test-reporter=dot", "test/"}, []string{"--test-reporter=dot"}},
		{"destination", []string{"--test", "--test-reporter-destination", "out.xml", "test/"}, []string{"--test-reporter-destination out.xml"}},
		{"both, twice", []string{"--test", "--test-reporter=junit", "--test-reporter-destination=a.xml", "--test-reporter=lcov", "--test-reporter-destination=l.info", "test/"},
			[]string{"--test-reporter=junit", "--test-reporter-destination=a.xml", "--test-reporter=lcov", "--test-reporter-destination=l.info"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := planNodeTestArgs(c.args, "/r.js")
			if !slices.Equal(p.Overrides, c.want) {
				t.Errorf("overrides = %q, want %q", p.Overrides, c.want)
			}
			wantArgs := []string{"--test", "--test-reporter=/r.js", "--test-reporter-destination=stdout", "test/"}
			if !slices.Equal(p.Args, wantArgs) {
				t.Errorf("args = %q, want %q", p.Args, wantArgs)
			}
			if !slices.Equal(p.NativeOptions, []string{"--test"}) {
				t.Errorf("native options = %q, want only --test", p.NativeOptions)
			}
		})
	}
}

func TestNodeTestReporterGoesInFrontOfTheFilesAndOfTheSeparator(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want []string
	}{
		{"no files", []string{"--test"}, []string{"--test", "--test-reporter=/r.js", "--test-reporter-destination=stdout"}},
		{"a glob", []string{"--test", "test/**/*.test.js"}, []string{"--test", "--test-reporter=/r.js", "--test-reporter-destination=stdout", "test/**/*.test.js"}},
		{"after the separator", []string{"--test", "--", "-odd.test.js"}, []string{"--test", "--test-reporter=/r.js", "--test-reporter-destination=stdout", "--", "-odd.test.js"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := planNodeTestArgs(c.args, "/r.js").Args; !slices.Equal(got, c.want) {
				t.Errorf("args = %q, want %q", got, c.want)
			}
		})
	}
}

func TestNodeTestOptionValuesAreNotTakenForTestFiles(t *testing.T) {
	p := planNodeTestArgs([]string{"--require", "./hook.js", "-r", "dotenv/config", "--test", "--test-name-pattern", "adds", "--", "test/a.test.js", "test/b.test.js"}, "/r.js")

	// The project's own name patterns are left out of the native command,
	// because the one test's pattern is added to it and patterns add up.
	wantNative := []string{"--require", "./hook.js", "-r", "dotenv/config", "--test"}
	if !slices.Equal(p.NativeOptions, wantNative) {
		t.Errorf("native options = %q, want %q", p.NativeOptions, wantNative)
	}
}
