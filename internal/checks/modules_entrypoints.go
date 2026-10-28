package checks

import (
	"encoding/json"
	"path"
	"regexp"
	"sort"
	"strings"
)

// entryPointsLookedFor names what productionEntryPoints and
// deploymentEntryPoints look for, for the Limitation of a package in which they
// find none.
const entryPointsLookedFor = "`main` (or `index.js` when `main` is missing or names no file), the file targets of `exports`, the `bin` files, the file of a `start` script of the form `node [options] <file>`, and " + deploymentFilesLookedFor

// productionEntryPoints returns the package-relative files from which a
// package's production code starts, as package.json names them: `main`, or
// index.js when `main` is missing or names no file, as Node loads it; every
// file target of `exports` under any condition; every `bin` file; and the file
// of a `start` script that is a plain `node [options] <file>`. Nothing is run.
// Only targets in covered, the files the cruise covers, count, so a missing
// file, a file outside the package and Build output drop out. exists says
// whether a package-relative file is on disk, covered or not. The list is in
// that order, sorted within `exports` and `bin`, each file once. It is empty
// when nothing is found or package.json is not JSON.
func productionEntryPoints(manifest []byte, covered map[string]bool, exists func(string) bool) []string {
	var m struct {
		Main    json.RawMessage            `json:"main"`
		Exports json.RawMessage            `json:"exports"`
		Bin     json.RawMessage            `json:"bin"`
		Scripts map[string]json.RawMessage `json:"scripts"`
	}
	if json.Unmarshal(manifest, &m) != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(files ...string) {
		for _, f := range files {
			if f != "" && !seen[f] {
				seen[f] = true
				out = append(out, f)
			}
		}
	}

	// Node ignores a `main` that is not a string, and then loads index.js. It
	// also loads index.js when `main` names no file (DEP0128). A `main` that
	// names a file the cruise does not cover, such as Build output, or a path
	// outside the package, is what Node loads, so index.js is no entry point.
	main, ok := manifestString(m.Main)
	switch {
	case !ok || main == "" || !namesAFile(main, exists):
		if covered["index.js"] {
			add("index.js")
		}
	default:
		add(resolveLikeRequire(main, covered))
	}

	var exports []string
	var exportsTree any
	if json.Unmarshal(m.Exports, &exportsTree) == nil {
		for _, target := range stringLeaves(exportsTree) {
			exports = append(exports, exportTargets(target, covered)...)
		}
	}
	sort.Strings(exports)
	add(exports...)

	var bins []string
	if bin, ok := manifestString(m.Bin); ok {
		bins = append(bins, exactTarget(bin, covered))
	} else {
		var named map[string]json.RawMessage
		if json.Unmarshal(m.Bin, &named) == nil {
			for _, raw := range named {
				if bin, ok := manifestString(raw); ok {
					bins = append(bins, exactTarget(bin, covered))
				}
			}
		}
	}
	sort.Strings(bins)
	add(bins...)

	if start, ok := manifestString(m.Scripts["start"]); ok {
		if file := nodeScriptFile(start); file != "" {
			add(resolveLikeRequire(file, covered))
		}
	}
	return out
}

func manifestString(raw json.RawMessage) (string, bool) {
	var s string
	err := json.Unmarshal(raw, &s)
	return s, err == nil
}

// stringLeaves returns the strings of a decoded JSON value, at any depth.
func stringLeaves(v any) []string {
	var children []any
	switch t := v.(type) {
	case string:
		return []string{t}
	case []any:
		children = t
	case map[string]any:
		for _, e := range t {
			children = append(children, e)
		}
	}
	var out []string
	for _, e := range children {
		out = append(out, stringLeaves(e)...)
	}
	return out
}

// packagePath cleans a path that package.json gives relative to the package,
// or returns "" for one that leaves the package.
func packagePath(p string) string {
	if p == "" || path.IsAbs(p) {
		return ""
	}
	p = path.Clean(p)
	if p == ".." || strings.HasPrefix(p, "../") {
		return ""
	}
	return p
}

// exactTarget is the covered file a path names exactly, or "".
func exactTarget(p string, covered map[string]bool) string {
	if p = packagePath(p); covered[p] {
		return p
	}
	return ""
}

// resolveLikeRequire is the covered file that `require` would load for a path
// relative to the package: the file itself, the file with `.js` added, or the
// folder's index.js. It returns "" for none.
func resolveLikeRequire(p string, covered map[string]bool) string {
	for _, c := range requireCandidates(p) {
		if covered[c] {
			return c
		}
	}
	return ""
}

// requireCandidates are the files `require` tries for a path relative to the
// package, in order, or nil for a path that leaves the package.
func requireCandidates(p string) []string {
	if p = packagePath(p); p == "" {
		return nil
	}
	return []string{p, p + ".js", path.Join(p, "index.js")}
}

// namesAFile says whether `main` names a file Node can load: one of the files
// `require` tries exists, or the path leaves the package, where the tool does
// not look.
func namesAFile(main string, exists func(string) bool) bool {
	candidates := requireCandidates(main)
	if candidates == nil {
		return true
	}
	for _, c := range candidates {
		if exists(c) {
			return true
		}
	}
	return false
}

// exportTargets returns the covered files an `exports` target names. A target
// with one `*` is a subpath pattern and names every covered file it matches.
func exportTargets(target string, covered map[string]bool) []string {
	switch strings.Count(target, "*") {
	case 0:
		if f := exactTarget(target, covered); f != "" {
			return []string{f}
		}
		return nil
	case 1:
		prefix, suffix, _ := strings.Cut(target, "*")
		prefix = strings.TrimPrefix(prefix, "./")
		if strings.HasPrefix(prefix, "../") || strings.HasPrefix(prefix, "/") {
			return nil
		}
		var out []string
		for f := range covered {
			if len(f) > len(prefix)+len(suffix) && strings.HasPrefix(f, prefix) && strings.HasSuffix(f, suffix) {
				out = append(out, f)
			}
		}
		return out
	}
	return nil
}

var (
	// shellSyntax are the characters that make a script more than one plain
	// command: operators, substitutions, redirections and quotes.
	shellSyntax = regexp.MustCompile("[;&|<>`$()\"'\\\\]")
)

// nodeOptionsWithValue are the Node options whose value is the next word.
var nodeOptionsWithValue = map[string]bool{
	"-r": true, "--require": true, "--import": true, "--loader": true, "--experimental-loader": true,
	"--env-file": true, "--input-type": true, "-C": true, "--conditions": true, "--title": true,
	"--inspect-port": true, "--redirect-warnings": true,
}

// nodeOptionsWithoutFile are the Node options after which Node runs no file.
var nodeOptionsWithoutFile = map[string]bool{
	"-e": true, "--eval": true, "-p": true, "--print": true, "-i": true, "--interactive": true,
	"-c": true, "--check": true, "--test": true, "--run": true, "-v": true, "--version": true,
	"-h": true, "--help": true,
}

// nodeScriptFile returns the file of a script that is a plain
// `node [options] <file> [arguments]`, possibly after variable assignments,
// or "" for any other script.
func nodeScriptFile(script string) string {
	if shellSyntax.MatchString(script) {
		return ""
	}
	return nodeCommandFile(strings.Fields(script))
}

// withoutEnvAssignments drops the `NAME=value` words that come in front of a
// command.
func withoutEnvAssignments(words []string) []string {
	for len(words) > 0 && envAssignment.MatchString(words[0]) {
		words = words[1:]
	}
	return words
}

// nodeCommandFile returns the file that the words of one command run when they
// are `node [options] <file> [arguments]`, possibly after variable
// assignments, or "". `node` may be given with its folder.
func nodeCommandFile(words []string) string {
	words = withoutEnvAssignments(words)
	if len(words) == 0 || path.Base(words[0]) != "node" {
		return ""
	}
	for i := 1; i < len(words); i++ {
		w := words[i]
		switch {
		case w == "--":
			if i+1 < len(words) {
				return words[i+1]
			}
			return ""
		case nodeOptionsWithoutFile[w]:
			return ""
		case nodeOptionsWithValue[w]:
			i++
		case strings.HasPrefix(w, "-"):
		default:
			return w
		}
	}
	return ""
}

// reachedFrom walks the import edges from each entry point in turn and maps
// every file it reaches, the entry point included, to the first entry point
// that reaches it. A file is visited once, so cycles end.
func reachedFrom(entries []string, edges map[string][]string) map[string]string {
	reached := map[string]string{}
	for _, entry := range entries {
		if _, ok := reached[entry]; ok {
			continue
		}
		reached[entry] = entry
		queue := []string{entry}
		for len(queue) > 0 {
			f := queue[0]
			queue = queue[1:]
			for _, to := range edges[f] {
				if _, ok := reached[to]; !ok {
					reached[to] = entry
					queue = append(queue, to)
				}
			}
		}
	}
	return reached
}
