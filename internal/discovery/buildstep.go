package discovery

import (
	"encoding/json"
	"path"
	"path/filepath"
	"strings"
)

// buildStepReason returns why a package needs a build step before its
// JavaScript can run, or "" when it does not. Signs are a Babel config, a
// bundler config, or a tsconfig.json next to TypeScript sources that also shows
// an emit signal (see tsEmitSignal and buildScript). A tsconfig.json that is
// only there for the editor, next to a few TypeScript files in a JavaScript
// package, is no sign: the JavaScript runs as it is.
func buildStepReason(root string, pkg *Package, files []File) string {
	var hasTS bool
	var tsconfig bool
	for _, f := range files {
		rel := f.PackageRel
		if !strings.Contains(rel, "/") { // files directly in the package folder
			if reason := configReason(rel); reason != "" {
				return reason
			}
			if rel == "tsconfig.json" {
				tsconfig = true
			}
		}
		if (f.Class == Source || f.Class == TestCode) && isTypeScript(rel) {
			hasTS = true
		}
	}
	folder := filepath.Join(root, filepath.FromSlash(pkg.Path))
	if tsconfig && hasTS {
		if signal := tsEmitSignal(root, folder); signal != "" {
			return "tsconfig.json next to TypeScript sources, with " + signal
		}
		if script := buildScript(root, filepath.Join(folder, "package.json")); script != "" {
			return "tsconfig.json next to TypeScript sources, and " + script + " builds them"
		}
	}
	if hasBabelKey(root, filepath.Join(folder, "package.json")) {
		return "Babel configuration in package.json"
	}
	return ""
}

func configReason(base string) string {
	switch {
	case base == ".babelrc" || strings.HasPrefix(base, ".babelrc.") || strings.HasPrefix(base, "babel.config."):
		return "Babel config " + base
	case base == ".swcrc":
		return "SWC config " + base
	case base == ".parcelrc":
		return "Parcel config " + base
	}
	for _, bundler := range []string{"webpack", "rollup", "vite", "esbuild", "tsup"} {
		if strings.HasPrefix(base, bundler+".config.") {
			return "bundler config " + base
		}
	}
	return ""
}

func isTypeScript(rel string) bool {
	if strings.HasSuffix(rel, ".d.ts") || strings.HasSuffix(rel, ".d.mts") || strings.HasSuffix(rel, ".d.cts") {
		return false
	}
	switch path.Ext(rel) {
	case ".ts", ".tsx", ".mts", ".cts":
		return true
	}
	return false
}

func hasBabelKey(root, manifest string) bool {
	var m struct {
		Babel json.RawMessage `json:"babel"`
	}
	return regularJSON(root, manifest, &m) && len(m.Babel) > 0
}

// IsTypeScript says whether a file is TypeScript source: .ts, .tsx, .mts or
// .cts, but not a declaration file, which only describes JavaScript.
func IsTypeScript(rel string) bool { return isTypeScript(rel) }
