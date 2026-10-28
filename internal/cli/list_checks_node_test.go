package cli_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// Seam A without Docker: list-checks shows the Node version of every package
// Context, where it came from, the other declared versions and the variant.

type listedContext struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Path string `json:"path"`
	Node *struct {
		Version    string   `json:"version"`
		Source     string   `json:"source"`
		Variant    string   `json:"variant"`
		Image      string   `json:"image"`
		NotChecked []string `json:"not_checked_versions"`
	} `json:"node"`
	NodeUnsupported string `json:"node_unsupported"`
}

func listedContexts(t *testing.T, dir string, args ...string) []listedContext {
	t.Helper()
	r := call(t, noDockerEnv(t), append([]string{"list-checks", dir, "--format", "json"}, args...)...)
	if r.code != 0 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	var out struct {
		Contexts []listedContext `json:"contexts"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatal(err)
	}
	return out.Contexts
}

func TestListChecksShowsTheNodeVersionSourceVariantAndOtherDeclaredVersions(t *testing.T) {
	dir := projectWith(t, map[string]string{
		"package.json":              `{"name":"demo","engines":{"node":">=24"}}`,
		"Dockerfile":                "FROM node:22-alpine\n",
		".nvmrc":                    "24\n",
		"packages/lib/package.json": `{"name":"lib"}`,
	})
	cs := listedContexts(t, dir)

	if len(cs) != 3 || cs[0].Kind != "project" || cs[0].Node != nil {
		t.Fatalf("contexts = %+v, want the project Context first, then one per package", cs)
	}
	root, lib := cs[1], cs[2]
	if root.Path != "." || root.Node == nil || root.Node.Version != "22" || root.Node.Source != "dockerfile" || root.Node.Variant != "alpine" {
		t.Errorf("root = %+v", root)
	}
	if want := []string{"24 (.nvmrc)", ">=24 (engines.node)"}; strings.Join(root.Node.NotChecked, "|") != strings.Join(want, "|") {
		t.Errorf("not checked = %q, want %q", root.Node.NotChecked, want)
	}
	if !strings.Contains(root.Node.Image, "@sha256:") {
		t.Errorf("image = %q, want a digest", root.Node.Image)
	}
	if lib.Node == nil || lib.Node.Version != "24" || lib.Node.Source != "default" || lib.Node.Variant != "debian" || lib.Node.NotChecked == nil {
		t.Errorf("lib = %+v, want the default 24 on debian and an empty (not null) list", lib)
	}

	r := call(t, noDockerEnv(t), "list-checks", dir)
	for _, want := range []string{"Node", "22 alpine", "dockerfile", "24 (.nvmrc)"} {
		if !strings.Contains(r.stdout, want) {
			t.Errorf("markdown misses %q:\n%s", want, r.stdout)
		}
	}
}

func TestListChecksShowsAnUnsupportedNodeVersionAndWhatItBlocks(t *testing.T) {
	dir := projectWith(t, map[string]string{
		"package.json":      `{"name":"demo","scripts":{"test":"mocha"},"devDependencies":{"mocha":"^10"}}`,
		"package-lock.json": `{}`,
		"index.js":          "module.exports = 1;\n",
		".nvmrc":            "18\n",
	})
	cs := listedContexts(t, dir)
	pkg := cs[1]
	if pkg.Node != nil || !strings.Contains(pkg.NodeUnsupported, "Node 18") || !strings.Contains(pkg.NodeUnsupported, "22, 24 and 26") {
		t.Fatalf("package Context = %+v", pkg)
	}
	l := listChecksJSON(t, dir, "--format", "json")
	for _, id := range []string{"package.install", "tests.existing", "syntax.parse"} {
		a := l.Checks[rowOf(t, l, id)].Applicability
		if len(a) != 1 || !strings.HasPrefix(a[0].Reason, "unsupported: ") || !strings.Contains(a[0].Reason, "Node 18") {
			t.Errorf("%s applicability = %+v", id, a)
		}
	}
	r := call(t, noDockerEnv(t), "list-checks", dir)
	if !strings.Contains(r.stdout, "unsupported") || !strings.Contains(r.stdout, "Node 18") {
		t.Errorf("markdown does not show the unsupported version:\n%s", r.stdout)
	}
}
