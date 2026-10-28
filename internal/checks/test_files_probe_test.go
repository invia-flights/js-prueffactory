package checks

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The probe asks the project's own Mocha which files a suite loads and turns
// the answer into project paths. These tests hold the reading of the answer and
// the expansion for node:test suites; the probe itself runs in Docker.

func probePackage(t *testing.T, files map[string]string) (*discovery.Project, *discovery.Package) {
	t.Helper()
	in := suiteInput(t, files)
	return in.Project, in.Context.Package
}

func TestTheMochaProbeAnswerBecomesProjectPathsOfTheLoadedFiles(t *testing.T) {
	_, pkg := probePackage(t, map[string]string{"src/a.spec.js": "x", "src/setup.js": "x"})
	// What a config file prints comes before the marker line.
	out := []byte("config says hello\n\n" + probeMarker + `{"ok":true,"noFiles":false,` +
		`"spec":["/work/src/a.spec.js","/work/node_modules/x/spec.js","/etc/passwd","/work"],` +
		`"file":["/work/src/first.js"],"require":["/work/src/setup.js","/work/../escape.js"],"import":["/work/src/esm.mjs"]}` + "\n")

	answer, err := parseMochaProbe(out)
	if err != nil {
		t.Fatal(err)
	}
	got := answer.testFiles(pkg, "test:unit")

	want := []discovery.TestFile{
		{ContextID: pkg.ContextID, Path: "src/a.spec.js", Suite: "test:unit", Kind: "spec"},
		{ContextID: pkg.ContextID, Path: "src/first.js", Suite: "test:unit", Kind: "file"},
		{ContextID: pkg.ContextID, Path: "src/setup.js", Suite: "test:unit", Kind: "require"},
		{ContextID: pkg.ContextID, Path: "src/esm.mjs", Suite: "test:unit", Kind: "import"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("files = %+v\nwant    %+v: files outside the Working copy and in node_modules are left out", got, want)
	}
}

func TestAPackageBelowTheRootGetsProjectPathsWithItsFolder(t *testing.T) {
	proj, _ := probePackage(t, map[string]string{"package.json": `{}`, "svc/package.json": `{}`, "svc/src/a.spec.js": "x"})
	var pkg *discovery.Package
	for _, p := range proj.Packages {
		if p.Path == "svc" {
			pkg = p
		}
	}
	out := []byte(probeMarker + `{"ok":true,"spec":["/work/svc/src/a.spec.js","/work/other/b.spec.js"],"file":[],"require":[],"import":[]}`)

	answer, err := parseMochaProbe(out)
	if err != nil {
		t.Fatal(err)
	}
	got := answer.testFiles(pkg, "scripts.test")

	if len(got) != 1 || got[0].Path != "svc/src/a.spec.js" {
		t.Errorf("files = %+v, want svc/src/a.spec.js only: a file outside the package is not its test code", got)
	}
}

func TestAMochaProbeThatCouldNotAnswerSaysWhy(t *testing.T) {
	cases := []struct {
		name    string
		out     string
		wantErr string
	}{
		{"no loader files", probeMarker + `{"ok":false,"code":"no_loader","error":"Mocha has no lib/cli/options.js"}`, "none of the loader files"},
		{"a config that throws", probeMarker + `{"ok":false,"code":"load_failed","error":"Unable to read/parse .mocharc.js: boom"}`, "boom"},
		{"no answer at all", "some output\n", "no answer"},
		{"an answer that is not JSON", probeMarker + "{nope", "not readable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseMochaProbe([]byte(c.out))
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("error = %v, want one mentioning %q", err, c.wantErr)
			}
		})
	}
}

func TestANodeTestSuiteIsExpandedFromItsFileArgumentsOrNodesDefaultsWithoutAContainer(t *testing.T) {
	_, pkg := probePackage(t, map[string]string{
		"src/a.spec.js": "x", "src/b.test.js": "x", "src/ab-test.js": "x", "src/plain.js": "x",
	})
	node := func(args ...string) *discovery.Suite {
		return &discovery.Suite{Runner: discovery.RunnerNodeTest, Args: append([]string{"--test"}, args...), Origin: "test:node"}
	}

	byArgument := nodeTestFilesOf(pkg, node("src/**/*.spec.js"))
	byDefault := nodeTestFilesOf(pkg, node())

	if len(byArgument) != 1 || byArgument[0].Path != "src/a.spec.js" || byArgument[0].Suite != "test:node" || byArgument[0].Kind != "spec" {
		t.Errorf("by argument = %+v", byArgument)
	}
	var names []string
	for _, f := range byDefault {
		names = append(names, f.Path)
	}
	if !reflect.DeepEqual(names, []string{"src/ab-test.js", "src/b.test.js"}) {
		t.Errorf("by default = %v, want Node's default patterns", names)
	}
}

func TestAMochaSuiteThatIsNotProbedBecauseTheInstallHadAGateIsNamedInALimitation(t *testing.T) {
	in := suiteInput(t, map[string]string{"src/a.spec.js": "x"})
	res := &Result{Status: resultset.StatusCompleted, Findings: []resultset.Finding{{Gate: true}}}

	in.addTestFileProbe(context.Background(), res)

	got := limitationsOfCode(res, testFilesNotResolved)
	if len(got) != 1 || !strings.Contains(got[0].Message, "`scripts.test` (mocha)") || !strings.Contains(got[0].Message, "install") {
		t.Errorf("limitations = %+v, want one naming the suite and the failed install", res.Limitations)
	}
}

func TestAMochaSuiteOfAPackageThatCannotBeInstalledIsNamedInALimitation(t *testing.T) {
	in := suiteInput(t, map[string]string{"src/a.spec.js": "x"})
	in.Context.Package.InstallUnsupported = &discovery.Unsupported{Code: "yarn_not_supported", Reason: "the package uses Yarn"}

	res := packageInstall{}.Run(context.Background(), in)

	got := limitationsOfCode(res, testFilesNotResolved)
	if len(got) != 1 || !strings.Contains(got[0].Message, "`scripts.test` (mocha)") || !strings.Contains(got[0].Message, "the package uses Yarn") {
		t.Errorf("limitations = %+v, want one naming the suite and the reason", res.Limitations)
	}
}

func TestAPackageWithoutMochaSuitesGetsNoProbeLimitation(t *testing.T) {
	in := suiteInput(t, map[string]string{"package.json": `{"scripts":{"test":"node --test"}}`, "src/a.test.js": "x"})
	in.Context.Package.InstallUnsupported = &discovery.Unsupported{Code: "yarn_not_supported", Reason: "the package uses Yarn"}

	res := packageInstall{}.Run(context.Background(), in)

	if got := limitationsOfCode(res, testFilesNotResolved); len(got) != 0 {
		t.Errorf("limitations = %+v, want none: node:test suites need no probe", got)
	}
}

func TestMochaSuitesAreNeverExpandedByName(t *testing.T) {
	_, pkg := probePackage(t, map[string]string{"src/ab-test.js": "x", "src/b.test.js": "x"})
	got := nodeTestFilesOf(pkg, &discovery.Suite{Runner: discovery.RunnerMocha, Origin: "scripts.test"})
	if len(got) != 0 {
		t.Errorf("a Mocha suite was expanded by name: %+v", got)
	}
}
