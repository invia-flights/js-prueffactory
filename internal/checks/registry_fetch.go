package checks

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/lockfile"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

//go:embed js/registry-data.js
var registryDataScript []byte

// The registry-data step is shared by deps.deprecated and deps.outdated: one
// fetch per package with an npm lockfile (version 2 or 3, or the lockfile its
// install produced), however many of the two Checks are selected. It runs an
// embedded Node script in a container of the package's Context image on
// Docker's default bridge network, as ADR-0004 allows in the Preparation phase,
// with the project's .npmrc and no host environment variables. The script
// resolves each package's registry the way npm does, asks at most 8 requests at
// a time and stops at the step's deadline.
//
// The data is never reused between Runs: every Run fetches its own, and the
// date of the fetch goes into the Report.
const (
	registryScriptPath = "/registry/registry-data.js"
	registryInputPath  = "/registry/input.json"
	// registryConcurrency is the most requests that run at once.
	registryConcurrency = 8
	// registryRequestTimeout is how long one request may take.
	registryRequestTimeout = 30 * time.Second
	// registryStepTimeout is the time limit of the step; the engine applies the
	// same limit to the Checks that run it (see timeLimit in internal/engine).
	registryStepTimeout = 5 * time.Minute
	// registryDeadlineMargin is what the script leaves of the Check's time to
	// start the container and to hand its answer back.
	registryDeadlineMargin = 15 * time.Second
	// maxUnknownNamed is how many names of unknown packages a message lists.
	maxUnknownNamed = 20
)

// registryDataApplicability is the Applicability of the Checks that read
// registry data: they examine the lockfile of a package, or the one its install
// produces.
func registryDataApplicability(id string, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, id + " examines the registry data of a package's dependencies, and this is the project Context"
	}
	if u := c.Package.NodeChoice.Unsupported; u != nil {
		return resultset.Applicable, "unsupported: " + u.Reason
	}
	if c.Package.NPMLockfile == "" {
		return resultset.Applicable, unsupportedInstallReason(c)
	}
	return resultset.Applicable, ""
}

// registryDataPrerequisites asks for the install only when the package has no
// lockfile, because then the lockfile its install produces is what is read.
func registryDataPrerequisites(c *discovery.Context) []string {
	if c.Package == nil || c.Package.NPMLockfile != "" || c.Package.InstallUnsupported != nil {
		return nil
	}
	return []string{packageInstallID}
}

// registryDataImages is the Node image of the package, when the step can run.
func registryDataImages(c *discovery.Context) []string {
	if c.Package == nil || c.Node == nil || (c.Package.NPMLockfile == "" && c.Package.InstallUnsupported != nil) {
		return nil
	}
	return []string{c.Node.Image}
}

// registryData is what the step made of one package: the locked versions, what
// the registry said about them, or why the data cannot be used.
type registryData struct {
	versions []lockedVersion
	asked    []registryRequestPackage
	answers  *registryAnswers
	// rejected are the registry entries of the lockfile with an invalid name or
	// version (see rejectedVersions). They are unknown, never fine.
	rejected []string
	// rejectedDirect are those of them that the manifest names.
	rejectedDirect []string
	// locate points a Finding at the lockfile entry of a locked version.
	locate func(key string) resultset.Location
	// lockfilePath is the path Limitations point at.
	lockfilePath string
	command      []string
	tool         *resultset.Tool
	// fail is set when the dependent Checks cannot use the data. The Checks
	// return a copy of it (see failed).
	fail *Result
}

// failed is the Result of a dependent Check when the data is unusable.
func (d *registryData) failed() *Result {
	r := *d.fail
	return &r
}

// result starts the Result of a dependent Check that has data to evaluate.
func (d *registryData) result() *Result {
	return &Result{
		Status: resultset.StatusCompleted, Command: d.command, Tool: d.tool,
		RegistryDataDate: d.answers.FetchedAt,
	}
}

// unknownNamed is the packages that are unknown, and a text that names up to
// maxUnknownNamed of them. Unknown are the packages the registry did not answer
// for and the lockfile entries whose name or version is no valid one, which
// were never asked about.
func (d *registryData) unknownNamed() (names []string, list string) {
	return unknownList(append(d.answers.unknownNames(d.asked), d.rejected...))
}

// unknownList sorts names and makes the text that names up to maxUnknownNamed of
// them. The names are text of the project: each goes into the list as quoted
// text (resultset.Quote), cut to a sensible length.
func unknownList(names []string) ([]string, string) {
	sort.Strings(names)
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = resultset.Quote(shorten(n, 100))
	}
	return names, strings.Join(cutList(quoted, maxUnknownNamed), ", ")
}

// unknownMetric is the Metric registry_unknown: how many packages the registry
// did not answer for, with their names. Those packages are never read as
// current or as not deprecated.
func (d *registryData) unknownMetric(checkID string) resultset.Metric {
	names, _ := d.unknownNamed()
	return d.unknownMetricOf(names)
}

// unknownMetricOf is registry_unknown for the given packages, for a Check that
// only cares about some of them.
func (d *registryData) unknownMetricOf(names []string) resultset.Metric {
	names, list := unknownList(names)
	m := resultset.Metric{Name: "registry_unknown", Value: floatPtr(len(names)), Unit: "packages"}
	if len(names) > 0 {
		m.Reason = &list
	}
	return m
}

// unknownCause is why the packages of the Gaps entry are unknown, as the
// deprecations Check sees it.
const unknownCause = "got no answer from the registry (HTTP 401, 403, 404, a timeout or another failure)"

// unknownLimitations is the Gaps entry for the unknown packages, or none.
func (d *registryData) unknownLimitations(checkID string) []resultset.Limitation {
	names, _ := d.unknownNamed()
	return d.unknownLimitationsOf(checkID, names, unknownCause)
}

// unknownLimitationsOf is the Gaps entry for the given packages, or none. cause
// finishes the sentence "N packages of the lockfile ...".
func (d *registryData) unknownLimitationsOf(checkID string, names []string, cause string) []resultset.Limitation {
	names, list := unknownList(names)
	if len(names) == 0 {
		return nil
	}
	noun := "packages"
	if len(names) == 1 {
		noun = "package"
	}
	path := d.lockfilePath
	return []resultset.Limitation{{
		ReasonCode: "registry_unknown_packages", CheckID: &checkID, Path: &path,
		Message: fmt.Sprintf("%d %s of the lockfile %s, so nothing is known about %s: %s",
			len(names), noun, cause, map[bool]string{true: "it", false: "them"}[len(names) == 1], list),
	}}
}

// registryData fetches the registry data of the package of the Context, once
// per Run however many Checks ask.
func (in *Input) registryData(ctx context.Context) *registryData {
	if in.Shared == nil {
		return in.fetchRegistryData(ctx)
	}
	v := in.Shared.Do(ctx, "registry-data/"+in.Context.ID, func(ctx context.Context) (any, bool) {
		// A fetch that was cut short by a cancelled or expired context says
		// nothing for the next caller, which has its own.
		return in.fetchRegistryData(ctx), ctx.Err() == nil
	})
	return v.(*registryData)
}

func (in *Input) fetchRegistryData(ctx context.Context) *registryData {
	pkg := in.Context.Package
	if u := pkg.NodeChoice.Unsupported; u != nil {
		return &registryData{fail: &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}}
	}
	src, unsupported := dependencyLockfile(in)
	if unsupported != nil {
		return &registryData{fail: unsupported}
	}
	d := &registryData{lockfilePath: src.path}
	if src.located != nil {
		d.locate = src.located.Location
	} else {
		d.locate = func(string) resultset.Location { return in.Location("primary", src.path, 0, 0) }
	}
	manifest := in.manifestOfPackage()
	d.versions = lockedVersions(src.lock, manifest)
	d.asked = registryRequestPackages(d.versions)
	d.rejected = rejectedVersions(src.lock)
	d.rejectedDirect = rejectedDirectVersions(src.lock, manifest)
	d.command = []string{"node", registryScriptPath}
	if len(d.asked) == 0 {
		// Nothing is resolved from a registry, so there is nothing to ask.
		d.answers = &registryAnswers{byName: map[string]*registryAnswer{}}
		return d
	}
	if in.Context.Node == nil || in.Docker == nil {
		d.fail = &Result{Status: resultset.StatusInfrastructureError, ReasonCode: "docker_setup_failed", Reason: "the registry-data step has no Node image to run in"}
		return d
	}

	input, err := json.Marshal(struct {
		NPMRC            string                   `json:"npmrc"`
		Packages         []registryRequestPackage `json:"packages"`
		Concurrency      int                      `json:"concurrency"`
		RequestTimeoutMS int64                    `json:"request_timeout_ms"`
		DeadlineMS       int64                    `json:"deadline_ms"`
	}{
		NPMRC: in.projectNPMRC(), Packages: d.asked, Concurrency: registryConcurrency,
		RequestTimeoutMS: registryRequestTimeout.Milliseconds(), DeadlineMS: registryDeadline(ctx).Milliseconds(),
	})
	if err != nil {
		d.fail = &Result{Status: resultset.StatusToolError, ReasonCode: "internal_error", Reason: err.Error()}
		return d
	}
	c, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "registry-" + strings.ToLower(in.Context.ID), Image: in.Context.Node.Image,
		Cmd: []string{"node", registryScriptPath, registryInputPath},
		Env: npmEnv(nil),
		// The fetch runs on Docker's default bridge, with outbound access, as
		// ADR-0004 allows in the Preparation phase.
		Preparation: true,
		Files: []docker.File{
			{Path: registryScriptPath, Mode: 0o644, Content: registryDataScript},
			{Path: registryInputPath, Mode: 0o644, Content: input},
		},
	})
	if err != nil {
		d.fail = failedToRun(&Result{}, err)
		return d
	}
	exit := c.ExitCode
	d.tool = &resultset.Tool{Name: "npm registry", ExitCode: &exit}
	if c.ExitCode != 0 || c.OOMKilled {
		d.fail = helperFailed(&Result{}, "registry-data", c, 400)
		return d
	}
	d.answers, err = readRegistryAnswers(c.Stdout)
	if err != nil {
		d.fail = &Result{Status: resultset.StatusToolError, ReasonCode: "helper_failed", Reason: err.Error()}
		return d
	}
	if code, reason := d.answers.allFailed(d.asked); code != "" {
		d.fail = &Result{Status: resultset.StatusBlocked, ReasonCode: code, Reason: reason, Command: d.command, Tool: d.tool}
	}
	return d
}

// registryDeadline is how long the script may run: what is left of the Check's
// time, less a margin, and never more than the step's limit.
func registryDeadline(ctx context.Context) time.Duration {
	limit := registryStepTimeout - registryDeadlineMargin
	if at, ok := ctx.Deadline(); ok {
		if left := time.Until(at) - registryDeadlineMargin; left < limit {
			limit = left
		}
	}
	if limit < 5*time.Second {
		limit = 5 * time.Second
	}
	return limit
}

// projectNPMRC is the text of the package's own .npmrc, which is where npm
// looks for the project's registry settings when it installs in the package's
// folder. A missing or unreadable file is no settings.
func (in *Input) projectNPMRC() string {
	data, err := readCapped(filepath.Join(packageFolder(in), ".npmrc"), 1<<20)
	if err != nil {
		return ""
	}
	return string(bytes.ToValidUTF8(data, nil))
}

// manifestOfPackage reads the package's package.json, or returns nil.
func (in *Input) manifestOfPackage() *lockfile.Manifest {
	data, err := readCapped(filepath.Join(packageFolder(in), "package.json"), maxProjectFileBytes)
	if err != nil {
		return nil
	}
	m, err := lockfile.ParseManifest(data)
	if err != nil {
		return nil
	}
	return m
}
