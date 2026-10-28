package checks

import (
	"encoding/json"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
)

// This file selects the files the repository.dockerfile, repository.shell and
// api.lint Checks examine. Selection works on the Snapshot's file list and on
// the first bytes of files, never on Docker or project code. Paths are literal
// project-relative paths and are never expanded as globs.

// maxOpenAPIBytes is the size above which a YAML or JSON file is not read to
// look for an `openapi` key.
const maxOpenAPIBytes = 16 << 20

// candidates returns the project files a repository Check may look at: not Test
// data and not below node_modules.
func candidates(p *discovery.Project) []discovery.File {
	var out []discovery.File
	for _, f := range p.Files {
		if f.Class == discovery.TestData || inNodeModules(f.Path) {
			continue
		}
		out = append(out, f)
	}
	return out
}

func inNodeModules(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == "node_modules" {
			return true
		}
	}
	return false
}

// openRegular opens a regular file of the Snapshot. A symbolic link or any
// other special file is skipped, so nothing outside the Snapshot is read.
func openRegular(root, rel string) (*os.File, bool) {
	full := filepath.Join(root, filepath.FromSlash(rel))
	if info, err := os.Lstat(full); err != nil || !info.Mode().IsRegular() {
		return nil, false
	}
	f, err := os.Open(full)
	if err != nil {
		return nil, false
	}
	return f, true
}

// dockerfileTargets returns `Dockerfile`, `Dockerfile.*` and `*.Dockerfile`
// files, in path order.
func dockerfileTargets(p *discovery.Project) []string {
	var out []string
	for _, f := range candidates(p) {
		base := path.Base(f.Path)
		if base == "Dockerfile" || strings.HasPrefix(base, "Dockerfile.") || strings.HasSuffix(base, ".Dockerfile") {
			out = append(out, f.Path)
		}
	}
	return out
}

// shellTarget is a shell script and the dialect ShellCheck reads it as.
type shellTarget struct {
	Path    string
	Dialect string
}

// shellDialects are the dialects ShellCheck accepts that a shebang can name.
var shellDialects = map[string]bool{"sh": true, "bash": true, "dash": true, "ksh": true}

// shellTargets returns `*.sh` and `*.bash` files and files with an sh or bash
// shebang. The dialect comes from the shebang, then from the extension.
func shellTargets(p *discovery.Project) []shellTarget {
	var out []shellTarget
	for _, f := range candidates(p) {
		fromShebang := shebangShell(p.Root, f.Path)
		var byExt string
		switch path.Ext(f.Path) {
		case ".sh":
			byExt = "sh"
		case ".bash":
			byExt = "bash"
		}
		selected := byExt != "" || fromShebang == "sh" || fromShebang == "bash"
		if !selected {
			continue
		}
		dialect := fromShebang
		if dialect == "" {
			dialect = byExt
		}
		out = append(out, shellTarget{Path: f.Path, Dialect: dialect})
	}
	return out
}

// shebangShell returns the shell a file's shebang names, or "".
func shebangShell(root, rel string) string {
	f, ok := openRegular(root, rel)
	if !ok {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 256)
	n, _ := io.ReadFull(f, buf)
	line := string(buf[:n])
	if !strings.HasPrefix(line, "#!") {
		return ""
	}
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	fields := strings.Fields(line[2:])
	if len(fields) == 0 {
		return ""
	}
	interpreter := path.Base(fields[0])
	if interpreter == "env" {
		interpreter = ""
		for _, a := range fields[1:] {
			if strings.HasPrefix(a, "-") || strings.Contains(a, "=") {
				continue
			}
			interpreter = path.Base(a)
			break
		}
	}
	if shellDialects[interpreter] {
		return interpreter
	}
	return ""
}

// openAPITarget is an OpenAPI or Swagger description file.
type openAPITarget struct {
	Path string
	// RemoteRef says the file has a `$ref` to an http or https URL, which
	// cannot be fetched during the Execution phase.
	RemoteRef bool
}

var (
	yamlOpenAPIKey = regexp.MustCompile(`(?m)^["']?(openapi|swagger)["']?[ \t]*:`)
	remoteRef      = regexp.MustCompile(`\$ref["']?\s*:\s*["']?https?://`)
)

// openAPITargets returns YAML and JSON files with a top-level `openapi` or
// `swagger` key.
func openAPITargets(p *discovery.Project) []openAPITarget {
	var out []openAPITarget
	for _, f := range candidates(p) {
		ext := path.Ext(f.Path)
		if ext != ".yaml" && ext != ".yml" && ext != ".json" {
			continue
		}
		file, ok := openRegular(p.Root, f.Path)
		if !ok {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, maxOpenAPIBytes+1))
		file.Close()
		if err != nil || len(data) > maxOpenAPIBytes {
			continue
		}
		if !isOpenAPI(ext, data) {
			continue
		}
		out = append(out, openAPITarget{Path: f.Path, RemoteRef: remoteRef.Match(data)})
	}
	return out
}

func isOpenAPI(ext string, data []byte) bool {
	if ext == ".json" {
		var top map[string]json.RawMessage
		if json.Unmarshal(data, &top) != nil {
			return false
		}
		_, a := top["openapi"]
		_, b := top["swagger"]
		return a || b
	}
	return yamlOpenAPIKey.Match(data)
}
