package discovery

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// mochaConfigNames are the Mocha config files in a package's folder, in the
// order Mocha looks for them.
var mochaConfigNames = []string{
	".mocharc.cjs", ".mocharc.js", ".mocharc.yaml", ".mocharc.yml", ".mocharc.json", ".mocharc.jsonc", ".mocharc.mjs",
}

// readTestInfo reads how every package runs its own tests, and marks the files
// the runner loads as Test code. It reads `scripts.test` and the Mocha config
// file as text and never runs either.
func readTestInfo(root string, proj *Project) {
	loaded := map[string]bool{}
	for _, pkg := range proj.Packages {
		dir := filepath.Join(root, filepath.FromSlash(pkg.Path))
		pkg.Tests = testCommandOf(dir, pkg)
		pkg.MochaDependency = readMochaDependency(dir)
		pkg.GeneratorScripts = GeneratorScripts(readScripts(dir))
		if pkg.Tests == nil || pkg.Tests.Unsupported != nil {
			continue
		}
		for i := range pkg.Tests.Suites {
			if pkg.Tests.Suites[i].Runner != RunnerMocha {
				continue
			}
			for _, f := range loadedByMocha(dir, pkg, &pkg.Tests.Suites[i]) {
				loaded[f] = true
			}
		}
	}
	if len(loaded) == 0 {
		return
	}
	reclassify := func(files []File) {
		for i := range files {
			if loaded[files[i].Path] && files[i].Class == Source {
				files[i].Class = TestCode
			}
		}
	}
	reclassify(proj.Files)
	for _, pkg := range proj.Packages {
		reclassify(pkg.Files)
	}
}

// testCommandOf decides how a package runs its tests: its `scripts.test`, or
// Mocha when a `.mocharc.*` file sits in the package folder and the script is
// missing or only npm's placeholder. It returns nil for a package without
// tests.
func testCommandOf(dir string, pkg *Package) *TestSetup {
	scripts := readScripts(dir)
	if script := strings.TrimSpace(scripts["test"]); script != "" && !placeholderTest.MatchString(script) {
		scripts["test"] = script
		return ResolveTestScript(scripts)
	}
	if name := mochaConfigName(pkg); name != "" {
		return &TestSetup{Suites: []Suite{{Runner: RunnerMocha, Origin: name}}}
	}
	return nil
}

// readScripts reads the string-valued `scripts` of the package's manifest. A
// manifest that is missing or not JSON has none.
func readScripts(dir string) map[string]string {
	scripts := map[string]string{}
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return scripts
	}
	var m struct {
		Scripts map[string]any `json:"scripts"`
	}
	if json.Unmarshal(data, &m) != nil {
		return scripts
	}
	for k, v := range m.Scripts {
		if s, ok := v.(string); ok {
			scripts[k] = s
		}
	}
	return scripts
}

// readMochaDependency says whether the package's manifest lists `mocha` under
// `dependencies` or `devDependencies`. A manifest that is missing or not JSON
// counts as no.
func readMochaDependency(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var m struct {
		Dependencies    map[string]json.RawMessage `json:"dependencies"`
		DevDependencies map[string]json.RawMessage `json:"devDependencies"`
	}
	if json.Unmarshal(data, &m) != nil {
		return false
	}
	_, dep := m.Dependencies["mocha"]
	_, dev := m.DevDependencies["mocha"]
	return dep || dev
}

// UsesMocha is the one decision "the package uses Mocha": its test command
// runs Mocha, or `mocha` is a dependency or devDependency, or a `.mocharc.*`
// file sits in the package root. It holds however the test script is written,
// also when the script is one the tool does not run.
func (p *Package) UsesMocha() bool {
	if p.Tests != nil {
		for _, s := range p.Tests.Suites {
			if s.Runner == RunnerMocha {
				return true
			}
		}
	}
	return p.MochaDependency || mochaConfigName(p) != ""
}

func mochaConfigName(pkg *Package) string {
	have := map[string]bool{}
	for _, f := range pkg.Files {
		if !strings.Contains(f.PackageRel, "/") {
			have[f.PackageRel] = true
		}
	}
	for _, name := range mochaConfigNames {
		if have[name] {
			return name
		}
	}
	return ""
}

// mochaOptionsWithValue are the Mocha options that take their value as the
// next word, so that the word is not read as a test file.
var mochaOptionsWithValue = map[string]bool{
	"config": true, "c": true, "require": true, "r": true, "import": true, "reporter": true, "R": true,
	"reporter-option": true, "reporter-options": true, "O": true, "spec": true, "ui": true, "u": true,
	"timeout": true, "t": true, "slow": true, "s": true, "grep": true, "g": true, "fgrep": true, "f": true,
	"retries": true, "file": true, "ignore": true, "exclude": true, "extension": true, "node-option": true,
	"jobs": true, "j": true, "package": true, "watch-files": true, "watch-ignore": true,
}

// mochaSelection is what a Mocha command line and config name as files.
type mochaSelection struct {
	specs     []string // positional words and --spec values: files, folders, globs
	loaded    []string // --require, --import and --file values
	recursive bool
}

// MochaArg is one item of a Mocha command line: an option with its value, or a
// test file argument.
type MochaArg struct {
	// Words are the words of the item as written: `--config x.js` is two
	// words, `--config=x.js` one.
	Words []string
	// Name is the option's name without dashes, empty for a test file.
	Name string
	// Value is the option's value, empty when it has none.
	Value string
	// File is true for a positional word or a --spec option: it names the
	// files Mocha loads.
	File bool
}

// ParseMochaArgs splits Mocha arguments into options and test files. It knows
// which options take their value as the next word, so that the word is not
// taken for a file.
func ParseMochaArgs(args []string) []MochaArg {
	var out []MochaArg
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			for _, rest := range args[i+1:] {
				out = append(out, MochaArg{Words: []string{rest}, Value: rest, File: true})
			}
			return out
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			out = append(out, MochaArg{Words: []string{a}, Value: a, File: true})
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimLeft(a, "-"), "=")
		item := MochaArg{Words: []string{a}, Name: name, Value: value}
		if !hasValue && mochaOptionsWithValue[name] && i+1 < len(args) {
			i++
			item.Words, item.Value = append(item.Words, args[i]), args[i]
		}
		item.File = name == "spec"
		out = append(out, item)
	}
	return out
}

func (m *mochaSelection) addArgs(args []string) {
	for _, a := range ParseMochaArgs(args) {
		switch {
		case a.File:
			m.specs = append(m.specs, a.Value)
		case a.Name == "require" || a.Name == "r" || a.Name == "import" || a.Name == "file":
			m.loaded = append(m.loaded, a.Value)
		case a.Name == "recursive":
			m.recursive = true
		}
	}
}

// addConfig reads the keys of a JSON or YAML Mocha config that name files.
// Configs written as JavaScript are not read.
func (m *mochaSelection) addConfig(data []byte, name string) {
	var cfg map[string]any
	var err error
	switch {
	case strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".jsonc"):
		err = json.Unmarshal(data, &cfg)
	case strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml"):
		err = yaml.Unmarshal(data, &cfg)
	default:
		return
	}
	if err != nil {
		return
	}
	m.specs = append(m.specs, stringsOf(cfg["spec"])...)
	for _, k := range []string{"require", "import", "file"} {
		m.loaded = append(m.loaded, stringsOf(cfg[k])...)
	}
	if r, ok := cfg["recursive"].(bool); ok && r {
		m.recursive = true
	}
}

func stringsOf(v any) []string {
	switch x := v.(type) {
	case string:
		return []string{x}
	case []any:
		var out []string
		for _, e := range x {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// loadedByMocha returns the project paths of the files Mocha loads in a
// package, as far as its command line and config say: test files by path,
// folder or glob, and the files it requires first. A file name that cannot be
// resolved from the text alone, such as a module name, loads nothing here.
func loadedByMocha(dir string, pkg *Package, suite *Suite) []string {
	var sel mochaSelection
	sel.addArgs(suite.Args)
	if name := mochaConfigName(pkg); name != "" {
		if data, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
			sel.addConfig(data, name)
		}
	}
	var rels []string
	for _, f := range pkg.Files {
		rels = append(rels, f.PackageRel)
	}
	var out []string
	add := func(rel string) {
		if pkg.Path == "." {
			out = append(out, rel)
		} else {
			out = append(out, pkg.Path+"/"+rel)
		}
	}
	for _, spec := range sel.specs {
		for _, rel := range matchSpec(rels, spec, sel.recursive, false) {
			add(rel)
		}
	}
	for _, name := range sel.loaded {
		for _, rel := range matchSpec(rels, name, false, true) {
			add(rel)
		}
	}
	return out
}

var mochaExtensions = map[string]bool{".js": true, ".cjs": true, ".mjs": true}

// matchSpec returns the package files a Mocha file argument names. A path that
// does not exist and has no wildcard names nothing. A folder names the
// JavaScript files directly inside it, or at any depth when recursive. A
// required file may leave out its extension.
func matchSpec(rels []string, spec string, recursive, withExtension bool) []string {
	spec = path.Clean(strings.TrimPrefix(spec, "./"))
	if spec == "." || path.IsAbs(spec) || spec == ".." || strings.HasPrefix(spec, "../") {
		return nil
	}
	var out []string
	for _, pat := range expandBraces(spec) {
		if strings.ContainsAny(pat, "*?[") {
			parts := strings.Split(pat, "/")
			for _, rel := range rels {
				if globMatch(parts, strings.Split(rel, "/")) {
					out = append(out, rel)
				}
			}
			continue
		}
		var exact bool
		for _, rel := range rels {
			if rel == pat {
				out, exact = append(out, rel), true
			}
		}
		if exact {
			continue
		}
		for _, rel := range rels {
			switch {
			case withExtension && mochaExtensions[path.Ext(rel)] && strings.TrimSuffix(rel, path.Ext(rel)) == pat:
				out = append(out, rel)
			case strings.HasPrefix(rel, pat+"/") && mochaExtensions[path.Ext(rel)]:
				if recursive || !strings.Contains(strings.TrimPrefix(rel, pat+"/"), "/") {
					out = append(out, rel)
				}
			}
		}
	}
	return out
}

// globMatch matches path segments against pattern segments. `**` matches any
// number of segments, and `*`, `?` and `[…]` follow path.Match.
func globMatch(pat, segs []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			for len(pat) > 0 && pat[0] == "**" {
				pat = pat[1:]
			}
			if len(pat) == 0 {
				return true
			}
			for i := 0; i <= len(segs); i++ {
				if globMatch(pat, segs[i:]) {
					return true
				}
			}
			return false
		}
		if len(segs) == 0 {
			return false
		}
		if ok, err := path.Match(pat[0], segs[0]); err != nil || !ok {
			return false
		}
		pat, segs = pat[1:], segs[1:]
	}
	return len(segs) == 0
}

// expandBraces expands the first {a,b} group of a pattern, recursively.
func expandBraces(p string) []string {
	open := strings.IndexByte(p, '{')
	if open < 0 {
		return []string{p}
	}
	depth, close := 0, -1
	var commas []int
	for i := open; i < len(p) && close < 0; i++ {
		switch p[i] {
		case '{':
			depth++
		case '}':
			if depth--; depth == 0 {
				close = i
			}
		case ',':
			if depth == 1 {
				commas = append(commas, i)
			}
		}
	}
	if close < 0 {
		return []string{p}
	}
	var out []string
	start := open + 1
	for _, end := range append(commas, close) {
		out = append(out, expandBraces(p[:open]+p[start:end]+p[close+1:])...)
		start = end + 1
	}
	return out
}
