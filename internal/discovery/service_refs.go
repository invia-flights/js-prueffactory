package discovery

import (
	"bytes"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// ServiceRef says that a package's test environment refers to a compose
// Service the Run does not start, so that tests which need it will fail for
// reasons outside the project.
type ServiceRef struct {
	// Service is the compose service name.
	Service string
	// File is the project path of the first file that refers to it, and Line
	// the 1-based line.
	File string
	Line int
}

// maxServiceRefFileBytes is the largest file the search reads.
const maxServiceRefFileBytes = 512 << 10

// readServiceRefs marks every package whose env files or Test code refer to a
// compose Service that is not started: a URL host (`://name:`, `://name/` or
// the name at the end of the URL) or, in an env file, an exact value. It reads
// files as text only. It is a heuristic: a name found in a comment or an
// unrelated string counts too, and a reference built in code is missed.
//
// Env files are `.env*` and `*.env` at any depth of the package outside
// node_modules, Test code folders included. Test code is searched for URL hosts
// only. The Services considered are the ones the Run does not start for a
// reason of the compose file; the project's own startable Services never are.
func readServiceRefs(root string, proj *Project) {
	var names []string
	for _, s := range proj.Services {
		if s.NotStarted != nil && s.NotStarted.Code != "invalid_service_name" {
			names = append(names, s.Name)
		}
	}
	if len(names) == 0 {
		return
	}
	sort.Strings(names)
	for _, pkg := range proj.Packages {
		pkg.ServiceRefs = serviceRefsOf(root, pkg, names)
	}
}

func serviceRefsOf(root string, pkg *Package, names []string) []ServiceRef {
	// Env files first, then Test code, each in path order, so that the file
	// named for a Service is the most telling one.
	var envFiles, testFiles []File
	for _, f := range pkg.Files {
		switch {
		case isEnvFile(f.Path):
			envFiles = append(envFiles, f)
		case f.Class == TestCode:
			testFiles = append(testFiles, f)
		}
	}
	var out []ServiceRef
	found := map[string]bool{}
	scan := func(files []File, env bool) {
		for _, f := range files {
			if len(found) == len(names) {
				return
			}
			data, ok := readSearchable(filepath.Join(root, filepath.FromSlash(f.Path)))
			if !ok {
				continue
			}
			for i, line := range strings.Split(string(data), "\n") {
				for _, name := range names {
					if !found[name] && lineRefersTo(line, name, env) {
						found[name] = true
						out = append(out, ServiceRef{Service: name, File: f.Path, Line: i + 1})
					}
				}
			}
		}
	}
	scan(envFiles, true)
	scan(testFiles, false)
	return out
}

// isEnvFile says whether a project path is an env file: `.env`, `.env.*` or
// `*.env`.
func isEnvFile(p string) bool {
	base := path.Base(p)
	return strings.HasPrefix(base, ".env") || strings.HasSuffix(base, ".env")
}

// readSearchable reads a regular text file of a sensible size.
func readSearchable(p string) ([]byte, bool) {
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxServiceRefFileBytes {
		return nil, false
	}
	data, err := os.ReadFile(p)
	if err != nil || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return nil, false
	}
	return data, true
}

// lineRefersTo says whether a line names the Service as a URL host, or, in an
// env file, as the whole value of a variable.
func lineRefersTo(line, name string, env bool) bool {
	if urlHost(name).MatchString(line) {
		return true
	}
	if !env {
		return false
	}
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return false
	}
	_, value, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(line, "export ")), "=")
	if !ok {
		return false
	}
	return dotEnvValue(strings.TrimSpace(value), nil) == name
}

// urlHost matches `://name` followed by the end of the host: a port, a path, a
// query, a fragment, a quote, white space or the end of the line. A longer name
// that starts the same way does not match.
func urlHost(name string) *regexp.Regexp {
	return regexp.MustCompile(`://` + regexp.QuoteMeta(name) + `(?:[:/?#'"` + "`" + `\s]|$)`)
}
