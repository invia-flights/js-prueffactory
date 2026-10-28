package gitstate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// Why the project's own git configuration is checked before git runs.
//
// `git status` can start programs that the repository's configuration names:
// `filter.<name>.clean|process|smudge` (switched on by a `.gitattributes`
// line), `core.fsmonitor`, `diff.external`, `core.pager`, `core.sshCommand`,
// helpers behind `extensions.partialclone` or `remote.<n>.promisor`, anything
// pulled in through `include.path` and more. The Original is untrusted input,
// so the Run must never let it run a command on the host.
//
// The decision: fail closed. git runs only when every file of the repository's
// own configuration (`config`, `config.worktree`) consists of nothing but
// allowlisted KEYS that cannot start a program, and every path git would
// follow was checked. Anything else (any other key, an include, a line the
// parser cannot classify, a NUL byte, a line ending in a backslash, a file
// that is not a small regular file) means git does not run at all: the commit
// is read from HEAD by Go code, the dirty state is "unknown", and a note
// becomes a Limitation. The user's global and system configuration are
// switched off for git as well (see Reader.git), as are attributes from
// outside the repository, lazy fetching and every transport protocol. Without
// a filter driver definition a `filter=` attribute is inert.
//
// What this does not close: the configuration could change between the check
// and the `git` call. The Original is not expected to be modified by an
// attacker while the Run reads it, and the Snapshot (not the Original) is what
// the Checks and containers see.

// safeKeys lists "section.key" (no subsection) and "section.*.key" (any
// subsection) names that only describe the repository and cannot run a
// program for `git status`.
var safeKeys = map[string]bool{
	"core.repositoryformatversion": true, "core.filemode": true, "core.bare": true,
	"core.logallrefupdates": true, "core.ignorecase": true, "core.precomposeunicode": true,
	"core.symlinks": true, "core.autocrlf": true, "core.eol": true, "core.safecrlf": true,
	"core.sparsecheckout": true, "core.sparsecheckoutcone": true, "core.untrackedcache": true,
	"user.name": true, "user.email": true,
	"submodule.active": true,
	"remote.*.url":     true, "remote.*.fetch": true, "remote.*.push": true, "remote.*.pushurl": true,
	"branch.*.remote": true, "branch.*.merge": true, "branch.*.rebase": true,
	"submodule.*.url": true, "submodule.*.active": true,
}

// configRisk returns why git must not run in the repository (empty if it may).
// A file that cannot be checked counts as a risk too.
func configRisk(ctx context.Context, gitDir, common string) string {
	files := []string{filepath.Join(common, "config"), filepath.Join(common, "config.worktree")}
	if gitDir != common {
		files = append(files, filepath.Join(gitDir, "config.worktree"))
	}
	for _, f := range files {
		b, err := readRegular(ctx, f, maxConfigFile)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Sprintf("the repository configuration %s cannot be checked: %v", filepath.Base(f), err)
		}
		if why := configFileRisk(string(b)); why != "" {
			return fmt.Sprintf("the repository configuration %s is not known to be harmless (%s)", filepath.Base(f), why)
		}
	}
	return ""
}

// configFileRisk checks one git configuration file against the allowlist of
// keys. It returns why the file is not known to be harmless, or "".
func configFileRisk(text string) string {
	if strings.ContainsRune(text, 0) {
		return "NUL byte"
	}
	section, sub := "", false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, " \t\r")
		// git continues a value over a backslash at the end of a line, but not
		// inside a comment, so this checker and git could read the next line
		// differently. Such a file is not examined further.
		if strings.HasSuffix(line, `\`) {
			return "line ending in a backslash"
		}
		line = strings.TrimLeft(line, " \t")
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if line[0] == '[' {
			var rest string
			var ok bool
			section, sub, rest, ok = parseSectionHeader(line)
			if !ok {
				return "unparseable section header"
			}
			line = strings.TrimLeft(rest, " \t")
			if line == "" || line[0] == '#' || line[0] == ';' {
				continue
			}
		}
		if section == "" {
			return "setting outside a section"
		}
		key := keyOf(line)
		if key == "" {
			return "unparseable line"
		}
		name := section + "." + key
		if sub {
			name = section + ".*." + key
		}
		if !safeKeys[name] {
			return name
		}
	}
	return ""
}

// parseSectionHeader parses `[name]` or `[name "sub"]` at the start of line.
// It returns the lower-case section name, whether there is a subsection and
// what follows `]`. The old `[name.sub]` form is not accepted.
func parseSectionHeader(line string) (name string, sub bool, rest string, ok bool) {
	i := 1
	for i < len(line) && (isAlnum(line[i]) || line[i] == '-') {
		i++
	}
	name = strings.ToLower(line[1:i])
	if name == "" || i >= len(line) {
		return "", false, "", false
	}
	switch line[i] {
	case ']':
		return name, false, line[i+1:], true
	case ' ', '\t':
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		if i >= len(line) || line[i] != '"' {
			return "", false, "", false
		}
		for i++; i < len(line); i++ {
			if line[i] == '\\' {
				i++
				continue
			}
			if line[i] == '"' {
				break
			}
		}
		if i+1 >= len(line) || line[i] != '"' || line[i+1] != ']' {
			return "", false, "", false
		}
		return name, true, line[i+2:], true
	}
	return "", false, "", false
}

// keyOf returns the lower-case variable name at the start of a `key = value`
// line, or "" if the line is not one.
func keyOf(line string) string {
	i := 0
	for i < len(line) && (isAlnum(line[i]) || line[i] == '-') {
		i++
	}
	if i == 0 || !isAlpha(line[0]) {
		return ""
	}
	key := strings.ToLower(line[:i])
	rest := strings.TrimLeft(line[i:], " \t")
	if rest == "" || rest[0] == '=' || rest[0] == '#' || rest[0] == ';' {
		return key
	}
	return ""
}

func isAlpha(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }
func isAlnum(c byte) bool { return isAlpha(c) || c >= '0' && c <= '9' }
