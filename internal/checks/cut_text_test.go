package checks

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCutsEndBetweenCharactersWhateverTheCutPoint(t *testing.T) {
	text := strings.Repeat("a€b", 40) // 3-byte characters at every offset
	for n := 0; n < len(text); n++ {
		for name, got := range map[string]string{
			"cutBytes":  cutBytes(text, n),
			"shorten":   shorten(text, n),
			"lastBytes": lastBytes(text, n),
			"tail":      tail(text, n),
		} {
			if !utf8.ValidString(got) {
				t.Fatalf("%s(%d) = %q, not valid UTF-8", name, n, got)
			}
		}
	}
	if got := shorten("short", 10); got != "short" {
		t.Errorf("shorten of a short text = %q", got)
	}
	if got := shorten("abcdef", 3); got != "abc..." {
		t.Errorf("shorten = %q", got)
	}
	if got := tail("  abcdef  ", 3); got != "...def" {
		t.Errorf("tail = %q", got)
	}
}

func TestAnUnknownPackageNameCutInTheMiddleOfACharacterStaysValidText(t *testing.T) {
	// The 100th byte is inside the 3-byte character.
	name := "@scope/" + strings.Repeat("a", 92) + "€€€"
	_, list := unknownList([]string{name})

	if !utf8.ValidString(list) {
		t.Errorf("list = %q, not valid UTF-8", list)
	}
	if !strings.Contains(list, "...") {
		t.Errorf("list = %q, want the name cut with an ellipsis", list)
	}
}
