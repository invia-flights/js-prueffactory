package redact

import (
	"encoding/base64"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// NpmrcValues returns the secret values in the text of an .npmrc: the values of
// `_authToken`, `_auth` and `_password` entries. The latter two are base64, so
// their decoded text counts as well, and for `_auth` its password half, which is
// what shows up if a tool prints the credentials it decoded. A value that is
// only a reference to an environment variable, such as ${NPM_TOKEN}, is no
// secret and is left out.
func NpmrcValues(data []byte) []string {
	var out []string
	add := func(v string) {
		if v != "" {
			out = append(out, v)
		}
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if value == "" || strings.Contains(value, "${") {
			continue
		}
		switch {
		case strings.HasSuffix(key, "_authToken"):
			add(value)
		case strings.HasSuffix(key, "_password"):
			add(value)
			if dec, err := base64.StdEncoding.DecodeString(value); err == nil {
				add(string(dec))
			}
		case strings.HasSuffix(key, "_auth"):
			add(value)
			if dec, err := base64.StdEncoding.DecodeString(value); err == nil {
				add(string(dec))
				if _, pass, ok := strings.Cut(string(dec), ":"); ok {
					add(pass)
				}
			}
		}
	}
	return out
}

// SnapshotNpmrcValues collects the secret values of every .npmrc file in the
// host-side copy of the Snapshot, outside node_modules.
func SnapshotNpmrcValues(dir string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable corner must not stop the walk
		}
		if d.IsDir() {
			if d.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if d.Name() != ".npmrc" || !d.Type().IsRegular() {
			return nil
		}
		if data, err := os.ReadFile(p); err == nil {
			out = append(out, NpmrcValues(data)...)
		}
		return nil
	})
	return out
}
