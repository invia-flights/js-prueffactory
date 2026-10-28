package checks

import (
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

// This file is the registry-data step that deps.deprecated and deps.outdated
// share: what it asks the registry about, and (in registry_fetch.go) how the
// answer is fetched and read.

// lockedVersion is one package version of a lockfile with what the Checks that
// read registry data need to say about it.
type lockedVersion struct {
	Name    string // the real package name, also for an npm alias
	Version string
	// Key is the lockfile entry that decided the scope, or the first entry of
	// the version, so a Finding can point at a line.
	Key string
	// Direct is true when the version is a dependency the manifest names.
	Direct bool
	// Scope is "prod" when any entry of the version is not development-only,
	// otherwise "dev".
	Scope string
}

// lockedVersions lists the registry packages of a lockfile, one row per name
// and version, in name and version order. Links, workspace folders and entries
// that do not come from an http(s) registry (git and file sources) are left
// out: the registry knows nothing about them, and they are no unknowns.
//
// A version is direct when the manifest names it: the root entry of the
// lockfile and the manifest, when there is one, are both read. An alias such
// as "npm:real-name@4" is the direct dependency `real-name`.
func lockedVersions(lock *lockfile.Lock, manifest *lockfile.Manifest) []lockedVersion {
	direct := directFolders(lock, manifest)
	type id struct{ name, version string }
	rows := map[id]*lockedVersion{}

	keys := make([]string, 0, len(lock.Packages))
	for k := range lock.Packages {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		e := lock.Packages[key]
		if key == "" || e.Link || e.Version == "" || !fromRegistry(e) {
			continue
		}
		name := packageName(key, e)
		if !validPackageName(name) || !validVersion(e.Version) {
			continue
		}
		row := rows[id{name, e.Version}]
		if row == nil {
			row = &lockedVersion{Name: name, Version: e.Version, Key: key, Scope: "dev"}
			rows[id{name, e.Version}] = row
		}
		if !e.Dev {
			if row.Scope == "dev" {
				row.Key = key
			}
			row.Scope = "prod"
		}
		if folder, top := strings.CutPrefix(key, "node_modules/"); top && direct[folder] {
			row.Direct = true
		}
	}
	out := make([]lockedVersion, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return compareVersions(out[i].Version, out[j].Version) < 0
	})
	return out
}

// Names, versions and hosts come from the project's lockfile and .npmrc. They
// go into titles, messages and reasons only when they look like what they
// claim to be: npm's package-name grammar, a semantic version, a hostname.
var (
	// Old packages such as JSONStream have capital letters, so those are allowed.
	packageNameGrammar = regexp.MustCompile(`^(@[A-Za-z0-9-~][A-Za-z0-9-._~]*/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$`)
	versionGrammar     = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)
	hostGrammar        = regexp.MustCompile(`^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$`)
)

func validPackageName(s string) bool { return len(s) <= 214 && packageNameGrammar.MatchString(s) }
func validVersion(s string) bool     { return len(s) <= 128 && versionGrammar.MatchString(s) }
func validHost(s string) bool        { return len(s) <= 255 && hostGrammar.MatchString(s) }

// rejectedVersions lists, sorted, the registry entries of a lockfile whose name
// or version is not valid (see validPackageName). lockedVersions leaves them
// out; the registry-data step counts them as unknown, so they are never read as
// fine.
func rejectedVersions(lock *lockfile.Lock) []string { return rejected(lock, nil) }

// rejectedDirectVersions is rejectedVersions for the entries that the manifest
// names, which are the ones a Check that reads direct dependencies misses.
func rejectedDirectVersions(lock *lockfile.Lock, manifest *lockfile.Manifest) []string {
	return rejected(lock, directFolders(lock, manifest))
}

// rejected lists the invalid registry entries, only those under a top-level
// folder of direct when that is not nil.
func rejected(lock *lockfile.Lock, direct map[string]bool) []string {
	seen := map[string]bool{}
	for key, e := range lock.Packages {
		if key == "" || e.Link || e.Version == "" || !fromRegistry(e) {
			continue
		}
		if direct != nil {
			if folder, top := strings.CutPrefix(key, "node_modules/"); !top || !direct[folder] {
				continue
			}
		}
		if name := packageName(key, e); !validPackageName(name) || !validVersion(e.Version) {
			seen[name+"@"+e.Version] = true
		}
	}
	out := make([]string, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// fromRegistry says whether a lockfile entry was resolved from an http(s)
// source. An entry without a `resolved` value counts: npm leaves it out of some
// registry entries.
func fromRegistry(e lockfile.Entry) bool {
	if e.Resolved == "" {
		return true
	}
	u, err := url.Parse(e.Resolved)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https")
}

// directFolders is the set of folder names under node_modules that the root
// of the package depends on, from the lockfile's root entry and the manifest.
func directFolders(lock *lockfile.Lock, manifest *lockfile.Manifest) map[string]bool {
	out := map[string]bool{}
	add := func(m map[string]string) {
		for name := range m {
			out[name] = true
		}
	}
	root := lock.Packages[""]
	add(root.Dependencies)
	add(root.DevDependencies)
	add(root.OptionalDependencies)
	if manifest != nil {
		add(manifest.Dependencies)
		add(manifest.DevDependencies)
		add(manifest.OptionalDependencies)
	}
	return out
}

// registryRequestPackage is one package the fetch script asks the registry
// about. Direct packages get the full packument, which has publication times;
// every other package gets the abbreviated one.
type registryRequestPackage struct {
	Name     string   `json:"name"`
	Versions []string `json:"versions"`
	Direct   bool     `json:"direct"`
}

// registryRequestPackages groups the locked versions by package name, in name
// order.
func registryRequestPackages(versions []lockedVersion) []registryRequestPackage {
	var out []registryRequestPackage
	for _, v := range versions {
		if n := len(out); n > 0 && out[n-1].Name == v.Name {
			out[n-1].Versions = append(out[n-1].Versions, v.Version)
			out[n-1].Direct = out[n-1].Direct || v.Direct
			continue
		}
		out = append(out, registryRequestPackage{Name: v.Name, Versions: []string{v.Version}, Direct: v.Direct})
	}
	return out
}
