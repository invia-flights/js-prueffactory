package checks

import (
	"path"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// This file finds the `include:` entries of a compose set that name a remote
// source. Compose would have to fetch those, and the Execution phase has no
// network.

const (
	// maxComposeIncludeFiles bounds the files read while following local
	// includes of one set.
	maxComposeIncludeFiles = 50
	// maxComposeIncludeDepth bounds how deep local includes are followed.
	maxComposeIncludeDepth = 8
)

// composeRemote is a remote include entry and the file that holds it.
type composeRemote struct {
	File  string
	Value string
}

var (
	// composeRemotePrefix matches a URL with a scheme (http, https, git, oci)
	// and the scp-style git address.
	composeRemotePrefix = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.-]*://|git@)`)
	// composeGitHost matches `github.com/org/repo.git` without a scheme.
	composeGitHost = regexp.MustCompile(`^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/\S*\.git([?#@]\S*)?$`)
)

func isRemoteInclude(value string) bool {
	return composeRemotePrefix.MatchString(value) || composeGitHost.MatchString(value)
}

// composeRemoteIncludes returns the remote includes of the files of a set and
// of the local files they include, recursively and within the project.
func composeRemoteIncludes(in *Input, set composeSet) []composeRemote {
	var out []composeRemote
	seen := map[string]bool{}
	var walk func(file string, depth int)
	walk = func(file string, depth int) {
		if seen[file] || len(seen) >= maxComposeIncludeFiles {
			return
		}
		seen[file] = true
		data, err := readProjectFile(in, file)
		if err != nil {
			return
		}
		var doc struct {
			Include any `yaml:"include"`
		}
		if yaml.Unmarshal(data, &doc) != nil {
			return
		}
		for _, value := range composeIncludePaths(doc.Include) {
			switch {
			case isRemoteInclude(value):
				out = append(out, composeRemote{File: file, Value: value})
			case depth < maxComposeIncludeDepth:
				local := path.Join(path.Dir(file), value)
				if local != ".." && !strings.HasPrefix(local, "../") && !path.IsAbs(value) {
					walk(local, depth+1)
				}
			}
		}
	}
	for _, f := range set.Files {
		walk(f, 0)
	}
	return out
}

// composeIncludePaths lists the paths and URLs of an `include` section: a
// string, or a list of strings and of maps with a `path` that is a string or a
// list of strings.
func composeIncludePaths(section any) []string {
	switch s := section.(type) {
	case string:
		return []string{s}
	case []any:
		var out []string
		for _, e := range s {
			out = append(out, composeIncludePaths(e)...)
		}
		return out
	case map[string]any:
		return composeIncludePaths(s["path"])
	}
	return nil
}
