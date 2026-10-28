package checks

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

// eslintApplicability is the Applicability of every Check that reads the
// combined run: a package with JavaScript in Source code or Test code.
func eslintApplicability(c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "the combined ESLint run examines packages, and this is the project Context"
	}
	for _, f := range c.Package.Files {
		if (f.Class == discovery.Source || f.Class == discovery.TestCode) && eslintCandidate(f.PackageRel) {
			return resultset.Applicable, ""
		}
	}
	return resultset.NotApplicable, "the package has no .js, .cjs or .mjs files outside Test data and Build output"
}

// eslintSourceApplicability is the Applicability of a Check that reads the run
// for Source code only: a package with JavaScript in Source code.
func eslintSourceApplicability(c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "the combined ESLint run examines packages, and this is the project Context"
	}
	for _, f := range c.Package.Files {
		if f.Class == discovery.Source && eslintCandidate(f.PackageRel) {
			return resultset.Applicable, ""
		}
	}
	return resultset.NotApplicable, "the package has no .js, .cjs or .mjs files in Source code"
}

// eslintTestApplicability is the Applicability of a Check that reads the run for
// Test code only: a package with JavaScript in Test code.
func eslintTestApplicability(c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "the combined ESLint run examines packages, and this is the project Context"
	}
	for _, f := range c.Package.Files {
		if f.Class == discovery.TestCode && eslintCandidate(f.PackageRel) {
			return resultset.Applicable, ""
		}
	}
	return resultset.NotApplicable, "the package has no .js, .cjs or .mjs Test code"
}

// The combined ESLint run. One execution of the toolset's ESLint per package
// lints every JavaScript file of Source code and Test code with a flat config
// that we generate, so the project's own configuration and its inline
// directives never change what the Checks measure. Several Checks share that
// one execution: each registers a rule group (registerESLintGroup), and only
// the groups of selected Checks are switched on.

// Limits for what the run reads from the project.
const (
	// eslintMaxFileBytes is the size above which a file is not linted. Such
	// files are generated or data in practice, and parsing them could use up
	// the Check's memory and time.
	eslintMaxFileBytes = 2 << 20
	// eslintMaxManifestBytes caps the package.json that is read for the
	// package's type and test script.
	eslintMaxManifestBytes = 1 << 20
)

// eslintFile is one file given to ESLint, relative to the package folder.
type eslintFile struct {
	Path string `json:"path"`
	// SourceType is "module" or "commonjs".
	SourceType string `json:"source_type"`
}

// eslintGroupSpec describes a rule group to the helper.
type eslintGroupSpec struct {
	ID string `json:"id"`
	// CoreProblem switches on every non-deprecated ESLint core rule of type
	// problem, with default options, except the rules in Except.
	CoreProblem bool     `json:"core_problem"`
	Except      []string `json:"except"`
	// CoreOptions are the options of core problem rules that are not left at
	// their defaults, by rule name. The rule stays a warning.
	CoreOptions map[string][]any `json:"core_options"`
	// Plugins are the names of the toolset's ESLint plugins the rules below
	// come from: "mocha", "n" or "sonarjs". Their rules are named with the
	// plugin's prefix, such as "mocha/no-exclusive-tests".
	Plugins []string `json:"plugins"`
	// Rules are explicit rules on top of the core problem rules, switched on as
	// warnings. Hits of the rules that carry a Measure become measures.
	Rules []eslintRuleSpec `json:"rules"`
	// TestOnly limits the group's rules to Test code.
	TestOnly bool `json:"test_only"`
	// SourceOnly limits the group's rules to Source code.
	SourceOnly bool `json:"source_only"`
	// Settings are ESLint settings that the group's plugins read.
	Settings map[string]any `json:"settings"`
}

// eslintRuleSpec is one explicit rule of a group.
type eslintRuleSpec struct {
	Name    string `json:"name"`
	Options []any  `json:"options"`
	// Measure is "cyclomatic", "cognitive" or "length" for a rule whose message
	// holds a number the helper reads: the rule is configured to report every
	// function, and the helper turns each hit into a measure instead of a message.
	Measure string `json:"measure,omitempty"`
}

// eslintInput is the helper's input document.
type eslintInput struct {
	ESLint  string `json:"eslint"`
	Globals string `json:"globals"`
	// Tools is the folder of the toolset's packages, where the plugins are.
	Tools string `json:"tools"`
	// Root is the package folder in the container; the helper runs there.
	Root   string            `json:"root"`
	Groups []eslintGroupSpec `json:"groups"`
	Files  []eslintFile      `json:"files"`
	// TestFiles are the Test code files among Files.
	TestFiles []string `json:"test_files"`
	// SourceFiles are the Source code files among Files.
	SourceFiles []string `json:"source_files"`
	// Mocha says that Mocha's globals apply to the Test code files.
	Mocha bool `json:"mocha"`
	// Oversized lists files left out because of eslintMaxFileBytes.
	Oversized []string `json:"-"`
}

// eslintCandidate says whether ESLint's default configuration covers a file.
// TypeScript and JSX need parsers that milestone 1 does not install.
func eslintCandidate(rel string) bool {
	switch path.Ext(rel) {
	case ".js", ".cjs", ".mjs":
		return true
	}
	return false
}

// packageFolder is the absolute path of a package in the host-side Snapshot.
func packageFolder(in *Input) string {
	return filepath.Join(in.SnapshotDir, filepath.FromSlash(in.Context.Package.Path))
}

// regularFile reports whether an absolute path is a regular file, and its size.
// A symbolic link is not, so the run never reads outside the Snapshot.
func regularFile(abs string) (size int64, ok bool) {
	info, err := os.Lstat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	return info.Size(), true
}

// eslintTargets lists the regular JavaScript files of the package's Source code
// and Test code, with the source type each is parsed as. Test data and Build
// output are never linted. The source type follows the extension, and for .js
// the package's type field.
func eslintTargets(in *Input) []eslintFile {
	pkg := in.Context.Package
	jsType := "commonjs"
	if facts := readPackageFacts(in); facts.moduleType {
		jsType = "module"
	}
	var out []eslintFile
	for _, f := range pkg.Files {
		if (f.Class != discovery.Source && f.Class != discovery.TestCode) || !eslintCandidate(f.PackageRel) {
			continue
		}
		if _, ok := regularFile(filepath.Join(in.SnapshotDir, filepath.FromSlash(f.Path))); !ok {
			continue
		}
		st := jsType
		switch path.Ext(f.PackageRel) {
		case ".mjs":
			st = "module"
		case ".cjs":
			st = "commonjs"
		}
		out = append(out, eslintFile{Path: f.PackageRel, SourceType: st})
	}
	return out
}

// packageFacts is what the run reads from a package's package.json.
type packageFacts struct {
	moduleType bool // "type": "module"
}

// readPackageFacts reads the package's type. A manifest that is
// missing, not a regular file, too large or not JSON counts as empty: other
// Checks report on the manifest, and the run needs only this hint.
func readPackageFacts(in *Input) packageFacts {
	abs := filepath.Join(packageFolder(in), "package.json")
	size, ok := regularFile(abs)
	if !ok || size > eslintMaxManifestBytes {
		return packageFacts{}
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return packageFacts{}
	}
	var m struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &m) != nil {
		return packageFacts{}
	}
	return packageFacts{moduleType: m.Type == "module"}
}

// eslintHelperInput builds the helper's input for the package and the groups.
func eslintHelperInput(in *Input, groups []eslintGroup) (eslintInput, error) {
	pkg := in.Context.Package
	root := "/snapshot"
	if pkg.Path != "." {
		root += "/" + pkg.Path
	}
	input := eslintInput{
		ESLint: toolvolume.ToolBin + "/eslint", Globals: toolvolume.ToolBin + "/globals", Tools: toolvolume.ToolBin, Root: root,
		Groups: []eslintGroupSpec{}, Files: []eslintFile{}, TestFiles: []string{}, SourceFiles: []string{},
		Mocha: pkg.UsesMocha(),
	}
	for _, g := range groups {
		input.Groups = append(input.Groups, g.spec(in))
	}

	tests := map[string]bool{}
	for _, f := range pkg.Files {
		if f.Class == discovery.TestCode {
			tests[f.PackageRel] = true
		}
	}
	for _, f := range eslintTargets(in) {
		if size, _ := regularFile(filepath.Join(packageFolder(in), filepath.FromSlash(f.Path))); size > eslintMaxFileBytes {
			input.Oversized = append(input.Oversized, path.Join(pkg.Path, f.Path))
			continue
		}
		input.Files = append(input.Files, f)
		if tests[f.Path] {
			input.TestFiles = append(input.TestFiles, f.Path)
		} else {
			input.SourceFiles = append(input.SourceFiles, f.Path)
		}
	}
	sort.Strings(input.Oversized)
	return input, nil
}

// eslintGroup is the rule group of one Check in the combined run.
type eslintGroup struct {
	checkID     string
	coreProblem bool
	except      []string
	coreOptions map[string][]any
	// plugins, rules and testOnly are described under eslintGroupSpec.
	plugins    []string
	rules      []eslintRuleSpec
	testOnly   bool
	sourceOnly bool
	// settings returns the ESLint settings of the group for a Context.
	settings func(in *Input) map[string]any
	// partialOnUnparsed makes the Check partial when ESLint could not parse a
	// file of its scope: its score counts hits, and a file nobody read has none.
	partialOnUnparsed bool
}

func (g eslintGroup) spec(in *Input) eslintGroupSpec {
	except := append([]string{}, g.except...)
	sort.Strings(except)
	rules := append([]eslintRuleSpec{}, g.rules...)
	sort.Slice(rules, func(i, j int) bool { return rules[i].Name < rules[j].Name })
	spec := eslintGroupSpec{
		ID: g.checkID, CoreProblem: g.coreProblem, Except: except, CoreOptions: map[string][]any{},
		Plugins: append([]string{}, g.plugins...), Rules: rules, TestOnly: g.testOnly, SourceOnly: g.sourceOnly, Settings: map[string]any{},
	}
	for name, options := range g.coreOptions {
		spec.CoreOptions[name] = options
	}
	if g.settings != nil {
		spec.Settings = g.settings(in)
	}
	return spec
}
