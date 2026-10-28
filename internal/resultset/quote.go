package resultset

import (
	"strings"
	"unicode"
)

// Quote marks project text inside a reason or Limitation message (a test
// script, a chain step) as quoted text. The result is a Markdown code span:
// the delimiter is longer than any backtick run in the text, and the span is
// padded with one space when the text begins or ends with a backtick. Control
// characters are dropped and line breaks become spaces.
//
// report.md shows such a span as it is, without HTML escaping, so `&&` reads
// as `&&`. Everything outside the spans of a reason stays escaped there.
func Quote(s string) string {
	s = strings.Join(strings.Fields(WithoutControls(s)), " ")
	if s == "" {
		return ""
	}
	d := strings.Repeat("`", LongestBacktickRun(s)+1)
	if strings.HasPrefix(s, "`") || strings.HasSuffix(s, "`") {
		s = " " + s + " "
	}
	return d + s + d
}

// WithoutControls drops the control characters of a text from the project, but
// keeps white space, so that an escape sequence in a test title does not reach a
// terminal through the Report.
func WithoutControls(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

// LongestBacktickRun returns the length of the longest run of backticks in s.
func LongestBacktickRun(s string) int {
	longest, cur := 0, 0
	for _, r := range s {
		if r == '`' {
			cur++
			longest = max(longest, cur)
		} else {
			cur = 0
		}
	}
	return longest
}
