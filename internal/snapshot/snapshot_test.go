package snapshot_test

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/snapshot"
)

// write creates a file below root, making parent folders as needed.
func write(t *testing.T, root, rel, content string, mode os.FileMode) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

func resolved(t *testing.T, dir string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func take(t *testing.T, root string, opts snapshot.Options) *snapshot.Snapshot {
	t.Helper()
	dest := filepath.Join(t.TempDir(), "copy")
	s, err := snapshot.Take(root, dest, opts)
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	return s
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func TestSnapshotKeepsEverythingExceptNodeModulesAndGit(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "package.json", "{}", 0o644)
	write(t, root, ".env", "SECRET=1", 0o644)
	write(t, root, ".gitignore", ".env\nbuild/\n", 0o644)
	write(t, root, "build/out.js", "x", 0o644) // ignored by .gitignore, still part of the Snapshot
	write(t, root, "node_modules/dep/index.js", "x", 0o644)
	write(t, root, "sub/node_modules/dep/index.js", "x", 0o644)
	write(t, root, "sub/a.js", "x", 0o644)
	write(t, root, ".git/HEAD", "ref: refs/heads/main", 0o644)

	s := take(t, root, snapshot.Options{})

	for _, rel := range []string{"package.json", ".env", ".gitignore", "build/out.js", "sub/a.js"} {
		if !exists(filepath.Join(s.Dir, rel)) {
			t.Errorf("%s missing from the Snapshot", rel)
		}
	}
	for _, rel := range []string{"node_modules", "sub/node_modules", ".git"} {
		if exists(filepath.Join(s.Dir, rel)) {
			t.Errorf("%s must not be in the Snapshot", rel)
		}
	}
	if s.FileCount != 5 {
		t.Errorf("FileCount = %d, want 5", s.FileCount)
	}
	if s.Algorithm != "sorted-path-sha256-v1" {
		t.Errorf("Algorithm = %q", s.Algorithm)
	}
}

func TestSnapshotKeepsTheExecutableBitAndNothingElseOfTheMode(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "run.sh", "#!/bin/sh\n", 0o755)
	write(t, root, "data.txt", "x", 0o600)

	s := take(t, root, snapshot.Options{})

	info, err := os.Stat(filepath.Join(s.Dir, "run.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o100 == 0 {
		t.Errorf("run.sh lost its executable bit: %v", info.Mode())
	}
	info, _ = os.Stat(filepath.Join(s.Dir, "data.txt"))
	if info.Mode()&0o111 != 0 {
		t.Errorf("data.txt became executable: %v", info.Mode())
	}
}

func TestSnapshotHashFollowsTheDocumentedAlgorithm(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "b.txt", "bee", 0o644)
	write(t, root, "a/run.sh", "go", 0o755)

	s := take(t, root, snapshot.Options{})

	// sorted-path-sha256-v1: per entry in byte-sorted path order, hash the path,
	// the entry type, the executable bit and the content SHA-256; then hash the
	// concatenated entry hashes.
	entry := func(path, typ, exec, content string) []byte {
		c := sha256.Sum256([]byte(content))
		h := sha256.Sum256([]byte(path + "\x00" + typ + "\x00" + exec + "\x00" + hex.EncodeToString(c[:])))
		return h[:]
	}
	var all []byte
	all = append(all, entry("a/run.sh", "file", "1", "go")...)
	all = append(all, entry("b.txt", "file", "0", "bee")...)
	want := sha256.Sum256(all)
	if s.Hash != hex.EncodeToString(want[:]) {
		t.Fatalf("Hash = %s, want %s", s.Hash, hex.EncodeToString(want[:]))
	}
}

func TestSnapshotHashIgnoresTimestampsAndOtherPermissionBits(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "a.txt", "x", 0o644)
	before := take(t, root, snapshot.Options{}).Hash

	if err := os.Chmod(filepath.Join(root, "a.txt"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(filepath.Join(root, "a.txt"), old, old); err != nil {
		t.Fatal(err)
	}
	if after := take(t, root, snapshot.Options{}).Hash; after != before {
		t.Fatal("hash changed although only mode bits other than exec and the mtime changed")
	}
}

func TestSnapshotHashChangesWithContentNamesAndExecutableBit(t *testing.T) {
	base := func() string {
		root := resolved(t, t.TempDir())
		write(t, root, "a.txt", "x", 0o644)
		return root
	}
	ref := take(t, base(), snapshot.Options{}).Hash

	cases := map[string]func(root string){
		"content": func(root string) { write(t, root, "a.txt", "y", 0o644) },
		"rename":  func(root string) { _ = os.Rename(filepath.Join(root, "a.txt"), filepath.Join(root, "b.txt")) },
		"exec":    func(root string) { _ = os.Chmod(filepath.Join(root, "a.txt"), 0o755) },
		"added":   func(root string) { write(t, root, "c.txt", "", 0o644) },
	}
	for name, mutate := range cases {
		root := base()
		mutate(root)
		if got := take(t, root, snapshot.Options{}).Hash; got == ref {
			t.Errorf("hash did not change after %s", name)
		}
	}
}

func TestCompareFindsEveryChangedPathOfTheOriginal(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "keep.txt", "k", 0o644)
	write(t, root, "edit.txt", "1", 0o644)
	write(t, root, "gone.txt", "1", 0o644)
	s := take(t, root, snapshot.Options{})

	changed, err := s.Compare(root, snapshot.Options{})
	if err != nil || len(changed) != 0 {
		t.Fatalf("untouched Original: changed=%v err=%v", changed, err)
	}

	write(t, root, "edit.txt", "2", 0o644)
	_ = os.Remove(filepath.Join(root, "gone.txt"))
	write(t, root, "new/file.txt", "n", 0o644)
	write(t, root, "node_modules/x/y.js", "ignored", 0o644)

	changed, err = s.Compare(root, snapshot.Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"edit.txt", "gone.txt", "new/file.txt"}
	if !slices.Equal(changed, want) {
		t.Fatalf("changed = %v, want %v", changed, want)
	}
}

func TestSymlinksInsideAreKeptAndOutsideAreLeftOutWithALimitation(t *testing.T) {
	outside := resolved(t, t.TempDir())
	write(t, outside, "secret.txt", "do not read", 0o644)
	root := resolved(t, t.TempDir())
	write(t, root, "README.md", "readme", 0o644)
	write(t, root, "docs/other.md", "o", 0o644)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Symlink("../README.md", filepath.Join(root, "docs", "index.md")))
	must(os.Symlink(filepath.Join(root, "README.md"), filepath.Join(root, "abs-link.md")))
	must(os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "escape.txt")))
	must(os.Symlink("../../"+filepath.Base(outside)+"/secret.txt", filepath.Join(root, "docs", "escape2.txt")))

	s := take(t, root, snapshot.Options{})

	if got, err := os.Readlink(filepath.Join(s.Dir, "docs", "index.md")); err != nil || got != "../README.md" {
		t.Errorf("relative inside link = %q, %v", got, err)
	}
	if got, err := os.Readlink(filepath.Join(s.Dir, "abs-link.md")); err != nil || got != "README.md" {
		t.Errorf("absolute inside link must become relative, got %q, %v", got, err)
	}
	for _, rel := range []string{"escape.txt", "docs/escape2.txt"} {
		if exists(filepath.Join(s.Dir, rel)) {
			t.Errorf("%s points outside the root and must be left out", rel)
		}
	}
	var limited []string
	for _, l := range s.Limitations {
		if l.Path != "" {
			limited = append(limited, l.Path)
		}
	}
	slices.Sort(limited)
	if want := []string{"docs/escape2.txt", "escape.txt"}; !slices.Equal(limited, want) {
		t.Errorf("limitation paths = %v, want %v", limited, want)
	}
}

func TestExplicitOutputFolderInsideTheRootIsLeftOutAndIgnoredByCompare(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "a.txt", "a", 0o644)
	out := filepath.Join(root, ".output", "js-prueffactory")
	opts := snapshot.Options{ExcludeAbs: []string{out}}

	write(t, root, ".output/js-prueffactory/old.txt", "x", 0o644)
	s := take(t, root, opts)
	if exists(filepath.Join(s.Dir, ".output", "js-prueffactory")) {
		t.Fatal("output folder was copied")
	}
	write(t, root, ".output/js-prueffactory/report.json", "{}", 0o644)
	changed, err := s.Compare(root, opts)
	if err != nil || len(changed) != 0 {
		t.Fatalf("writing the Report must not count as a change: %v %v", changed, err)
	}
}

func TestWriteTarStreamsTheCopyWithRootOwnedEntries(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "a/run.sh", "go", 0o755)
	write(t, root, "b.txt", "bee", 0o644)
	s := take(t, root, snapshot.Options{})

	var buf bytes.Buffer
	if err := s.WriteTar(&buf); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	modes := map[string]int64{}
	tr := tar.NewReader(&buf)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Uid != 0 || h.Gid != 0 {
			t.Errorf("%s owned by %d:%d, want root", h.Name, h.Uid, h.Gid)
		}
		if h.Typeflag == tar.TypeReg {
			b, _ := io.ReadAll(tr)
			got[h.Name] = string(b)
			modes[h.Name] = h.Mode & 0o777
		}
	}
	if got["a/run.sh"] != "go" || got["b.txt"] != "bee" {
		t.Fatalf("tar content = %v", got)
	}
	if modes["a/run.sh"] != 0o755 || modes["b.txt"] != 0o644 {
		t.Fatalf("tar modes = %v", modes)
	}
}

func TestRemoveDeletesTheHostSideCopy(t *testing.T) {
	root := resolved(t, t.TempDir())
	write(t, root, "a.txt", "a", 0o644)
	s := take(t, root, snapshot.Options{})
	if err := s.Remove(); err != nil {
		t.Fatal(err)
	}
	if exists(s.Dir) {
		t.Fatal("copy still exists")
	}
}
