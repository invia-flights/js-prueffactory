package gitstate_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/gitstate"
)

// plantMarkerCommand returns a shell command that proves it ran by creating
// marker.
func plantMarkerCommand(marker string) string {
	return "sh -c 'echo ran > " + marker + "; cat'"
}

// A cloned or downloaded repository brings its own .git/config and
// .gitattributes. Reading the git state must never let them run a command on
// the host, so the dirty state stays unknown and a note says why.
func TestProjectConfigThatCouldRunACommandIsNeverRun(t *testing.T) {
	for name, setup := range map[string]func(t *testing.T, dir, marker string){
		"clean filter": func(t *testing.T, dir, marker string) {
			gitIn(t, dir, "config", "filter.evil.clean", plantMarkerCommand(marker))
			writeFile(t, dir, ".gitattributes", "*.txt filter=evil\n")
		},
		"filter process": func(t *testing.T, dir, marker string) {
			gitIn(t, dir, "config", "filter.evil.process", plantMarkerCommand(marker))
			writeFile(t, dir, ".gitattributes", "*.txt filter=evil\n")
		},
		"fsmonitor hook": func(t *testing.T, dir, marker string) {
			gitIn(t, dir, "config", "core.fsmonitor", "sh -c 'echo ran > "+marker+"'")
		},
		"include of a file with a filter": func(t *testing.T, dir, marker string) {
			inc := filepath.Join(t.TempDir(), "inc.cfg")
			if err := os.WriteFile(inc, []byte("[filter \"evil\"]\n\tclean = "+plantMarkerCommand(marker)+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			gitIn(t, dir, "config", "include.path", inc)
			writeFile(t, dir, ".gitattributes", "*.txt filter=evil\n")
		},
		"external diff": func(t *testing.T, dir, marker string) {
			gitIn(t, dir, "config", "diff.external", plantMarkerCommand(marker))
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := repo(t)
			marker := filepath.Join(t.TempDir(), "marker")
			setup(t, dir, marker)
			// A changed file makes git look at its content, which is when a
			// clean filter would run.
			writeFile(t, dir, "a.txt", "changed\n")

			s := read(t, withGit(t), dir)

			if _, err := os.Stat(marker); err == nil {
				t.Fatal("a command from the project's git configuration ran on the host")
			}
			if s == nil || s.Dirty != gitstate.Unknown || s.Note == "" || s.Commit != gitIn(t, dir, "rev-parse", "HEAD") {
				t.Errorf("state = %+v, want the commit, dirty unknown and a note", s)
			}
		})
	}
}

func appendToConfig(t *testing.T, dir, text string) {
	t.Helper()
	f, err := os.OpenFile(filepath.Join(dir, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

// git ignores a backslash at the end of a comment line, but a reader that
// treats it as a continuation would not see the key on the next line.
func TestAnExecKeyHiddenBehindABackslashIsStillNeverRun(t *testing.T) {
	dir := repo(t)
	marker := filepath.Join(t.TempDir(), "marker")
	appendToConfig(t, dir, "[core]\n\t# a comment ending in a backslash \\\n\tfsmonitor = sh -c 'echo ran > "+marker+"'\n")
	writeFile(t, dir, "a.txt", "changed\n")

	s := read(t, withGit(t), dir)

	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a command from the project's git configuration ran on the host")
	}
	if s == nil || s.Dirty != gitstate.Unknown || s.Note == "" {
		t.Errorf("state = %+v, want dirty unknown and a note", s)
	}
}

// Keys that are not on the list of harmless ones keep git from running, even
// where this tool knows of no way to make `git status` run a program with them.
func TestKeysThatAreNotKnownToBeHarmlessKeepGitFromRunning(t *testing.T) {
	for name, cfg := range map[string]string{
		"partial clone":        "[extensions]\n\tpartialclone = origin\n",
		"upload pack":          "[remote \"origin\"]\n\turl = https://example.invalid/x.git\n\tuploadpack = sh -c true\n",
		"promisor remote":      "[remote \"origin\"]\n\tpromisor = true\n",
		"credential helper":    "[credential]\n\thelper = sh -c true\n",
		"url rewrite":          "[url \"ext::sh -c true %S\"]\n\tinsteadOf = https://example.invalid/\n",
		"alias":                "[alias]\n\tstatus = !sh -c true\n",
		"core pager":           "[core]\n\tpager = sh -c true\n",
		"include if":           "[includeIf \"gitdir:/\"]\n\tpath = /nonexistent\n",
		"old style subsection": "[remote.origin]\n\turl = https://example.invalid/x.git\n",
		"NUL byte":             "[core]\n\tbare = false\x00\n",
	} {
		t.Run(name, func(t *testing.T) {
			dir := repo(t)
			appendToConfig(t, dir, cfg)
			s := read(t, withGit(t), dir)
			if s == nil || s.Dirty != gitstate.Unknown || s.Note == "" || s.Commit != gitIn(t, dir, "rev-parse", "HEAD") {
				t.Errorf("state = %+v, want the commit, dirty unknown and a note", s)
			}
		})
	}
}

// A commondir that exists but cannot be read as a small regular file is a path
// git would follow and this package did not look at.
func TestAnUnreadableCommondirKeepsGitFromRunning(t *testing.T) {
	for name, replace := range map[string]func(t *testing.T, commondir string){
		"symbolic link": func(t *testing.T, commondir string) {
			target := filepath.Join(t.TempDir(), "commondir")
			if err := os.WriteFile(target, []byte("../..\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, commondir); err != nil {
				t.Fatal(err)
			}
		},
		"named pipe": func(t *testing.T, commondir string) {
			if err := syscall.Mkfifo(commondir, 0o644); err != nil {
				t.Skip("no named pipes here")
			}
		},
		"too large": func(t *testing.T, commondir string) {
			if err := os.WriteFile(commondir, []byte("../..\n"+strings.Repeat(" ", 100<<10)), 0o644); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := repo(t)
			wt := filepath.Join(resolved(t, t.TempDir()), "wt")
			gitIn(t, dir, "worktree", "add", "-q", "--detach", wt)
			want := gitIn(t, wt, "rev-parse", "HEAD")
			commondir := filepath.Join(dir, ".git", "worktrees", "wt", "commondir")
			if err := os.Remove(commondir); err != nil {
				t.Fatal(err)
			}
			replace(t, commondir)

			done := make(chan *gitstate.State, 1)
			go func() { done <- read(t, withGit(t), wt) }()
			var s *gitstate.State
			select {
			case s = <-done:
			case <-time.After(20 * time.Second):
				t.Fatal("Read hung")
			}

			if s == nil || s.Dirty != gitstate.Unknown || s.Note == "" || s.Commit != want {
				t.Errorf("state = %+v, want commit %s, dirty unknown and a note", s, want)
			}
		})
	}
}

// The user's own global git configuration is just as unwelcome: it may define
// a filter that an attribute in the project switches on.
func TestGlobalGitConfigurationIsNotReadEither(t *testing.T) {
	dir := repo(t)
	marker := filepath.Join(t.TempDir(), "marker")
	home := t.TempDir()
	cfg := "[filter \"evil\"]\n\tclean = " + plantMarkerCommand(marker) + "\n"
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, ".gitattributes", "*.txt filter=evil\n")
	writeFile(t, dir, "a.txt", "changed\n")
	r := gitstate.Reader{Exe: requireGit(t), Env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "XDG_CONFIG_HOME=" + home}}

	s := read(t, r, dir)

	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a filter from the global git configuration ran")
	}
	if s == nil || s.Dirty != gitstate.Dirty {
		t.Errorf("state = %+v, want dirty", s)
	}
}

func TestOrdinaryRepositoryConfigStillGivesTheDirtyState(t *testing.T) {
	dir := repo(t)
	gitIn(t, dir, "config", "core.autocrlf", "false")
	gitIn(t, dir, "remote", "add", "origin", "https://example.invalid/x.git")
	gitIn(t, dir, "config", "branch.main.remote", "origin")
	writeFile(t, dir, "a.txt", "changed\n")
	if s := read(t, withGit(t), dir); s == nil || s.Dirty != gitstate.Dirty || s.Note != "" {
		t.Errorf("state = %+v, want dirty without a note", s)
	}
}

func TestTheFallbackReadsOnlyBoundedRegularFiles(t *testing.T) {
	t.Run("HEAD is a named pipe", func(t *testing.T) {
		dir := repo(t)
		head := filepath.Join(dir, ".git", "HEAD")
		if err := os.Remove(head); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(head, 0o644); err != nil {
			t.Skip("no named pipes here")
		}
		assertReadFailsQuickly(t, dir)
	})
	t.Run("HEAD is a symbolic link", func(t *testing.T) {
		dir := repo(t)
		head := filepath.Join(dir, ".git", "HEAD")
		target := filepath.Join(t.TempDir(), "HEAD")
		if err := os.WriteFile(target, []byte(gitIn(t, dir, "rev-parse", "HEAD")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		_ = os.Remove(head)
		if err := os.Symlink(target, head); err != nil {
			t.Fatal(err)
		}
		assertReadFailsQuickly(t, dir)
	})
	t.Run("HEAD is far too large", func(t *testing.T) {
		dir := repo(t)
		huge := gitIn(t, dir, "rev-parse", "HEAD") + "\n" + strings.Repeat("x", 200<<10)
		writeFile(t, filepath.Join(dir, ".git"), "HEAD", huge)
		assertReadFailsQuickly(t, dir)
	})
	t.Run("packed-refs is far too large", func(t *testing.T) {
		dir := repo(t)
		gitIn(t, dir, "pack-refs", "--all")
		packed := filepath.Join(dir, ".git", "packed-refs")
		b, err := os.ReadFile(packed)
		if err != nil {
			t.Fatal(err)
		}
		// The branch line sits behind more than the size limit.
		big := append([]byte(strings.Repeat("# "+strings.Repeat("x", 78)+"\n", 60000)), b...)
		if err := os.WriteFile(packed, big, 0o644); err != nil {
			t.Fatal(err)
		}
		assertReadFailsQuickly(t, dir)
	})
}

func TestACancelledContextStopsTheFallback(t *testing.T) {
	dir := repo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s, err := (gitstate.Reader{}).Read(ctx, dir); err == nil {
		t.Errorf("state %+v, want an error for a cancelled context", s)
	}
}

func assertReadFailsQuickly(t *testing.T, dir string) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := gitstate.Reader{}.Read(context.Background(), dir)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Error("Read succeeded, want an error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Read hung")
	}
}
