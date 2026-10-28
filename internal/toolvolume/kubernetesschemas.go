package toolvolume

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// The Kubernetes schemas are the JSON Schemas kubeconform validates built-in
// kinds with. They live in a cache volume of their own, keyed by the Kubernetes
// version, and are fetched in the Preparation phase under a host-side lock.
// Every file is checked against the checksum of the toolset table before it
// enters the schema folder and again each time a Run reuses the volume, so a
// damaged or tampered volume is fetched anew and never read.

const (
	// KubernetesSchemaMountPath is where the schema volume is mounted. The
	// schemas are in its folder toolset.KubernetesSchemaFolder.
	KubernetesSchemaMountPath = "/k8s-schemas"

	// kubernetesStaging is the folder next to the final one that a download
	// is verified in, so the move into place is a rename.
	kubernetesStaging = KubernetesSchemaMountPath + "/.staging"
	// kubernetesSums is where the checksum list is put inside the containers.
	kubernetesSums = "/jspf/schemas.sha256"
	// kubernetesTimeout is the time limit of one download.
	kubernetesTimeout = 5 * time.Minute
	// kubernetesChecksumMarker is what the fetch prints when a download does
	// not match the pinned checksum.
	kubernetesChecksumMarker = "JSPF_SCHEMA_CHECKSUM_MISMATCH"
)

// KubernetesSchemasConfig says what EnsureKubernetesSchemas works on.
type KubernetesSchemasConfig struct {
	// Docker is the Run's driver. The containers belong to the Run; the volume
	// does not.
	Docker *docker.Driver
	// CacheDir is the host folder of js-prueffactory's cache. The lock file
	// lives there.
	CacheDir string
	// Helper is the pinned Alpine image (repository@digest) that downloads and
	// checks the files.
	Helper string
	// Kind is the cache kind of the volume; the default is derived from the
	// Kubernetes version. Tests use their own, so they never touch the volume
	// of a real Run.
	Kind string
	// Files is the schema table; the default is toolset.KubernetesSchemas.
	// Tests use it to feed a wrong checksum.
	Files []toolset.KubernetesSchemaFile
	// Logf receives progress lines. It may be nil.
	Logf func(format string, args ...any)
}

// KubernetesSchemas is the schema volume a Run validates with.
type KubernetesSchemas struct {
	// Name is the volume. Mount it read-only at KubernetesSchemaMountPath.
	Name string
	// Fetched is true when this call downloaded the files, false when it reused
	// the ones an earlier Run had downloaded.
	Fetched bool
}

// kubernetesKind is the cache kind of the schemas of the pinned version, for
// example "kubernetes-schemas-1-34-1".
func kubernetesKind() string {
	return "kubernetes-schemas-" + strings.ReplaceAll(toolset.KubernetesVersion, ".", "-")
}

// EnsureKubernetesSchemas returns the schema volume, fetching the files first
// when the volume lacks one or holds one that no longer matches its checksum.
// It works under a host-side lock, so Runs that start at the same time never
// fetch twice. An unreachable server or a checksum mismatch is an error: unlike
// the advisory data, a file that cannot be verified is of no use.
func EnsureKubernetesSchemas(ctx context.Context, cfg KubernetesSchemasConfig) (*KubernetesSchemas, error) {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	kind := cfg.Kind
	if kind == "" {
		kind = kubernetesKind()
	}
	files := cfg.Files
	if files == nil {
		files = toolset.KubernetesSchemas
	}
	sums, fetch, err := kubernetesScripts(files)
	if err != nil {
		return nil, err
	}

	logf("waiting for the Kubernetes schema lock in %s", cfg.CacheDir)
	l, err := acquire(ctx, filepath.Join(cfg.CacheDir, "kubernetes-schemas.lock"))
	if err != nil {
		return nil, fmt.Errorf("Kubernetes schema lock: %w", err)
	}
	defer l.release()

	d := cfg.Docker
	name, err := d.CacheVolume(ctx, kind)
	if err != nil {
		return nil, err
	}
	sumsFile := docker.File{Path: kubernetesSums, Mode: 0o644, Content: []byte(sums)}

	probe, err := d.RunContainer(ctx, docker.ContainerSpec{
		Name: "k8s-schemas-probe", Image: cfg.Helper, Network: docker.NetworkNone,
		Mounts: []docker.Mount{{Volume: name, Path: KubernetesSchemaMountPath, ReadOnly: true}},
		Files:  []docker.File{sumsFile},
		Cmd:    []string{"sh", "-c", "cd " + KubernetesSchemaMountPath + "/" + toolset.KubernetesSchemaFolder + " && sha256sum -c " + kubernetesSums},
	})
	if err != nil {
		return nil, fmt.Errorf("cannot inspect the Kubernetes schema volume: %w", err)
	}
	if probe.ExitCode == 0 {
		logf("reusing the Kubernetes %s schemas in volume %s", toolset.KubernetesVersion, name)
		return &KubernetesSchemas{Name: name}, nil
	}

	logf("fetching the Kubernetes %s schemas into volume %s", toolset.KubernetesVersion, name)
	ctx, cancel := context.WithTimeout(ctx, kubernetesTimeout)
	defer cancel()
	// The default bridge network: the Preparation phase has outbound access
	// (ADR-0004), and this download is the only reason this container exists.
	res, err := d.RunContainer(ctx, docker.ContainerSpec{
		Name: "k8s-schemas-fetch", Image: cfg.Helper, Preparation: true,
		Mounts: []docker.Mount{{Volume: name, Path: KubernetesSchemaMountPath}},
		Files:  []docker.File{sumsFile},
		Cmd:    []string{"sh", "-c", fetch},
	})
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return nil, fmt.Errorf("the Kubernetes schema download took longer than %s", kubernetesTimeout)
	case err != nil:
		return nil, fmt.Errorf("the Kubernetes schema download: %w", err)
	case res.ExitCode != 0:
		stderr := lastLines(string(res.Stderr), 3)
		if strings.Contains(stderr, kubernetesChecksumMarker) {
			return nil, fmt.Errorf("a Kubernetes schema does not match its pinned checksum: %s", stderr)
		}
		return nil, fmt.Errorf("the Kubernetes schema download failed (exit %d): %s", res.ExitCode, stderr)
	}
	logf("fetched the Kubernetes %s schemas", toolset.KubernetesVersion)
	return &KubernetesSchemas{Name: name, Fetched: true}, nil
}

// kubernetesScripts returns the checksum list (`sha256sum -c` format) and the
// fetch script of a schema table. The script downloads every file into the
// staging folder, checks the list there, and only then moves the folder into
// place. Every word that reaches the script is checked first, so that it can
// sit in single quotes without any escaping.
func kubernetesScripts(files []toolset.KubernetesSchemaFile) (sums, fetch string, err error) {
	if len(files) == 0 {
		return "", "", errors.New("toolvolume: the Kubernetes schema table is empty")
	}
	var list, script strings.Builder
	script.WriteString("set -e; rm -rf " + kubernetesStaging + " && mkdir -p " + kubernetesStaging + " && cd " + kubernetesStaging + " && ")
	for _, f := range files {
		name := f.Name()
		if !safeWord.MatchString(f.Raw) || !safeWord.MatchString(f.SHA256) || !safeWord.MatchString(name) || !strings.HasPrefix(f.Raw, "https://") {
			return "", "", fmt.Errorf("toolvolume: the Kubernetes schema %q is not usable", f.Raw)
		}
		fmt.Fprintf(&list, "%s  %s\n", f.SHA256, name)
		fmt.Fprintf(&script, "wget -q -O '%s' '%s' && ", name, f.Raw)
	}
	script.WriteString(`{ sha256sum -c ` + kubernetesSums + ` >/dev/null 2>&1 || { echo "` + kubernetesChecksumMarker + `: a downloaded schema does not match its pinned checksum" >&2; exit 1; }; } && `)
	final := KubernetesSchemaMountPath + "/" + toolset.KubernetesSchemaFolder
	script.WriteString("rm -rf " + final + " && mv " + kubernetesStaging + " " + final)
	return list.String(), script.String(), nil
}
