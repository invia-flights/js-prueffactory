package discovery

import "strings"

// nodeOptionsWithValue are the Node options that can take their value as the
// next word, so that the word is not taken for a test file.
var nodeOptionsWithValue = map[string]bool{
	"require": true, "r": true, "import": true, "loader": true, "experimental-loader": true,
	"conditions": true, "C": true, "env-file": true, "disable-warning": true, "watch-path": true,
	"test-reporter": true, "test-reporter-destination": true, "test-name-pattern": true,
	"test-skip-pattern": true, "test-concurrency": true, "test-timeout": true, "test-shard": true,
	"test-isolation": true, "test-coverage-include": true, "test-coverage-exclude": true,
	"test-coverage-branches": true, "test-coverage-functions": true, "test-coverage-lines": true,
	"max-old-space-size": true, "stack-size": true, "title": true, "input-type": true,
}

// ParseNodeTestArgs splits the arguments of `node … --test …` into options and
// test file arguments. It knows which options take their value as the next
// word. Everything after `--` is a test file argument, and the `--` itself is
// an item named "--".
func ParseNodeTestArgs(args []string) []MochaArg {
	var out []MochaArg
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out = append(out, MochaArg{Words: []string{a}, Name: "--"})
			for _, rest := range args[i+1:] {
				out = append(out, MochaArg{Words: []string{rest}, Value: rest, File: true})
			}
			return out
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			out = append(out, MochaArg{Words: []string{a}, Value: a, File: true})
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimLeft(a, "-"), "=")
		item := MochaArg{Words: []string{a}, Name: name, Value: value}
		if !hasValue && nodeOptionsWithValue[name] && i+1 < len(args) {
			i++
			item.Words, item.Value = append(item.Words, args[i]), args[i]
		}
		out = append(out, item)
	}
	return out
}
