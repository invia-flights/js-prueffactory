package checks

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() { Register(packageManifestID, packageManifest{}) }

const packageManifestID = "package.manifest"

// packageManifest parses each package's package.json and lockfile in Go, on the
// host-side Snapshot copy. It needs no container, so it implements no
// ImageUser. The parsing lives in internal/lockfile, which the other lockfile
// Checks share.
//
// Gates: a package.json or lockfile that does not parse, a manifest dependency
// the lockfile lacks, and a specifier that differs from the lockfile's. Warnings:
// no lockfile, and lockfiles of several package managers. A lockfile that this
// release cannot read (version 1, another package manager, workspaces) is no
// defect: the Check is partial and says why.
type packageManifest struct{}

// Rule IDs of package.manifest.
const (
	ruleManifestInvalid    = "manifest-invalid"
	ruleLockfileInvalid    = "lockfile-invalid"
	ruleMissingDependency  = "lockfile-missing-dependency"
	ruleSpecifierMismatch  = "lockfile-specifier-mismatch"
	ruleLockfileMissing    = "lockfile-missing"
	ruleMultipleLockfiles  = "lockfile-multiple-managers"
	packageManagerMetricID = "package_manager"
)

func (packageManifest) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "package.manifest examines packages, and this is the project Context"
	}
	return resultset.Applicable, ""
}

func (packageManifest) Run(_ context.Context, in *Input) *Result {
	pkg := in.Context.Package
	res := &Result{}
	rel := func(name string) string { return path.Join(pkg.Path, name) }
	dir := in.SnapshotDir
	if pkg.Path != "." {
		dir = path.Join(in.SnapshotDir, pkg.Path)
	}
	loaded := lockfile.Load(dir)

	var manifestSyntax, lockSyntax *lockfile.SyntaxError
	switch {
	case loaded.ManifestErr == nil:
	case errors.As(loaded.ManifestErr, &manifestSyntax):
		res.Findings = append(res.Findings, in.syntaxFinding(ruleManifestInvalid, rel("package.json"),
			"package.json does not parse", manifestSyntax))
	default:
		return readFailure(res, rel("package.json"), loaded.ManifestErr)
	}
	switch {
	case loaded.LockErr == nil:
	case errors.As(loaded.LockErr, &lockSyntax):
		res.Findings = append(res.Findings, in.syntaxFinding(ruleLockfileInvalid, rel(loaded.LockfileName),
			"The lockfile is broken", lockSyntax))
	default:
		return readFailure(res, rel(loaded.LockfileName), loaded.LockErr)
	}

	if loaded.Manifest != nil && loaded.Lock != nil {
		for _, m := range lockfile.Check(loaded.Manifest, loaded.Lock) {
			res.Findings = append(res.Findings, in.mismatchFinding(m, rel("package.json"), loaded.LockfileName))
		}
	}
	if len(loaded.Lockfiles) == 0 {
		res.Findings = append(res.Findings, in.noLockfileFinding(rel("package.json")))
	}
	if managers := loaded.Managers(); len(managers) > 1 {
		res.Findings = append(res.Findings, in.multipleLockfilesFinding(loaded, rel))
	}

	res.Metrics = []resultset.Metric{packageManagerMetric(loaded)}
	res.Status = resultset.StatusCompleted

	// A lockfile the Check cannot read is a gap, not a defect. A missing or
	// broken lockfile is already reported as a Finding above.
	if u := loaded.Unsupported; u != nil && u.Code != "no_lockfile" && u.Code != "lockfile_invalid" {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusPartial, u.Code, u.Reason
		id := packageManifestID
		lim := resultset.Limitation{ReasonCode: u.Code, Message: u.Reason, CheckID: &id}
		if loaded.LockfileName != "" {
			p := rel(loaded.LockfileName)
			lim.Path = &p
		}
		res.Limitations = append(res.Limitations, lim)
	}
	return res
}

// readFailure turns a file that exists but cannot be read into a tool error.
func readFailure(res *Result, file string, err error) *Result {
	res.Status, res.ReasonCode = resultset.StatusToolError, "read_failed"
	res.Reason = fmt.Sprintf("cannot read %s: %v", file, err)
	return res
}

// finding fills the fields every package.manifest Finding shares.
func (in *Input) manifestFinding(rule, fingerprintText string, file string) resultset.Finding {
	r := rule
	return resultset.Finding{
		CheckID: packageManifestID, ContextID: in.Context.ID, RuleID: &r,
		Fingerprint: resultset.NewFingerprint(packageManifestID, rule, file, fingerprintText),
		Kind:        resultset.KindDefect, Confidence: resultset.ConfidenceConfirmed,
		Evidence: []resultset.Evidence{}, Reproduction: in.Reproduction(packageManifestID),
		Limitations: []string{},
	}
}

func (in *Input) syntaxFinding(rule, file, title string, se *lockfile.SyntaxError) resultset.Finding {
	f := in.manifestFinding(rule, title, file)
	f.Severity, f.Gate = resultset.SeverityError, true
	f.Title = title
	f.Message = "npm cannot read this file, so nothing can be installed from it: " + se.Message + "."
	f.Locations = []resultset.Location{in.Location("primary", file, se.Line, se.Column)}
	return f
}

func (in *Input) mismatchFinding(m lockfile.Mismatch, manifestFile, lockName string) resultset.Finding {
	rule := ruleMissingDependency
	if m.Kind == lockfile.SpecifierMismatch {
		rule = ruleSpecifierMismatch
	}
	f := in.manifestFinding(rule, m.Section+" "+m.Name, manifestFile)
	f.Severity, f.Gate = resultset.SeverityError, true
	expected := m.Specifier
	f.Expected = &expected
	f.Locations = []resultset.Location{in.Location("primary", manifestFile, 0, 0)}
	switch m.Kind {
	case lockfile.MissingDependency:
		f.Title = "The lockfile does not contain a dependency of package.json"
		f.Message = fmt.Sprintf("%s declares %s@%s in %s, but %s does not install it, so `npm ci` fails.",
			path.Base(manifestFile), m.Name, m.Specifier, m.Section, lockName)
		actual := "not in " + lockName
		f.Actual = &actual
	default:
		f.Title = "A dependency specifier differs from the lockfile"
		f.Message = fmt.Sprintf("%s declares %s@%s in %s, but %s records %s, so `npm ci` fails.",
			path.Base(manifestFile), m.Name, m.Specifier, m.Section, lockName, m.LockSpecifier)
		actual := m.LockSpecifier
		f.Actual = &actual
	}
	return f
}

func (in *Input) noLockfileFinding(manifestFile string) resultset.Finding {
	f := in.manifestFinding(ruleLockfileMissing, "no lockfile", manifestFile)
	f.Severity = resultset.SeverityWarning
	f.Title = "The package has no lockfile"
	f.Message = "Without a lockfile, `npm install` resolves the newest matching versions, so two Runs can install different code. Commit a package-lock.json."
	f.Locations = []resultset.Location{in.Location("primary", manifestFile, 0, 0)}
	return f
}

func (in *Input) multipleLockfilesFinding(l *lockfile.Loaded, rel func(string) string) resultset.Finding {
	var names []string
	var locations []resultset.Location
	for _, lf := range l.Lockfiles {
		names = append(names, lf.Name)
		role := "related"
		if len(locations) == 0 {
			role = "primary"
		}
		locations = append(locations, in.Location(role, rel(lf.Name), 0, 0))
	}
	f := in.manifestFinding(ruleMultipleLockfiles, strings.Join(names, " "), rel("package.json"))
	f.Severity = resultset.SeverityWarning
	f.Title = "Lockfiles of several package managers"
	f.Message = fmt.Sprintf("The package holds %s. Only one of them is kept up to date, and it is unclear which versions are meant. Treated as a %s package.",
		strings.Join(names, ", "), l.Manager)
	f.Locations = locations
	return f
}

// packageManagerMetric records the detected manager. The Report schema has no
// field for it yet, so it goes into a Metric without a value and with the
// answer as its reason.
func packageManagerMetric(l *lockfile.Loaded) resultset.Metric {
	var by string
	switch l.Source {
	case "lockfile":
		var names []string
		for _, lf := range l.Lockfiles {
			if lf.Manager == l.Manager {
				names = append(names, lf.Name)
			}
		}
		by = "found by " + strings.Join(names, ", ")
	case "packageManager":
		by = "found by the packageManager field"
	case "deno.json":
		by = "found by deno.json"
	default:
		by = "assumed: no lockfile and no packageManager field"
	}
	reason := fmt.Sprintf("%s (%s)", l.Manager, by)
	return resultset.Metric{Name: packageManagerMetricID, Reason: &reason, Unit: "name"}
}
