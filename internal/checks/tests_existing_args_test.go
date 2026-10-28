package checks

import (
	"slices"
	"testing"
)

// The project's Mocha arguments are kept, except the ones that would hide
// results or hide our reporter. Each removal is reported as an override.

func TestMochaRunKeepsTheProjectsArgumentsAndAddsOurReporterAndNoBail(t *testing.T) {
	p := planMochaArgs([]string{"test/api", "--config", "test/mocha-opts.js", "--exit", "--timeout", "5000"}, "/jspf/mocha-reporter.js")

	want := []string{"test/api", "--config", "test/mocha-opts.js", "--exit", "--timeout", "5000",
		"--reporter", "/jspf/mocha-reporter.js", "--no-bail"}
	if !slices.Equal(p.Args, want) {
		t.Errorf("args = %q, want %q", p.Args, want)
	}
	if len(p.Overrides) != 0 {
		t.Errorf("nothing of the project's was replaced: %q", p.Overrides)
	}
	// A single test is re-run with the project's options and no test files.
	if wantNative := []string{"--config", "test/mocha-opts.js", "--exit", "--timeout", "5000"}; !slices.Equal(p.NativeOptions, wantNative) {
		t.Errorf("native options = %q, want %q", p.NativeOptions, wantNative)
	}
}

func TestMochaRunReplacesTheProjectsReporterAndBailAndSaysSo(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want []string // texts the overrides hold, one per override
	}{
		{"reporter with a value", []string{"--reporter", "spec", "test/"}, []string{"--reporter spec"}},
		{"reporter with equals", []string{"--reporter=dot", "test/"}, []string{"--reporter=dot"}},
		{"short reporter", []string{"-R", "xunit", "test/"}, []string{"-R xunit"}},
		{"reporter options", []string{"--reporter-option", "output=out.xml", "test/"}, []string{"--reporter-option output=out.xml"}},
		{"short reporter options", []string{"-O", "a=b", "test/"}, []string{"-O a=b"}},
		{"bail", []string{"--bail", "test/"}, []string{"--bail"}},
		{"short bail", []string{"-b", "test/"}, []string{"-b"}},
		{"all of them", []string{"--bail", "-R", "spec", "-O", "a=b", "test/"}, []string{"--bail", "-R spec", "-O a=b"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := planMochaArgs(c.args, "/r.js")
			if !slices.Equal(p.Overrides, c.want) {
				t.Errorf("overrides = %q, want %q", p.Overrides, c.want)
			}
			wantArgs := []string{"test/", "--reporter", "/r.js", "--no-bail"}
			if !slices.Equal(p.Args, wantArgs) {
				t.Errorf("args = %q, want %q", p.Args, wantArgs)
			}
			if len(p.NativeOptions) != 0 {
				t.Errorf("native options = %q, want none", p.NativeOptions)
			}
		})
	}
}

func TestMochaVersionsNineToTwelveAreSupported(t *testing.T) {
	for v, want := range map[string]bool{
		"8.4.0": false, "9.0.0": true, "9.2.2": true, "10.8.2": true, "11.7.5": true, "12.0.0": true, "12.3.1": true,
		"13.0.0": false, "10.0.0-beta.1": true, "": false, "latest": false,
	} {
		if got := supportedMochaVersion(v); got != want {
			t.Errorf("supportedMochaVersion(%q) = %v, want %v", v, got, want)
		}
	}
}
