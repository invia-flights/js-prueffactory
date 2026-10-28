// Package resultsettest builds small, valid, finalized result sets for tests at
// seam B (hand-made results in, exit code and rendered reports out).
package resultsettest

import (
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// SHA is a well-formed SHA-256 for fixtures.
var SHA = strings.Repeat("ab", 32)

// Minimal returns a finalized, valid result set with one project Context, one
// package Context and one completed syntax.parse execution without Findings.
// Callers may change it and call Finalize again.
func Minimal() *resultset.Set {
	at := time.Date(2026, 10, 25, 10, 15, 0, 0, time.UTC)
	s := &resultset.Set{
		Format: resultset.FormatID, SchemaVersion: resultset.SchemaVersion,
		Producer: resultset.Producer{Name: "js-prueffactory", Version: "test"},
		Run: resultset.Run{
			ID: "20261025T101500Z-demo-aaaa", Command: "test", StartedAt: at, FinishedAt: at.Add(time.Second),
			DurationMS: 1000, BudgetSeconds: 1800, BudgetSource: "default",
			Host:   resultset.Host{OS: "linux", Arch: "amd64"},
			Docker: resultset.DockerInfo{ServerVersion: "29.4.0", APIVersion: "1.56", CPUs: 4, MemoryBytes: 1 << 33},
		},
		Source: resultset.Source{
			OriginalPath: "/work/demo", SnapshotAlgorithm: "sorted-path-sha256-v1", SnapshotHash: SHA, FileCount: 2,
			OriginalUnchanged: true,
		},
		Profiles:  resultset.Profiles{CatalogVersion: "1", ExecutionProfile: "execution-v0", ToolsetVersion: "abc"},
		Selection: resultset.Selection{EffectiveChecks: []string{"syntax.parse"}, IsStandardScope: true},
		Contexts: []resultset.Context{
			{ID: "C-0001", Kind: "project", Path: "."},
			{ID: "C-0002", Kind: "package", Path: "."},
		},
		Summary:   resultset.Summary{NetworkIsolation: resultset.IsolationNotProbed},
		Benchmark: resultset.Benchmark{Status: resultset.BenchmarkNotRequested},
		Checks: []resultset.Execution{
			{ID: "e1", CheckID: "syntax.parse", Family: "syntax", ContextID: "C-0002", Selected: true,
				Applicability: resultset.Applicable, Status: resultset.StatusCompleted},
		},
		ReportCompleteness: resultset.ReportCompleteness{
			AllFindingsIncluded: true,
			Redaction:           resultset.Redaction{Reason: ptr("secrets scan not available")},
		},
	}
	s.Finalize()
	return s
}

func ptr[T any](v T) *T { return &v }
