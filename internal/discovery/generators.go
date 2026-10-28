package discovery

import (
	"path"
	"sort"
	"strings"
)

// GeneratorScript is a script of a package.json that schema.drift runs: a
// generator-like name and a command that is a plain `node <file>` call.
type GeneratorScript struct {
	// Name is the script's name in package.json.
	Name string
	// Env holds the VAR=value assignments in front of the command, or nil.
	Env map[string]string
	// File is the .js, .cjs or .mjs file the command runs, as a clean path
	// relative to the package folder.
	File string
	// Args are the arguments after the file, or nil.
	Args []string
}

// lifecycleScripts are the npm lifecycle names, with their pre and post forms,
// that never count as generator scripts.
var lifecycleScripts = func() map[string]bool {
	m := map[string]bool{}
	for _, base := range []string{"prepare", "install", "test", "start", "build"} {
		for _, prefix := range []string{"", "pre", "post"} {
			m[prefix+base] = true
		}
	}
	return m
}()

// generatorName says whether a script name points to generation: it contains
// `schema`, `swagger`, `openapi` or `codegen`, or starts with `generate` or
// `gen:`, and it is not an npm lifecycle name.
func generatorName(name string) bool {
	if lifecycleScripts[name] {
		return false
	}
	n := strings.ToLower(name)
	if strings.HasPrefix(n, "generate") || strings.HasPrefix(n, "gen:") {
		return true
	}
	for _, word := range []string{"schema", "swagger", "openapi", "codegen"} {
		if strings.Contains(n, word) {
			return true
		}
	}
	return false
}

// GeneratorScripts returns the generator scripts of a package.json in name
// order. A script is one when its name points to generation (generatorName) and
// its command, after the leading `VAR=value` assignments, is exactly `node
// <relative .js, .cjs or .mjs file> [arguments]` with no shell syntax: no
// `&&`, pipe, redirect, substitution or variable expansion. Anything else is
// ignored. `scripts` holds the package's scripts that are strings; nothing is
// run.
func GeneratorScripts(scripts map[string]string) []GeneratorScript {
	var out []GeneratorScript
	for name, text := range scripts {
		if !generatorName(name) {
			continue
		}
		if g, ok := plainNodeCall(name, text); ok {
			out = append(out, g)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// plainNodeCall reads a command that is exactly one `node <file> [args]` call.
func plainNodeCall(name, text string) (GeneratorScript, bool) {
	steps, problem := splitSteps(text)
	if problem != "" || len(steps) != 1 {
		return GeneratorScript{}, false
	}
	words := steps[0].words
	g := GeneratorScript{Name: name}
	i := 0
	for ; i < len(words) && assignment.MatchString(words[i]); i++ {
		k, v, _ := strings.Cut(words[i], "=")
		if g.Env == nil {
			g.Env = map[string]string{}
		}
		g.Env[k] = v
	}
	// The first word after node is the file: an option such as -e or
	// --require would run other code than the file.
	if i+1 >= len(words) || words[i] != "node" {
		return GeneratorScript{}, false
	}
	file := path.Clean(words[i+1])
	switch path.Ext(file) {
	case ".js", ".cjs", ".mjs":
	default:
		return GeneratorScript{}, false
	}
	if strings.HasPrefix(file, "/") || file == ".." || strings.HasPrefix(file, "../") || strings.HasPrefix(file, "-") {
		return GeneratorScript{}, false
	}
	g.File = file
	if rest := words[i+2:]; len(rest) > 0 {
		g.Args = rest
	}
	return g, true
}
