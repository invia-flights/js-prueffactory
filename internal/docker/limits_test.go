package docker_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

// recordingCLI is a fake docker that appends every call's arguments to a file
// and answers just enough for RunContainer to finish.
func recordingCLI(t *testing.T) (exe, log string) {
	t.Helper()
	log = filepath.Join(t.TempDir(), "calls")
	dir := fakeCLI(t, `echo "$*" >> `+log+`
case "$1" in
  inspect) echo '{"ExitCode":0,"OOMKilled":false}' ;;
esac
`)
	return filepath.Join(dir, "docker"), log
}

func createCall(t *testing.T, log string) string {
	t.Helper()
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(l, "create ") {
			return l
		}
	}
	t.Fatalf("no create call in %q", data)
	return ""
}

func TestEveryContainerIsLimitedToTwoCPUsAndFourGigabytes(t *testing.T) {
	scope := docker.Scope{RunID: "20261025T101500Z-x-aaaa", Host: "h", PID: 1, Deadline: time.Now().Add(time.Hour)}
	cases := []struct {
		name string
		spec docker.ContainerSpec
		want []string
		not  string
	}{
		{"unset limits get the defaults", docker.ContainerSpec{}, []string{"--cpus 2", "--memory 4096m"}, ""},
		{"a Service may ask for less", docker.ContainerSpec{CPUs: 1, MemoryMB: 1024}, []string{"--cpus 1", "--memory 1024m"}, ""},
		{"nothing may ask for more", docker.ContainerSpec{CPUs: 8, MemoryMB: 16384}, []string{"--cpus 2", "--memory 4096m"}, "--cpus 8"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			exe, log := recordingCLI(t)
			tc.spec.Image, tc.spec.Cmd, tc.spec.Network = "node@sha256:x", []string{"true"}, docker.NetworkNone
			if _, err := docker.New(exe, nil).WithScope(scope).RunContainer(context.Background(), tc.spec); err != nil {
				t.Fatal(err)
			}
			create := createCall(t, log)
			for _, w := range tc.want {
				if !strings.Contains(create, w) {
					t.Errorf("create call %q lacks %q", create, w)
				}
			}
			if tc.not != "" && strings.Contains(create, tc.not) {
				t.Errorf("create call %q contains %q", create, tc.not)
			}
		})
	}
}
