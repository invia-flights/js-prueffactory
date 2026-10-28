package gitstate_test

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/gitstate"
)

// gitIn runs the real git CLI in dir as the source of truth for what a
// repository contains. Tests skip when the host has no git.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
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

func requireGit(t *testing.T) string {
	t.Helper()
	exe, err := exec.LookPath("git")
	if err != nil {
		t.Skip("no git binary on this host")
	}
	return exe
}

func resolved(t *testing.T, dir string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// repo creates a repository with one commit and returns its folder.
func repo(t *testing.T) string {
	t.Helper()
	requireGit(t)
	dir := resolved(t, t.TempDir())
	gitIn(t, dir, "init", "-q")
	writeFile(t, dir, "a.txt", "a\n")
	writeFile(t, dir, "b.txt", "b\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-q", "-m", "first")
	return dir
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// withGit reads through the real git CLI, as the tool does on a normal host.
func withGit(t *testing.T) gitstate.Reader {
	t.Helper()
	exe := requireGit(t)
	return gitstate.Reader{Exe: exe, Env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}}
}

// withoutGit is a host that has no git binary.
var withoutGit = gitstate.Reader{}

func read(t *testing.T, r gitstate.Reader, dir string) *gitstate.State {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s, err := r.Read(ctx, dir)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	return s
}

func TestWithoutDotGitThereIsNoGitState(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.txt", "a")
	if s := read(t, withoutGit, dir); s != nil {
		t.Errorf("state = %+v, want nil", s)
	}
	if s := read(t, withGit(t), dir); s != nil {
		t.Errorf("state with git = %+v, want nil", s)
	}
}

func TestACleanRepositoryHasItsHeadCommitAndIsClean(t *testing.T) {
	dir := repo(t)
	s := read(t, withGit(t), dir)
	if want := gitIn(t, dir, "rev-parse", "HEAD"); s == nil || s.Commit != want || s.Dirty != gitstate.Clean {
		t.Fatalf("state = %+v, want commit %s clean", s, want)
	}
}

func TestAModifiedOrUntrackedFileMakesTheStateDirty(t *testing.T) {
	for name, change := range map[string]func(dir string){
		"modified tracked file": func(dir string) { writeFile(t, dir, "a.txt", "changed\n") },
		"untracked file":        func(dir string) { writeFile(t, dir, "new.txt", "new\n") },
		"staged file": func(dir string) {
			writeFile(t, dir, "c.txt", "c\n")
			gitIn(t, dir, "add", "c.txt")
		},
		"deleted file": func(dir string) { _ = os.Remove(filepath.Join(dir, "b.txt")) },
	} {
		t.Run(name, func(t *testing.T) {
			dir := repo(t)
			change(dir)
			s := read(t, withGit(t), dir)
			if s == nil || s.Dirty != gitstate.Dirty || s.Commit != gitIn(t, dir, "rev-parse", "HEAD") {
				t.Errorf("state = %+v", s)
			}
		})
	}
}

func TestIgnoredFilesDoNotMakeTheStateDirty(t *testing.T) {
	dir := repo(t)
	writeFile(t, dir, ".gitignore", "*.log\n")
	gitIn(t, dir, "add", ".gitignore")
	gitIn(t, dir, "commit", "-q", "-m", "ignore")
	writeFile(t, dir, "debug.log", "noise")
	if s := read(t, withGit(t), dir); s == nil || s.Dirty != gitstate.Clean {
		t.Errorf("state = %+v", s)
	}
}

// A plain `git status` refreshes the stat information in .git/index and writes
// it back. Touching a tracked file makes the index stale, so only a read with
// optional locks switched off leaves the file alone.
func TestReadingGitStateNeverWritesTheIndex(t *testing.T) {
	dir := repo(t)
	index := filepath.Join(dir, ".git", "index")
	earlier := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "a.txt"), earlier, earlier); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	infoBefore, _ := os.Stat(index)

	s := read(t, withGit(t), dir)

	after, _ := os.ReadFile(index)
	infoAfter, _ := os.Stat(index)
	if !bytes.Equal(before, after) || !infoBefore.ModTime().Equal(infoAfter.ModTime()) {
		t.Error("reading the git state changed .git/index")
	}
	if s == nil || s.Dirty != gitstate.Clean {
		t.Errorf("state = %+v", s)
	}
	if entries, _ := filepath.Glob(filepath.Join(dir, ".git", "*.lock")); len(entries) != 0 {
		t.Errorf("lock files left behind: %v", entries)
	}
}

func TestWithoutAGitBinaryTheCommitComesFromHeadAndDirtyIsUnknown(t *testing.T) {
	dir := repo(t)
	writeFile(t, dir, "a.txt", "changed\n")
	want := gitIn(t, dir, "rev-parse", "HEAD")

	s := read(t, withoutGit, dir)

	if s == nil || s.Commit != want || s.Dirty != gitstate.Unknown {
		t.Fatalf("state = %+v, want commit %s unknown", s, want)
	}
}

func TestHeadIsReadFromPackedRefsDetachedHeadsAndWorktrees(t *testing.T) {
	t.Run("packed refs", func(t *testing.T) {
		dir := repo(t)
		gitIn(t, dir, "pack-refs", "--all")
		if _, err := os.Stat(filepath.Join(dir, ".git", "refs", "heads", "main")); err == nil {
			t.Fatal("test set-up: the loose ref is still there")
		}
		if s := read(t, withoutGit, dir); s == nil || s.Commit != gitIn(t, dir, "rev-parse", "HEAD") {
			t.Errorf("state = %+v", s)
		}
	})
	t.Run("detached head", func(t *testing.T) {
		dir := repo(t)
		gitIn(t, dir, "checkout", "-q", "--detach")
		if s := read(t, withoutGit, dir); s == nil || s.Commit != gitIn(t, dir, "rev-parse", "HEAD") {
			t.Errorf("state = %+v", s)
		}
	})
	t.Run("linked worktree whose .git is a file", func(t *testing.T) {
		dir := repo(t)
		gitIn(t, dir, "commit", "-q", "--allow-empty", "-m", "second")
		wt := filepath.Join(resolved(t, t.TempDir()), "wt")
		gitIn(t, dir, "worktree", "add", "-q", "-b", "other", wt, "HEAD~1")
		want := gitIn(t, wt, "rev-parse", "HEAD")
		if want == gitIn(t, dir, "rev-parse", "HEAD") {
			t.Fatal("test set-up: worktree is on the main commit")
		}
		if s := read(t, withoutGit, wt); s == nil || s.Commit != want || s.Dirty != gitstate.Unknown {
			t.Errorf("without git: %+v", s)
		}
		if s := read(t, withGit(t), wt); s == nil || s.Commit != want || s.Dirty != gitstate.Clean {
			t.Errorf("with git: %+v", s)
		}
	})
}

func TestAGitBinaryThatFailsFallsBackToHead(t *testing.T) {
	dir := repo(t)
	bin := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'fatal: detected dubious ownership' >&2\nexit 128\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := read(t, gitstate.Reader{Exe: bin}, dir)
	if s == nil || s.Commit != gitIn(t, dir, "rev-parse", "HEAD") || s.Dirty != gitstate.Unknown {
		t.Errorf("state = %+v", s)
	}
}

func TestARepositoryWithoutACommitCannotBeRead(t *testing.T) {
	requireGit(t)
	dir := resolved(t, t.TempDir())
	gitIn(t, dir, "init", "-q")
	for name, r := range map[string]gitstate.Reader{"with git": withGit(t), "without git": withoutGit} {
		s, err := r.Read(context.Background(), dir)
		if err == nil || s != nil {
			t.Errorf("%s: state %+v, err %v; want an error", name, s, err)
		}
	}
}
