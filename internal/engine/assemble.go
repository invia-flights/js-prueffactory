package engine

import (
	"context"
	"runtime"
	"runtime/debug"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// Version is the version of the binary.
const Version = "0.1.0-dev"

func producer() resultset.Producer {
	p := resultset.Producer{Name: "js-prueffactory", Version: Version}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && s.Value != "" {
				rev := s.Value
				p.VCSRevision = &rev
			}
		}
	}
	return p
}

// assemble builds the result set from what the Run collected. Executions,
// Findings and metrics still carry temporary keys; Finalize replaces them.
func (r *run) assemble(ctx context.Context) *resultset.Set {
	finished := time.Now()
	cfg := r.cfg

	s := &resultset.Set{
		Format: resultset.FormatID, SchemaVersion: resultset.SchemaVersion,
		Producer: producer(),
		Run: resultset.Run{
			ID: cfg.RunID, Command: cfg.Command,
			StartedAt: cfg.Start.UTC(), FinishedAt: finished.UTC(), DurationMS: finished.Sub(cfg.Start).Milliseconds(),
			BudgetSeconds: int64(cfg.Budget / time.Second), BudgetSource: cfg.BudgetSource,
			Status: resultset.RunCompleted,
			Host:   resultset.Host{OS: runtime.GOOS, Arch: runtime.GOARCH},
		},
		Source: resultset.Source{
			OriginalPath:      cfg.Original,
			SnapshotAlgorithm: r.snap.Algorithm, SnapshotHash: r.snap.Hash, FileCount: r.snap.FileCount,
			Git:               r.git,
			OriginalUnchanged: !r.unverified && len(r.changed) == 0,
			ChangedPaths:      r.changed,
			ExcludedPaths:     r.snap.Excluded,
		},
		Profiles: resultset.Profiles{
			CatalogVersion: checks.CatalogVersion, ExecutionProfile: checks.ExecutionProfile,
			ToolsetVersion: toolset.Version(),
		},
		Selection: resultset.Selection{
			Only: cfg.Selection.Only, Exclude: cfg.Selection.Exclude,
			EffectiveChecks: cfg.Selection.Effective, DeselectedChecks: cfg.Selection.Deselected,
			PrerequisitesRun: append([]string{}, r.prerequisites...),
			IsStandardScope:  cfg.Selection.IsStandardScope, Fast: cfg.Selection.Fast,
		},
		Summary:            resultset.Summary{NetworkIsolation: resultset.IsolationNotProbed},
		Benchmark:          resultset.Benchmark{Status: resultset.BenchmarkNotRequested},
		ReportCompleteness: resultset.ReportCompleteness{AllFindingsIncluded: true},
	}
	if cfg.DockerInfo != nil {
		s.Run.Docker = resultset.DockerInfo{
			ServerVersion: cfg.DockerInfo.ServerVersion, APIVersion: cfg.DockerInfo.APIVersion,
			CPUs: cfg.DockerInfo.CPUs, MemoryBytes: cfg.DockerInfo.MemoryBytes,
		}
	}
	if r.isolation != "" {
		s.Summary.NetworkIsolation = r.isolation
	}
	if r.cancelled || ctx.Err() != nil {
		s.Run.Status = resultset.RunCancelled
	}
	for _, c := range r.proj.Contexts {
		s.Contexts = append(s.Contexts, c.Context)
	}
	s.Run.RegistryDataDate = registryDataDate(r.results)
	s.Selection.PrerequisitesRun = r.prerequisitesRun()
	s.Limitations = append(s.Limitations, r.snapLimits...)
	s.Limitations = append(s.Limitations, r.limitations...)
	for _, res := range r.results {
		s.Checks = append(s.Checks, res.exec)
		s.Findings = append(s.Findings, res.findings...)
		s.Metrics = append(s.Metrics, res.metrics...)
		s.Limitations = append(s.Limitations, res.limitations...)
		s.Artifacts = append(s.Artifacts, res.artifacts...)
		s.TestCases = append(s.TestCases, res.testCases...)
		if inv := res.inventory; inv != nil {
			s.Inventory.Suppressions = append(s.Inventory.Suppressions, inv.Suppressions...)
			s.Inventory.FileHashes = append(s.Inventory.FileHashes, inv.FileHashes...)
			s.Inventory.Size = append(s.Inventory.Size, inv.Size...)
			s.Inventory.Tests = append(s.Inventory.Tests, inv.Tests...)
			s.Inventory.TestSuites = append(s.Inventory.TestSuites, inv.TestSuites...)
			s.Inventory.TestFiles = append(s.Inventory.TestFiles, inv.TestFiles...)
			s.Inventory.MovedTestFiles = append(s.Inventory.MovedTestFiles, inv.MovedTestFiles...)
		}
	}
	markTestCode(r.proj, r.probedTestFiles(), s.Findings)
	var serviceLimits []resultset.Limitation
	s.Services, serviceLimits = r.reportServices()
	s.Limitations = append(s.Limitations, serviceLimits...)
	recordContextTools(s.Contexts, r.results)
	r.redactSet(s)
	return s
}
