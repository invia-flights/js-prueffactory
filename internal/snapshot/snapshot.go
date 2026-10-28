// Package snapshot takes the Snapshot of the Original: a hashed, host-side
// copy of its files that Checks work from, and the final re-hash that proves
// the Original was not modified. It never writes to the Original.
package snapshot

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Algorithm is the ID of the hashing algorithm recorded in the Report.
const Algorithm = "sorted-path-sha256-v1"

// Options adjusts what a Snapshot contains.
type Options struct {
	// ExcludeAbs lists absolute folders inside the root to leave out, such as an
	// explicit report folder. The caller resolves symlinks before passing them.
	ExcludeAbs []string
}

// Limitation is something the Snapshot could not take over.
type Limitation struct {
	Code    string
	Message string
	Path    string // relative to the root, "/" separators
}

// Snapshot is the identified state of the Original's files.
type Snapshot struct {
	// Dir is the host-side copy. Remove deletes it.
	Dir       string
	Algorithm string
	// Hash is the SHA-256 over the sorted entry hashes, as hex.
	Hash      string
	FileCount int
	// Excluded names what was left out by rule: "node_modules/" at any depth,
	// ".git" at the root, and every explicit exclusion as a root-relative path.
	Excluded    []string
	Limitations []Limitation

	entries map[string]string // relative path -> entry hash, hex
}

// Take copies the files of root into dest, which must not exist yet or be empty.
// The root must already be resolved (no symlinks in its own path).
func Take(root, dest string, opts Options) (*Snapshot, error) {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return nil, err
	}
	sc, err := scan(root, opts, dest)
	if err != nil {
		_ = os.RemoveAll(dest)
		return nil, err
	}
	s := &Snapshot{
		Dir: dest, Algorithm: Algorithm, Hash: sc.hash, FileCount: len(sc.entries),
		Limitations: sc.limitations, entries: sc.entries,
		Excluded: []string{"node_modules/", ".git"},
	}
	for _, abs := range opts.ExcludeAbs {
		if rel, err := filepath.Rel(root, abs); err == nil && !strings.HasPrefix(rel, "..") {
			s.Excluded = append(s.Excluded, filepath.ToSlash(rel))
		}
	}
	return s, nil
}

// Compare re-hashes the Original with the same algorithm and exclusions and
// returns the relative paths that differ from the Snapshot, sorted.
func (s *Snapshot) Compare(root string, opts Options) ([]string, error) {
	sc, err := scan(root, opts, "")
	if err != nil {
		return nil, err
	}
	changed := map[string]bool{}
	for p, h := range s.entries {
		if now, ok := sc.entries[p]; !ok || now != h {
			changed[p] = true
		}
	}
	for p := range sc.entries {
		if _, ok := s.entries[p]; !ok {
			changed[p] = true
		}
	}
	out := make([]string, 0, len(changed))
	for p := range changed {
		out = append(out, p)
	}
	sort.Strings(out)
	return out, nil
}

// Remove deletes the host-side copy.
func (s *Snapshot) Remove() error { return os.RemoveAll(s.Dir) }

// WriteTar writes the copy as a tar archive. Entries are owned by root, files
// have mode 0644 or 0755 and no timestamps, so the archive depends only on what
// the Snapshot hash covers. This is the only way the Snapshot reaches Docker.
func (s *Snapshot) WriteTar(w io.Writer) error {
	tw := tar.NewWriter(w)
	err := filepath.WalkDir(s.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(s.Dir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		switch {
		case d.IsDir():
			return tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: name + "/", Mode: 0o755})
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return tw.WriteHeader(&tar.Header{Typeflag: tar.TypeSymlink, Name: name, Linkname: target, Mode: 0o777})
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			mode := int64(0o644)
			if info.Mode()&0o100 != 0 {
				mode = 0o755
			}
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: mode, Size: info.Size()}); err != nil {
				return err
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

type scanResult struct {
	hash        string
	entries     map[string]string
	limitations []Limitation
}

// scan walks root once. With a non-empty dest it also copies what it keeps.
func scan(root string, opts Options, dest string) (*scanResult, error) {
	res := &scanResult{entries: map[string]string{}}
	excluded := map[string]bool{}
	for _, abs := range opts.ExcludeAbs {
		excluded[filepath.Clean(abs)] = true
	}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		slash := filepath.ToSlash(rel)
		if err != nil {
			res.limit("unreadable_path", "cannot read "+slash+": "+err.Error(), slash)
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if rel == "." {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if name == "node_modules" || (rel == ".git") || excluded[path] {
				return fs.SkipDir
			}
			if dest != "" {
				return os.MkdirAll(filepath.Join(dest, rel), 0o755)
			}
			return nil
		}
		if rel == ".git" { // a .git file, as in worktrees and submodules
			return nil
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			target, ok, why := linkTarget(root, path)
			if !ok {
				res.limit("symlink_outside_root", fmt.Sprintf("symlink %s %s and was left out", slash, why), slash)
				return nil
			}
			res.entries[slash] = entryHash(slash, "symlink", false, target)
			if dest != "" {
				return os.Symlink(target, filepath.Join(dest, rel))
			}
		case d.Type().IsRegular():
			return res.addFile(path, rel, slash, dest)
		default:
			res.limit("special_file", fmt.Sprintf("%s is a special file (%s) and was left out", slash, d.Type()), slash)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, len(res.entries))
	for p := range res.entries {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, p := range paths {
		raw, _ := hex.DecodeString(res.entries[p])
		h.Write(raw)
	}
	res.hash = hex.EncodeToString(h.Sum(nil))
	sort.Slice(res.limitations, func(i, j int) bool { return res.limitations[i].Path < res.limitations[j].Path })
	return res, nil
}

func (r *scanResult) limit(code, msg, path string) {
	r.limitations = append(r.limitations, Limitation{Code: code, Message: msg, Path: path})
}

func (r *scanResult) addFile(path, rel, slash, dest string) error {
	info, err := os.Stat(path)
	if err != nil {
		r.limit("unreadable_path", "cannot read "+slash+": "+err.Error(), slash)
		return nil
	}
	in, err := os.Open(path)
	if err != nil {
		r.limit("unreadable_path", "cannot read "+slash+": "+err.Error(), slash)
		return nil
	}
	defer in.Close()
	exec := info.Mode()&0o100 != 0
	sum := sha256.New()
	var w io.Writer = sum
	var out *os.File
	if dest != "" {
		mode := os.FileMode(0o644)
		if exec {
			mode = 0o755
		}
		out, err = os.OpenFile(filepath.Join(dest, rel), os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		w = io.MultiWriter(sum, out)
	}
	_, copyErr := io.Copy(w, in)
	if out != nil {
		if err := out.Close(); err != nil && copyErr == nil {
			copyErr = err
		}
		// OpenFile applies the umask, so set the bits explicitly.
		mode := os.FileMode(0o644)
		if exec {
			mode = 0o755
		}
		_ = os.Chmod(out.Name(), mode)
	}
	if copyErr != nil {
		if out != nil {
			_ = os.Remove(out.Name())
		}
		r.limit("unreadable_path", "cannot read "+slash+": "+copyErr.Error(), slash)
		return nil
	}
	r.entries[slash] = entryHash(slash, "file", exec, hex.EncodeToString(sum.Sum(nil)))
	return nil
}

// entryHash is the hash of one entry: path, type, executable bit and either the
// content SHA-256 or the link target.
func entryHash(path, typ string, exec bool, value string) string {
	x := "0"
	if exec {
		x = "1"
	}
	sum := sha256.Sum256([]byte(path + "\x00" + typ + "\x00" + x + "\x00" + value))
	return hex.EncodeToString(sum[:])
}

// linkTarget decides whether a symlink may be kept. It returns the target as it
// is written into the copy: relative links stay as they are and absolute links
// into the root become relative ones. Links that resolve outside the root are
// refused so the tool never reads files outside the Original.
func linkTarget(root, path string) (target string, ok bool, why string) {
	raw, err := os.Readlink(path)
	if err != nil {
		return "", false, "cannot be read: " + err.Error()
	}
	abs := raw
	if !filepath.IsAbs(raw) {
		abs = filepath.Join(filepath.Dir(path), raw)
	}
	abs = filepath.Clean(abs)
	check := abs
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		check = r
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", false, "cannot be resolved: " + err.Error()
	}
	// A relative link is copied as written, so it must stay inside the root
	// on its own path too, or the copy would point somewhere else.
	if !within(root, check) || (!filepath.IsAbs(raw) && !within(root, abs)) {
		return "", false, "points outside the project"
	}
	if filepath.IsAbs(raw) {
		// An absolute link may name the root by another route, such as an alias
		// of it. Inside is decided on the resolved path, and the copy gets a link
		// to that path, relative to the link's own folder.
		rel, err := filepath.Rel(filepath.Dir(path), check)
		if err != nil {
			return "", false, "cannot be made relative"
		}
		return filepath.ToSlash(rel), true, ""
	}
	return filepath.ToSlash(raw), true, ""
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
