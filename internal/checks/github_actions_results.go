package checks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file turns the JSON output of actionlint and zizmor into Findings.
//
// Everything a workflow says, such as job names, expressions, action names and
// the messages and snippets built from them, stays in untrusted Evidence. The
// title and the message use the tool's own vocabulary (rule kinds, audit names,
// severities) only when it looks like that vocabulary, and paths only when
// they look like paths.

const (
	githubActionsID = "repository.github-actions"

	// actionlintShellcheck and actionlintPyflakes are the kinds of the problems
	// that actionlint's embedded ShellCheck and pyflakes report in `run:`
	// scripts. They are warnings, every other actionlint kind is a Gate.
	actionlintShellcheck = "shellcheck"
	actionlintPyflakes   = "pyflakes"
)

// ghaWord is what an actionlint kind or a zizmor audit name looks like.
var ghaWord = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

// ghaDescription is what zizmor's one-line audit description looks like.
var ghaDescription = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9 ,.()'/-]{0,99}$`)

func ghaVocabulary(s string) string {
	if ghaWord.MatchString(s) {
		return s
	}
	return "unknown"
}

// ghaPath turns a path a tool printed into a project-relative path. actionlint
// drops the leading slash of the path it was given, zizmor keeps it.
func ghaPath(p string) string {
	p = strings.TrimPrefix(p, "/")
	return strings.TrimPrefix(p, strings.TrimPrefix(snapshotMount, "/")+"/")
}

// actionlintFindings reads actionlint's `-format '{{json .}}'` output, an
// array of errors, or nothing at all for clean workflows. Problems that its
// embedded ShellCheck and pyflakes found are warnings, every other error is a
// Gate.
func actionlintFindings(in *Input, stdout []byte) ([]resultset.Finding, error) {
	if len(bytes.TrimSpace(stdout)) == 0 {
		return nil, nil
	}
	var results []struct {
		Message string `json:"message"`
		Path    string `json:"filepath"`
		Line    int    `json:"line"`
		Column  int    `json:"column"`
		Kind    string `json:"kind"`
		Snippet string `json:"snippet"`
	}
	if err := json.Unmarshal(stdout, &results); err != nil {
		return nil, fmt.Errorf("actionlint printed no JSON: %w", err)
	}
	var out []resultset.Finding
	for _, r := range results {
		kind, path := ghaVocabulary(r.Kind), ghaPath(r.Path)
		rule := "actionlint." + kind
		gate := kind != actionlintShellcheck && kind != actionlintPyflakes
		f := resultset.Finding{
			CheckID: githubActionsID, ContextID: in.Context.ID,
			RuleID:      &rule,
			Fingerprint: resultset.NewFingerprint(githubActionsID, rule, path, r.Message),
			Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning,
			Confidence:   resultset.ConfidenceLikely,
			Title:        cutTitle(fmt.Sprintf("actionlint %s problem in %s", kind, shownPath(path))),
			Locations:    []resultset.Location{in.Location("primary", path, r.Line, r.Column)},
			Evidence:     []resultset.Evidence{Untrusted("tool_output", rawJSON(r), "actionlint")},
			Reproduction: in.Reproduction(githubActionsID),
			Limitations:  []string{},
		}
		if gate {
			f.Severity, f.Confidence, f.Gate = resultset.SeverityError, resultset.ConfidenceConfirmed, true
			f.Message = fmt.Sprintf("actionlint reports a %s problem in %s, line %d: the workflow is broken or would not do what it says. What it said is in the Evidence.", kind, shownPath(path), r.Line)
		} else {
			f.Message = fmt.Sprintf("The %s that actionlint runs on the scripts of %s reports an issue at line %d. What it said is in the Evidence.", kind, shownPath(path), r.Line)
		}
		out = append(out, f)
	}
	return out, nil
}

// zizmorSeverity maps zizmor's severity to the Finding's: Medium and High are
// warnings, Low and Informational are notes. No zizmor Finding is a Gate.
func zizmorSeverity(s string) (resultset.Severity, resultset.FindingKind) {
	switch s {
	case "High", "Medium":
		return resultset.SeverityWarning, resultset.KindDefect
	}
	return resultset.SeverityNote, resultset.KindHint
}

// ghaLevel is zizmor's severity or confidence word when it is one of its four.
func ghaLevel(s string) string {
	switch s {
	case "High", "Medium", "Low", "Informational":
		return s
	}
	return "unknown"
}

// zizmorLocation is one location of a zizmor result.
type zizmorLocation struct {
	Symbolic struct {
		Key struct {
			Local *struct {
				Path string `json:"verbatim_path"`
			} `json:"Local"`
		} `json:"key"`
		Annotation string `json:"annotation"`
		Kind       string `json:"kind"`
	} `json:"symbolic"`
	Concrete struct {
		Location struct {
			Start struct {
				Row    int `json:"row"`
				Column int `json:"column"`
			} `json:"start_point"`
		} `json:"location"`
		Feature string `json:"feature"`
	} `json:"concrete"`
}

// maxFeatureBytes bounds the workflow text one location adds to the Evidence.
const maxFeatureBytes = 500

// zizmorFindings reads `zizmor --format json` output, an array of results. A
// result that an inline `zizmor: ignore` comment silenced is left out. Rows and
// columns count from 0 in zizmor's output.
func zizmorFindings(in *Input, stdout []byte) ([]resultset.Finding, error) {
	var results []struct {
		Ident          string `json:"ident"`
		Desc           string `json:"desc"`
		Determinations struct {
			Confidence string `json:"confidence"`
			Severity   string `json:"severity"`
		} `json:"determinations"`
		Locations []zizmorLocation `json:"locations"`
		Ignored   bool             `json:"ignored"`
	}
	if err := json.Unmarshal(stdout, &results); err != nil {
		return nil, fmt.Errorf("zizmor printed no JSON: %w", err)
	}
	var out []resultset.Finding
	for _, r := range results {
		if r.Ignored {
			continue
		}
		audit := ghaVocabulary(r.Ident)
		rule := "zizmor." + audit
		path, line, column, feature := "", 0, 0, ""
		if primary := primaryZizmorLocation(r.Locations); primary != nil {
			if local := primary.Symbolic.Key.Local; local != nil {
				path = ghaPath(local.Path)
			}
			line, column = primary.Concrete.Location.Start.Row+1, primary.Concrete.Location.Start.Column+1
			feature = primary.Concrete.Feature
		}
		severity, kind := zizmorSeverity(r.Determinations.Severity)
		what := audit
		if ghaDescription.MatchString(r.Desc) {
			what += " (" + r.Desc + ")"
		}
		out = append(out, resultset.Finding{
			CheckID: githubActionsID, ContextID: in.Context.ID,
			RuleID:      &rule,
			Fingerprint: resultset.NewFingerprint(githubActionsID, rule, path, feature),
			Kind:        kind, Severity: severity, Confidence: resultset.ConfidenceLikely,
			Title: cutTitle(fmt.Sprintf("zizmor %s in %s", audit, shownPath(path))),
			Message: fmt.Sprintf("zizmor reports %s in %s, line %d, with severity %s and confidence %s. What it said is in the Evidence.",
				what, shownPath(path), line, ghaLevel(r.Determinations.Severity), ghaLevel(r.Determinations.Confidence)),
			Locations:    []resultset.Location{in.Location("primary", path, line, column)},
			Evidence:     []resultset.Evidence{Untrusted("tool_output", zizmorEvidence(r.Ident, r.Desc, r.Locations), "zizmor")},
			Reproduction: in.Reproduction(githubActionsID),
			Limitations:  []string{},
		})
	}
	return out, nil
}

// primaryZizmorLocation is the location zizmor marks as the primary one, or
// the first when it marks none.
func primaryZizmorLocation(locations []zizmorLocation) *zizmorLocation {
	for i := range locations {
		if locations[i].Symbolic.Kind == "Primary" {
			return &locations[i]
		}
	}
	if len(locations) > 0 {
		return &locations[0]
	}
	return nil
}

// zizmorEvidence is what zizmor said about one result, in plain text: the
// audit, its description, and for every location the note and the workflow
// text it points at.
func zizmorEvidence(ident, desc string, locations []zizmorLocation) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", ident, desc)
	for _, l := range locations {
		feature := strings.TrimSpace(l.Concrete.Feature)
		feature = shorten(feature, maxFeatureBytes)
		fmt.Fprintf(&b, "\n%s (line %d): %s\n%s", l.Symbolic.Kind, l.Concrete.Location.Start.Row+1, l.Symbolic.Annotation, feature)
	}
	return b.String()
}
