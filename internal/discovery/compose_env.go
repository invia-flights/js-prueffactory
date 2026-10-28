package discovery

import (
	"sort"
	"strings"
)

// readDotEnv reads the project's .env file the way compose does: KEY=VALUE
// lines, an optional `export` prefix, `#` comments, single-quoted values that
// are literal, double-quoted values with escapes, and ${VAR} interpolation of
// the values defined before. The host environment is never consulted. A missing
// or unreadable file is an empty environment.
func readDotEnv(path string) map[string]string {
	vars := map[string]string{}
	data, err := readComposeFile(path)
	if err != nil {
		return vars
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !dotEnvKey(key) {
			continue
		}
		vars[key] = dotEnvValue(strings.TrimSpace(value), vars)
	}
	return vars
}

func dotEnvKey(k string) bool {
	if k == "" {
		return false
	}
	for i, r := range k {
		letter := r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
		if !letter && (i == 0 || !(r >= '0' && r <= '9' || r == '.' || r == '-')) {
			return false
		}
	}
	return true
}

func dotEnvValue(v string, vars map[string]string) string {
	if v == "" {
		return ""
	}
	switch v[0] {
	case '\'':
		if end := strings.IndexByte(v[1:], '\''); end >= 0 {
			return v[1 : 1+end]
		}
	case '"':
		if end := closingQuote(v); end > 0 {
			inner := v[1:end]
			inner = strings.NewReplacer(`\n`, "\n", `\t`, "\t", `\r`, "\r", `\"`, `"`, `\\`, `\`).Replace(inner)
			out, _ := interpolate(inner, vars)
			return out
		}
	}
	if i := strings.Index(v, " #"); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	out, _ := interpolate(v, vars)
	return out
}

// closingQuote returns the index of the double quote that closes v, which
// starts with one, skipping escaped quotes, or -1.
func closingQuote(v string) int {
	for i := 1; i < len(v); i++ {
		switch v[i] {
		case '\\':
			i++
		case '"':
			return i
		}
	}
	return -1
}

// interpolate expands $VAR, ${VAR}, ${VAR:-default}, ${VAR-default},
// ${VAR:?error}, ${VAR?error}, ${VAR:+replacement} and ${VAR+replacement} from
// vars, and $$ as a literal dollar sign. It also returns the names of the
// variables that have no value and no default, sorted: the ones compose would
// leave empty with a warning, or reject with ?, and that this tool cannot
// answer because it never reads the host environment.
func interpolate(s string, vars map[string]string) (string, []string) {
	missing := map[string]bool{}
	out := expand(s, vars, missing)
	var names []string
	for n := range missing {
		names = append(names, n)
	}
	sort.Strings(names)
	return out, names
}

func expand(s string, vars map[string]string, missing map[string]bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '$' || i+1 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		switch next := s[i+1]; {
		case next == '$':
			b.WriteByte('$')
			i++
		case next == '{':
			end := matchingBrace(s, i+1)
			if end < 0 {
				b.WriteByte('$')
				continue
			}
			b.WriteString(expandBraced(s[i+2:end], vars, missing))
			i = end
		case isNameStart(next):
			j := i + 1
			for j < len(s) && isNameChar(s[j]) {
				j++
			}
			name := s[i+1 : j]
			if v, ok := vars[name]; ok {
				b.WriteString(v)
			} else {
				missing[name] = true
			}
			i = j - 1
		default:
			b.WriteByte('$')
		}
	}
	return b.String()
}

// matchingBrace returns the index of the brace that closes the one at open.
func matchingBrace(s string, open int) int {
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

func expandBraced(body string, vars map[string]string, missing map[string]bool) string {
	end := 0
	for end < len(body) && isNameChar(body[end]) {
		end++
	}
	name, op := body[:end], body[end:]
	if name == "" || !isNameStart(name[0]) {
		return "${" + body + "}"
	}
	val, set := vars[name]
	nonEmpty := set && val != ""
	word := func(prefix string) string { return expand(strings.TrimPrefix(op, prefix), vars, missing) }
	switch {
	case op == "":
		if !set {
			missing[name] = true
		}
		return val
	case strings.HasPrefix(op, ":-"):
		if nonEmpty {
			return val
		}
		return word(":-")
	case strings.HasPrefix(op, "-"):
		if set {
			return val
		}
		return word("-")
	case strings.HasPrefix(op, ":?"):
		if !nonEmpty {
			missing[name] = true
		}
		return val
	case strings.HasPrefix(op, "?"):
		if !set {
			missing[name] = true
		}
		return val
	case strings.HasPrefix(op, ":+"):
		if nonEmpty {
			return word(":+")
		}
		return ""
	case strings.HasPrefix(op, "+"):
		if set {
			return word("+")
		}
		return ""
	}
	return "${" + body + "}"
}

func isNameStart(c byte) bool { return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func isNameChar(c byte) bool  { return isNameStart(c) || c >= '0' && c <= '9' }
