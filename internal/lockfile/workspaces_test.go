package lockfile_test

import (
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

func TestWorkspaceMembersFollowTheWorkspacesPatterns(t *testing.T) {
	cases := []struct {
		name      string
		manifest  string
		member    string
		wantMatch bool
	}{
		{"star matches one level", `{"workspaces":["packages/*"]}`, "packages/a", true},
		{"star does not match two levels", `{"workspaces":["packages/*"]}`, "packages/a/b", false},
		{"double star matches any depth", `{"workspaces":["apps/**"]}`, "apps/x/y", true},
		{"exact path", `{"workspaces":["tools/cli"]}`, "tools/cli", true},
		{"other folder", `{"workspaces":["packages/*"]}`, "tools/cli", false},
		{"leading dot slash", `{"workspaces":["./packages/*"]}`, "packages/a", true},
		{"negation wins", `{"workspaces":["packages/*","!packages/legacy"]}`, "packages/legacy", false},
		{"object form", `{"workspaces":{"packages":["packages/*"]}}`, "packages/a", true},
		{"star inside a name", `{"workspaces":["packages/lib-*"]}`, "packages/lib-core", true},
		{"no workspaces", `{}`, "packages/a", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := lockfile.ParseManifest([]byte(c.manifest))
			if err != nil {
				t.Fatal(err)
			}
			if got := m.IsWorkspaceMember(c.member); got != c.wantMatch {
				t.Errorf("IsWorkspaceMember(%q) = %v, want %v", c.member, got, c.wantMatch)
			}
		})
	}
}
