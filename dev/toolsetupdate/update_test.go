package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSources answers from maps and records what was asked.
type fakeSources struct {
	digests   map[string]string // "repo:tag" -> digest
	refused   map[string]string // "repo:tag" -> reason
	checksums map[string]string // archive URL -> sha256
	fileSums  map[string]string // plain file URL -> sha256 of its content
	asked     []string
}

func (f *fakeSources) ImageDigest(_ context.Context, repo, tag string) (string, error) {
	key := repo + ":" + tag
	f.asked = append(f.asked, key)
	if why, ok := f.refused[key]; ok {
		return "", fmt.Errorf("%s: %s", key, why)
	}
	d, ok := f.digests[key]
	if !ok {
		return "", fmt.Errorf("%s: unknown to the fake", key)
	}
	return d, nil
}

func (f *fakeSources) Checksum(_ context.Context, archiveURL string) (string, error) {
	f.asked = append(f.asked, archiveURL)
	c, ok := f.checksums[archiveURL]
	if !ok {
		return "", fmt.Errorf("%s: unknown to the fake", archiveURL)
	}
	return c, nil
}

func (f *fakeSources) FileChecksum(_ context.Context, fileURL string) (string, error) {
	f.asked = append(f.asked, fileURL)
	c, ok := f.fileSums[fileURL]
	if !ok {
		return "", fmt.Errorf("%s: unknown to the fake", fileURL)
	}
	return c, nil
}

const (
	oldDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	newDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	oldSum    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	newSum    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// A table that spells its entries the three ways the real one does: a plain
// Image variable, an Image inside a PinnedTool, and elided Image literals in a
// map; plus a download with a checksum.
const tableSource = `package toolset

// Tool is pinned by the digest of its index.
var Tool = PinnedTool{
	Name:    "tool",
	Version: "1.0.0",
	Image:   Image{Repo: "vendor/tool", Tag: "v1.0.0", Digest: "` + oldDigest + `"},
}

var Base = Image{
	Repo:   "ghcr.io/vendor/base",
	Tag:    "3.1",
	Digest: "` + oldDigest + `",
}

var images = map[nodeKey]Image{
	{24, "debian"}: {Repo: "node", Tag: "24.1.0", Digest: "` + oldDigest + `"},
	{24, "alpine"}: {Repo: "node", Tag: "24.1.0-alpine", Digest: "` + oldDigest + `"},
}

var Bin = Binary{
	Version: "3.1.0",
	Downloads: map[string]Download{
		"amd64": {
			URL:    "https://example.test/bin-v3.1.0-linux-amd64.tar.gz",
			SHA256: "` + oldSum + `",
		},
	},
}
`

func writeTable(t *testing.T, name, content string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func allNew() *fakeSources {
	return &fakeSources{
		digests: map[string]string{
			"vendor/tool:v1.0.0":      newDigest,
			"ghcr.io/vendor/base:3.1": newDigest,
			"node:24.1.0":             newDigest,
			"node:24.1.0-alpine":      newDigest,
		},
		checksums: map[string]string{"https://example.test/bin-v3.1.0-linux-amd64.tar.gz": newSum},
	}
}

func TestUpdateRewritesEveryPinnedDigestAndChecksumInTheTable(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	changes, err := Update(context.Background(), dir, allNew(), true)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "tool.go"))
	want := strings.NewReplacer(oldDigest, newDigest, oldSum, newSum).Replace(tableSource)
	if string(got) != want {
		t.Fatalf("the table is not the old one with new digests and checksums:\n%s", got)
	}
	if len(changes) != 5 {
		t.Fatalf("changes = %d, want 5 (4 images, 1 checksum): %v", len(changes), changes)
	}
}

func TestUpdateKeepsTheTagsAndAsksForThePinnedOnes(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	src := allNew()
	if _, err := Update(context.Background(), dir, src, true); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"vendor/tool:v1.0.0", "ghcr.io/vendor/base:3.1", "node:24.1.0", "node:24.1.0-alpine"} {
		found := false
		for _, a := range src.asked {
			found = found || a == want
		}
		if !found {
			t.Errorf("%s was never resolved; asked %v", want, src.asked)
		}
	}
}

func TestUpdateWithoutWriteOnlyReportsTheChanges(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	changes, err := Update(context.Background(), dir, allNew(), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 5 {
		t.Fatalf("changes = %d, want 5", len(changes))
	}
	got, _ := os.ReadFile(filepath.Join(dir, "tool.go"))
	if string(got) != tableSource {
		t.Fatal("a dry run changed the table")
	}
}

func TestUpdateOfAnUpToDateTableChangesNothing(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	src := &fakeSources{
		digests: map[string]string{
			"vendor/tool:v1.0.0": oldDigest, "ghcr.io/vendor/base:3.1": oldDigest,
			"node:24.1.0": oldDigest, "node:24.1.0-alpine": oldDigest,
		},
		checksums: map[string]string{"https://example.test/bin-v3.1.0-linux-amd64.tar.gz": oldSum},
	}
	changes, err := Update(context.Background(), dir, src, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 0 {
		t.Fatalf("changes = %v, want none", changes)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "tool.go"))
	if string(got) != tableSource {
		t.Fatal("the table changed")
	}
}

func TestOneRefusedImageStopsTheWholeUpdateAndLeavesTheTableAlone(t *testing.T) {
	dir := writeTable(t, "tool.go", tableSource)
	src := allNew()
	src.refused = map[string]string{"ghcr.io/vendor/base:3.1": "has no linux/arm64 entry in its index"}
	_, err := Update(context.Background(), dir, src, true)
	if err == nil {
		t.Fatal("a refused image did not fail the update")
	}
	if !strings.Contains(err.Error(), "ghcr.io/vendor/base:3.1") || !strings.Contains(err.Error(), "arm64") {
		t.Fatalf("the error should name the image and the reason: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "tool.go"))
	if string(got) != tableSource {
		t.Fatal("the table was partly rewritten although an image was refused")
	}
}

func TestTestFilesAreNotPartOfTheTable(t *testing.T) {
	dir := writeTable(t, "tool_test.go", tableSource)
	changes, err := Update(context.Background(), dir, &fakeSources{}, true)
	if err != nil || len(changes) != 0 {
		t.Fatalf("changes = %v, err = %v; a _test.go file must be ignored", changes, err)
	}
}
