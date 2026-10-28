package checks

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// The cuts of project and tool text. Every one cuts between characters, so the
// result is valid UTF-8 whenever the text was.

// cutBytes is the first n bytes of s, ending at a character.
func cutBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// shorten is s cut to about n bytes, with "..." where it was cut.
func shorten(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return cutBytes(s, n) + "..."
}

// lastBytes returns the last n bytes of s, starting at a character.
func lastBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	for len(s) > 0 && !utf8.RuneStart(s[0]) {
		s = s[1:]
	}
	return s
}

// tail is the end of s, at most n bytes of it, with "..." where the start was
// cut.
func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "..." + lastBytes(s, n)
}

// cutList shortens a list to n entries and says how many were left out.
func cutList(list []string, n int) []string {
	if len(list) <= n {
		return list
	}
	out := append([]string{}, list[:n]...)
	return append(out, fmt.Sprintf("and %d more", len(list)-n))
}
