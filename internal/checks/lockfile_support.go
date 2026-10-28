package checks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// This file holds what the native lockfile Checks (security.integrity,
// security.licenses and package.install-scripts) share. They all read the Lock
// that internal/lockfile parses, report every package whose lockfile they
// cannot use as unsupported with the reason internal/lockfile gives, and point
// their Findings at the lockfile entry.

// lockfileApplicability is the Applicability of the lockfile Checks: they
// examine the npm lockfile of a package. A package of another package manager
// (a yarn, pnpm or Bun lockfile, or a `packageManager` field naming such a
// manager) is applicable too: its Run ends unsupported with the reason of
// package.install, so the Report shows that the Check did not look. A package
// without any lockfile has nothing to examine, and package.manifest already
// warns about the missing lockfile, so that is not a gap of these Checks.
func lockfileApplicability(id string, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, id + " examines the lockfile of a package, and this is the project Context"
	}
	// A package whose manager nothing set is an npm package. A package.json
	// that names another manager makes the package that manager's even next to
	// an npm lockfile.
	if m := c.Package.Manager; m != "" && m != lockfile.NPM {
		return resultset.Applicable, unsupportedInstallReason(c)
	}
	if c.Package.NPMLockfile != "" {
		return resultset.Applicable, ""
	}
	return resultset.NotApplicable, id + " examines the npm lockfile, and this package has no lockfile"
}

// packageLockfile is the lockfile of the package that a lockfile Check runs in.
type packageLockfile struct {
	in *Input
	// Dir is the package folder in the Snapshot copy.
	Dir    string
	Loaded *lockfile.Loaded
	// LockfilePath is the lockfile's path relative to the project root.
	LockfilePath string
	rawLock      []byte
}

// loadPackageLockfile reads the package's lockfile. When it cannot be used it
// returns the Result the Check hands back: unsupported, with the reason code
// and text of internal/lockfile. A version 1 lockfile, another package manager
// and a missing or broken lockfile are all gaps of these Checks, not defects:
// package.manifest reports the defects.
func loadPackageLockfile(in *Input) (*packageLockfile, *Result) {
	pkg := in.Context.Package
	dir := in.SnapshotDir
	if pkg.Path != "." {
		dir = filepath.Join(in.SnapshotDir, filepath.FromSlash(pkg.Path))
	}
	loaded := lockfile.Load(dir)
	if loaded.Lock == nil {
		u := loaded.Unsupported
		if u == nil {
			// Not reachable by the contract of Load, but never panic on it.
			u = &lockfile.Unsupported{Code: "no_lockfile", Reason: "the package has no usable lockfile"}
		}
		return nil, &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	l := &packageLockfile{in: in, Dir: dir, Loaded: loaded, LockfilePath: path.Join(pkg.Path, loaded.LockfileName)}
	l.rawLock, _ = readCapped(filepath.Join(dir, loaded.LockfileName), maxProjectFileBytes)
	return l, nil
}

// npmrcEntry is one `key=value` line of an .npmrc file.
type npmrcEntry struct{ key, value string }

// readNpmrc returns the settings of the project's own .npmrc, read from the
// package folder and, for a nested package, from the project root too.
// Comments and lines without `=` are skipped. Nothing is interpolated: a value
// with `${VAR}` stays as it is.
func readNpmrc(in *Input, pkgDir string) []npmrcEntry {
	dirs := []string{pkgDir}
	if filepath.Clean(pkgDir) != filepath.Clean(in.SnapshotDir) {
		dirs = append(dirs, in.SnapshotDir)
	}
	var out []npmrcEntry
	for _, dir := range dirs {
		data, err := readCapped(filepath.Join(dir, ".npmrc"), 1<<20)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || line[0] == ';' || line[0] == '#' {
				continue
			}
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			out = append(out, npmrcEntry{strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)})
		}
	}
	return out
}

// Keys returns the entry paths of the lockfile in sorted order, without the
// root package.
func (l *packageLockfile) Keys() []string {
	keys := make([]string, 0, len(l.Loaded.Lock.Packages))
	for k := range l.Loaded.Lock.Packages {
		if k != "" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// Location points at the entry's line in the lockfile.
func (l *packageLockfile) Location(key string) resultset.Location {
	line, col := 0, 0
	needle, _ := json.Marshal(key)
	needle = append(needle, ':')
	if i := bytes.Index(l.rawLock, needle); i >= 0 {
		line = 1 + bytes.Count(l.rawLock[:i], []byte{'\n'})
		col = i - bytes.LastIndexByte(l.rawLock[:i], '\n')
	}
	return l.in.Location("primary", l.LockfilePath, line, col)
}

// Finding fills the fields every lockfile Finding shares. The message names
// the entry in backticks first, so a reader and an agent see which package it
// is about.
func (l *packageLockfile) Finding(checkID, rule, key string, kind resultset.FindingKind, sev resultset.Severity, title, message string) resultset.Finding {
	r := rule
	in := l.in
	return resultset.Finding{
		CheckID: checkID, ContextID: in.Context.ID, RuleID: &r,
		Fingerprint: resultset.NewFingerprint(checkID, rule, l.LockfilePath, key),
		Kind:        kind, Severity: sev, Confidence: resultset.ConfidenceConfirmed,
		Title: title, Message: fmt.Sprintf("`%s` %s", key, message),
		Locations: []resultset.Location{l.Location(key)},
		Evidence:  []resultset.Evidence{}, Reproduction: in.Reproduction(checkID),
		Limitations: []string{},
	}
}
