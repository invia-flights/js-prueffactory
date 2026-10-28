// Package cli is the command front end and test seam A: one in-process entry
// point that takes the arguments, an environment lookup, stdout, stderr and a
// cancellation context, and returns the exit code. `main` only wires the real
// process into it.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/engine"
	"github.com/invia-flights/jscript-bench/internal/gitstate"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/runid"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

const usage = `usage:
  js-prueffactory test <path> [--format json|markdown|json,markdown] [--output-dir <dir>]
                              [--budget <duration>] [--fast]
                              [--only <checks>] [--exclude <checks>]
  js-prueffactory benchmark <path> [the same flags as test]
  js-prueffactory list-checks <path> [--format markdown|json] [--fast] [--only <checks>] [--exclude <checks>]

Checks the JavaScript project in <path> without modifying it and writes
report.json and report.md into a new report folder. The folder is printed as
the only line on stdout; progress goes to stderr. benchmark runs the same Checks
and adds a 0 to 100 score, labelled uncalibrated, and a Verdict; the Verdict
never changes the exit code.

--only and --exclude take comma-separated Check IDs or families (the part of an
ID before the first dot) and may repeat. list-checks shows the Catalog and what
applies to <path> without Docker and without writing files.

The default Budget is 2 hours. --fast skips the slow Checks (list-checks shows
which) and makes the default Budget 30 minutes; an explicit --budget always wins.

exit codes: 0 all selected applicable Checks completed, no Gate fired;
1 a Gate fired; 2 no Gate fired but a Check did not complete; 3 usage error,
Docker unreachable or internal error; 130 interrupted.
`

// Main runs js-prueffactory and returns the exit code. args do not include the
// program name.
func Main(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, "js-prueffactory: no command given\n"+usage)
		return resultset.ExitInternalError
	}
	command := args[0]
	switch command {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, usage)
		return resultset.ExitOK
	case "test", "benchmark":
		// benchmark runs exactly the Checks test runs, with the same flags and
		// the same exit codes, and adds the score to the Report.
		return runTest(ctx, command, args[1:], getenv, stdout, stderr)
	case "list-checks":
		return runListChecksCommand(command, args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "js-prueffactory: unknown command %q\n%s", command, usage)
		return resultset.ExitInternalError
	}
}

func runTest(ctx context.Context, command string, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		fmt.Fprintf(stderr, "js-prueffactory: %v\n", err)
		return resultset.ExitInternalError
	}

	opts, err := parse(command, args)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprint(stdout, usage)
		return resultset.ExitOK
	}
	if err != nil {
		return fail(err)
	}

	log := progress.New(stderr, nil)
	budget, budgetSource, err := resolveBudget(opts.BudgetFlag, opts.Fast, getenv, func(msg string) { log.Printf("%s", msg) })
	if err != nil {
		return fail(err)
	}
	log.Printf("budget %s (%s)", budget, budgetSource)

	original, err := resolveOriginal(opts.Path)
	if err != nil {
		return fail(err)
	}
	start := time.Now()
	id := runid.New(start, filepath.Base(original), runid.RandomSuffix)
	out, err := resolveOutput(opts.OutputDir, original, id, getenv)
	if err != nil {
		return fail(err)
	}

	// From here on Docker is needed. Check it before any file is copied.
	exe, err := docker.Locate(getenv)
	if err != nil {
		return fail(err)
	}
	base := docker.New(exe, docker.Env(getenv))
	info, err := base.Preflight(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return interrupted(stderr)
		}
		return fail(err)
	}

	host, _ := os.Hostname()
	scope := docker.Scope{RunID: id, Host: host, PID: os.Getpid(), Deadline: start.Add(budget + 10*time.Minute)}
	scoped := base.WithScope(scope)
	sweepLeftovers(ctx, scoped, host, log)
	if ctx.Err() != nil {
		return interrupted(stderr)
	}
	// Toolset volumes of other toolset versions go at the start of every Run.
	toolvolume.CleanOtherVersions(ctx, toolvolume.Config{Docker: scoped, CacheDir: cacheDir(getenv), Logf: log.Printf})
	tmp := getenv("TMPDIR")
	if tmp == "" {
		tmp = os.TempDir()
	}

	res, err := engine.Run(ctx, engine.Config{
		Command:  command,
		Original: original, ReportDir: out.Dir, ExcludeFromSnapshot: out.ExcludeFromSnapshot,
		Formats: opts.Formats, Selection: opts.Selection,
		RunID: id, Start: start, Budget: budget, BudgetSource: budgetSource,
		TempDir: tmp,
		Git:     gitstate.FromEnv(getenv),
		Docker:  scoped, DockerInfo: info,
		Log:      log,
		HardStop: hardStop(ctx),

		CacheDir: cacheDir(getenv),
	})
	if errors.Is(err, engine.ErrAborted) {
		return interrupted(stderr)
	}
	if err != nil {
		fmt.Fprintf(stderr, "js-prueffactory: %v\n", err)
		return resultset.ExitInternalError
	}
	fmt.Fprintln(stdout, res.ReportDir)
	return res.ExitCode
}

// runListChecksCommand parses the arguments of list-checks and prints the listing.
func runListChecksCommand(command string, args []string, stdout, stderr io.Writer) int {
	opts, err := parse(command, args)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprint(stdout, usage)
		return resultset.ExitOK
	}
	if err != nil {
		fmt.Fprintf(stderr, "js-prueffactory: %v\n", err)
		return resultset.ExitInternalError
	}
	return runListChecks(opts, stdout, stderr)
}

// interrupted is the exit path of a Run that was cancelled before it had a
// Report to write, or that was stopped by a second interrupt.
func interrupted(stderr io.Writer) int {
	fmt.Fprintln(stderr, "js-prueffactory: interrupted")
	return resultset.ExitInterrupted
}

// sweepLeftovers removes what dead Runs left in Docker. It never fails the Run:
// a sweep that cannot finish only warns.
func sweepLeftovers(ctx context.Context, d *docker.Driver, host string, log *progress.Logger) {
	removed, err := d.SweepLeftovers(ctx, time.Now(), host, nil)
	if len(removed) > 0 {
		log.Printf("removed %d leftover Docker resource(s) of dead Runs", len(removed))
	}
	if err != nil && ctx.Err() == nil {
		log.Printf("warning: could not sweep every leftover of dead Runs: %v", err)
	}
}
