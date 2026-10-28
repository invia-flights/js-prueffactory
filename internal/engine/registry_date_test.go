package engine

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

// fetchedAt is a Check that read registry data fetched at a given time.
type fetchedAt struct{ at time.Time }

func (fetchedAt) Applicability(*discovery.Project, *discovery.Context) (resultset.Applicability, string) {
	return resultset.Applicable, ""
}

func (f fetchedAt) Run(context.Context, *checks.Input) *checks.Result {
	return &checks.Result{Status: resultset.StatusCompleted, RegistryDataDate: f.at}
}

func executeFetchedAt(t *testing.T, r *run, at time.Time) *execResult {
	t.Helper()
	p := &planned{
		key: "x1", entry: checks.Entry{ID: "deps.deprecated", Family: "deps"}, check: fetchedAt{at},
		context:       &discovery.Context{Context: resultset.Context{ID: "C-0002"}},
		applicability: resultset.Applicable,
	}
	return r.execute(context.Background(), context.Background(), p, false)
}

func TestTheRunRecordsTheOldestRegistryFetchAsItsRegistryDataDate(t *testing.T) {
	r := &run{log: progress.New(io.Discard, nil), snap: &snapshot.Snapshot{Dir: t.TempDir()}, proj: &discovery.Project{}}
	old := time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)
	newer := old.Add(time.Hour)

	results := []*execResult{executeFetchedAt(t, r, newer), executeFetchedAt(t, r, old), executeFetchedAt(t, r, time.Time{})}

	got := registryDataDate(results)
	if got == nil || *got != "2026-10-27T09:00:00Z" {
		t.Errorf("registry data date = %v, want the oldest fetch, 2026-10-27T09:00:00Z", got)
	}
}

func TestTheChecksThatRunTheRegistryDataStepHaveFiveMinutes(t *testing.T) {
	for _, id := range []string{"deps.deprecated", "deps.outdated"} {
		if got := timeLimit(id); got != 5*time.Minute {
			t.Errorf("timeLimit(%s) = %s, want 5m0s", id, got)
		}
	}
}

func TestARunWithoutAnyRegistryFetchHasNoRegistryDataDate(t *testing.T) {
	r := &run{log: progress.New(io.Discard, nil), snap: &snapshot.Snapshot{Dir: t.TempDir()}, proj: &discovery.Project{}}

	if got := registryDataDate([]*execResult{executeFetchedAt(t, r, time.Time{})}); got != nil {
		t.Errorf("registry data date = %v, want none", *got)
	}
}
