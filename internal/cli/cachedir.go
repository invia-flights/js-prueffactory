package cli

import (
	"os"
	"path/filepath"
)

// cacheDir returns the host folder for js-prueffactory's caches:
// ${XDG_CACHE_HOME:-~/.cache}/js-prueffactory. It holds the lock file that
// protects the shared Docker cache volumes. Without XDG_CACHE_HOME and HOME it
// falls back to the temporary folder, so the lock still works within the host.
func cacheDir(getenv func(string) string) string {
	if base := getenv("XDG_CACHE_HOME"); filepath.IsAbs(base) {
		return filepath.Join(base, "js-prueffactory")
	}
	if home := getenv("HOME"); filepath.IsAbs(home) {
		return filepath.Join(home, ".cache", "js-prueffactory")
	}
	return filepath.Join(os.TempDir(), "js-prueffactory-cache")
}
