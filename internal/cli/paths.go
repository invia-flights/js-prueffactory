package cli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// resolveOriginal returns the absolute path of the project folder with every
// symlink resolved.
func resolveOriginal(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", usagef("cannot resolve %q: %v", path, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", usagef("%q is not a directory: %v", path, err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", usagef("%q is not a directory", path)
	}
	return resolved, nil
}

// outputPlan is where the Report goes.
type outputPlan struct {
	// Dir is the absolute report folder.
	Dir string
	// ExcludeFromSnapshot is set for an explicit folder inside the Original:
	// the resolved folder, which the Snapshot leaves out.
	ExcludeFromSnapshot string
}

// resolveOutput decides the report folder. An explicit --output-dir must not
// exist or be an empty folder, and may lie inside the Original. The default
// folder lies under the state directory and must not lie inside the Original.
// Symlinks are resolved before the "inside the project" test.
func resolveOutput(explicit, original, runID string, getenv func(string) string) (*outputPlan, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return nil, usagef("cannot resolve --output-dir %q: %v", explicit, err)
		}
		if err := requireNewOrEmpty(abs, explicit); err != nil {
			return nil, err
		}
		plan := &outputPlan{Dir: abs}
		if resolved := resolveThroughExisting(abs); within(original, resolved) {
			plan.ExcludeFromSnapshot = resolved
		}
		return plan, nil
	}

	state := getenv("XDG_STATE_HOME")
	if state == "" {
		home := getenv("HOME")
		if home == "" {
			return nil, usagef("cannot find the default report folder: neither XDG_STATE_HOME nor HOME is set; pass --output-dir")
		}
		state = filepath.Join(home, ".local", "state")
	}
	dir := filepath.Join(state, "js-prueffactory", "runs", runID)
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, usagef("cannot resolve the default report folder %q: %v", dir, err)
	}
	if within(original, resolveThroughExisting(abs)) {
		return nil, usagef("the default report folder %s lies inside the project; pass --output-dir to write there on purpose, or set XDG_STATE_HOME elsewhere", abs)
	}
	return &outputPlan{Dir: abs}, nil
}

func requireNewOrEmpty(abs, shown string) error {
	info, err := os.Stat(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return usagef("cannot use --output-dir %q: %v", shown, err)
	}
	if !info.IsDir() {
		return usagef("--output-dir %q exists and is not empty (it is a file)", shown)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return usagef("cannot read --output-dir %q: %v", shown, err)
	}
	if len(entries) > 0 {
		return usagef("--output-dir %q exists and is not empty; a Run never writes into an existing report", shown)
	}
	return nil
}

// resolveThroughExisting resolves symlinks in the longest existing prefix of
// path and appends the rest, so a folder that does not exist yet can still be
// compared with the Original.
func resolveThroughExisting(path string) string {
	var rest []string
	cur := filepath.Clean(path)
	for {
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			for i := len(rest) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, rest[i])
			}
			return resolved
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return path
		}
		rest = append(rest, filepath.Base(cur))
		cur = parent
	}
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
