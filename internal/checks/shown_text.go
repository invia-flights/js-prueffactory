package checks

import (
	"regexp"
	"strings"
)

// Project text in trusted fields. A Finding's title and message and a
// Limitation's message are trusted text, so a name, a path or an address that
// the project wrote may stand in them only when it looks harmless: no space,
// no quote, no markup character and no control character. Anything else is
// replaced by a placeholder, and the real text stays in the Finding's Evidence,
// which is marked untrusted. (Text that is free-form and still has to be shown,
// such as a test title or a script, goes through resultset.Quote instead.)

var (
	// shownWordPattern is what a kind, a name or a stage may look like.
	shownWordPattern = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._:/-]{0,62}$`)
	// shownNamePattern is what a job or a stage name may look like: a word
	// without the colon, so that nothing in it reads as a scheme.
	shownNamePattern = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._/-]{0,62}$`)
	// shownPathPattern is what a path may look like.
	shownPathPattern = regexp.MustCompile(`^[A-Za-z0-9_@+.-][A-Za-z0-9_@+./-]{0,199}$`)
	// shownURLPattern is what a remote address, a project path or a component
	// reference may look like.
	shownURLPattern = regexp.MustCompile(`^[A-Za-z0-9$][A-Za-z0-9+.:/_@~%=&?#${}-]{0,199}$`)
	// shownEnvNamePattern is what an environment variable name may look like.
	shownEnvNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

// looksLikeWord says whether shownWord shows s as it is. A word with a colon
// followed by a slash is the start of an address and never one.
func looksLikeWord(s string) bool {
	return shownWordPattern.MatchString(s) && !strings.Contains(s, ":/")
}

// shownWord is s when it looks like a word, otherwise a placeholder that says
// what s was ("kind", "job name").
func shownWord(s, what string) string {
	if looksLikeWord(s) {
		return s
	}
	return "(" + what + " with unusual characters)"
}

// shownName is s when it looks like a name without a colon (a job or a stage),
// otherwise a placeholder that says what s was.
func shownName(s, what string) string {
	if shownNamePattern.MatchString(s) {
		return s
	}
	return "(" + what + " with unusual characters)"
}

// shownPath is s when it looks like a path, otherwise a placeholder.
func shownPath(s string) string {
	if shownPathPattern.MatchString(s) && !strings.Contains(s, "..") {
		return s
	}
	return "(path with unusual characters)"
}

// shownURL is s when it looks like an address, otherwise a placeholder that
// says what s was ("include").
func shownURL(s, what string) string {
	if shownURLPattern.MatchString(s) {
		return s
	}
	return "(" + what + " with unusual characters)"
}

// shownEnvName is s when it looks like the name of an environment variable,
// otherwise a placeholder.
func shownEnvName(s string) string {
	if shownEnvNamePattern.MatchString(s) {
		return s
	}
	return "(variable name with unusual characters)"
}

// shownGlobPattern is what the path of a local include may look like: a path
// that may hold the wildcards `*` and `?` and a variable such as ${NAME}.
var shownGlobPattern = regexp.MustCompile(`^[A-Za-z0-9_@+./*?$-][A-Za-z0-9_@+./*?${}-]{0,199}$`)

// shownGlob is s when it looks like a path or a glob of paths, otherwise a
// placeholder.
func shownGlob(s string) string {
	if shownGlobPattern.MatchString(s) {
		return s
	}
	return "(path with unusual characters)"
}
