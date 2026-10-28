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

// Seam A tests of tests.existing for suites that do not go as planned. Each
// starts from a copy of clean-mocha and changes it.

// writeFiles adds or replaces files of a project copy.
func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// setTestScript changes scripts.test of a project copy.
func setTestScript(t *testing.T, dir, script string) {
	t.Helper()
	p := filepath.Join(dir, "package.json")
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	m["scripts"] = map[string]any{"test": script}
	out, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(p, out, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestATestFileThatFailsToLoadIsAGateFindingWithTheError(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, map[string]string{
		"test/broken.test.js": "'use strict';\n\nconst missing = require('./does-not-exist');\n\ndescribe('broken', () => {\n  it('never loads', () => {});\n});\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || e.Gate != 1 {
		t.Errorf("tests.existing = %+v, want completed with one Gate", e)
	}
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 || fs[0].RuleID == nil || *fs[0].RuleID != "test-file-load-failed" || !fs[0].Gate {
		t.Fatalf("findings = %+v", fs)
	}
	if loc := fs[0].Locations[0]; loc.Path != "test/broken.test.js" || loc.Start == nil || loc.Start.Line != 3 {
		t.Errorf("location = %+v, want test/broken.test.js:3", loc)
	}
	if text := fs[0].Evidence[0].Text; !strings.Contains(text, "does-not-exist") || strings.Contains(text, "/work/") {
		t.Errorf("evidence = %q", text)
	}
	r.assertNothingLeft(t)
}

func TestATestThatEndsTheProcessLeavesTheRecordedResultsAndNeverRunTests(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, map[string]string{
		"test/b-exits.test.js": "'use strict';\n\ndescribe('exits', () => {\n  it('quits the process', () => {\n    process.exit(0);\n  });\n\n  it('would run next', () => {});\n});\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 || *fs[0].RuleID != "test-run-aborted" {
		t.Fatalf("findings = %+v", fs)
	}
	if got := passedTitles(t, r, e); !slices.Equal(got, []string{"add adds two numbers"}) {
		t.Errorf("the result recorded before the process ended is kept: passed = %v", got)
	}
	titles := map[string]resultset.TestOutcome{}
	for _, tc := range testCasesOf(&r.set, e.ID) {
		titles[tc.FullTitle] = tc.Outcome
		if tc.Outcome == resultset.TestNeverRun && (tc.NeverRunReason == nil || !strings.Contains(*tc.NeverRunReason, "stopped")) {
			t.Errorf("%s = %+v", tc.FullTitle, tc)
		}
	}
	if titles["exits would run next"] != resultset.TestNeverRun || titles["exits quits the process"] != resultset.TestNeverRun {
		t.Errorf("test cases = %v, want the two tests that did not finish as never_run", titles)
	}
	r.assertNothingLeft(t)
}

func TestAMissingTestRunnerIsAGateFindingBecauseTheProjectIsAtFault(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	// The project asks for Mocha in its script but never installs it.
	writeFiles(t, original, map[string]string{
		"package.json":      `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"mocha"}}` + "\n",
		"package-lock.json": `{"name":"clean-mocha","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"clean-mocha","version":"1.0.0"}}}` + "\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	fs := findingsOf(&r.set, "tests.existing")
	if e.Status != resultset.StatusCompleted || len(fs) != 1 || fs[0].Title != "test runner not installed" || !fs[0].Gate ||
		fs[0].Confidence != resultset.ConfidenceConfirmed {
		t.Fatalf("tests.existing = %+v, findings = %+v", e, fs)
	}
	r.assertNothingLeft(t)
}

func TestAnUnsupportedMochaVersionIsReportedAsUnsupportedWithTheVersion(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	// No lockfile, so npm install resolves the exact old version.
	writeFiles(t, original, map[string]string{
		"package.json": `{"name":"clean-mocha","version":"1.0.0","private":true,"scripts":{"test":"mocha"},"devDependencies":{"mocha":"8.4.0"}}` + "\n",
	})
	if err := os.Remove(filepath.Join(original, "package-lock.json")); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 2 {
		t.Fatalf("exit = %d, want 2\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	if e.Status != resultset.StatusUnsupported || e.ReasonCode == nil || *e.ReasonCode != "test_runner_version_unsupported" ||
		e.Reason == nil || !strings.Contains(*e.Reason, "8.4.0") {
		t.Errorf("tests.existing = %+v", e)
	}
	r.assertNothingLeft(t)
}

func TestTheScriptsEnvironmentReachesTheTestsAndOurReporterReplacesTheProjectsReporterAndBail(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	setTestScript(t, original, "NODE_ENV=staging GREETING_FROM_SCRIPT='hello world' mocha --reporter dot --bail")
	writeFiles(t, original, map[string]string{
		"test/env.test.js": `'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

describe('the container', () => {
  it('sees the variables of the test script', () => {
    assert.strictEqual(process.env.NODE_ENV, 'staging');
    assert.strictEqual(process.env.GREETING_FROM_SCRIPT, 'hello world');
  });

  it('sees no variable of the host', () => {
    assert.strictEqual(process.env.TMPDIR, undefined);
    assert.strictEqual(process.env.XDG_STATE_HOME, undefined);
  });

  it('may write into its project folder', () => {
    fs.writeFileSync('written-by-a-test.txt', 'ok');
  });
});

describe('bail is off', () => {
  it('fails first', () => {
    assert.fail('first failure');
  });

  it('still runs after a failure', () => {});
});
`,
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 1 {
		t.Fatalf("exit = %d, want 1\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	fs := findingsOf(&r.set, "tests.existing")
	if len(fs) != 1 || !strings.Contains(fs[0].Title, "bail is off fails first") {
		t.Fatalf("findings = %+v, want only the deliberate failure", fs)
	}
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 6, Run: 6, Passed: 5, Failed: 1}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v: --no-bail keeps the tests after the failure running", got, want)
	}
	// The project's own reporter and bail are replaced, and the Report says so.
	var overrides []string
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "test_command_override" {
			overrides = append(overrides, l.Message)
		}
	}
	joined := strings.Join(overrides, "\n")
	if !strings.Contains(joined, "--reporter dot") || !strings.Contains(joined, "--bail") {
		t.Errorf("overrides = %q", overrides)
	}
	// The native command for the failure keeps the project's environment.
	native := fs[0].Reproduction.Test.NativeCommand
	if len(native) < 5 || native[0] != "env" || native[1] != "GREETING_FROM_SCRIPT=hello world" || native[2] != "NODE_ENV=staging" {
		t.Errorf("native command = %q", native)
	}
	r.assertNothingLeft(t)
}

func TestSkippedTestsAreCountedAsSkippedAndAreTestCases(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeFiles(t, original, map[string]string{
		"test/skipped.test.js": "'use strict';\n\ndescribe('later', () => {\n  it.skip('is skipped', () => {});\n  it('is pending without a body');\n});\n",
	})

	r := realRun(t, context.Background(), "test", original, "--only", "tests.existing")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "tests.existing")
	want := resultset.PackageTests{ContextID: e.ContextID, Found: 3, Run: 1, Passed: 1, Skipped: 2}
	if got := inventoryOf(t, &r.set, e.ContextID); got != want {
		t.Errorf("inventory = %+v, want %+v", got, want)
	}
	cases := testCasesOf(&r.set, e.ID)
	if len(cases) != 2 || cases[0].Outcome != resultset.TestSkipped || cases[1].Outcome != resultset.TestSkipped || r.set.Summary.TestCases.Skipped != 2 {
		t.Errorf("test cases = %+v, summary = %+v", cases, r.set.Summary.TestCases)
	}
	r.assertNothingLeft(t)
}
