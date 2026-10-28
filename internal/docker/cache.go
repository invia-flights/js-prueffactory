package docker

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"
)

// Cache volumes outlive a Run. They carry cache labels and never a run label,
// so RemoveRunResources keeps them. Only the toolset ticket uses them so far.

// Label keys of cache volumes.
const (
	LabelCache          = "js-prueffactory.cache"
	LabelToolsetVersion = "js-prueffactory.toolset-version"
)

// CreateCacheVolume creates a volume with the given labels, or does nothing when
// it exists. The volume does not belong to the Run.
func (d *Driver) CreateCacheVolume(ctx context.Context, name string, labels map[string]string) error {
	if !volumeName.MatchString(name) {
		return fmt.Errorf("refusing to create volume %q: not a js-prueffactory name", name)
	}
	args := []string{"volume", "create"}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--label", k+"="+labels[k])
	}
	args = append(args, name)
	_, err := d.output(ctx, nil, args...)
	return err
}

// ListVolumes returns the names of the volumes that match a `docker volume ls`
// filter such as "label=js-prueffactory.cache=toolset".
func (d *Driver) ListVolumes(ctx context.Context, filter string) ([]string, error) {
	out, err := d.output(ctx, nil, "volume", "ls", "--quiet", "--filter", filter)
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(out)), nil
}

// VolumeLabel returns the value of one label of a volume, or "".
func (d *Driver) VolumeLabel(ctx context.Context, name, key string) (string, error) {
	out, err := d.output(ctx, nil, "volume", "inspect", "--format", `{{index .Labels "`+key+`"}}`, name)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// RemoveVolumeIfUnused removes a volume unless a container still uses it, a
// stopped or never-started one included. It reports whether it was removed. A
// volume that is already gone counts as removed.
func (d *Driver) RemoveVolumeIfUnused(ctx context.Context, name string) (bool, error) {
	var out, errb bytes.Buffer
	code, err := d.run(ctx, nil, &out, &errb, "volume", "rm", name)
	if err != nil {
		return false, err
	}
	if code == 0 {
		return true, nil
	}
	msg := errb.String()
	switch {
	case strings.Contains(msg, "in use"):
		return false, nil
	case strings.Contains(msg, "No such volume"):
		return true, nil
	}
	return false, fmt.Errorf("docker volume rm %s failed (exit %d): %s", name, code, lastLine(msg))
}

// Hold creates, without starting it, a run-owned container that mounts a
// volume read-only. Docker treats the volume as in use until the Run's cleanup
// removes the container, so no other Run can delete it in the meantime.
func (d *Driver) Hold(ctx context.Context, suffix, image, volume, mountPath string) error {
	if !volumeName.MatchString(volume) {
		return fmt.Errorf("refusing to hold %q: not a js-prueffactory volume", volume)
	}
	args := []string{"create", "--name", d.Name(suffix), "--pull", "never"}
	args = append(args, d.labels()...)
	args = append(args, "--volume", volume+":"+mountPath+":ro", image, "true")
	_, err := d.output(ctx, nil, args...)
	return err
}
