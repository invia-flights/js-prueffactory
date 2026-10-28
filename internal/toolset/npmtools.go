package toolset

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

// The npm tools are installed from a manifest and a lockfile that are embedded
// in the binary, once per toolset version, into a cache volume. Each tool has
// its own file (jscpd.go and so on) that adds it to the table with
// registerNPMTool; the manifest and the lockfile are shared and are regenerated
// with `npm install --package-lock-only --ignore-scripts` in the npm folder.

//go:embed npm/package.json
var npmManifest []byte

//go:embed npm/package-lock.json
var npmLockfile []byte

// NPMManifest is the embedded package.json of the tool install.
func NPMManifest() []byte { return npmManifest }

// NPMLockfile is the embedded package-lock.json of the tool install. Its npm
// integrity hashes pin every installed file.
func NPMLockfile() []byte { return npmLockfile }

// Tool is one npm tool of the table.
type Tool struct {
	Name    string // the name the Report shows
	Version string
	License string // SPDX expression
	Package string // npm package name
	// Integrity is the npm integrity hash of the package from the lockfile.
	Integrity string
	// RunInstallScripts is true for a tool that cannot work without its
	// lifecycle scripts. Installs run with --ignore-scripts otherwise.
	RunInstallScripts bool
}

var npmTools = map[string]Tool{}

func init() {
	sum := sha256.Sum256(npmLockfile)
	record("npm/lockfile", hex.EncodeToString(sum[:]))
}

// registerNPMTool adds a tool to the table and to the toolset version. Its
// integrity is read from the embedded lockfile, so the lockfile stays the single
// source of truth. It panics when the tool is missing from the lockfile.
func registerNPMTool(t Tool) {
	t.Integrity = lockedIntegrity(t.Package, t.Version)
	if t.Integrity == "" {
		panic(fmt.Sprintf("toolset: %s@%s is not in the embedded lockfile", t.Package, t.Version))
	}
	if _, dup := npmTools[t.Name]; dup {
		panic("toolset: duplicate npm tool " + t.Name)
	}
	npmTools[t.Name] = t
	record("npm-tool/"+t.Name, fmt.Sprintf("%s@%s license=%s integrity=%s scripts=%v", t.Package, t.Version, t.License, t.Integrity, t.RunInstallScripts))
}

// lockedIntegrity returns the integrity of a package at a version in the
// embedded lockfile, or "".
func lockedIntegrity(pkg, version string) string {
	var lock struct {
		Packages map[string]struct {
			Version   string `json:"version"`
			Integrity string `json:"integrity"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(npmLockfile, &lock); err != nil {
		panic("toolset: the embedded lockfile is not valid JSON: " + err.Error())
	}
	p := lock.Packages["node_modules/"+pkg]
	if p.Version != version {
		return ""
	}
	return p.Integrity
}

// NPMTools returns the npm tools sorted by name.
func NPMTools() []Tool {
	out := make([]Tool, 0, len(npmTools))
	for _, t := range npmTools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// NPMTool returns one npm tool by name.
func NPMTool(name string) (Tool, bool) {
	t, ok := npmTools[name]
	return t, ok
}

// InstallScripts says whether the install must run lifecycle scripts, which is
// so when any tool of the table needs them.
func InstallScripts() bool {
	for _, t := range npmTools {
		if t.RunInstallScripts {
			return true
		}
	}
	return false
}
