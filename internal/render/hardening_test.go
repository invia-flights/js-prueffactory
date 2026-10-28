package render_test

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/resultset/resultsettest"
)

// hostileTexts are the awkward strings every text field of a Finding gets.
var hostileTexts = map[string]string{
	"crlf":        "first\r\nsecond\rthird",
	"tabs":        "a\tb\t\tc",
	"astral":      "emoji \U0001F600 and math \U0001D54F and \U00010348",
	"backticks":   "run ` and `` and ``` and ```` and `````` end",
	"pipes":       "a|b || c \\| d",
	"html":        "<script>alert(1)</script> <img src=x onerror=y> &amp; &lt;",
	"control":     "bell\x07 nul\x00 esc\x1b[31m del\x7f c1\u0085 end",
	"markdown":    "# heading\n- item\n1. numbered\n> quote\n---\n[link](http://evil.example)\n[ref]: http://evil.example\n**bold** _it_ ~~x~~ ![img](x)",
	"fence":       "```\nclosed early\n```\n## after",
	"blank lines": "a\n\n\n\nb",
	"trailing":    "ends with backtick`",
}

func hostileSet(text string) *resultset.Set {
	s := resultsettest.Minimal()
	f := resultsettest.Finding("src/"+text+".js", text, true)
	f.Message = text
	f.RuleID = &text
	f.Expected, f.Actual = &text, &text
	f.Evidence = []resultset.Evidence{{Kind: "tool_output", Text: text, Origin: text, Trust: resultset.TrustUntrusted}}
	f.Locations[0].Role = text
	g := resultsettest.Finding("src/other.js", text, false)
	g.Message = text
	s.Findings = []resultset.Finding{f, g}
	s.Limitations = []resultset.Limitation{{ReasonCode: "r", Message: text}}
	s.Metrics = []resultset.Metric{{ID: "m", CheckID: "syntax.parse", ContextID: "C-0002", Name: text, Unit: text}}
	s.Finalize()
	return s
}

var htmlTag = regexp.MustCompile(`</?[A-Za-z!]`)

func TestMarkdownTurnsHostileTextIntoInertText(t *testing.T) {
	for name, text := range hostileTexts {
		t.Run(name, func(t *testing.T) {
			s := hostileSet(text)
			if problems := s.Validate(); len(problems) != 0 {
				t.Fatalf("fixture invalid: %v", problems)
			}
			md := string(render.Markdown(s))
			if !utf8.ValidString(md) || strings.Contains(md, "\r") {
				t.Error("report.md has invalid UTF-8 or a carriage return")
			}
			for _, r := range md {
				if unicode.IsControl(r) && r != '\n' && r != '\t' {
					t.Fatalf("control character %U survived", r)
				}
			}
			outside := stripCodeSpans(outsideCodeFences(md))
			if loc := htmlTag.FindStringIndex(outside); loc != nil {
				t.Errorf("an HTML tag appears outside code at %q", outside[loc[0]:min(len(outside), loc[0]+30)])
			}
			// Headings, quotes, lists and rules in the output come from the tool,
			// never from project text, so no line may start with project text's
			// block markers.
			for _, line := range strings.Split(outside, "\n") {
				for _, bad := range []string{"# heading", "## after", "- item", "1. numbered", "> quote", "---", "[ref]:", "[link](", "![img]"} {
					if strings.HasPrefix(strings.TrimSpace(line), bad) && strings.Contains(text, bad) {
						t.Errorf("line starts with project text %q: %s", bad, line)
					}
				}
				if strings.Contains(text, "[link](http") && strings.Contains(line, "[link](http") && !strings.Contains(line, `\[link`) {
					t.Errorf("project text became a link: %s", line)
				}
			}
			// Every table row has the cell count of its header.
			var width int
			for _, line := range strings.Split(outside, "\n") {
				if !strings.HasPrefix(line, "|") {
					width = 0
					continue
				}
				if width == 0 {
					width = len(splitCells(line))
				} else if got := len(splitCells(line)); got != width {
					t.Errorf("table row has %d cells, want %d: %s", got, width, line)
				}
			}
			// Fences: every fence opened is closed by a longer-or-equal one and
			// nothing in the text can close it early.
			if err := checkFences(md); err != nil {
				t.Error(err)
			}
		})
	}
}

// stripCodeSpans removes inline code spans, whose content Markdown renders
// literally. A backtick preceded by a backslash does not open or close one.
func stripCodeSpans(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); {
		if s[i] != '`' || (i > 0 && s[i-1] == '\\') {
			out.WriteByte(s[i])
			i++
			continue
		}
		n := 0
		for i+n < len(s) && s[i+n] == '`' {
			n++
		}
		// Find the next run of exactly n backticks on the same paragraph.
		end, j := -1, i+n
		for j < len(s) {
			if s[j] == '`' {
				m := 0
				for j+m < len(s) && s[j+m] == '`' {
					m++
				}
				if m == n {
					end = j + m
					break
				}
				j += m
				continue
			}
			j++
		}
		if end < 0 {
			out.WriteString(s[i : i+n])
			i += n
			continue
		}
		i = end
	}
	return out.String()
}

// checkFences walks the Markdown the way CommonMark does and reports an
// unclosed fence at the end.
func checkFences(md string) error {
	fence := ""
	for i, line := range strings.Split(md, "\n") {
		trimmed := strings.TrimRight(line, " ")
		if fence == "" {
			if strings.HasPrefix(trimmed, "```") && strings.Trim(trimmed, "`") == "" {
				fence = trimmed
			}
			continue
		}
		if strings.HasPrefix(trimmed, fence) && strings.Trim(trimmed, "`") == "" {
			fence = ""
		}
		_ = i
	}
	if fence != "" {
		return fmt.Errorf("code fence %q is never closed", fence)
	}
	return nil
}

func TestMarkdownFenceIsLongerThanAnyBacktickRunInsideIt(t *testing.T) {
	for _, run := range []int{1, 3, 4, 7, 12} {
		text := "before " + strings.Repeat("`", run) + " after"
		s := hostileSet(text)
		md := string(render.Markdown(s))
		want := strings.Repeat("`", max(3, run+1))
		if !strings.Contains(md, "\n"+want+"\n") {
			t.Errorf("a run of %d backticks needs a fence of %d:\n%s", run, len(want), md)
		}
		if err := checkFences(md); err != nil {
			t.Error(err)
		}
	}
}

func TestMarkdownKeepsTabsInsideFencesAndAstralCharactersWhole(t *testing.T) {
	s := hostileSet("a\tb \U0001F600")
	md := string(render.Markdown(s))
	if !strings.Contains(md, "a\tb \U0001F600\n") {
		t.Errorf("tab or astral character lost inside a fence:\n%s", md)
	}
}

func manyFindings(n int, gate bool) *resultset.Set {
	s := resultsettest.Minimal()
	for i := 0; i < n; i++ {
		s.Findings = append(s.Findings, resultsettest.Finding(fmt.Sprintf("src/f%03d.js", i), "Finding "+fmt.Sprint(i), gate))
	}
	s.Finalize()
	return s
}

func TestMarkdownShowsAtMost50FindingsPerCheckAndPointsToTheJSONForTheRest(t *testing.T) {
	for _, gate := range []bool{false, true} {
		t.Run(fmt.Sprintf("gate=%v", gate), func(t *testing.T) {
			s := manyFindings(120, gate)
			md := string(render.Markdown(s))
			shown := 0
			for _, f := range s.Findings {
				if strings.Contains(md, f.ID+"]") || strings.Contains(md, "### "+f.ID+":") || strings.Contains(md, "- "+f.ID+" ") {
					shown++
				}
			}
			if shown != 50 {
				t.Errorf("%d Findings shown in full, want 50", shown)
			}
			if !strings.Contains(md, fmt.Sprintf("70 more Findings, %s to %s, in report.json", s.Findings[50].ID, s.Findings[119].ID)) {
				t.Errorf("no line with the count and ID range of the rest:\n%s", section(md, "## Findings"))
			}
			if !strings.Contains(md, "Gates: "+fmt.Sprint(map[bool]int{true: 120, false: 0}[gate])+".") {
				t.Error("the result line must count every Gate, not only the shown ones")
			}
		})
	}
}

func TestMarkdownCapDoesNotMixDifferentChecks(t *testing.T) {
	s := manyFindings(60, false)
	other := resultsettest.Finding("src/x.js", "other", false)
	other.CheckID = "package.manifest"
	s.Checks = append(s.Checks, resultset.Execution{ID: "tmp-m", CheckID: "package.manifest", Family: "package", ContextID: "C-0002",
		Selected: true, Applicability: resultset.Applicable, Status: resultset.StatusCompleted})
	other.ExecutionID = "tmp-m"
	s.Findings = append(s.Findings, other)
	s.Finalize()
	md := string(render.Markdown(s))
	if !strings.Contains(section(md, "## Findings"), "10 more Findings") {
		t.Errorf("syntax.parse has 60 Findings, so 10 are left out:\n%s", section(md, "## Findings"))
	}
	if strings.Count(md, "more Findings") != 1 {
		t.Error("the other Check, with one Finding, must not get a rest line")
	}
}

func TestMarkdownEmptySectionsAlwaysSayNone(t *testing.T) {
	md := string(render.Markdown(resultsettest.Minimal()))
	for _, h := range []string{"## Gates", "## Findings", "## Measurements", "## Setup, tool and infrastructure problems", "## Inventory"} {
		if got := strings.TrimSpace(section(md, h)); got != "None." {
			t.Errorf("%s is empty and reads %q, want %q", h, got, "None.")
		}
	}
	sum := section(md, "## Summary")
	if strings.Contains(sum, "None.") {
		t.Errorf("the summary of one execution is not empty:\n%s", sum)
	}
	if !strings.HasSuffix(md, "\n") || strings.HasSuffix(md, "\n\n") {
		t.Error("report.md must end with exactly one newline")
	}
	// Twelve parts in order: title, untrusted line, result line, then the nine headings.
	if got := strings.Count(md, "\n## "); got != 9 {
		t.Errorf("%d second-level sections, want 9", got)
	}
}

func TestMarkdownEmptyArtifactsContextsAndServicesAreNamedNone(t *testing.T) {
	s := resultsettest.Minimal()
	s.Contexts, s.Services, s.Artifacts = nil, nil, nil
	s.Checks = nil
	s.Finalize()
	md := string(render.Markdown(s))
	arts := section(md, "## Artifacts, versions, Contexts and Services")
	if strings.Count(arts, "None.") != 3 {
		t.Errorf("artifacts, contexts and services should each say None.:\n%s", arts)
	}
	if got := strings.TrimSpace(section(md, "## Summary")); got != "None." {
		t.Errorf("an empty summary reads %q, want None.", got)
	}
}

func TestMarkdownLinksCutEvidenceToItsFullTextArtifact(t *testing.T) {
	s := resultsettest.Minimal()
	f := resultsettest.Finding("src/a.js", "long", true)
	f.Evidence = []resultset.Evidence{{Kind: "tool_output", Text: strings.Repeat("z", 9000), Origin: "node", Trust: resultset.TrustUntrusted}}
	s.Findings = []resultset.Finding{f}
	s.Finalize()
	md := string(render.Markdown(s))
	path := s.Artifacts[0].Path
	if !strings.Contains(md, "original text had 9000 bytes") || !strings.Contains(md, "full text: ["+path+"]("+path+")") {
		t.Errorf("the cut evidence does not point to %s:\n%s", path, section(md, "## Gates"))
	}
	if !strings.Contains(md, "truncated evidence items: 1") {
		t.Error("report.md does not count truncated evidence")
	}
}

func TestJSONAndMarkdownAgreeOnIDsCountsAndStatuses(t *testing.T) {
	s := handMade()
	data, err := render.JSON(s)
	if err != nil {
		t.Fatal(err)
	}
	var back resultset.Set
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	md := string(render.Markdown(&back))
	for _, f := range back.Findings {
		if !strings.Contains(md, f.ID) {
			t.Errorf("finding %s is in report.json but not in report.md", f.ID)
		}
	}
	if !strings.Contains(md, fmt.Sprintf("exit code %d", back.Run.ExitCode)) || !strings.Contains(md, fmt.Sprintf("Gates: %d.", back.Summary.Gates)) {
		t.Error("exit code or Gate count differ")
	}
	sc := back.Summary.ScopeCompleteness
	if !strings.Contains(md, fmt.Sprintf("Scope completeness: %d of %d", sc.Completed, sc.Required)) {
		t.Error("scope completeness differs")
	}
	for _, e := range back.Checks {
		if e.Selected && e.Applicability == resultset.Applicable && e.Status != resultset.StatusCompleted &&
			!strings.Contains(section(md, "## Gaps"), "**"+string(e.Status)+"**") {
			t.Errorf("execution %s is %s in report.json and missing from the gaps", e.ID, e.Status)
		}
	}
	for _, c := range back.Contexts {
		if !strings.Contains(md, c.ID) {
			t.Errorf("context %s is missing from report.md", c.ID)
		}
	}
}

func TestReportsAreIdenticalWhateverTheArrivalOrder(t *testing.T) {
	build := func(reverse bool) *resultset.Set {
		s := resultsettest.Minimal()
		for i := 0; i < 8; i++ {
			s.Findings = append(s.Findings, resultsettest.Finding(fmt.Sprintf("src/%d.js", i%3), fmt.Sprintf("t%d", i), i%2 == 0))
		}
		if reverse {
			for i, j := 0, len(s.Findings)-1; i < j; i, j = i+1, j-1 {
				s.Findings[i], s.Findings[j] = s.Findings[j], s.Findings[i]
			}
		}
		s.Finalize()
		return s
	}
	a, b := build(false), build(true)
	ja, _ := render.JSON(a)
	jb, _ := render.JSON(b)
	if string(ja) != string(jb) || string(render.Markdown(a)) != string(render.Markdown(b)) {
		t.Fatal("the same results in a different order produced different reports")
	}
}
