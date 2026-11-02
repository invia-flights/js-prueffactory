import { isAbs, join, tempDir } from "../gocompat/filepath.ts";

/**
 * cacheDir returns the host folder for js-prueffactory's caches:
 * ${XDG_CACHE_HOME:-~/.cache}/js-prueffactory. It holds the lock file that
 * protects the shared Docker cache volumes. Without XDG_CACHE_HOME and HOME it
 * falls back to the temporary folder (Go's os.TempDir, which reads the
 * process's own TMPDIR), so the lock still works within the host.
 */
export function cacheDir(getenv: (name: string) => string): string {
  const base = getenv("XDG_CACHE_HOME");
  if (isAbs(base)) {
    return join(base, "js-prueffactory");
  }
  const home = getenv("HOME");
  if (isAbs(home)) {
    return join(home, ".cache", "js-prueffactory");
  }
  return join(tempDir(), "js-prueffactory-cache");
}
