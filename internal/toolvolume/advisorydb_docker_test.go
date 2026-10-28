//go:build docker

package toolvolume_test

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// These tests fill a real advisory database volume. Every test uses its own
// cache kind, so it never touches the volume of a real Run, and removes it.

func advisoryConfig(t *testing.T, base *docker.Driver, cache, kind string, now time.Time) toolvolume.AdvisoryConfig {
	t.Helper()
	ctx := context.Background()
	for _, img := range []string{toolset.OSVScanner.Image.Ref(), toolset.Alpine.Ref()} {
		if err := base.Pull(ctx, img); err != nil {
			t.Fatal(err)
		}
	}
	return toolvolume.AdvisoryConfig{
		Docker: newScope(t, base), CacheDir: cache, Kind: kind,
		Scanner: toolset.OSVScanner.Image.Ref(), Helper: toolset.Alpine.Ref(),
		Now: func() time.Time { return now },
	}
}

func TestTheAdvisoryDatabaseIsDownloadedOnceAndRefreshedAfterADay(t *testing.T) {
	base, _ := scoped(t)
	ctx := context.Background()
	cache := t.TempDir()
	kind := fmt.Sprintf("t26x%x", rand.Int63())
	t.Cleanup(func() { removeVolume("jspf-cache-" + kind) })
	start := time.Date(2026, 10, 26, 9, 0, 0, 0, time.UTC)

	first, err := toolvolume.EnsureAdvisoryDB(ctx, advisoryConfig(t, base, cache, kind, start))
	if err != nil {
		t.Fatal(err)
	}
	if !first.Refreshed || first.Name != "jspf-cache-"+kind || !first.Date.Equal(start) {
		t.Fatalf("first = %+v, want a download dated %v into jspf-cache-%s", first, start, kind)
	}
	labels, err := base.VolumeLabel(ctx, first.Name, docker.LabelCache)
	if err != nil || labels != kind {
		t.Errorf("cache label = %q, %v, want %q: the volume must survive the Run", labels, err, kind)
	}
	// The database is where the scan will look for it.
	check, err := newScope(t, base).RunContainer(ctx, docker.ContainerSpec{
		Name: "probe", Image: toolset.Alpine.Ref(), Network: "none",
		Mounts: []docker.Mount{{Volume: first.Name, Path: toolvolume.AdvisoryMountPath, ReadOnly: true}},
		Cmd:    []string{"sh", "-c", "find " + toolvolume.AdvisoryCacheDir + " -name all.zip -size +1000k | grep -c ."},
	})
	if err != nil || check.ExitCode != 0 {
		t.Fatalf("no database file below %s: %+v, %v", toolvolume.AdvisoryCacheDir, check, err)
	}

	// Within a day the next Run reuses it and records the same date.
	second, err := toolvolume.EnsureAdvisoryDB(ctx, advisoryConfig(t, base, cache, kind, start.Add(23*time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	if second.Refreshed || !second.Date.Equal(start) || second.Warning != "" {
		t.Fatalf("second = %+v, want a reuse of the database dated %v", second, start)
	}

	// A refresh that cannot download keeps the old database and says so.
	offline := advisoryConfig(t, base, cache, kind, start.Add(25*time.Hour))
	offline.Scanner = "ghcr.io/google/osv-scanner@sha256:" + strings.Repeat("0", 64)
	third, err := toolvolume.EnsureAdvisoryDB(ctx, offline)
	if err != nil {
		t.Fatalf("a failed refresh must fall back to the old database: %v", err)
	}
	if third.Refreshed || !third.Date.Equal(start) || third.Warning == "" {
		t.Fatalf("third = %+v, want the old database with a warning", third)
	}

	// After a day it downloads again and the date moves.
	later := start.Add(26 * time.Hour)
	fourth, err := toolvolume.EnsureAdvisoryDB(ctx, advisoryConfig(t, base, cache, kind, later))
	if err != nil {
		t.Fatal(err)
	}
	if !fourth.Refreshed || !fourth.Date.Equal(later) || fourth.Warning != "" {
		t.Fatalf("fourth = %+v, want a refresh dated %v", fourth, later)
	}
}

func TestWithoutADatabaseAFailedDownloadIsAnError(t *testing.T) {
	base, _ := scoped(t)
	cache := t.TempDir()
	kind := fmt.Sprintf("t26x%x", rand.Int63())
	t.Cleanup(func() { removeVolume("jspf-cache-" + kind) })
	cfg := advisoryConfig(t, base, cache, kind, time.Now())
	cfg.Scanner = "ghcr.io/google/osv-scanner@sha256:" + strings.Repeat("0", 64)
	if db, err := toolvolume.EnsureAdvisoryDB(context.Background(), cfg); err == nil {
		t.Fatalf("EnsureAdvisoryDB = %+v, want an error: there is no database to fall back to", db)
	}
}
