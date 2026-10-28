package checks

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

func init() { Register(depsSecurityID, securityDependencies{}) }

const depsSecurityID = "security.dependencies"

// securityDependencies reports known vulnerabilities in the locked dependency
// versions of a package, with osv-scanner and its offline advisory database.
//
// It scans one lockfile per package. The lockfile is copied into the scan
// container, so the scan sees nothing else of the project, in particular no
// project osv-scanner.toml that could silence advisories. A package without a
// lockfile is scanned with the lockfile its install produced, which is why the
// Check then lists package.install as a prerequisite.
//
// Advisory matches are reported per package version and vulnerability. They
// are no Gates. Packages that the advisory data cannot cover are counted in a
// metric and never reported as clean.
type securityDependencies struct{}

// scannable says whether the Check has a lockfile to scan in a Context, or can
// get one by installing.
func scannable(c *discovery.Context) bool {
	if c.Package == nil {
		return false
	}
	return c.Package.NPMLockfile != "" || c.Package.InstallUnsupported == nil
}

func (securityDependencies) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, depsSecurityID + " examines the lockfile of a package, and this is the project Context"
	}
	if c.Package.NPMLockfile == "" {
		return resultset.Applicable, unsupportedInstallReason(c)
	}
	return resultset.Applicable, ""
}

// Prerequisites asks for the install only when the package has no lockfile.
func (securityDependencies) Prerequisites(c *discovery.Context) []string {
	if c.Package == nil || c.Package.NPMLockfile != "" || c.Package.InstallUnsupported != nil {
		return nil
	}
	return []string{packageInstallID}
}

// Images tells the engine which image Run will use.
func (securityDependencies) Images(c *discovery.Context) []string {
	if !scannable(c) {
		return nil
	}
	return []string{toolset.OSVScanner.Image.Ref()}
}

func (securityDependencies) UsesAdvisoryDB(c *discovery.Context) bool { return scannable(c) }

// producedLockfileKey is where package.install leaves the lockfile it
// produced, in the Run's Shared store.
func producedLockfileKey(contextID string) string { return "npm-lockfile/" + contextID }

// The scan container sees the lockfile under this name, whatever it was called
// in the project (npm-shrinkwrap.json is the same format).
const (
	scanDir      = "/scan"
	scanLockfile = scanDir + "/package-lock.json"
	scanConfig   = scanDir + "/osv-scanner.toml"
)

// osvArgs is the command line after the executable. The lockfile is named with
// its type, so osv-scanner never reads the part before a colon in the path as
// a type, and the scan reads our empty config instead of the project's
// osv-scanner.toml. It uses the offline database only.
var osvArgs = []string{
	"scan", "--offline-vulnerabilities",
	"--verbosity", "error", "--format", "json",
	// --all-packages lists the packages without advisories too, which is how
	// the Check knows what the scan covered.
	"--all-packages",
	"--config", scanConfig,
	"-L", "package-lock.json:" + scanLockfile,
}

// osv-scanner's exit codes: 1 means it found vulnerabilities, 128 that the
// lockfile held no packages.
const (
	osvVulnerabilitiesFound = 1
	osvNoPackages           = 128
)

func (securityDependencies) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	res := &Result{Command: append([]string{"osv-scanner"}, osvArgs...)}

	src, unsupported := dependencyLockfile(in)
	if unsupported != nil {
		return unsupported
	}
	if in.AdvisoryError != "" || in.AdvisoryVolume == "" {
		reason := in.AdvisoryError
		if reason == "" {
			reason = "the Preparation phase did not provide the advisory database"
		}
		res.Status, res.ReasonCode, res.Reason = resultset.StatusInfrastructureError, "advisory_database_unavailable", reason
		return res
	}

	digest := toolset.OSVScanner.Image.Digest
	date := in.AdvisoryDate.UTC().Format(time.RFC3339)
	res.ToolRefs = []resultset.ToolRef{
		{Name: toolset.OSVScanner.Name, Version: toolset.OSVScanner.Version, Digest: &digest},
		// The date of the advisory data is part of what a result depends on.
		{Name: "osv-advisory-database", Version: date},
	}

	c, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "osv-" + strings.ToLower(in.Context.ID), Image: toolset.OSVScanner.Image.Ref(),
		Cmd: osvArgs, WorkDir: scanDir, Network: in.Network,
		Env:    map[string]string{"OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY": toolvolume.AdvisoryCacheDir},
		Mounts: []docker.Mount{{Volume: in.AdvisoryVolume, Path: toolvolume.AdvisoryMountPath, ReadOnly: true}},
		Files: []docker.File{
			{Path: scanLockfile, Mode: 0o644, Content: src.scanRaw},
			{Path: scanConfig, Mode: 0o644, Content: nil},
		},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	exit := c.ExitCode
	version := toolset.OSVScanner.Version
	res.Tool = &resultset.Tool{Name: toolset.OSVScanner.Name, Version: &version, ExitCode: &exit}
	if exit != 0 && exit != osvVulnerabilitiesFound && exit != osvNoPackages {
		res.Status, res.ReasonCode = resultset.StatusToolError, "tool_failed"
		res.Reason = fmt.Sprintf("osv-scanner exited with %d: %s", exit, tail(string(c.Stderr), 400))
		return res
	}

	verdict := judgeScan(exit, c.Stdout, src.scanLock)
	if f := verdict.Fail; f != nil {
		res.Status, res.ReasonCode, res.Reason = f.Status, f.Code, f.Reason
		return res
	}
	advisories := verdict.Advisories

	for _, a := range advisories {
		res.Findings = append(res.Findings, in.dependencyFinding(a, src, date))
	}
	notCovered := float64(len(notCoveredPackages(src.lock)))
	res.Metrics = append(res.Metrics, resultset.Metric{Name: "not_covered_by_advisory_data", Value: &notCovered, Unit: "packages"})
	if l := notCoveringLimitation(src.lock, src.path); l != nil {
		res.Limitations = append(res.Limitations, *l)
	}
	if in.AdvisoryWarning != "" {
		id := depsSecurityID
		p := path.Join(pkg.Path, "package.json")
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "advisory_database_stale",
			Message:    fmt.Sprintf("the advisory database is from %s and is older than 24 hours, because %s", date, in.AdvisoryWarning),
			CheckID:    &id, Path: &p,
		})
	}
	res.Status = resultset.StatusCompleted
	if verdict.Partial != "" {
		id := depsSecurityID
		p := src.path
		res.Status, res.ReasonCode, res.Reason = resultset.StatusPartial, "scanner_package_mismatch", verdict.Partial
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "scanner_package_mismatch", Message: verdict.Partial, CheckID: &id, Path: &p,
		})
	}
	return res
}

// scanFailure says why a scan cannot be trusted at all.
type scanFailure struct {
	Status resultset.ExecStatus
	Code   string
	Reason string
}

// scanVerdict is what the Check makes of osv-scanner's answer.
type scanVerdict struct {
	Advisories []advisory
	// Fail is set when the scan says nothing about the lockfile.
	Fail *scanFailure
	// Partial is set, with the explanation, when the scan saw fewer packages
	// than the lockfile lists: what it did not see is not clean.
	Partial string
}

// judgeScan reads osv-scanner's exit code and report against the lockfile that
// was scanned. osv-scanner and internal/lockfile parse the lockfile
// separately, so a scan that saw nothing or less than the lockfile lists must
// never read as a clean result: the two parsers disagree, and what was not
// scanned is unknown.
func judgeScan(exit int, report []byte, lock *lockfile.Lock) scanVerdict {
	locked := lockedPackages(lock)
	sawNothing := scanVerdict{Fail: &scanFailure{
		Status: resultset.StatusToolError, Code: "scanner_saw_no_packages",
		Reason: fmt.Sprintf("osv-scanner found no packages in a lockfile that lists %d, so nothing was scanned", len(locked)),
	}}
	if exit == osvNoPackages {
		if len(locked) > 0 {
			return sawNothing
		}
		return scanVerdict{}
	}
	advisories, err := interpretOSV(report, lock)
	if err != nil {
		return scanVerdict{Fail: &scanFailure{
			Status: resultset.StatusToolError, Code: "report_unreadable",
			Reason: "the osv-scanner report could not be read: " + err.Error(),
		}}
	}
	if exit == osvVulnerabilitiesFound && len(advisories) == 0 {
		// It said it found something and we read nothing: never call that clean.
		return scanVerdict{Fail: &scanFailure{
			Status: resultset.StatusToolError, Code: "report_unreadable",
			Reason: "osv-scanner reported vulnerabilities, but the report names none",
		}}
	}
	seen := scannedPackages(report)
	if len(seen) == 0 && len(locked) > 0 {
		return sawNothing
	}
	// Compare the sets, not the counts: a count hides a package that was missed
	// next to one that was added.
	missing, extra := differences(locked, seen)
	if len(missing) == 0 && len(extra) == 0 {
		return scanVerdict{Advisories: advisories}
	}
	var parts []string
	if len(missing) > 0 {
		parts = append(parts, fmt.Sprintf("osv-scanner did not see %d of the %d packages the lockfile lists, so they were not checked for advisories: %s",
			len(missing), len(locked), capped(missing)))
	}
	if len(extra) > 0 {
		parts = append(parts, fmt.Sprintf("osv-scanner reports %d packages the lockfile does not list, so the two readers of the lockfile disagree: %s",
			len(extra), capped(extra)))
	}
	return scanVerdict{Advisories: advisories, Partial: strings.Join(parts, "; ")}
}

// differences returns, sorted, what is in want but not in got, and what is in
// got but not in want.
func differences(want, got map[string]bool) (missing, extra []string) {
	for k := range want {
		if !got[k] {
			missing = append(missing, k)
		}
	}
	for k := range got {
		if !want[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return missing, extra
}

// maxNamedPairs caps the package versions a message lists.
const maxNamedPairs = 10

func capped(pairs []string) string {
	return strings.Join(cutList(pairs, maxNamedPairs), ", ")
}

// dependencySource is the lockfile a scan reads.
type dependencySource struct {
	raw  []byte
	lock *lockfile.Lock
	// path is the project path that Findings point at: the lockfile, or for a
	// lockfile that only the install produced, the package.json.
	path string
	// produced is true for the lockfile of a package that had none.
	produced bool
	// scanRaw and scanLock are the lockfile as the scan sees it, without the
	// entries that are no registry packages (see scannableLockfile).
	scanRaw  []byte
	scanLock *lockfile.Lock
	// located finds the entry's line in a lockfile of the project.
	located *packageLockfile
}

// newDependencySource prepares the copy of the lockfile that is scanned.
func newDependencySource(src *dependencySource) (*dependencySource, *Result) {
	fail := func(err error) (*dependencySource, *Result) {
		return nil, &Result{Status: resultset.StatusToolError, ReasonCode: "lockfile_unreadable",
			Reason: "the lockfile could not be prepared for the scan: " + err.Error()}
	}
	raw, _, err := scannableLockfile(src.raw)
	if err != nil {
		return fail(err)
	}
	lock, err := lockfile.ParseLock(raw)
	if err != nil {
		return fail(err)
	}
	src.scanRaw, src.scanLock = raw, lock
	return src, nil
}

// dependencyLockfile finds the lockfile to scan. When it cannot be used it
// returns the Result the Check hands back: unsupported, with a reason code.
func dependencyLockfile(in *Input) (*dependencySource, *Result) {
	pkg := in.Context.Package
	if pkg.NPMLockfile != "" {
		l, unsupported := loadPackageLockfile(in)
		if unsupported != nil {
			return nil, unsupported
		}
		return newDependencySource(&dependencySource{raw: l.rawLock, lock: l.Loaded.Lock, path: l.LockfilePath, located: l})
	}
	if u := pkg.InstallUnsupported; u != nil {
		return nil, &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	var raw []byte
	if in.Shared != nil {
		if v, ok := in.Shared.Get(producedLockfileKey(in.Context.ID)); ok {
			raw, _ = v.([]byte)
		}
	}
	if len(raw) == 0 {
		return nil, &Result{Status: resultset.StatusUnsupported, ReasonCode: "no_lockfile",
			Reason: "the package has no lockfile, and its install produced none to scan"}
	}
	lock, err := lockfile.ParseLock(raw)
	if err != nil {
		return nil, &Result{Status: resultset.StatusUnsupported, ReasonCode: "lockfile_unreadable",
			Reason: "the lockfile that npm install produced cannot be used: " + err.Error()}
	}
	return newDependencySource(&dependencySource{raw: raw, lock: lock, path: path.Join(pkg.Path, "package.json"), produced: true})
}

// primaryAdvisoryID is the ID that names an advisory: the first that is not a
// CVE alias, because CVE IDs name the same problem in other databases.
func primaryAdvisoryID(ids []string) string {
	for _, id := range ids {
		if !strings.HasPrefix(id, "CVE-") {
			return id
		}
	}
	return ids[0]
}

// advisorySeverity maps the advisory severity to the severity of a Finding.
// The advisory severity itself stays visible in the Finding's text and evidence.
func advisorySeverity(level string) resultset.Severity {
	switch level {
	case "critical", "high":
		return resultset.SeverityError
	case "moderate":
		return resultset.SeverityWarning
	}
	return resultset.SeverityNote
}

func (in *Input) dependencyFinding(a advisory, src *dependencySource, date string) resultset.Finding {
	rule := primaryAdvisoryID(a.IDs)
	ids := strings.Join(a.IDs, ", ")
	var loc resultset.Location
	if src.located != nil && a.LockKey != "" {
		loc = src.located.Location(a.LockKey)
	} else {
		loc = in.Location("primary", src.path, 0, 0)
	}

	fixed := "no fixed version is known"
	var expected *string
	if a.Fixed != "" {
		fixed = "fixed in " + a.Fixed
		e := fmt.Sprintf("%s %s or later", a.Package, a.Fixed)
		expected = &e
	}
	actual := fmt.Sprintf("%s %s", a.Package, a.Version)
	locked := "the lockfile"
	if src.produced {
		locked = "the lockfile that npm install produced, because the package has none"
	}
	message := fmt.Sprintf("`%s` %s, a %s dependency in %s, is affected by %s (advisory severity %s); %s. Advisory database of %s.",
		a.Package, a.Version, a.Scope, locked, ids, a.Severity, fixed, date)

	f := resultset.Finding{
		CheckID: depsSecurityID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(depsSecurityID, rule, src.path, a.Package+"@"+a.Version),
		Kind:        resultset.KindDefect, Severity: advisorySeverity(a.Severity),
		Confidence: resultset.ConfidenceLikely,
		Title:      fmt.Sprintf("Known vulnerability %s in %s %s", rule, a.Package, a.Version),
		Message:    message,
		Locations:  []resultset.Location{loc},
		Expected:   expected, Actual: &actual,
		Reproduction: in.Reproduction(depsSecurityID),
		Limitations:  []string{},
	}
	add := func(kind, text string) {
		f.Evidence = append(f.Evidence, Untrusted(kind, text, "osv-scanner"))
	}
	add("advisory_ids", ids)
	add("advisory_severity", a.Severity)
	if a.SeverityNote != "" {
		add("advisory_severity_note", a.SeverityNote)
	}
	add("dependency_scope", a.Scope)
	if a.Fixed != "" {
		add("fixed_version", a.Fixed)
	}
	add("advisory_database_date", date)
	if a.Summary != "" {
		add("advisory_summary", a.Summary)
	}
	return f
}
