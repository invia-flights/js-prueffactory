package discovery

import (
	"path"
	"sort"
	"strings"
)

// FileClass is the File class of a project file.
type FileClass string

const (
	Source      FileClass = "source"
	TestCode    FileClass = "test_code"
	TestData    FileClass = "test_data"
	BuildOutput FileClass = "build_output"
)

var (
	testDataFolders    = map[string]bool{"fixtures": true, "__fixtures__": true, "testdata": true, "__mocks__": true}
	buildOutputFolders = map[string]bool{"dist": true, "build": true, "coverage": true}
	testCodeFolders    = map[string]bool{"test": true, "tests": true, "__tests__": true, "spec": true}
)

// Classify returns the File class of a path relative to the project root
// (with "/" separators). Test data wins over Test code, and Build output wins
// over Test code. Only folder names and the `.min.js` suffix decide here; the
// files a discovered test runner loads become Test code when runner discovery
// lands.
func Classify(rel string) FileClass {
	dir, base := path.Split(rel)
	var data, build, test bool
	for _, part := range strings.Split(strings.Trim(dir, "/"), "/") {
		data = data || testDataFolders[part]
		build = build || buildOutputFolders[part]
		test = test || testCodeFolders[part]
	}
	switch {
	case data:
		return TestData
	case build || strings.HasSuffix(base, ".min.js"):
		return BuildOutput
	case test:
		return TestCode
	default:
		return Source
	}
}

// FolderNames returns the folder names that put a file into a File class,
// sorted. Source code has none.
func FolderNames(class FileClass) []string {
	var set map[string]bool
	switch class {
	case TestData:
		set = testDataFolders
	case BuildOutput:
		set = buildOutputFolders
	case TestCode:
		set = testCodeFolders
	}
	names := make([]string, 0, len(set))
	for n := range set {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
