// Package engine performs a Run: it takes the Snapshot, discovers the project,
// plans the Check executions, prepares Docker, runs the Checks, proves the
// Original is unchanged, cleans up and writes the Report.
//
// The work is split over files by phase, so tickets that change one phase touch
// one file: source.go (Snapshot and the final re-hash), plan.go (Selection and
// the list of executions), docker.go (Preparation phase and cleanup),
// schedule.go (running the executions), assemble.go (building the result set).
package engine

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/invia-flights/jscript-bench/internal/benchmark"
	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/gitstate"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/redact"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/snapshot"
	"github.com/invia-flights/jscript-bench/internal/writer"
)

// Config is everything a Run needs. The front end validates it first.
type Config struct {
	Command string // "test" or "benchmark"

	// Original is the absolute, symlink-resolved project folder.
	Original string
	// ReportDir is the absolute folder the Report goes into.
	ReportDir string
	// ExcludeFromSnapshot is an explicit report folder inside the Original.
	ExcludeFromSnapshot string
	Formats             writer.Formats

	RunID        string
	Start        time.Time
	Budget       time.Duration
	BudgetSource string // "default", "flag" or "ci_job_timeout"

	// Selection says which Checks are selected. Nil means every implemented Check.
	Selection *checks.Selection

	// TempDir holds the host-side copy of the Snapshot for the length of the Run.
	TempDir string

	// CacheDir is the host folder of js-prueffactory's caches, such as
	// ~/.cache/js-prueffactory. It holds the lock that protects the shared
	// Docker cache volumes.
	CacheDir string

	// Docker creates resources owned by this Run. DockerInfo is the daemon's
	// answer to the preflight.
	Docker     *docker.Driver
	DockerInfo *docker.Info

	// Git reads the git state of the Original. The zero value stands for a host
	// without a git binary.
	Git gitstate.Reader

	Log *progress.Logger

	// HardStop, when it closes, is the second interrupt: the Run skips the
	// Report, cleans up at once and returns ErrAborted. May be nil.
	HardStop <-chan struct{}
}

// ErrAborted is returned when HardStop closed. No Report was written.
var ErrAborted = errors.New("the Run was stopped by a second interrupt; no Report was written")

// hardStopGrace is how long a hard-stopped Run waits for its own goroutine to
// notice the cancellation before it cleans up a last time.
const hardStopGrace = 10 * time.Second

// Result is the outcome of a Run that produced a Report.
type Result struct {
	ExitCode  int
	ReportDir string
}

// Run performs the Run. A non-nil error means no valid Report was written and
// the caller exits with 3.
func Run(ctx context.Context, cfg Config) (*Result, error) {
	r := &run{cfg: cfg, log: cfg.Log, started: cfg.Start, redactor: redact.New()}
	if cfg.HardStop == nil {
		return r.perform(ctx)
	}

	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type outcome struct {
		res *Result
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := r.perform(wctx)
		done <- outcome{res, err}
	}()
	select {
	case o := <-done:
		return o.res, o.err
	case <-cfg.HardStop:
		r.log.Printf("second interrupt: skipping the Report and cleaning up")
		r.abort()
		cancel()
		r.cleanupNow()
		// The Run's goroutine may still create or hold something until it sees
		// the cancellation, so wait for it briefly and clean up once more.
		select {
		case <-done:
		case <-time.After(hardStopGrace):
		}
		r.cleanupNow()
		return nil, ErrAborted
	}
}

// perform is the Run itself, without the hard-stop watch.
func (r *run) perform(ctx context.Context) (*Result, error) {
	cfg := r.cfg
	r.log.Printf("run %s started on %s", cfg.RunID, cfg.Original)

	// Whatever happens below, nothing of this Run stays behind. cleanup is
	// idempotent, and the normal path calls it before the Report is written.
	defer r.cleanup()

	if err := r.takeSnapshot(ctx); err != nil {
		return nil, err
	}
	proj, err := discovery.Discover(r.snap.Dir)
	if err != nil {
		return nil, err
	}
	r.proj = proj
	// Known before any container runs, so that Checks can redact what a Service
	// logs before they put it in a reason.
	r.collectServiceSecrets()
	r.log.Printf("discovered %d package(s) and %d file(s)", len(proj.Packages), len(proj.Files))

	if r.cfg.Selection == nil {
		sel, err := checks.ResolveCatalog(nil, nil)
		if err != nil {
			return nil, err
		}
		r.cfg.Selection = sel
	}
	r.planned = plan(proj, r.cfg.Selection)
	r.shared = checks.NewShared()
	r.executeAll(ctx)
	r.collectNpmrcSecrets()
	r.verifyOriginal()
	r.cleanup()

	set := r.assemble(ctx)
	set.Finalize()
	if cfg.Command == "benchmark" {
		// The score reads the finished Report and changes nothing in it but the
		// benchmark section. The exit code stays what the Checks decided.
		benchmark.Apply(set)
	}
	if err := r.writeReport(set); err != nil {
		return nil, err
	}
	r.log.Printf("report written to %s", cfg.ReportDir)
	return &Result{ExitCode: set.Run.ExitCode, ReportDir: cfg.ReportDir}, nil
}

// run holds the state of one Run.
type run struct {
	cfg     Config
	log     *progress.Logger
	started time.Time

	snap       *snapshot.Snapshot
	git        *resultset.GitState // nil without .git or when it cannot be read
	tmpDir     string
	snapLimits []resultset.Limitation
	changed    []string // paths of the Original that changed during the Run
	unverified bool     // the final re-hash itself failed

	proj    *discovery.Project
	planned []*planned
	// shared holds results that Checks of the Run share, such as the combined
	// ESLint run.
	shared *checks.Shared

	// Docker state of the Execution phase.
	volume      string
	network     string
	dockerReady bool
	// workVolume holds the Working copy, when a Check uses it.
	workVolume string
	// isolation is the answer of the network isolation probe, or "" while the
	// probe has not run.
	isolation string

	// finished remembers how executions ended, for those that wait for them.
	finMu    sync.Mutex
	finished map[*planned]*execResult

	// Toolset volume (ticket 14): the volume with the pinned npm tools, or the
	// reason it is not available.
	toolsetVolume string
	toolsetErr    string

	// advisory is the offline advisory database (ticket 26).
	advisory advisoryDB

	// kubernetesSchemas is the volume with the Kubernetes schemas, or the reason
	// it is not available.
	kubernetesSchemas kubernetesSchemas

	results []*execResult
	// redactor holds the secret values found in the Run. They live in memory
	// only. scan records how the secret scan went, and prerequisites lists the
	// Checks that ran without being selected.
	redactor      *redact.Redactor
	redactMu      sync.Mutex // guards redactor while Checks use it through redactText
	scan          secretScan
	envLeft       []string // names of .env and Service env variables whose values redact.EnvRule left readable
	prerequisites []string
	// limitations collects Run-level Limitations next to those of Checks.
	limitations []resultset.Limitation
	cancelled   bool

	// mu guards cleaned and aborted, and serializes the decision to write the
	// Report with a hard stop.
	mu      sync.Mutex
	cleanMu sync.Mutex // one removal at a time
	cleaned bool
	aborted bool
}

// abort records the hard stop, after which no Report is written.
func (r *run) abort() {
	r.mu.Lock()
	r.aborted = true
	r.mu.Unlock()
}

// writeReport writes the Report unless the Run was hard-stopped.
func (r *run) writeReport(set *resultset.Set) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.aborted {
		return ErrAborted
	}
	err := writer.Write(r.cfg.ReportDir, set, r.cfg.Formats)
	var invalid *writer.InvalidReportError
	if errors.As(err, &invalid) {
		r.explainInvalid(invalid)
	}
	return err
}

// cleanup removes every Docker resource of the Run and the host-side copy. It
// may be called more than once; only the first call does anything.
func (r *run) cleanup() {
	r.mu.Lock()
	done := r.cleaned
	r.cleaned = true
	r.mu.Unlock()
	if done {
		return
	}
	r.cleanupNow()
}

// cleanupNow does the removal whether or not cleanup ran before. Removing what
// is already gone is harmless, which makes it the tool of the hard stop.
func (r *run) cleanupNow() {
	r.cleanMu.Lock()
	defer r.cleanMu.Unlock()
	if r.cfg.Docker != nil {
		if err := r.cfg.Docker.RemoveRunResources(context.Background()); err != nil {
			r.log.Printf("warning: could not remove every Docker resource of this Run: %v", err)
		}
	}
	// The Snapshot copy lives inside tmpDir.
	r.mu.Lock()
	dir := r.tmpDir
	r.mu.Unlock()
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
}

// setTmpDir records the host-side folder of the Run for cleanup.
func (r *run) setTmpDir(dir string) {
	r.mu.Lock()
	r.tmpDir = dir
	r.mu.Unlock()
}
