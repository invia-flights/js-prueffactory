//go:build docker

package docker_test

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// These tests talk to a real Docker daemon. With the docker tag an unreachable
// daemon fails them loudly.

// uniqueRunID returns a run ID no other test, binary or Run shares, so tests
// that run in parallel against one daemon never see or remove each other's
// resources. The tag only makes leftovers recognisable.
func uniqueRunID(tag string) string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return time.Now().UTC().Format("20060102T150405Z") + "-" + tag + "-" + hex.EncodeToString(b[:])
}

// realDriver returns a Driver whose Run ID is unique (see uniqueRunID).
func realDriver(t *testing.T, tag string) (*docker.Driver, string) {
	t.Helper()
	d, image, _ := realDriverID(t, tag)
	return d, image
}

// realDriverID is realDriver that also returns the Run ID it made up.
func realDriverID(t *testing.T, tag string) (d *docker.Driver, image, runID string) {
	t.Helper()
	runID = uniqueRunID(tag)
	exe, err := docker.Locate(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	base := docker.New(exe, docker.Env(os.Getenv))
	if _, err := base.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	scoped := base.WithScope(docker.Scope{RunID: runID, Host: "test-host", PID: os.Getpid(), Deadline: time.Now().Add(time.Hour)})
	t.Cleanup(func() {
		if err := scoped.RemoveRunResources(context.Background()); err != nil {
			t.Errorf("cleanup: %v", err)
		}
		assertGone(t, runID)
	})
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	if err := base.Pull(context.Background(), img.Ref()); err != nil {
		t.Fatal(err)
	}
	return scoped, img.Ref(), runID
}

func assertGone(t *testing.T, runID string) {
	t.Helper()
	for _, kind := range [][]string{{"ps", "-a"}, {"network", "ls"}, {"volume", "ls"}} {
		args := append(append([]string{}, kind...), "--filter", "label=js-prueffactory.run-id="+runID, "-q")
		out, err := exec.Command("docker", args...).Output()
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(out)) != "" {
			t.Errorf("docker %s still lists %s", kind[0], out)
		}
	}
}

func tarOf(files map[string]string) func(io.Writer) error {
	return func(w io.Writer) error {
		tw := tar.NewWriter(w)
		for name, content := range files {
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: 0o644, Size: int64(len(content))}); err != nil {
				return err
			}
			if _, err := tw.Write([]byte(content)); err != nil {
				return err
			}
		}
		return tw.Close()
	}
}

func TestVolumeReceivesATarStreamAndAContainerReadsItWithoutAHostMount(t *testing.T) {
	d, image := realDriver(t, "driver-aaaa")
	ctx := context.Background()

	vol, err := d.CreateVolume(ctx, "data")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.PutTar(ctx, vol, image, tarOf(map[string]string{"sub/hello.txt": "hello from the host"})); err != nil {
		t.Fatal(err)
	}
	res, err := d.RunContainer(ctx, docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"cat", "/data/sub/hello.txt", "/jspf/extra.txt"},
		Mounts: []docker.Mount{{Volume: vol, Path: "/data", ReadOnly: true}},
		Files:  []docker.File{{Path: "/jspf/extra.txt", Content: []byte(" and a copied-in file")}},
		CPUs:   1, MemoryMB: 256,
		WorkDir: "/data",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 || string(res.Stdout) != "hello from the host and a copied-in file" {
		t.Fatalf("exit %d, stdout %q, stderr %q", res.ExitCode, res.Stdout, res.Stderr)
	}

	// A read-only mount really is read-only.
	res, err = d.RunContainer(ctx, docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"sh", "-c", "echo x > /data/new.txt"},
		Mounts: []docker.Mount{{Volume: vol, Path: "/data", ReadOnly: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode == 0 {
		t.Error("wrote into a read-only mount")
	}
}

func TestNonZeroExitAndOutputAreReported(t *testing.T) {
	d, image := realDriver(t, "driver-bbbb")
	res, err := d.RunContainer(context.Background(), docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"sh", "-c", "echo out; echo err >&2; exit 7"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 7 || string(res.Stdout) != "out\n" || string(res.Stderr) != "err\n" {
		t.Fatalf("%+v", res)
	}
}

func TestAContainerThatAnnouncesItsEndAndKeepsRunningIsStoppedAfterTheGracePeriod(t *testing.T) {
	d, image := realDriver(t, "driver-g23a")
	started := time.Now()

	res, err := d.RunContainer(context.Background(), docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"sh", "-c", "echo before; echo @@END-g23a@@ >&2; sleep 120"},
		EndMarker: &docker.EndMarker{Text: "@@END-g23a@@", Grace: 2 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}

	if !res.StoppedAfterGrace || res.ExitCode == 0 {
		t.Errorf("result = %+v, want stopped after the grace period with a non-zero exit", res)
	}
	if time.Since(started) > 60*time.Second {
		t.Errorf("took %s, the container should have been stopped after the 2 second grace", time.Since(started))
	}
	if string(res.Stdout) != "before\n" || string(res.Stderr) != "" {
		t.Errorf("stdout %q, stderr %q: the marker is not part of the output", res.Stdout, res.Stderr)
	}
}

func TestAContainerThatExitsWithinTheGracePeriodIsLeftAlone(t *testing.T) {
	d, image := realDriver(t, "driver-g23b")

	res, err := d.RunContainer(context.Background(), docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"sh", "-c", "echo @@END-g23b@@; sleep 1; echo done"},
		EndMarker: &docker.EndMarker{Text: "@@END-g23b@@", Grace: 30 * time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}

	if res.StoppedAfterGrace || res.ExitCode != 0 || string(res.Stdout) != "done\n" {
		t.Errorf("result = %+v", res)
	}
}

func TestInternalNetworkContainersAndLabelsBelongToTheRun(t *testing.T) {
	d, image, runID := realDriverID(t, "driver-cccc")
	ctx := context.Background()

	net, err := d.CreateNetwork(ctx, "net", true)
	if err != nil {
		t.Fatal(err)
	}
	if net != "jspf-"+runID+"-net" {
		t.Errorf("network name = %q", net)
	}
	out, _ := exec.Command("docker", "network", "inspect", "--format", "{{.Internal}}", net).Output()
	if strings.TrimSpace(string(out)) != "true" {
		t.Errorf("Internal = %q, want true", out)
	}

	// While a container runs it joins the network and carries the labels.
	done := make(chan error, 1)
	go func() {
		_, err := d.RunContainer(ctx, docker.ContainerSpec{Name: "sleeper", Image: image, Cmd: []string{"sleep", "4"}, Network: net})
		done <- err
	}()
	name := "jspf-" + runID + "-sleeper"
	var inspect []byte
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		inspect, _ = exec.Command("docker", "inspect", "--format", "{{json .Config.Labels}}", name).Output()
		if len(bytes.TrimSpace(inspect)) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	var labels map[string]string
	if err := json.Unmarshal(bytes.TrimSpace(inspect), &labels); err != nil {
		t.Fatalf("no labels for container %s: %v %q", name, err, inspect)
	}
	if labels[docker.LabelRunID] != runID || labels[docker.LabelHost] != "test-host" || labels[docker.LabelPID] == "" || labels[docker.LabelDeadline] == "" {
		t.Errorf("labels = %v", labels)
	}
	nets, _ := exec.Command("docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", name).Output()
	if !strings.Contains(string(nets), net) {
		t.Errorf("container did not join %s: %s", net, nets)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCancellingARunningContainerRemovesIt(t *testing.T) {
	d, image, runID := realDriverID(t, "driver-dddd")
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()

	_, err := d.RunContainer(ctx, docker.ContainerSpec{Network: docker.NetworkNone, Image: image, Cmd: []string{"sleep", "60"}})
	if err == nil {
		t.Fatal("expected the cancelled container run to fail")
	}
	assertGone(t, runID)
}

func TestCacheVolumeCarriesTheCacheLabelIsReusedAndSurvivesTheRun(t *testing.T) {
	d, image := realDriver(t, "driver-cv13")
	ctx := context.Background()
	kind := "test13-" + strings.ReplaceAll(time.Now().Format("150405.000"), ".", "")
	var name string
	t.Cleanup(func() {
		if name != "" {
			_ = exec.Command("docker", "volume", "rm", "--force", name).Run()
		}
	})

	name, err := d.CacheVolume(ctx, kind)
	if err != nil {
		t.Fatal(err)
	}
	again, err := d.CacheVolume(ctx, kind)
	if err != nil || again != name {
		t.Fatalf("second call = %q, %v; want %q", again, err, name)
	}
	if _, err := d.RunContainer(ctx, docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"sh", "-c", "echo kept > /cache/marker"},
		Mounts: []docker.Mount{{Volume: name, Path: "/cache"}},
	}); err != nil {
		t.Fatal(err)
	}

	// The volume has the cache label and no run label, so no Run removes it.
	out, err := exec.Command("docker", "volume", "inspect", "--format", "{{json .Labels}}", name).Output()
	if err != nil {
		t.Fatal(err)
	}
	var labels map[string]string
	if err := json.Unmarshal(bytes.TrimSpace(out), &labels); err != nil {
		t.Fatal(err)
	}
	if labels[docker.LabelCache] != kind {
		t.Errorf("labels = %v, want %s=%s", labels, docker.LabelCache, kind)
	}
	if _, has := labels[docker.LabelRunID]; has {
		t.Errorf("a cache volume must carry no run label: %v", labels)
	}
	if err := d.RemoveRunResources(ctx); err != nil {
		t.Fatal(err)
	}
	res, err := d.RunContainer(ctx, docker.ContainerSpec{Network: docker.NetworkNone,
		Image: image, Cmd: []string{"cat", "/cache/marker"},
		Mounts: []docker.Mount{{Volume: name, Path: "/cache", ReadOnly: true}},
	})
	if err != nil || strings.TrimSpace(string(res.Stdout)) != "kept" {
		t.Errorf("the cache did not survive the Run: %v %+v", err, res)
	}
}
