package main

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Sources answers what the registries and release servers say today.
type Sources interface {
	// ImageDigest returns the multi-arch index digest of repo:tag, or an error
	// when the image must not be pinned (for example no arm64 entry).
	ImageDigest(ctx context.Context, repo, tag string) (string, error)
	// Checksum returns the SHA-256 the release server publishes for the archive
	// at archiveURL.
	Checksum(ctx context.Context, archiveURL string) (string, error)
	// FileChecksum returns the SHA-256 of the content of the file at fileURL,
	// for files that no server publishes a checksum for.
	FileChecksum(ctx context.Context, fileURL string) (string, error)
}

// Change is one pinned value that differs from what the sources say.
type Change struct {
	File string
	What string // "node:24.22.1" or the archive URL
	Old  string
	New  string
}

func (c Change) String() string {
	return fmt.Sprintf("%s: %s: %s -> %s", c.File, c.What, c.Old, c.New)
}

// edit replaces the string literal at [start, end) of a file's source.
type edit struct {
	start, end int
	new        string
}

// pin is one value of the table to refresh: the literal holding it and how to
// look the current value up.
type pin struct {
	file       string
	start, end int
	what       string
	old        string
	lookup     func(ctx context.Context, s Sources) (string, error)
}

// Update refreshes the pinned table in the non-test Go files of dir. The table
// is found by shape, not by name, so a tool added later is refreshed without a
// change here: any composite literal with string Repo, Tag and Digest fields is
// an image, and any with string URL and SHA256 fields is a release archive with
// its checksum, and any with string Raw and SHA256 fields is a plain file whose
// checksum is the hash of its content. Tags and versions stay as they are; only digests and checksums
// move. When any value cannot be resolved, or an image is refused, nothing is
// written and the error lists every problem. With write false the files stay
// untouched and the changes are only returned.
func Update(ctx context.Context, dir string, src Sources, write bool) ([]Change, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	type parsed struct {
		path string
		src  []byte
		pins []pin
	}
	var all []parsed
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, content, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		all = append(all, parsed{path: path, src: content, pins: findPins(fset, f, filepath.Base(path))})
	}

	var changes []Change
	var problems []error
	edits := map[string][]edit{}
	cache := map[string]string{}
	for _, p := range all {
		for _, pn := range p.pins {
			key := pn.what
			cur, seen := cache[key]
			if !seen {
				cur, err = pn.lookup(ctx, src)
				if err != nil {
					problems = append(problems, err)
					continue
				}
				cache[key] = cur
			}
			if cur == pn.old {
				continue
			}
			changes = append(changes, Change{File: pn.file, What: pn.what, Old: pn.old, New: cur})
			edits[p.path] = append(edits[p.path], edit{start: pn.start, end: pn.end, new: cur})
		}
	}
	if len(problems) > 0 {
		return nil, errors.Join(problems...)
	}
	if !write {
		return changes, nil
	}
	rewritten := map[string][]byte{}
	for _, p := range all {
		es := edits[p.path]
		if len(es) == 0 {
			continue
		}
		out := append([]byte(nil), p.src...)
		sort.Slice(es, func(i, j int) bool { return es[i].start > es[j].start })
		for _, e := range es {
			out = append(out[:e.start:e.start], append([]byte(strconv.Quote(e.new)), out[e.end:]...)...)
		}
		if _, err := parser.ParseFile(token.NewFileSet(), p.path, out, parser.SkipObjectResolution); err != nil {
			return nil, fmt.Errorf("the rewritten %s no longer parses: %w", p.path, err)
		}
		rewritten[p.path] = out
	}
	for path, out := range rewritten {
		if err := os.WriteFile(path, out, 0o644); err != nil {
			return nil, err
		}
	}
	return changes, nil
}

// findPins lists the digest and checksum literals of one file.
func findPins(fset *token.FileSet, f *ast.File, file string) []pin {
	var pins []pin
	ast.Inspect(f, func(n ast.Node) bool {
		lit, ok := n.(*ast.CompositeLit)
		if !ok {
			return true
		}
		fields := stringFields(lit)
		offset := func(l *ast.BasicLit) (int, int) {
			return fset.Position(l.Pos()).Offset, fset.Position(l.End()).Offset
		}
		if repo, tag, digest := fields["Repo"], fields["Tag"], fields["Digest"]; repo != nil && tag != nil && digest != nil {
			r, t := unquote(repo), unquote(tag)
			s, e := offset(digest)
			pins = append(pins, pin{
				file: file, start: s, end: e, what: r + ":" + t, old: unquote(digest),
				lookup: func(ctx context.Context, src Sources) (string, error) { return src.ImageDigest(ctx, r, t) },
			})
		}
		if u, sum := fields["URL"], fields["SHA256"]; u != nil && sum != nil {
			url := unquote(u)
			s, e := offset(sum)
			pins = append(pins, pin{
				file: file, start: s, end: e, what: url, old: unquote(sum),
				lookup: func(ctx context.Context, src Sources) (string, error) { return src.Checksum(ctx, url) },
			})
		}
		if u, sum := fields["Raw"], fields["SHA256"]; u != nil && sum != nil {
			url := unquote(u)
			s, e := offset(sum)
			pins = append(pins, pin{
				file: file, start: s, end: e, what: url, old: unquote(sum),
				lookup: func(ctx context.Context, src Sources) (string, error) { return src.FileChecksum(ctx, url) },
			})
		}
		return true
	})
	return pins
}

// stringFields returns the keyed fields of a composite literal whose value is
// a plain string literal.
func stringFields(lit *ast.CompositeLit) map[string]*ast.BasicLit {
	out := map[string]*ast.BasicLit{}
	for _, el := range lit.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok {
			continue
		}
		if v, ok := kv.Value.(*ast.BasicLit); ok && v.Kind == token.STRING {
			out[key.Name] = v
		}
	}
	return out
}

func unquote(l *ast.BasicLit) string {
	s, err := strconv.Unquote(l.Value)
	if err != nil {
		return l.Value
	}
	return s
}
