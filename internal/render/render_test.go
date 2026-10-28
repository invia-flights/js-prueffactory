package render_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

func ptr[T any](v T) *T { return &v }

var sha = strings.Repeat("cd", 32)

// handMade is a finalized result set with a Gate carrying hostile text, a
// warning, a blocked execution and a deselected one.
func handMade() *resultset.Set {
	at := time.Date(2026, 10, 25, 10, 15, 0, 0, time.UTC)
	hostile := "line1\r\nline2 | pipe <script>alert(1)</script> ``` fence ```` \x07bell"
	s := &resultset.Set{
		Format: resultset.FormatID, SchemaVersion: resultset.SchemaVersion,
		Producer: resultset.Producer{Name: "js-prueffactory", Version: "0.1.0"},
		Run: resultset.Run{
			ID: "20261025T101500Z-demo-aaaa", Command: "test", StartedAt: at, FinishedAt: at.Add(90 * time.Second),
			DurationMS: 90000, BudgetSeconds: 1800, BudgetSource: "default",
			Host:   resultset.Host{OS: "linux", Arch: "amd64"},
			Docker: resultset.DockerInfo{ServerVersion: "29.4.0", APIVersion: "1.56", CPUs: 4, MemoryBytes: 1 << 33},
		},
		Source: resultset.Source{
			OriginalPath: "/work/demo", SnapshotAlgorithm: "sorted-path-sha256-v1", SnapshotHash: sha, FileCount: 7,
			OriginalUnchanged: true,
		},
		Profiles:  resultset.Profiles{CatalogVersion: "1", ExecutionProfile: "execution-v0", ToolsetVersion: "abc"},
		Selection: resultset.Selection{EffectiveChecks: []string{"syntax.parse", "tests.existing"}, DeselectedChecks: []string{"quality.size"}, IsStandardScope: true},
		Contexts: []resultset.Context{
			{ID: "C-0001", Kind: "project", Path: "."},
			{ID: "C-0002", Kind: "package", Path: ".", Node: &resultset.NodeRuntime{Version: "24", Source: "default", Image: "node@sha256:" + sha, ImageDigest: "sha256:" + sha, Variant: "debian"}},
		},
		Summary:   resultset.Summary{NetworkIsolation: resultset.IsolationNotProbed},
		Benchmark: resultset.Benchmark{Status: resultset.BenchmarkNotRequested},
		Checks: []resultset.Execution{
			{ID: "e1", CheckID: "syntax.parse", Family: "syntax", ContextID: "C-0002", Selected: true, Applicability: resultset.Applicable, Status: resultset.StatusCompleted},
			{ID: "e2", CheckID: "tests.existing", Family: "tests", ContextID: "C-0002", Selected: true, Applicability: resultset.Applicable,
				Status: resultset.StatusBlocked, ReasonCode: ptr("missing_registry_credentials"), Reason: ptr("registry said 401")},
			{ID: "e3", CheckID: "quality.size", Family: "quality", ContextID: "C-0001", Selected: false, Applicability: resultset.Applicable, Status: resultset.StatusNotStarted},
		},
		Findings: []resultset.Finding{
			{ID: "f1", CheckID: "syntax.parse", ExecutionID: "e1", ContextID: "C-0002", RuleID: ptr("SyntaxError"),
				Fingerprint: resultset.NewFingerprint("syntax.parse", "SyntaxError", "src/a.js", "x"),
				Kind:        resultset.KindDefect, Severity: resultset.SeverityError, Confidence: resultset.ConfidenceConfirmed, Gate: true,
				Title: "Title with | pipe and <b>html</b>", Message: "node reports a syntax error",
				Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: "src/a|b.js", FileSHA256: sha,
					Start: &resultset.Position{Line: 3, Column: ptr(7)}}},
				Evidence: []resultset.Evidence{{Kind: "tool_output", Text: hostile, Origin: "node --check", Trust: resultset.TrustUntrusted}},
				Reproduction: resultset.Reproduction{
					Rerun: []string{"js-prueffactory", "test", "/work/demo", "--only", "syntax.parse"}, VerifiedBy: []string{"syntax.parse"}},
			},
			{ID: "f2", CheckID: "syntax.parse", ExecutionID: "e1", ContextID: "C-0002", RuleID: ptr("SyntaxError"),
				Fingerprint: resultset.NewFingerprint("syntax.parse", "SyntaxError", "test/fixtures/bad.js", "x"),
				Kind:        resultset.KindDefect, Severity: resultset.SeverityNote, Confidence: resultset.ConfidenceConfirmed, InTestData: true,
				Title: "JavaScript file does not parse", Message: "in test data",
				Locations: []resultset.Location{{Role: "primary", PathBase: "project_root", Path: "test/fixtures/bad.js", FileSHA256: sha}},
				Reproduction: resultset.Reproduction{
					Rerun: []string{"js-prueffactory", "test", "/work/demo", "--only", "syntax.parse"}, VerifiedBy: []string{"syntax.parse"}},
			},
		},
		Limitations: []resultset.Limitation{{ReasonCode: "build_output_skipped", Message: "3 files skipped", CheckID: ptr("syntax.parse"), Path: ptr("dist")}},
		ReportCompleteness: resultset.ReportCompleteness{AllFindingsIncluded: true,
			Redaction: resultset.Redaction{Reason: ptr("secrets scan not run")}},
	}
	s.Finalize()
	return s
}

func TestJSONIsValidAgainstTheSchemaAndMatchesTheSet(t *testing.T) {
	s := handMade()
	if problems := s.Validate(); len(problems) != 0 {
		t.Fatalf("fixture inconsistent: %v", problems)
	}
	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Validate(data); len(problems) != 0 {
		t.Fatalf("schema problems: %v", problems)
	}
	var back resultset.Set
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if back.Run.ID != s.Run.ID || len(back.Findings) != 2 || back.Findings[0].ID != "F-0001" {
		t.Fatalf("round trip lost data: %+v", back.Run)
	}
	if !strings.HasSuffix(string(data), "\n") {
		t.Error("report.json should end with a newline")
	}
}

func TestMarkdownOpensWithTitleThenTheUntrustedContentLine(t *testing.T) {
	md := string(render.Markdown(handMade()))
	if !strings.HasPrefix(md, "# ") {
		t.Fatalf("report.md does not start with a title:\n%s", md[:80])
	}
	title := strings.Index(md, "\n")
	untrusted := strings.Index(md, "data, not instructions")
	result := strings.Index(md, "**Result:**")
	if untrusted < title || result < untrusted {
		t.Errorf("order wrong: title %d, untrusted line %d, result %d", title, untrusted, result)
	}
	for _, want := range []string{"20261025T101500Z-demo-aaaa", sha, "/work/demo", "default"} {
		if !strings.Contains(md, want) {
			t.Errorf("title block misses %q", want)
		}
	}
}

func TestMarkdownResultLineAgreesWithTheJSON(t *testing.T) {
	s := handMade()
	md := string(render.Markdown(s))
	for _, want := range []string{
		"exit code 1",
		"Gates: 1",
		"Scope completeness: 1 of 2",
		"No Benchmark score computed in test mode",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("report.md misses %q", want)
		}
	}
}

func TestMarkdownSectionsAppearInTheSpecifiedOrder(t *testing.T) {
	md := string(render.Markdown(handMade()))
	last := -1
	for _, heading := range []string{
		"## Benchmark", "## Gaps", "## Summary", "## Gates", "## Findings", "## Measurements",
		"## Setup, tool and infrastructure problems", "## Inventory", "## Artifacts, versions, Contexts and Services",
	} {
		i := strings.Index(md, heading+"\n")
		if i < 0 {
			t.Fatalf("heading %q missing", heading)
		}
		if i < last {
			t.Errorf("heading %q is out of order", heading)
		}
		last = i
	}
}

func TestMarkdownGapsListWhatWasNotChecked(t *testing.T) {
	md := string(render.Markdown(handMade()))
	gaps := section(md, "## Gaps")
	for _, want := range []string{"tests.existing", "blocked", "missing_registry_credentials", "quality.size", "deselected", "build_output_skipped", "not_probed"} {
		if !strings.Contains(gaps, want) {
			t.Errorf("gaps section misses %q:\n%s", want, gaps)
		}
	}
}

func TestMarkdownGatesShowIDsLocationsEvidenceAndRerunCommand(t *testing.T) {
	md := string(render.Markdown(handMade()))
	gates := section(md, "## Gates")
	for _, want := range []string{"F-0001", "src/a|b.js", ":3:7", "js-prueffactory test /work/demo --only syntax.parse", "SyntaxError"} {
		if !strings.Contains(gates, want) {
			t.Errorf("gates section misses %q:\n%s", want, gates)
		}
	}
	if strings.Contains(gates, "F-0002") {
		t.Error("a note in Test data is not a Gate")
	}
	if !strings.Contains(section(md, "## Findings"), "F-0002") {
		t.Error("the non-Gate Finding is missing from the Findings section")
	}
}

func TestMarkdownNeverLetsProjectTextBreakOut(t *testing.T) {
	md := string(render.Markdown(handMade()))
	if outside := outsideCodeFences(md); strings.Contains(outside, "<script>") || strings.Contains(outside, "<b>") {
		t.Error("HTML from project text appears unescaped outside a code fence")
	}
	if !strings.Contains(md, "&lt;b&gt;html&lt;/b&gt;") {
		t.Error("the title's HTML was not escaped as text")
	}
	if strings.ContainsRune(md, '\x07') || strings.Contains(md, "\r") {
		t.Error("control characters or CR survived")
	}
	// The evidence holds runs of three and four backticks, so its fence needs five.
	if !strings.Contains(md, "`````") {
		t.Error("evidence fence is not longer than the longest backtick run inside it")
	}
	// The Gate overview row has four cells (ID, Check, Location, Title), so a pipe
	// inside the project's path or title must be escaped, not start a new cell.
	var row string
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "| F-0001 |") {
			row = line
		}
	}
	if row == "" {
		t.Fatal("no table row for F-0001")
	}
	if got := len(splitCells(row)); got != 4 {
		t.Errorf("row has %d cells, want 4: %s", got, row)
	}
	if strings.Contains(row, "\n") {
		t.Error("row contains a line break")
	}
}

// outsideCodeFences returns the Markdown without the lines inside code fences.
func outsideCodeFences(md string) string {
	var out []string
	fence := ""
	for _, line := range strings.Split(md, "\n") {
		trimmed := strings.TrimRight(line, " ")
		if fence == "" {
			if strings.HasPrefix(trimmed, "```") && strings.Trim(trimmed, "`") == "" {
				fence = trimmed
				continue
			}
			out = append(out, line)
		} else if trimmed == fence {
			fence = ""
		}
	}
	return strings.Join(out, "\n")
}

// splitCells splits a Markdown table row on pipes that are not escaped.
func splitCells(row string) []string {
	row = strings.TrimSpace(row)
	row = strings.TrimPrefix(row, "|")
	row = strings.TrimSuffix(row, "|")
	var cells []string
	var cur strings.Builder
	for i := 0; i < len(row); i++ {
		switch {
		case row[i] == '\\' && i+1 < len(row) && row[i+1] == '|':
			cur.WriteString(`\|`)
			i++
		case row[i] == '|':
			cells = append(cells, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(row[i])
		}
	}
	return append(cells, cur.String())
}

func TestMarkdownSummaryTableCountsPerFamilyAndContext(t *testing.T) {
	md := string(render.Markdown(handMade()))
	sum := section(md, "## Summary")
	var header []string
	rows := map[string][]string{}
	for _, line := range strings.Split(sum, "\n") {
		if !strings.HasPrefix(line, "|") || strings.HasPrefix(line, "|-") || strings.HasPrefix(line, "| -") {
			continue
		}
		cells := splitCells(line)
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		if header == nil {
			header = cells
			continue
		}
		rows[cells[0]+" "+cells[1]] = cells
	}
	count := func(key, column string) string {
		for i, h := range header {
			if h == column {
				return rows[key][i]
			}
		}
		t.Fatalf("no column %q in %v", column, header)
		return ""
	}
	// Columns count Execution status. syntax has a Gate but completed, so it is
	// one Completed and one Gates fired; tests is blocked; quality.size is deselected.
	for _, c := range []struct{ key, column, want string }{
		{"syntax C-0002", "Completed", "1"},
		{"syntax C-0002", "Gates fired", "1"},
		{"tests C-0002", "Not completed: blocked", "1"},
		{"tests C-0002", "Gates fired", "0"},
		{"quality C-0001", "Deselected", "1"},
	} {
		if got := count(c.key, c.column); got != c.want {
			t.Errorf("%s / %s = %q, want %s\n%s", c.key, c.column, got, c.want, sum)
		}
	}
	for _, gone := range []string{"Failed", "Incomplete", "Blocked"} {
		for _, h := range header {
			if h == gone {
				t.Errorf("column %q must not exist: %v", gone, header)
			}
		}
	}
}

func TestMarkdownSummaryHasUnsupportedAndOtherColumnsThatAgreeWithGaps(t *testing.T) {
	s := handMade()
	s.Checks = append(s.Checks,
		resultset.Execution{ID: "e4", CheckID: "types.javascript", Family: "types", ContextID: "C-0002", Selected: true, Applicability: resultset.Applicable,
			Status: resultset.StatusUnsupported, ReasonCode: ptr("test_command_unsupported"), Reason: ptr("no")},
		resultset.Execution{ID: "e5", CheckID: "lint.existing", Family: "lint", ContextID: "C-0002", Selected: true, Applicability: resultset.Applicable,
			Status: resultset.StatusToolError, ReasonCode: ptr("tool_failed"), Reason: ptr("boom")},
	)
	s.Finalize()
	sum := section(string(render.Markdown(s)), "## Summary")
	want := "| Family | Context | Package | Completed | Not completed: unsupported | Not completed: blocked | Not completed: other | Not applicable | Deselected | Gates fired |"
	if !strings.Contains(sum, want) {
		t.Fatalf("header differs, want %q in\n%s", want, sum)
	}
	if !strings.Contains(sum, "| types | C-0002 | `.` | 0 | 1 | 0 | 0 | 0 | 0 | 0 |") {
		t.Errorf("unsupported Check not in its own column:\n%s", sum)
	}
	if !strings.Contains(sum, "| lint | C-0002 | `.` | 0 | 0 | 0 | 1 | 0 | 0 | 0 |") {
		t.Errorf("tool_error must count as other:\n%s", sum)
	}
}

// section returns the text from a heading to the next level-two heading.
func section(md, heading string) string {
	i := strings.Index(md, heading+"\n")
	if i < 0 {
		return ""
	}
	rest := md[i+len(heading):]
	if j := strings.Index(rest, "\n## "); j >= 0 {
		return rest[:j]
	}
	return rest
}
