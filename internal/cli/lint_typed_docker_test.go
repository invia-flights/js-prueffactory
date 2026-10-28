//go:build docker

package cli_test

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A with a real Docker daemon, for lint.typed.

func TestLintTypedReportsFloatingAndMisusedPromisesAndIgnoresTheDisableComment(t *testing.T) {
	original := copyProject(t, "typed-js")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original, "--only", "lint.typed")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: the Findings are warnings and never Gates\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
	exec := oneExecution(t, &r.set, "lint.typed")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("lint.typed = %+v\nstderr:\n%s", exec, r.stderr)
	}
	if command := strings.Join(exec.Command, " "); !strings.Contains(command, "--no-config-lookup") || !strings.Contains(command, "--no-inline-config") || !strings.Contains(command, "--format json") {
		t.Errorf("command = %q", command)
	}

	// The lines of src/orders.js: 19 floats a promise, 29 does too behind an
	// eslint-disable comment, 38 hands an async callback to forEach, 49 awaits a
	// number. test/orders.test.js line 7 floats a promise in Test code.
	type key struct {
		rule, path string
		line       int
	}
	got := map[key]resultset.Finding{}
	for _, f := range findingsOf(&r.set, "lint.typed") {
		if f.Gate || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely {
			t.Errorf("finding = %+v, want a likely warning without Gate", f)
		}
		got[key{*f.RuleID, f.Locations[0].Path, f.Locations[0].Start.Line}] = f
	}
	floating, misused, thenable := "@typescript-eslint/no-floating-promises", "@typescript-eslint/no-misused-promises", "@typescript-eslint/await-thenable"
	for _, want := range []key{
		{floating, "src/orders.js", 19}, {floating, "src/orders.js", 29}, {misused, "src/orders.js", 38}, {thenable, "src/orders.js", 49},
		{floating, "test/orders.test.js", 7},
	} {
		f, ok := got[want]
		if !ok {
			t.Errorf("no finding %+v among %d: %v", want, len(got), got)
			continue
		}
		if f.InTestCode != (want.path == "test/orders.test.js") {
			t.Errorf("%+v: in_test_code = %v", want, f.InTestCode)
		}
	}
	if len(got) != 5 {
		t.Errorf("findings = %d, want exactly the five above", len(got))
	}

	// The rule list and its hash are recorded.
	if artifactOf(&r.set, exec, "C-0002-rules.json") == nil {
		t.Errorf("no rule list artifact: %+v", r.set.Artifacts)
	}
	found := false
	for _, c := range r.set.Contexts {
		for _, tool := range c.Tools {
			found = found || (tool.Name == "typed-lint-rules" && tool.Digest != nil && len(*tool.Digest) == 64)
		}
	}
	if !found {
		t.Error("the Context does not record the rule list hash")
	}
}

func TestLintTypedAcceptsAChainThatEndsInARejectionHandlerOfTypeAnyOrFunctionAndStillReportsTheOthers(t *testing.T) {
	original := copyProject(t, "typed-js-handlers")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.typed")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	exec := oneExecution(t, &r.set, "lint.typed")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("lint.typed = %+v\nstderr:\n%s", exec, r.stderr)
	}
	// src/handler.js: the chains that end in .catch(next), .then(f, onError) and
	// .catch(onError).finally(f) (lines 18 to 33) are handled. Line 38 drops a
	// promise and line 43 has no rejection handler.
	var lines []int
	for _, f := range findingsOf(&r.set, "lint.typed") {
		if *f.RuleID != "@typescript-eslint/no-floating-promises" || f.Locations[0].Path != "src/handler.js" {
			t.Errorf("finding = %+v, want only floating promises in src/handler.js", f)
			continue
		}
		lines = append(lines, f.Locations[0].Start.Line)
	}
	sort.Ints(lines)
	if !slices.Equal(lines, []int{38, 43}) {
		t.Errorf("floating promises at lines %v, want [38 43]", lines)
	}
}

func TestLintTypedLeavesTheTopLevelRegistrationsOfNodeTestAloneAndStillReportsARealFloatingPromise(t *testing.T) {
	original := copyProject(t, "typed-js-node-test")

	r := realRun(t, context.Background(), "test", original, "--only", "lint.typed")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	r.assertNothingLeft(t)
	exec := oneExecution(t, &r.set, "lint.typed")
	if exec.Status != resultset.StatusCompleted {
		t.Fatalf("lint.typed = %+v\nstderr:\n%s", exec, r.stderr)
	}
	// Both test files register tests, hooks and suites at the top level, in
	// every form of import. Only the assert.rejects of
	// test/registration.test.js line 29 is a promise nobody awaits.
	findings := findingsOf(&r.set, "lint.typed")
	if len(findings) != 1 {
		var where []string
		for _, f := range findings {
			where = append(where, fmt.Sprintf("%s:%d", f.Locations[0].Path, f.Locations[0].Start.Line))
		}
		t.Fatalf("findings = %v, want only the floating assert.rejects", where)
	}
	f := findings[0]
	if *f.RuleID != "@typescript-eslint/no-floating-promises" || f.Locations[0].Path != "test/registration.test.js" || f.Locations[0].Start.Line != 29 || !f.InTestCode {
		t.Errorf("finding = %+v, want a floating promise in Test code at test/registration.test.js:29", f)
	}
}

func TestBenchmarkCountsOnlyTheSourceCodeHitsOfTypedLintAndRecordsTheRuleListInTheFingerprint(t *testing.T) {
	original := copyProject(t, "typed-js")

	r := realRun(t, context.Background(), "benchmark", original, "--only", "lint.typed")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0\nstderr:\n%s", r.code, r.stderr)
	}
	part := benchmarkPart(t, &r.set, "typed_lint")
	if part.State != resultset.PartMeasured || part.RawValue == nil || part.Score == nil {
		t.Fatalf("part = %+v", part)
	}
	// Four Source code hits in three rules: floating twice (damped to 2),
	// misused once and await-thenable once, so n_eff is 4; the hit in Test code
	// does not count.
	if *part.RawValue != 4 || part.NEff == nil || *part.NEff != 4 {
		t.Errorf("raw value %v, n_eff %v, want 4 and 4", *part.RawValue, part.NEff)
	}
	fp := r.set.Benchmark.Fingerprint
	if fp == nil || fp.Fields.TypedLintRulesHash == nil || len(*fp.Fields.TypedLintRulesHash) != 64 {
		t.Errorf("fingerprint = %+v, want the typed lint rule list hash", fp)
	}
	r.assertNothingLeft(t)
}
