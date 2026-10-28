//go:build docker

package docker_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

func valkeyFamily(t *testing.T) toolset.ServiceFamily {
	t.Helper()
	f, ok := toolset.ServiceFamilyOf("valkey/valkey")
	if !ok {
		t.Fatal("no valkey family")
	}
	return f
}

func TestAServiceIsReachableUnderItsAliasOnAnInternalNetworkAndGoneAfterwards(t *testing.T) {
	d, _ := realDriver(t, "service-aaaa")
	ctx := context.Background()
	fam := valkeyFamily(t)
	if err := d.Pull(ctx, fam.Image.Ref()); err != nil {
		t.Fatal(err)
	}

	net, err := d.CreateNetwork(ctx, "svcnet", true)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := d.StartService(ctx, docker.ServiceSpec{
		Name: "svc-redis", Alias: "redis", Image: fam.Image.Ref(), Network: net,
		CPUs: toolset.ServiceCPUs, MemoryMB: toolset.ServiceMemoryMB,
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		res, err := d.Exec(ctx, svc, fam.Probe...)
		if err != nil {
			t.Fatal(err)
		}
		if res.ExitCode == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the probe never passed: %s %s\nlogs: %s", res.Stdout, res.Stderr, d.Logs(ctx, svc))
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Another container of the network reaches it by its compose name.
	res, err := d.RunContainer(ctx, docker.ContainerSpec{
		Name: "client", Image: fam.Image.Ref(), Cmd: []string{"valkey-cli", "-h", "redis", "ping"}, Network: net,
		CPUs: 1, MemoryMB: 256,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 || !strings.Contains(string(res.Stdout), "PONG") {
		t.Fatalf("client: exit %d, %s %s", res.ExitCode, res.Stdout, res.Stderr)
	}

	if !d.Running(ctx, svc) {
		t.Error("the Service is not reported as running")
	}

	if err := d.RemoveService(ctx, svc); err != nil {
		t.Fatal(err)
	}
	if d.Running(ctx, svc) {
		t.Error("the Service is reported as running after RemoveService")
	}
	if err := d.RemoveNetwork(ctx, net); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(ctx, svc, "true"); err == nil {
		t.Error("the Service container still exists after RemoveService")
	}
}

func TestAServiceNeverTakesAHostPathOrAForeignContainerName(t *testing.T) {
	d, _ := realDriver(t, "service-bbbb")
	ctx := context.Background()
	if _, err := d.Exec(ctx, "some-other-container", "true"); err == nil {
		t.Error("Exec accepted a container that is not run-owned")
	}
	if err := d.RemoveService(ctx, "postgres"); err == nil {
		t.Error("RemoveService accepted a container that is not run-owned")
	}
	if _, err := d.StartService(ctx, docker.ServiceSpec{Name: "x", Alias: "--privileged", Image: "x@sha256:0", Network: "jspf-x"}); err == nil {
		t.Error("StartService accepted an alias that is an option")
	}
}
