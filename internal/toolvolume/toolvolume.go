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

const (
	// MountPath is where checks mount the toolset volume.
	MountPath = "/toolset"
	// volumePrefix starts the name of every toolset volume.
	volumePrefix = "jspf-toolset-"
	// completeMarker is written as the last step of an install. Its content is
	// the toolset version, so a half-filled volume is never mistaken for a
	// finished one.
	completeMarker = ".jspf-complete"
	// installTimeout is the time limit of one install.
	installTimeout = 15 * time.Minute
	// ToolBin is the folder that holds the installed tools' packages.
	ToolBin = MountPath + "/node_modules"
	// HelmBin is the Helm binary the install downloads. It is a static binary
	// that runs in the pinned Alpine image.
	HelmBin = MountPath + "/bin/helm"
)

// Config says what Ensure works on.
type Config struct {
	// Docker is the Run's driver. The install and holding containers belong to
	// the Run; the volume does not.
	Docker *docker.Driver
	// CacheDir is the host folder of js-prueffactory's cache, such as
	// ~/.cache/js-prueffactory. The lock file lives there.
	CacheDir string
	// Version is the toolset version; the default is toolset.Version().
	Version string
	// Image is the pinned Node image that installs the tools (repository@digest).
	Image string
	// Helm is the Helm release to install; the default is toolset.Helm. Tests
	// use it to feed a wrong checksum.
	Helm *toolset.HelmBinary
	// Logf receives progress lines. It may be nil.
	Logf func(format string, args ...any)
}

// Volume is the toolset volume a Run uses.
type Volume struct {
	Name string
	// Installed is true when this call filled the volume, false when it reused
	// one that an earlier Run had filled.
	Installed bool
}

// VolumeName returns the name of the toolset volume of a toolset version.
func VolumeName(version string) string { return volumePrefix + version }

// Ensure returns the toolset volume of the toolset version, filling it first if
// it does not exist yet. It works under a host-side lock, so Runs that start at
// the same time never fill the same volume twice. It also keeps the volume in
// use by the Run until the Run's cleanup, and removes the toolset volumes of
// other versions that nothing uses.
func Ensure(ctx context.Context, cfg Config) (*Volume, error) {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	version := cfg.Version
	if version == "" {
		version = toolset.Version()
	}
	name := VolumeName(version)
	d := cfg.Docker

	logf("waiting for the toolset lock in %s", cfg.CacheDir)
	l, err := acquire(ctx, filepath.Join(cfg.CacheDir, "toolset.lock"))
	if err != nil {
		return nil, fmt.Errorf("toolset lock: %w", err)
	}
	defer l.release()

	if err := createLabelled(ctx, d, name, version); err != nil {
		return nil, err
	}
	vol := &Volume{Name: name}

	complete, err := isComplete(ctx, cfg, name, version)
	if err != nil {
		return nil, err
	}
	if complete {
		logf("reusing toolset volume %s", name)
	} else {
		logf("installing toolset %s into volume %s", version, name)
		if err := install(ctx, cfg, name, version); err != nil {
			// A half-filled volume must not stay for the next Run to trip over.
			_, _ = d.RemoveVolumeIfUnused(context.WithoutCancel(ctx), name)
			return nil, err
		}
		vol.Installed = true
		logf("installed toolset %s", version)
	}

	// Hold the volume before the lock is released, so a Run of another binary
	// version cannot remove it between this install and the checks' use.
	if err := d.Hold(ctx, "toolset-hold", cfg.Image, name, MountPath); err != nil {
		return nil, err
	}
	removeOtherVersions(ctx, cfg, name, logf)
	return vol, nil
}

// createLabelled creates the toolset volume with its cache labels. Docker
// creates a missing volume without labels when a container mounts it, and
// `volume create` leaves an existing volume as it is. A volume of our name
// without our label is therefore replaced, so the cleanup of old toolset
// versions can always find it.
func createLabelled(ctx context.Context, d *docker.Driver, name, version string) error {
	labels := map[string]string{docker.LabelCache: "toolset", docker.LabelToolsetVersion: version}
	for attempt := 0; attempt < 2; attempt++ {
		if err := d.CreateCacheVolume(ctx, name, labels); err != nil {
			return err
		}
		got, err := d.VolumeLabel(ctx, name, docker.LabelCache)
		if err != nil {
			return err
		}
		if got == "toolset" {
			return nil
		}
		removed, err := d.RemoveVolumeIfUnused(ctx, name)
		if err != nil {
			return err
		}
		if !removed {
			return fmt.Errorf("the volume %s exists without js-prueffactory's labels and is in use, so it cannot be replaced", name)
		}
	}
	return fmt.Errorf("cannot create the toolset volume %s with its labels", name)
}

func isComplete(ctx context.Context, cfg Config, volume, version string) (bool, error) {
	res, err := cfg.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "toolset-probe", Image: cfg.Image, Network: "none",
		Env:    map[string]string{"JSPF_TOOLSET_VERSION": version},
		Mounts: []docker.Mount{{Volume: volume, Path: MountPath, ReadOnly: true}},
		Cmd:    []string{"sh", "-c", `test "$(cat ` + MountPath + `/` + completeMarker + ` 2>/dev/null)" = "$JSPF_TOOLSET_VERSION"`},
	})
	if err != nil {
		return false, fmt.Errorf("cannot inspect the toolset volume: %w", err)
	}
	return res.ExitCode == 0, nil
}

func install(ctx context.Context, cfg Config, volume, version string) error {
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()

	npmCI := "npm ci --no-audit --no-fund"
	if !toolset.InstallScripts() {
		npmCI += " --ignore-scripts"
	}
	helm := toolset.Helm
	if cfg.Helm != nil {
		helm = *cfg.Helm
	}
	script := npmCI + " && " + helmInstallScript(helm) + ` && printf %s "$JSPF_TOOLSET_VERSION" > ` + MountPath + `/` + completeMarker

	// The default bridge network: the Preparation phase has outbound access
	// (ADR-0004), and this is the only step that needs it for the tools.
	res, err := cfg.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "toolset-install", Image: cfg.Image, Preparation: true,
		Env: map[string]string{
			"JSPF_TOOLSET_VERSION":       version,
			"NPM_CONFIG_UPDATE_NOTIFIER": "false",
		},
		WorkDir: MountPath,
		Mounts:  []docker.Mount{{Volume: volume, Path: MountPath}},
		Files: []docker.File{
			{Path: MountPath + "/package.json", Mode: 0o644, Content: toolset.NPMManifest()},
			{Path: MountPath + "/package-lock.json", Mode: 0o644, Content: toolset.NPMLockfile()},
		},
		Cmd: []string{"sh", "-c", script},
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("installing the tools took longer than %s", installTimeout)
		}
		return fmt.Errorf("cannot install the tools: %w", err)
	}
	if res.ExitCode != 0 {
		if strings.Contains(string(res.Stderr), helmChecksumMarker) {
			return fmt.Errorf("the Helm %s download failed its checksum check, so it was not installed: %s", helm.Version, lastLines(string(res.Stderr), 3))
		}
		return fmt.Errorf("installing the tools failed (exit %d): %s", res.ExitCode, lastLines(string(res.Stderr), 3))
	}
	return nil
}

// cleanupLockWait is how long the cleanup at the start of a Run waits for the
// toolset lock before it gives up for this Run.
const cleanupLockWait = 5 * time.Second

// CleanOtherVersions removes the toolset volumes of other toolset versions at
// the start of a Run, whether or not the Run needs the toolset at all. It never
// removes the current version's volume, and `docker volume rm` leaves any
// volume that a container uses, so a volume held by a live Run stays. It works
// under the same lock as Ensure, so it cannot remove the volume of a Run that
// is just creating it and has not held it yet. If another Run holds the lock
// (it may be installing for minutes), this one does not wait: that Run's
// Ensure does the cleanup itself. It never fails the Run.
func CleanOtherVersions(ctx context.Context, cfg Config) {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	version := cfg.Version
	if version == "" {
		version = toolset.Version()
	}
	waitCtx, cancel := context.WithTimeout(ctx, cleanupLockWait)
	defer cancel()
	l, err := acquire(waitCtx, filepath.Join(cfg.CacheDir, "toolset.lock"))
	if err != nil {
		if ctx.Err() == nil {
			logf("not cleaning up old toolset volumes now: the toolset lock is busy")
		}
		return
	}
	defer l.release()
	removeOtherVersions(ctx, cfg, VolumeName(version), logf)
}

// removeOtherVersions removes the toolset volumes of other toolset versions.
// Docker refuses to remove a volume that a container uses, and such a volume
// belongs to a live Run, so it is left alone.
func removeOtherVersions(ctx context.Context, cfg Config, keep string, logf func(string, ...any)) {
	names, err := cfg.Docker.ListVolumes(ctx, "label="+docker.LabelCache+"=toolset")
	if err != nil {
		logf("warning: cannot list toolset volumes: %v", err)
		return
	}
	for _, n := range names {
		if n == keep || !strings.HasPrefix(n, volumePrefix) {
			continue
		}
		removed, err := cfg.Docker.RemoveVolumeIfUnused(ctx, n)
		switch {
		case err != nil:
			logf("warning: cannot remove the toolset volume %s of another version: %v", n, err)
		case removed:
			logf("removed the toolset volume %s of another version", n)
		}
	}
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
