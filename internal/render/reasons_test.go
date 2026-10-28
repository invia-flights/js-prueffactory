package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// gaps returns the Gaps section of report.md.
func gaps(s *resultset.Set) string { return section(string(render.Markdown(s)), "## Gaps") }

func TestMarkdownShowsQuotedProjectTextInReasonsAsCodeSpans(t *testing.T) {
	s := handMade()
	blockedCheck(s).Reason = ptr("the test script " + resultset.Quote("mocha && node x.js") + " uses shell syntax")
	s.Limitations = append(s.Limitations, resultset.Limitation{ReasonCode: "test_chain_all_steps_run",
		Message: "step " + resultset.Quote("npm run a && npm run b") + " ran"})
	s.Finalize()
	got := gaps(s)
	for _, want := range []string{
		"the test script `mocha && node x.js` uses shell syntax",
		"step `npm run a && npm run b` ran",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Gaps lack %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "&amp;") {
		t.Errorf("a code span must not be HTML-escaped:\n%s", got)
	}
}

func TestMarkdownCodeSpansOfReasonsHoldHostileTextInertly(t *testing.T) {
	hostile := []string{
		"a`b", "`edge`", "x ``y`` z", "a <b>html</b> & c", "*emph* _x_ [l](http://evil.example) # h",
		"| pipe |", "line1\nline2", "```\n## fence\n```", "trailing backtick`", "```` four",
	}
	for _, h := range hostile {
		s := handMade()
		blockedCheck(s).Reason = ptr("before " + resultset.Quote(h) + " after *this* <i>is</i> plain")
		s.Finalize()
		var line string
		for _, l := range strings.Split(gaps(s), "\n") {
			if strings.Contains(l, "before") {
				line = l
			}
		}
		if line == "" {
			t.Fatalf("no reason line for %q", h)
		}
		// Outside the code span the text stays escaped, and the span closes where it should.
		outside := stripCodeSpans(line)
		if !strings.Contains(outside, `before  after \*this\* &lt;i&gt;is&lt;/i&gt; plain`) {
			t.Errorf("%q: the text around the span changed or the span did not close: %q", h, outside)
		}
		// The span shows the text itself.
		want := strings.Join(strings.Fields(h), " ")
		if got := spanText(t, line[strings.Index(line, "before ")+len("before "):]); got != want {
			t.Errorf("%q: span shows %q, want %q", h, got, want)
		}
	}
}

// spanText returns the content of the first inline code span of line the way
// CommonMark reads it: one padding space is stripped when both sides have one.
func spanText(t *testing.T, line string) string {
	t.Helper()
	i := strings.Index(line, "`")
	if i < 0 {
		t.Fatalf("no span in %q", line)
	}
	n := 0
	for i+n < len(line) && line[i+n] == '`' {
		n++
	}
	delim := strings.Repeat("`", n)
	rest := line[i+n:]
	for k := 0; k+n <= len(rest); k++ {
		if rest[k:k+n] != delim || (k > 0 && rest[k-1] == '`') || (k+n < len(rest) && rest[k+n] == '`') {
			continue
		}
		c := rest[:k]
		if len(c) > 1 && c[0] == ' ' && c[len(c)-1] == ' ' && strings.Trim(c, " ") != "" {
			c = c[1 : len(c)-1]
		}
		return c
	}
	t.Fatalf("span not closed in %q", line)
	return ""
}

// blockedCheck is the blocked Execution of handMade, whose Reason shows in Gaps.
func blockedCheck(s *resultset.Set) *resultset.Execution {
	for i := range s.Checks {
		if s.Checks[i].Status == resultset.StatusBlocked {
			return &s.Checks[i]
		}
	}
	panic("no blocked Execution")
}

func TestMarkdownEscapesUnbalancedBackticksInReasons(t *testing.T) {
	s := handMade()
	blockedCheck(s).Reason = ptr("a stray ` and <b>bold</b> text")
	s.Finalize()
	if got := gaps(s); !strings.Contains(got, "a stray \\` and &lt;b&gt;bold&lt;/b&gt; text") {
		t.Errorf("an unclosed backtick must stay escaped text:\n%s", got)
	}
}

func TestMarkdownShowsQuotedTextInFindingMessagesAsCodeSpans(t *testing.T) {
	s := handMade()
	s.Findings[0].Message = "The suite " + resultset.Quote("test:api && more") + " may need a Service, so this is a *note*."
	s.Finalize()
	got := string(render.Markdown(s))
	if !strings.Contains(got, "The suite `test:api && more` may need a Service, so this is a \\*note\\*.") {
		t.Errorf("the quoted text is not a code span or the rest is not escaped:\n%s", got)
	}
	if strings.Contains(got, "\\`test:api") {
		t.Errorf("the backticks of the span are escaped:\n%s", got)
	}
}
