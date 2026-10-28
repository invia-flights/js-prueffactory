// Package gitstate reads which git commit the Original is at and whether its
// working tree is dirty, without ever writing to the Original and without ever
// letting the Original's own configuration run a command on the host.
//
// It prefers the `git` CLI with optional locks switched off, so `git status`
// cannot refresh and rewrite the Original's index, and with the user's global
// and system configuration switched off. It runs git only after the
// repository's own configuration has been checked against an allowlist (see
// config.go). Without a usable or safe git it reads HEAD directly and reports
// the dirty state as unknown.
package gitstate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Dirty states.
const (
	Clean   = "clean"
	Dirty   = "dirty"
	Unknown = "unknown"
)

// State is the git state of the Original.
type State struct {
	Commit string
	// Dirty is Clean, Dirty or Unknown. Untracked files make a tree dirty;
	// ignored files do not.
	Dirty string
	// Note says why git was deliberately not run (Dirty is then Unknown). It
	// is empty when git was run, or when the host simply has no git.
	Note string
}

// Reader reads git state. The zero value stands for a host without a git
// binary.
type Reader struct {
	// Exe is the path of the git binary, empty if the host has none.
	Exe string
	// Env is the environment git runs in, before the isolation settings of
	// Reader.git are added.
	Env []string
}

// FromEnv looks for git on PATH. Git runs with a small, fixed environment so
// that variables such as GIT_DIR or GIT_INDEX_FILE of the caller cannot
// redirect it away from the Original. HOME and XDG_CONFIG_HOME are not passed,
// so the user's git configuration is not read.
func FromEnv(getenv func(string) string) Reader {
	var r Reader
	for _, dir := range filepath.SplitList(getenv("PATH")) {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, "git")
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			r.Exe = p
			break
		}
	}
	r.Env = []string{"PATH=" + getenv("PATH")}
	return r
}

// commandTimeout bounds each git call, so a huge or stuck repository degrades
// to an unknown dirty state instead of blocking the Run.
const commandTimeout = 2 * time.Minute

// Read returns the git state of root. It returns (nil, nil) when root has no
// `.git`, and an error when `.git` exists but no commit can be found, as in a
// repository without commits.
func (r Reader) Read(ctx context.Context, root string) (*State, error) {
	if _, err := os.Lstat(filepath.Join(root, ".git")); errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	gitDir, common, note, err := locateDirs(ctx, root)
	if err != nil {
		return nil, err
	}
	if r.Exe != "" {
		if note == "" {
			note = configRisk(ctx, gitDir, common)
		}
		if note == "" {
			if s, err := r.viaGit(ctx, root); err == nil {
				return s, nil
			}
			// git is there but failed, for example on "dubious ownership".
			// Fall through to reading HEAD, which needs no git.
		}
	}
	commit, err := commitFromHead(ctx, gitDir, common)
	if err != nil {
		return nil, err
	}
	return &State{Commit: commit, Dirty: Unknown, Note: note}, nil
}

func (r Reader) viaGit(ctx context.Context, root string) (*State, error) {
	commit, err := r.git(ctx, root, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil {
		return nil, err
	}
	commit = strings.TrimSpace(commit)
	if !hexID.MatchString(commit) {
		return nil, fmt.Errorf("git rev-parse printed %q", commit)
	}
	// Submodules are left out: `git status` would start another git inside
	// each one, which reads that submodule's own, unchecked configuration.
	status, err := r.git(ctx, root, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all")
	if err != nil {
		return nil, err
	}
	dirty := Clean
	if strings.TrimSpace(status) != "" {
		dirty = Dirty
	}
	return &State{Commit: commit, Dirty: dirty}, nil
}

// git runs one read-only git command inside root, in an isolated setup.
// --no-optional-locks stops `status` from writing the refreshed index back.
// The system and global configuration and the attributes file outside the
// repository are switched off, and the settings that could start a program
// are overridden on the command line (belt and braces: the repository's
// configuration has already been checked, see config.go).
func (r Reader) git(ctx context.Context, root string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	full := append([]string{
		"--no-optional-locks",
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=" + os.DevNull,
		"-c", "core.attributesFile=" + os.DevNull,
		"-c", "core.untrackedCache=false",
		"-c", "protocol.allow=never",
		"-C", root}, args...)
	cmd := exec.CommandContext(ctx, r.Exe, full...)
	// Later entries win, so these override whatever the caller's Env holds.
	cmd.Env = append(append([]string{}, r.Env...),
		"GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull,
		"GIT_NO_LAZY_FETCH=1", "GIT_ATTR_NOSYSTEM=1", "HOME="+os.DevNull, "XDG_CONFIG_HOME="+os.DevNull)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

var hexID = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// locateDirs returns the folder holding HEAD (`.git` itself, or the folder a
// `.git` file points to) and the common folder holding refs and config (the
// same folder unless `commondir` says otherwise, as in linked worktrees).
// Only a missing commondir file means "same folder". One that exists but is
// not a bounded regular file is something git would follow and this code did
// not look at, so it comes back as a note (git must not run) and the commit is
// read from the git folder alone.
func locateDirs(ctx context.Context, root string) (gitDir, common, note string, err error) {
	gitDir, err = locateGitDir(ctx, root)
	if err != nil {
		return "", "", "", err
	}
	b, err := readRegular(ctx, filepath.Join(gitDir, "commondir"), maxSmallFile)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return gitDir, gitDir, "", nil
	case err != nil:
		return gitDir, gitDir, "the commondir file of the repository cannot be checked: " + err.Error(), nil
	}
	return gitDir, joinFrom(gitDir, strings.TrimSpace(string(b))), "", nil
}

// commitFromHead resolves HEAD by reading the repository's files, all of them
// bounded regular files. It follows loose refs and packed-refs.
func commitFromHead(ctx context.Context, gitDir, common string) (string, error) {
	head, err := readRegular(ctx, filepath.Join(gitDir, "HEAD"), maxSmallFile)
	if err != nil {
		return "", fmt.Errorf("cannot read HEAD: %w", err)
	}
	text := strings.TrimSpace(string(head))
	if hexID.MatchString(text) {
		return text, nil
	}
	ref, ok := strings.CutPrefix(text, "ref: ")
	if !ok || ref == "" || strings.Contains(ref, "..") {
		return "", fmt.Errorf("HEAD is not a commit or a branch: %q", text)
	}
	for _, dir := range []string{gitDir, common} {
		if b, err := readRegular(ctx, filepath.Join(dir, filepath.FromSlash(ref)), maxSmallFile); err == nil {
			if id := strings.TrimSpace(string(b)); hexID.MatchString(id) {
				return id, nil
			}
		}
	}
	if b, err := readRegular(ctx, filepath.Join(common, "packed-refs"), maxPackedRefs); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if id, name, ok := strings.Cut(strings.TrimSpace(line), " "); ok && name == ref && hexID.MatchString(id) {
				return id, nil
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("%s has no commit yet", ref)
}

// locateGitDir returns `.git` itself, or the folder a `.git` file points to.
// The folders of a linked worktree or a submodule may lie outside the
// Original, so the target is not restricted to it; only bounded regular files
// are read from it.
func locateGitDir(ctx context.Context, root string) (string, error) {
	dotGit := filepath.Join(root, ".git")
	info, err := os.Stat(dotGit)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return dotGit, nil
	}
	b, err := readRegular(ctx, dotGit, maxSmallFile)
	if err != nil {
		return "", err
	}
	target, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
	if !ok {
		return "", errors.New(".git is a file without a gitdir line")
	}
	return joinFrom(root, strings.TrimSpace(target)), nil
}

func joinFrom(base, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
}
