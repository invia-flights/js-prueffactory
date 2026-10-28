package discovery

import (
	"encoding/json"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// maxConfigBytes is the size above which Discovery does not read a project's
// config file: tsconfig.json and package.json are small, and the project is
// untrusted input.
const maxConfigBytes = 1 << 20

// regularJSON reads a JSON or JSONC file that is a regular file below root, up
// to maxConfigBytes. The read is confined to root with os.Root, so a symlinked
// folder (or file) in the project cannot lead it outside, and the file itself
// must not be a link or a special file.
func regularJSON(root, file string, out any) bool {
	rel, err := filepath.Rel(root, file)
	if err != nil || !filepath.IsLocal(rel) {
		return false
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return false
	}
	defer r.Close()
	if info, err := r.Lstat(rel); err != nil || !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return false
	}
	f, err := r.Open(rel)
	if err != nil {
		return false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes {
		return false
	}
	return json.Unmarshal(StripJSONC(data, true), out) == nil
}

// tsEmitSignal says which compiler option of the package's tsconfig.json, with
// the relative configs it extends, makes the compiler write output, or "".
// noEmit wins. A config that extends a package (@tsconfig/node20) cannot be
// followed and gives no signal.
func tsEmitSignal(root, folder string) string {
	opts := map[string]json.RawMessage{}
	loadTsconfigOptions(root, filepath.Join(folder, "tsconfig.json"), opts, 0, map[string]bool{})
	if string(opts["noEmit"]) == "true" {
		return ""
	}
	for _, key := range []string{"outDir", "outFile", "rootDir", "declarationDir"} {
		if v, ok := opts[key]; ok && string(v) != "null" && string(v) != `""` {
			return "the compiler option " + key
		}
	}
	if string(opts["declaration"]) == "true" {
		return "the compiler option declaration"
	}
	return ""
}

// loadTsconfigOptions merges compilerOptions into opts: what a config extends
// first, then its own options on top, as TypeScript does.
func loadTsconfigOptions(root, file string, opts map[string]json.RawMessage, depth int, seen map[string]bool) {
	if depth > 5 || seen[file] {
		return
	}
	seen[file] = true
	var cfg struct {
		Extends         json.RawMessage            `json:"extends"`
		CompilerOptions map[string]json.RawMessage `json:"compilerOptions"`
	}
	if !regularJSON(root, file, &cfg) {
		return
	}
	var bases []string
	var one string
	if json.Unmarshal(cfg.Extends, &one) == nil && one != "" {
		bases = []string{one}
	} else {
		_ = json.Unmarshal(cfg.Extends, &bases)
	}
	for _, base := range bases {
		if !strings.HasPrefix(base, "./") && !strings.HasPrefix(base, "../") {
			continue
		}
		target := filepath.Join(filepath.Dir(file), filepath.FromSlash(base))
		if !strings.HasSuffix(target, ".json") {
			target += ".json"
		}
		loadTsconfigOptions(root, target, opts, depth+1, seen)
	}
	for k, v := range cfg.CompilerOptions {
		opts[k] = v
	}
}

// buildTools are the commands that produce the JavaScript that runs from
// TypeScript sources when a package script runs them.
var buildTools = map[string]bool{
	"tsc": true, "tsup": true, "esbuild": true, "swc": true, "babel": true,
	"rollup": true, "webpack": true, "vite": true, "parcel": true,
}

var commandSeparator = regexp.MustCompile(`&&|\|\||;|\|`)

// buildScript returns "scripts.<name>" for the first script (by name) in the
// package.json that runs a compiler or bundler, or "". tsc only counts without
// --noEmit, because a type check builds nothing.
func buildScript(root, manifest string) string {
	var m struct {
		Scripts map[string]string `json:"scripts"`
	}
	if !regularJSON(root, manifest, &m) {
		return ""
	}
	names := make([]string, 0, len(m.Scripts))
	for name := range m.Scripts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		for _, command := range commandSeparator.Split(m.Scripts[name], -1) {
			words := strings.Fields(command)
			noEmit := slices.ContainsFunc(words, func(w string) bool { return strings.EqualFold(strings.TrimLeft(w, "-"), "noEmit") })
			for _, w := range words {
				tool := path.Base(strings.Trim(w, `"'`))
				if buildTools[tool] && !(tool == "tsc" && noEmit) {
					return "scripts." + name
				}
			}
		}
	}
	return ""
}
