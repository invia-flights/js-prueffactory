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

// fakeCLI writes an executable shell script named docker into a new folder and
// returns that folder.
func fakeCLI(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLocateFindsTheDockerCLIOnPath(t *testing.T) {
	dir := fakeCLI(t, "exit 0\n")
	exe, err := docker.Locate(env(map[string]string{"PATH": "/nonexistent:" + dir}))
	if err != nil {
		t.Fatal(err)
	}
	if exe != filepath.Join(dir, "docker") {
		t.Fatalf("Locate = %q", exe)
	}
}

func TestLocateReportsAMissingCLI(t *testing.T) {
	_, err := docker.Locate(env(map[string]string{"PATH": t.TempDir()}))
	if err == nil || !strings.Contains(err.Error(), "docker CLI") {
		t.Fatalf("err = %v, want a message naming the docker CLI", err)
	}
}

func TestPreflightReportsAnUnreachableDaemon(t *testing.T) {
	dir := fakeCLI(t, "echo 'Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?' >&2\nexit 1\n")
	d := docker.New(filepath.Join(dir, "docker"), nil)
	_, err := d.Preflight(context.Background())
	if err == nil || !strings.Contains(err.Error(), "Cannot connect to the Docker daemon") {
		t.Fatalf("err = %v", err)
	}
}

func TestPreflightReadsTheDaemonFacts(t *testing.T) {
	dir := fakeCLI(t, `case "$1" in
  info) echo '{"ServerVersion":"29.4.0","NCPU":8,"MemTotal":17179869184,"OSType":"linux","Architecture":"aarch64"}' ;;
  version) echo '{"Version":"29.4.0","ApiVersion":"1.56","MinAPIVersion":"1.44"}' ;;
esac
`)
	info, err := docker.New(filepath.Join(dir, "docker"), nil).Preflight(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.ServerVersion != "29.4.0" || info.APIVersion != "1.56" || info.CPUs != 8 || info.MemoryBytes != 17179869184 {
		t.Fatalf("info = %+v", info)
	}
}

func TestContainersCanOnlyMountRunOwnedVolumesNeverHostPaths(t *testing.T) {
	dir := fakeCLI(t, "echo should-not-be-called >&2\nexit 9\n")
	d := docker.New(filepath.Join(dir, "docker"), nil).WithScope(docker.Scope{
		RunID: "20261025T101500Z-x-aaaa", Host: "h", PID: 1, Deadline: time.Now().Add(time.Hour),
	})
	for _, bad := range []string{"/Users/me/project", "./relative", "../up", "~/home", "name with space"} {
		_, err := d.RunContainer(context.Background(), docker.ContainerSpec{
			Image: "node@sha256:x", Cmd: []string{"true"},
			Mounts: []docker.Mount{{Volume: bad, Path: "/work"}},
		})
		if err == nil || !strings.Contains(err.Error(), "volume") {
			t.Errorf("mount of %q was not refused: %v", bad, err)
		}
	}
}

func TestResourceNamesCarryTheRunPrefix(t *testing.T) {
	d := docker.New("docker", nil).WithScope(docker.Scope{RunID: "20261025T101500Z-x-aaaa"})
	if got := d.Name("net"); got != "jspf-20261025T101500Z-x-aaaa-net" {
		t.Fatalf("Name = %q", got)
	}
}
