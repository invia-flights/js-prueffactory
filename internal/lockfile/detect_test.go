package lockfile_test

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

func dirWith(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestDetectNpmFromItsLockfile(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package.json", "package-lock.json"), &lockfile.Manifest{})
	if d.Manager != lockfile.NPM || d.Source != "lockfile" || d.NPMLockfile != "package-lock.json" || len(d.Managers()) != 1 {
		t.Errorf("d = %+v", d)
	}
}

func TestDetectPrefersTheShrinkwrapLikeNpmDoes(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package-lock.json", "npm-shrinkwrap.json"), &lockfile.Manifest{})
	if d.NPMLockfile != "npm-shrinkwrap.json" || len(d.Lockfiles) != 2 {
		t.Errorf("d = %+v", d)
	}
	if len(d.Managers()) != 1 {
		t.Errorf("two npm lockfiles are one manager, got %v", d.Managers())
	}
}

func TestDetectOtherManagersFromTheirLockfiles(t *testing.T) {
	for file, want := range map[string]lockfile.Manager{
		"pnpm-lock.yaml": lockfile.PNPM, "yarn.lock": lockfile.Yarn, "bun.lock": lockfile.Bun,
		"bun.lockb": lockfile.Bun, "deno.lock": lockfile.Deno,
	} {
		d := lockfile.Detect(dirWith(t, file), &lockfile.Manifest{})
		if d.Manager != want || d.NPMLockfile != "" {
			t.Errorf("%s: d = %+v, want %s", file, d, want)
		}
	}
}

func TestDetectFromThePackageManagerFieldWithoutALockfile(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package.json"), &lockfile.Manifest{PackageManager: "yarn@4.1.0+sha224.abc"})
	if d.Manager != lockfile.Yarn || d.Source != "packageManager" || len(d.Lockfiles) != 0 {
		t.Errorf("d = %+v", d)
	}
}

func TestDetectDenoFromItsConfig(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package.json", "deno.json"), &lockfile.Manifest{})
	if d.Manager != lockfile.Deno {
		t.Errorf("d = %+v", d)
	}
}

func TestDetectAssumesNpmWhenNothingSaysOtherwise(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package.json"), &lockfile.Manifest{})
	if d.Manager != lockfile.NPM || d.Source != "default" {
		t.Errorf("d = %+v", d)
	}
}

func TestDetectSeveralManagersFollowsThePackageManagerField(t *testing.T) {
	dir := dirWith(t, "package-lock.json", "yarn.lock")
	d := lockfile.Detect(dir, &lockfile.Manifest{PackageManager: "yarn@1.22.0"})
	if d.Manager != lockfile.Yarn {
		t.Errorf("d.Manager = %s, want yarn", d.Manager)
	}
	if !reflect.DeepEqual(d.Managers(), []lockfile.Manager{lockfile.NPM, lockfile.Yarn}) {
		t.Errorf("managers = %v", d.Managers())
	}
	d = lockfile.Detect(dir, &lockfile.Manifest{})
	if d.Manager != lockfile.NPM {
		t.Errorf("without a hint npm wins, got %s", d.Manager)
	}
}

func TestDetectAPackageManagerFieldOutweighsALoneNpmLockfile(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package-lock.json"), &lockfile.Manifest{PackageManager: "yarn@4.1.0"})
	if d.Manager != lockfile.Yarn || d.Source != "packageManager" || d.NPMLockfile != "package-lock.json" {
		t.Errorf("d = %+v", d)
	}
	d = lockfile.Detect(dirWith(t, "package-lock.json"), &lockfile.Manifest{PackageManager: "npm@10.2.0"})
	if d.Manager != lockfile.NPM || d.Source != "lockfile" {
		t.Errorf("a field naming npm changes nothing, got %+v", d)
	}
}

func TestDetectALoneLockfileOfAnotherManagerOutweighsThePackageManagerField(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "yarn.lock"), &lockfile.Manifest{PackageManager: "npm@10.2.0"})
	if d.Manager != lockfile.Yarn || d.Source != "lockfile" {
		t.Errorf("d = %+v", d)
	}
}

func TestDetectIgnoresAnUnknownPackageManagerField(t *testing.T) {
	d := lockfile.Detect(dirWith(t, "package-lock.json"), &lockfile.Manifest{PackageManager: "mystery@1"})
	if d.Manager != lockfile.NPM {
		t.Errorf("d = %+v", d)
	}
}
