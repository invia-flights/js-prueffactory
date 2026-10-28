package toolvolume

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

// fakeDocker answers `volume ls` with the given toolset volumes and records
// every other call in the returned log. `volume rm` of a name that contains
// "busy" fails the way Docker fails for a volume a container uses.
func fakeDocker(t *testing.T, volumes ...string) (*docker.Driver, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := "#!/bin/sh\n" +
		"case \"$1 $2\" in\n" +
		"  \"volume ls\") printf '%s\\n' " + strings.Join(quoted(volumes), " ") + " ;;\n" +
		"  \"volume rm\") echo \"$*\" >> " + log + "\n" +
		"    case \"$3\" in *busy*) echo 'Error response from daemon: remove x: volume is in use' >&2; exit 1 ;; esac ;;\n" +
		"esac\n"
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	d := docker.New(filepath.Join(dir, "docker"), nil).WithScope(docker.Scope{RunID: "r", Host: "h", PID: 1, Deadline: time.Now().Add(time.Hour)})
	return d, log
}

func quoted(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = "'" + s + "'"
	}
	return out
}

func removals(t *testing.T, log string) []string {
	t.Helper()
	data, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

// Spec: the Run removes the toolset volumes of other toolset versions at its
// start, not only when a Check that uses the toolset is about to run.
func TestOtherToolsetVersionsAreRemovedAtStartButNeverTheCurrentOne(t *testing.T) {
	d, log := fakeDocker(t, VolumeName("v-now"), VolumeName("v-old"), VolumeName("v-busy"), "someone-elses-volume")

	CleanOtherVersions(context.Background(), Config{Docker: d, CacheDir: t.TempDir(), Version: "v-now"})

	got := strings.Join(removals(t, log), "\n")
	if !strings.Contains(got, "volume rm "+VolumeName("v-old")) {
		t.Errorf("the old volume was not removed:\n%s", got)
	}
	if strings.Contains(got, VolumeName("v-now")) {
		t.Errorf("the current version's volume was removed:\n%s", got)
	}
	if strings.Contains(got, "someone-elses-volume") {
		t.Errorf("a volume that is not a toolset volume was touched:\n%s", got)
	}
	// The volume of a live Run is asked about, and Docker's refusal leaves it alone.
}

// Another Run may be filling a volume right now, under the same lock. The start
// does not wait for it and does not remove anything then.
func TestTheCleanupAtStartLeavesEverythingWhileAnotherRunHoldsTheToolsetLock(t *testing.T) {
	d, log := fakeDocker(t, VolumeName("v-now"), VolumeName("v-old"))
	cache := t.TempDir()
	held, err := acquire(context.Background(), filepath.Join(cache, "toolset.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer held.release()

	started := time.Now()
	CleanOtherVersions(context.Background(), Config{Docker: d, CacheDir: cache, Version: "v-now"})

	if took := time.Since(started); took > 15*time.Second {
		t.Errorf("the cleanup waited %s for the lock", took)
	}
	if got := removals(t, log); len(got) != 0 {
		t.Errorf("volumes were removed while another Run held the lock: %v", got)
	}
}
