//go:build docker

package docker_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// plant creates a resource of kind ("volume", "network" or "container") with
// the js-prueffactory labels of a pretend Run. It is removed again when the test
// ends, whatever the sweep did.
func plant(t *testing.T, kind, image, runID, host string, pid int, deadline time.Time) string {
	t.Helper()
	name := "jspf-" + runID + "-planted"
	labels := []string{
		"--label", "js-prueffactory.run-id=" + runID,
		"--label", "js-prueffactory.host=" + host,
		"--label", fmt.Sprintf("js-prueffactory.pid=%d", pid),
		"--label", "js-prueffactory.deadline=" + deadline.UTC().Format(time.RFC3339),
	}
	var args []string
	switch kind {
	case "container":
		args = append([]string{"create", "--name", name}, labels...)
		args = append(args, image, "true")
	default:
		args = append([]string{kind, "create"}, labels...)
		args = append(args, name)
	}
	if out, err := exec.Command("docker", args...).CombinedOutput(); err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	t.Cleanup(func() {
		switch kind {
		case "container":
			_ = exec.Command("docker", "rm", "-f", "-v", name).Run()
		default:
			_ = exec.Command("docker", kind, "rm", name).Run()
		}
	})
	return name
}

func exists(t *testing.T, kind, name string) bool {
	t.Helper()
	args := []string{kind, "inspect", name}
	if kind == "container" {
		args = []string{"inspect", "--type", "container", name}
	}
	return exec.Command("docker", args...).Run() == nil
}

func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func TestSweepRemovesLeftoversOfDeadRunsAndSparesLiveOnes(t *testing.T) {
	// Other agents and CI jobs may run Docker tests on this daemon at the same
	// time, so every run ID here is unique.
	nonce := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	d, image := realDriver(t, "sweepme")
	host, _ := os.Hostname()
	now := time.Now()
	dead := deadPID(t)
	me := os.Getpid()

	type planted struct {
		kind, name string
		wantGone   bool
		why        string
	}
	var all []planted
	add := func(kind, id, host string, pid int, deadline time.Time, wantGone bool, why string) {
		all = append(all, planted{kind, plant(t, kind, image, id, host, pid, deadline), wantGone, why})
	}
	for _, kind := range []string{"volume", "network", "container"} {
		k := kind[:1]
		add(kind, "20250101T000000Z-expired-"+nonce+k, "some-other-host", me, now.Add(-time.Minute), true, "past its deadline, even though its process runs")
		add(kind, "20250101T000000Z-deadpid-"+nonce+k, host, dead, now.Add(time.Hour), true, "from this host, process gone")
		add(kind, "20250101T000000Z-alive-"+nonce+k, host, me, now.Add(time.Hour), false, "live deadline and a running process")
		add(kind, "20250101T000000Z-elsewhere-"+nonce+k, "some-other-host", dead, now.Add(time.Hour), false, "another host, so its process cannot be judged")
	}
	// A cache volume has a cache label and no run label: never touched.
	cache := "jspf-cache-sweeptest-" + fmt.Sprint(now.UnixNano())
	if out, err := exec.Command("docker", "volume", "create", "--label", "js-prueffactory.cache=npm", cache).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "volume", "rm", cache).Run() })
	// That the sweep spares the resources of its own Run is covered with a fake
	// CLI (TestTheSweepSparesTheResourcesOfItsOwnRun): on a shared daemon any
	// concurrent Run's sweep may legitimately remove an abandoned-looking one.

	if _, err := d.SweepLeftovers(context.Background(), now, host, nil); err != nil {
		t.Fatal(err)
	}

	for _, p := range all {
		if got := !exists(t, p.kind, p.name); got != p.wantGone {
			t.Errorf("%s %s: removed = %v, want %v (%s)", p.kind, p.name, got, p.wantGone, p.why)
		}
	}
	if !exists(t, "volume", cache) {
		t.Error("the cache volume was removed")
	}
}
