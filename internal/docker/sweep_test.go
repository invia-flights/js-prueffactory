package docker_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

// The sweep must never remove what belongs to the Run that sweeps, even when
// its labels say it is abandoned. This is tested against a fake docker CLI that
// lists one abandoned resource of this Run and one of another Run per kind, so
// no other process sharing a real daemon can interfere.
func TestTheSweepSparesTheResourcesOfItsOwnRun(t *testing.T) {
	log := filepath.Join(t.TempDir(), "calls")
	listing := func(id string) string {
		// id | run id | host | pid | deadline; the deadline is long past.
		return `echo "` + id + `-own|RUN-SELF|h|1|2020-01-01T00:00:00Z"; echo "` + id + `-other|RUN-OTHER|h|1|2020-01-01T00:00:00Z"`
	}
	dir := fakeCLI(t, `echo "$*" >> `+log+`
case "$1 $2" in
  "ps --all") `+listing("c")+` ;;
  "network ls") `+listing("n")+` ;;
  "volume ls") `+listing("v")+` ;;
esac
`)
	d := docker.New(filepath.Join(dir, "docker"), nil).WithScope(docker.Scope{
		RunID: "RUN-SELF", Host: "h", PID: 42, Deadline: time.Now().Add(time.Hour),
	})

	removed, err := d.SweepLeftovers(context.Background(), time.Now(), "h", func(int) bool { return true })
	if err != nil {
		t.Fatal(err)
	}

	want := map[string]bool{"c-other": true, "n-other": true, "v-other": true}
	if len(removed) != len(want) {
		t.Fatalf("removed = %v, want only %v", removed, want)
	}
	for _, id := range removed {
		if !want[id] {
			t.Errorf("removed %q, which is not an abandoned resource of another Run", id)
		}
	}
	for _, line := range strings.Split(callsOf(t, log), "\n") {
		if strings.Contains(line, "rm ") && strings.Contains(line, "-own") {
			t.Errorf("the sweep asked to remove a resource of its own Run: %q", line)
		}
	}
}
