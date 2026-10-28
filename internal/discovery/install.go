package discovery

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

// Unsupported says why a package cannot be handled in this release. Code is a
// stable reason code for the Report.
type Unsupported struct {
	Code   string
	Reason string
}

// readInstallInfo decides how the dependencies of every package get installed:
// with npm, from a lockfile or without, or not at all because the package uses
// another package manager or sits in an npm workspace. npm is the only package
// manager the tool installs with.
func readInstallInfo(root string, pkgs []*Package) {
	manifests := map[string]*lockfile.Manifest{}
	for _, pkg := range pkgs {
		dir := filepath.Join(root, filepath.FromSlash(pkg.Path))
		data, err := os.ReadFile(filepath.Join(dir, "package.json"))
		var m *lockfile.Manifest
		if err == nil {
			m, _ = lockfile.ParseManifest(data)
		}
		manifests[pkg.Path] = m
		d := lockfile.Detect(dir, m)
		pkg.NPMLockfile = d.NPMLockfile
		pkg.Manager = d.Manager
		if u := lockfile.ManagerSupport(d, m); u != nil {
			pkg.InstallUnsupported = &Unsupported{Code: u.Code, Reason: u.Reason}
		}
	}
	for _, pkg := range pkgs {
		if pkg.InstallUnsupported != nil {
			continue
		}
		if ws := workspaceRootOf(pkg, pkgs, manifests); ws != "" {
			pkg.InstallUnsupported = &Unsupported{
				Code: "workspaces_unsupported",
				Reason: fmt.Sprintf("the package is a member of the npm workspace of %s, and js-prueffactory does not support npm workspaces",
					workspaceName(ws)),
			}
		}
	}
}

func workspaceName(rootPath string) string {
	if rootPath == "." {
		return "the project root"
	}
	return rootPath
}

// workspaceRootOf returns the path of the package whose `workspaces` field
// names pkg, or "" when there is none.
func workspaceRootOf(pkg *Package, pkgs []*Package, manifests map[string]*lockfile.Manifest) string {
	for _, other := range pkgs {
		m := manifests[other.Path]
		if other == pkg || m == nil || !m.HasWorkspaces {
			continue
		}
		rel := pkg.Path
		if other.Path != "." {
			if !strings.HasPrefix(pkg.Path, other.Path+"/") {
				continue
			}
			rel = strings.TrimPrefix(pkg.Path, other.Path+"/")
		} else if pkg.Path == "." {
			continue
		}
		if m.IsWorkspaceMember(path.Clean(rel)) {
			return other.Path
		}
	}
	return ""
}
