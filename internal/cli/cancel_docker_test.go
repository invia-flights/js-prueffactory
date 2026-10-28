//go:build docker

package cli_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/cli"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Ticket 05: Ctrl-C, leftover cleanup and two Runs at once, through the entry
// point with a real Docker daemon.

// interruptAt returns a context that carries interrupts and a hook for
// realRunHooked that sends n interrupts the moment the first Check starts.
func interruptAt(t *testing.T, n int) (context.Context, func(line string)) {
	t.Helper()
	sigs := make(chan os.Signal, 2)
	ctx, stop := cli.WithInterrupts(context.Background(), sigs)
	t.Cleanup(stop)
	var once sync.Once
	return ctx, func(line string) {
		if strings.Contains(line, "running syntax.parse") {
			once.Do(func() {
				for i := 0; i < n; i++ {
					sigs <- os.Interrupt
				}
			})
		}
	}
}

// runIDFromProgress reads the run ID from the first progress line, so a Run
// that wrote no Report can still be checked for leftovers.
func runIDFromProgress(t *testing.T, stderr string) string {
	t.Helper()
	for _, line := range strings.Split(stderr, "\n") {
		if f := strings.Fields(line); len(f) > 3 && f[1] == "run" && f[3] == "started" {
			return f[2]
		}
	}
	t.Fatalf("no run ID in the progress output:\n%s", stderr)
	return ""
}

func TestCtrlCCancelsCleansUpAndStillWritesACancelledReport(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	before := treeFingerprint(t, original)
	ctx, hook := interruptAt(t, 1)

	r := realRunHooked(t, ctx, hook, "test", original)

	if r.code != 130 {
		t.Fatalf("exit = %d, want 130\n%s", r.code, r.stderr)
	}
	if r.reportDir == "" {
		t.Fatalf("no Report folder was printed\n%s", r.stderr)
	}
	if r.set.Run.Status != resultset.RunCancelled || r.set.Run.ExitCode != 130 {
		t.Errorf("run status = %q, exit code = %d, want cancelled and 130", r.set.Run.Status, r.set.Run.ExitCode)
	}
	cancelled := 0
	for _, c := range r.set.Checks {
		if c.Status == resultset.StatusCancelled {
			cancelled++
		}
	}
	if cancelled == 0 {
		t.Error("no Check execution is marked cancelled")
	}
	if _, err := os.Stat(filepath.Join(r.reportDir, "report.md")); err != nil {
		t.Errorf("report.md is missing: %v", err)
	}
	r.assertNothingLeft(t)
	if after := treeFingerprint(t, original); after != before {
		t.Error("the Original changed")
	}
}

func TestACancelledContextAtTheEntryPointIsTheSameAsCtrlC(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	ctx, cancel := context.WithCancel(context.Background())
	r := realRunHooked(t, ctx, func(line string) {
		if strings.Contains(line, "running syntax.parse") {
			cancel()
		}
	}, "test", original)

	if r.code != 130 || r.set.Run.Status != resultset.RunCancelled {
		t.Fatalf("exit = %d, status = %q\n%s", r.code, r.set.Run.Status, r.stderr)
	}
	r.assertNothingLeft(t)
}

func TestASecondCtrlCSkipsTheReportCleansUpAndStillExitsOneThirty(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	ctx, hook := interruptAt(t, 2)

	r := realRunHooked(t, ctx, hook, "test", original)

	if r.code != 130 {
		t.Fatalf("exit = %d, want 130\n%s", r.code, r.stderr)
	}
	if r.stdout != "" {
		t.Errorf("stdout = %q, want nothing because no Report was written", r.stdout)
	}
	id := runIDFromProgress(t, r.stderr)
	t.Cleanup(func() { forceRemoveRun(id) })
	assertNoRunResources(t, id)
	if entries, _ := os.ReadDir(r.tmp); len(entries) != 0 {
		t.Errorf("the host-side Snapshot copy was not removed: %v", entries)
	}
}

// plantVolume creates a labelled volume that pretends to belong to another Run.
func plantVolume(t *testing.T, runID, host string, pid int, deadline time.Time) string {
	t.Helper()
	name := "jspf-" + runID + "-planted"
	out, err := exec.Command("docker", "volume", "create",
		"--label", "js-prueffactory.run-id="+runID,
		"--label", "js-prueffactory.host="+host,
		"--label", fmt.Sprintf("js-prueffactory.pid=%d", pid),
		"--label", "js-prueffactory.deadline="+deadline.UTC().Format(time.RFC3339),
		name).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "volume", "rm", "-f", name).Run() })
	return name
}

func volumeExists(name string) bool {
	return exec.Command("docker", "volume", "inspect", name).Run() == nil
}

func TestTheNextRunSweepsUpWhatADeadRunLeftAndSparesLiveRuns(t *testing.T) {
	host, _ := os.Hostname()
	now := time.Now()
	nonce := strconv.FormatInt(now.UnixNano()%1e9, 36) // other Docker tests may run at the same time
	expired := plantVolume(t, "20250101T000000Z-expired-"+nonce, "elsewhere", os.Getpid(), now.Add(-time.Minute))
	orphan := plantVolume(t, "20250101T000000Z-orphan-"+nonce, host, deadPID(t), now.Add(time.Hour))
	live := plantVolume(t, "20250101T000000Z-live-"+nonce, host, os.Getpid(), now.Add(time.Hour))

	r := realRun(t, context.Background(), "test", copyProject(t, "clean-mocha"))

	if r.code != 0 {
		t.Fatalf("exit = %d\n%s", r.code, r.stderr)
	}
	if volumeExists(expired) {
		t.Error("the volume past its deadline was not removed")
	}
	if volumeExists(orphan) {
		t.Error("the volume of a dead process on this host was not removed")
	}
	if !volumeExists(live) {
		t.Error("the volume of a live Run was removed")
	}
}

func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func TestTwoRunsAtTheSameTimeBothFinishAndDoNotTouchEachOther(t *testing.T) {
	const n = 2
	runs := make([]*dockerRun, n)
	var wg sync.WaitGroup
	for i := range runs {
		original := copyProject(t, "clean-mocha")
		wg.Add(1)
		go func() {
			defer wg.Done()
			// A failed Report check inside realRun ends only this goroutine and
			// leaves runs[i] nil, which the loop below reports.
			runs[i] = realRun(t, context.Background(), "test", original)
		}()
	}
	wg.Wait()

	seen := map[string]bool{}
	for i, r := range runs {
		if r == nil {
			t.Errorf("run %d did not finish", i)
			continue
		}
		if r.code != 0 {
			t.Errorf("run %d: exit = %d\n%s", i, r.code, r.stderr)
			continue
		}
		if seen[r.set.Run.ID] {
			t.Errorf("both Runs have the run ID %s", r.set.Run.ID)
		}
		seen[r.set.Run.ID] = true
		if r.set.Run.Status != resultset.RunCompleted {
			t.Errorf("run %d: status = %q", i, r.set.Run.Status)
		}
		r.assertNothingLeft(t)
	}
}
