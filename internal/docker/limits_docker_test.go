//go:build docker

package docker_test

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

func TestARunningContainerHasTwoCPUsAndFourGigabytes(t *testing.T) {
	d, image, runID := realDriverID(t, "driver-limits")

	done := make(chan error, 1)
	go func() {
		// The spec asks for no limits at all.
		_, err := d.RunContainer(context.Background(), docker.ContainerSpec{Network: docker.NetworkNone, Name: "limited", Image: image, Cmd: []string{"sleep", "4"}})
		done <- err
	}()
	name := "jspf-" + runID + "-limited"
	var out []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _ = exec.Command("docker", "inspect", "--format", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", name).Output()
		if len(strings.TrimSpace(string(out))) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got, want := strings.TrimSpace(string(out)), "2000000000 4294967296"; got != want {
		t.Errorf("NanoCpus and Memory = %q, want %q", got, want)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
