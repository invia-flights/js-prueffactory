// Package discovery reads a project folder and describes it: packages, File
// classes, Contexts and what each Check can apply to. It is pure Go, never
// contacts Docker and never executes project code. Runs and `list-checks`
// share it.
package discovery

import (
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
)

// File is one file of the project.
type File struct {
	Path       string // relative to the project root, "/" separators
	PackageRel string // relative to the folder of its package, or Path outside every package
	Class      FileClass
	ContextID  string // Context the file belongs to
}

// Package is a folder with a package.json outside node_modules, Test data and
// Build output.
type Package struct {
	Path      string // relative to the project root, "." for the root package
	ContextID string
	// BuildStepReason is non-empty when the package needs a build step before
	// its JavaScript can run.
	BuildStepReason string
	// NPMLockfile is the npm lockfile npm itself would use ("package-lock.json"
	// or "npm-shrinkwrap.json"), or "" without one.
	NPMLockfile string
	// Manager is the package manager the package uses, found from its
	// lockfiles and its `packageManager` field; npm when nothing says
	// otherwise.
	Manager lockfile.Manager
	// InstallUnsupported is non-nil when the tool cannot install the package's
	// dependencies: another package manager, or an npm workspace.
	// Everything that needs the installed dependencies is unsupported too.
	InstallUnsupported *Unsupported
	// NodeChoice is the Node version and image variant the package runs on,
	// where they came from, and whether the version is unsupported.
	NodeChoice NodeChoice
	// Tests is how the package runs its own tests, or nil when it has none.
	Tests *TestSetup
	// MochaDependency is true when `mocha` is in the manifest's `dependencies`
	// or `devDependencies`. Use UsesMocha for the decision.
	MochaDependency bool
	// GeneratorScripts are the scripts schema.drift runs, in name order.
	GeneratorScripts []GeneratorScript
	// ServiceRefs lists the compose Services the Run does not start that the
	// package's env files or Test code refer to, one per Service (see
	// readServiceRefs). The package's suites may need them.
	ServiceRefs []ServiceRef
	// Files holds the files whose nearest enclosing package this is.
	Files []File
}

// Context is a Context of the Report plus what the engine needs to use it.
type Context struct {
	resultset.Context
	Package *Package // nil for the project Context
}

// Project is the discovery result.
type Project struct {
	Root     string
	Packages []*Package
	// Contexts holds the project Context first, then one per package in path order.
	Contexts []Context
	Files    []File
	// Services are the services of the project's compose files, by name.
	Services []ComposeService
	// DotEnv holds the variables of the project's .env file. They feed the
	// interpolation of compose files, and the Report redacts the secret ones.
	DotEnv map[string]string
	// ComposeProblems lists the compose files that could not be read.
	ComposeProblems []ComposeProblem
}

// ContextByID returns the Context with the given ID.
func (p *Project) ContextByID(id string) *Context {
	for i := range p.Contexts {
		if p.Contexts[i].ID == id {
			return &p.Contexts[i]
		}
	}
	return nil
}

// Discover reads root. It never follows symlinks and never reads outside it.
func Discover(root string) (*Project, error) {
	var files []File
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		slash := filepath.ToSlash(rel)
		files = append(files, File{Path: slash, Class: Classify(slash)})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("discovery: %w", err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	proj := &Project{Root: root}
	for _, f := range files {
		if path.Base(f.Path) != "package.json" || f.Class == TestData || f.Class == BuildOutput {
			continue
		}
		dir := path.Dir(f.Path)
		proj.Packages = append(proj.Packages, &Package{Path: dir})
	}
	sort.Slice(proj.Packages, func(i, j int) bool { return packageLess(proj.Packages[i].Path, proj.Packages[j].Path) })

	proj.Contexts = append(proj.Contexts, Context{Context: resultset.Context{
		ID: "C-0001", Kind: "project", Path: ".", Tools: []resultset.ToolRef{},
		Limits: containerLimits(),
	}})
	for i, pkg := range proj.Packages {
		pkg.ContextID = fmt.Sprintf("C-%04d", i+2)
	}

	for i := range files {
		pkg := nearestPackage(proj.Packages, files[i].Path)
		if pkg == nil {
			files[i].ContextID = "C-0001"
			files[i].PackageRel = files[i].Path
			continue
		}
		files[i].ContextID = pkg.ContextID
		files[i].PackageRel = strings.TrimPrefix(files[i].Path, pkg.Path+"/")
		if pkg.Path == "." {
			files[i].PackageRel = files[i].Path
		}
		pkg.Files = append(pkg.Files, files[i])
	}
	proj.Files = files

	proj.Services, proj.ComposeProblems = readCompose(root)
	proj.DotEnv = readDotEnv(filepath.Join(root, ".env"))
	readInstallInfo(root, proj.Packages)
	readNodeInfo(root, proj.Packages)
	readTestInfo(root, proj)
	readServiceRefs(root, proj)
	for _, pkg := range proj.Packages {
		pkg.BuildStepReason = buildStepReason(root, pkg, pkg.Files)
		proj.Contexts = append(proj.Contexts, Context{
			Package: pkg,
			Context: resultset.Context{
				ID: pkg.ContextID, Kind: "package", Path: pkg.Path,
				Node: nodeRuntimeFor(pkg), Tools: []resultset.ToolRef{}, Limits: containerLimits(),
			},
		})
	}
	return proj, nil
}

func containerLimits() resultset.ContainerLimit {
	return resultset.ContainerLimit{CPUs: toolset.ContainerCPUs, MemoryMB: toolset.ContainerMemoryMB}
}

// packageLess orders the root package first, then by path.
func packageLess(a, b string) bool {
	if a == "." || b == "." {
		return a == "." && b != "."
	}
	return a < b
}

// nearestPackage returns the package with the longest path that encloses file.
func nearestPackage(pkgs []*Package, file string) *Package {
	var best *Package
	bestLen := -1
	for _, p := range pkgs {
		length := len(p.Path)
		if p.Path == "." {
			length = 0
		} else if !strings.HasPrefix(file, p.Path+"/") {
			continue
		}
		if length > bestLen {
			best, bestLen = p, length
		}
	}
	return best
}
