package checks

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(lintExistingID, lintExisting{}) }

const lintExistingID = "lint.existing"

// lintExisting runs the project's own linter, ESLint or Biome, at the version
// the lockfile locked, from the package's node_modules in the Working copy, with
// the project's own configuration and check-only. A project with both linters
// gets both. Diagnostics of error level are Gates, warnings are warnings.
//
// Unlike the combined ESLint run, this Check executes the project's own
// configuration, which is JavaScript and therefore project code. It runs in the
// package's Node image on the Run's internal network, with the Working copy
// mounted read-only.
type lintExisting struct{}

// linters says which of the two linters a package declares as a dependency, and
// whether and where it configures ESLint. A configuration file without the
// dependency does not make a linter: the package then has no locked version of
// it to run. A dependency without any configuration does not make one either:
// ESLint is then used as a library, and there is no linter setup that could
// fail. Biome runs with its defaults without a configuration.
type linters struct {
	eslint, biome bool
	// eslintConfigured is set when ESLint has a configuration of any kind: a
	// flat config file in the package folder or the nearest ancestor inside the
	// project, a legacy file or an `eslintConfig` key.
	eslintConfigured bool
	// legacyESLint is the package-relative path of an `.eslintrc*` file, or
	// "package.json" for an `eslintConfig` key. It is empty for none.
	legacyESLint string
}

// runsESLint says whether the Check runs ESLint: it is a dependency and the
// project configures it.
func (l linters) runsESLint() bool { return l.eslint && l.eslintConfigured }

// flatConfigNames are the files ESLint reads as its flat configuration.
var flatConfigNames = []string{
	"eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
	"eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
}

// hasFlatESLintConfig looks for a flat config the way ESLint resolves it: in the
// package folder, then in each ancestor folder up to the project root. Only
// regular files count.
func hasFlatESLintConfig(root string, pkg *discovery.Package) bool {
	dir := pkg.Path
	for {
		for _, name := range flatConfigNames {
			if _, ok := regularFile(filepath.Join(root, filepath.FromSlash(dir), name)); ok {
				return true
			}
		}
		if dir == "." || dir == "" {
			return false
		}
		dir = path.Dir(dir)
	}
}

// maxLintManifestBytes caps the package.json that is read to find the linters.
const maxLintManifestBytes = 1 << 20

// lintersOf finds the linters a package declares in its manifest, and its legacy
// ESLint configuration among the files at its root. Test data does not count,
// and neither do files of nested folders.
func lintersOf(root string, pkg *discovery.Package) linters {
	var l linters
	for _, f := range pkg.Files {
		if f.Class == discovery.TestData || strings.Contains(f.PackageRel, "/") {
			continue
		}
		if strings.HasPrefix(f.PackageRel, ".eslintrc") && l.legacyESLint == "" {
			l.legacyESLint = f.PackageRel
		}
	}
	abs := filepath.Join(root, filepath.FromSlash(pkg.Path), "package.json")
	size, ok := regularFile(abs)
	if !ok || size > maxLintManifestBytes {
		return l
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return l
	}
	var m struct {
		Dependencies    map[string]json.RawMessage `json:"dependencies"`
		DevDependencies map[string]json.RawMessage `json:"devDependencies"`
		ESLintConfig    json.RawMessage            `json:"eslintConfig"`
	}
	if json.Unmarshal(data, &m) != nil {
		return l
	}
	for _, deps := range []map[string]json.RawMessage{m.Dependencies, m.DevDependencies} {
		if _, ok := deps["eslint"]; ok {
			l.eslint = true
		}
		if _, ok := deps["@biomejs/biome"]; ok {
			l.biome = true
		}
	}
	if len(m.ESLintConfig) > 0 && string(m.ESLintConfig) != "null" && l.legacyESLint == "" {
		l.legacyESLint = "package.json"
	}
	l.eslintConfigured = l.legacyESLint != "" || hasFlatESLintConfig(root, pkg)
	return l
}

func (lintExisting) Applicability(p *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "lint.existing examines packages, and this is the project Context"
	}
	l := lintersOf(p.Root, c.Package)
	switch {
	case l.biome || l.runsESLint():
	case l.eslint:
		return resultset.NotApplicable, "ESLint is a dependency, but there is no ESLint configuration (no eslint.config.* in the package or an ancestor folder, no .eslintrc*, no eslintConfig in package.json), so the project has no linter setup to run and ESLint is probably used as a library"
	default:
		return resultset.NotApplicable, "the package has neither ESLint nor Biome as a dependency, so there is no locked version of either to run (a configuration file alone does not count)"
	}
	return resultset.Applicable, unsupportedInstallReason(c)
}

func (lintExisting) Prerequisites(*discovery.Context) []string { return []string{packageInstallID} }

func (lintExisting) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (lintExisting) Images(c *discovery.Context) []string { return nodeImages(c) }
