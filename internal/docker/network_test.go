package docker_test

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
)

var testScope = docker.Scope{RunID: "20261025T101500Z-x-aaaa", Host: "h", PID: 1, Deadline: time.Now().Add(time.Hour)}

// ADR-0004: only the Preparation phase has outbound access. A container that
// names neither a network nor the Preparation phase would silently get the
// default bridge, so it is refused.
func TestAContainerMustChooseItsNetworkExplicitly(t *testing.T) {
	exe, log := recordingCLI(t)
	d := docker.New(exe, nil).WithScope(testScope)
	_, err := d.RunContainer(context.Background(), docker.ContainerSpec{Image: "node@sha256:x", Cmd: []string{"true"}})
	if err == nil || !strings.Contains(err.Error(), "network") {
		t.Fatalf("err = %v, want a refusal that names the network", err)
	}
	if got := callsOf(t, log); got != "" {
		t.Errorf("docker was called anyway: %q", got)
	}
}

func TestOnlyAPreparationContainerGetsTheDefaultBridge(t *testing.T) {
	scope := testScope
	for name, tc := range map[string]struct {
		spec       docker.ContainerSpec
		wantErr    string
		wantNet    string // the --network argument, "" for none given
		wantNoFlag bool
	}{
		"preparation":                 {spec: docker.ContainerSpec{Preparation: true}, wantNoFlag: true},
		"no network":                  {spec: docker.ContainerSpec{Network: docker.NetworkNone}, wantNet: "none"},
		"a run-owned network":         {spec: docker.ContainerSpec{Network: "jspf-run-exec"}, wantNet: "jspf-run-exec"},
		"preparation and a network":   {spec: docker.ContainerSpec{Preparation: true, Network: "jspf-run-exec"}, wantErr: "network"},
		"the host network":            {spec: docker.ContainerSpec{Network: "host"}, wantErr: "network"},
		"another container's network": {spec: docker.ContainerSpec{Network: "container:abc"}, wantErr: "network"},
	} {
		t.Run(name, func(t *testing.T) {
			exe, log := recordingCLI(t)
			tc.spec.Image, tc.spec.Cmd = "node@sha256:x", []string{"true"}
			_, err := docker.New(exe, nil).WithScope(scope).RunContainer(context.Background(), tc.spec)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want a refusal mentioning %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			create := createCall(t, log)
			if tc.wantNoFlag && strings.Contains(create, "--network") {
				t.Errorf("create call %q names a network", create)
			}
			if tc.wantNet != "" && !strings.Contains(create, "--network "+tc.wantNet+" ") {
				t.Errorf("create call %q lacks --network %s", create, tc.wantNet)
			}
		})
	}
}

// ADR-0004: on the internal network a lookup of a host that is not a Run
// Service takes 5 s by default, so a project test that calls out hits the
// Mocha timeout instead of failing fast. Every container on a run-owned network
// therefore starts with a one-second, one-attempt resolver.
func TestEveryContainerOnTheRunNetworkGetsFastFailingResolverOptions(t *testing.T) {
	dnsOpts := []string{"--dns-opt timeout:1", "--dns-opt attempts:1"}
	for name, tc := range map[string]struct {
		spec docker.ContainerSpec
		want bool
	}{
		"a container on the run network": {spec: docker.ContainerSpec{Network: "jspf-run-exec"}, want: true},
		"a container with no network":    {spec: docker.ContainerSpec{Network: docker.NetworkNone}},
		"a preparation container":        {spec: docker.ContainerSpec{Preparation: true}},
	} {
		t.Run(name, func(t *testing.T) {
			exe, log := recordingCLI(t)
			tc.spec.Image, tc.spec.Cmd = "node@sha256:x", []string{"true"}
			if _, err := docker.New(exe, nil).WithScope(testScope).RunContainer(context.Background(), tc.spec); err != nil {
				t.Fatal(err)
			}
			create := createCall(t, log)
			for _, opt := range dnsOpts {
				if got := strings.Contains(create, opt); got != tc.want {
					t.Errorf("create call %q: contains %q = %v, want %v", create, opt, got, tc.want)
				}
			}
		})
	}
}

func TestEveryServiceOnTheRunNetworkGetsFastFailingResolverOptions(t *testing.T) {
	exe, log := recordingCLI(t)
	_, err := docker.New(exe, nil).WithScope(testScope).StartService(context.Background(),
		docker.ServiceSpec{Name: "pg", Alias: "postgres", Image: "postgres@sha256:x", Network: "jspf-run-exec"})
	if err != nil {
		t.Fatal(err)
	}
	create := createCall(t, log)
	for _, opt := range []string{"--dns-opt timeout:1", "--dns-opt attempts:1"} {
		if !strings.Contains(create, opt) {
			t.Errorf("create call %q lacks %q", create, opt)
		}
	}
}

func TestEveryContainerIsHardened(t *testing.T) {
	exe, log := recordingCLI(t)
	d := docker.New(exe, nil).WithScope(testScope)
	if _, err := d.RunContainer(context.Background(), docker.ContainerSpec{Image: "node@sha256:x", Cmd: []string{"true"}, Network: docker.NetworkNone}); err != nil {
		t.Fatal(err)
	}
	create := createCall(t, log)
	for _, want := range []string{"--security-opt no-new-privileges", "--pids-limit ", "--cap-drop ALL", "--cap-add SETUID"} {
		if !strings.Contains(create, want) {
			t.Errorf("create call %q lacks %q", create, want)
		}
	}
}

// callsOf returns what the recording CLI was called with, "" if never.
func callsOf(t *testing.T, log string) string {
	t.Helper()
	data, err := os.ReadFile(log)
	if errors.Is(err, fs.ErrNotExist) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestAnEnvironmentVariableNameThatCouldBeAnOptionIsRefused(t *testing.T) {
	exe, log := recordingCLI(t)
	d := docker.New(exe, nil).WithScope(testScope)
	_, err := d.RunContainer(context.Background(), docker.ContainerSpec{
		Image: "node@sha256:x", Cmd: []string{"true"}, Network: docker.NetworkNone,
		Env: map[string]string{"A=B --privileged": "x"},
	})
	if err == nil || !strings.Contains(err.Error(), "environment variable") {
		t.Fatalf("err = %v", err)
	}
	if got := callsOf(t, log); got != "" {
		t.Errorf("docker was called anyway: %q", got)
	}
}
