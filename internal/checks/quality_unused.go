package checks

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

func init() { Register(unusedID, unused{}) }

const unusedID = "quality.unused"

// unusedMaxFindings caps the Findings of one execution, so that a project that
// uses almost none of its exports cannot flood the Report.
const unusedMaxFindings = 2000

// unused runs Knip from the toolset volume on the installed dependencies in the
// Working copy, with the project's own Knip configuration when there is one.
// Undeclared and unresolvable imports are warnings. Unused files, exports and
// dependencies are notes, because dynamic loading and a public API can use code
// that Knip cannot see. It never fires a Gate.
type unused struct{}

// toolImage is the pinned Node image of the toolset's own tools that read the
// installed dependencies. Knip and dependency-cruiser need a newer Node than an
// old package may run on, and they only read the Working copy.
func toolImage() string {
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	return img.Ref()
}

// isScannableSource says whether a file is JavaScript or TypeScript that the
// graph tools read.
func isScannableSource(rel string) bool {
	switch path.Ext(rel) {
	case ".js", ".cjs", ".mjs", ".jsx", ".ts", ".mts", ".cts", ".tsx":
		return true
	}
	return false
}

// hasCodeToExamine says whether a package has Source code or Test code that
// the graph tools read.
func hasCodeToExamine(c *discovery.Context) bool {
	for _, f := range c.Package.Files {
		if (f.Class == discovery.Source || f.Class == discovery.TestCode) && isScannableSource(f.PackageRel) {
			return true
		}
	}
	return false
}

func (unused) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "quality.unused examines packages, and this is the project Context"
	}
	if !hasCodeToExamine(c) {
		return resultset.NotApplicable, "the package has no JavaScript or TypeScript files outside Test data and Build output"
	}
	return resultset.Applicable, unsupportedInstallReason(c)
}

func (unused) Prerequisites(*discovery.Context) []string { return []string{packageInstallID} }

func (unused) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (unused) Images(c *discovery.Context) []string { return toolImages(c) }

// UsesToolset says that Knip comes from the toolset volume.
func (unused) UsesToolset(c *discovery.Context) bool { return len(toolImages(c)) > 0 }

// toolImages is the Images answer of the Checks that run a toolset tool on the
// installed dependencies: none for a package that cannot be installed.
func toolImages(c *discovery.Context) []string {
	if c.Package == nil || c.Package.InstallUnsupported != nil || !hasCodeToExamine(c) {
		return nil
	}
	return []string{toolImage()}
}

// toolContainer is the container that runs a toolset tool in the package's
// folder of the Working copy. Both are mounted read-only: the tools only read.
// The container joins the Run's network, which has no way out.
func (in *Input) toolContainer(name string, cmd []string, files ...docker.File) docker.ContainerSpec {
	return docker.ContainerSpec{
		Name:  name + "-" + strings.ToLower(in.Context.ID),
		Image: toolImage(),
		Cmd:   cmd,
		// Config loaders cache compiled files next to the project by default.
		Env:     map[string]string{"JITI_FS_CACHE": "false", "JITI_CACHE": "false", "NO_COLOR": "1", "CI": "1"},
		WorkDir: workPath(in.Context.Package),
		Network: in.Network,
		Mounts: []docker.Mount{
			{Volume: in.WorkVolume, Path: workMount, ReadOnly: true},
			{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
		},
		Files: files,
	}
}

// toolRun records the pinned tool in the Result.
func toolRun(res *Result, name string) {
	version := ""
	if tool, ok := toolset.NPMTool(name); ok {
		version = tool.Version
		integrity := tool.Integrity
		res.ContextTools = []resultset.ToolRef{{Name: tool.Name, Version: tool.Version, Digest: &integrity}}
	}
	res.Tool = &resultset.Tool{Name: name, Version: &version}
}

func (unused) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("Knip")
	}
	// No path of the project is an argument: Knip finds its entry files itself,
	// from the project's manifest and configuration.
	res := &Result{Command: []string{"node", toolvolume.ToolBin + "/knip/bin/knip.js",
		"--reporter", "json", "--no-exit-code", "--no-progress", "--no-config-hints", "--no-tag-hints"}}
	c, err := in.Docker.RunContainer(ctx, in.toolContainer("knip", res.Command))
	if err != nil {
		return failedToRun(res, err)
	}
	if c.ExitCode != 0 {
		exit := c.ExitCode
		toolRun(res, "knip")
		res.Tool.ExitCode = &exit
		res.Status, res.ReasonCode = resultset.StatusToolError, "knip_failed"
		res.Reason = fmt.Sprintf("Knip exited with %d: %s", c.ExitCode, tail(string(c.Stderr)+" "+string(c.Stdout), 800))
		if c.OOMKilled {
			res.Reason = "Knip ran out of memory: " + res.Reason
		}
		return res
	}
	stdout, command := c.Stdout, res.Command
	var second []resultset.Limitation
	// Files that Mocha loads are invisible to Knip. Run it again with them as
	// entry files, unless the project's own config is in charge.
	if cfg, ok := in.knipSecondRunConfig(stdout); ok {
		again := append(append([]string{}, res.Command...), "--config", knipGeneratedConfigPath)
		c2, err := in.Docker.RunContainer(ctx, in.toolContainer("knip-mocha", again,
			docker.File{Path: knipGeneratedConfigPath, Mode: 0o644, Content: cfg}))
		if err == nil && c2.ExitCode == 0 {
			stdout, command = c2.Stdout, again
		} else {
			// The first report, corrected as far as it goes, is still true.
			id := unusedID
			second = append(second, resultset.Limitation{
				ReasonCode: "knip_second_run_failed", CheckID: &id,
				Message: "Knip's second run, with the files that Mocha loads as entry files, did not finish, so files that only those files import may be reported as unused.",
			})
		}
	}
	out := interpretKnip(in, stdout)
	out.Command = command
	out.Limitations = append(out.Limitations, second...)
	return out
}

// knipGeneratedConfigPath is where the generated Knip config is put in the
// container. It is outside the project, which the tool never writes to.
const knipGeneratedConfigPath = "/jspf/knip.json"

// knipItem is one entry of an issue type in Knip's JSON report.
type knipItem struct {
	Name string `json:"name"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

// knipIssue is the report's entry for one file. Types that Knip adds later are
// ignored.
type knipIssue struct {
	File         string     `json:"file"`
	Files        []knipItem `json:"files"`
	Dependencies []knipItem `json:"dependencies"`
	DevDeps      []knipItem `json:"devDependencies"`
	OptionalPeer []knipItem `json:"optionalPeerDependencies"`
	Unlisted     []knipItem `json:"unlisted"`
	Binaries     []knipItem `json:"binaries"`
	Unresolved   []knipItem `json:"unresolved"`
	Exports      []knipItem `json:"exports"`
	Types        []knipItem `json:"types"`
}

// knipKind describes how one issue type becomes a Finding.
type knipKind struct {
	rule     string
	title    string
	severity resultset.Severity
	// message is formatted with the item's name.
	message string
}

var (
	knipUnlisted   = knipKind{"unlisted-dependency", "An import names a package that package.json does not declare", resultset.SeverityWarning, "`%s` is imported but not declared in package.json."}
	knipUnresolved = knipKind{"unresolved-import", "An import cannot be resolved", resultset.SeverityWarning, "`%s` is imported but cannot be resolved."}
	knipFile       = knipKind{"unused-file", "A file is not used by anything", resultset.SeverityNote, "%s is not reachable from any entry file."}
	knipExport     = knipKind{"unused-export", "An export is not used", resultset.SeverityNote, "The export `%s` is not imported anywhere."}
	knipType       = knipKind{"unused-type", "An exported type is not used", resultset.SeverityNote, "The exported type `%s` is not used anywhere."}
	knipDep        = knipKind{"unused-dependency", "A dependency is not used", resultset.SeverityNote, "The dependency `%s` is declared in package.json but never used."}
	knipDevDep     = knipKind{"unused-dev-dependency", "A devDependency is not used", resultset.SeverityNote, "The devDependency `%s` is declared in package.json but never used."}
	knipOptPeer    = knipKind{"unused-optional-peer-dependency", "An optional peer dependency is not used", resultset.SeverityNote, "The optional peer dependency `%s` is declared in package.json but never used."}
	knipBinary     = knipKind{"unlisted-binary", "A script runs a binary that no dependency provides", resultset.SeverityNote, "The binary `%s` is used but no declared dependency provides it."}
)

// interpretKnip turns Knip's JSON report into Findings. Files in Test data and
// Build output are not code the project means to use, so nothing is reported
// for them.
func interpretKnip(in *Input, stdout []byte) *Result {
	res := &Result{}
	toolRun(res, "knip")
	issues, loadedFiles, err := in.correctKnip(stdout)
	if err != nil {
		res.Status, res.ReasonCode = resultset.StatusToolError, "knip_output_unreadable"
		res.Reason = "Knip wrote no JSON report: " + tail(string(stdout), 400)
		return res
	}
	// A file that Mocha loads is used. With a generated config that made them
	// entry files, Knip does not report them; with the project's own config it
	// does, and the Report says what the correction cannot do.
	mochaLoaded := map[string]bool{}
	for _, f := range loadedFiles {
		mochaLoaded[f] = true
	}
	if len(loadedFiles) > 0 && in.hasOwnKnipConfig() {
		id := unusedID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "mocha_loaded_files_not_traced", CheckID: &id,
			Message: fmt.Sprintf("Mocha loads %s, which Knip cannot see. The project has its own Knip config, which is left alone, so files that only they import may still be reported as unused.",
				strings.Join(cutList(loadedFiles, 20), ", ")),
		})
	}

	pkg := in.Context.Package
	classOf := map[string]discovery.FileClass{}
	for _, f := range pkg.Files {
		classOf[f.PackageRel] = f.Class
	}

	var found []resultset.Finding
	add := func(file string, k knipKind, items []knipItem) {
		if cl := classOf[file]; cl == discovery.BuildOutput || cl == discovery.TestData {
			return
		}
		for _, it := range items {
			found = append(found, in.knipFinding(file, k, it))
		}
	}
	for _, issue := range issues {
		// A file with unused code is reported under its own name, and an unused
		// dependency under package.json. Names come from the tool, so a path
		// that leaves the package is dropped rather than trusted.
		if issue.File == "" || path.IsAbs(issue.File) || strings.HasPrefix(path.Clean(issue.File), "..") {
			continue
		}
		file := path.Clean(issue.File)
		for _, it := range issue.Files {
			if mochaLoaded[file] {
				continue
			}
			// The unused file is the entry's own file.
			it.Name = file
			add(file, knipFile, []knipItem{it})
		}
		add(file, knipDep, issue.Dependencies)
		add(file, knipDevDep, issue.DevDeps)
		add(file, knipOptPeer, issue.OptionalPeer)
		add(file, knipUnlisted, issue.Unlisted)
		add(file, knipBinary, issue.Binaries)
		add(file, knipUnresolved, issue.Unresolved)
		add(file, knipExport, issue.Exports)
		add(file, knipType, issue.Types)
	}
	sort.SliceStable(found, func(i, j int) bool {
		a, b := found[i].Locations[0], found[j].Locations[0]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		al, bl := 0, 0
		if a.Start != nil {
			al = a.Start.Line
		}
		if b.Start != nil {
			bl = b.Start.Line
		}
		if al != bl {
			return al < bl
		}
		return found[i].Fingerprint.Value < found[j].Fingerprint.Value
	})
	if len(found) > unusedMaxFindings {
		id := unusedID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &id,
			Message: fmt.Sprintf("The Report keeps the first %d Findings of Knip; %d more were found and are left out.", unusedMaxFindings, len(found)-unusedMaxFindings),
		})
		found = found[:unusedMaxFindings]
		res.Status = resultset.StatusPartial
		res.ReasonCode = "findings_cut"
		res.Reason = "Knip found more than the Report keeps"
	} else {
		res.Status = resultset.StatusCompleted
	}
	res.Findings = found
	return res
}

func (in *Input) knipFinding(file string, k knipKind, it knipItem) resultset.Finding {
	rel := path.Join(in.Context.Package.Path, file)
	rule := k.rule
	kind, confidence := resultset.KindHint, resultset.ConfidenceSuspected
	if k.severity == resultset.SeverityWarning {
		kind, confidence = resultset.KindDefect, resultset.ConfidenceLikely
	}
	name := it.Name
	if k.rule == knipFile.rule {
		name = rel
	}
	return resultset.Finding{
		CheckID: unusedID, ContextID: in.Context.ID, RuleID: &rule,
		Fingerprint: resultset.NewFingerprint(unusedID, rule, rel, name),
		Kind:        kind, Severity: k.severity, Confidence: confidence, Gate: false,
		Title:        k.title,
		Message:      fmt.Sprintf(k.message, name),
		Locations:    []resultset.Location{in.Location("primary", rel, it.Line, it.Col)},
		Evidence:     []resultset.Evidence{Untrusted("tool_output", name, "knip")},
		Reproduction: in.Reproduction(unusedID),
		Limitations:  []string{},
	}
}
