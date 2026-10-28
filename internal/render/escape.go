package render

import (
	"strings"
	"unicode"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// clean removes control characters other than tab and newline and turns CRLF
// and CR into LF.
func clean(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// text escapes project or tool text for use in running Markdown outside code:
// control characters are removed, `&`, `<` and `>` are escaped so the text
// cannot inject HTML, and Markdown syntax is backslash-escaped so the text
// cannot make headings, lists, links, emphasis or code. Line breaks become
// spaces.
func text(s string) string {
	s = htmlEscaper.Replace(clean(s))
	return mdEscape(strings.Join(strings.Fields(s), " "))
}

// mdEscape backslash-escapes the characters that start Markdown syntax in
// running text. An underscore between two letters or digits cannot start
// emphasis, so it stays readable.
func mdEscape(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		switch r {
		case '\\', '`', '*', '[', ']', '~':
			b.WriteByte('\\')
		case '_':
			inWord := i > 0 && i+1 < len(rs) && isWordRune(rs[i-1]) && isWordRune(rs[i+1])
			if !inWord {
				b.WriteByte('\\')
			}
		case '#', '-', '+', '=':
			if i == 0 {
				b.WriteByte('\\')
			}
		case '.', ')':
			// "1." and "2)" at the start would begin a numbered list.
			if i > 0 && allDigits(rs[:i]) && (i+1 == len(rs) || rs[i+1] == ' ') {
				b.WriteByte('\\')
			}
		}
		b.WriteRune(r)
	}
	return b.String()
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

func allDigits(rs []rune) bool {
	for _, r := range rs {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(rs) > 0
}

// cell escapes project or tool text for a table cell: everything text does, and
// pipes are escaped so they cannot start a new cell.
func cell(s string) string {
	return strings.ReplaceAll(text(s), "|", `\|`)
}

// fence puts project or tool text into a code fence that is longer than the
// longest backtick run inside the text.
func fence(s string) string {
	s = strings.TrimRight(clean(s), "\n")
	f := strings.Repeat("`", max(3, resultset.LongestBacktickRun(s)+1))
	return f + "\n" + s + "\n" + f + "\n"
}

// code puts text into an inline code span, see resultset.Quote. Control
// characters are cleaned first. Inside a table the caller still passes the
// result through pipeSafe.
func code(s string) string { return resultset.Quote(clean(s)) }

// cellCode is code for use in a table cell.
func cellCode(s string) string { return strings.ReplaceAll(code(s), "|", `\|`) }

// reasonText renders a reason or Limitation message. Project text that the
// producer quoted with resultset.Quote is a Markdown code span: it is shown as
// a code span, without HTML escaping, so `&&` stays `&&`. Everything else is
// escaped as text. A backtick run that no run of the same length closes is
// not a span and is escaped like any other text.
func reasonText(s string) string {
	s = clean(s)
	var out strings.Builder
	plain := 0 // start of the text not yet written
	flush := func(end int) {
		seg := s[plain:end]
		if seg == "" {
			return
		}
		if strings.TrimSpace(seg) == "" {
			out.WriteByte(' ')
			return
		}
		if unicode.IsSpace([]rune(seg)[0]) {
			out.WriteByte(' ')
		}
		out.WriteString(text(seg))
		if r := []rune(seg); unicode.IsSpace(r[len(r)-1]) {
			out.WriteByte(' ')
		}
	}
	for i := 0; i < len(s); {
		if s[i] != '`' {
			i++
			continue
		}
		n := 0
		for i+n < len(s) && s[i+n] == '`' {
			n++
		}
		end := closingRun(s, i+n, n)
		if end < 0 {
			i += n
			continue
		}
		flush(i)
		content := s[i+n : end]
		if len(content) > 1 && content[0] == ' ' && content[len(content)-1] == ' ' && strings.Trim(content, " ") != "" {
			content = content[1 : len(content)-1]
		}
		out.WriteString(code(content))
		i = end + n
		plain = i
	}
	flush(len(s))
	return out.String()
}

// reasonCell is reasonText for use in a table cell.
func reasonCell(s string) string { return strings.ReplaceAll(reasonText(s), "|", `\|`) }

// closingRun returns the index of the next run of exactly n backticks at or
// after from, or -1.
func closingRun(s string, from, n int) int {
	for j := from; j < len(s); {
		if s[j] != '`' {
			j++
			continue
		}
		m := 0
		for j+m < len(s) && s[j+m] == '`' {
			m++
		}
		if m == n {
			return j
		}
		j += m
	}
	return -1
}
