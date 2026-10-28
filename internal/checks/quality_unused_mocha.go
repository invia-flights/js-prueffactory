package checks

import (
	"encoding/json"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// This file corrects what Knip reports about a package that runs its tests
// with Mocha. Knip reads the `require` and `file` entries of a Mocha config
// relative to the config file, while Mocha reads them relative to the working
// folder, which is the package folder. Knip ignores `reporter`. And a binary
// that only a CI script runs, such as c8, looks unused to it. The corrections
// work on Knip's report and on what the package's own files say; nothing of
// the project is run.

// commandSeparators are the shell operators that start a new command.
var commandSeparators = regexp.MustCompile("&&|\\|\\||[;|()`\n]")

// commandWords splits a command line into the words of each command in it,
// at the shell operators that start a new command. Quotes are only trimmed
// off the words, not interpreted: the result is a guess at what a script runs,
// good enough to find the binary a command starts with.
func commandWords(line string) [][]string {
	var out [][]string
	for _, segment := range commandSeparators.Split(line, -1) {
		var words []string
		for _, w := range strings.Fields(segment) {
			words = append(words, strings.Trim(w, `"'`))
		}
		if len(words) > 0 {
			out = append(out, words)
		}
	}
	return out
}

// cleanPackagePath cleans a path that a script or Mocha writes relative to the
// package folder. It says false for an absolute path and for one that leaves
// the package.
func cleanPackagePath(p string) (string, bool) {
	if p == "" || strings.HasPrefix(p, "/") {
		return "", false
	}
	p = path.Clean(p)
	if p == "." || p == ".." || strings.HasPrefix(p, "../") {
		return "", false
	}
	return p, true
}

// mochaConfigFiles returns the package-relative paths of the Mocha config
// files of a package: the `--config` of every `mocha …` command in a package
// script, and the `.mocharc.*` files in the package folder. The scripts are
// those of package.json, by name; files lists the package-relative file names
// of the package.
func mochaConfigFiles(scripts map[string]string, files []string) []string {
	set := map[string]bool{}
	for _, script := range scripts {
		for _, words := range commandWords(script) {
			for i, w := range words {
				if b := path.Base(w); b != "mocha" && b != "_mocha" {
					continue
				}
				for _, a := range discovery.ParseMochaArgs(words[i+1:]) {
					if a.Name != "config" {
						continue
					}
					if rel, ok := cleanPackagePath(a.Value); ok {
						set[rel] = true
					}
				}
				break
			}
		}
	}
	for _, f := range files {
		if !strings.Contains(f, "/") && strings.HasPrefix(f, ".mocharc.") {
			set[f] = true
		}
	}
	out := make([]string, 0, len(set))
	for f := range set {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// resolveExtensions are the endings tried for a module path without one, the
// ones of Node's resolution in the order it tries them, then the ones of
// TypeScript that Mocha can load through a loader.
var resolveExtensions = []string{"", ".js", ".json", ".node", ".cjs", ".mjs", ".ts", ".mts", ".cts"}

// resolveFromPackage resolves a relative module path the way Mocha does, from
// the package folder, with Node's extension and folder-index resolution. exists
// says whether a package-relative file exists. It returns the package-relative
// file, and false when the path leaves the package or names no file.
func resolveFromPackage(exists func(string) bool, spec string) (string, bool) {
	rel, ok := cleanPackagePath(spec)
	if !ok {
		return "", false
	}
	for _, ext := range resolveExtensions {
		if exists(rel + ext) {
			return rel + ext, true
		}
	}
	for _, ext := range resolveExtensions[1:] {
		if exists(rel + "/index" + ext) {
			return rel + "/index" + ext, true
		}
	}
	return "", false
}

// mochaFacts is what the package says about the files Mocha loads and the
// dependencies it uses.
type mochaFacts struct {
	// configs are the package-relative paths of the Mocha config files.
	configs map[string]bool
	// exists says whether a package-relative file exists.
	exists func(string) bool
	// quoted holds the quoted string literals of the Mocha config files and of
	// the local modules they require.
	quoted map[string]bool
	// binaries holds the first words of the commands in the package's shell
	// scripts, Dockerfiles and .gitlab-ci.yml.
	binaries map[string]bool
}

// readScripts returns the `scripts` of a package.json, left empty when the
// file is missing, unreadable or not JSON.
func readScripts(dir string) map[string]string {
	data, err := readCapped(filepath.Join(dir, "package.json"), maxProjectFileBytes)
	if err != nil {
		return nil
	}
	var m struct {
		Scripts map[string]json.RawMessage `json:"scripts"`
	}
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	out := map[string]string{}
	for k, v := range m.Scripts {
		var s string
		if json.Unmarshal(v, &s) == nil {
			out[k] = s
		}
	}
	return out
}

// maxConfigModules bounds how many local modules of a Mocha config are read
// for quoted strings.
const maxConfigModules = 30

// localRequire finds the relative module paths that a JavaScript file requires
// or imports.
var localRequire = regexp.MustCompile(`(?:require\(|import\(|\bfrom\s+|\bimport\s+)\s*['"](\.{1,2}/[^'"\n]*|\.{1,2})['"]`)

// newMochaFacts reads what the package says about Mocha from the Snapshot.
func (in *Input) newMochaFacts() *mochaFacts {
	pkg := in.Context.Package
	dir := filepath.Join(in.SnapshotDir, filepath.FromSlash(pkg.Path))
	have := map[string]bool{}
	var names []string
	for _, f := range pkg.Files {
		have[f.PackageRel] = true
		names = append(names, f.PackageRel)
	}
	m := &mochaFacts{
		configs: map[string]bool{}, exists: func(rel string) bool { return have[rel] },
		quoted: map[string]bool{}, binaries: map[string]bool{},
	}
	read := func(rel string) []byte {
		data, err := readCapped(filepath.Join(dir, filepath.FromSlash(rel)), maxProjectFileBytes)
		if err != nil {
			return nil
		}
		return data
	}
	configs := mochaConfigFiles(readScripts(dir), names)
	for _, c := range configs {
		m.configs[c] = true
	}

	// The quoted strings of a config, and of the local modules it requires: a
	// config is often built by a shared helper that names the reporter.
	queue, seen := append([]string{}, configs...), map[string]bool{}
	for len(queue) > 0 && len(seen) < maxConfigModules {
		rel := queue[0]
		queue = queue[1:]
		if seen[rel] || !have[rel] {
			continue
		}
		seen[rel] = true
		data := read(rel)
		for q := range quotedStrings(rel, data) {
			m.quoted[q] = true
		}
		if !isScannableSource(rel) {
			continue
		}
		for _, match := range localRequire.FindAllSubmatch(data, -1) {
			if next, ok := resolveFromPackage(m.exists, path.Join(path.Dir(rel), string(match[1]))); ok {
				queue = append(queue, next)
			}
		}
	}

	for _, f := range pkg.Files {
		if f.Class == discovery.TestData || f.Class == discovery.BuildOutput {
			continue
		}
		var lines []string
		switch base := path.Base(f.PackageRel); {
		case base == ".gitlab-ci.yml" || base == ".gitlab-ci.yaml":
			lines = gitlabScriptLines(read(f.PackageRel))
		case base == "Dockerfile" || strings.HasPrefix(base, "Dockerfile.") || strings.HasSuffix(base, ".Dockerfile"):
			lines = dockerfileRunLines(string(read(f.PackageRel)))
		case path.Ext(base) == ".sh" || path.Ext(base) == ".bash" || shebangShell(in.SnapshotDir, f.Path) != "":
			lines = strings.Split(string(read(f.PackageRel)), "\n")
		}
		for _, line := range lines {
			for _, b := range commandBinaries(line) {
				m.binaries[b] = true
			}
		}
	}
	return m
}

// quotedLiteral matches a string literal without escapes or interpolation.
var quotedLiteral = regexp.MustCompile("\"([^\"\\\\\n]{1,200})\"|'([^'\\\\\n]{1,200})'|`([^`\\\\$\n]{1,200})`")

// quotedStrings returns the string literals of a config file, or for a YAML
// file all its scalar values, which need no quotes.
func quotedStrings(name string, data []byte) map[string]bool {
	out := map[string]bool{}
	if ext := path.Ext(name); ext == ".yml" || ext == ".yaml" {
		var doc any
		if yaml.Unmarshal(data, &doc) == nil {
			yamlStrings(doc, out)
		}
		return out
	}
	for _, m := range quotedLiteral.FindAllSubmatch(data, -1) {
		for _, g := range m[1:] {
			if len(g) > 0 {
				out[string(g)] = true
			}
		}
	}
	return out
}

func yamlStrings(v any, out map[string]bool) {
	switch x := v.(type) {
	case string:
		out[x] = true
	case []any:
		for _, e := range x {
			yamlStrings(e, out)
		}
	case map[string]any:
		for _, e := range x {
			yamlStrings(e, out)
		}
	}
}

// namedByQuotedString says whether a package is named by one of the quoted
// strings: exactly, or as the package part of a subpath such as
// "chai/register-expect".
func namedByQuotedString(quoted map[string]bool, dep string) bool {
	if quoted[dep] {
		return true
	}
	for q := range quoted {
		if strings.HasPrefix(q, dep+"/") {
			return true
		}
	}
	return false
}

// binaryRunsDependency says whether a command binary is the binary of a
// package. Without the package's own `bin` entry, which is in the installed
// package and not in the Snapshot, the binary has the package's name, or the
// part after the scope of a scoped package.
func binaryRunsDependency(binaries map[string]bool, dep string) bool {
	if binaries[dep] {
		return true
	}
	if strings.HasPrefix(dep, "@") {
		if _, name, ok := strings.Cut(dep, "/"); ok {
			return binaries[name]
		}
	}
	return false
}

var envAssignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// commandPrefixes are words that come in front of a command without being it.
var commandPrefixes = map[string]bool{"exec": true, "env": true, "time": true, "then": true, "do": true, "else": true, "!": true}

// commandBinaries returns the binaries a shell command line starts commands
// with: the first word of each command, after env assignments, `exec` and
// `npx`. A command that follows `npx` anywhere in a command is one too, as in
// `docker compose run app npx c8 npm test`.
func commandBinaries(line string) []string {
	if strings.HasPrefix(strings.TrimSpace(line), "#") {
		return nil
	}
	var out []string
	for _, words := range commandWords(line) {
		i := 0
		for i < len(words) && (envAssignment.MatchString(words[i]) || commandPrefixes[words[i]]) {
			i++
		}
		if i >= len(words) {
			continue
		}
		first := words[i]
		switch {
		case first == "npx":
			out = append(out, npxBinary(words[i+1:])...)
			continue
		case first == "npm" && i+1 < len(words) && (words[i+1] == "exec" || words[i+1] == "x"):
			out = append(out, npxBinary(words[i+2:])...)
			continue
		}
		out = append(out, path.Base(first))
		for j := i + 1; j < len(words); j++ {
			if words[j] == "npx" {
				out = append(out, npxBinary(words[j+1:])...)
			}
		}
	}
	return out
}

// npxBinary returns the binary that npx runs: its first word that is neither an
// option nor an option's value, without a version.
func npxBinary(words []string) []string {
	for i := 0; i < len(words); i++ {
		w := words[i]
		switch {
		case w == "-p" || w == "--package" || w == "-c" || w == "--call":
			i++
		case strings.HasPrefix(w, "-"):
		default:
			if at := strings.LastIndex(w, "@"); at > 0 {
				w = w[:at]
			}
			return []string{path.Base(w)}
		}
	}
	return nil
}

var dockerRun = regexp.MustCompile(`(?i)^RUN\s+(.*)$`)

// dockerfileRunLines returns the commands of the RUN instructions of a
// Dockerfile, with their line continuations joined and their options removed.
// A RUN in exec form is not a shell command line and is left out.
func dockerfileRunLines(content string) []string {
	var out []string
	lines := strings.Split(content, "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		for strings.HasSuffix(line, `\`) && i+1 < len(lines) {
			i++
			line = strings.TrimSuffix(line, `\`) + strings.TrimRight(lines[i], "\r")
		}
		m := dockerRun.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		cmd := strings.TrimSpace(m[1])
		for strings.HasPrefix(cmd, "--") {
			_, rest, _ := strings.Cut(cmd, " ")
			cmd = strings.TrimSpace(rest)
		}
		if cmd == "" || strings.HasPrefix(cmd, "[") {
			continue
		}
		out = append(out, cmd)
	}
	return out
}

// gitlabScriptLines returns the command lines of every `script`,
// `before_script` and `after_script` of a .gitlab-ci.yml.
func gitlabScriptLines(data []byte) []string {
	var doc any
	if yaml.Unmarshal(data, &doc) != nil {
		return nil
	}
	var out []string
	var add func(v any)
	add = func(v any) {
		switch x := v.(type) {
		case string:
			for _, l := range strings.Split(x, "\n") {
				if l = strings.TrimSpace(l); l != "" {
					out = append(out, l)
				}
			}
		case []any:
			for _, e := range x {
				add(e)
			}
		}
	}
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, e := range x {
				switch k {
				case "script", "before_script", "after_script":
					add(e)
				default:
					walk(e)
				}
			}
		case []any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(doc)
	return out
}

// correctKnip reads Knip's report and removes what Knip gets wrong about
// Mocha. It returns the corrected issues and the Mocha-loaded files: the files
// that a Mocha config names relative to the package folder, as the
// package-relative paths of files that exist.
func (in *Input) correctKnip(stdout []byte) ([]knipIssue, []string, error) {
	var report struct {
		Issues []knipIssue `json:"issues"`
	}
	if err := json.Unmarshal(stdout, &report); err != nil {
		return nil, nil, err
	}
	m := in.newMochaFacts()
	loaded := map[string]bool{}
	for i := range report.Issues {
		issue := &report.Issues[i]
		switch file := path.Clean(issue.File); {
		case m.configs[file]:
			var kept []knipItem
			for _, it := range issue.Unresolved {
				if rel, ok := resolveFromPackage(m.exists, it.Name); ok {
					loaded[rel] = true
					continue
				}
				kept = append(kept, it)
			}
			issue.Unresolved = kept
		case file == "package.json":
			issue.Dependencies = dropItems(issue.Dependencies, func(name string) bool { return namedByQuotedString(m.quoted, name) })
			issue.DevDeps = dropItems(issue.DevDeps, func(name string) bool {
				return namedByQuotedString(m.quoted, name) || binaryRunsDependency(m.binaries, name)
			})
		}
	}
	// Mocha's own answer, from the test file probe: what it loads through
	// `file`, `require` and `import`, also when a config builds those lists in
	// code and Knip has no unresolved import to learn them from.
	// A spec file is Mocha-loaded as well, but Knip learns most of them itself,
	// so only those that it reported as unused count. A Suite that names a
	// folder (`mocha test/modules`) is the case where it does not.
	reportedUnused := map[string]bool{}
	for _, issue := range report.Issues {
		if len(issue.Files) > 0 {
			reportedUnused[path.Clean(issue.File)] = true
		}
	}
	for _, f := range ProbedTestFiles(in.Shared, in.Context.ID) {
		rel, ok := relToPackage(in.Context.Package, f.Path)
		if !ok || !m.exists(rel) || (f.Kind == "spec" && !reportedUnused[rel]) {
			continue
		}
		loaded[rel] = true
	}
	files := make([]string, 0, len(loaded))
	for f := range loaded {
		files = append(files, f)
	}
	sort.Strings(files)
	return report.Issues, files, nil
}

// relToPackage turns a project path into the path relative to the package folder,
// for a file inside the package.
func relToPackage(pkg *discovery.Package, projectPath string) (string, bool) {
	if pkg.Path == "." {
		return projectPath, true
	}
	return strings.CutPrefix(projectPath, pkg.Path+"/")
}

// dropItems returns the items that drop does not accept.
func dropItems(items []knipItem, drop func(name string) bool) []knipItem {
	var kept []knipItem
	for _, it := range items {
		if !drop(it.Name) {
			kept = append(kept, it)
		}
	}
	return kept
}
