package checks

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// knipConfigNames are the files Knip reads its configuration from, in the
// package folder.
var knipConfigNames = map[string]bool{
	"knip.json": true, "knip.jsonc": true, ".knip.json": true, ".knip.jsonc": true,
	"knip.ts": true, "knip.js": true, "knip.config.ts": true, "knip.config.js": true,
}

// hasOwnKnipConfig says whether the package has a Knip configuration of its
// own: a config file in the package folder, or a "knip" key in package.json.
func (in *Input) hasOwnKnipConfig() bool {
	pkg := in.Context.Package
	for _, f := range pkg.Files {
		if knipConfigNames[f.PackageRel] {
			return true
		}
	}
	data, err := readCapped(filepath.Join(in.SnapshotDir, filepath.FromSlash(pkg.Path), "package.json"), maxProjectFileBytes)
	if err != nil {
		return false
	}
	var m struct {
		Knip json.RawMessage `json:"knip"`
	}
	return json.Unmarshal(data, &m) == nil && len(m.Knip) > 0 && string(m.Knip) != "null"
}

// knipDefaultEntries are the entry patterns Knip uses when its config names
// none, for the extensions it knows without plugins.
var knipDefaultEntries = []string{
	"{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
	"src/{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!",
}

// knipConfigWithEntries is a Knip config that keeps Knip's default entry
// patterns and adds the given files. The names come from the project, so a
// name that Knip would read as a pattern or an option is not added.
func knipConfigWithEntries(files []string) []byte {
	entry := append([]string{}, knipDefaultEntries...)
	for _, f := range files {
		if strings.ContainsAny(f, globCharacters) || strings.HasPrefix(f, "-") {
			continue
		}
		entry = append(entry, f)
	}
	data, _ := json.Marshal(map[string]any{"entry": entry})
	return data
}

// knipSecondRunConfig says whether Knip runs a second time after the first
// report, and with which config: when Mocha loads files that Knip could not
// see, and the project has no Knip config of its own, they become entry files
// of a generated config. A project's own config is never rewritten.
func (in *Input) knipSecondRunConfig(stdout []byte) ([]byte, bool) {
	if in.hasOwnKnipConfig() {
		return nil, false
	}
	_, loaded, err := in.correctKnip(stdout)
	if err != nil || len(loaded) == 0 {
		return nil, false
	}
	return knipConfigWithEntries(loaded), true
}
