package docker

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// ServiceSpec describes a Service container: a long-running container, such as
// Valkey, that stays up while the tests of a suite use it.
type ServiceSpec struct {
	Name     string // suffix of the container name, unique within the Run
	Alias    string // host name other containers of the network reach it under
	Image    string // pinned reference, repository@digest
	Env      map[string]string
	Network  string // run-owned network to join
	CPUs     float64
	MemoryMB int64
}

var (
	// aliasName is what a network alias may be: never something that starts
	// like an option.
	aliasName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`)
	envKey    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// containerName is a container this Driver created: jspf-<run-id>-<suffix>.
	containerName = regexp.MustCompile(`^jspf-[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// StartService creates a container with the image's own entrypoint, joins it to
// the network under the alias and starts it. It does not wait for the Service
// to answer: use Exec with the family's probe for that. The returned name
// identifies the container for Exec, Logs and RemoveService.
func (d *Driver) StartService(ctx context.Context, spec ServiceSpec) (string, error) {
	if !aliasName.MatchString(spec.Alias) {
		return "", fmt.Errorf("refusing to start a Service under the name %q", spec.Alias)
	}
	if !volumeName.MatchString(spec.Network) {
		return "", fmt.Errorf("refusing to start a Service on %q: not a run-owned network", spec.Network)
	}
	name := d.Name(spec.Name)
	args := []string{"create", "--name", name, "--pull", "never"}
	args = append(args, d.labels()...)
	args = append(args, hardening()...)
	args = append(args, "--network", spec.Network, "--network-alias", spec.Alias)
	args = append(args, fastLookupFailure()...)
	cpus, memoryMB := spec.CPUs, spec.MemoryMB
	if cpus <= 0 || cpus > toolset.ServiceCPUs {
		cpus = toolset.ServiceCPUs
	}
	if memoryMB <= 0 || memoryMB > toolset.ServiceMemoryMB {
		memoryMB = toolset.ServiceMemoryMB
	}
	args = append(args, "--cpus", fmt.Sprint(cpus), "--memory", fmt.Sprintf("%dm", memoryMB))
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		if !envKey.MatchString(k) {
			return "", fmt.Errorf("refusing to pass the environment variable %q to a Service", k)
		}
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		args = append(args, "--env", k+"="+spec.Env[k])
	}
	args = append(args, spec.Image)
	if _, err := d.output(ctx, nil, args...); err != nil {
		return "", err
	}
	if _, err := d.output(ctx, nil, "start", name); err != nil {
		_ = d.RemoveService(context.WithoutCancel(ctx), name)
		return "", err
	}
	return name, nil
}

// Exec runs a command inside a running container of this Run and returns its
// result. A command that fails is not an error.
func (d *Driver) Exec(ctx context.Context, container string, cmd ...string) (*ContainerResult, error) {
	if !containerName.MatchString(container) {
		return nil, fmt.Errorf("refusing to run a command in %q: not a run-owned container", container)
	}
	var out, errb limitedBuffer
	out.max, errb.max = maxCapture, maxCapture
	args := append([]string{"exec", container}, cmd...)
	code, err := d.run(ctx, nil, &out, &errb, args...)
	if err != nil {
		return nil, fmt.Errorf("docker exec: %w", err)
	}
	if code != 0 && strings.Contains(errb.buf.String(), "No such container") {
		return nil, fmt.Errorf("docker exec: no such container %s", container)
	}
	return &ContainerResult{ExitCode: code, Stdout: out.Bytes(), Stderr: errb.Bytes()}, nil
}

// Running says whether a container of this Run is up. A Service that has
// exited will never pass its probe.
func (d *Driver) Running(ctx context.Context, container string) bool {
	if !containerName.MatchString(container) {
		return false
	}
	out, err := d.output(ctx, nil, "inspect", "--format", "{{.State.Running}}", container)
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

// Logs returns the tail of what a container of this Run printed, for the reason
// a Service did not come up. It never fails; it returns what it could read.
func (d *Driver) Logs(ctx context.Context, container string) string {
	if !containerName.MatchString(container) {
		return ""
	}
	var out limitedBuffer
	out.max = 64 << 10
	_, _ = d.run(ctx, nil, &out, &out, "logs", "--tail", "40", container)
	return strings.TrimSpace(string(out.Bytes()))
}

// RemoveService stops and removes a container of this Run with its anonymous
// volumes. It ignores the caller's cancellation, so a cancelled Run still
// cleans up.
func (d *Driver) RemoveService(ctx context.Context, container string) error {
	if !containerName.MatchString(container) {
		return fmt.Errorf("refusing to remove %q: not a run-owned container", container)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	_, err := d.output(ctx, nil, "rm", "--force", "--volumes", container)
	return err
}

// RemoveNetwork removes a network of this Run. Remove the containers on it
// first.
func (d *Driver) RemoveNetwork(ctx context.Context, network string) error {
	if !volumeName.MatchString(network) {
		return fmt.Errorf("refusing to remove %q: not a run-owned network", network)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	_, err := d.output(ctx, nil, "network", "rm", network)
	return err
}
