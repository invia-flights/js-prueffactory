package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

func init() { Register(typesJavascriptID, typesJavascript{}) }

const typesJavascriptID = "types.javascript"

// typesJavascript lets TypeScript 7 check the JavaScript of a package, in the
// basic profile: JSDoc and inference, with `strict` and `noImplicitAny` off. It
// shows contract errors that the project never promised to be free of, so
// every error is a warning and never a Gate.
//
// TypeScript runs from the toolset volume on the toolset's own Node image, like
// ESLint, and reads the package's installed dependencies in the Working copy,
// which it mounts read-only. The tsconfig is ours: it is written next to the
// helper files outside the Working copy, so that nothing in the project, not
// even a tsconfig.json or jsconfig.json for its editor, changes what is
// measured and nothing is written to the project's folder.
//
// TypeScript files in the package's Source code (.ts, .tsx, .mts, .cts) are
// checked together with the JavaScript, with the same profile, so a mostly
// JavaScript package with a few TypeScript files is measured like any other.
// The exception is a package whose Discovery says it needs a build step and
// that has TypeScript sources: the JavaScript that runs is a build product
// there, and the Check is unsupported with the reason, like syntax.parse.
// Because the project's own tsconfig is not read, errors that only exist for
// that reason (path aliases, project references, custom lib settings) are
// counted, and a Limitation names the likely cause when they are a flood.
type typesJavascript struct{}

const (
	// typesConfigPath is where the generated tsconfig lies in the container.
	typesConfigPath = "/jspf/tsconfig.json"
	// typesMaxFindings caps the Findings of one package, so that a large
	// untyped codebase cannot turn the Report into noise. The cut is reported.
	typesMaxFindings = 2000
	// A Limitation says the Check ran without the project's tsconfig when at
	// least typesFloodMin Findings are resolution errors and they are more than
	// 1 in typesFloodShare of all Findings.
	typesFloodMin   = 5
	typesFloodShare = 5
)

// typesResolutionCodes are the TS codes of errors that a missing project
// tsconfig causes: a module, namespace or global that TypeScript cannot find
// because it does not see the project's path aliases, project references,
// custom lib or types settings, or an extension rule of the project's module
// settings. Plain type mismatches, and unknown names in the code itself
// (TS2304), are not among them.
var typesResolutionCodes = map[string]bool{
	"TS2307": true, "TS2792": true, // cannot find module
	"TS2834": true, "TS2835": true, // relative import needs an explicit extension
	"TS2503": true,                                 // cannot find namespace
	"TS2580": true, "TS2581": true, "TS2582": true, // missing @types: node, jQuery, test runner
	"TS2591": true, "TS2592": true, "TS2593": true,
	"TS2583": true, "TS2584": true, // missing lib: Promise, console, ...
}

// typesIsDeclaration says whether a file only declares types for JavaScript.
func typesIsDeclaration(rel string) bool {
	return strings.HasSuffix(rel, ".d.ts") || strings.HasSuffix(rel, ".d.mts") || strings.HasSuffix(rel, ".d.cts")
}

// typesCandidate says whether the Check gives a file to TypeScript: JavaScript,
// TypeScript (.tsx parses because the generated config sets jsx) and
// declaration files. JSX in .jsx files is not given.
func typesCandidate(rel string) bool {
	return typesIsDeclaration(rel) || eslintCandidate(rel) || discovery.IsTypeScript(rel)
}

// typesApplicability explains why the Check cannot or need not run in a
// Context. A Context that has JavaScript and can be checked gives Applicable
// and no reason; unsupported packages are Applicable with an "unsupported"
// reason, as for the other Checks that need the install.
func typesApplicability(c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "types.javascript examines packages, and this is the project Context"
	}
	if reason := unsupportedInstallReason(c); reason != "" {
		return resultset.Applicable, reason
	}
	if _, reason := typesUnsupported(c.Package); reason != "" {
		return resultset.Applicable, "unsupported: " + reason
	}
	for _, f := range c.Package.Files {
		if f.Class == discovery.Source && typesCandidate(f.PackageRel) {
			return resultset.Applicable, ""
		}
	}
	return resultset.NotApplicable, "the package's Source code has no .js, .cjs, .mjs, .ts, .tsx, .mts or .cts files"
}

// typesUnsupported returns the reason code and reason when the package needs a
// build step and has TypeScript files in its Source code. Discovery decides
// what needs a build step (a Babel or bundler config, or a tsconfig.json that
// emits next to TypeScript sources); a tsconfig.json only for the editor does
// not.
func typesUnsupported(pkg *discovery.Package) (code, reason string) {
	if pkg.BuildStepReason == "" {
		return "", ""
	}
	var ts []string
	for _, f := range pkg.Files {
		if f.Class == discovery.Source && discovery.IsTypeScript(f.PackageRel) {
			ts = append(ts, f.Path)
		}
	}
	if len(ts) == 0 {
		return "", ""
	}
	sort.Strings(ts)
	return "build_step_required", fmt.Sprintf("the package needs a build step before its JavaScript can run (%s), so its TypeScript sources (%s) are not checked",
		pkg.BuildStepReason, strings.Join(cutList(ts, 3), ", "))
}

func (typesJavascript) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return typesApplicability(c)
}

// runnable says whether the Check starts a container in the Context.
func typesRunnable(c *discovery.Context) bool {
	app, reason := typesApplicability(c)
	return app == resultset.Applicable && reason == ""
}

// Prerequisites is the install, except for a package that is unsupported
// whatever the install does.
func (typesJavascript) Prerequisites(c *discovery.Context) []string {
	if c.Package != nil {
		if _, reason := typesUnsupported(c.Package); reason != "" {
			return nil
		}
	}
	return []string{packageInstallID}
}

func (typesJavascript) UsesWorkingCopy() bool { return true }

// Images tells the engine which image Run will use.
func (typesJavascript) Images(c *discovery.Context) []string {
	if !typesRunnable(c) {
		return nil
	}
	return []string{typesImage()}
}

// UsesToolset says that TypeScript comes from the toolset volume.
func (typesJavascript) UsesToolset(c *discovery.Context) bool { return typesRunnable(c) }

func typesImage() string {
	img, _ := toolset.NodeImage(toolset.DefaultNodeMajor, toolset.VariantDebian)
	return img.Ref()
}

// typesTargets lists the files of the package's Source code that TypeScript is
// given, relative to the package folder and sorted. Only regular files count,
// so a link in the project never leads out of the Snapshot.
func typesTargets(in *Input) []string {
	var out []string
	for _, f := range in.Context.Package.Files {
		if f.Class != discovery.Source || !typesCandidate(f.PackageRel) {
			continue
		}
		if _, ok := regularFile(filepath.Join(packageFolder(in), filepath.FromSlash(f.PackageRel))); !ok {
			continue
		}
		out = append(out, f.PackageRel)
	}
	sort.Strings(out)
	return out
}

// tsTarget is the ECMAScript target that matches a Node version, from the
// language level its V8 supports. An unknown version gets the default Node's.
func tsTarget(node string) string {
	digits := node
	for i, r := range node {
		if r < '0' || r > '9' {
			digits = node[:i]
			break
		}
	}
	major, err := strconv.Atoi(digits)
	switch {
	case err != nil || major >= 24:
		return "es2024"
	case major >= 20:
		return "es2023"
	case major >= 18:
		return "es2022"
	case major >= 16:
		return "es2021"
	case major >= 14:
		return "es2020"
	}
	return "es2019"
}

// typesTsconfig builds the tsconfig of the run: the basic profile, with the
// files as literal absolute paths in the Working copy. Types come from the
// package's own node_modules, folder by folder up to the Working copy, and then
// from the toolset, so that @types/node and @types/mocha fill in only where the
// project lacks them.
func typesTsconfig(files []string, pkgPath, nodeVersion string, mocha bool) ([]byte, error) {
	return typesTsconfigFor(files, pkgPath, nodeVersion, mocha, false)
}

// typesTsconfigFor is typesTsconfig with `strict` and `noImplicitAny` on or off.
// types.strictness runs both profiles over the same files and settings.
func typesTsconfigFor(files []string, pkgPath, nodeVersion string, mocha, strict bool) ([]byte, error) {
	folder := workMount
	if pkgPath != "." {
		folder += "/" + pkgPath
	}
	var roots []string
	for dir := folder; ; dir = path.Dir(dir) {
		roots = append(roots, dir+"/node_modules/@types")
		if dir == workMount {
			break
		}
	}
	roots = append(roots, toolvolume.ToolBin+"/@types")

	types := []string{"node"}
	if mocha {
		types = append(types, "mocha")
	}
	abs := make([]string, 0, len(files))
	for _, f := range files {
		abs = append(abs, folder+"/"+f)
	}
	return json.MarshalIndent(map[string]any{
		"compilerOptions": map[string]any{
			"allowJs": true, "checkJs": true, "noEmit": true,
			"strict": strict, "noImplicitAny": strict,
			// Nothing is emitted; "preserve" lets .tsx files parse without a
			// JSX runtime module.
			"jsx": "preserve",
			// require('./schema') that Node resolves to schema.json is not a
			// missing module. JSON files are never listed in "files".
			"resolveJsonModule": true,
			"module":            "nodenext", "target": tsTarget(nodeVersion), "skipLibCheck": true,
			"types": types, "typeRoots": roots,
		},
		"files": abs,
	}, "", "  ")
}

// tscDiagnostic is one line of `tsc --pretty false` output with the lines that
// continue it.
type tscDiagnostic struct {
	Path     string // as printed: relative to the folder tsc ran in
	Line     int
	Column   int
	Category string // "error", "warning" or "message"
	Code     string // "TS2345"
	Message  string
}

var (
	tscFileDiagnostic   = regexp.MustCompile(`^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$`)
	tscGlobalDiagnostic = regexp.MustCompile(`^(?:error|warning) TS\d+: .*$`)
)

// parseTSC reads the text output of tsc. A diagnostic without a file, which is
// a problem with the configuration or the run, goes into global as it was
// printed.
func parseTSC(out string) (diags []tscDiagnostic, global []string) {
	last := -1 // index of the diagnostic that continuation lines belong to, -2 for a global one
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.TrimSpace(line) == "":
		case line[0] == ' ' || line[0] == '\t':
			text := strings.TrimSpace(line)
			switch {
			case last >= 0:
				diags[last].Message += "\n" + text
			case last == -2:
				global[len(global)-1] += "\n" + text
			}
		default:
			if m := tscFileDiagnostic.FindStringSubmatch(line); m != nil {
				l, _ := strconv.Atoi(m[2])
				c, _ := strconv.Atoi(m[3])
				diags = append(diags, tscDiagnostic{Path: m[1], Line: l, Column: c, Category: m[4], Code: m[5], Message: m[6]})
				last = len(diags) - 1
			} else if tscGlobalDiagnostic.MatchString(line) {
				global = append(global, line)
				last = -2
			} else {
				last = -1
			}
		}
	}
	return diags, global
}

func (typesJavascript) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	if code, reason := typesUnsupported(pkg); reason != "" {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: code, Reason: reason}
	}
	res := &Result{}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("TypeScript")
	}
	files := typesTargets(in)
	if len(files) == 0 {
		res.Status = resultset.StatusCompleted
		return res
	}
	node := ""
	if in.Context.Node != nil {
		node = in.Context.Node.Version
	}
	config, err := typesTsconfig(files, pkg.Path, node, pkg.UsesMocha())
	if err != nil {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "internal_error", err.Error()
		return res
	}

	res.Command = []string{"node", toolvolume.ToolBin + "/typescript7/bin/tsc", "-p", typesConfigPath, "--pretty", "false"}
	container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
		Name: "types-" + strings.ToLower(in.Context.ID), Image: typesImage(), Cmd: res.Command,
		WorkDir: workPath(pkg), Network: in.Network,
		Mounts: []docker.Mount{
			{Volume: in.WorkVolume, Path: workMount, ReadOnly: true},
			{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
		},
		Files: []docker.File{{Path: typesConfigPath, Mode: 0o644, Content: config}},
	})
	if err != nil {
		return failedToRun(res, err)
	}
	if container.OOMKilled {
		res.Status, res.ReasonCode = resultset.StatusToolError, "tsc_failed"
		res.Reason = "tsc ran out of memory: " + tail(string(container.Stderr), 400)
		return res
	}
	diags, global := parseTSC(string(container.Stdout))
	out := interpretTypes(in, diags, global, container.ExitCode)
	out.Command = res.Command
	if out.Status == resultset.StatusToolError && out.ReasonCode == "tsc_failed" {
		out.Reason += ": " + tail(string(container.Stderr)+"\n"+string(container.Stdout), 800)
	}
	out.Artifacts = append(out.Artifacts, resultset.Artifact{
		ID:   "tsconfig-" + in.Context.ID,
		Path: "artifacts/" + typesJavascriptID + "/" + in.Context.ID + "-tsconfig.json", MediaType: "application/json",
		Content: append(config, '\n'),
	})
	return out
}

var tscCannotFindModule = regexp.MustCompile(`^Cannot find module '([^']+)'`)

// typesNodeLoadsJSON says whether a "cannot find module" diagnostic is about a
// relative require that Node resolves to a JSON file: require('./schema') loads
// schema.json, or schema/index.json, when no .js file or package main is
// there. resolveJsonModule lets TypeScript load a JSON module only when the
// path names the file with its .json extension, so it reports TS2307 for the
// extensionless form (checked with TypeScript 7.0.2 under nodenext and under
// bundler resolution). The Check drops these before they count as Findings or
// as resolution errors, and lists them in the Result (see typesDroppedJSON). A
// .js file or a directory with a package.json is found by TypeScript first, so
// no error remains for those. It returns the specifier and the JSON file that
// Node loads, relative to the package folder.
func typesNodeLoadsJSON(in *Input, rel string, d tscDiagnostic) (specifier, resolvesTo string, ok bool) {
	if d.Code != "TS2307" {
		return "", "", false
	}
	m := tscCannotFindModule.FindStringSubmatch(d.Message)
	if m == nil || !(strings.HasPrefix(m[1], "./") || strings.HasPrefix(m[1], "../")) {
		return "", "", false
	}
	dir := path.Join(path.Dir(rel), m[1])
	for _, candidate := range []string{dir + ".json", path.Join(dir, "index.json")} {
		if _, isFile := regularFile(filepath.Join(packageFolder(in), filepath.FromSlash(candidate))); isFile {
			return m[1], candidate, true
		}
	}
	return "", "", false
}

// typesJSONListMax caps the dropped errors that the list names; the rest is
// counted.
const typesJSONListMax = 50

// droppedJSONError is one TS2307 that the Check dropped because Node loads the
// JSON file. Paths are project paths.
type droppedJSONError struct {
	Specifier  string `json:"specifier"`
	Path       string `json:"path"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	ResolvesTo string `json:"resolves_to"`
}

// typesDroppedJSON reports what the JSON filter dropped, so that a reader sees
// what was left out of the Findings: the count as a measurement, and the list,
// cut at typesJSONListMax with the remainder counted, as an artifact. It adds
// the list only when something was dropped.
func typesDroppedJSON(in *Input, res *Result, dropped []droppedJSONError) {
	v := float64(len(dropped))
	res.Metrics = append(res.Metrics, resultset.Metric{Name: "json_modules_dropped", Unit: "errors", Value: &v})
	if len(dropped) == 0 {
		return
	}
	sort.Slice(dropped, func(i, j int) bool {
		a, b := dropped[i], dropped[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Column < b.Column
	})
	listed := dropped
	if len(listed) > typesJSONListMax {
		listed = listed[:typesJSONListMax]
	}
	doc, err := json.MarshalIndent(struct {
		Check     string             `json:"check"`
		ContextID string             `json:"context_id"`
		Note      string             `json:"note"`
		Dropped   int                `json:"dropped"`
		Omitted   int                `json:"omitted"`
		Errors    []droppedJSONError `json:"errors"`
	}{typesJavascriptID, in.Context.ID,
		"TypeScript reported \"Cannot find module\" (TS2307) for these requires, but Node loads the JSON file named in resolves_to. The Check does not report them as Findings and does not count them in resolution_errors.",
		len(dropped), len(dropped) - len(listed), listed}, "", "  ")
	if err != nil {
		return
	}
	res.Artifacts = append(res.Artifacts, resultset.Artifact{
		ID:   "json-modules-dropped-" + in.Context.ID,
		Path: "artifacts/" + typesJavascriptID + "/" + in.Context.ID + "-json-modules-dropped.json", MediaType: "application/json",
		Content: append(doc, '\n'),
	})
}

// interpretTypes turns tsc's diagnostics and exit code into the Result. tsc
// exits with 0 for a clean run and 1 or 2 when it reported errors; anything
// else, or a failure without a diagnostic, is a problem of the tool and not a
// statement about the project. Only diagnostics in the files of the package's
// Source code are reported: what an import pulls in from Test code, Test data
// or outside the package is not what the Check examines.
func interpretTypes(in *Input, diags []tscDiagnostic, global []string, exit int) *Result {
	res := &Result{}
	if tool, ok := toolset.NPMTool("typescript"); ok {
		v, code := tool.Version, exit
		res.Tool = &resultset.Tool{Name: "tsc", Version: &v, ExitCode: &code}
	}
	for _, name := range []string{"typescript", "@types/node", "@types/mocha"} {
		if tool, ok := toolset.NPMTool(name); ok {
			integrity := tool.Integrity
			res.ContextTools = append(res.ContextTools, resultset.ToolRef{Name: tool.Name, Version: tool.Version, Digest: &integrity})
		}
	}
	switch {
	case exit < 0 || exit > 2:
		res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "tsc_failed", fmt.Sprintf("tsc exited with %d", exit)
		return res
	case len(global) > 0:
		res.Status, res.ReasonCode = resultset.StatusToolError, "tsc_config_error"
		res.Reason = "tsc reported a problem with the generated configuration: " + strings.Join(cutList(global, 3), "; ")
		return res
	case exit != 0 && len(diags) == 0:
		res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "tsc_failed", fmt.Sprintf("tsc exited with %d and reported no error", exit)
		return res
	}

	pkg := in.Context.Package
	source := map[string]bool{}
	for _, f := range typesTargets(in) {
		source[f] = true
	}
	var findings []resultset.Finding
	var dropped []droppedJSONError
	for _, d := range diags {
		rel := path.Clean(d.Path)
		if d.Category == "message" || !source[rel] {
			continue
		}
		if spec, target, ok := typesNodeLoadsJSON(in, rel, d); ok {
			dropped = append(dropped, droppedJSONError{
				Specifier: spec, Path: path.Join(pkg.Path, rel), Line: d.Line, Column: d.Column, ResolvesTo: path.Join(pkg.Path, target),
			})
			continue
		}
		f := repoFinding(in, typesJavascriptID, toolProblem{
			Tool: "tsc", Rule: d.Code, Level: "warning", Path: path.Join(pkg.Path, rel),
			Line: d.Line, Column: d.Column, Message: d.Message, Raw: rawJSON(d),
		})
		// The basic profile still has false positives: dynamic patterns and
		// dependencies without types.
		f.Confidence = resultset.ConfidenceSuspected
		findings = append(findings, f)
	}
	// Errors that only exist because the generated config cannot see the
	// project's own: counted before the cut, and a Limitation when they are a
	// flood. The Findings stay in the Report.
	resolution := 0
	for _, f := range findings {
		if f.RuleID != nil && typesResolutionCodes[*f.RuleID] {
			resolution++
		}
	}
	v := float64(resolution)
	res.Metrics = append(res.Metrics, resultset.Metric{Name: "resolution_errors", Unit: "errors", Value: &v})
	typesDroppedJSON(in, res, dropped)
	res.Limitations = append(res.Limitations, projectTsconfigNotUsed(typesJavascriptID, resolution, len(findings), "Treat these Findings with care.")...)
	if len(findings) > typesMaxFindings {
		id := typesJavascriptID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &id,
			Message: fmt.Sprintf("The Report keeps the first %d type errors; %d more were found and are left out.", typesMaxFindings, len(findings)-typesMaxFindings),
		})
		findings = findings[:typesMaxFindings]
		res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
		res.Reason = "some type errors are missing from this Check; see the Limitations"
	}
	res.Findings = findings
	if res.Status == "" {
		res.Status = resultset.StatusCompleted
	}
	return res
}

// projectTsconfigNotUsed is the Limitation project_tsconfig_not_used, or none:
// when resolution errors are a flood among the total type errors, the Check
// most likely ran without the project's own tsconfig. consequence ends the
// message with what the cause means for the Check's results.
func projectTsconfigNotUsed(checkID string, resolution, total int, consequence string) []resultset.Limitation {
	if resolution < typesFloodMin || resolution*typesFloodShare <= total {
		return nil
	}
	return []resultset.Limitation{{
		ReasonCode: "project_tsconfig_not_used", CheckID: &checkID,
		Message: fmt.Sprintf("%d of %d type errors say TypeScript cannot find a module, namespace or global type (TS2307 and similar). "+
			"The likely cause is that the Check ran without the project's own tsconfig: path aliases, `paths`, project references, "+
			"a custom `lib` or `types` setting and project-specific global types are not known to it. %s",
			resolution, total, consequence),
	}}
}
