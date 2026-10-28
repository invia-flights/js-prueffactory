package toolvolume

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

// The advisory database is osv-scanner's offline copy of the npm advisories.
// It lives in a cache volume of its own, is filled in the Preparation phase
// under a host-side lock, and is refreshed when it is older than a day. Every
// Run that scans dependencies records its date.

const (
	// AdvisoryMountPath is where the advisory database volume is mounted.
	AdvisoryMountPath = "/osv-db"
	// AdvisoryCacheDir is the folder inside the volume that holds a complete
	// database. Point osv-scanner's OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY at it.
	AdvisoryCacheDir = AdvisoryMountPath + "/current"
	// AdvisoryMaxAge is how old the database may get before the Preparation
	// phase downloads it again.
	AdvisoryMaxAge = 24 * time.Hour

	// advisoryKind is the cache kind of the volume, jspf-cache-osv-db.
	advisoryKind = "osv-db"
	// advisoryDateFile holds the date of the database. It is written as the
	// last step of a refresh, so a database with a date is complete.
	advisoryDateFile = AdvisoryMountPath + "/updated-at"
	// advisoryTimeout is the time limit of one download.
	advisoryTimeout = 15 * time.Minute
)

// AdvisoryConfig says what EnsureAdvisoryDB works on.
type AdvisoryConfig struct {
	// Docker is the Run's driver. The containers belong to the Run; the volume
	// does not.
	Docker *docker.Driver
	// CacheDir is the host folder of js-prueffactory's cache. The lock file
	// lives there.
	CacheDir string
	// Scanner is the pinned osv-scanner image (repository@digest) that
	// downloads the database, and Helper the pinned Alpine image that moves it
	// into place.
	Scanner, Helper string
	// Kind is the cache kind of the volume; the default is osv-db. Tests use
	// their own, so they never touch the volume of a real Run.
	Kind string
	// Now is the clock; the default is time.Now.
	Now func() time.Time
	// Logf receives progress lines. It may be nil.
	Logf func(format string, args ...any)
}

// AdvisoryDB is the advisory database a Run scans with.
type AdvisoryDB struct {
	// Name is the volume. Mount it read-only at AdvisoryMountPath.
	Name string
	// Date is when the database was downloaded.
	Date time.Time
	// Refreshed is true when this call downloaded the database, false when it
	// reused the one an earlier Run had downloaded.
	Refreshed bool
	// Warning is set when the database is older than AdvisoryMaxAge because the
	// refresh failed. The old database is used; the Report says how old it is.
	Warning string
}

func formatDBDate(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// parseDBDate reads the content of the date file.
func parseDBDate(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	return t, err == nil
}

// needsRefresh says whether a database of the given date is too old at time
// now. A missing date and a date in the future (a clock that went back) count
// as too old.
func needsRefresh(date, now time.Time) bool {
	if date.IsZero() || date.After(now) {
		return true
	}
	return now.Sub(date) > AdvisoryMaxAge
}

// EnsureAdvisoryDB returns the advisory database volume, downloading the
// database first when there is none or when it is older than 24 hours. It works
// under a host-side lock, so Runs that start at the same time never download
// it twice. A failed refresh keeps the old database and sets Warning; without
// an old database it is an error.
func EnsureAdvisoryDB(ctx context.Context, cfg AdvisoryConfig) (*AdvisoryDB, error) {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	now := time.Now
	if cfg.Now != nil {
		now = cfg.Now
	}
	kind := cfg.Kind
	if kind == "" {
		kind = advisoryKind
	}

	logf("waiting for the advisory database lock in %s", cfg.CacheDir)
	l, err := acquire(ctx, filepath.Join(cfg.CacheDir, "advisorydb.lock"))
	if err != nil {
		return nil, fmt.Errorf("advisory database lock: %w", err)
	}
	defer l.release()

	d := cfg.Docker
	name, err := d.CacheVolume(ctx, kind)
	if err != nil {
		return nil, err
	}
	date, have, err := readAdvisoryDate(ctx, cfg, name)
	if err != nil {
		return nil, err
	}
	at := now().UTC().Truncate(time.Second)
	if have && !needsRefresh(date, at) {
		logf("reusing the advisory database of %s", formatDBDate(date))
		return &AdvisoryDB{Name: name, Date: date}, nil
	}

	logf("downloading the advisory database into volume %s", name)
	if err := refreshAdvisoryDB(ctx, cfg, name, at); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !have {
			return nil, fmt.Errorf("the advisory database could not be downloaded: %w", err)
		}
		logf("warning: the advisory database could not be refreshed, using the one of %s: %v", formatDBDate(date), err)
		return &AdvisoryDB{Name: name, Date: date, Warning: fmt.Sprintf("the refresh failed: %v", err)}, nil
	}
	logf("downloaded the advisory database")
	return &AdvisoryDB{Name: name, Date: at, Refreshed: true}, nil
}

// readAdvisoryDate returns the date of the database in the volume, and whether
// there is a complete one.
func readAdvisoryDate(ctx context.Context, cfg AdvisoryConfig, volume string) (time.Time, bool, error) {
	res, err := cfg.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "advisorydb-probe", Image: cfg.Helper, Network: "none",
		Mounts: []docker.Mount{{Volume: volume, Path: AdvisoryMountPath, ReadOnly: true}},
		Cmd:    []string{"sh", "-c", "test -d " + AdvisoryCacheDir + " && cat " + advisoryDateFile},
	})
	if err != nil {
		return time.Time{}, false, fmt.Errorf("cannot inspect the advisory database volume: %w", err)
	}
	if res.ExitCode != 0 {
		return time.Time{}, false, nil
	}
	date, ok := parseDBDate(string(res.Stdout))
	return date, ok, nil
}

// seedLockfile is a lockfile with one package of the public npm registry.
// osv-scanner downloads the database of every ecosystem it finds in what it
// scans, so scanning this file is what fetches the npm database.
const seedLockfile = `{
  "name": "seed", "version": "1.0.0", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "seed", "version": "1.0.0", "dependencies": {"left-pad": "1.3.0"}},
    "node_modules/left-pad": {"version": "1.3.0", "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"}
  }
}
`

// refreshAdvisoryDB downloads the database next to the current one and swaps
// it in, so a download that dies half way never leaves a broken database.
func refreshAdvisoryDB(ctx context.Context, cfg AdvisoryConfig, volume string, date time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, advisoryTimeout)
	defer cancel()
	d := cfg.Docker
	mount := []docker.Mount{{Volume: volume, Path: AdvisoryMountPath}}
	helper := func(name, script string) (*docker.ContainerResult, error) {
		return d.RunContainer(ctx, docker.ContainerSpec{
			Name: name, Image: cfg.Helper, Network: "none", Mounts: mount,
			Env: map[string]string{"JSPF_DB_DATE": formatDBDate(date)},
			Cmd: []string{"sh", "-c", script},
		})
	}
	failed := func(step string, res *docker.ContainerResult, err error) error {
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			return fmt.Errorf("the download took longer than %s", advisoryTimeout)
		case err != nil:
			return fmt.Errorf("%s: %w", step, err)
		}
		return fmt.Errorf("%s failed (exit %d): %s", step, res.ExitCode, lastLines(string(res.Stderr), 3))
	}

	staging := AdvisoryMountPath + "/staging"
	if res, err := helper("advisorydb-clear", "rm -rf "+staging+" && mkdir -p "+staging); err != nil || res.ExitCode != 0 {
		return failed("preparing the download folder", res, err)
	}

	// The default bridge network: the Preparation phase has outbound access
	// (ADR-0004), and this download is the only reason this container exists.
	// The project's own osv-scanner.toml is never read here: the seed brings an
	// empty one.
	res, err := d.RunContainer(ctx, docker.ContainerSpec{
		Name: "advisorydb-download", Image: cfg.Scanner, Preparation: true, Mounts: mount,
		Env: map[string]string{"OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY": staging},
		Files: []docker.File{
			{Path: "/seed/package-lock.json", Mode: 0o644, Content: []byte(seedLockfile)},
			{Path: "/seed/osv-scanner.toml", Mode: 0o644, Content: nil},
		},
		Cmd: []string{
			"scan", "--offline-vulnerabilities", "--download-offline-databases",
			"--verbosity", "error", "--format", "json", "--config", "/seed/osv-scanner.toml",
			"-L", "package-lock.json:/seed/package-lock.json",
		},
	})
	// osv-scanner exits with 1 when it finds vulnerabilities in what it scanned.
	if err != nil || (res.ExitCode != 0 && res.ExitCode != 1) {
		return failed("the osv-scanner download", res, err)
	}

	swap := `set -e
test -n "$(find ` + staging + ` -name all.zip -size +100k | head -n 1)"
rm -rf ` + AdvisoryMountPath + `/previous
if [ -d ` + AdvisoryCacheDir + ` ]; then mv ` + AdvisoryCacheDir + ` ` + AdvisoryMountPath + `/previous; fi
mv ` + staging + ` ` + AdvisoryCacheDir + `
printf %s "$JSPF_DB_DATE" > ` + advisoryDateFile + `.tmp
mv ` + advisoryDateFile + `.tmp ` + advisoryDateFile + `
rm -rf ` + AdvisoryMountPath + `/previous`
	if res, err := helper("advisorydb-swap", swap); err != nil || res.ExitCode != 0 {
		return failed("moving the download into place (is the database file there?)", res, err)
	}
	return nil
}
