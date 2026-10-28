package checks

import (
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// This file builds the compose sets repository.compose validates, from the
// compose files of the project root that discovery reads.

// composeSet is the files one `docker compose` run reads together.
type composeSet struct {
	// Files are project-relative, the base file first.
	Files []string
}

// composeBases are the file names compose itself looks for, without extension.
var composeBases = []string{"compose", "docker-compose"}

// composeSets returns the default set of every base file (the base file with
// its matching override file, when present) and a set of its own for every
// other compose file, sorted by the first file.
func composeSets(p *discovery.Project) []composeSet {
	present := map[string]bool{}
	var names []string
	for _, f := range p.Files {
		if !strings.Contains(f.Path, "/") && discovery.IsComposeFile(f.Path) {
			present[f.Path] = true
			names = append(names, f.Path)
		}
	}
	sort.Strings(names)

	used := map[string]bool{}
	var sets []composeSet
	for _, name := range names {
		prefix, ext, ok := composeBase(name)
		if !ok {
			continue
		}
		set := composeSet{Files: []string{name}}
		used[name] = true
		// The override with the base file's own extension wins over the other one.
		other := ".yaml"
		if ext == ".yaml" {
			other = ".yml"
		}
		for _, e := range []string{ext, other} {
			if override := prefix + ".override" + e; present[override] && !used[override] {
				set.Files = append(set.Files, override)
				used[override] = true
				break
			}
		}
		sets = append(sets, set)
	}
	for _, name := range names {
		if !used[name] {
			sets = append(sets, composeSet{Files: []string{name}})
		}
	}
	sort.SliceStable(sets, func(i, j int) bool { return sets[i].Files[0] < sets[j].Files[0] })
	return sets
}

// composeBase splits a base file name such as "compose.yml" into its prefix
// and extension.
func composeBase(name string) (prefix, ext string, ok bool) {
	for _, base := range composeBases {
		for _, e := range []string{".yaml", ".yml"} {
			if name == base+e {
				return base, e, true
			}
		}
	}
	return "", "", false
}
