package discovery

import (
	"path"
	"regexp"
	"strings"
)

// nodeTestName is Node's documented naming rule for test files outside a
// folder named `test`: the file name without its extension is `test`, starts
// with `test-`, or ends in `.test`, `-test` or `_test`.
var nodeTestName = regexp.MustCompile(`^test$|^test-.+|.+[.\-_]test$`)

// NodeTestFiles returns the package files a `node --test` suite runs. rels are
// the package's files relative to the package folder, args are the arguments
// after `node`.
//
// With file arguments it is exactly what they name: a path, or a glob. Without
// any it is what Node's documented default discovery finds: every .js, .cjs
// and .mjs file below a folder named `test`, and elsewhere those whose name
// follows nodeTestName. node_modules is not searched. The defaults are for
// these suites only: no other runner's files are chosen by their names.
func NodeTestFiles(rels []string, args []string) []string {
	var patterns []string
	for _, a := range ParseNodeTestArgs(args) {
		if a.File {
			patterns = append(patterns, a.Value)
		}
	}
	var out []string
	if len(patterns) == 0 {
		for _, rel := range rels {
			if nodeDefaultTestFile(rel) {
				out = append(out, rel)
			}
		}
		return out
	}
	seen := map[string]bool{}
	add := func(rel string) {
		if !seen[rel] {
			seen[rel] = true
			out = append(out, rel)
		}
	}
	for _, pat := range patterns {
		pat = path.Clean(strings.TrimPrefix(pat, "./"))
		if pat == "." || path.IsAbs(pat) || pat == ".." || strings.HasPrefix(pat, "../") {
			continue
		}
		for _, p := range expandBraces(pat) {
			if !strings.ContainsAny(p, "*?[") {
				for _, rel := range rels {
					if rel == p {
						add(rel)
					}
				}
				continue
			}
			parts := strings.Split(p, "/")
			for _, rel := range rels {
				if inNodeModules(rel) && !strings.Contains(p, "node_modules") {
					continue
				}
				if globMatch(parts, strings.Split(rel, "/")) {
					add(rel)
				}
			}
		}
	}
	return out
}

// nodeDefaultTestFile says whether Node's default discovery runs the file.
func nodeDefaultTestFile(rel string) bool {
	ext := path.Ext(rel)
	if !mochaExtensions[ext] || inNodeModules(rel) {
		return false
	}
	dir, base := path.Split(rel)
	for _, part := range strings.Split(strings.Trim(dir, "/"), "/") {
		if part == "test" {
			return true
		}
	}
	return nodeTestName.MatchString(strings.TrimSuffix(base, ext))
}

func inNodeModules(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == "node_modules" {
			return true
		}
	}
	return false
}
