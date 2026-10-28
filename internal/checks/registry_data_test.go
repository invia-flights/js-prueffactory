package checks

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

// rootedLock parses a lockfile whose root entry is rootJSON.
func rootedLock(t *testing.T, rootJSON, entries string) *lockfile.Lock {
	t.Helper()
	l, err := lockfile.ParseLock([]byte(`{"lockfileVersion": 3, "packages": {"": ` + rootJSON + `, ` + entries + `}}`))
	if err != nil {
		t.Fatal(err)
	}
	return l
}

const registryLockEntries = `
	"node_modules/direct-prod": {"version": "2.0.0", "resolved": "https://registry.npmjs.org/direct-prod/-/direct-prod-2.0.0.tgz"},
	"node_modules/direct-dev": {"version": "1.0.0", "dev": true, "resolved": "https://registry.npmjs.org/direct-dev/-/direct-dev-1.0.0.tgz"},
	"node_modules/@scope/shared": {"version": "3.1.0", "resolved": "https://registry.npmjs.org/@scope/shared/-/shared-3.1.0.tgz"},
	"node_modules/transitive-dev": {"version": "0.5.0", "dev": true, "resolved": "https://registry.npmjs.org/transitive-dev/-/transitive-dev-0.5.0.tgz"},
	"node_modules/direct-prod/node_modules/transitive-dev": {"version": "0.4.0", "resolved": "https://registry.npmjs.org/transitive-dev/-/transitive-dev-0.4.0.tgz"},
	"node_modules/aliased": {"name": "real-name", "version": "4.0.0", "resolved": "https://registry.npmjs.org/real-name/-/real-name-4.0.0.tgz"},
	"node_modules/from-git": {"version": "1.0.0", "resolved": "git+ssh://git@example.com/x/from-git.git#abc"},
	"node_modules/workspace-member": {"resolved": "packages/member", "link": true}`

const registryRoot = `{"name": "x", "dependencies": {"direct-prod": "^2.0.0", "@scope/shared": "^3.0.0", "aliased": "npm:real-name@4"}, "devDependencies": {"direct-dev": "^1.0.0"}}`

func TestLockedVersionsSayWhetherAVersionIsDirectAndProdOrDev(t *testing.T) {
	got := lockedVersions(rootedLock(t, registryRoot, registryLockEntries), nil)

	type row struct {
		Name, Version, Scope string
		Direct               bool
	}
	var rows []row
	for _, v := range got {
		rows = append(rows, row{v.Name, v.Version, v.Scope, v.Direct})
	}
	want := []row{
		{"@scope/shared", "3.1.0", "prod", true},
		{"direct-dev", "1.0.0", "dev", true},
		{"direct-prod", "2.0.0", "prod", true},
		{"real-name", "4.0.0", "prod", true},
		// One dev-only copy and one that production code reaches: two versions,
		// each with its own scope, and neither is a direct dependency.
		{"transitive-dev", "0.4.0", "prod", false},
		{"transitive-dev", "0.5.0", "dev", false},
	}
	if !slices.Equal(rows, want) {
		t.Errorf("locked versions =\n%v\nwant\n%v", rows, want)
	}
}

func TestRegistryRequestListsEveryLockedNameWithItsVersionsAndMarksDirectOnes(t *testing.T) {
	versions := lockedVersions(rootedLock(t, registryRoot, registryLockEntries), nil)

	got := registryRequestPackages(versions)

	byName := map[string]registryRequestPackage{}
	for _, p := range got {
		byName[p.Name] = p
	}
	if len(got) != 5 {
		t.Errorf("request names %d packages, want 5 (git and link entries are no registry packages): %+v", len(got), got)
	}
	if p := byName["transitive-dev"]; !slices.Equal(p.Versions, []string{"0.4.0", "0.5.0"}) || p.Direct {
		t.Errorf("transitive-dev = %+v, want both versions and no direct mark", p)
	}
	if p := byName["real-name"]; !p.Direct || !slices.Equal(p.Versions, []string{"4.0.0"}) {
		t.Errorf("an alias is asked for under its real name and is direct: %+v", p)
	}
	if !slices.IsSortedFunc(got, func(a, b registryRequestPackage) int {
		if a.Name < b.Name {
			return -1
		}
		if a.Name > b.Name {
			return 1
		}
		return 0
	}) {
		t.Errorf("request is not in name order: %+v", got)
	}
	raw, _ := json.Marshal(got[0])
	if string(raw) != `{"name":"@scope/shared","versions":["3.1.0"],"direct":true}` {
		t.Errorf("JSON of a request row = %s", raw)
	}
}
