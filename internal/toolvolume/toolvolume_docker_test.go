//go:build docker

package toolvolume_test

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// These tests fill real toolset volumes. Every test uses its own toolset
// version string, so it never touches the volume of a real Run, and removes
// what it created.

func scoped(t *testing.T) (*docker.Driver, string) {
	t.Helper()
	exe, err := docker.Locate(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	base := docker.New(exe, docker.Env(os.Getenv))
	if _, err := base.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	if err := base.Pull(context.Background(), img.Ref()); err != nil {
		t.Fatal(err)
	}
	return base, img.Ref()
}

func newScope(t *testing.T, base *docker.Driver) *docker.Driver {
	t.Helper()
	id := fmt.Sprintf("t14-%d-%d", os.Getpid(), rand.Int63())
	d := base.WithScope(docker.Scope{RunID: id, Host: "test-host", PID: os.Getpid(), Deadline: time.Now().Add(time.Hour)})
	t.Cleanup(func() { _ = d.RemoveRunResources(context.Background()) })
	return d
}

func uniqueVersion(t *testing.T) string {
	t.Helper()
	v := fmt.Sprintf("t14x%x", rand.Int63())
	t.Cleanup(func() { removeVolume("jspf-toolset-" + v) })
	return v
}

// removeVolume is the test's own cleanup; it does not use the code under test.
func removeVolume(name string) { _ = exec.Command("docker", "volume", "rm", "-f", name).Run() }

func volumeCreatedAt(t *testing.T, name string) string {
	t.Helper()
	out, err := exec.Command("docker", "volume", "inspect", "--format", "{{.CreatedAt}}", name).Output()
	if err != nil {
		t.Fatalf("docker volume inspect %s: %v", name, err)
	}
	return strings.TrimSpace(string(out))
}

func volumeExists(name string) bool {
	return exec.Command("docker", "volume", "inspect", name).Run() == nil
}

func TestTheToolsAreInstalledOnceAndReusedByTheNextRun(t *testing.T) {
	base, image := scoped(t)
	cache := t.TempDir()
	version := uniqueVersion(t)
	ctx := context.Background()

	first := newScope(t, base)
	var logs []string
	v1, err := toolvolume.Ensure(ctx, toolvolume.Config{
		Docker: first, CacheDir: cache, Version: version, Image: image,
		Logf: func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if !v1.Installed || v1.Name != "jspf-toolset-"+version {
		t.Fatalf("first Ensure = %+v, want a fresh install into jspf-toolset-%s", v1, version)
	}
	if !strings.Contains(strings.Join(logs, "\n"), "installing") {
		t.Errorf("the first Run should log the install: %q", logs)
	}

	// The volume carries the cache labels, never a run label, so a Run's cleanup keeps it.
	out, _ := exec.Command("docker", "volume", "inspect", "--format", "{{json .Labels}}", v1.Name).Output()
	if !strings.Contains(string(out), `"js-prueffactory.cache":"toolset"`) || !strings.Contains(string(out), version) || strings.Contains(string(out), "run-id") {
		t.Errorf("labels = %s", out)
	}

	// The installed tool is there and can run, on the same image.
	cr, err := first.RunContainer(ctx, docker.ContainerSpec{
		Name: "probe", Image: image, Network: "none",
		Mounts: []docker.Mount{{Volume: v1.Name, Path: "/toolset", ReadOnly: true}},
		Cmd:    []string{"node", "/toolset/node_modules/jscpd/run-jscpd.js", "--version"},
	})
	if err != nil || cr.ExitCode != 0 || !strings.Contains(string(cr.Stdout), "5.4.2") {
		t.Fatalf("jscpd --version: %+v, %v", cr, err)
	}

	// A later Run, with another run ID, reuses the volume without installing.
	created := volumeCreatedAt(t, v1.Name)
	second := newScope(t, base)
	logs = nil
	v2, err := toolvolume.Ensure(ctx, toolvolume.Config{
		Docker: second, CacheDir: cache, Version: version, Image: image,
		Logf: func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if v2.Installed || v2.Name != v1.Name {
		t.Fatalf("second Ensure = %+v, want a reuse of %s", v2, v1.Name)
	}
	if strings.Contains(strings.Join(logs, "\n"), "installing") || !strings.Contains(strings.Join(logs, "\n"), "reusing") {
		t.Errorf("the second Run should log a reuse: %q", logs)
	}
	if volumeCreatedAt(t, v1.Name) != created {
		t.Error("the volume was recreated")
	}
}

func TestAVolumeOfTheRightNameWithoutLabelsIsReplacedNotTrusted(t *testing.T) {
	// Docker creates a missing named volume without labels when a container
	// mounts it. Such a volume would never be recognised by the cleanup of old
	// toolset versions, so Ensure replaces it.
	base, image := scoped(t)
	version := uniqueVersion(t)
	name := "jspf-toolset-" + version
	if out, err := exec.Command("docker", "volume", "create", name).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}

	v, err := toolvolume.Ensure(context.Background(), toolvolume.Config{Docker: newScope(t, base), CacheDir: t.TempDir(), Version: version, Image: image})
	if err != nil {
		t.Fatal(err)
	}
	if !v.Installed {
		t.Error("the unlabelled volume was reused instead of replaced")
	}
	out, _ := exec.Command("docker", "volume", "inspect", "--format", "{{json .Labels}}", name).Output()
	if !strings.Contains(string(out), `"js-prueffactory.cache":"toolset"`) {
		t.Errorf("labels = %s", out)
	}
}

func TestTwoRunsStartingTogetherFillTheVolumeOnce(t *testing.T) {
	base, image := scoped(t)
	cache := t.TempDir()
	version := uniqueVersion(t)

	var wg sync.WaitGroup
	results := make([]*toolvolume.Volume, 2)
	errs := make([]error, 2)
	for i := range results {
		wg.Add(1)
		d := newScope(t, base)
		go func() {
			defer wg.Done()
			results[i], errs[i] = toolvolume.Ensure(context.Background(), toolvolume.Config{
				Docker: d, CacheDir: cache, Version: version, Image: image,
			})
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
	}
	if results[0].Installed == results[1].Installed {
		t.Fatalf("installed = %v and %v, want exactly one Run to install", results[0].Installed, results[1].Installed)
	}
}

func TestOtherToolsetVersionsAreRemovedButVolumesInUseAreLeftAlone(t *testing.T) {
	base, image := scoped(t)
	cache := t.TempDir()
	version := uniqueVersion(t)
	ctx := context.Background()

	stale, inUse := "jspf-toolset-t14stale"+version, "jspf-toolset-t14inuse"+version
	for _, name := range []string{stale, inUse} {
		name := name
		out, err := exec.Command("docker", "volume", "create",
			"--label", "js-prueffactory.cache=toolset", "--label", "js-prueffactory.toolset-version="+strings.TrimPrefix(name, "jspf-toolset-"), name).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		t.Cleanup(func() { removeVolume(name) })
	}
	// Another Run still holds one of them: a created container counts as a user.
	holder := "jspf-t14holder-" + version
	if out, err := exec.Command("docker", "create", "--name", holder, "--pull", "never", "--volume", inUse+":/toolset", image, "true").CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", holder).Run() })
	// A volume without the cache label is not ours and must stay.
	foreign := "jspf-toolset-t14foreign" + version
	if out, err := exec.Command("docker", "volume", "create", foreign).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	t.Cleanup(func() { removeVolume(foreign) })

	if _, err := toolvolume.Ensure(ctx, toolvolume.Config{Docker: newScope(t, base), CacheDir: cache, Version: version, Image: image}); err != nil {
		t.Fatal(err)
	}

	if volumeExists(stale) {
		t.Error("the volume of another toolset version was kept")
	}
	if !volumeExists(inUse) {
		t.Error("a volume that a container still uses was removed")
	}
	if !volumeExists(foreign) {
		t.Error("a volume without the cache label was removed")
	}
	if !volumeExists("jspf-toolset-" + version) {
		t.Error("the current toolset volume is gone")
	}
}

func TestTheRunKeepsItsToolsetVolumeInUseUntilItsCleanup(t *testing.T) {
	// Another Run with a newer binary removes unused toolset volumes of other
	// versions. The Run must not lose its volume between install and use.
	base, image := scoped(t)
	cache := t.TempDir()
	version, other := uniqueVersion(t), uniqueVersion(t)
	mine := newScope(t, base)

	v, err := toolvolume.Ensure(context.Background(), toolvolume.Config{Docker: mine, CacheDir: cache, Version: version, Image: image})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := toolvolume.Ensure(context.Background(), toolvolume.Config{Docker: newScope(t, base), CacheDir: cache, Version: other, Image: image}); err != nil {
		t.Fatal(err)
	}
	if !volumeExists(v.Name) {
		t.Fatal("the volume of a running Run was removed by another Run")
	}

	// After the Run's own cleanup the volume may go, and no container is left.
	if err := mine.RemoveRunResources(context.Background()); err != nil {
		t.Fatal(err)
	}
	out, _ := exec.Command("docker", "ps", "-a", "--filter", "label=js-prueffactory.run-id="+runIDOf(mine), "-q").Output()
	if strings.TrimSpace(string(out)) != "" {
		t.Errorf("containers left after cleanup: %s", out)
	}
	if !volumeExists(v.Name) {
		t.Error("the Run's cleanup must keep the cache volume")
	}
}

func TestTheHelmBinaryIsInstalledAndRunsInThePinnedAlpineImage(t *testing.T) {
	base, image := scoped(t)
	if err := base.Pull(context.Background(), toolset.Alpine.Ref()); err != nil {
		t.Fatal(err)
	}
	version := uniqueVersion(t)
	d := newScope(t, base)
	ctx := context.Background()

	v, err := toolvolume.Ensure(ctx, toolvolume.Config{Docker: d, CacheDir: t.TempDir(), Version: version, Image: image})
	if err != nil {
		t.Fatal(err)
	}
	cr, err := d.RunContainer(ctx, docker.ContainerSpec{
		Name: "helm-probe", Image: toolset.Alpine.Ref(), Network: "none",
		Mounts: []docker.Mount{{Volume: v.Name, Path: toolvolume.MountPath, ReadOnly: true}},
		Cmd:    []string{toolvolume.HelmBin, "version", "--short"},
	})
	if err != nil || cr.ExitCode != 0 || !strings.HasPrefix(string(cr.Stdout), "v"+toolset.Helm.Version) {
		t.Fatalf("helm version: %+v, %v", cr, err)
	}
}

func TestAHelmChecksumMismatchStopsThePreparationAndLeavesNoVolume(t *testing.T) {
	base, image := scoped(t)
	version := uniqueVersion(t)
	d := newScope(t, base)

	wrong := toolset.Helm
	wrong.Downloads = map[string]toolset.HelmDownload{}
	for arch, dl := range toolset.Helm.Downloads {
		dl.SHA256 = strings.Repeat("0", 64)
		wrong.Downloads[arch] = dl
	}
	_, err := toolvolume.Ensure(context.Background(), toolvolume.Config{
		Docker: d, CacheDir: t.TempDir(), Version: version, Image: image, Helm: &wrong,
	})
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("Ensure = %v, want a checksum error", err)
	}
	if volumeExists("jspf-toolset-" + version) {
		t.Error("a volume with an unverified binary must not stay")
	}
}

func runIDOf(d *docker.Driver) string {
	return strings.TrimSuffix(strings.TrimPrefix(d.Name(""), "jspf-"), "-")
}
