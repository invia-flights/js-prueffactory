// Package docker is a thin wrapper over the `docker` command-line tool
// (ADR-0002). It creates and removes the volumes, networks and containers of
// one Run, streams tar archives into volumes and out of containers, and labels
// everything so it can be found and removed again.
//
// The API deliberately has no way to mount a host folder (ADR-0001): a
// container mount names a run-owned volume, and data reaches a volume or a
// container only as a tar stream.
package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// Label keys stamped on every run-owned resource.
const (
	LabelRunID    = "js-prueffactory.run-id"
	LabelHost     = "js-prueffactory.host"
	LabelPID      = "js-prueffactory.pid"
	LabelDeadline = "js-prueffactory.deadline"
)

// Scope identifies the Run that owns what a Driver creates.
type Scope struct {
	RunID string
	Host  string
	PID   int
	// Deadline is the start time plus the Budget plus ten minutes. Leftovers of
	// other Runs are removed once it has passed.
	Deadline time.Time
}

// Driver calls the docker CLI.
type Driver struct {
	exe   string
	env   []string
	scope Scope
	seq   *atomic.Int64
}

// envKeys are the only variables handed to the docker CLI: enough for contexts,
// credential helpers and DOCKER_HOST, nothing else of the host environment.
var envKeys = []string{
	"PATH", "HOME", "USER", "TMPDIR", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
	"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY",
	"DOCKER_CERT_PATH", "DOCKER_API_VERSION", "DOCKER_DEFAULT_PLATFORM",
}

// Env builds the CLI environment from an environment lookup.
func Env(getenv func(string) string) []string {
	var out []string
	for _, k := range envKeys {
		if v := getenv(k); v != "" {
			out = append(out, k+"="+v)
		}
	}
	return out
}

// Locate finds the docker executable on the PATH the lookup reports.
func Locate(getenv func(string) string) (string, error) {
	for _, dir := range filepath.SplitList(getenv("PATH")) {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, "docker")
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", errors.New("the docker CLI was not found on PATH; install Docker or make `docker` available")
}

// New returns a Driver for the CLI at exe running with the given environment.
func New(exe string, env []string) *Driver {
	return &Driver{exe: exe, env: env, seq: new(atomic.Int64)}
}

// WithScope returns a Driver whose resources belong to the Run of scope.
func (d *Driver) WithScope(scope Scope) *Driver {
	c := *d
	c.scope = scope
	return &c
}

// Name returns the name of a run-owned resource: jspf-<run-id>-<suffix>.
func (d *Driver) Name(suffix string) string { return "jspf-" + d.scope.RunID + "-" + suffix }

func (d *Driver) labels() []string {
	return []string{
		"--label", LabelRunID + "=" + d.scope.RunID,
		"--label", LabelHost + "=" + d.scope.Host,
		"--label", fmt.Sprintf("%s=%d", LabelPID, d.scope.PID),
		"--label", LabelDeadline + "=" + d.scope.Deadline.UTC().Format(time.RFC3339),
	}
}

// RunFilter is the label filter that selects every resource of this Run.
func (d *Driver) runFilter() string { return "label=" + LabelRunID + "=" + d.scope.RunID }

// run executes the docker CLI. A non-zero exit is not an error here.
func (d *Driver) run(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer, args ...string) (int, error) {
	cmd := exec.CommandContext(ctx, d.exe, args...)
	cmd.Env = d.env
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return -1, ctx.Err()
		}
		return -1, err
	}
	return 0, nil
}

// output runs the CLI and returns its output, failing on a non-zero exit.
func (d *Driver) output(ctx context.Context, stdin io.Reader, args ...string) ([]byte, error) {
	var out, errb bytes.Buffer
	code, err := d.run(ctx, stdin, &out, &errb, args...)
	if err != nil {
		return nil, fmt.Errorf("docker %s: %w", args[0], err)
	}
	if code != 0 {
		return nil, fmt.Errorf("docker %s failed (exit %d): %s", strings.Join(args[:min(2, len(args))], " "), code, lastLine(errb.String()))
	}
	return out.Bytes(), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// Info is what the Docker daemon reports about itself.
type Info struct {
	ServerVersion string
	APIVersion    string
	CPUs          int
	MemoryBytes   int64
	OS            string
	Arch          string
}

// Preflight checks that the daemon is reachable and reads its facts.
func (d *Driver) Preflight(ctx context.Context) (*Info, error) {
	var out, errb bytes.Buffer
	code, err := d.run(ctx, nil, &out, &errb, "info", "--format", "{{json .}}")
	if err != nil {
		return nil, fmt.Errorf("cannot run docker: %w", err)
	}
	if code != 0 {
		return nil, fmt.Errorf("the Docker daemon is not reachable: %s", daemonProblem(errb.String()))
	}
	var raw struct {
		ServerVersion string
		NCPU          int
		MemTotal      int64
		OSType        string
		Architecture  string
	}
	if err := json.Unmarshal(out.Bytes(), &raw); err != nil {
		return nil, fmt.Errorf("cannot read `docker info` output: %w", err)
	}
	info := &Info{ServerVersion: raw.ServerVersion, CPUs: raw.NCPU, MemoryBytes: raw.MemTotal, OS: raw.OSType, Arch: raw.Architecture}

	vout, err := d.output(ctx, nil, "version", "--format", "{{json .Server}}")
	if err != nil {
		return nil, fmt.Errorf("the Docker daemon is not reachable: %w", err)
	}
	var ver struct{ ApiVersion string }
	if err := json.Unmarshal(vout, &ver); err != nil {
		return nil, fmt.Errorf("cannot read `docker version` output: %w", err)
	}
	info.APIVersion = ver.ApiVersion
	if !apiAtLeast(info.APIVersion, MinAPIVersion) {
		return nil, fmt.Errorf("the Docker daemon speaks API %s, but js-prueffactory needs API %s or newer (Docker Engine 20.10); update Docker", info.APIVersion, MinAPIVersion)
	}
	return info, nil
}

// MinAPIVersion is the oldest Docker Engine API version js-prueffactory
// supports: the one of Docker Engine 20.10, which has everything the driver
// uses (label filters, internal networks, tar streams through `docker cp -`).
const MinAPIVersion = "1.41"

// apiAtLeast compares "major.minor" API versions. An unreadable version is
// treated as too old.
func apiAtLeast(have, want string) bool {
	parse := func(v string) (int, int, bool) {
		var maj, min int
		if _, err := fmt.Sscanf(v, "%d.%d", &maj, &min); err != nil {
			return 0, 0, false
		}
		return maj, min, true
	}
	hm, hn, ok1 := parse(have)
	wm, wn, ok2 := parse(want)
	if !ok1 || !ok2 {
		return false
	}
	return hm > wm || (hm == wm && hn >= wn)
}

func daemonProblem(stderr string) string {
	for _, l := range strings.Split(stderr, "\n") {
		if strings.Contains(l, "Cannot connect") || strings.Contains(l, "failed to connect") || strings.Contains(l, "error during connect") {
			return strings.TrimSpace(l)
		}
	}
	return lastLine(stderr)
}

// Pull makes sure an image is present locally. Images are pulled by digest, so
// an image that exists is exactly the pinned one.
func (d *Driver) Pull(ctx context.Context, ref string) error {
	if _, err := d.output(ctx, nil, "image", "inspect", "--format", "{{.Id}}", ref); err == nil {
		return nil
	} else if ctx.Err() != nil {
		return err
	}
	if _, err := d.output(ctx, nil, "pull", "--quiet", ref); err != nil {
		return fmt.Errorf("cannot pull %s: %w", ref, err)
	}
	return nil
}

// CreateVolume creates a run-owned volume and returns its name.
func (d *Driver) CreateVolume(ctx context.Context, suffix string) (string, error) {
	name := d.Name(suffix)
	args := append([]string{"volume", "create"}, d.labels()...)
	args = append(args, name)
	if _, err := d.output(ctx, nil, args...); err != nil {
		return "", err
	}
	return name, nil
}

var cacheKind = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// CacheVolume makes sure the cache volume of a kind, such as "npm", exists and
// returns its name, jspf-cache-<kind>. The volume carries the cache label with
// the kind as its value (see CreateCacheVolume) and survives between Runs.
// Creating a volume that exists is harmless, so concurrent Runs may call it at
// the same time.
func (d *Driver) CacheVolume(ctx context.Context, kind string) (string, error) {
	if !cacheKind.MatchString(kind) {
		return "", fmt.Errorf("%q is not a valid cache kind", kind)
	}
	name := "jspf-cache-" + kind
	if err := d.CreateCacheVolume(ctx, name, map[string]string{LabelCache: kind}); err != nil {
		return "", err
	}
	return name, nil
}

// CreateNetwork creates a run-owned network and returns its name. An internal
// network has no route to the outside.
func (d *Driver) CreateNetwork(ctx context.Context, suffix string, internal bool) (string, error) {
	name := d.Name(suffix)
	args := []string{"network", "create"}
	if internal {
		args = append(args, "--internal")
	}
	args = append(args, d.labels()...)
	args = append(args, name)
	if _, err := d.output(ctx, nil, args...); err != nil {
		return "", err
	}
	return name, nil
}

// Mount attaches a run-owned volume to a container.
type Mount struct {
	Volume   string
	Path     string // absolute path inside the container
	ReadOnly bool
}

// File is a file copied into a container before it starts.
type File struct {
	Path    string // absolute path inside the container
	Mode    int64
	Content []byte
}

// ContainerSpec describes one short-lived container.
type ContainerSpec struct {
	Name    string // suffix of the container name, unique within the Run
	Image   string // pinned reference, repository@digest
	Cmd     []string
	Env     map[string]string
	WorkDir string
	// Network is the run-owned network to join, or NetworkNone. It must be set
	// unless Preparation is: an empty network would silently mean Docker's
	// default bridge, with outbound access (ADR-0004).
	Network string
	// Preparation marks a container of the Preparation phase (npm install, the
	// toolset and advisory-database downloads), the only containers that have
	// outbound access. It joins the default bridge and must not name a Network.
	Preparation bool
	Mounts      []Mount
	Files       []File
	CPUs        float64
	MemoryMB    int64
	// EndMarker, when set, lets the container announce that its work is done
	// and gives its process a grace period to exit after that.
	EndMarker *EndMarker
	// Entrypoint replaces the image's entrypoint when set, for an image that
	// bundles a second tool next to the one it starts by default.
	Entrypoint string
}

// ContainerResult is what a finished container left behind.
type ContainerResult struct {
	ExitCode  int
	OOMKilled bool
	Stdout    []byte
	Stderr    []byte
	// StoppedAfterGrace is true when the container announced the end of its
	// work with the spec's EndMarker, kept running for the whole grace period
	// and was stopped by the driver.
	StoppedAfterGrace bool
}

var volumeName = regexp.MustCompile(`^jspf-[A-Za-z0-9][A-Za-z0-9_.-]*$`)

const maxCapture = 32 << 20

// NetworkNone is the Network of a container that needs no network at all.
const NetworkNone = "none"

// maxPIDs bounds the processes of one container, so a fork bomb in project code
// cannot exhaust the host.
const maxPIDs = 4096

// keptCapabilities are what a container keeps of Docker's default capabilities.
// npm installs as root (chown, setuid/setgid for tools that drop privileges),
// and Service images start as root and step down to their own user. Everything
// else goes: no raw sockets, no mknod, no chroot, no audit, no changing of file
// capabilities.
var keptCapabilities = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID"}

// hardening are the create flags every container gets: no gaining of privileges
// through setuid binaries, a reduced capability set and a bound on the number
// of processes.
func hardening() []string {
	args := []string{"--security-opt", "no-new-privileges", "--pids-limit", fmt.Sprint(maxPIDs), "--cap-drop", "ALL"}
	for _, c := range keptCapabilities {
		args = append(args, "--cap-add", c)
	}
	return args
}

// fastLookupFailure are the resolver options of every container on the Run's
// internal network. There, a lookup of a host that is not a Run Service takes
// 5 s and ends in EAI_AGAIN by default, which turns a test that calls out into
// a Mocha timeout instead of a connection error. One attempt of one second
// makes it fail after about 1.1 s; Run Service names still resolve at once
// (ADR-0004).
func fastLookupFailure() []string {
	return []string{"--dns-opt", "timeout:1", "--dns-opt", "attempts:1"}
}

// networkArgs returns the --network flags for a spec, or an error if the spec
// does not make its network access explicit.
func networkArgs(spec ContainerSpec) ([]string, error) {
	switch {
	case spec.Preparation && spec.Network != "":
		return nil, errors.New("a container is either a Preparation container on the default bridge or on a named network, not both: the network must be explicit")
	case spec.Preparation:
		return nil, nil
	case spec.Network == NetworkNone:
		return []string{"--network", spec.Network}, nil
	case volumeName.MatchString(spec.Network):
		return append([]string{"--network", spec.Network}, fastLookupFailure()...), nil
	case spec.Network == "":
		return nil, errors.New("the container names no network and is not a Preparation container: the network must be explicit (ADR-0004)")
	}
	return nil, fmt.Errorf("refusing to join the network %q: a container may only join a run-owned network or none", spec.Network)
}

// RunContainer creates a container, copies the spec's files into it, runs it to
// completion and removes it again, whatever happens.
func (d *Driver) RunContainer(ctx context.Context, spec ContainerSpec) (*ContainerResult, error) {
	for _, m := range spec.Mounts {
		if !volumeName.MatchString(m.Volume) {
			return nil, fmt.Errorf("refusing to mount %q: containers may only mount run-owned volumes, never host paths", m.Volume)
		}
	}
	netArgs, err := networkArgs(spec)
	if err != nil {
		return nil, err
	}
	for k := range spec.Env {
		if !envKey.MatchString(k) {
			return nil, fmt.Errorf("refusing to pass the environment variable %q to a container", k)
		}
	}
	suffix := spec.Name
	if suffix == "" {
		suffix = fmt.Sprintf("c%d", d.seq.Add(1))
	}
	name := d.Name(suffix)

	args := []string{"create", "--name", name, "--pull", "never"}
	args = append(args, d.labels()...)
	args = append(args, hardening()...)
	args = append(args, netArgs...)
	// Every container is limited, whatever the caller asks for.
	cpus, memoryMB := spec.CPUs, spec.MemoryMB
	if cpus <= 0 || cpus > toolset.ContainerCPUs {
		cpus = toolset.ContainerCPUs
	}
	if memoryMB <= 0 || memoryMB > toolset.ContainerMemoryMB {
		memoryMB = toolset.ContainerMemoryMB
	}
	args = append(args, "--cpus", fmt.Sprint(cpus), "--memory", fmt.Sprintf("%dm", memoryMB))
	if spec.WorkDir != "" {
		args = append(args, "--workdir", spec.WorkDir)
	}
	for _, m := range spec.Mounts {
		v := m.Volume + ":" + m.Path
		if m.ReadOnly {
			v += ":ro"
		}
		args = append(args, "--volume", v)
	}
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		args = append(args, "--env", k+"="+spec.Env[k])
	}
	if spec.Entrypoint != "" {
		args = append(args, "--entrypoint", spec.Entrypoint)
	}
	args = append(args, spec.Image)
	args = append(args, spec.Cmd...)

	if _, err := d.output(ctx, nil, args...); err != nil {
		return nil, err
	}
	defer d.removeContainer(name)

	if len(spec.Files) > 0 {
		if err := d.copyIn(ctx, name, spec.Files); err != nil {
			return nil, err
		}
	}

	var out, errb limitedBuffer
	out.max, errb.max = maxCapture, maxCapture
	var stdout, stderr io.Writer = &out, &errb
	var grace *graceStop
	if spec.EndMarker != nil && spec.EndMarker.Text != "" {
		grace = &graceStop{marker: *spec.EndMarker, stop: func() { d.stopContainer(name) }}
		defer grace.cancel()
		m := []byte(spec.EndMarker.Text)
		stdout = &markerWriter{dst: &out, marker: m, onSeen: grace.seen}
		stderr = &markerWriter{dst: &errb, marker: m, onSeen: grace.seen}
	}
	if _, err := d.run(ctx, nil, stdout, stderr, "start", "--attach", name); err != nil {
		return nil, err
	}
	if grace != nil {
		grace.cancel()
	}
	inspect, err := d.output(ctx, nil, "inspect", "--format", "{{json .State}}", name)
	if err != nil {
		return nil, err
	}
	var state struct {
		ExitCode  int
		OOMKilled bool
	}
	if err := json.Unmarshal(inspect, &state); err != nil {
		return nil, fmt.Errorf("cannot read container state: %w", err)
	}
	res := &ContainerResult{ExitCode: state.ExitCode, OOMKilled: state.OOMKilled, Stdout: out.Bytes(), Stderr: errb.Bytes()}
	if grace != nil {
		m := []byte(spec.EndMarker.Text)
		res.Stdout, res.Stderr = stripMarker(res.Stdout, m), stripMarker(res.Stderr, m)
		res.StoppedAfterGrace = grace.didStop()
	}
	return res, nil
}

func (d *Driver) removeContainer(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, _ = d.output(ctx, nil, "rm", "--force", "--volumes", name)
}

func (d *Driver) copyIn(ctx context.Context, container string, files []File) error {
	data, err := TarFiles(files)
	if err != nil {
		return err
	}
	_, err = d.output(ctx, bytes.NewReader(data), "cp", "-", container+":/")
	return err
}

// PutTar streams a tar archive into a run-owned volume. It uses a short-lived
// container, created from image but never started, that has the volume mounted.
func (d *Driver) PutTar(ctx context.Context, volume, image string, writeTar func(io.Writer) error) error {
	if !volumeName.MatchString(volume) {
		return fmt.Errorf("refusing to write into %q: not a run-owned volume", volume)
	}
	name := d.Name(fmt.Sprintf("loader%d", d.seq.Add(1)))
	args := []string{"create", "--name", name, "--pull", "never"}
	args = append(args, d.labels()...)
	args = append(args, hardening()...)
	args = append(args, "--network", NetworkNone, "--volume", volume+":/volume", image, "true")
	if _, err := d.output(ctx, nil, args...); err != nil {
		return err
	}
	defer d.removeContainer(name)

	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(writeTar(pw)) }()
	_, err := d.output(ctx, pr, "cp", "-", name+":/volume")
	pr.CloseWithError(err)
	return err
}

// RemoveRunResources removes every container, network and volume that carries
// this Run's label. It ignores the caller's cancellation so a cancelled Run
// still cleans up.
func (d *Driver) RemoveRunResources(ctx context.Context) error {
	ctx = context.WithoutCancel(ctx)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var errs []error
	kinds := []struct {
		list []string
		rm   []string
	}{
		{[]string{"ps", "--all", "--quiet", "--filter", d.runFilter()}, []string{"rm", "--force", "--volumes"}},
		{[]string{"network", "ls", "--quiet", "--filter", d.runFilter()}, []string{"network", "rm"}},
		{[]string{"volume", "ls", "--quiet", "--filter", d.runFilter()}, []string{"volume", "rm", "--force"}},
	}
	for _, k := range kinds {
		out, err := d.output(ctx, nil, k.list...)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		ids := strings.Fields(string(out))
		if len(ids) == 0 {
			continue
		}
		if _, err := d.output(ctx, nil, append(k.rm, ids...)...); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// limitedBuffer keeps at most max bytes and drops the rest.
type limitedBuffer struct {
	buf bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

func (b *limitedBuffer) Bytes() []byte { return b.buf.Bytes() }
