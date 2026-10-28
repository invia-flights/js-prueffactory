package checks

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/toolset"
	"github.com/invia-flights/jscript-bench/internal/toolvolume"
)

func init() { Register(lintTypedID, lintTyped{}) }

//go:embed js/typed-lint-rules.js
var typedLintRulesJS string

const lintTypedID = "lint.typed"

// lintTyped finds the async mistakes that crash Express apps with the
// type-aware rules of typescript-eslint: a promise that nobody awaits
// (no-floating-promises), a promise where a plain value or a callback that
// returns nothing is expected (no-misused-promises), and an await of a value
// that is no promise (await-thenable). The rules run with their default options.
//
// It is a run of its own, not part of the combined ESLint run of the
// milestone-1 Checks, because type-aware rules need a TypeScript program. The
// program is the generated tsconfig of types.javascript, over the files of
// Source code and Test code together (the project's own tsconfig is never read),
// and the ESLint config is generated too: --no-config-lookup keeps the
// project's configuration out and --no-inline-config makes `eslint-disable`
// comments no way to hide a Finding. typescript-eslint 8.72 supports ESLint 10
// and TypeScript 6, so the run uses the toolset's ESLint and no ESLint major of
// its own.
//
// Findings are warnings with confidence likely and never Gates. Test code is
// linted and its Findings are reported, flagged in_test_code, and the Benchmark
// part counts only Source code. The Check flags the files of the static File
// classes; the engine also flags a Finding in a co-located spec that the test
// file probe moved to Test code (see markTestCode), so that one does not count
// either. The title and message of a Finding are ours;
// the tool's own text, which can quote the project, is untrusted evidence.
//
// Like the type Checks it shares the unsupported packages (a build step is
// needed before the JavaScript can run), the install prerequisite and the
// resolution-error rules: type-aware rules see an unresolved import as an `any`
// and report less, so a flood of resolution errors gets the Limitation
// project_tsconfig_not_used.
type lintTyped struct{}

// typedLintRules are the rules of the Check, with default options, and the
// words the Report uses for what each finds. Their hash is in the Benchmark
// fingerprint.
var typedLintRules = map[string]string{
	"@typescript-eslint/await-thenable":       "await is applied to a value that is not a promise",
	"@typescript-eslint/no-floating-promises": "a promise is neither awaited nor handled, so its result and a rejection are lost",
	"@typescript-eslint/no-misused-promises":  "a promise is used where a plain value or a callback that returns nothing is expected",
}

// typedLintRuleChanges says what the Check changes about the behaviour of a
// rule. The Report records it next to the rule list, and the rule list hash
// covers it, because it changes what a Finding means.
var typedLintRuleChanges = map[string]string{
	"@typescript-eslint/no-floating-promises": "a chain that ends in .catch(handler) or .then(onFulfilled, handler) counts as handled, whatever the type of the handler; " +
		"the registration functions of node:test (" + strings.Join(nodeTestRegistrations, ", ") + ") are known safe calls",
}

// nodeTestRegistrations are the exports of node:test that register a test, a
// suite or a hook, and the variants of the first two. The runner collects what
// they register itself, so that awaiting the promise they return, which a
// top-level call does not, is not what its API wants. The rule matches a call
// by the name of the function in the node:test types, so that the same function
// reached as `t.test` of a test context is known safe too.
var nodeTestRegistrations = []string{"test", "it", "describe", "suite", "before", "after", "beforeEach", "afterEach", "skip", "only", "todo"}

// typedLintRuleOptions are the options of the rules that do not run with their
// defaults.
var typedLintRuleOptions = map[string]any{
	"@typescript-eslint/no-floating-promises": map[string]any{
		"allowForKnownSafeCalls": []any{map[string]any{"from": "package", "package": "node:test", "name": nodeTestRegistrations}},
	},
}

// typedLintRuleNames lists the rules in order.
func typedLintRuleNames() []string {
	names := make([]string, 0, len(typedLintRules))
	for name := range typedLintRules {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// typedLintRulesHash is the SHA-256 of the sorted rule names, one per line,
// each followed by a tab and its change from typedLintRuleChanges if it has one.
func typedLintRulesHash() string {
	var lines []string
	for _, name := range typedLintRuleNames() {
		if change, ok := typedLintRuleChanges[name]; ok {
			name += "\t" + change
		}
		lines = append(lines, name)
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n") + "\n"))
	return hex.EncodeToString(sum[:])
}

const (
	typedLintConfigPath = "/jspf/eslint.config.mjs"
	// typedLintToolsName is the Context tool whose digest is the rule list hash.
	typedLintToolsName = "typed-lint-rules"
)

func (lintTyped) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	if c.Package == nil {
		return resultset.NotApplicable, "lint.typed examines packages, and this is the project Context"
	}
	return typesApplicability(c)
}

// Prerequisites, UsesWorkingCopy, Images and UsesToolset are those of the type
// Checks: the install, the Working copy, the toolset's Node image.
func (lintTyped) Prerequisites(c *discovery.Context) []string {
	return typesJavascript{}.Prerequisites(c)
}
func (lintTyped) UsesWorkingCopy() bool                 { return true }
func (lintTyped) Images(c *discovery.Context) []string  { return typesJavascript{}.Images(c) }
func (lintTyped) UsesToolset(c *discovery.Context) bool { return typesRunnable(c) }

// typedLintFiles lists the files of the run, relative to the package folder and
// sorted: lint is what ESLint reads, program what the TypeScript program holds
// (declaration files too, for their types), and oversized the files left out of
// both because of eslintMaxFileBytes.
func typedLintFiles(in *Input) (lint, program, oversized []string) {
	all := append(typesTargets(in), typesTestTargets(in)...)
	sort.Strings(all)
	for _, f := range all {
		if size, _ := regularFile(filepath.Join(packageFolder(in), filepath.FromSlash(f))); size > eslintMaxFileBytes {
			oversized = append(oversized, f)
			continue
		}
		program = append(program, f)
		if !typesIsDeclaration(f) {
			lint = append(lint, f)
		}
	}
	return lint, program, oversized
}

// typedLintTsconfig is the generated tsconfig of types.javascript over the
// files of Source code and Test code.
func typedLintTsconfig(in *Input) ([]byte, error) {
	_, program, _ := typedLintFiles(in)
	node := ""
	if in.Context.Node != nil {
		node = in.Context.Node.Version
	}
	return typesTsconfigFor(program, in.Context.Package.Path, node, in.Context.Package.UsesMocha(), false)
}

// typedLintCommand is the ESLint command line. File names come from the
// project: they follow `--` and carry a prefix, so that no name reads as an
// option.
func typedLintCommand(files []string) []string {
	cmd := []string{"node", toolvolume.ToolBin + "/eslint/bin/eslint.js",
		"--no-config-lookup", "--no-inline-config", "--config", typedLintConfigPath, "--format", "json", "--"}
	for _, f := range files {
		cmd = append(cmd, "./"+f)
	}
	return cmd
}

// typedLintConfigModule is the flat config as an ES module. The parser and the
// plugin are objects of the toolset's typescript-eslint, which the module
// loads; the JSON only names them. The plugin handed to ESLint is a copy whose
// no-floating-promises is wrapped by js/typed-lint-rules.js, under the same ID.
func typedLintConfigModule(in *Input) string {
	rules := map[string]any{}
	for name := range typedLintRules {
		rules[name] = "warn"
		if options, ok := typedLintRuleOptions[name]; ok {
			rules[name] = []any{"warn", options}
		}
	}
	jsType := "commonjs"
	if readPackageFacts(in).moduleType {
		jsType = "module"
	}
	config := []any{
		map[string]any{
			"files":         []string{"**/*.js", "**/*.cjs", "**/*.mjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"},
			"linterOptions": map[string]any{"noInlineConfig": true, "reportUnusedDisableDirectives": "off"},
			"languageOptions": map[string]any{
				"parser": "typescript-eslint parser",
				"parserOptions": map[string]any{
					"project": []string{typesConfigPath}, "tsconfigRootDir": path.Dir(typesConfigPath),
				},
			},
			"plugins": map[string]any{"@typescript-eslint": "typescript-eslint plugin"},
			"rules":   rules,
		},
		map[string]any{"files": []string{"**/*.js"}, "languageOptions": map[string]any{"sourceType": jsType}},
		map[string]any{"files": []string{"**/*.mjs"}, "languageOptions": map[string]any{"sourceType": "module"}},
		map[string]any{"files": []string{"**/*.cjs"}, "languageOptions": map[string]any{"sourceType": "commonjs"}},
	}
	doc, _ := json.Marshal(config)
	return strings.Join([]string{
		"import loaded from " + fmt.Sprintf("%q", toolvolume.ToolBin+"/typescript-eslint/dist/index.js") + ";",
		"const tseslint = loaded.default ?? loaded;",
		typedLintRulesJS,
		"const plugin = {",
		"  ...tseslint.plugin,",
		"  rules: { ...tseslint.plugin.rules, 'no-floating-promises': trustRejectionHandlers(tseslint.plugin.rules['no-floating-promises']) },",
		"};",
		"const config = " + string(doc) + ";",
		"for (const c of config) {",
		"  if (c.languageOptions && c.languageOptions.parser) c.languageOptions.parser = tseslint.parser;",
		"  if (c.plugins) c.plugins = { '@typescript-eslint': plugin };",
		"}",
		"export default config;",
		"",
	}, "\n")
}

// typedLintMessage is one message of ESLint's JSON output.
type typedLintMessage struct {
	// Path is relative to the package folder.
	Path    string `json:"path"`
	Rule    string `json:"rule_id"`
	Message string `json:"message"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	// Fatal marks a parse error, which has no rule.
	Fatal bool `json:"fatal"`
}

// parseTypedLintOutput reads `eslint --format json`: an array of one entry per
// file with absolute paths below folder.
func parseTypedLintOutput(out []byte, folder string) ([]typedLintMessage, error) {
	var files []struct {
		FilePath string `json:"filePath"`
		Messages []struct {
			RuleID  *string `json:"ruleId"`
			Message string  `json:"message"`
			Line    int     `json:"line"`
			Column  int     `json:"column"`
			Fatal   bool    `json:"fatal"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(out, &files); err != nil {
		return nil, fmt.Errorf("ESLint did not print its JSON document: %w", err)
	}
	var msgs []typedLintMessage
	for _, f := range files {
		rel := strings.TrimPrefix(f.FilePath, strings.TrimSuffix(folder, "/")+"/")
		for _, m := range f.Messages {
			rule := ""
			if m.RuleID != nil {
				rule = *m.RuleID
			}
			msgs = append(msgs, typedLintMessage{Path: rel, Rule: rule, Message: m.Message, Line: m.Line, Column: m.Column, Fatal: m.Fatal})
		}
	}
	return msgs, nil
}

// typedLintRun is what the runs left: ESLint's messages, or why there are none,
// the files left out because of their size, and the tsc run over the same
// program when there was one.
type typedLintRun struct {
	Messages  []typedLintMessage
	ExitCode  int
	Oversized []string
	// Failed says that ESLint produced nothing usable, and why.
	Failed string
	// TSC is the tsc run over the generated tsconfig, for the resolution-error
	// rules. It is nil when it did not run or did not finish.
	TSC *tscRun
}

// interpretTypedLint turns the runs into the Result.
func interpretTypedLint(in *Input, run typedLintRun) *Result {
	res := &Result{}
	if tool, ok := toolset.NPMTool("eslint"); ok {
		v, code := tool.Version, run.ExitCode
		res.Tool = &resultset.Tool{Name: "eslint", Version: &v, ExitCode: &code}
	}
	hash := typedLintRulesHash()
	for _, name := range []string{"eslint", "typescript-eslint", "typescript6", "@types/node", "@types/mocha"} {
		if tool, ok := toolset.NPMTool(name); ok {
			integrity := tool.Integrity
			res.ContextTools = append(res.ContextTools, resultset.ToolRef{Name: tool.Name, Version: tool.Version, Digest: &integrity})
		}
	}
	res.ContextTools = append(res.ContextTools, resultset.ToolRef{Name: typedLintToolsName, Version: hash[:12], Digest: &hash})
	if run.Failed != "" {
		res.Status, res.ReasonCode, res.Reason = resultset.StatusToolError, "eslint_failed", run.Failed
		return res
	}
	if doc, err := typedLintRuleList(in); err == nil {
		res.Artifacts = append(res.Artifacts, resultset.Artifact{
			ID:   "rules-" + in.Context.ID,
			Path: "artifacts/" + lintTypedID + "/" + in.Context.ID + "-rules.json", MediaType: "application/json", Content: doc,
		})
	}

	pkg := in.Context.Package
	tests := map[string]bool{}
	for _, f := range pkg.Files {
		if f.Class == discovery.TestCode {
			tests[f.PackageRel] = true
		}
	}
	var source, test []resultset.Finding
	var unparsed []string
	for _, m := range run.Messages {
		if m.Fatal {
			unparsed = append(unparsed, path.Join(pkg.Path, m.Path))
			continue
		}
		what, ok := typedLintRules[m.Rule]
		if !ok {
			continue
		}
		f := repoFinding(in, lintTypedID, toolProblem{
			Tool: "eslint", Rule: m.Rule, Level: "warning", Path: path.Join(pkg.Path, m.Path),
			Line: m.Line, Column: m.Column, Message: m.Message, Raw: rawJSON(m),
		})
		// What the tool says about the project's code is evidence; the words of
		// the Finding are ours.
		f.Title = cutTitle(m.Rule + ": " + what)
		f.Message = fmt.Sprintf("typescript-eslint reports warning %s: %s", m.Rule, what)
		if tests[m.Path] {
			f.InTestCode = true
			test = append(test, f)
		} else {
			source = append(source, f)
		}
	}
	// Source code first, so that a cut never drops what the Benchmark counts.
	findings := append(source, test...)

	var left []string
	if len(findings) > eslintMaxFindings {
		id := lintTypedID
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "findings_cut", CheckID: &id,
			Message: fmt.Sprintf("The Report keeps the first %d hits, Source code first; %d more were found and are left out.", eslintMaxFindings, len(findings)-eslintMaxFindings),
		})
		findings = findings[:eslintMaxFindings]
		left = append(left, "hits")
	}
	res.Findings = findings
	id := lintTypedID
	if len(unparsed) > 0 {
		sort.Strings(unparsed)
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "files_not_parsed", CheckID: &id,
			Message: "typescript-eslint could not parse these files and did not lint them: " + strings.Join(cutList(unparsed, 20), ", "),
		})
	}
	if len(run.Oversized) > 0 {
		var projectPaths []string
		for _, f := range run.Oversized {
			projectPaths = append(projectPaths, path.Join(pkg.Path, f))
		}
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "files_too_large", CheckID: &id,
			Message: fmt.Sprintf("These files are over %d bytes and were not linted: %s", eslintMaxFileBytes, strings.Join(cutList(projectPaths, 20), ", ")),
		})
		left = append(left, "files")
	}
	typedLintResolution(in, run, res)

	res.Status = resultset.StatusCompleted
	switch {
	case len(left) > 0:
		res.Status, res.ReasonCode = resultset.StatusPartial, "check_could_not_run_on_some_files"
		res.Reason = "some " + strings.Join(left, " and ") + " are missing from this Check; see the Limitations"
	case len(unparsed) > 0:
		// No hits in a file nobody read is not a measurement, so the Benchmark
		// counts the part as unknown.
		res.Status, res.ReasonCode = resultset.StatusPartial, "files_not_parsed"
		res.Reason = fmt.Sprintf("typescript-eslint could not parse %d file%s, so what they hold was not checked; see the Limitation files_not_parsed", len(unparsed), plural(len(unparsed)))
	}
	return res
}

// typedLintResolution applies the resolution-error rules of types.javascript to
// the tsc run over the same program: the errors that only exist because the
// generated config cannot see the project's own are counted, and a Limitation
// names the likely cause when they are a flood.
func typedLintResolution(in *Input, run typedLintRun, res *Result) {
	if run.TSC == nil {
		return
	}
	inProgram := map[string]bool{}
	_, program, _ := typedLintFiles(in)
	for _, f := range program {
		inProgram[f] = true
	}
	total, resolution := 0, 0
	for _, d := range run.TSC.Diagnostics {
		rel := path.Clean(d.Path)
		if d.Category == "message" || !inProgram[rel] {
			continue
		}
		if _, _, ok := typesNodeLoadsJSON(in, rel, d); ok {
			continue
		}
		total++
		if typesResolutionCodes[d.Code] {
			resolution++
		}
	}
	v := float64(resolution)
	res.Metrics = append(res.Metrics, resultset.Metric{Name: "resolution_errors", Unit: "errors", Value: &v})
	res.Limitations = append(res.Limitations, projectTsconfigNotUsed(lintTypedID, resolution, total,
		"The type-aware rules see an unresolved import as `any` and report less there. Treat these results with care.")...)
}

// typedLintRuleList is the artifact that records which rules were on.
func typedLintRuleList(in *Input) ([]byte, error) {
	eslintVersion, tseslintVersion := "", ""
	if tool, ok := toolset.NPMTool("eslint"); ok {
		eslintVersion = tool.Version
	}
	if tool, ok := toolset.NPMTool("typescript-eslint"); ok {
		tseslintVersion = tool.Version
	}
	// Each rule runs with its default options, except for the changes noted here.
	options := map[string]string{}
	for _, name := range typedLintRuleNames() {
		options[name] = "default"
		if change, ok := typedLintRuleChanges[name]; ok {
			options[name] = "default, and " + change
		}
	}
	doc, err := json.MarshalIndent(struct {
		Check       string            `json:"check"`
		ContextID   string            `json:"context_id"`
		ESLint      string            `json:"eslint_version"`
		TSESLint    string            `json:"typescript_eslint_version"`
		Rules       []string          `json:"rules"`
		RulesSHA256 string            `json:"rules_sha256"`
		Options     map[string]string `json:"options"`
	}{lintTypedID, in.Context.ID, eslintVersion, tseslintVersion, typedLintRuleNames(), typedLintRulesHash(), options}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(doc, '\n'), nil
}

func (lintTyped) Run(ctx context.Context, in *Input) *Result {
	pkg := in.Context.Package
	if u := pkg.InstallUnsupported; u != nil {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: u.Code, Reason: u.Reason}
	}
	if code, reason := typesUnsupported(pkg); reason != "" {
		return &Result{Status: resultset.StatusUnsupported, ReasonCode: code, Reason: reason}
	}
	if in.ToolsetVolume == "" {
		return in.toolsetUnavailable("ESLint, typescript-eslint and TypeScript 6")
	}
	lint, _, oversized := typedLintFiles(in)
	if len(lint) == 0 {
		return interpretTypedLint(in, typedLintRun{Oversized: oversized})
	}
	tsconfig, err := typedLintTsconfig(in)
	if err != nil {
		return &Result{Status: resultset.StatusToolError, ReasonCode: "internal_error", Reason: err.Error()}
	}
	configs := []docker.File{
		{Path: typesConfigPath, Mode: 0o644, Content: tsconfig},
		{Path: typedLintConfigPath, Mode: 0o644, Content: []byte(typedLintConfigModule(in))},
	}
	start := func(name string, cmd []string) (*docker.ContainerResult, *Result) {
		container, err := in.Docker.RunContainer(ctx, docker.ContainerSpec{
			Name: name + "-" + strings.ToLower(in.Context.ID), Image: typesImage(), Cmd: cmd,
			WorkDir: workPath(pkg), Network: in.Network,
			Mounts: []docker.Mount{
				{Volume: in.WorkVolume, Path: workMount, ReadOnly: true},
				{Volume: in.ToolsetVolume, Path: toolvolume.MountPath, ReadOnly: true},
			},
			Files: configs,
		})
		if err != nil {
			return nil, failedToRun(&Result{}, err)
		}
		return container, nil
	}

	command := typedLintCommand(lint)
	container, stop := start("typedlint", command)
	if stop != nil {
		stop.Command = command
		return stop
	}
	run := typedLintRun{ExitCode: container.ExitCode, Oversized: oversized}
	switch {
	case container.OOMKilled:
		run.Failed = "ESLint ran out of memory: " + tail(string(container.Stderr), 400)
	case container.ExitCode < 0 || container.ExitCode > 1:
		run.Failed = fmt.Sprintf("ESLint exited with %d: %s", container.ExitCode, tail(string(container.Stderr), 800))
	default:
		msgs, err := parseTypedLintOutput(container.Stdout, workPath(pkg))
		if err != nil {
			run.Failed = err.Error() + ": " + tail(string(container.Stderr), 800)
		}
		run.Messages = msgs
	}

	// The same program, once more with the compiler, for the resolution-error
	// rules. A failure of this run says nothing about the lint and is left out.
	if run.Failed == "" {
		tscCmd := []string{"node", toolvolume.ToolBin + "/@typescript/typescript6/bin/tsc6", "-p", typesConfigPath, "--pretty", "false"}
		if tsc, stop := start("typedlint-tsc", tscCmd); stop == nil && !tsc.OOMKilled {
			diags, global := parseTSC(string(tsc.Stdout))
			r := tscRun{Diagnostics: diags, Global: global, Exit: tsc.ExitCode}
			if code, _ := r.problem(); code == "" {
				run.TSC = &r
			}
		}
	}

	out := interpretTypedLint(in, run)
	// The file list can be long, so the Report keeps the command up to the files.
	out.Command = append(append([]string{}, command[:len(command)-len(lint)]...), fmt.Sprintf("(%d files)", len(lint)))
	out.Artifacts = append(out.Artifacts, resultset.Artifact{
		ID:   "tsconfig-" + in.Context.ID,
		Path: "artifacts/" + lintTypedID + "/" + in.Context.ID + "-tsconfig.json", MediaType: "application/json",
		Content: append(tsconfig, '\n'),
	})
	return out
}
