package checks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register("quality.suppressions", qualitySuppressions{}) }

// qualitySuppressions counts comment Suppressions in Source code and Test code
// by kind and File class. It is native: it reads the host-side Snapshot copy
// and starts no container. Test data and Build output are not counted, because
// Test data may contain them on purpose and generated files are not the
// project's own choice.
//
// The same pass records the SHA-256 of every Test code file and of every test,
// lint, coverage and TypeScript config file, manifest and lockfile in the
// Inventory. Suppressions set in config files are not counted, and the hashes
// are what makes a change to them visible.
type qualitySuppressions struct{}

const qualitySuppressionsID = "quality.suppressions"

func (qualitySuppressions) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package != nil {
		return resultset.NotApplicable, "quality.suppressions examines the whole project, and this is a package Context"
	}
	return resultset.Applicable, ""
}

// suppressionKinds lists the kinds in report order, each with the pattern that
// follows a comment opener. Closing and re-enabling forms such as
// `eslint-enable`, `c8 ignore stop` and `jscpd:ignore-end` are not Suppressions.
var suppressionKinds = []struct{ kind, pattern string }{
	{"eslint-disable", `eslint-disable(?:-next-line|-line)?\b`},
	{"biome-ignore", `biome-ignore(?:-all|-start)?\b`},
	{"@ts-ignore", `@ts-ignore\b`},
	{"@ts-expect-error", `@ts-expect-error\b`},
	{"@ts-nocheck", `@ts-nocheck\b`},
	{"c8 ignore", `c8\s+ignore\s+(?:next|start|file)\b`},
	{"istanbul ignore", `istanbul\s+ignore\s+(?:next|if|else|file)\b`},
	{"node:coverage ignore", `node:coverage\s+(?:ignore\s+next|disable)\b`},
	{"gitleaks:allow", `gitleaks:allow\b`},
	{"hadolint ignore", `hadolint\s+ignore\s*=`},
	{"shellcheck disable", `shellcheck\s+disable\s*=`},
	{"jscpd:ignore-start", `jscpd:ignore-start\b`},
	{"stryker disable", `(?i:stryker\s+disable\b)`},
	{"njsscan-ignore", `njsscan-ignore\b`},
	{"nosemgrep", `nosemgrep\b`},
}

// suppressionRE finds a directive that starts a comment: a comment opener
// (`//`, `/*`, a leading `*` of a block comment, `#` or `<!--`), optional
// white space, then one of the kinds, each in its own capture group. A word in
// a string or in the middle of a sentence is therefore not counted.
var suppressionRE = func() *regexp.Regexp {
	alts := make([]string, len(suppressionKinds))
	for i, k := range suppressionKinds {
		alts[i] = "(" + k.pattern + ")"
	}
	return regexp.MustCompile(`(?:/{2,}|/\*+|<!--|#|^\s*\*+)\s*(?:` + strings.Join(alts, "|") + `)`)
}()

// countSuppressions returns the number of Suppressions of each kind in a file.
func countSuppressions(data []byte) map[string]int {
	counts := map[string]int{}
	for _, line := range strings.Split(string(data), "\n") {
		for _, m := range suppressionRE.FindAllStringSubmatch(line, -1) {
			for i, kind := range suppressionKinds {
				if m[i+1] != "" {
					counts[kind.kind]++
				}
			}
		}
	}
	return counts
}

// configRole returns the Inventory role of a test, lint, coverage or TypeScript
// config file, a manifest or a lockfile, or "" for any other file.
func configRole(rel string) string {
	base := path.Base(rel)
	switch base {
	case "package.json":
		return "manifest"
	case "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb":
		return "lockfile"
	case ".eslintignore", "biome.json", "biome.jsonc":
		return "lint_config"
	}
	hasPrefix := func(prefixes ...string) bool {
		for _, p := range prefixes {
			if strings.HasPrefix(base, p) {
				return true
			}
		}
		return false
	}
	switch {
	case hasPrefix(".mocharc", "jest.config.", "vitest.config.", "vitest.workspace.", "ava.config.", "karma.conf.", ".taprc"):
		return "test_config"
	case hasPrefix("eslint.config.", ".eslintrc"):
		return "lint_config"
	case hasPrefix(".c8rc", ".nycrc", "c8.config.", ".istanbul"):
		return "coverage_config"
	case (strings.HasPrefix(base, "tsconfig") || strings.HasPrefix(base, "jsconfig")) && strings.HasSuffix(base, ".json"):
		return "typescript_config"
	}
	return ""
}

func (qualitySuppressions) Run(_ context.Context, in *Input) *Result {
	res := &Result{
		Status: resultset.StatusCompleted,
		Limitations: []resultset.Limitation{{
			ReasonCode: "config_suppressions_not_counted",
			Message: "Suppressions set in config files, such as ESLint rule overrides, ignore patterns and TypeScript " +
				"compiler options, are not counted. The Inventory's config file hashes make changes to them visible.",
			CheckID: strPointer(qualitySuppressionsID),
		}},
	}

	type key struct{ kind, class string }
	counts := map[key]int{}
	inv := &resultset.Inventory{}
	unreadable := 0
	var firstErr error
	var tooLarge []string

	for _, f := range in.Project.Files {
		if f.Class == discovery.TestData || f.Class == discovery.BuildOutput {
			continue
		}
		role := configRole(f.Path)
		if role == "" && f.Class == discovery.TestCode {
			role = "test_code"
		}
		data, err := readProjectFile(in, f.Path)
		if errors.Is(err, errNotRegular) {
			continue
		}
		if errors.Is(err, errTooLarge) {
			tooLarge = append(tooLarge, f.Path)
			continue
		}
		if err != nil {
			if unreadable++; firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", f.Path, err)
			}
			continue
		}
		if role != "" {
			sum := sha256.Sum256(data)
			inv.FileHashes = append(inv.FileHashes, resultset.FileHash{Path: f.Path, Role: role, SHA256: hex.EncodeToString(sum[:])})
		}
		if isBinary(data) || isProse(f.Path) {
			continue
		}
		for kind, n := range countSuppressions(data) {
			counts[key{kind, string(f.Class)}] += n
		}
	}

	for _, k := range suppressionKinds {
		for _, class := range []discovery.FileClass{discovery.Source, discovery.TestCode} {
			if n := counts[key{k.kind, string(class)}]; n > 0 {
				inv.Suppressions = append(inv.Suppressions, resultset.SuppressionCount{Kind: k.kind, FileClass: string(class), Count: n})
			}
		}
	}
	sort.Slice(inv.FileHashes, func(i, j int) bool { return inv.FileHashes[i].Path < inv.FileHashes[j].Path })
	res.Inventory = inv
	res.Limitations = append(res.Limitations, tooLargeLimitation(qualitySuppressionsID, tooLarge)...)

	if unreadable > 0 {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = fmt.Sprintf("%d file(s) could not be read and are not counted or hashed, for example %v", unreadable, firstErr)
	}
	return res
}

// isProse reports whether a file is documentation. Its text talks about
// directives instead of using them, so it is not scanned.
func isProse(rel string) bool {
	switch strings.ToLower(path.Ext(rel)) {
	case ".md", ".markdown", ".txt", ".rst", ".adoc":
		return true
	}
	return false
}

func strPointer(s string) *string { return &s }
