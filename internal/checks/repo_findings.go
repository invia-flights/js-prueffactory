package checks

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file turns the JSON output of hadolint, ShellCheck and Redocly CLI into
// Findings. Error-level results are Gates, warnings are warnings, and the rest
// (info and style results) are notes.

// snapshotMount is where the Snapshot volume is mounted in tool containers.
const snapshotMount = "/snapshot"

// projectPath turns a path a tool printed into a project-relative path.
func projectPath(p string) string {
	return strings.TrimPrefix(strings.TrimPrefix(p, snapshotMount), "/")
}

// toolProblem is one result of a tool, in the terms all three tools share.
type toolProblem struct {
	Tool    string // "hadolint", "shellcheck" or "redocly"
	Rule    string
	Level   string // "error", "warning", "info" or "style"
	Path    string // project-relative
	Line    int
	Column  int
	Message string
	Title   string
	// What the tool printed, as Evidence.
	Raw string
}

// repoFinding builds the Finding for one tool result.
func repoFinding(in *Input, checkID string, p toolProblem) resultset.Finding {
	f := resultset.Finding{
		CheckID: checkID, ContextID: in.Context.ID,
		RuleID:      &p.Rule,
		Fingerprint: resultset.NewFingerprint(checkID, p.Rule, p.Path, p.Message),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityNote,
		Confidence:   resultset.ConfidenceSuspected,
		Title:        cutTitle(p.Rule + ": " + p.Message),
		Message:      fmt.Sprintf("%s reports %s %s: %s", p.Tool, levelWord(p.Level), p.Rule, p.Message),
		Locations:    []resultset.Location{in.Location("primary", p.Path, p.Line, p.Column)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", p.Raw, p.Tool)},
		Reproduction: in.Reproduction(checkID),
		Limitations:  []string{},
	}
	switch p.Level {
	case "error":
		f.Severity, f.Confidence, f.Gate = resultset.SeverityError, resultset.ConfidenceConfirmed, true
	case "warning", "warn":
		f.Severity, f.Confidence = resultset.SeverityWarning, resultset.ConfidenceLikely
	default:
		f.Kind = resultset.KindHint
	}
	return f
}

func levelWord(level string) string {
	if level == "warn" {
		return "warning"
	}
	return level
}

func cutTitle(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	return shorten(s, 120)
}

func rawJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// hadolintFindings reads hadolint's `-f json` output, an array of results.
func hadolintFindings(in *Input, stdout []byte) ([]resultset.Finding, error) {
	var results []struct {
		Code    string `json:"code"`
		Column  int    `json:"column"`
		File    string `json:"file"`
		Level   string `json:"level"`
		Line    int    `json:"line"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(stdout, &results); err != nil {
		return nil, fmt.Errorf("hadolint printed no JSON: %w", err)
	}
	var out []resultset.Finding
	for _, r := range results {
		out = append(out, repoFinding(in, "repository.dockerfile", toolProblem{
			Tool: "hadolint", Rule: r.Code, Level: r.Level, Path: projectPath(r.File),
			Line: r.Line, Column: r.Column, Message: r.Message, Raw: rawJSON(r),
		}))
	}
	return out, nil
}

// shellcheckFindings reads ShellCheck's `-f json1` output.
func shellcheckFindings(in *Input, stdout []byte) ([]resultset.Finding, error) {
	var doc struct {
		Comments []struct {
			File    string `json:"file"`
			Line    int    `json:"line"`
			Column  int    `json:"column"`
			Level   string `json:"level"`
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return nil, fmt.Errorf("shellcheck printed no JSON: %w", err)
	}
	var out []resultset.Finding
	for _, c := range doc.Comments {
		out = append(out, repoFinding(in, "repository.shell", toolProblem{
			Tool: "shellcheck", Rule: fmt.Sprintf("SC%04d", c.Code), Level: c.Level, Path: projectPath(c.File),
			Line: c.Line, Column: c.Column, Message: c.Message, Raw: rawJSON(c),
		}))
	}
	return out, nil
}

// redoclyNoJSON is Redocly exiting without a JSON report, as it does when it
// cannot read or parse a file. Output is the first 200 bytes of what it printed.
type redoclyNoJSON struct{ Output string }

func (e *redoclyNoJSON) Error() string {
	if e.Output == "" {
		return "redocly printed no JSON and nothing else"
	}
	return "redocly printed no JSON, it said: " + e.Output
}

// outputHead returns the first 200 bytes of the first non-empty output.
func outputHead(outputs ...[]byte) string {
	for _, o := range outputs {
		if t := strings.TrimSpace(string(o)); t != "" {
			return cutBytes(t, 200)
		}
	}
	return ""
}

// unparseableFinding is the Gate for an OpenAPI file that is not valid YAML or
// JSON, reported when artifacts.structured is not there to report it.
func unparseableFinding(in *Input, target openAPITarget, perr *parseError, output string) resultset.Finding {
	return repoFinding(in, apiLintID, toolProblem{
		Tool: "redocly", Rule: ruleUnparseable, Level: "error", Path: target.Path,
		Line: perr.line, Column: perr.column,
		Message: "the file is not valid YAML or JSON, so it cannot be linted",
		Raw:     output,
	})
}

// redoclyFindings reads `redocly lint --format json` output for one file. For a
// file with a remote $ref it drops the failures to fetch that reference, since
// the Execution phase has no network: the caller records a Limitation instead.
func redoclyFindings(in *Input, target openAPITarget, stdout, stderr []byte) ([]resultset.Finding, error) {
	var doc struct {
		Problems []struct {
			RuleID   string `json:"ruleId"`
			Severity string `json:"severity"`
			Message  string `json:"message"`
			Location []struct {
				Start struct {
					Line int `json:"line"`
					Col  int `json:"col"`
				} `json:"start"`
			} `json:"location"`
		} `json:"problems"`
	}
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return nil, &redoclyNoJSON{Output: outputHead(stderr, stdout)}
	}
	var out []resultset.Finding
	for _, p := range doc.Problems {
		if target.RemoteRef && p.RuleID == "no-unresolved-refs" && strings.Contains(p.Message, "fetch failed") {
			continue
		}
		line, col := 0, 0
		if len(p.Location) > 0 {
			line, col = p.Location[0].Start.Line, p.Location[0].Start.Col
		}
		out = append(out, repoFinding(in, "api.lint", toolProblem{
			Tool: "redocly", Rule: p.RuleID, Level: p.Severity, Path: target.Path,
			Line: line, Column: col, Message: p.Message, Raw: rawJSON(p),
		}))
	}
	return out, nil
}
