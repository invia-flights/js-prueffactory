package redact

import (
	"regexp"
	"sort"
	"strings"
)

// EnvRule is the rule that decides which values of a .env file and of a
// Service's environment are redacted, in the words the Report uses to say so.
// LooksLikeSecret implements it. It is the only place that decides, so changing
// the rule means changing LooksLikeSecret and this text, nothing else.
//
// Why a rule at all: registering every value turns ordinary values such as a
// host name, a region or a word into text that is replaced everywhere, in file
// paths and code included, and the Report becomes unreadable. Registering none
// leaks the passwords that sit in .env files. A value is therefore redacted
// only when it looks like a secret.
const EnvRule = "A value from a .env file or a Service environment is redacted only if it looks like a secret: " +
	"its variable name contains SECRET, TOKEN, PASSWORD, PASSWD, KEY, CREDENTIAL, AUTH or PRIVATE (whatever the value, a URL or a path included, except a switch or a small number), " +
	"or it contains a URL with userinfo (user@host or user:password@host), a PEM block, " +
	"or it is a single token of at least 12 characters that mixes character classes (at least three of lower case, upper case, digits and symbols, " +
	"or at least 16 letters and digits with both). " +
	"A placeholder is never redacted, whatever the name: " +
	"a value that is, in any case, empty, dummy, changeme, change-me, change_me, placeholder, example, sample, secret, password, foo, bar, baz, todo, tbd, n/a, unset, undefined, default, fake, mock, xxx or a longer run of x, or one character repeated. " +
	"Under any other name, plain words, numbers, booleans, host names, URLs without userinfo and paths (values with a /) are left readable."

// secretNameParts are the parts of a variable name that suggest a secret. The
// match is a case-insensitive substring of the name.
var secretNameParts = []string{"SECRET", "TOKEN", "PASSWORD", "PASSWD", "KEY", "CREDENTIAL", "AUTH", "PRIVATE"}

// plainValue matches the values that are never secrets, even under a secret
// name: switches, well-known environment names and small integers such as
// ports.
var plainValue = regexp.MustCompile(`(?i)^(true|false|yes|no|on|off|production|prod|test|testing|development|dev|staging|local|debug|info|warn|error|null|none|[0-9]{1,5})$`)

// placeholderWord matches the words that stand in for a value in an example or
// a template. A variable such as AWS_SECRET_ACCESS_KEY=empty is no secret, and
// redacting the word would corrupt every text that holds it, such as a test
// title and the command that re-runs the test by that title.
var placeholderWord = regexp.MustCompile(`(?i)^(empty|dummy|changeme|change-me|change_me|placeholder|example|sample|secret|password|foo|bar|baz|todo|tbd|n/a|unset|undefined|default|fake|mock)$`)

// isPlaceholder reports whether v is a placeholder: one of placeholderWord, or a
// value made of one repeated character, which includes xxx and longer runs of
// x in either case.
func isPlaceholder(v string) bool {
	if placeholderWord.MatchString(v) {
		return true
	}
	runes := []rune(strings.ToLower(v))
	for _, r := range runes {
		if r != runes[0] {
			return false
		}
	}
	return len(runes) > 0
}

var (
	// hostLike matches a lower-case name with separators: a host name, a
	// region, an image reference, a version, a hyphenated name.
	hostLike = regexp.MustCompile(`^[a-z0-9]+([._:-][a-z0-9]+)+$`)
	// alnum matches letters and digits only.
	alnum = regexp.MustCompile(`^[A-Za-z0-9]+$`)
)

// LooksLikeSecret reports whether the value of the environment variable name
// must be redacted, by EnvRule. The order matters: a switch, a small number or
// a placeholder is never a secret, whatever the name; userinfo in a URL and a PEM block always are; then a
// name that suggests a secret decides for the whole value, with no exception
// for URLs and paths; only under other names does the value itself have to
// pass the floor.
func LooksLikeSecret(name, value string) bool { return secretRule(name, value) != "" }

// The names of the rules of EnvRule, as the diagnostics show them.
const (
	ruleSecretName  = "env-secret-name"
	ruleURLUserinfo = "env-url-userinfo"
	rulePEMBlock    = "env-pem-block"
	ruleEntropy     = "env-entropy"
)

// secretRule returns the name of the rule of EnvRule that makes the value of
// the variable name a secret, or "" when the value is not one. It is the single
// place that decides; LooksLikeSecret only asks whether it found a rule.
func secretRule(name, value string) string {
	v := strings.TrimSpace(value)
	switch {
	case len(v) < MinLength || plainValue.MatchString(v) || isPlaceholder(v):
		return ""
	case len(urlAuthorities(v)) > 0:
		return ruleURLUserinfo
	case strings.Contains(v, "-----BEGIN "):
		return rulePEMBlock
	case nameSuggestsSecret(name):
		return ruleSecretName
	case passesFloor(v):
		return ruleEntropy
	}
	return ""
}

// authority is the authority part of a URL found in a value.
type authority struct {
	// userinfo is what stands before the last @ of the authority, and ok says
	// that there is an @.
	userinfo string
	ok       bool
	// rest is what follows the authority: path, query and fragment.
	rest string
}

// urlAuthorities finds the URLs of a value that have userinfo. For each
// "://" the authority is the text up to the first /, ? or # (or white space),
// split at its last @. It does not depend on what characters the userinfo has.
func urlAuthorities(v string) []authority {
	var out []authority
	for _, a := range allAuthorities(v) {
		if a.ok {
			out = append(out, a)
		}
	}
	return out
}

func allAuthorities(v string) []authority {
	var out []authority
	rest := v
	for {
		i := strings.Index(rest, "://")
		if i < 0 {
			return out
		}
		rest = rest[i+3:]
		end := strings.IndexAny(rest, "/?# \t\r\n")
		auth := rest
		if end >= 0 {
			auth = rest[:end]
		}
		a := authority{rest: rest[len(auth):]}
		if j := strings.LastIndex(auth, "@"); j >= 0 {
			a.userinfo, a.ok = auth[:j], true
		}
		if end := strings.IndexAny(a.rest, " \t\r\n"); end >= 0 {
			a.rest = a.rest[:end]
		}
		out = append(out, a)
	}
}

// urlSecretParts returns the parts of the URLs in a registered value that
// must be redacted on their own, so that a readable URL elsewhere does not
// leak them: the userinfo and its password (the text after its first colon),
// the query string, the fragment, the value of every query parameter whose
// name suggests a secret or whose value passes the floor, and every path
// segment that passes the floor.
func urlSecretParts(v string) []string {
	var out []string
	for _, a := range allAuthorities(v) {
		if a.ok {
			out = append(out, a.userinfo)
			if _, pass, ok := strings.Cut(a.userinfo, ":"); ok {
				out = append(out, pass)
			}
		}
		pathQuery, fragment, _ := strings.Cut(a.rest, "#")
		path, query, _ := strings.Cut(pathQuery, "?")
		out = append(out, query, fragment)
		for _, seg := range strings.Split(path, "/") {
			if passesFloor(seg) {
				out = append(out, seg)
			}
		}
		for _, param := range strings.Split(query, "&") {
			if k, val, ok := strings.Cut(param, "="); ok && (nameSuggestsSecret(k) || passesFloor(val)) {
				out = append(out, val)
			}
		}
	}
	return out
}

func nameSuggestsSecret(name string) bool {
	up := strings.ToUpper(name)
	for _, p := range secretNameParts {
		if strings.Contains(up, p) {
			return true
		}
	}
	return false
}

// passesFloor is the entropy and length floor for a value under an unremarkable
// name.
func passesFloor(v string) bool {
	if len(v) < 12 || strings.ContainsAny(v, " \t\r\n/") || strings.Contains(v, "://") || hostLike.MatchString(v) {
		return false
	}
	var lower, upper, digit, symbol bool
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= '0' && r <= '9':
			digit = true
		default:
			symbol = true
		}
	}
	classes := 0
	for _, c := range []bool{lower, upper, digit, symbol} {
		if c {
			classes++
		}
	}
	if classes >= 3 {
		return true
	}
	return len(v) >= 16 && alnum.MatchString(v) && digit && (lower || upper)
}

// EnvSelection is what EnvRule made of an environment.
type EnvSelection struct {
	// Values are the values to redact, each with the forms a log can show it
	// in. Forms shorter than MinLength are left out, because the Redactor
	// ignores them.
	Values []string
	// Sources says for each of Values which rule registered it and for which
	// variable, such as "env-secret-name (variable DB_PASSWORD)". It never
	// holds a value. When two variables give the same value, the first by name
	// wins.
	Sources map[string]string
	// Left are the names of the variables with a value that the rule left
	// readable, sorted.
	Left []string
}

// SelectEnv applies EnvRule to an environment, from a .env file or a Service's
// compose entry. For a value that is redacted it also returns the forms a log
// can show it in: with its whitespace normalised the way the Report's one-line
// texts are, for a value of several lines each line, and for a URL its userinfo, password, query string, fragment and token-like parts (urlSecretParts).
func SelectEnv(env map[string]string) EnvSelection {
	sources := map[string]string{}
	var sel EnvSelection
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		v := env[name]
		rule := secretRule(name, v)
		if rule == "" {
			if strings.TrimSpace(v) != "" {
				sel.Left = append(sel.Left, name)
			}
			continue
		}
		source := rule + " (variable " + name + ")"
		add := func(part string) {
			if len(part) >= MinLength {
				if _, ok := sources[part]; !ok {
					sources[part] = source
				}
			}
		}
		add(v)
		add(strings.Join(strings.Fields(v), " "))
		if strings.ContainsAny(v, "\r\n") {
			for _, line := range strings.FieldsFunc(v, func(r rune) bool { return r == '\n' || r == '\r' }) {
				add(strings.TrimSpace(line))
			}
		}
		for _, part := range urlSecretParts(v) {
			add(part)
		}
	}
	for v := range sources {
		sel.Values = append(sel.Values, v)
	}
	sel.Sources = sources
	sort.Strings(sel.Values)
	sort.Strings(sel.Left)
	return sel
}
