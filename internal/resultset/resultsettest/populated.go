package resultsettest

import (
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Populated returns a finalized test mode result set that uses every section
// of the Report contract except the benchmark details (ScoredProject covers
// those), so a field added to a Go type but not to the schema (or the other way
// round) fails where it is used, and a closed-vocabulary field that redaction
// would rewrite shows up as an invalid Report.
func Populated() *resultset.Set {
	at := time.Date(2026, 10, 25, 10, 15, 0, 0, time.UTC)
	s := &resultset.Set{
		Format: resultset.FormatID, SchemaVersion: resultset.SchemaVersion,
		Producer: resultset.Producer{Name: "js-prueffactory", Version: "0.1.0", VCSRevision: ptr("abc")},
		Run: resultset.Run{
			ID: "20261025T101500Z-x-aaaa", Command: "test", StartedAt: at, FinishedAt: at.Add(time.Minute),
			DurationMS: 60000, BudgetSeconds: 1800, BudgetSource: "default",
			Host:   resultset.Host{OS: "darwin", Arch: "arm64"},
			Docker: resultset.DockerInfo{ServerVersion: "29.4.0", APIVersion: "1.56", CPUs: 8, MemoryBytes: 1 << 33},
		},
		Source: resultset.Source{
			OriginalPath: "/p", SnapshotAlgorithm: "sorted-path-sha256-v1", SnapshotHash: SHA, FileCount: 3,
			Git: &resultset.GitState{Commit: "deadbeef", Dirty: "unknown"}, OriginalUnchanged: true,
		},
		Profiles: resultset.Profiles{CatalogVersion: "1", ExecutionProfile: "execution-v0", ToolsetVersion: "abc"},
		Selection: resultset.Selection{
			Only: []string{"syntax"}, EffectiveChecks: []string{"syntax.parse"}, IsStandardScope: false,
		},
		Contexts: []resultset.Context{
			{ID: "C-0001", Kind: "project", Path: "."},
			{ID: "C-0002", Kind: "package", Path: ".", NPM: ptr("11.0.0"),
				Node:   &resultset.NodeRuntime{Version: "24", Source: "default", Image: "node@sha256:" + SHA, ImageDigest: "sha256:" + SHA, Variant: "debian"},
				Tools:  []resultset.ToolRef{{Name: "node", Version: "24.22.1", Digest: ptr("sha256:" + SHA)}},
				Limits: resultset.ContainerLimit{CPUs: 2, MemoryMB: 4096}},
		},
		Services: []resultset.Service{{
			Family: "valkey", ComposeService: "redis", Image: ptr("valkey"), ImageDigest: ptr("sha256:x"),
			DeclaredImage: "valkey/valkey:8", ContextIDs: []string{"C-0002"}, Status: "started",
		}},
		Summary:   resultset.Summary{NetworkIsolation: resultset.IsolationNotProbed, TestCases: resultset.TestCounts{Passed: 4, Failed: 1}},
		Benchmark: resultset.Benchmark{Status: resultset.BenchmarkNotRequested},
		Checks: []resultset.Execution{
			{ID: "tmp", CheckID: "tests.existing", Family: "tests", ContextID: "C-0002", Selected: true,
				Applicability: resultset.Applicable, Status: resultset.StatusCompleted,
				StartedAt: &at, DurationMS: ptr(int64(5)), Tool: &resultset.Tool{Name: "mocha", Version: ptr("10.8.2"), ExitCode: ptr(1)},
				Command: []string{"mocha"}, ArtifactIDs: []string{"art"}},
		},
		TestCases: []resultset.TestCase{{
			ID: "t", ExecutionID: "tmp", File: "test/a.js", Suite: "scripts.test", FullTitle: "a b", SuitePath: []string{"a"},
			Outcome: resultset.TestFailed, Flaky: false, FindingIDs: []string{"f"},
			Attempts: []resultset.TestAttempt{{Outcome: resultset.TestFailed, DurationMS: 3, Error: ptr("boom")}},
		}},
		Findings: []resultset.Finding{{
			ID: "f", CheckID: "tests.existing", ExecutionID: "tmp", ContextID: "C-0002", RuleID: ptr("assertion"),
			Fingerprint: resultset.NewFingerprint("tests.existing", "assertion", "test/a.js", "a b"),
			Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
			Title: "t", Message: "m",
			Locations: []resultset.Location{{
				Role: "primary", PathBase: "project_root", Path: "test/a.js", FileSHA256: SHA,
				Start: &resultset.Position{Line: 3, Column: ptr(5)}, End: &resultset.Position{Line: 3},
				Snippet: &resultset.Snippet{StartLine: 3, Text: "x"},
			}},
			Expected: ptr("1"), Actual: ptr("2"),
			Evidence: []resultset.Evidence{{Kind: "stack", Text: "x", Origin: "mocha", Trust: resultset.TrustUntrusted, OriginalSize: ptr(9000), ArtifactID: ptr("art")}},
			Reproduction: resultset.Reproduction{
				Rerun:      []string{"js-prueffactory", "test", "/p"},
				Test:       &resultset.TestRepro{Runner: "mocha", File: "test/a.js", FullTitle: "a b", NativeCommand: []string{"mocha", "--fgrep", "a b"}},
				VerifiedBy: []string{"tests.existing"},
			},
			Limitations: []string{"x"},
			Suite:       ptr("scripts.test"),
		}},
		Metrics: []resultset.Metric{{ID: "m", CheckID: "quality.size", ContextID: "C-0001", Name: "lines", Value: ptr(10.0), Unit: "lines"}},
		Inventory: resultset.Inventory{
			Tests:          []resultset.PackageTests{{ContextID: "C-0002", Found: 5}},
			TestSuites:     []resultset.SuiteTests{{ContextID: "C-0002", Suite: "scripts.test", Found: 5}},
			TestFiles:      []resultset.TestFileCount{{ContextID: "C-0002", Suite: "scripts.test", File: "test/a.js", Found: 5}},
			Suppressions:   []resultset.SuppressionCount{{Kind: "eslint-disable", FileClass: "source", Count: 1}},
			FileHashes:     []resultset.FileHash{{Path: "package.json", Role: "manifest", SHA256: SHA}},
			Size:           []resultset.SizeCount{{Group: "extension", Name: ".js", Lines: 3, NonBlankLines: 2}},
			MovedTestFiles: []resultset.MovedTestFile{{ContextID: "C-0002", Path: "src/a.spec.js", Suite: "scripts.test", Kind: "spec"}},
		},
		Limitations: []resultset.Limitation{{ReasonCode: "x", Message: "m", CheckID: ptr("syntax.parse"), Path: ptr("a")}},
		Artifacts:   []resultset.Artifact{{ID: "art", Path: "artifacts/a.json", MediaType: "application/json", SHA256: SHA, Size: 1, CheckID: "tests.existing"}},
		ReportCompleteness: resultset.ReportCompleteness{
			AllFindingsIncluded: true, Redaction: resultset.Redaction{Applied: false, Reason: ptr("secrets scan not run")},
		},
	}
	s.Finalize()
	return s
}
