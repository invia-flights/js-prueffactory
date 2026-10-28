package engine

import (
	"sort"
	"sync"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

var toolsMu sync.Mutex

// recordTools adds the tools a Check ran to the Context it ran in. A tool is
// recorded once per name and digest, and a Context lists its tools in name
// order, so the Report does not depend on scheduling.
func recordTools(c *discovery.Context, refs []resultset.ToolRef) {
	if len(refs) == 0 {
		return
	}
	toolsMu.Lock()
	defer toolsMu.Unlock()
	for _, ref := range refs {
		known := false
		for _, have := range c.Tools {
			known = known || (have.Name == ref.Name && have.Version == ref.Version && sameDigest(have.Digest, ref.Digest))
		}
		if !known {
			c.Tools = append(c.Tools, ref)
		}
	}
	sort.SliceStable(c.Tools, func(i, j int) bool { return c.Tools[i].Name < c.Tools[j].Name })
}

func sameDigest(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
