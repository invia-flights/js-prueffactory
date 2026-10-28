//go:build docker

package cli_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon: Test code is what the project's test
// runner loads, wherever it lives. The specs sit next to the code and a Mocha
// config written in JavaScript selects them, so only the project's own Mocha
// can say which files are tests.

func noUndefIn(s *resultset.Set, check string) []string {
	var paths []string
	for _, f := range findingsOf(s, check) {
		if f.RuleID != nil && *f.RuleID == "no-undef" {
			paths = append(paths, f.Locations[0].Path)
		}
	}
	slices.Sort(paths)
	return slices.Compact(paths)
}

func TestFilesTheRunnerLoadsAreTestCodeEvenNextToTheCodeAndAFileWithATestLikeNameIsNot(t *testing.T) {
	original := copyProject(t, "colocated-tests")

	r := realRun(t, context.Background(), "test", original,
		"--only", "package.install,lint.correctness,quality.suppressions,tests.coverage")

	if r.code != 0 && r.code != 1 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)

	// The probe moved the spec and the file the config requires, and says which
	// suite loads them. src/ab-test.js is not among them.
	var moved []string
	for _, m := range r.set.Inventory.MovedTestFiles {
		if m.Suite != "scripts.test" {
			t.Errorf("moved file %+v: the suite is the test script", m)
		}
		moved = append(moved, m.Path+":"+m.Kind)
	}
	slices.Sort(moved)
	if want := []string{"src/a.spec.js:spec", "src/setup.js:require"}; !slices.Equal(moved, want) {
		t.Errorf("moved test files = %v, want %v", moved, want)
	}
	var measured bool
	for _, m := range r.set.Metrics {
		if m.CheckID == "package.install" && m.Name == "test_files.moved:scripts.test" && m.Value != nil && *m.Value == 2 {
			measured = true
		}
	}
	if !measured {
		t.Errorf("no Measurement says that two files moved for the suite: %+v", r.set.Metrics)
	}

	// No Mocha global is undefined in the spec, and a real no-undef in the file
	// the runner does not load is still reported: it is Source code.
	if got := noUndefIn(&r.set, "lint.correctness"); !slices.Equal(got, []string{"src/ab-test.js"}) {
		t.Errorf("no-undef in %v, want src/ab-test.js only", got)
	}

	// The Inventory's Test code hashes have the two moved files, not the other.
	roles := map[string]string{}
	for _, h := range r.set.Inventory.FileHashes {
		roles[h.Path] = h.Role
	}
	if roles["src/a.spec.js"] != "test_code" || roles["src/setup.js"] != "test_code" {
		t.Errorf("file hashes = %v, want the spec and the setup file as test_code", roles)
	}
	if _, ok := roles["src/ab-test.js"]; ok {
		t.Errorf("src/ab-test.js is Source code and has no Test code hash: %v", roles)
	}

	// Coverage leaves Test code out and still counts the Source code.
	cov := oneExecution(t, &r.set, "tests.coverage")
	if cov.Status != resultset.StatusCompleted {
		t.Fatalf("tests.coverage = %+v", cov)
	}
	covered := map[string]bool{}
	for _, f := range coverageFilesOf(t, r, cov).Files {
		covered[f.Path] = true
	}
	if covered["src/a.spec.js"] || covered["src/setup.js"] || !covered["src/index.js"] || !covered["src/ab-test.js"] {
		t.Errorf("coverage files = %v, want the Source code (src/index.js, src/ab-test.js) and neither the spec nor the setup file", covered)
	}

	// The probe resolved everything, and the runner loaded nothing else.
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "test_files_not_resolved" || l.ReasonCode == "test_file_classified_as_source" {
			t.Errorf("limitation %+v, want none", l)
		}
	}
}

func TestAMochaConfigThatThrowsLeavesTheStaticClassesAndSaysSo(t *testing.T) {
	original := copyProject(t, "colocated-tests-broken-config")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.correctness")

	r.assertNothingLeft(t)
	var limitation *resultset.Limitation
	for i, l := range r.set.Limitations {
		if l.ReasonCode == "test_files_not_resolved" {
			limitation = &r.set.Limitations[i]
		}
	}
	if limitation == nil {
		t.Fatalf("no test_files_not_resolved Limitation in %+v", r.set.Limitations)
	}
	for _, want := range []string{"scripts.test", "config boom"} {
		if !strings.Contains(limitation.Message, want) {
			t.Errorf("the Limitation does not say %q: %s", want, limitation.Message)
		}
	}
	if len(r.set.Inventory.MovedTestFiles) != 0 {
		t.Errorf("moved test files = %+v, want none", r.set.Inventory.MovedTestFiles)
	}
	// The spec is in src/, so by its place it is Source code and `describe` is
	// not known there.
	if got := noUndefIn(&r.set, "lint.correctness"); !slices.Equal(got, []string{"src/a.spec.js"}) {
		t.Errorf("no-undef in %v, want src/a.spec.js: the static classes stay", got)
	}
}
