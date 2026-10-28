//go:build docker

package cli_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon: a test script that chains two npm scripts
// runs as two suites, every suite runs although the second one fails, and the
// Report names the suite everywhere.

func TestAChainOfNpmScriptsRunsOneSuitePerStepAndNamesTheFailingLayer(t *testing.T) {
	original := copyProject(t, "npm-run-chain")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 (the api suite has a failing test)\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Gate != 1 {
		t.Errorf("tests.existing = %+v, want completed with one Gate", e)
	}

	// Two suites ran, each with its own counts, and the package row adds them up.
	suites := r.set.Inventory.TestSuites
	if len(suites) != 2 {
		t.Fatalf("suite rows = %+v, want test:unit and test:api", suites)
	}
	want := map[string]resultset.SuiteTests{
		"test:unit": {ContextID: e.ContextID, Suite: "test:unit", Found: 2, Run: 2, Passed: 2},
		"test:api":  {ContextID: e.ContextID, Suite: "test:api", Found: 2, Run: 2, Passed: 1, Failed: 1},
	}
	for _, row := range suites {
		if row != want[row.Suite] {
			t.Errorf("suite row = %+v, want %+v", row, want[row.Suite])
		}
	}
	if got, total := inventoryOf(t, &r.set, e.ContextID), (resultset.PackageTests{ContextID: e.ContextID, Found: 4, Run: 4, Passed: 3, Failed: 1}); got != total {
		t.Errorf("package row = %+v, want %+v", got, total)
	}
	var files []string
	for _, f := range r.set.Inventory.TestFiles {
		files = append(files, f.Suite+" "+f.File)
	}
	slices.Sort(files)
	if !slices.Equal(files, []string{"test:api test/api/sum.test.js", "test:unit test/unit/add.test.js"}) {
		t.Errorf("test files = %v", files)
	}

	// One Gate, from the api suite, with that suite's own re-run command.
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 {
		t.Fatalf("findings = %+v, want exactly one", fs)
	}
	f := fs[0]
	if !f.Gate || f.Suite == nil || *f.Suite != "test:api" {
		t.Errorf("finding = %+v, want a Gate of suite test:api", f)
	}
	repro := f.Reproduction.Test
	if repro == nil || repro.File != "test/api/sum.test.js" || repro.FullTitle != "describeSum describes a sum with the wrong text" {
		t.Fatalf("test repro = %+v", repro)
	}
	wantCmd := []string{"npx", "mocha", "--config", "test/config/mocha-api.js", "--fgrep", "describeSum describes a sum with the wrong text", "test/api/sum.test.js"}
	if !slices.Equal(repro.NativeCommand, wantCmd) {
		t.Errorf("native command = %q, want %q", repro.NativeCommand, wantCmd)
	}
	for _, tc := range r.set.TestCases {
		if tc.Suite != "test:api" {
			t.Errorf("test case %+v: only the api suite has tests that are not passed", tc)
		}
	}

	// The Report says the tool ran every step.
	var chain, override []resultset.Limitation
	for _, l := range r.set.Limitations {
		switch l.ReasonCode {
		case "test_chain_all_steps_run":
			chain = append(chain, l)
		case "test_command_override":
			override = append(override, l)
		}
	}
	if len(chain) != 1 || !strings.Contains(chain[0].Message, "&&") {
		t.Errorf("chain limitations = %+v", chain)
	}
	if len(override) != 1 || !strings.Contains(override[0].Message, "`test:unit`, `test:api`") {
		t.Errorf("override limitations = %+v, want one for the package that lists both suites", override)
	}

	// Each suite has its own command log.
	for _, name := range []string{"test-output-1-test-unit.log", "test-output-2-test-api.log"} {
		if artifactOf(&r.set, e, name) == nil {
			t.Errorf("no %s artifact in %+v", name, r.set.Artifacts)
		}
	}
}

// The configs of the chain name mocha-multi-reporters as the reporter and ci/test.sh
// is the only place that runs c8: Knip must not report either as unused, nor
// report an unresolved import in the configs and setup files, nor an unused
// dependency for Mocha itself.
func TestKnipReportsNothingFalseForAChainWithAReporterPluginAndACIScript(t *testing.T) {
	original := copyProject(t, "npm-run-chain")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.unused")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "quality.unused"); e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v)", e.Status, e.Reason)
	}
	// The only true finding is the export that no test calls (src/unit-only.js
	// keeps it for the Coverage test).
	got := unusedSummary(&r.set)
	if want := []string{"unused-export neverCalled"}; !slices.Equal(got, want) {
		t.Errorf("quality.unused findings = %q, want %q: mocha, mocha-multi-reporters and c8 are used", got, want)
	}
	r.assertNothingLeft(t)
}

func TestCoverageOfAChainIsTheUnionOverItsSuitesAndAnOpenHandleNamesItsSuite(t *testing.T) {
	original := copyProject(t, "npm-run-chain")

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing,tests.coverage,runtime.warnings")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1 (the api suite has a failing test)\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	for _, id := range []string{"tests.existing", "tests.coverage", "runtime.warnings"} {
		if e := oneExecution(t, &r.set, id); e.Status != resultset.StatusCompleted {
			t.Errorf("%s = %+v, want completed", id, e)
		}
	}

	// Coverage is one report for the package over both suites: src/unit-only.js
	// is loaded by the unit suite alone and src/api-only.js by the api suite
	// alone, and both count as covered.
	cov := oneExecution(t, &r.set, "tests.coverage")
	ms := coverageMetrics(&r.set)
	if len(ms) != 3 {
		t.Fatalf("metrics = %+v", ms)
	}
	for name, m := range ms {
		if m.Value == nil || *m.Value <= 0 {
			t.Errorf("%s = %+v, want a measured value", name, m)
		}
	}
	a := artifactOf(&r.set, cov, cov.ContextID+"-files.json")
	if a == nil {
		t.Fatalf("no per-file coverage artifact in %+v", r.set.Artifacts)
	}
	data, err := os.ReadFile(filepath.Join(r.reportDir, filepath.FromSlash(a.Path)))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Files []struct {
			Path  string `json:"path"`
			Lines struct {
				Total, Covered int
			} `json:"lines"`
			Untested []struct {
				Name string `json:"name"`
			} `json:"untested_functions"`
		} `json:"files"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	covered := map[string]int{}
	var paths []string
	for _, f := range doc.Files {
		covered[f.Path] = f.Lines.Covered
		paths = append(paths, f.Path)
		if f.Path == "src/unit-only.js" && (len(f.Untested) != 1 || f.Untested[0].Name != "neverCalled") {
			t.Errorf("untested functions of unit-only.js = %+v, want neverCalled", f.Untested)
		}
	}
	if !slices.Equal(paths, []string{"src/api-only.js", "src/index.js", "src/unit-only.js"}) {
		t.Fatalf("covered files = %v", paths)
	}
	for _, p := range paths {
		if covered[p] == 0 {
			t.Errorf("%s has no covered lines, but a suite loads it: Coverage is the union over all suites", p)
		}
	}

	// The unit suite leaves a server open, the api suite does not: the Finding
	// is the unit suite's alone.
	fs := findingsOf(&r.set, "runtime.warnings")
	if len(fs) != 1 || !ruleIs(fs[0], "open-resources") || fs[0].Suite == nil || *fs[0].Suite != "test:unit" || !strings.Contains(fs[0].Message, "TCPServerWrap") {
		t.Errorf("runtime.warnings findings = %+v, want one open-resources Finding of test:unit", fs)
	}

	// The NODE_OPTIONS override is listed once, for both suites, although
	// runtime.warnings and tests.existing are selected.
	var nodeOptions []resultset.Limitation
	for _, l := range r.set.Limitations {
		if strings.Contains(l.Message, "NODE_OPTIONS") {
			nodeOptions = append(nodeOptions, l)
		}
	}
	if len(nodeOptions) != 1 || !strings.Contains(nodeOptions[0].Message, "`test:unit`, `test:api`") {
		t.Errorf("NODE_OPTIONS limitations = %+v, want one that names both suites", nodeOptions)
	}
	if len(r.set.Inventory.TestSuites) != 2 {
		t.Errorf("suite rows = %+v", r.set.Inventory.TestSuites)
	}
}
