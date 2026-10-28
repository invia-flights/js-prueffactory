package cli

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// UseCatalog makes the command line resolve Selections against entries until the
// test ends. The real Catalog marks Checks for --fast before they are
// implemented, so the --fast rules need a Catalog in which they are.
func UseCatalog(t *testing.T, entries []checks.Entry) {
	t.Helper()
	previous := catalogEntries
	catalogEntries = func() []checks.Entry { return entries }
	t.Cleanup(func() { catalogEntries = previous })
}
