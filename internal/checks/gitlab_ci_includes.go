package checks

import (
	"errors"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file resolves the `include:` entries of a GitLab CI file. Only entries
// of type local are followed, recursively. The others need the network or
// GitLab's own files, so each is a Limitation.

const (
	ruleGitlabIncludeMissing = "gitlab-ci.include-missing"
	reasonIncludeNotResolved = "include_not_resolved"
	// maxCIFiles is GitLab's limit of includes in one pipeline, so a glob
	// cannot make the Check read without bound.
	maxCIFiles = 150
)

// ciFile is one resolved CI file.
type ciFile struct {
	path  string
	class discovery.FileClass
	doc   *ciDoc
}

// ciResolution is what reading the main file and its local includes found.
type ciResolution struct {
	files       []*ciFile // the main file first, then the includes in the order found
	findings    []resultset.Finding
	limitations []resultset.Limitation
	// unresolved says that some include was not resolved, so a job or stage
	// may live in a file the Check cannot see.
	unresolved bool
	tooLarge   []string
	unreadable []string
}

type ciResolver struct {
	in      *Input
	res     *ciResolution
	seen    map[string]bool
	classes map[string]discovery.FileClass
	paths   []string // every project file, for wildcards
}

func resolveCI(in *Input) *ciResolution {
	r := &ciResolver{
		in: in, res: &ciResolution{}, seen: map[string]bool{},
		classes: map[string]discovery.FileClass{},
	}
	for _, f := range in.Project.Files {
		r.classes[f.Path] = f.Class
		r.paths = append(r.paths, f.Path)
	}
	sort.Strings(r.paths)
	r.load(gitlabCIFile)
	return r.res
}

// load reads and parses one file, then follows its includes.
func (r *ciResolver) load(rel string) {
	if r.seen[rel] {
		return
	}
	r.seen[rel] = true
	data, err := readProjectFile(r.in, rel)
	switch {
	case errors.Is(err, errTooLarge):
		r.res.tooLarge = append(r.res.tooLarge, rel)
		return
	case err != nil:
		r.res.unreadable = append(r.res.unreadable, shownPath(rel)+": "+unreadableReason(err))
		return
	}
	class := r.classes[rel]
	doc, err := readCIDoc(data)
	if err != nil {
		inTestData := class == discovery.TestData
		msg := "The file is not valid YAML, so GitLab rejects the pipeline."
		if inTestData {
			msg = "The file is not valid YAML. Test data may be invalid on purpose, so this is only a note."
		}
		r.res.findings = append(r.res.findings, gitlabFinding(r.in, gitlabFindingSpec{
			rule: ruleGitlabYAML, path: rel, gate: !inTestData, inTestData: inTestData,
			title: "GitLab CI file does not parse", message: msg, evidence: err.Error(),
		}))
		return
	}
	file := &ciFile{path: rel, class: class, doc: doc}
	r.res.files = append(r.res.files, file)
	r.res.findings = append(r.res.findings, schemaFindings(r.in, rel, class, doc)...)
	r.followIncludes(file)
}

func unreadableReason(err error) string {
	switch {
	case errors.Is(err, errNotRegular):
		return "a symbolic link or special file, which the Check does not follow"
	case errors.Is(err, os.ErrNotExist):
		return "does not exist"
	}
	// The error names the file, which is the project's text.
	return "could not be read"
}

// ciInclude is one entry of an include list: the type of the entry and the
// values that name the file.
type ciInclude struct {
	kind   string // local, remote, project, template or component
	values []string
	// files are the files a project entry names, when it names one project.
	files   []string
	pointer string // JSON pointer of the entry, for its line
}

// shown is how a value of the entry stands in trusted text: each part only when
// it looks like an address or a path (see shownURL).
func (inc ciInclude) shown(value string) string {
	out := shownURL(value, "include")
	for _, f := range inc.files {
		out += " " + shownURL(f, "include file")
	}
	return out
}

var ciURL = regexp.MustCompile(`^https?://`)

// includesOf lists the entries of the file's top-level `include`. The value
// is a string, a map or a list of both.
func includesOf(doc *ciDoc) []ciInclude {
	top, ok := doc.value.(map[string]any)
	if !ok {
		return nil
	}
	inc, ok := top["include"]
	if !ok {
		return nil
	}
	if list, isList := inc.([]any); isList {
		var out []ciInclude
		for i, e := range list {
			out = append(out, includeEntry(e, fmt.Sprintf("/include/%d", i))...)
		}
		return out
	}
	return includeEntry(inc, "/include")
}

func includeEntry(e any, pointer string) []ciInclude {
	switch t := e.(type) {
	case string:
		if ciURL.MatchString(t) {
			return []ciInclude{{kind: "remote", values: []string{t}, pointer: pointer}}
		}
		return []ciInclude{{kind: "local", values: []string{t}, pointer: pointer}}
	case map[string]any:
		for _, kind := range []string{"local", "remote", "template", "component"} {
			if v, ok := t[kind]; ok {
				return []ciInclude{{kind: kind, values: stringsOf(v), pointer: pointer}}
			}
		}
		if v, ok := t["project"]; ok {
			values := stringsOf(v)
			inc := ciInclude{kind: "project", values: values, pointer: pointer}
			if len(values) == 1 {
				inc.files = stringsOf(t["file"])
			}
			return []ciInclude{inc}
		}
	}
	return nil
}

// stringsOf returns the strings of a string or of a list of strings.
func stringsOf(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case []any:
		var out []string
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func (r *ciResolver) followIncludes(from *ciFile) {
	for _, inc := range includesOf(from.doc) {
		pos := from.doc.position(inc.pointer)
		if inc.kind != "local" {
			for _, v := range inc.values {
				r.notResolved(from, fmt.Sprintf("include of type %s", inc.kind), inc.shown(v))
			}
			continue
		}
		for _, v := range inc.values {
			r.followLocal(from, pos, v)
		}
	}
}

// notResolved records that an include needs more than the project's own files.
// shown is the include as it may stand in a Limitation.
func (r *ciResolver) notResolved(from *ciFile, what, shown string) {
	r.res.unresolved = true
	r.res.limitations = append(r.res.limitations, resultset.Limitation{
		ReasonCode: reasonIncludeNotResolved,
		Message:    fmt.Sprintf("%s is not resolved, because that needs more than the project's own files: %s", what, shown),
		CheckID:    strPointer(gitlabCIID), Path: strPointer(from.path),
	})
}

// followLocal reads the file or the files a local include names.
func (r *ciResolver) followLocal(from *ciFile, pos ciPos, value string) {
	if strings.Contains(value, "$") {
		r.notResolved(from, "include of type local with a variable", shownGlob(value))
		return
	}
	var targets []string
	if strings.ContainsAny(value, "*?") {
		pattern := localCIPath(value)
		re := globRegexp(pattern)
		for _, p := range r.paths {
			if re.MatchString(p) && !inNodeModules(p) {
				targets = append(targets, p)
			}
		}
	} else {
		rel := localCIPath(value)
		if _, ok := r.classes[rel]; ok {
			targets = []string{rel}
		}
	}
	if len(targets) == 0 {
		r.res.findings = append(r.res.findings, gitlabFinding(r.in, gitlabFindingSpec{
			rule: ruleGitlabIncludeMissing, path: from.path, line: pos.line, column: pos.column,
			gate:  true,
			title: "Local include does not exist", key: value,
			message:  fmt.Sprintf("The local include %s matches no file of the project, so GitLab rejects the pipeline.", shownGlob(value)),
			evidence: value, evidenceSource: "include entry",
		}))
		return
	}
	for _, t := range targets {
		if len(r.seen) >= maxCIFiles {
			r.res.limitations = append(r.res.limitations, resultset.Limitation{
				ReasonCode: "includes_over_limit",
				Message:    fmt.Sprintf("%d files were read, which is GitLab's limit of includes; no more local includes were followed", maxCIFiles),
				CheckID:    strPointer(gitlabCIID), Path: strPointer(from.path),
			})
			return
		}
		r.load(t)
	}
}

// localCIPath turns the value of a local include into a project-relative path.
// A leading slash is the project root, and the path cannot leave the project.
func localCIPath(value string) string {
	return strings.TrimPrefix(path.Clean("/"+value), "/")
}

// globRegexp turns a path pattern into a regexp the way GitLab matches local
// includes: `*` matches within a folder, `**` any number of folders, and `?`
// one character.
func globRegexp(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch c := pattern[i]; {
		case c == '*' && i+1 < len(pattern) && pattern[i+1] == '*':
			i++
			if i+1 < len(pattern) && pattern[i+1] == '/' {
				i++
				b.WriteString("(?:.*/)?")
			} else {
				b.WriteString(".*")
			}
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}
