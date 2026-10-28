package lockfile_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

func writeFiles(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLoadAnNpmPackageWithAVersion3LockfileIsUsable(t *testing.T) {
	l := lockfile.Load(writeFiles(t, map[string]string{
		"package.json": `{"dependencies": {"a": "^1.0.0"}}`, "package-lock.json": v3Lock,
	}))
	if l.Unsupported != nil || l.Lock == nil || l.Manifest == nil || l.ManifestErr != nil || l.LockErr != nil {
		t.Fatalf("l = %+v", l)
	}
	if l.LockfileName != "package-lock.json" {
		t.Errorf("LockfileName = %q", l.LockfileName)
	}
}

func TestLoadVersion1LockfileIsUnsupportedWithTheReason(t *testing.T) {
	l := lockfile.Load(writeFiles(t, map[string]string{
		"package.json": `{}`, "package-lock.json": `{"lockfileVersion": 1}`,
	}))
	if l.Lock != nil || l.LockErr != nil || l.Unsupported == nil {
		t.Fatalf("l = %+v", l)
	}
	if l.Unsupported.Code != "lockfile_version_unsupported" || l.Unsupported.Reason == "" {
		t.Errorf("Unsupported = %+v", l.Unsupported)
	}
}

func TestLoadABrokenLockfileIsAnErrorNotUnsupported(t *testing.T) {
	l := lockfile.Load(writeFiles(t, map[string]string{
		"package.json": `{}`, "package-lock.json": `{"lockfileVersion": 3,`,
	}))
	if l.LockErr == nil || l.Unsupported == nil || l.Unsupported.Code != "lockfile_invalid" {
		t.Fatalf("l = %+v", l)
	}
}

func TestLoadWithoutALockfileHasNothingToReadButNoError(t *testing.T) {
	l := lockfile.Load(writeFiles(t, map[string]string{"package.json": `{}`}))
	if l.Lock != nil || l.LockErr != nil || l.Unsupported == nil || l.Unsupported.Code != "no_lockfile" {
		t.Fatalf("l = %+v", l)
	}
}

func TestLoadOtherManagersAndWorkspacesAreUnsupported(t *testing.T) {
	pnpm := lockfile.Load(writeFiles(t, map[string]string{"package.json": `{}`, "pnpm-lock.yaml": "x"}))
	if pnpm.Unsupported == nil || pnpm.Unsupported.Code != "package_manager_unsupported" {
		t.Errorf("pnpm: %+v", pnpm.Unsupported)
	}
	ws := lockfile.Load(writeFiles(t, map[string]string{
		"package.json": `{"workspaces": ["a"]}`, "package-lock.json": v3Lock,
	}))
	if ws.Unsupported == nil || ws.Unsupported.Code != "workspaces_unsupported" {
		t.Errorf("workspaces: %+v", ws.Unsupported)
	}
}

func TestLoadABrokenManifestStillReadsTheLockfile(t *testing.T) {
	l := lockfile.Load(writeFiles(t, map[string]string{"package.json": `{`, "package-lock.json": v3Lock}))
	if l.ManifestErr == nil || l.Manifest != nil || l.Lock == nil || l.Unsupported != nil {
		t.Fatalf("l = %+v", l)
	}
}
