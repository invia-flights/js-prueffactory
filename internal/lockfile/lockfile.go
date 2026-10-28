// Package lockfile reads package.json and npm lockfiles in Go, without Node and
// without a container. package.manifest uses it to validate both, and the
// other lockfile Checks (security.integrity, security.licenses,
// package.install-scripts and security.dependencies) build on the same
// parsed Lock.
package lockfile

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// SyntaxError says that a document is not what it should be: not valid JSON,
// or valid JSON of the wrong shape. Line and Column are 1-based and zero when
// the position is unknown.
type SyntaxError struct {
	Line, Column int
	Message      string
}

func (e *SyntaxError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("%d:%d: %s", e.Line, e.Column, e.Message)
	}
	return e.Message
}

// UnsupportedVersionError is returned for a readable lockfile whose
// lockfileVersion is not 2 or 3. The lockfile is not broken, but the
// lockfile-based Checks cannot use it.
type UnsupportedVersionError struct{ Version int }

func (e *UnsupportedVersionError) Error() string {
	if e.Version == 1 {
		return "lockfileVersion 1 (npm 6 and older) is not supported, only versions 2 and 3"
	}
	return fmt.Sprintf("lockfileVersion %d is not supported, only versions 2 and 3", e.Version)
}

// Lock is a parsed npm lockfile of version 2 or 3. Only the flat `packages`
// map is read: version 2 repeats it in the legacy `dependencies` tree.
type Lock struct {
	Version int
	// Packages maps a path such as "node_modules/a/node_modules/b" to its
	// entry. The root package has the key "".
	Packages map[string]Entry
}

// Entry is one lockfile entry.
type Entry struct {
	// Name is set when the entry's real package name differs from the folder
	// name in its key, as for an npm alias.
	Name             string `json:"name"`
	Version          string `json:"version"`
	Resolved         string `json:"resolved"`
	Integrity        string `json:"integrity"`
	Link             bool   `json:"link"`
	InBundle         bool   `json:"inBundle"`
	Dev              bool   `json:"dev"`
	Optional         bool   `json:"optional"`
	Peer             bool   `json:"peer"`
	HasInstallScript bool   `json:"hasInstallScript"`

	Dependencies         map[string]string `json:"dependencies"`
	DevDependencies      map[string]string `json:"devDependencies"`
	OptionalDependencies map[string]string `json:"optionalDependencies"`
	PeerDependencies     map[string]string `json:"peerDependencies"`

	// License is the raw `license` value. Use the License method for text.
	LicenseRaw json.RawMessage `json:"license"`
}

// License returns the license expression of the entry, or "" when it has none.
// Old packages record a license as an object or a list; those come back as the
// raw JSON text so nothing is lost.
func (e Entry) License() string {
	raw := bytes.TrimSpace(e.LicenseRaw)
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

// ParseLock reads an npm lockfile. It returns a *SyntaxError for a broken
// document and an *UnsupportedVersionError for any version other than 2 or 3.
func ParseLock(data []byte) (*Lock, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	var head struct {
		Version *int `json:"lockfileVersion"`
	}
	if err := decode(data, &head); err != nil {
		return nil, err
	}
	if head.Version == nil {
		return nil, &SyntaxError{Message: "the lockfile has no lockfileVersion"}
	}
	if *head.Version != 2 && *head.Version != 3 {
		return nil, &UnsupportedVersionError{Version: *head.Version}
	}
	var body struct {
		Packages map[string]Entry `json:"packages"`
	}
	if err := decode(data, &body); err != nil {
		return nil, err
	}
	if body.Packages == nil {
		// npm reads a lockfile without packages as an empty one. Whatever the
		// manifest declares is then reported as missing.
		body.Packages = map[string]Entry{}
	}
	return &Lock{Version: *head.Version, Packages: body.Packages}, nil
}

// decode unmarshals a JSON object into v and turns every failure into a
// *SyntaxError with a position.
func decode(data []byte, v any) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return &SyntaxError{Message: "the file is empty"}
	}
	if trimmed[0] != '{' {
		if trimmed[0] == '[' || bytes.Equal(trimmed, []byte("null")) {
			return &SyntaxError{Line: 1, Column: 1, Message: "the top level must be a JSON object"}
		}
	}
	err := json.Unmarshal(data, v)
	if err == nil {
		return nil
	}
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syn):
		line, col := position(data, syn.Offset)
		return &SyntaxError{Line: line, Column: col, Message: syn.Error()}
	case errors.As(err, &typ):
		line, col := position(data, typ.Offset)
		what := typ.Field
		if what == "" {
			what = "the top level"
		}
		return &SyntaxError{Line: line, Column: col, Message: fmt.Sprintf("%s must be a %s, found a %s", what, typ.Type, typ.Value)}
	}
	return &SyntaxError{Message: err.Error()}
}

// position turns a byte offset into a 1-based line and column. The decoder's
// offset points just after the offending byte, so the column of the byte
// itself is the offset's column minus one, but never before column 1.
func position(data []byte, offset int64) (line, col int) {
	if offset > int64(len(data)) {
		offset = int64(len(data))
	}
	line, col = 1, 1
	for i := int64(0); i < offset-1 && i < int64(len(data)); i++ {
		if data[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
}
