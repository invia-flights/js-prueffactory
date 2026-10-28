package engine

import (
	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// markTestCode is the one rule behind a Finding's in_test_code: it is true when
// the File class of the Finding's primary location is Test code, whatever Check
// produced it. The class is the one the file list holds once the files the
// probes found (loaded) have moved to Test code; a path in no file list is
// classified by its folder names. The rule only ever sets the flag, so a flag
// a Check set itself stays, and a Finding without a primary location keeps
// false. A Check that is a checks.TestCodeNoter gets its note appended to the
// message of each Finding the rule finds in Test code, since only here is the
// class known for every file.
func markTestCode(proj *discovery.Project, loaded []discovery.TestFile, findings []resultset.Finding) {
	view := proj.WithTestFiles(loaded)
	classes := make(map[string]discovery.FileClass, len(view.Files))
	for _, f := range view.Files {
		classes[f.Path] = f.Class
	}
	for i := range findings {
		path, ok := primaryPath(findings[i])
		if !ok {
			continue
		}
		class, known := classes[path]
		if !known {
			class = discovery.Classify(path)
		}
		if class != discovery.TestCode {
			continue
		}
		findings[i].InTestCode = true
		if noter, ok := checks.Implementation(findings[i].CheckID).(checks.TestCodeNoter); ok {
			if note := noter.TestCodeNote(findings[i]); note != "" {
				findings[i].Message += " " + note
			}
		}
	}
}

// primaryPath returns the path of the Finding's primary location.
func primaryPath(f resultset.Finding) (string, bool) {
	for _, l := range f.Locations {
		if l.Role == "primary" && l.Path != "" {
			return l.Path, true
		}
	}
	return "", false
}

// probedTestFiles gathers what the test file probes of all packages found. By
// the time the Report is assembled every probe has finished or never will.
func (r *run) probedTestFiles() []discovery.TestFile {
	var out []discovery.TestFile
	for _, c := range r.proj.Contexts {
		out = append(out, checks.ProbedTestFiles(r.shared, c.ID)...)
	}
	return out
}
