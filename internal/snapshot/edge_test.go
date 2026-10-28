package snapshot_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

func limitedPaths(s *snapshot.Snapshot) map[string]string {
	out := map[string]string{}
	for _, l := range s.Limitations {
		out[l.Path] = l.Code
	}
	return out
}

func TestUnreadableFilesAndSpecialFilesAreLeftOutAndListedWithTheirPaths(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read every file")
	}
	root := resolved(t, t.TempDir())
	write(t, root, "ok.js", "ok", 0o644)
	write(t, root, "locked.js", "secret", 0o644)
	write(t, root, "src/locked-too.js", "secret", 0o644)
	for _, rel := range []string{"locked.js", "src/locked-too.js"} {
		if err := os.Chmod(filepath.Join(root, rel), 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := take(t, root, snapshot.Options{})

	for _, rel := range []string{"locked.js", "src/locked-too.js", "pipe"} {
		if exists(filepath.Join(s.Dir, rel)) {
			t.Errorf("%s must be left out of the copy", rel)
		}
	}
	if !exists(filepath.Join(s.Dir, "ok.js")) {
		t.Error("ok.js is missing")
	}
	got := limitedPaths(s)
	want := map[string]string{"locked.js": "unreadable_path", "src/locked-too.js": "unreadable_path", "pipe": "special_file"}
	if len(got) != len(want) {
		t.Fatalf("limitations = %v, want %v", got, want)
	}
	for p, code := range want {
		if got[p] != code {
			t.Errorf("limitation of %s = %q, want %q", p, got[p], code)
		}
	}
	if s.FileCount != 1 {
		t.Errorf("file count = %d, want 1: left-out files do not count", s.FileCount)
	}
	// Left-out files do not make the final re-hash differ.
	if changed, err := s.Compare(root, snapshot.Options{}); err != nil || len(changed) != 0 {
		t.Errorf("Compare = %v, %v", changed, err)
	}
}

func TestAnUnreadableFolderIsLeftOutWithItsPath(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read every folder")
	}
	root := resolved(t, t.TempDir())
	write(t, root, "ok.js", "ok", 0o644)
	write(t, root, "private/a.js", "a", 0o644)
	if err := os.Chmod(filepath.Join(root, "private"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "private"), 0o755) })

	s := take(t, root, snapshot.Options{})

	if got := limitedPaths(s); got["private"] != "unreadable_path" {
		t.Errorf("limitations = %v, want one for private", got)
	}
}

// The tool resolves symlinks before it decides what lies inside the root: an
// absolute link written through another name of the root is still inside.
func TestAbsoluteLinkThroughAnAliasOfTheRootIsKeptAsARelativeLink(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "README.md", "readme", 0o644)
	write(t, root, "docs/.keep", "", 0o644)
	alias := filepath.Join(resolved(t, t.TempDir()), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(alias, "README.md"), filepath.Join(root, "docs", "readme-link")); err != nil {
		t.Fatal(err)
	}

	s := take(t, root, snapshot.Options{})

	got, err := os.Readlink(filepath.Join(s.Dir, "docs", "readme-link"))
	if err != nil || got != "../README.md" {
		t.Fatalf("link = %q, %v; want ../README.md", got, err)
	}
	if len(s.Limitations) != 0 {
		t.Errorf("limitations = %v", s.Limitations)
	}
}

func TestLinksThatLeaveTheRootByAnyRouteAreLeftOut(t *testing.T) {
	outside := resolved(t, t.TempDir())
	write(t, outside, "secret.txt", "do not read", 0o644)
	write(t, outside, "dir/inner.txt", "x", 0o644)
	root := resolved(t, t.TempDir())
	write(t, root, "a.txt", "a", 0o644)
	links := map[string]string{
		"to-dir":      outside,                               // a folder outside
		"dangling":    filepath.Join(outside, "missing.txt"), // does not exist, still outside
		"via-inside":  "hop",                                 // inside link that itself points outside
		"hop":         filepath.Join(outside, "secret.txt"),
		"loop-a":      "loop-b", // cannot be resolved
		"loop-b":      "loop-a",
		"to-root-dir": "..", // the parent of the root
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}

	s := take(t, root, snapshot.Options{})

	var left []string
	for p := range limitedPaths(s) {
		left = append(left, p)
	}
	slices.Sort(left)
	want := []string{"dangling", "hop", "loop-a", "loop-b", "to-dir", "to-root-dir", "via-inside"}
	if !slices.Equal(left, want) {
		t.Errorf("left out = %v, want %v", left, want)
	}
	entries, _ := os.ReadDir(s.Dir)
	var kept []string
	for _, e := range entries {
		kept = append(kept, e.Name())
	}
	if !slices.Equal(kept, []string{"a.txt"}) {
		t.Errorf("copy holds %v, want only a.txt", kept)
	}
	for _, l := range s.Limitations {
		if strings.Contains(l.Message, "secret") && strings.Contains(l.Message, "do not read") {
			t.Errorf("a limitation leaks file content: %q", l.Message)
		}
	}
}

func TestTestdataProjectSymlinksKeepsItsInsideLinksAndLeavesTheOutsideLinkOut(t *testing.T) {
	root := resolved(t, filepath.Join("..", "..", "testdata", "projects", "symlinks"))

	s := take(t, root, snapshot.Options{})

	for rel, want := range map[string]string{"main-link.js": "src/index.js", "docs/notes-link.md": "notes.md"} {
		if got, err := os.Readlink(filepath.Join(s.Dir, filepath.FromSlash(rel))); err != nil || got != want {
			t.Errorf("%s -> %q, %v; want %q", rel, got, err, want)
		}
	}
	if exists(filepath.Join(s.Dir, "outside-link.md")) {
		t.Error("outside-link.md points outside the project and must be left out")
	}
	got := limitedPaths(s)
	if len(got) != 1 || got["outside-link.md"] != "symlink_outside_root" {
		t.Errorf("limitations = %v", s.Limitations)
	}
	if s.FileCount != 5 { // package.json, src/index.js, docs/notes.md and the two kept links
		t.Errorf("file count = %d, want 5", s.FileCount)
	}
}

// A relative link is copied as written. One that only reaches the root again
// through an alias would point somewhere else inside the copy, so it is left out.
func TestRelativeLinkThatReachesTheRootThroughAnAliasIsLeftOut(t *testing.T) {
	parent := resolved(t, t.TempDir())
	root := filepath.Join(parent, "project")
	write(t, root, "README.md", "readme", 0o644)
	if err := os.Symlink(root, filepath.Join(parent, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../alias/README.md", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}

	s := take(t, root, snapshot.Options{})

	if exists(filepath.Join(s.Dir, "link")) || limitedPaths(s)["link"] == "" {
		t.Errorf("link must be left out and listed: %v", s.Limitations)
	}
}
