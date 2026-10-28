package discovery_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// nodeOf discovers a project and returns the package Context at path.
func nodeOf(t *testing.T, files map[string]string, path string) (*discovery.Context, *discovery.Package) {
	t.Helper()
	proj := project(t, files)
	for i := range proj.Contexts {
		if c := &proj.Contexts[i]; c.Package != nil && c.Package.Path == path {
			return c, c.Package
		}
	}
	t.Fatalf("no package %q", path)
	return nil, nil
}

func TestNodeVersionComesFromTheFirstSourceThatAnswers(t *testing.T) {
	cases := []struct {
		name    string
		files   map[string]string
		version string
		source  string
		variant string
	}{
		{"default", map[string]string{"package.json": `{}`}, "24", "default", "debian"},
		{"dockerfile", map[string]string{"package.json": `{}`, "Dockerfile": "FROM node:22\n"}, "22", "dockerfile", "debian"},
		{"dockerfile beats nvmrc", map[string]string{"package.json": `{}`, "Dockerfile": "FROM node:22\n", ".nvmrc": "24\n"}, "22", "dockerfile", "debian"},
		{"nvmrc", map[string]string{"package.json": `{}`, ".nvmrc": "v22.3.0\n"}, "22", "nvmrc", "debian"},
		{"nvmrc beats node-version", map[string]string{"package.json": `{}`, ".nvmrc": "22\n", ".node-version": "24\n"}, "22", "nvmrc", "debian"},
		{"node-version", map[string]string{"package.json": `{}`, ".node-version": "24.1.0"}, "24", "node_version_file", "debian"},
		{"node-version beats engines", map[string]string{"package.json": `{"engines":{"node":">=22"}}`, ".node-version": "22"}, "22", "node_version_file", "debian"},
		{"engines picks the highest supported major", map[string]string{"package.json": `{"engines":{"node":">=20"}}`}, "26", "engines", "debian"},
		{"engines range with an upper bound", map[string]string{"package.json": `{"engines":{"node":">=20 <24"}}`}, "22", "engines", "debian"},
		{"engines caret", map[string]string{"package.json": `{"engines":{"node":"^22.1.0"}}`}, "22", "engines", "debian"},
		{"engines with alternatives", map[string]string{"package.json": `{"engines":{"node":"18 || 24"}}`}, "24", "engines", "debian"},
		{"engines x-range", map[string]string{"package.json": `{"engines":{"node":"22.x"}}`}, "22", "engines", "debian"},
		{"engines tilde", map[string]string{"package.json": `{"engines":{"node":"~24.2"}}`}, "24", "engines", "debian"},
		{"engines hyphen range", map[string]string{"package.json": `{"engines":{"node":"20.0.0 - 23.9.9"}}`}, "22", "engines", "debian"},
		{"engines less or equal", map[string]string{"package.json": `{"engines":{"node":"<=22"}}`}, "22", "engines", "debian"},
		{"engines less than", map[string]string{"package.json": `{"engines":{"node":"<24"}}`}, "22", "engines", "debian"},
		{"engines operator then space", map[string]string{"package.json": `{"engines":{"node":">= 22.1 < 23"}}`}, "22", "engines", "debian"},
		{"engines exact version", map[string]string{"package.json": `{"engines":{"node":"24.3.0"}}`}, "24", "engines", "debian"},
		{"engines star", map[string]string{"package.json": `{"engines":{"node":"*"}}`}, "26", "engines", "debian"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := nodeOf(t, tc.files, ".")
			n := c.Node
			if n == nil {
				t.Fatal("no Node runtime")
			}
			if n.Version != tc.version || n.Source != tc.source || n.Variant != tc.variant {
				t.Errorf("node = %s from %s on %s, want %s from %s on %s", n.Version, n.Source, n.Variant, tc.version, tc.source, tc.variant)
			}
			if !strings.HasPrefix(n.ImageDigest, "sha256:") || n.Image != "node@"+n.ImageDigest {
				t.Errorf("image %q is not pinned by digest %q", n.Image, n.ImageDigest)
			}
		})
	}
}

func TestNodeVersionSourcesThatDoNotAnswerFallThrough(t *testing.T) {
	cases := map[string]map[string]string{
		"alias in nvmrc":          {"package.json": `{}`, ".nvmrc": "lts/*\n"},
		"garbage in nvmrc":        {"package.json": `{}`, ".nvmrc": "22; touch /tmp/x\n"},
		"empty nvmrc":             {"package.json": `{}`, ".nvmrc": "\n\n"},
		"comment-only nvmrc":      {"package.json": `{}`, ".nvmrc": "# nothing\n"},
		"engines not a string":    {"package.json": `{"engines":{"node":22}}`},
		"engines not parseable":   {"package.json": `{"engines":{"node":"banana"}}`},
		"dockerfile without node": {"package.json": `{}`, "Dockerfile": "FROM nginx:1.27\n"},
		"dockerfile arg tag":      {"package.json": `{}`, "Dockerfile": "ARG V=22\nFROM node:${V}\n"},
		"dockerfile arg tag bare": {"package.json": `{}`, "Dockerfile": "ARG V=22\nFROM node:$V-alpine\n"},
		"dockerfile lts tag":      {"package.json": `{}`, "Dockerfile": "FROM node:lts\n"},
		"dockerfile in test data": {"package.json": `{}`, "test/fixtures/Dockerfile": "FROM node:22\n"},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			c, _ := nodeOf(t, files, ".")
			if c.Node == nil || c.Node.Version != "24" || c.Node.Source != "default" || c.Node.Variant != "debian" {
				t.Errorf("node = %+v, want the default 24 on debian", c.Node)
			}
		})
	}
}

func TestNodeVersionFromTheLastNodeLineOfADockerfile(t *testing.T) {
	cases := map[string]struct {
		dockerfile string
		version    string
		variant    string
	}{
		"last of several stages":    {"FROM node:20 AS build\nRUN x\nFROM node:22-alpine\n", "22", "alpine"},
		"later non-node stage":      {"FROM node:22 AS build\nFROM nginx:1.27\nCOPY --from=build /a /b\n", "22", "debian"},
		"arg line is ignored":       {"ARG V=18\nFROM node:22-alpine AS a\nFROM node:${V}-alpine\n", "22", "alpine"},
		"platform flag and as":      {"FROM --platform=linux/amd64 node:22.3.1-alpine3.20 AS app\n", "22", "alpine"},
		"lower case":                {"from node:22-alpine\n", "22", "alpine"},
		"slim stays on full debian": {"FROM node:22-slim\n", "22", "debian"},
		"bookworm":                  {"FROM node:22-bookworm\n", "22", "debian"},
		"digest after the tag":      {"FROM node:22-alpine@sha256:" + strings.Repeat("a", 64) + "\n", "22", "alpine"},
		"docker.io path":            {"FROM docker.io/library/node:22-alpine\n", "22", "alpine"},
		"continued line":            {"FROM \\\n  node:22-alpine\n", "22", "alpine"},
		"comment is not a stage":    {"# FROM node:18\nFROM node:22\n", "22", "debian"},
		"windows line endings":      {"FROM node:22-alpine\r\nRUN x\r\n", "22", "alpine"},
		"a node:<major> in RUN":     {"FROM node:22\nRUN echo FROM node:18\n", "22", "debian"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c, _ := nodeOf(t, map[string]string{"package.json": `{}`, "Dockerfile": tc.dockerfile}, ".")
			if c.Node == nil || c.Node.Version != tc.version || c.Node.Source != "dockerfile" || c.Node.Variant != tc.variant {
				t.Errorf("node = %+v, want %s from dockerfile on %s", c.Node, tc.version, tc.variant)
			}
		})
	}
}

func TestDockerfileNamesThatCount(t *testing.T) {
	for _, name := range []string{"Dockerfile", "Dockerfile.prod", "app.Dockerfile", "app.dockerfile", "docker/Dockerfile", "ci/Dockerfile.test"} {
		c, _ := nodeOf(t, map[string]string{"package.json": `{}`, name: "FROM node:22-alpine\n"}, ".")
		if c.Node == nil || c.Node.Source != "dockerfile" {
			t.Errorf("%s: node = %+v, want it to count", name, c.Node)
		}
	}
	for _, name := range []string{"Dockerfile.md", "dockerfile-notes.txt", "Dockerfilefoo", "dist/Dockerfile"} {
		c, _ := nodeOf(t, map[string]string{"package.json": `{}`, name: "FROM node:22-alpine\n"}, ".")
		if c.Node == nil || c.Node.Source != "default" {
			t.Errorf("%s: node = %+v, want it ignored", name, c.Node)
		}
	}
}

func TestDisagreeingDockerfilesTakeTheHighestSupportedMajor(t *testing.T) {
	c, pkg := nodeOf(t, map[string]string{
		"package.json":      `{}`,
		"Dockerfile":        "FROM node:22-alpine\n",
		"docker/Dockerfile": "FROM node:24\n",
		"ci/Dockerfile":     "FROM node:18\n",
	}, ".")
	if c.Node == nil || c.Node.Version != "24" || c.Node.Variant != "debian" || c.Node.Source != "dockerfile" {
		t.Fatalf("node = %+v, want 24 from the Dockerfile that says 24, on debian", c.Node)
	}
	want := []string{"18 (ci/Dockerfile)", "22 (Dockerfile)"}
	if !slices.Equal(c.Node.NotChecked, want) {
		t.Errorf("not checked = %q, want %q", c.Node.NotChecked, want)
	}
	if pkg.NodeChoice.Unsupported != nil {
		t.Errorf("unexpected unsupported: %+v", pkg.NodeChoice.Unsupported)
	}
}

func TestOtherDeclaredVersionsAreRecordedAsNotChecked(t *testing.T) {
	c, _ := nodeOf(t, map[string]string{
		"package.json":  `{"engines":{"node":">=24"}}`,
		"Dockerfile":    "FROM node:22\n",
		".nvmrc":        "24\n",
		".node-version": "v22.1.0\n",
	}, ".")
	if c.Node.Version != "22" || c.Node.Source != "dockerfile" {
		t.Fatalf("node = %+v", c.Node)
	}
	want := []string{"24 (.nvmrc)", ">=24 (engines.node)"}
	if !slices.Equal(c.Node.NotChecked, want) {
		t.Errorf("not checked = %q, want %q", c.Node.NotChecked, want)
	}
}

func TestAnEnginesRangeThatTheChosenVersionSatisfiesIsNotListed(t *testing.T) {
	c, _ := nodeOf(t, map[string]string{"package.json": `{"engines":{"node":">=22"}}`, ".nvmrc": "22"}, ".")
	if len(c.Node.NotChecked) != 0 {
		t.Errorf("not checked = %q, want none", c.Node.NotChecked)
	}
}

func TestADockerfileInANestedPackageBelongsToThatPackage(t *testing.T) {
	files := map[string]string{
		"package.json":            `{}`,
		"Dockerfile":              "FROM node:22\n",
		"packages/a/package.json": `{}`,
		"packages/a/Dockerfile":   "FROM node:24-alpine\n",
		"packages/b/package.json": `{}`,
	}
	root, _ := nodeOf(t, files, ".")
	a, _ := nodeOf(t, files, "packages/a")
	b, _ := nodeOf(t, files, "packages/b")
	if root.Node.Version != "22" || len(root.Node.NotChecked) != 0 {
		t.Errorf("root = %+v, want 22 and nothing not checked", root.Node)
	}
	if a.Node.Version != "24" || a.Node.Variant != "alpine" {
		t.Errorf("a = %+v, want 24 alpine", a.Node)
	}
	if b.Node.Version != "24" || b.Node.Source != "default" {
		t.Errorf("b = %+v, want the default: the root Dockerfile does not reach into packages", b.Node)
	}
}

func TestAnUnsupportedVersionIsReportedWithTheReasonAndRunsNothing(t *testing.T) {
	cases := map[string]map[string]string{
		"dockerfile":    {"package.json": `{}`, "Dockerfile": "FROM node:18-alpine\n"},
		"nvmrc":         {"package.json": `{}`, ".nvmrc": "20.1.0\n"},
		"engines":       {"package.json": `{"engines":{"node":"^18"}}`},
		"engines below": {"package.json": `{"engines":{"node":"<22"}}`},
		"engines exact": {"package.json": `{"engines":{"node":"20.11.0"}}`},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			c, pkg := nodeOf(t, files, ".")
			if c.Node != nil {
				t.Errorf("Node = %+v, want none for an unsupported version", c.Node)
			}
			u := pkg.NodeChoice.Unsupported
			if u == nil || u.Code != "node_version_unsupported" || !strings.Contains(u.Reason, "22, 24 and 26") {
				t.Fatalf("unsupported = %+v", u)
			}
			if pkg.InstallUnsupported == nil || pkg.InstallUnsupported.Code != "node_version_unsupported" {
				t.Errorf("install must be unsupported with the same reason: %+v", pkg.InstallUnsupported)
			}
		})
	}
}

func TestAnUnsupportedDockerfileVersionLosesToASupportedOne(t *testing.T) {
	c, pkg := nodeOf(t, map[string]string{
		"package.json": `{}`, "Dockerfile": "FROM node:18\n", "Dockerfile.new": "FROM node:22-alpine\n",
	}, ".")
	if c.Node == nil || c.Node.Version != "22" || c.Node.Variant != "alpine" || pkg.NodeChoice.Unsupported != nil {
		t.Fatalf("node = %+v, choice = %+v", c.Node, pkg.NodeChoice)
	}
	if !slices.Equal(c.Node.NotChecked, []string{"18 (Dockerfile)"}) {
		t.Errorf("not checked = %q", c.Node.NotChecked)
	}
}

func TestTheUnsupportedReasonKeepsAnExistingInstallReason(t *testing.T) {
	_, pkg := nodeOf(t, map[string]string{"package.json": `{}`, "pnpm-lock.yaml": "", ".nvmrc": "18"}, ".")
	if pkg.InstallUnsupported == nil || pkg.InstallUnsupported.Code == "node_version_unsupported" {
		t.Errorf("install = %+v, want the package-manager reason kept", pkg.InstallUnsupported)
	}
	if pkg.NodeChoice.Unsupported == nil {
		t.Error("the Node version is still unsupported")
	}
}

// Version strings come from the project and are untrusted. Whatever they say,
// the image is one of the pinned table entries.
func TestHostileVersionStringsNeverReachTheImage(t *testing.T) {
	for _, h := range []string{"22\" --privileged", "22$(id)", "22 && rm -rf /", "../../etc", "22\n24"} {
		c, _ := nodeOf(t, map[string]string{"package.json": `{}`, ".nvmrc": h}, ".")
		if c.Node != nil && (c.Node.Image != "node@"+c.Node.ImageDigest || strings.ContainsAny(c.Node.Image, " $\"&")) {
			t.Errorf("%q: image %q", h, c.Node.Image)
		}
	}
	c, _ := nodeOf(t, map[string]string{"package.json": `{}`, "Dockerfile": "FROM node:22$(id)\n"}, ".")
	if c.Node == nil || c.Node.Source != "default" {
		t.Errorf("node = %+v, a tag with shell syntax must not count", c.Node)
	}
}

func TestHostileDeclaredVersionsStayOutOfTheNotCheckedList(t *testing.T) {
	c, _ := nodeOf(t, map[string]string{
		"package.json": `{"engines":{"node":"` + strings.Repeat("9", 300) + `"}}`, ".nvmrc": "22",
	}, ".")
	for _, s := range c.Node.NotChecked {
		if len(s) > 120 {
			t.Errorf("not-checked entry is %d bytes long", len(s))
		}
	}
}

func TestADockerfileThatIsASymlinkIsNeverRead(t *testing.T) {
	// The Snapshot has no symlinks, but discovery also runs on the Original.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "target"), []byte("FROM node:22\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "target"), filepath.Join(root, "Dockerfile")); err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range proj.Contexts {
		if c.Package != nil && c.Node.Source != "default" {
			t.Errorf("node = %+v, want the symlink ignored", c.Node)
		}
	}
}
