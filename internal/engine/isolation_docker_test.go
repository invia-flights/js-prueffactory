//go:build docker

package engine

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/progress"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// uniqueRunID returns a run ID no other test or Run on a shared daemon has.
func uniqueRunID(tag string) string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return time.Now().UTC().Format("20060102T150405Z") + "-" + tag + "-" + hex.EncodeToString(b[:])
}

func isolationRun(t *testing.T, runID, network string, internal bool) (*run, *bytes.Buffer) {
	t.Helper()
	exe, err := docker.Locate(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	drv := docker.New(exe, docker.Env(os.Getenv)).WithScope(docker.Scope{
		RunID: runID, Host: "test-host", PID: os.Getpid(), Deadline: time.Now().Add(time.Hour),
	})
	t.Cleanup(func() { _ = drv.RemoveRunResources(context.Background()) })
	var stderr bytes.Buffer
	r := &run{cfg: Config{Docker: drv}, log: progress.New(&stderr, nil)}
	if network == "" {
		if r.network, err = drv.CreateNetwork(context.Background(), "net", internal); err != nil {
			t.Fatal(err)
		}
	} else {
		r.network = network
	}
	return r, &stderr
}

func TestTheProbeConfirmsIsolationOnAnInternalNetwork(t *testing.T) {
	r, stderr := isolationRun(t, uniqueRunID("isolation-aaaa"), "", true)

	r.probeIsolation(context.Background())

	if r.isolation != resultset.IsolationConfirmed || len(r.limitations) != 0 {
		t.Errorf("isolation = %q, limitations = %+v\n%s", r.isolation, r.limitations, stderr)
	}
	assertFastLookupFailureAndServiceNamesResolve(t, r)
}

// lookupScript is what a project test does: Node's own dns.lookup. It prints
// how many seconds the lookup of a host that nothing provides took and whether
// the Run Service's name resolves.
const lookupScript = `const dns = require('dns');
const t0 = Date.now();
dns.lookup('unknown-host.invalid', (e) => {
  console.log('unknown_code=' + (e ? e.code : ''));
  console.log('unknown_seconds=' + (Date.now() - t0) / 1000);
  dns.lookup('redis', (e2) => console.log('service_code=' + (e2 ? e2.code : 'ok')));
});`

// ADR-0004: a test that calls a host the Run does not provide must fail fast.
// A lookup of an unknown name on the internal network fails within 2 seconds
// (the Docker default is 5), and a Run Service's name still resolves.
func assertFastLookupFailureAndServiceNamesResolve(t *testing.T, r *run) {
	t.Helper()
	ctx := context.Background()
	drv := r.cfg.Docker
	fam, ok := toolset.ServiceFamilyOf("valkey/valkey")
	if !ok {
		t.Fatal("no valkey family")
	}
	if err := drv.Pull(ctx, fam.Image.Ref()); err != nil {
		t.Fatal(err)
	}
	node, ok := toolset.NodeImage(24, toolset.VariantAlpine)
	if !ok {
		t.Fatal("no Node 24 alpine image")
	}
	if err := drv.Pull(ctx, node.Ref()); err != nil {
		t.Fatal(err)
	}
	svc, err := drv.StartService(ctx, docker.ServiceSpec{
		Name: "lookup-redis", Alias: "redis", Image: fam.Image.Ref(), Network: r.network,
		CPUs: toolset.ServiceCPUs, MemoryMB: toolset.ServiceMemoryMB,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = drv.RemoveService(context.Background(), svc) })

	// A Service's alias is registered once its container runs; wait for that.
	var out map[string]string
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		c, err := drv.RunContainer(ctx, docker.ContainerSpec{
			Name: "lookup-client", Image: node.Ref(), Network: r.network,
			Cmd: []string{"node", "-e", lookupScript}, CPUs: 1, MemoryMB: 128,
		})
		if err != nil {
			t.Fatal(err)
		}
		out = map[string]string{}
		for _, line := range strings.Split(string(c.Stdout), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok {
				out[k] = v
			}
		}
		if out["service_code"] == "ok" || time.Now().After(deadline) {
			break
		}
	}
	if out["service_code"] != "ok" {
		t.Errorf("the Run Service name does not resolve: %v", out)
	}
	if out["unknown_code"] == "" {
		t.Errorf("a lookup of an unknown name did not fail: %v", out)
	}
	secs, err := strconv.ParseFloat(out["unknown_seconds"], 64)
	if err != nil {
		t.Fatalf("no timing in %v: %v", out, err)
	}
	if secs >= 2 {
		t.Errorf("a lookup of an unknown name took %.2f s, want under 2 s (the Docker default is 5 s)", secs)
	}
}

// A network with a route out stands in for a Docker that ignores --internal.
func TestTheProbeReportsAnOpenNetworkAsALimitationAndAWarningAndGoesOn(t *testing.T) {
	r, stderr := isolationRun(t, uniqueRunID("isolation-bbbb"), "", false)

	r.probeIsolation(context.Background())

	if r.isolation != resultset.IsolationNotIsolated {
		t.Fatalf("isolation = %q, want not_isolated\n%s", r.isolation, stderr)
	}
	if len(r.limitations) != 1 || r.limitations[0].ReasonCode != "network_not_isolated" {
		t.Errorf("limitations = %+v", r.limitations)
	}
	if !strings.Contains(stderr.String(), "warning: network isolation is NOT in effect") {
		t.Errorf("stderr = %s", stderr)
	}
}
