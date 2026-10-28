//go:build docker

package toolvolume_test

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// These tests fill a real schema volume from the network. Every test uses its
// own cache kind, so it never touches the volume of a real Run, and removes it.

func schemaConfig(t *testing.T, base *docker.Driver, cache, kind string) toolvolume.KubernetesSchemasConfig {
	t.Helper()
	if err := base.Pull(context.Background(), toolset.Alpine.Ref()); err != nil {
		t.Fatal(err)
	}
	return toolvolume.KubernetesSchemasConfig{
		Docker: newScope(t, base), CacheDir: cache, Kind: kind, Helper: toolset.Alpine.Ref(),
	}
}

// schemaFolderListing runs ls in the volume and returns its output.
func schemaFolderListing(t *testing.T, base *docker.Driver, volume, script string) (string, int) {
	t.Helper()
	res, err := newScope(t, base).RunContainer(context.Background(), docker.ContainerSpec{
		Name: "probe", Image: toolset.Alpine.Ref(), Network: "none",
		Mounts: []docker.Mount{{Volume: volume, Path: toolvolume.KubernetesSchemaMountPath, ReadOnly: true}},
		Cmd:    []string{"sh", "-c", script},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(res.Stdout), res.ExitCode
}

func TestTheKubernetesSchemasAreFetchedOnceAndVerifiedBeforeUse(t *testing.T) {
	base, _ := scoped(t)
	ctx := context.Background()
	cache := t.TempDir()
	kind := fmt.Sprintf("t10x%x", rand.Int63())
	t.Cleanup(func() { removeVolume("jspf-cache-" + kind) })

	first, err := toolvolume.EnsureKubernetesSchemas(ctx, schemaConfig(t, base, cache, kind))
	if err != nil {
		t.Fatal(err)
	}
	if !first.Fetched || first.Name != "jspf-cache-"+kind {
		t.Fatalf("first = %+v, want a fetch into jspf-cache-%s", first, kind)
	}
	if label, err := base.VolumeLabel(ctx, first.Name, docker.LabelCache); err != nil || label != kind {
		t.Errorf("cache label = %q, %v, want %q: the volume must survive the Run", label, err, kind)
	}
	folder := toolvolume.KubernetesSchemaMountPath + "/" + toolset.KubernetesSchemaFolder
	out, code := schemaFolderListing(t, base, first.Name, "ls "+folder+" | wc -l")
	if code != 0 || strings.TrimSpace(out) != fmt.Sprint(len(toolset.KubernetesSchemas)) {
		t.Fatalf("the folder holds %q files (exit %d), want %d", strings.TrimSpace(out), code, len(toolset.KubernetesSchemas))
	}

	second, err := toolvolume.EnsureKubernetesSchemas(ctx, schemaConfig(t, base, cache, kind))
	if err != nil {
		t.Fatal(err)
	}
	if second.Fetched || second.Name != first.Name {
		t.Fatalf("second = %+v, want a reuse", second)
	}
}

func TestAFileThatNoLongerMatchesItsChecksumIsFetchedAgain(t *testing.T) {
	base, _ := scoped(t)
	ctx := context.Background()
	cache := t.TempDir()
	kind := fmt.Sprintf("t10x%x", rand.Int63())
	t.Cleanup(func() { removeVolume("jspf-cache-" + kind) })

	first, err := toolvolume.EnsureKubernetesSchemas(ctx, schemaConfig(t, base, cache, kind))
	if err != nil {
		t.Fatal(err)
	}
	// Damage one file from outside, with the volume mounted writable.
	damage := newScope(t, base)
	res, err := damage.RunContainer(ctx, docker.ContainerSpec{
		Name: "damage", Image: toolset.Alpine.Ref(), Network: "none",
		Mounts: []docker.Mount{{Volume: first.Name, Path: toolvolume.KubernetesSchemaMountPath}},
		Cmd:    []string{"sh", "-c", "echo tampered > " + toolvolume.KubernetesSchemaMountPath + "/" + toolset.KubernetesSchemaFolder + "/pod-v1.json"},
	})
	if err != nil || res.ExitCode != 0 {
		t.Fatalf("damage: %+v, %v", res, err)
	}

	again, err := toolvolume.EnsureKubernetesSchemas(ctx, schemaConfig(t, base, cache, kind))
	if err != nil {
		t.Fatal(err)
	}
	if !again.Fetched {
		t.Fatalf("again = %+v, want a new fetch because pod-v1.json was changed", again)
	}
	_, code := schemaFolderListing(t, base, again.Name, "cd "+toolvolume.KubernetesSchemaMountPath+"/"+toolset.KubernetesSchemaFolder+" && grep -q tampered pod-v1.json")
	if code == 0 {
		t.Error("the tampered file is still there")
	}
}

func TestADownloadThatDoesNotMatchTheChecksumIsNeverMovedIntoPlace(t *testing.T) {
	base, _ := scoped(t)
	ctx := context.Background()
	kind := fmt.Sprintf("t10x%x", rand.Int63())
	t.Cleanup(func() { removeVolume("jspf-cache-" + kind) })

	cfg := schemaConfig(t, base, t.TempDir(), kind)
	files := append([]toolset.KubernetesSchemaFile(nil), toolset.KubernetesSchemas...)
	files[1].SHA256 = strings.Repeat("0", 64)
	cfg.Files = files

	got, err := toolvolume.EnsureKubernetesSchemas(ctx, cfg)
	if err == nil {
		t.Fatalf("EnsureKubernetesSchemas = %+v, want an error for a wrong checksum", got)
	}
	if !strings.Contains(err.Error(), "checksum") {
		t.Errorf("error = %v, want it to name the checksum", err)
	}
	_, code := schemaFolderListing(t, base, "jspf-cache-"+kind, "test -e "+toolvolume.KubernetesSchemaMountPath+"/"+toolset.KubernetesSchemaFolder)
	if code == 0 {
		t.Error("an unverified download is in the schema folder")
	}
}
