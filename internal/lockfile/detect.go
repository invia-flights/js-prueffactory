package lockfile

import (
	"os"
	"slices"
	"sort"
	"strings"
)

// Manager is a package manager.
type Manager string

const (
	NPM  Manager = "npm"
	PNPM Manager = "pnpm"
	Yarn Manager = "yarn"
	Bun  Manager = "bun"
	Deno Manager = "deno"
)

// Lockfile is a lockfile found in a package folder.
type Lockfile struct {
	Name    string
	Manager Manager
}

// Detection says which package manager a package uses and which lockfiles it
// holds.
type Detection struct {
	// Manager is the manager of the package. Source says how it was found:
	// "lockfile", "packageManager" (the manifest field), "deno.json" or
	// "default" when nothing says otherwise and npm is assumed.
	Manager Manager
	Source  string
	// Lockfiles lists every lockfile of any manager, sorted by name.
	Lockfiles []Lockfile
	// NPMLockfile is the npm lockfile npm itself would use, or "". npm
	// prefers npm-shrinkwrap.json over package-lock.json.
	NPMLockfile string
}

var lockfileNames = map[string]Manager{
	"package-lock.json":   NPM,
	"npm-shrinkwrap.json": NPM,
	"pnpm-lock.yaml":      PNPM,
	"yarn.lock":           Yarn,
	"bun.lock":            Bun,
	"bun.lockb":           Bun,
	"deno.lock":           Deno,
}

// Managers returns the distinct managers whose lockfiles are present, sorted
// by name. More than one means the package is ambiguous.
func (d Detection) Managers() []Manager {
	seen := map[Manager]bool{}
	var out []Manager
	for _, l := range d.Lockfiles {
		if !seen[l.Manager] {
			seen[l.Manager] = true
			out = append(out, l.Manager)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Detect looks at the files directly inside dir, a package folder, and at its
// manifest. Several lockfiles of different managers resolve to the manager
// named by the `packageManager` field when it is one of them, and otherwise
// to npm when its lockfile is there, and otherwise to the first by name. A
// lone npm lockfile does not outweigh a `packageManager` field that names
// another manager: Corepack would not let npm install such a package, so it is
// that manager's package, and a lone lockfile of any other manager keeps its
// manager.
func Detect(dir string, m *Manifest) Detection {
	var d Detection
	var deno bool
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if mgr, ok := lockfileNames[name]; ok {
			d.Lockfiles = append(d.Lockfiles, Lockfile{Name: name, Manager: mgr})
			if mgr == NPM && (d.NPMLockfile == "" || name == "npm-shrinkwrap.json") {
				d.NPMLockfile = name
			}
		}
		if name == "deno.json" || name == "deno.jsonc" {
			deno = true
		}
	}
	sort.Slice(d.Lockfiles, func(i, j int) bool { return d.Lockfiles[i].Name < d.Lockfiles[j].Name })

	hint := managerField(m)
	managers := d.Managers()
	switch {
	case len(managers) == 1 && managers[0] == NPM && hint != "" && hint != NPM:
		d.Manager, d.Source = hint, "packageManager"
	case len(managers) == 1:
		d.Manager, d.Source = managers[0], "lockfile"
	case len(managers) > 1:
		d.Source = "lockfile"
		d.Manager = managers[0]
		if slices.Contains(managers, NPM) {
			d.Manager = NPM
		}
		if slices.Contains(managers, hint) {
			d.Manager = hint
		}
	case hint != "":
		d.Manager, d.Source = hint, "packageManager"
	case deno:
		d.Manager, d.Source = Deno, "deno.json"
	default:
		d.Manager, d.Source = NPM, "default"
	}
	return d
}

// managerField returns the manager named by the `packageManager` field, such
// as "pnpm" for "pnpm@9.1.0", or "" when it is absent or unknown.
func managerField(m *Manifest) Manager {
	if m == nil || m.PackageManager == "" {
		return ""
	}
	name, _, _ := strings.Cut(m.PackageManager, "@")
	switch mgr := Manager(name); mgr {
	case NPM, PNPM, Yarn, Bun, Deno:
		return mgr
	}
	return ""
}
