package lockfile_test

import (
	"errors"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

func TestParseManifestReadsTheDependencySections(t *testing.T) {
	m, err := lockfile.ParseManifest([]byte(`{
		"name": "x",
		"dependencies": {"a": "^1.0.0"},
		"devDependencies": {"b": "~2.1.0"},
		"optionalDependencies": {"c": "3.0.0"},
		"packageManager": "pnpm@9.1.0+sha256.abc",
		"workspaces": ["packages/*"]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Dependencies["a"] != "^1.0.0" || m.DevDependencies["b"] != "~2.1.0" || m.OptionalDependencies["c"] != "3.0.0" {
		t.Errorf("sections = %+v", m)
	}
	if m.PackageManager != "pnpm@9.1.0+sha256.abc" || !m.HasWorkspaces {
		t.Errorf("packageManager/workspaces = %q %v", m.PackageManager, m.HasWorkspaces)
	}
}

func TestParseManifestToleratesAByteOrderMark(t *testing.T) {
	if _, err := lockfile.ParseManifest([]byte("\xef\xbb\xbf{\"name\":\"x\"}")); err != nil {
		t.Fatal(err)
	}
}

func TestParseManifestSyntaxErrorHasALineAndColumn(t *testing.T) {
	_, err := lockfile.ParseManifest([]byte("{\n  \"name\": \"x\",\n  \"version\": \n}\n"))
	var se *lockfile.SyntaxError
	if !errors.As(err, &se) {
		t.Fatalf("err = %v, want *SyntaxError", err)
	}
	if se.Line != 4 || se.Column != 1 {
		t.Errorf("position = %d:%d, want 4:1", se.Line, se.Column)
	}
}

func TestParseManifestRejectsWrongShapes(t *testing.T) {
	for name, doc := range map[string]string{
		"array":             `[]`,
		"null":              `null`,
		"empty":             ``,
		"deps not a map":    `{"dependencies": ["a"]}`,
		"specifier not str": `{"dependencies": {"a": 1}}`,
	} {
		_, err := lockfile.ParseManifest([]byte(doc))
		var se *lockfile.SyntaxError
		if !errors.As(err, &se) {
			t.Errorf("%s: err = %v, want *SyntaxError", name, err)
		}
	}
}

const v3Lock = `{
  "name": "x", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "x", "dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}},
    "node_modules/a": {"version": "1.2.0", "resolved": "https://registry.npmjs.org/a/-/a-1.2.0.tgz", "integrity": "sha512-aaa", "license": "MIT", "hasInstallScript": true},
    "node_modules/b": {"version": "2.1.4", "dev": true, "license": "(MIT OR Apache-2.0)"},
    "node_modules/l": {"resolved": "../l", "link": true}
  }
}`

func TestParseLockReadsVersion3Entries(t *testing.T) {
	l, err := lockfile.ParseLock([]byte(v3Lock))
	if err != nil {
		t.Fatal(err)
	}
	if l.Version != 3 || len(l.Packages) != 4 {
		t.Fatalf("version %d, %d packages", l.Version, len(l.Packages))
	}
	a := l.Packages["node_modules/a"]
	if a.Version != "1.2.0" || a.Integrity != "sha512-aaa" || !a.HasInstallScript || a.License() != "MIT" {
		t.Errorf("a = %+v", a)
	}
	if !l.Packages["node_modules/b"].Dev || l.Packages["node_modules/b"].License() != "(MIT OR Apache-2.0)" {
		t.Errorf("b = %+v", l.Packages["node_modules/b"])
	}
	if !l.Packages["node_modules/l"].Link {
		t.Error("link entry not read")
	}
	if l.Packages[""].Dependencies["a"] != "^1.0.0" {
		t.Errorf("root = %+v", l.Packages[""])
	}
}

func TestParseLockAcceptsVersion2WithItsLegacyDependenciesTree(t *testing.T) {
	l, err := lockfile.ParseLock([]byte(`{"lockfileVersion": 2, "packages": {"": {}}, "dependencies": {}}`))
	if err != nil || l.Version != 2 {
		t.Fatalf("l = %+v, err = %v", l, err)
	}
}

func TestParseLockVersion1IsUnsupportedNotBroken(t *testing.T) {
	_, err := lockfile.ParseLock([]byte(`{"lockfileVersion": 1, "dependencies": {"a": {"version": "1.0.0"}}}`))
	var ue *lockfile.UnsupportedVersionError
	if !errors.As(err, &ue) || ue.Version != 1 {
		t.Fatalf("err = %v, want unsupported version 1", err)
	}
	var se *lockfile.SyntaxError
	if errors.As(err, &se) {
		t.Error("a version 1 lockfile is not broken")
	}
}

func TestParseLockBrokenDocuments(t *testing.T) {
	for name, doc := range map[string]string{
		"not json":         `{"lockfileVersion": 3,`,
		"no version":       `{"packages": {}}`,
		"packages not map": `{"lockfileVersion": 3, "packages": []}`,
		"empty":            ``,
		"conflict markers": "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n",
		"version not int":  `{"lockfileVersion": "3", "packages": {}}`,
	} {
		_, err := lockfile.ParseLock([]byte(doc))
		var se *lockfile.SyntaxError
		if !errors.As(err, &se) {
			t.Errorf("%s: err = %v, want *SyntaxError", name, err)
		}
	}
}

func TestParseLockWithoutPackagesIsAnEmptyLockfile(t *testing.T) {
	l, err := lockfile.ParseLock([]byte(`{"lockfileVersion": 3}`))
	if err != nil || l.Version != 3 || len(l.Packages) != 0 {
		t.Fatalf("l = %+v, err = %v", l, err)
	}
}

func TestVersion4IsUnsupportedWithTheVersionInTheReason(t *testing.T) {
	_, err := lockfile.ParseLock([]byte(`{"lockfileVersion": 4, "packages": {}}`))
	var ue *lockfile.UnsupportedVersionError
	if !errors.As(err, &ue) || ue.Version != 4 {
		t.Fatalf("err = %v", err)
	}
}
