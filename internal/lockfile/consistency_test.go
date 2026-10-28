package lockfile_test

import (
	"reflect"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

func mustLock(t *testing.T, doc string) *lockfile.Lock {
	t.Helper()
	l, err := lockfile.ParseLock([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func mustManifest(t *testing.T, doc string) *lockfile.Manifest {
	t.Helper()
	m, err := lockfile.ParseManifest([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestConsistentManifestAndLockHaveNoMismatches(t *testing.T) {
	m := mustManifest(t, `{"dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "~2.1.0"}}`)
	if got := lockfile.Check(m, mustLock(t, v3Lock)); len(got) != 0 {
		t.Errorf("mismatches = %+v", got)
	}
}

func TestADependencyThatTheLockfileLacksIsReported(t *testing.T) {
	m := mustManifest(t, `{"dependencies": {"a": "^1.0.0", "z": "^9.0.0"}, "devDependencies": {"b": "~2.1.0"}}`)
	got := lockfile.Check(m, mustLock(t, v3Lock))
	want := []lockfile.Mismatch{{Kind: lockfile.MissingDependency, Name: "z", Section: "dependencies", Specifier: "^9.0.0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestASpecifierThatDiffersFromTheLockfileRootIsReported(t *testing.T) {
	m := mustManifest(t, `{"dependencies": {"a": "^1.0.0"}, "devDependencies": {"b": "^3.0.0"}}`)
	got := lockfile.Check(m, mustLock(t, v3Lock))
	want := []lockfile.Mismatch{{Kind: lockfile.SpecifierMismatch, Name: "b", Section: "devDependencies", Specifier: "^3.0.0", LockSpecifier: "~2.1.0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestADependencyTheRootEntryDeclaresButNoPackageEntryInstallsIsMissing(t *testing.T) {
	l := mustLock(t, `{"lockfileVersion": 3, "packages": {"": {"dependencies": {"a": "^1.0.0"}}}}`)
	m := mustManifest(t, `{"dependencies": {"a": "^1.0.0"}}`)
	got := lockfile.Check(m, l)
	if len(got) != 1 || got[0].Kind != lockfile.MissingDependency || got[0].Name != "a" {
		t.Errorf("got %+v", got)
	}
}

func TestAlinkedDependencyCountsAsPresent(t *testing.T) {
	l := mustLock(t, `{"lockfileVersion": 3, "packages": {"": {"dependencies": {"l": "file:../l"}}, "node_modules/l": {"resolved": "../l", "link": true}}}`)
	m := mustManifest(t, `{"dependencies": {"l": "file:../l"}}`)
	if got := lockfile.Check(m, l); len(got) != 0 {
		t.Errorf("got %+v", got)
	}
}

func TestMismatchesComeInAStableOrder(t *testing.T) {
	l := mustLock(t, `{"lockfileVersion": 3, "packages": {"": {}}}`)
	m := mustManifest(t, `{"devDependencies": {"y": "1"}, "dependencies": {"z": "1", "b": "1"}}`)
	var names []string
	for _, mm := range lockfile.Check(m, l) {
		names = append(names, mm.Section+":"+mm.Name)
	}
	want := []string{"dependencies:b", "dependencies:z", "devDependencies:y"}
	if !reflect.DeepEqual(names, want) {
		t.Errorf("order = %v, want %v", names, want)
	}
}
