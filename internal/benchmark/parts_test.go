package benchmark_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// Every expected score below was worked out by hand from the spec's formula
// S = 100 * 2^(-x / x50), not by calling the scorer's own code.

func advisory(severity, scope string) []func(*resultset.Finding) {
	return []func(*resultset.Finding){
		resultsettest.Evidence("advisory_severity", severity),
		resultsettest.Evidence("dependency_scope", scope),
	}
}

func TestOneHighAndTwoModerateProductionAdvisoriesGiveVNineAndFiftyThreePointSix(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("security.dependencies", "GHSA-high", false, advisory("high", "prod")...)
	p.Add("security.dependencies", "GHSA-mod-1", false, advisory("moderate", "prod")...)
	p.Add("security.dependencies", "GHSA-mod-2", false, advisory("moderate", "prod")...)
	b := score(t, p).Benchmark

	v := part(t, b, "vulnerabilities")
	wantScore(t, "V", v.RawValue, 9)
	wantScore(t, "part score", v.Score, 53.6)
	if v.Score != nil && *v.Score != 53.6 {
		t.Errorf("part score = %v, want exactly 53.6", *v.Score)
	}
	wantScore(t, "security area", area(t, b, "security").Score, 53.6)
}

func TestVulnerabilitiesWeighSeverityAndScope(t *testing.T) {
	tests := []struct {
		name     string
		severity string
		scope    string
		wantV    float64
	}{
		{"critical in production", "critical", "prod", 10},
		{"high in production", "high", "prod", 5},
		{"moderate in production", "moderate", "prod", 2},
		{"low in production", "low", "prod", 0.5},
		{"high in development", "high", "dev", 1.25},
		{"low in development", "low", "dev", 0.125},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			p.Add("security.dependencies", "GHSA-x", false, advisory(tc.severity, tc.scope)...)
			wantScore(t, "V", part(t, score(t, p).Benchmark, "vulnerabilities").RawValue, tc.wantV)
		})
	}
}

func TestAnAdvisoryWithoutSeverityCountsAsModerateInProduction(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Add("security.dependencies", "GHSA-x", false)
	wantScore(t, "V", part(t, score(t, p).Benchmark, "vulnerabilities").RawValue, 2)
}

func TestCountBasedPartsScoreFromTheirOwnX50(t *testing.T) {
	tests := []struct {
		name     string
		part     string
		build    func(p *resultsettest.Project)
		wantRaw  float64
		wantNEff float64 // 0 when the part does not damp
		want     float64
	}{
		{"smells: three hits of one rule, the Gate is not counted", "smells", func(p *resultsettest.Project) {
			for i := 0; i < 3; i++ {
				p.Add("tests.smells", "mocha/no-pending-tests", false)
			}
			p.Add("tests.smells", "mocha/no-exclusive-tests", true)
		}, 3, 2.58, 69.9},
		{"syntax: files that fail to parse, outside Test data, one file counted once", "syntax", func(p *resultsettest.Project) {
			p.Add("syntax.parse", "SyntaxError", true, resultsettest.AtPath("src/a.js"))
			p.Add("syntax.parse", "SyntaxError", true, resultsettest.AtPath("src/a.js"))
			p.Add("syntax.parse", "SyntaxError", true, resultsettest.AtPath("src/b.js"))
			p.Add("syntax.parse", "SyntaxError", false, resultsettest.AtPath("test/fixtures/c.js"), resultsettest.InTestData)
		}, 2, 0, 25},
		{"structured files: one file", "structured_files", func(p *resultsettest.Project) {
			p.Add("artifacts.structured", "invalid-json", true, resultsettest.AtPath("config.json"))
			p.Add("artifacts.structured", "invalid-json", false, resultsettest.AtPath("test/fixtures/x.json"), resultsettest.InTestData)
		}, 1, 0, 50},
		{"openapi: two structural errors of one rule, style hits ignored", "openapi", func(p *resultsettest.Project) {
			p.Applicable("api.lint")
			p.Add("api.lint", "spec-no-empty-servers", true)
			p.Add("api.lint", "spec-no-empty-servers", true)
			p.Add("api.lint", "operation-summary", false)
		}, 2, 2, 50},
		{"json schema: one schema fails to compile", "json_schema", func(p *resultsettest.Project) {
			p.Applicable("schema.compile")
			p.Add("schema.compile", "compile", true, resultsettest.AtPath("schemas/a.json"))
			p.Add("schema.compile", "compile", true, resultsettest.AtPath("schemas/a.json"))
			p.Add("schema.compile", "strict-mode", false, resultsettest.AtPath("schemas/b.json"))
		}, 1, 0, 70.7},
		{"helm: one chart fails with two values files", "helm", func(p *resultsettest.Project) {
			p.Applicable("repository.helm")
			msg := func(f *resultset.Finding) {
				f.Message = "helm reports error helm.template: chart in deploy/chart does not render with its default values: boom"
			}
			p.Add("repository.helm", "helm.template", true, msg)
			p.Add("repository.helm", "helm.template", true, msg, resultsettest.AtPath("deploy/chart/values-prod.yaml"))
			p.Add("repository.helm", "helm.lint", false)
		}, 1, 0, 50},
		{"dependency tree: three different problems", "dependency_tree", func(p *resultsettest.Project) {
			p.Add("deps.tree", "missing", false)
			p.Add("deps.tree", "invalid", false)
			p.Add("deps.tree", "extraneous", false)
		}, 3, 3, 50},
		{"dockerfile and shell: error-level hits of both tools, warnings ignored", "dockerfile_shell", func(p *resultsettest.Project) {
			p.Applicable("repository.dockerfile")
			p.Applicable("repository.shell")
			p.Add("repository.dockerfile", "DL3006", true)
			p.Add("repository.shell", "SC2086", true)
			p.Add("repository.shell", "SC2154", false)
		}, 2, 2, 63},
		{"lockfile integrity: five hits of one rule", "lockfile_integrity", func(p *resultsettest.Project) {
			for i := 0; i < 5; i++ {
				p.Add("security.integrity", "missing-integrity", false)
			}
		}, 5, 3.32, 63.1},
		{"code patterns: five hits of one rule in Source code, the one in Test data is not counted", "code_patterns", func(p *resultsettest.Project) {
			for i := 0; i < 5; i++ {
				p.Add("security.patterns", "njsscan/eval_nodejs", false)
			}
			p.Add("security.patterns", "prueffactory/eval-non-literal", false, resultsettest.InTestData)
		}, 5, 3.32, 63.1},
		{"correctness lint: four hits of one rule and one of another", "correctness_lint", func(p *resultsettest.Project) {
			for i := 0; i < 4; i++ {
				p.Add("lint.correctness", "no-undef", false)
			}
			p.Add("lint.correctness", "no-unreachable", false)
		}, 5, 4, 75.8},
		{"project linter: only the Gates the project's config makes", "project_linter", func(p *resultsettest.Project) {
			p.Applicable("lint.existing")
			p.Add("lint.existing", "no-unused-vars", true)
			p.Add("lint.existing", "semi", true)
			p.Add("lint.existing", "quotes", false)
		}, 2, 2, 75.8},
		{"node compatibility: two hits of one rule", "node_compatibility", func(p *resultsettest.Project) {
			p.Add("deps.engines", "n/no-deprecated-api", false)
			p.Add("deps.engines", "n/no-deprecated-api", false)
		}, 2, 2, 63},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, tc.part)
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s (%v), want measured", got.State, got.Reason)
			}
			wantScore(t, "raw value", got.RawValue, tc.wantRaw)
			if tc.wantNEff > 0 {
				wantScore(t, "n_eff", got.NEff, tc.wantNEff)
			} else if got.NEff != nil {
				t.Errorf("n_eff = %v on a part that does not damp", *got.NEff)
			}
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func TestSuppressionsCountCommentsInSourceAndTestCode(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.Set.Inventory.Suppressions = []resultset.SuppressionCount{
		{Kind: "eslint-disable", FileClass: "source", Count: 12},
		{Kind: "@ts-ignore", FileClass: "test_code", Count: 8},
	}
	got := part(t, score(t, p).Benchmark, "suppressions")
	wantScore(t, "raw value", got.RawValue, 20)
	wantScore(t, "score", got.Score, 50)
}

func TestNotCountBasedPartsFollowTheirOwnRules(t *testing.T) {
	tests := []struct {
		name  string
		part  string
		build func(p *resultsettest.Project)
		want  float64
	}{
		{"manifest: fine", "manifest", func(p *resultsettest.Project) {}, 100},
		{"manifest: missing lockfile is 50", "manifest", func(p *resultsettest.Project) {
			p.Add("package.manifest", "lockfile-missing", false)
		}, 50},
		{"manifest: broken is 0", "manifest", func(p *resultsettest.Project) {
			p.Add("package.manifest", "lockfile-missing", false)
			p.Add("package.manifest", "lockfile-specifier-mismatch", true)
		}, 0},
		{"install: fine", "install", func(p *resultsettest.Project) {}, 100},
		{"install: a failure the project caused is 0", "install", func(p *resultsettest.Project) {
			p.Add("package.install", "lockfile-out-of-sync", true)
		}, 0},
		{"secrets: none", "secrets", func(p *resultsettest.Project) {}, 100},
		{"secrets: only in Test data", "secrets", func(p *resultsettest.Project) {
			p.Add("security.secrets", "generic-api-key", false, resultsettest.InTestData)
		}, 100},
		{"secrets: only in Test code", "secrets", func(p *resultsettest.Project) {
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath("test/helpers.js"), resultsettest.InTestCode)
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath("src/a.spec.js"), resultsettest.InTestCode)
		}, 100},
		{"secrets: only in Test data and Test code", "secrets", func(p *resultsettest.Project) {
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath("test/fixtures/a.json"), resultsettest.InTestData)
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath("test/helpers.js"), resultsettest.InTestCode)
		}, 100},
		{"secrets: one in Source code is 0", "secrets", func(p *resultsettest.Project) {
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath("test/helpers.js"), resultsettest.InTestCode)
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath("src/config.js"))
		}, 0},
		{"secrets: one in a root .env is 0", "secrets", func(p *resultsettest.Project) {
			p.Add("security.secrets", "generic-api-key", false, resultsettest.AtPath(".env"))
		}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := resultsettest.ScoredProject()
			tc.build(p)
			got := part(t, score(t, p).Benchmark, tc.part)
			if got.State != resultset.PartMeasured {
				t.Fatalf("state = %s, want measured", got.State)
			}
			if got.X50 != nil || got.NEff != nil {
				t.Errorf("x50 %v and n_eff %v on a part that is not count-based", got.X50, got.NEff)
			}
			wantScore(t, "part score", got.Score, tc.want)
		})
	}
}

func fileCount(name string, found, passed, focusedPassed int) resultset.TestFileCount {
	return resultset.TestFileCount{File: name, Found: found, Passed: passed, PassedFocused: focusedPassed}
}

func TestThePassRateIsTheMeanOverTestFilesNotOverTests(t *testing.T) {
	p := resultsettest.ScoredProject()
	// 100 tests that all pass in one file, 1 of 2 in another: the mean over
	// files is 75, the mean over tests would be 99.
	p.TestFiles(fileCount("test/big.test.js", 100, 100, 0), fileCount("test/small.test.js", 2, 1, 0))
	got := part(t, score(t, p).Benchmark, "pass_rate")
	wantScore(t, "pass rate", got.Score, 75)
	wantScore(t, "tests area", area(t, score(t, p).Benchmark, "tests").Score, 75)
}

func TestFilesWithoutTestsAreIgnoredByThePassRate(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(fileCount("test/a.test.js", 4, 4, 0), fileCount("test/empty.test.js", 0, 0, 0))
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 100)
}

func TestAFocusedTestThatPassedStillCountsAsNotPassed(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(fileCount("test/a.test.js", 4, 4, 1))
	wantScore(t, "pass rate", part(t, score(t, p).Benchmark, "pass_rate").Score, 75)
}

func TestAFileThatFailedToLoadCountsAsOneFileWithRateZero(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles(fileCount("test/a.test.js", 4, 4, 0))
	p.Add("tests.existing", "test-file-load-failed", true, resultsettest.AtPath("test/broken.test.js"))
	got := part(t, score(t, p).Benchmark, "pass_rate")
	wantScore(t, "pass rate", got.Score, 50)
}

func TestAProjectWithoutTestsGetsZeroWithReasonNoTests(t *testing.T) {
	t.Run("the package has no test script", func(t *testing.T) {
		p := resultsettest.ScoredProject()
		p.NotApplicable("tests.existing")
		p.TestFiles()
		got := part(t, score(t, p).Benchmark, "pass_rate")
		assertProjectFault(t, got, "no_tests")
	})
	t.Run("the suite ran and found nothing", func(t *testing.T) {
		p := resultsettest.ScoredProject()
		p.TestFiles()
		got := part(t, score(t, p).Benchmark, "pass_rate")
		assertProjectFault(t, got, "no_tests")
	})
}

func TestAMissingTestRunnerIsTheProjectsFault(t *testing.T) {
	p := resultsettest.ScoredProject()
	p.TestFiles()
	p.Add("tests.existing", "test-runner-not-installed", true)
	assertProjectFault(t, part(t, score(t, p).Benchmark, "pass_rate"), "test_runner_not_installed")
}

func assertProjectFault(t *testing.T, got resultset.BenchmarkPart, reason string) {
	t.Helper()
	if got.State != resultset.PartProjectFault {
		t.Fatalf("part %s state = %s, want project_fault", got.ID, got.State)
	}
	if got.Reason == nil || *got.Reason != reason {
		t.Errorf("part %s reason = %v, want %s", got.ID, got.Reason, reason)
	}
	wantScore(t, "score", got.Score, 0)
	wantNull(t, "raw value", got.RawValue)
}

func TestTheWorstPartOfAnAreaDecidesTheArea(t *testing.T) {
	p := resultsettest.ScoredProject()
	// Excellent linting cannot hide a leaked secret inside Security.
	p.Add("security.secrets", "generic-api-key", false)
	b := score(t, p).Benchmark
	wantScore(t, "vulnerabilities", part(t, b, "vulnerabilities").Score, 100)
	wantScore(t, "security area", area(t, b, "security").Score, 0)
	// 40 + 20 + 15 of 100 weight at 100, Security at 0.
	wantScore(t, "score", b.Score, 75)
}

func TestAbsoluteCountsDoNotDependOnProjectSize(t *testing.T) {
	small := resultsettest.ScoredProject()
	small.Add("security.dependencies", "GHSA-x", false, advisory("critical", "prod")...)
	large := resultsettest.ScoredProject()
	large.Add("security.dependencies", "GHSA-x", false, advisory("critical", "prod")...)
	large.Set.Inventory.Size = []resultset.SizeCount{{Group: "file_class", Name: "source", Lines: 900000, NonBlankLines: 800000}}
	a := part(t, score(t, small).Benchmark, "vulnerabilities").Score
	b := part(t, score(t, large).Benchmark, "vulnerabilities").Score
	if a == nil || b == nil || *a != *b {
		t.Errorf("the same advisory scores %v in a small and %v in a large project", a, b)
	}
}
