package checks

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file turns the output of the project's own linters into Findings. An
// error-level diagnostic is a Gate and a warning is a warning. repoFinding
// applies that rule to the level it is given.

// --- ESLint ---

// projectESLintFindings reads the stdout of `eslint --format json`, a list of
// files with their messages. Messages the project's own directives suppressed
// are listed apart by ESLint and are no findings. Files outside the package, such
// as a config the project extends from a parent folder, cannot be placed in the
// project and are left out.
func projectESLintFindings(in *Input, stdout []byte) ([]resultset.Finding, error) {
	var files []struct {
		FilePath string `json:"filePath"`
		Messages []struct {
			RuleID   *string `json:"ruleId"`
			Severity int     `json:"severity"`
			Message  string  `json:"message"`
			Line     int     `json:"line"`
			Column   int     `json:"column"`
			Fatal    bool    `json:"fatal"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(stdout, &files); err != nil {
		return nil, fmt.Errorf("ESLint printed no JSON report: %w", err)
	}
	prefix := workPath(in.Context.Package) + "/"
	var out []resultset.Finding
	for _, f := range files {
		rel, ok := strings.CutPrefix(f.FilePath, prefix)
		if !ok {
			continue
		}
		for _, m := range f.Messages {
			rule := "eslint-directive"
			switch {
			case m.RuleID != nil && *m.RuleID != "":
				rule = *m.RuleID
			case m.Fatal:
				rule = "parse-error"
			}
			level := "warning"
			if m.Severity >= 2 {
				level = "error"
			}
			out = append(out, repoFinding(in, lintExistingID, toolProblem{
				Tool: "eslint", Rule: rule, Level: level, Path: in.projectFile(rel),
				Line: m.Line, Column: m.Column, Message: m.Message,
				Raw: rawJSON(map[string]any{"rule": rule, "severity": m.Severity, "message": m.Message, "file": rel, "line": m.Line, "column": m.Column}),
			}))
		}
	}
	return out, nil
}

// --- Biome ---

// biomeDiagnostic is what is read of one diagnostic of Biome's JSON reporter.
// The reporter also prints advices and the whole source of each file for every
// diagnostic; none of that is kept.
type biomeDiagnostic struct {
	Category    string `json:"category"`
	Severity    string `json:"severity"`
	Description string `json:"description"`
	Location    *struct {
		Path struct {
			File string `json:"file"`
		} `json:"path"`
		Span       []int  `json:"span"`
		SourceCode string `json:"sourceCode"`
	} `json:"location"`
}

// biomeFindings reads the stdout of `biome lint --reporter=json`. Output that is
// not Biome's JSON is an error: it says nothing about the code.
func biomeFindings(in *Input, stdout []byte) ([]resultset.Finding, error) {
	var doc struct {
		Diagnostics []biomeDiagnostic `json:"diagnostics"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return nil, fmt.Errorf("Biome printed no JSON report: %w", err)
	}
	var out []resultset.Finding
	for _, d := range doc.Diagnostics {
		p := toolProblem{
			Tool: "biome", Rule: d.Category, Level: biomeLevel(d.Severity), Message: d.Description,
			Path: in.projectFile("package.json"),
		}
		raw := map[string]any{"category": d.Category, "severity": d.Severity, "description": d.Description}
		if l := d.Location; l != nil && l.Path.File != "" {
			p.Path = in.projectFile(l.Path.File)
			raw["file"] = l.Path.File
			if len(l.Span) == 2 {
				p.Line, p.Column = biomeLineAndColumn(l.SourceCode, l.Span[0])
				raw["span"] = l.Span
			}
		}
		if p.Rule == "" {
			p.Rule = "biome-diagnostic"
		}
		p.Raw = rawJSON(raw)
		out = append(out, repoFinding(in, lintExistingID, p))
	}
	return out, nil
}

// biomeLevel maps Biome's severities onto the levels repoFinding knows.
func biomeLevel(severity string) string {
	switch severity {
	case "fatal", "error":
		return "error"
	case "warning":
		return "warning"
	}
	return "info"
}

// biomeLineAndColumn turns a byte offset into a 1-based line and a 1-based column
// counted in characters. An offset outside the text gives no position.
func biomeLineAndColumn(src string, offset int) (line, column int) {
	if offset < 0 || offset > len(src) {
		return 0, 0
	}
	before := src[:offset]
	line = 1 + strings.Count(before, "\n")
	column = 1 + utf8.RuneCountInString(before[strings.LastIndexByte(before, '\n')+1:])
	return line, column
}

// projectFile is a path relative to the folder of the package as a path
// relative to the project root. The paths come from a linter that ran project
// code, so the result is confined to the project root, whatever they hold.
func (in *Input) projectFile(rel string) string {
	return strings.TrimPrefix(path.Join("/", in.Context.Package.Path, rel), "/")
}
