package checks

import (
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

// osv-scanner reads a git dependency as a package of the GIT ecosystem, which
// the offline database does not hold, and then fails the whole scan. Those
// entries are not in the advisory data anyway, so they are left out of the
// copy of the lockfile that is scanned, and counted as not covered.
func TestEntriesThatAreNoRegistryPackagesAreLeftOutOfTheScannedLockfile(t *testing.T) {
	raw := []byte(`{
  "name": "x", "lockfileVersion": 3, "requires": true, "extra": {"kept": true},
  "packages": {
    "": {"name": "x", "dependencies": {"a": "1"}},
    "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha512-x"},
    "node_modules/private": {"version": "1.0.0", "resolved": "https://registry.corp.example/private/-/private-1.0.0.tgz"},
    "node_modules/tarball": {"version": "1.0.0", "resolved": "http://downloads.example.org/tarball-1.0.0.tgz"},
    "node_modules/gitdep": {"version": "1.0.0", "resolved": "git+ssh://git@github.com/acme/gitdep.git#0123"},
    "node_modules/shorthand": {"version": "1.0.0", "resolved": "github:acme/shorthand#0123"},
    "node_modules/filedep": {"version": "1.0.0", "resolved": "file:vendor/filedep-1.0.0.tgz"},
    "node_modules/linked": {"resolved": "../linked", "link": true},
    "node_modules/bundled": {"version": "1.0.0", "inBundle": true}
  }
}`)
	filtered, dropped, err := scannableLockfile(raw)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(dropped)
	if got := strings.Join(dropped, ","); got != "node_modules/filedep,node_modules/gitdep,node_modules/shorthand" {
		t.Errorf("dropped = %s", got)
	}
	lock, err := lockfile.ParseLock(filtered)
	if err != nil {
		t.Fatalf("the filtered lockfile does not parse: %v", err)
	}
	var kept []string
	for k := range lock.Packages {
		kept = append(kept, k)
	}
	sort.Strings(kept)
	want := "," + "node_modules/a,node_modules/bundled,node_modules/linked,node_modules/private,node_modules/tarball"
	if got := strings.Join(kept, ","); got != want {
		t.Errorf("kept = %s, want %s", got, want)
	}
	if !strings.Contains(string(filtered), `"kept"`) {
		t.Error("the rest of the lockfile must stay as it was")
	}
}

func TestALockfileWithNothingToDropIsScannedAsItIs(t *testing.T) {
	raw := []byte(`{"lockfileVersion": 3, "packages": {"": {}, "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}}}`)
	filtered, dropped, err := scannableLockfile(raw)
	if err != nil || len(dropped) != 0 || string(filtered) != string(raw) {
		t.Fatalf("filtered = %s, dropped = %v, err = %v", filtered, dropped, err)
	}
}
