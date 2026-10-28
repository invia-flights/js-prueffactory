package checks

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

//go:embed js/depcruise.js
var cruiseScript []byte

//go:embed config/depcruise.json
var cruiseRules []byte

func init() { Register(cyclesID, cycles{}) }

const cyclesID = "modules.cycles"

// cycles runs dependency-cruiser from the toolset volume on the Source code of
// a package, after the install, with a rule file of our own: the project's
// dependency-cruiser configuration is never read. The two rules are no-circular
// and not-to-dev-dep. Their hits are warnings and never Gates. Imports the
// cruiser cannot resolve, such as path aliases that only a bundler knows, can
// hide a cycle, and are listed as a Limitation.
type cycles struct{}

func (cycles) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "modules.cycles examines packages, and this is the project Context"
	}
	if targets, held := cruiseTargets(c); len(targets)+len(held) == 0 {
		return resultset.NotApplicable, "the package has no JavaScript files in Source code"
	}
	return resultset.Applicable, unsupportedInstallReason(c)
}

func (cycles) Prerequisites(*discovery.Context) []string { return []string{packageInstallID} }

func (cycles) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (cycles) Images(c *discovery.Context) []string { return cyclesImages(c) }

// UsesToolset says that dependency-cruiser comes from the toolset volume.
func (cycles) UsesToolset(c *discovery.Context) bool { return len(cyclesImages(c)) > 0 }

func cyclesImages(c *discovery.Context) []string {
	if c.Package == nil || c.Package.InstallUnsupported != nil {
		return nil
	}
	if targets, held := cruiseTargets(c); len(targets)+len(held) == 0 {
		return nil
	}
	return []string{toolImage()}
}

// cruiseExtension says whether dependency-cruiser parses a file in a plain
// install: TypeScript needs a compiler that milestone 1 does not install.
func cruiseExtension(rel string) bool {
	switch path.Ext(rel) {
	case ".js", ".cjs", ".mjs", ".jsx":
		return true
	}
	return false
}

// globCharacters are the characters with which dependency-cruiser would read a
// file name as a glob. The names come from the project, so a file whose name
// has one is not passed at all.
const globCharacters = `*?[]{}()!\`

// cruiseTargets returns the package-relative JavaScript files of Source code to
// cruise, sorted, and the ones held back because their names read as globs.
// Test code is not production code, and Test data and Build output are not the
// project's own.
func cruiseTargets(c *discovery.Context) (targets, held []string) {
	for _, f := range c.Package.Files {
		if f.Class != discovery.Source || !cruiseExtension(f.PackageRel) {
			continue
		}
		if strings.ContainsAny(f.PackageRel, globCharacters) {
			held = append(held, f.PackageRel)
			continue
		}
		targets = append(targets, f.PackageRel)
	}
	sort.Strings(targets)
	sort.Strings(held)
	return targets, held
}

// The helper's output.
type cruiseViolation struct {
	Rule      string   `json:"rule"`
	From      string   `json:"from"`
	To        string   `json:"to"`
	Specifier string   `json:"specifier"`
	Cycle     []string `json:"cycle"`
}

type cruiseUnresolved struct {
	From   string `json:"from"`
	Module string `json:"module"`
}

type cruiseResult struct {
	Version      string             `json:"version"`
	TotalCruised int                `json:"total_cruised"`
	Violations   []cruiseViolation  `json:"violations"`
	Unresolved   []cruiseUnresolved `json:"unresolved"`
	// Edges maps each cruised file to the package's own files it imports,
	// lazy requires inside functions included.
	Edges map[string][]string `json:"edges"`
	Error string              `json:"error"`
}

func (cycles) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("dependency-cruiser")
	}
	targets, held := cruiseTargets(in.Context)
	helperIn, _ := json.Marshal(struct {
		Depcruise string   `json:"depcruise"`
		Config    string   `json:"config"`
		Root      string   `json:"root"`
		Files     []string `json:"files"`
	}{
		Depcruise: toolvolume.ToolBin + "/dependency-cruiser/bin/dependency-cruiser.mjs",
		Config:    "/jspf/depcruise.json", Root: workPath(pkg), Files: nonNil(targets),
	})

	res := &Result{Command: []string{"node", "/jspf/depcruise.js", "/jspf/input.json"}}
	c, err := in.Docker.RunContainer(ctx, in.toolContainer("cruise", res.Command,
		docker.File{Path: "/jspf/depcruise.js", Mode: 0o644, Content: cruiseScript},
		docker.File{Path: "/jspf/depcruise.json", Mode: 0o644, Content: cruiseRules},
		docker.File{Path: "/jspf/input.json", Mode: 0o644, Content: helperIn},
	))
	if err != nil {
		return failedToRun(res, err)
	}
	var out cruiseResult
	if c.ExitCode != 0 || json.Unmarshal(c.Stdout, &out) != nil {
		toolRun(res, "dependency-cruiser")
		exit := c.ExitCode
		res.Tool.ExitCode = &exit
		helperFailed(res, "dependency-cruiser", c, 800)
		return res
	}
	r := interpretCycles(in, out, held, in.cyclesEntryPoints(ctx, targets))
	r.Command = res.Command
	return r
}

// productionEntries are the production entry points of a package.
type productionEntries struct {
	// Files are the package-relative entry points, the ones package.json
	// names first, then the ones the deployment files start.
	Files []string
	// Started holds the entry points that only a deployment file names.
	Started map[string]startedEntry
}

// cyclesEntryPoints returns the production entry points of the package among
// the cruised files: the ones package.json names and the ones the project's
// deployment files start. Files is empty when there are none.
func (in *Input) cyclesEntryPoints(ctx context.Context, targets []string) productionEntries {
	manifest, err := readCapped(filepath.Join(packageFolder(in), "package.json"), maxProjectFileBytes)
	if err != nil {
		return productionEntries{}
	}
	cruised := map[string]bool{}
	for _, t := range targets {
		cruised[t] = true
	}
	exists := func(p string) bool {
		_, ok := regularFile(filepath.Join(packageFolder(in), filepath.FromSlash(p)))
		return ok
	}
	entries := productionEntries{Files: productionEntryPoints(manifest, cruised, exists), Started: map[string]startedEntry{}}
	for _, s := range deploymentEntryPoints(in.projectDeploymentCommands(ctx), in.Context.Package.Path, manifest, cruised) {
		if !slices.Contains(entries.Files, s.File) {
			entries.Files = append(entries.Files, s.File)
			entries.Started[s.File] = s
		}
	}
	return entries
}

// cruiseMaxFindings caps the Findings of one execution.
const cruiseMaxFindings = 2000

// interpretCycles turns the helper's output into Findings. held lists the files
// that were not given to the cruiser. Like the files ESLint cannot parse, they
// are a Limitation and not a reason to call the Check partial: a project with a
// `[id].js` file should not be incomplete for that.
//
// entries are the package's production entry points. A devDependency import
// is reported only in a file they reach through the import edges, so a dev
// script that only an npm script runs may use devDependencies; a Finding names
// the deployment file that starts its entry point, when one does. Without
// entry points every cruised file counts, and a Limitation says so; the Check
// still completes, because it then reports more, not less. Cycles are reported
// wherever they are.
func interpretCycles(in *Input, out cruiseResult, held []string, entries productionEntries) *Result {
	res := &Result{}
	toolRun(res, "dependency-cruiser")
	if out.Error != "" {
		res.Status, res.ReasonCode = resultset.StatusToolError, "dependency_cruiser_failed"
		res.Reason = "dependency-cruiser failed: " + out.Error
		return res
	}
	// Every Limitation is about this package, so each names its package.json.
	id, manifest := cyclesID, in.manifestPath()
	pkgPath := in.Context.Package.Path
	var reached map[string]string
	if len(entries.Files) > 0 {
		reached = reachedFrom(entries.Files, out.Edges)
	}

	seen := map[string]bool{}
	for _, v := range out.Violations {
		var f *resultset.Finding
		switch v.Rule {
		case "no-circular":
			f = in.cycleFinding(pkgPath, v, seen)
		case "not-to-dev-dep":
			entry, ok := reached[v.From]
			if reached != nil && !ok {
				continue
			}
			f = in.devDependencyFinding(pkgPath, v, inProject(pkgPath, entry), entries.Started[entry], seen)
		}
		if f != nil {
			res.Findings = append(res.Findings, *f)
		}
	}
	sort.SliceStable(res.Findings, func(i, j int) bool {
		a, b := res.Findings[i], res.Findings[j]
		if a.Locations[0].Path != b.Locations[0].Path {
			return a.Locations[0].Path < b.Locations[0].Path
		}
		return a.Fingerprint.Value < b.Fingerprint.Value
	})

	res.Status = resultset.StatusCompleted
	if len(res.Findings) > cruiseMaxFindings {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &id, Path: &manifest,
			Message: fmt.Sprintf("The Report keeps the first %d Findings of dependency-cruiser; %d more were found and are left out.", cruiseMaxFindings, len(res.Findings)-cruiseMaxFindings),
		})
		res.Findings = res.Findings[:cruiseMaxFindings]
		res.Status = resultset.StatusPartial
		res.ReasonCode = "findings_cut"
		res.Reason = "dependency-cruiser found more than the Report keeps"
	}
	if len(out.Unresolved) > 0 {
		var specs []string
		for _, u := range out.Unresolved {
			specs = append(specs, u.Module)
		}
		sort.Strings(specs)
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "imports_not_resolved", CheckID: &id, Path: &manifest,
			Message: "dependency-cruiser could not resolve these imports, which may be path aliases that only a bundler or compiler configuration knows, so a cycle through them is not seen: " +
				strings.Join(cutList(specs, 20), ", "),
		})
	}
	if len(entries.Files) == 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "production_entry_points_unknown", CheckID: &id, Path: &manifest,
			Message: "No production entry point of this package was found among the cruised files, so every Source code file counts as production code for devDependency imports. Looked for: " +
				entryPointsLookedFor + ".",
		})
	}
	if len(held) > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "files_not_scanned", CheckID: &id, Path: &manifest,
			Message: "These files have glob characters in their names, which dependency-cruiser would read as patterns, and were not scanned: " +
				strings.Join(cutList(held, 20), ", "),
		})
	}
	return res
}

// inProject turns a path relative to the package into one relative to the
// project, or "" when it leaves the project.
func inProject(pkgPath, rel string) string {
	p := path.Join(pkgPath, rel)
	if p == ".." || strings.HasPrefix(p, "../") || path.IsAbs(p) {
		return ""
	}
	return p
}

// cycleFinding builds the Finding of a cycle, or nil for one already reported.
// dependency-cruiser reports a cycle from each of its edges, so the members are
// sorted to give every view of the cycle one Finding and one fingerprint.
func (in *Input) cycleFinding(pkgPath string, v cruiseViolation, seen map[string]bool) *resultset.Finding {
	ring := v.Cycle
	if len(ring) == 0 {
		ring = []string{v.From, v.To}
	}
	// The ring closes on the file it started from; keep each member once.
	members := map[string]bool{}
	for _, m := range ring {
		members[m] = true
	}
	members[v.From] = true
	var sorted []string
	for m := range members {
		p := inProject(pkgPath, m)
		if p == "" {
			return nil
		}
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	key := strings.Join(sorted, "\x00")
	if seen[key] {
		return nil
	}
	seen[key] = true

	// Show the ring from its smallest member, in the order of the imports.
	shown := make([]string, 0, len(ring)+1)
	for _, m := range ring {
		shown = append(shown, inProject(pkgPath, m))
	}
	if shown[0] != shown[len(shown)-1] {
		shown = append(shown, shown[0])
	}
	shown = shown[:len(shown)-1]
	start := 0
	for i, m := range shown {
		if m < shown[start] {
			start = i
		}
	}
	shown = append(append([]string{}, shown[start:]...), shown[:start]...)
	shown = append(shown, shown[0])

	rule := "circular-import"
	locs := []resultset.Location{in.Location("primary", sorted[0], 0, 0)}
	for _, p := range sorted[1:] {
		locs = append(locs, in.Location("related", p, 0, 0))
	}
	chain := strings.Join(shown, " -> ")
	return &resultset.Finding{
		CheckID: cyclesID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(cyclesID, rule, sorted[0], strings.Join(sorted, " ")),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning,
		Confidence:   resultset.ConfidenceConfirmed,
		Title:        "Modules import each other in a cycle",
		Message:      "Circular import: " + chain + ".",
		Locations:    locs,
		Evidence:     []resultset.Evidence{Untrusted("tool_output", chain, "dependency-cruiser")},
		Reproduction: in.Reproduction(cyclesID),
		Limitations:  []string{},
	}
}

// devDependencyFinding builds the Finding of production code that imports a
// package that is only a devDependency. entry is the project-relative entry
// point that reaches the file, or "" when the entry points are unknown, and
// startedBy says which deployment file starts it, when one does. The
// fingerprint leaves both out, so a Finding keeps its identity either way.
func (in *Input) devDependencyFinding(pkgPath string, v cruiseViolation, entry string, startedBy startedEntry, seen map[string]bool) *resultset.Finding {
	from := inProject(pkgPath, v.From)
	spec := v.Specifier
	if from == "" || spec == "" {
		return nil
	}
	key := "dev\x00" + from + "\x00" + spec
	if seen[key] {
		return nil
	}
	seen[key] = true

	rule := "dev-dependency-in-production"
	var runBy string
	if startedBy.DeploymentFile != "" {
		runBy = fmt.Sprintf(" (run by `%s` through `%s`)", startedBy.DeploymentFile, startedBy.Command)
	}
	subject := from
	switch entry {
	case "":
	case from:
		subject = fmt.Sprintf("%s, a production entry point%s,", from, runBy)
	default:
		subject = fmt.Sprintf("%s, reached from the production entry point `%s`%s,", from, entry, runBy)
	}
	msg := fmt.Sprintf("%s imports `%s`, which package.json lists only under devDependencies, so it is missing wherever only production dependencies are installed.", subject, spec)
	return &resultset.Finding{
		CheckID: cyclesID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(cyclesID, rule, from, spec),
		Kind:        resultset.KindDefect, Severity: resultset.SeverityWarning,
		Confidence:   resultset.ConfidenceLikely,
		Title:        "Production code imports a devDependency",
		Message:      msg,
		Locations:    []resultset.Location{in.Location("primary", from, 0, 0)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", spec, "dependency-cruiser")},
		Reproduction: in.Reproduction(cyclesID),
		Limitations:  []string{},
	}
}
