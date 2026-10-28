package benchmark_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

func indicator(t *testing.T, b resultset.Benchmark, id string) resultset.SideIndicator {
	t.Helper()
	for _, s := range b.SideIndicators {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("no side indicator %q in %d indicators", id, len(b.SideIndicators))
	return resultset.SideIndicator{}
}

func TestSideIndicatorsAreShownAndNeverChangeTheScore(t *testing.T) {
	clean := score(t, resultsettest.ScoredProject()).Benchmark

	p := resultsettest.ScoredProject()
	for i := 0; i < 5; i++ {
		p.Add("modules.cycles", "circular-import", false)
	}
	for i := 0; i < 40; i++ {
		p.Add("quality.unused", "unused-export", false)
	}
	for i := 0; i < 9; i++ {
		p.Add("types.javascript", "TS2339", false)
	}
	noisy := score(t, p).Benchmark

	wantScore(t, "import cycles", indicator(t, noisy, "import_cycles").Value, 5)
	wantScore(t, "unused exports", indicator(t, noisy, "unused_exports").Value, 40)
	wantScore(t, "JSDoc type errors", indicator(t, noisy, "jsdoc_type_errors").Value, 9)
	if *noisy.Score != *clean.Score || *noisy.Range != *clean.Range || *noisy.Verdict != *clean.Verdict {
		t.Errorf("side indicators changed the result: score %v and %v, range %+v and %+v",
			*clean.Score, *noisy.Score, *clean.Range, *noisy.Range)
	}
}

func TestTypeErrorsInTypeScriptFilesCountLikeThoseInJavaScriptFiles(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("types.javascript", "TS2345", false, resultsettest.AtPath("src/a.js"))
	p.Add("types.javascript", "TS2322", false, resultsettest.AtPath("src/b.ts"))
	p.Add("types.javascript", "TS2322", false, resultsettest.AtPath("src/c.tsx"))

	got := indicator(t, score(t, p).Benchmark, "jsdoc_type_errors")

	wantScore(t, "type errors", got.Value, 3)
	if got.State != resultset.PartMeasured {
		t.Errorf("state = %s, want measured: a package with TypeScript files is no longer unsupported", got.State)
	}
}

func TestATypeScriptPackageThatNeedsABuildStepLeavesTheTypeErrorIndicatorUnknownWithTheReason(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("types.javascript", resultset.StatusUnsupported, "build_step_required")

	got := indicator(t, score(t, p).Benchmark, "jsdoc_type_errors")

	if got.State != resultset.PartUnknown || got.Value != nil || got.Reason == nil || !strings.Contains(*got.Reason, "build_step_required") {
		t.Errorf("indicator = %+v, want unknown with the reason", got)
	}
}

func TestEverySideIndicatorOfTheSpecHasARow(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	for _, id := range []string{
		"coverage", "complexity", "duplication", "import_cycles", "unused_files", "unused_exports", "unused_dependencies",
		"jsdoc_type_errors", "runtime_warnings", "unknown_licenses", "copyleft_licenses", "install_scripts", "source_code_lines",
	} {
		indicator(t, b, id)
	}
}

func TestCoverageAndRuntimeWarningsAreUnknownUntilTheirChecksTakePart(t *testing.T) {
	b := score(t, resultsettest.ScoredProject()).Benchmark
	for _, id := range []string{"coverage", "runtime_warnings"} {
		got := indicator(t, b, id)
		if got.State != resultset.PartUnknown || got.Value != nil {
			t.Errorf("%s: state %s, value %v, want unknown without a value", id, got.State, got.Value)
		}
	}
}

func TestCoverageMetricsAppearAsIndicatorsWhenTheCheckRuns(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.AddExecution("tests.coverage", "C-0002")
	p.Metric("tests.coverage", "lines_percent", 81.25, "percent")
	p.Metric("tests.coverage", "branches_percent", 60, "percent")
	b := score(t, p).Benchmark
	lines := indicator(t, b, "coverage.lines_percent")
	wantScore(t, "lines", lines.Value, 81.25)
	if lines.Unit != "percent" || lines.State != resultset.PartMeasured {
		t.Errorf("lines: unit %q state %q", lines.Unit, lines.State)
	}
	wantScore(t, "branches", indicator(t, b, "coverage.branches_percent").Value, 60)
}

func TestRuntimeWarningsCountTheFindingsOfTheCheck(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.AddExecution("runtime.warnings", "C-0002")
	p.Add("runtime.warnings", "DEP0005", false)
	p.Add("runtime.warnings", "open-handle", false)
	got := indicator(t, score(t, p).Benchmark, "runtime_warnings")
	wantScore(t, "runtime warnings", got.Value, 2)
	if got.State != resultset.PartMeasured {
		t.Errorf("state = %s", got.State)
	}
}

func TestLicenseAndInstallScriptCounts(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Metric("security.licenses", "license:MIT", 120, "packages")
	p.Metric("security.licenses", "license:none_in_lockfile", 3, "packages")
	p.Metric("security.licenses", "license:GPL-3.0-only", 2, "packages")
	p.Metric("security.licenses", "license:(MIT OR LGPL-2.1)", 1, "packages")
	p.Metric("security.licenses", "license:Apache-2.0", 30, "packages")
	p.Metric("package.install-scripts", "install_scripts", 4, "packages")
	p.Metric("package.install-scripts", "install_script:esbuild", 1, "packages")
	b := score(t, p).Benchmark
	wantScore(t, "packages without a license", indicator(t, b, "unknown_licenses").Value, 3)
	if got := indicator(t, b, "unknown_licenses").Label; got != "Packages without a license in the lockfile" {
		t.Errorf("label = %q", got)
	}
	wantScore(t, "copyleft licenses", indicator(t, b, "copyleft_licenses").Value, 3)
	wantScore(t, "install scripts", indicator(t, b, "install_scripts").Value, 4)
}

func TestComplexityDuplicationAndSizeIndicators(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Metric("quality.metrics", "functions_above_cyclomatic_10", 7, "functions")
	p.Metric("quality.metrics", "functions_above_cognitive_15", 4, "functions")
	p.Metric("quality.metrics", "cyclomatic_p90", 6, "complexity")
	p.Metric("quality.clones", "duplication_percent_source", 3.5, "percent")
	// The indicator counts JavaScript and TypeScript only; the Source code
	// class total (which holds lockfiles and OpenAPI files too) is not it.
	p.Metric("quality.size", "lines.file_class:source", 40223, "lines")
	p.Metric("quality.size", "lines.source_code:javascript_typescript", 9700, "lines")
	b := score(t, p).Benchmark
	wantScore(t, "cyclomatic", indicator(t, b, "complexity.cyclomatic_10").Value, 7)
	wantScore(t, "cognitive", indicator(t, b, "complexity.cognitive_15").Value, 4)
	wantScore(t, "duplication", indicator(t, b, "duplication.source").Value, 3.5)
	lines := indicator(t, b, "source_code_lines")
	wantScore(t, "lines of JavaScript and TypeScript in Source code", lines.Value, 9700)
	if lines.Label != "Lines of JavaScript and TypeScript in Source code" || lines.Unit != "lines" {
		t.Errorf("source_code_lines label %q unit %q", lines.Label, lines.Unit)
	}
	for _, s := range b.SideIndicators {
		if s.ID == "source_lines" {
			t.Error("the old source_lines indicator is still reported")
		}
	}
	for _, s := range b.SideIndicators {
		if s.ID == "complexity.cyclomatic_p90" {
			t.Error("a percentile metric is not a threshold count")
		}
	}
}

func TestAnIndicatorWhoseCheckDidNotCompleteHasNoValue(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Status("modules.cycles", resultset.StatusTimedOut, "timed_out")
	got := indicator(t, score(t, p).Benchmark, "import_cycles")
	if got.State != resultset.PartUnknown || got.Value != nil {
		t.Errorf("state %s, value %v", got.State, got.Value)
	}
}
