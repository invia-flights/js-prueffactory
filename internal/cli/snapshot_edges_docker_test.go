//go:build docker

package cli_test

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Seam A tests for ticket 03: what the Report says about git state, symlinks
// and a report folder inside the Original. They use copies of testdata
// projects and the real Docker daemon.

// copyTree copies a testdata project like copyProject, but keeps symlinks as
// symlinks.
func copyTree(t *testing.T, name string) string {
	t.Helper()
	src := filepath.Join("..", "..", "testdata", "projects", name)
	dst := filepath.Join(t.TempDir(), name)
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(dst)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

// git runs the real git CLI in dir. It is the independent source of truth for
// the commit the Report must name.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git binary on this host")
	}
	cmd := exec.Command("git", append([]string{
		"-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main",
	}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, errb.String())
	}
	return strings.TrimSpace(out.String())
}

// gitCopy turns a copy of a testdata project into a repository with one commit.
func gitCopy(t *testing.T, name string) string {
	t.Helper()
	dir := copyProject(t, name)
	git(t, dir, "init", "-q")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "first")
	return dir
}

func sourceGit(t *testing.T, r *dockerRun) (commit, dirty string, present bool) {
	t.Helper()
	g := r.set.Source.Git
	if g == nil {
		return "", "", false
	}
	return g.Commit, g.Dirty, true
}

func TestGitCommitAndCleanStateAreRecordedAndTheIndexIsNotWritten(t *testing.T) {
	original := gitCopy(t, "clean-mocha")
	// Make the index stale: a plain `git status` would refresh and rewrite it.
	earlier := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(original, "src", "index.js"), earlier, earlier); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(original, ".git", "index")
	indexBefore, _ := os.ReadFile(index)
	infoBefore, _ := os.Stat(index)
	want := git(t, original, "rev-parse", "HEAD")

	r := realRun(t, context.Background(), "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d\n%s", r.code, r.stderr)
	}
	commit, dirty, ok := sourceGit(t, r)
	if !ok || commit != want || dirty != "clean" {
		t.Errorf("source.git = %q %q (present %v), want %q clean", commit, dirty, ok, want)
	}
	indexAfter, _ := os.ReadFile(index)
	infoAfter, _ := os.Stat(index)
	if !bytes.Equal(indexBefore, indexAfter) || !infoBefore.ModTime().Equal(infoAfter.ModTime()) {
		t.Error("the Run changed .git/index of the Original")
	}
	if !r.set.Source.OriginalUnchanged {
		t.Errorf("source = %+v", r.set.Source)
	}
	// The .git folder never reaches the Snapshot.
	if r.set.Source.FileCount != 6 {
		t.Errorf("file count = %d, want 6", r.set.Source.FileCount)
	}
	r.assertNothingLeft(t)
}

func TestGitDirtyStateIsRecorded(t *testing.T) {
	original := gitCopy(t, "clean-mocha")
	if err := os.WriteFile(filepath.Join(original, "src", "index.js"), []byte("module.exports = 2;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := git(t, original, "rev-parse", "HEAD")

	r := realRun(t, context.Background(), "test", original)

	commit, dirty, ok := sourceGit(t, r)
	if !ok || commit != want || dirty != "dirty" {
		t.Errorf("source.git = %q %q (present %v), want %q dirty", commit, dirty, ok, want)
	}
	r.assertNothingLeft(t)
}

func TestWithoutADotGitFolderTheGitStateIsNull(t *testing.T) {
	original := copyProject(t, "clean-mocha")

	r := realRun(t, context.Background(), "test", original)

	source, _ := r.report["source"].(map[string]any)
	if v, present := source["git"]; !present || v != nil {
		t.Errorf("source.git = %v (present %v), want null", v, present)
	}
	r.assertNothingLeft(t)
}

func TestWithoutAGitBinaryTheCommitComesFromHeadAndDirtyIsUnknown(t *testing.T) {
	original := gitCopy(t, "clean-mocha")
	want := git(t, original, "rev-parse", "HEAD")
	dockerExe, err := exec.LookPath("docker")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err := os.Symlink(dockerExe, filepath.Join(bin, "docker")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin) // docker is there, git is not

	r := realRun(t, context.Background(), "test", original)

	commit, dirty, ok := sourceGit(t, r)
	if !ok || commit != want || dirty != "unknown" {
		t.Errorf("source.git = %q %q (present %v), want %q unknown\nstderr:\n%s", commit, dirty, ok, want, r.stderr)
	}
	r.assertNothingLeft(t)
}

func TestSymlinksInsideAreKeptAndOutsideLinksAreLeftOutAsALimitation(t *testing.T) {
	original := copyTree(t, "symlinks")
	before := treeFingerprint(t, original)

	r := realRun(t, context.Background(), "test", original)

	if r.code != 0 {
		t.Fatalf("exit = %d\n%s", r.code, r.stderr)
	}
	// package.json, src/index.js, docs/notes.md and the two links inside.
	if r.set.Source.FileCount != 5 || !r.set.Source.OriginalUnchanged {
		t.Errorf("source = %+v", r.set.Source)
	}
	var found []string
	for _, l := range r.set.Limitations {
		if l.Path != nil {
			found = append(found, *l.Path+" "+l.ReasonCode)
		}
	}
	if !slices.Equal(found, []string{"outside-link.md symlink_outside_root"}) {
		t.Errorf("limitations with a path = %v", found)
	}
	md, _ := os.ReadFile(filepath.Join(r.reportDir, "report.md"))
	if !strings.Contains(string(md), "outside-link.md") {
		t.Error("report.md does not name the link that was left out")
	}
	if treeFingerprint(t, original) != before {
		t.Error("the Original changed")
	}
	r.assertNothingLeft(t)
}

func TestExplicitOutputFolderInsideTheOriginalIsExcludedAndDoesNotCountAsAChange(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	out := filepath.Join(original, ".reports", "run-1")

	r := realRun(t, context.Background(), "test", original, "--output-dir", out)

	if r.code != 0 {
		t.Fatalf("exit = %d\n%s", r.code, r.stderr)
	}
	if r.reportDir != out {
		t.Errorf("report folder = %q, want %q", r.reportDir, out)
	}
	for _, f := range []string{"report.json", "report.md"} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	if !r.set.Source.OriginalUnchanged || len(r.set.Source.ChangedPaths) != 0 {
		t.Errorf("source = %+v", r.set.Source)
	}
	if !slices.Contains(r.set.Source.ExcludedPaths, ".reports/run-1") {
		t.Errorf("excluded paths = %v, want .reports/run-1 among them", r.set.Source.ExcludedPaths)
	}
	if r.set.Source.FileCount != 6 {
		t.Errorf("file count = %d, want 6: the report folder is not part of the Snapshot", r.set.Source.FileCount)
	}
	r.assertNothingLeft(t)
}

// The tool resolves symlinks before it asks whether a folder lies inside the
// Original, so a link from outside into the Original does not hide the report
// folder from the Snapshot.
func TestExplicitOutputFolderReachedThroughASymlinkIsStillRecognisedAsInside(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	inside := filepath.Join(original, "ci-output")
	if err := os.Mkdir(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(inside, alias); err != nil {
		t.Fatal(err)
	}

	r := realRun(t, context.Background(), "test", original, "--output-dir", filepath.Join(alias, "run-1"))

	if r.code != 0 {
		t.Fatalf("exit = %d\n%s", r.code, r.stderr)
	}
	if _, err := os.Stat(filepath.Join(inside, "run-1", "report.json")); err != nil {
		t.Errorf("the report did not land inside the Original: %v", err)
	}
	if !r.set.Source.OriginalUnchanged || !slices.Contains(r.set.Source.ExcludedPaths, "ci-output/run-1") {
		t.Errorf("source = %+v", r.set.Source)
	}
	r.assertNothingLeft(t)
}
