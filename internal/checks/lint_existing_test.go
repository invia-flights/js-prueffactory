package checks

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/docker"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam: lint.existing's applicability, and what it makes of the output of the
// project's own linters. The linters themselves run in Docker and are covered
// by the docker-tagged tests in internal/cli.

func TestLintExistingIsImplementedPerPackageAndCanFireGates(t *testing.T) {
	entry, ok := Lookup("lint.existing")
	if !ok || entry.Status != Implemented || entry.Scope != PerPackage || !entry.CanFireGates {
		t.Fatalf("lint.existing = %+v, want implemented per package with Gates", entry)
	}
	impl := Implementation("lint.existing")
	if p, ok := impl.(PrerequisiteUser); !ok || !slices.Equal(p.Prerequisites(nil), []string{"package.install"}) {
		t.Errorf("lint.existing needs the installed dependencies, so package.install is its prerequisite")
	}
	if w, ok := impl.(WorkingCopyUser); !ok || !w.UsesWorkingCopy() {
		t.Error("lint.existing runs the project's linter from the Working copy")
	}
}

func TestLintExistingAppliesToPackagesThatHaveABiomeOrAConfiguredESLint(t *testing.T) {
	eslint := `{"devDependencies":{"eslint":"^9"}}`
	cases := []struct {
		name  string
		files map[string]string
		want  resultset.Applicability
	}{
		{"neither linter", map[string]string{"package.json": `{"name":"x"}`, "a.js": "1;\n"}, resultset.NotApplicable},
		{"eslint as a dependency with a flat config", map[string]string{"package.json": eslint, "eslint.config.js": "export default [];\n"}, resultset.Applicable},
		{"eslint as a production dependency with a flat config", map[string]string{"package.json": `{"dependencies":{"eslint":"^9"}}`, "eslint.config.mjs": "export default [];\n"}, resultset.Applicable},
		{"a flat config in cjs", map[string]string{"package.json": eslint, "eslint.config.cjs": "module.exports = [];\n"}, resultset.Applicable},
		{"a flat config in ts", map[string]string{"package.json": eslint, "eslint.config.ts": "export default [];\n"}, resultset.Applicable},
		{"a flat config in mts", map[string]string{"package.json": eslint, "eslint.config.mts": "export default [];\n"}, resultset.Applicable},
		{"a flat config in cts", map[string]string{"package.json": eslint, "eslint.config.cts": "export default [];\n"}, resultset.Applicable},
		{"a legacy .eslintrc without extension", map[string]string{"package.json": eslint, ".eslintrc": "{}\n"}, resultset.Applicable},
		{"a legacy .eslintrc.json", map[string]string{"package.json": eslint, ".eslintrc.json": "{}\n"}, resultset.Applicable},
		{"a legacy .eslintrc.yaml", map[string]string{"package.json": eslint, ".eslintrc.yaml": "root: true\n"}, resultset.Applicable},
		{"eslintConfig in package.json", map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"},"eslintConfig":{"root":true}}`}, resultset.Applicable},
		{"biome as a dependency", map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`}, resultset.Applicable},
		{"a dependency with its config", map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`, "biome.json": "{}\n"}, resultset.Applicable},
		{"eslint without any configuration, but biome as well", map[string]string{"package.json": `{"devDependencies":{"eslint":"^9","@biomejs/biome":"2.1.2"}}`}, resultset.Applicable},
		{"a flat config alone: no locked ESLint to run", map[string]string{"package.json": `{}`, "eslint.config.mjs": "export default [];\n"}, resultset.NotApplicable},
		{"a legacy config file alone", map[string]string{"package.json": `{}`, ".eslintrc.json": "{}\n"}, resultset.NotApplicable},
		{"eslintConfig in package.json alone", map[string]string{"package.json": `{"eslintConfig":{"root":true}}`}, resultset.NotApplicable},
		{"biome.json alone", map[string]string{"package.json": `{}`, "biome.json": "{}\n"}, resultset.NotApplicable},
		{"a manifest that is not JSON", map[string]string{"package.json": `{`}, resultset.NotApplicable},
	}
	impl := Implementation("lint.existing")
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj, _ := writeTree(t, c.files)
			got, reason := impl.Applicability(proj, packageContext(t, proj, "."))
			if got != c.want {
				t.Fatalf("applicability = %v (%s), want %v", got, reason, c.want)
			}
			if got == resultset.NotApplicable && reason == "" {
				t.Error("not_applicable needs a reason")
			}
		})
	}
	proj, _ := writeTree(t, map[string]string{"package.json": eslint, "eslint.config.js": "export default [];\n"})
	if got, _ := impl.Applicability(proj, &proj.Contexts[0]); got != resultset.NotApplicable {
		t.Errorf("the project Context holds no package to lint, got %v", got)
	}
}

func TestESLintAsADependencyWithoutAnyConfigurationIsNotApplicableAndSaysSo(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^10"}}`, "index.js": "1;\n"})

	got, reason := Implementation("lint.existing").Applicability(proj, packageContext(t, proj, "."))

	if got != resultset.NotApplicable {
		t.Fatalf("applicability = %v, want not_applicable", got)
	}
	if !strings.Contains(reason, "ESLint is a dependency") || !strings.Contains(reason, "no ESLint configuration") {
		t.Errorf("reason = %q, want it to say ESLint is a dependency but there is no configuration", reason)
	}
}

func TestESLintFindsItsFlatConfigInTheNearestAncestorInsideTheProject(t *testing.T) {
	eslint := `{"devDependencies":{"eslint":"^9"}}`
	cases := []struct {
		name  string
		files map[string]string
		want  resultset.Applicability
	}{
		{"a config at the project root serves a nested package", map[string]string{
			"package.json": `{"workspaces":["packages/*"]}`, "eslint.config.js": "export default [];\n", "packages/a/package.json": eslint}, resultset.Applicable},
		{"a config in an intermediate folder serves a deeper package", map[string]string{
			"package.json": `{}`, "libs/eslint.config.mjs": "export default [];\n", "libs/a/package.json": eslint}, resultset.Applicable},
		{"a config of a sibling folder does not", map[string]string{
			"package.json": `{}`, "libs/b/eslint.config.js": "export default [];\n", "libs/a/package.json": eslint}, resultset.NotApplicable},
		{"a legacy file of an ancestor is not read for the package", map[string]string{
			"package.json": `{}`, ".eslintrc.json": "{}\n", "packages/a/package.json": eslint}, resultset.NotApplicable},
	}
	impl := Implementation("lint.existing")
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proj, _ := writeTree(t, c.files)
			var path string
			for _, ctx := range proj.Contexts {
				if ctx.Package != nil && ctx.Package.Path != "." && strings.HasSuffix(ctx.Package.Path, "/a") {
					path = ctx.Package.Path
				}
			}
			if got, reason := impl.Applicability(proj, packageContext(t, proj, path)); got != c.want {
				t.Fatalf("applicability = %v (%s), want %v", got, reason, c.want)
			}
		})
	}
}

func TestAnESLintConfigThatIsNoRegularFileDoesNotCount(t *testing.T) {
	_, dir := writeTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "elsewhere.js": "export default [];\n"})
	if err := os.Symlink(filepath.Join(dir, "elsewhere.js"), filepath.Join(dir, "eslint.config.js")); err != nil {
		t.Skip("no symlinks:", err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}

	if got, reason := Implementation("lint.existing").Applicability(proj, packageContext(t, proj, ".")); got != resultset.NotApplicable {
		t.Errorf("applicability = %v (%s), want not_applicable: a symlink is not read", got, reason)
	}
}

func TestLintExistingChecksEachPackageOnItsOwn(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{
		"package.json":                `{"name":"root"}`,
		"packages/a/package.json":     `{"devDependencies":{"eslint":"^9"}}`,
		"packages/a/eslint.config.js": "export default [];\n",
		"packages/b/package.json":     `{"name":"b"}`,
		"packages/b/src/b.js":         "1;\n",
	})
	impl := Implementation("lint.existing")
	if got, _ := impl.Applicability(proj, packageContext(t, proj, "packages/a")); got != resultset.Applicable {
		t.Errorf("package a has ESLint, got %v", got)
	}
	if got, _ := impl.Applicability(proj, packageContext(t, proj, "packages/b")); got != resultset.NotApplicable {
		t.Errorf("package b has neither linter, got %v", got)
	}
}

// A trimmed copy of what Biome 2.1.2 printed for a project with a debugger
// statement: the advices and the fix diffs are left out, the rest is as Biome
// wrote it. The span is in bytes of sourceCode.
const projectBiomeJSON = `{"summary":{"changed":0,"unchanged":2,"matches":0,"errors":1,"warnings":2},"diagnostics":[` +
	`{"category":"lint/suspicious/noConsole","severity":"warning","description":"Don't use console.","message":[],"advices":{"advices":[]},"location":{"path":{"file":"src/index.js"},"span":[47,58],"sourceCode":"'use strict';\n\nfunction main() {\n  debugger;\n  console.log('x');\n  return 1;\n}\n"},"tags":[],"source":null},` +
	`{"category":"lint/suspicious/noDebugger","severity":"error","description":"This is an unexpected use of the debugger statement.","message":[],"advices":{"advices":[]},"location":{"path":{"file":"src/index.js"},"span":[35,44],"sourceCode":"'use strict';\n\nfunction main() {\n  debugger;\n  console.log('x');\n  return 1;\n}\n"},"tags":["fixable"],"source":null},` +
	`{"category":"lint/style/useConst","severity":"information","description":"Use const.","message":[],"advices":{"advices":[]},"location":{"path":{"file":"src/ü.js"},"span":[9,12],"sourceCode":"/* ü */ let x\n"},"tags":[],"source":null}` +
	`],"command":"lint"}`

func lintInput(t *testing.T) *Input {
	t.Helper()
	proj, dir := writeTree(t, map[string]string{
		"package.json":                `{"name":"root"}`,
		"packages/inner/package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`,
		"packages/inner/src/index.js": "1;\n",
	})
	return &Input{Project: proj, Context: packageContext(t, proj, "packages/inner"), OriginalPath: "/original", SnapshotDir: dir}
}

func TestBiomeErrorsAreGatesAndWarningsAreWarningsWithTheirPositions(t *testing.T) {
	in := lintInput(t)

	findings, err := biomeFindings(in, []byte(projectBiomeJSON))

	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 3 {
		t.Fatalf("findings = %d, want 3: %+v", len(findings), findings)
	}
	byRule := map[string]resultset.Finding{}
	for _, f := range findings {
		byRule[*f.RuleID] = f
		if f.CheckID != "lint.existing" || f.ContextID != in.Context.ID {
			t.Errorf("check/context = %s/%s", f.CheckID, f.ContextID)
		}
	}
	debugger := byRule["lint/suspicious/noDebugger"]
	if !debugger.Gate || debugger.Severity != resultset.SeverityError || debugger.Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("an error-level diagnostic is a Gate: %+v", debugger)
	}
	loc := debugger.Locations[0]
	if loc.Path != "packages/inner/src/index.js" || loc.Start == nil || loc.Start.Line != 4 || *loc.Start.Column != 3 {
		t.Errorf("location = %+v, want packages/inner/src/index.js at 4:3, relative to the project", loc)
	}
	if console := byRule["lint/suspicious/noConsole"]; console.Gate || console.Severity != resultset.SeverityWarning || console.Locations[0].Start.Line != 5 {
		t.Errorf("a warning is not a Gate: %+v", console)
	}
	// An information diagnostic is a hint, and the column counts characters, not
	// the bytes of the two-byte ü before it.
	info := byRule["lint/style/useConst"]
	if info.Gate || info.Severity != resultset.SeverityNote || info.Kind != resultset.KindHint {
		t.Errorf("information = %+v, want a note", info)
	}
	if got := *info.Locations[0].Start.Column; got != 9 {
		t.Errorf("column = %d, want 9 (a character count)", got)
	}
	if strings.Contains(debugger.Evidence[0].Text, "sourceCode") {
		t.Errorf("the evidence must not carry Biome's copy of the source: %s", debugger.Evidence[0].Text)
	}
}

func TestBiomeOutputThatIsNotJSONIsAnError(t *testing.T) {
	if _, err := biomeFindings(lintInput(t), []byte("")); err == nil {
		t.Error("no output at all is no statement that the code is clean")
	}
}

// What ESLint 9 printed with --format json for a project with an unused
// variable (error), a loose comparison (warning), a parse error and an unused
// disable directive, trimmed to the fields that matter. File paths are the
// absolute paths inside the container.
const projectESLintJSON = `[` +
	`{"filePath":"/work/packages/inner/src/index.js","messages":[` +
	`{"ruleId":"no-unused-vars","severity":2,"message":"'unused' is assigned a value but never used.","line":3,"column":7,"nodeType":"Identifier","endLine":3,"endColumn":13},` +
	`{"ruleId":"eqeqeq","severity":1,"message":"Expected '===' and instead saw '=='.","line":5,"column":9}` +
	`],"suppressedMessages":[{"ruleId":"no-console","severity":2,"message":"silenced","line":9,"column":1}],"errorCount":1,"warningCount":1},` +
	`{"filePath":"/work/packages/inner/src/clean.js","messages":[],"suppressedMessages":[],"errorCount":0,"warningCount":0},` +
	`{"filePath":"/work/packages/inner/src/broken.js","messages":[{"ruleId":null,"fatal":true,"severity":2,"message":"Parsing error: Unexpected token )","line":1,"column":8}]},` +
	`{"filePath":"/work/packages/inner/src/old.js","messages":[{"ruleId":null,"severity":1,"message":"Unused eslint-disable directive (no problems were reported from 'no-console').","line":2,"column":1}]},` +
	`{"filePath":"/etc/passwd","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"outside","line":1,"column":1}]}` +
	`]`

func TestESLintErrorsAreGatesAndWarningsAreWarningsInTheProjectsOwnRuleNames(t *testing.T) {
	in := lintInput(t)

	findings, err := projectESLintFindings(in, []byte(projectESLintJSON))

	if err != nil {
		t.Fatal(err)
	}
	var got []string
	byRule := map[string]resultset.Finding{}
	for _, f := range findings {
		got = append(got, *f.RuleID)
		byRule[*f.RuleID] = f
	}
	want := []string{"no-unused-vars", "eqeqeq", "parse-error", "eslint-directive"}
	if !slices.Equal(got, want) {
		t.Fatalf("rules = %v, want %v: suppressed messages and files outside the package are not findings", got, want)
	}
	unused := byRule["no-unused-vars"]
	if !unused.Gate || unused.Severity != resultset.SeverityError || unused.Confidence != resultset.ConfidenceConfirmed {
		t.Errorf("a severity 2 message is a Gate: %+v", unused)
	}
	if loc := unused.Locations[0]; loc.Path != "packages/inner/src/index.js" || loc.Start.Line != 3 || *loc.Start.Column != 7 {
		t.Errorf("location = %+v, want packages/inner/src/index.js at 3:7", loc)
	}
	if eq := byRule["eqeqeq"]; eq.Gate || eq.Severity != resultset.SeverityWarning {
		t.Errorf("a severity 1 message is a warning, not a Gate: %+v", eq)
	}
	if parse := byRule["parse-error"]; !parse.Gate || !strings.Contains(parse.Message, "Parsing error") {
		t.Errorf("a file the project's ESLint cannot parse is an error of its own linter: %+v", parse)
	}
	if dir := byRule["eslint-directive"]; dir.Gate || dir.Severity != resultset.SeverityWarning {
		t.Errorf("a message without a rule that is no parse error is a warning: %+v", dir)
	}
}

// fakeLinters replaces the container step of lint.existing. It answers by the
// command, records every command it was asked to run, and fails the test for a
// command it has no answer for.
type fakeLinters struct {
	t        *testing.T
	answers  func(cmd []string) *docker.ContainerResult
	commands [][]string
}

func (f *fakeLinters) run(_ context.Context, _ *Input, _ string, cmd []string) (*docker.ContainerResult, error) {
	f.commands = append(f.commands, cmd)
	got := f.answers(cmd)
	if got == nil {
		f.t.Fatalf("unexpected command %v", cmd)
	}
	return got, nil
}

func (f *fakeLinters) count(substring string) int {
	n := 0
	for _, c := range f.commands {
		if strings.Contains(strings.Join(c, " "), substring) {
			n++
		}
	}
	return n
}

func withFakeLinters(t *testing.T, answers func(cmd []string) *docker.ContainerResult) *fakeLinters {
	t.Helper()
	f := &fakeLinters{t: t, answers: answers}
	old := runLintContainer
	runLintContainer = f.run
	t.Cleanup(func() { runLintContainer = old })
	return f
}

func ok(stdout string) *docker.ContainerResult {
	return &docker.ContainerResult{Stdout: []byte(stdout)}
}

func lintTree(t *testing.T, files map[string]string) *Input {
	t.Helper()
	proj, dir := writeTree(t, files)
	return &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}
}

func isVersionQuery(cmd []string) bool { return len(cmd) > 1 && cmd[1] == "-p" }

func TestESLintRunsFromNodeModulesWithTheProjectsConfigAndItsInlineDirectives(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "export default [];\n", "src/a.js": "1;\n"})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("9.39.0\n")
		}
		out := strings.ReplaceAll(`[{"filePath":"/work/src/a.js","messages":[{"ruleId":"no-undef","severity":2,"message":"x is not defined.","line":1,"column":1}]}]`, "\n", "")
		return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(out)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 1 || !res.Findings[0].Gate {
		t.Fatalf("result = %+v, want completed with the error-level diagnostic as a Gate", res)
	}
	lint := strings.Join(fake.commands[len(fake.commands)-1], " ")
	if lint != "node node_modules/eslint/bin/eslint.js --format json ." {
		t.Errorf("command = %q, want the project's own ESLint from node_modules with JSON output", lint)
	}
	for _, flag := range []string{"--no-inline-config", "--no-config-lookup", "--fix", "--cache"} {
		if strings.Contains(lint, flag) {
			t.Errorf("command %q must keep the project's config and directives and stay check-only: %s", lint, flag)
		}
	}
	if res.Tool == nil || res.Tool.Name != "eslint" || res.Tool.Version == nil || *res.Tool.Version != "9.39.0" || *res.Tool.ExitCode != 1 {
		t.Errorf("tool = %+v, want the locked ESLint 9.39.0 with its exit code", res.Tool)
	}
	if strings.Join(res.Command, " ") != lint {
		t.Errorf("recorded command = %v", res.Command)
	}
}

func TestACleanESLintRunCompletesWithoutFindings(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "export default [];\n"})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("9.39.0\n")
		}
		return ok("[]")
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Errorf("result = %+v", res)
	}
}

func TestALegacyESLintConfigWithAnESLintThatNoLongerReadsItIsAProjectError(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^10"}}`, ".eslintrc.json": "{}\n"})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("10.13.0\n")
		}
		return &docker.ContainerResult{ExitCode: 2, Stderr: []byte("\nOops! Something went wrong! :(\n\nESLint: 10.13.0\n\nESLint couldn't find an eslint.config.* file.\n")}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 1 {
		t.Fatalf("result = %+v, want completed with one project error", res)
	}
	f := res.Findings[0]
	if !f.Gate || *f.RuleID != "eslint-legacy-config" || f.Locations[0].Path != ".eslintrc.json" {
		t.Errorf("finding = %+v, want a Gate on the legacy config file", f)
	}
	if !strings.Contains(f.Message, "10.13.0") || !strings.Contains(f.Message, ".eslintrc") || !strings.Contains(f.Message, "eslint.config") {
		t.Errorf("message = %q, want the reason: the version, the legacy file and the format it needs", f.Message)
	}
}

func TestESLintWithoutAnyConfigurationIsNeverStartedAndMakesNoFinding(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^10"}}`, "index.js": "1;\n"})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		return &docker.ContainerResult{ExitCode: 2, Stderr: []byte("ESLint couldn't find an eslint.config.* file.\n")}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 0 || len(fake.commands) != 0 {
		t.Errorf("findings = %+v, commands = %v, want ESLint left alone: the project has no linter setup that could fail", res.Findings, fake.commands)
	}
}

func TestABiomePackageWhoseESLintHasNoConfigurationRunsBiomeOnly(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^10","@biomejs/biome":"2.1.2"}}`})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("2.1.2\n")
		}
		return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(projectBiomeJSON)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 3 || fake.count("eslint") != 0 {
		t.Errorf("status %s, findings %d, eslint runs %d, want Biome's three findings and no ESLint", res.Status, len(res.Findings), fake.count("eslint"))
	}
}

func TestAnESLintExitOf2ForAnotherReasonThanAMissingConfigurationStaysAProjectError(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"},"eslintConfig":{"extends":"nope"}}`})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("9.39.0\n")
		}
		return &docker.ContainerResult{ExitCode: 2, Stderr: []byte("Error: Cannot read config file")}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 1 || !res.Findings[0].Gate || *res.Findings[0].RuleID != "eslint-failed" {
		t.Fatalf("result = %+v, want one Gate of eslint-failed", res)
	}
}

func TestAnESLintConfigThatFailsToLoadIsAProjectErrorWithTheErrorAsEvidence(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "x\n"})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("9.39.0\n")
		}
		return &docker.ContainerResult{ExitCode: 2, Stderr: []byte("Error: Cannot find module 'eslint-plugin-x'")}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 1 || !res.Findings[0].Gate || *res.Findings[0].RuleID != "eslint-failed" {
		t.Fatalf("result = %+v, want one Gate of eslint-failed", res)
	}
	if ev := res.Findings[0].Evidence[0]; !strings.Contains(ev.Text, "eslint-plugin-x") || ev.Trust != resultset.TrustUntrusted {
		t.Errorf("evidence = %+v", ev)
	}
}

func TestADeclaredLinterThatIsNotInstalledIsAProjectError(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "module.exports = [];\n"})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		return &docker.ContainerResult{ExitCode: 1, Stderr: []byte("Error: Cannot find module './node_modules/eslint/package.json'")}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 1 || !res.Findings[0].Gate || *res.Findings[0].RuleID != "eslint-not-installed" {
		t.Fatalf("result = %+v, want one Gate of eslint-not-installed", res)
	}
	if len(fake.commands) != 1 {
		t.Errorf("a linter that is not there is not run: %v", fake.commands)
	}
}

func TestABrokenLinterRunIsAToolErrorAndNotAFindingOfTheProject(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "export default [];\n"})
	for name, answer := range map[string]*docker.ContainerResult{
		"out of memory":  {ExitCode: 137, OOMKilled: true},
		"cannot execute": {ExitCode: 126, Stderr: []byte("permission denied")},
	} {
		t.Run(name, func(t *testing.T) {
			withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
				if isVersionQuery(cmd) {
					return ok("9.39.0\n")
				}
				return answer
			})

			res := lintExisting{}.Run(context.Background(), in)

			if res.Status != resultset.StatusToolError || len(res.Findings) != 0 {
				t.Errorf("result = %+v, want tool_error and no finding", res)
			}
		})
	}
}

func TestBiomeRunsLintFromNodeModulesWithTheJSONReporter(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`, "biome.json": "{}\n"})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("2.1.2\n")
		}
		return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(projectBiomeJSON)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 3 {
		t.Fatalf("result = %+v, want the three diagnostics", res)
	}
	gates := 0
	for _, f := range res.Findings {
		if f.Gate {
			gates++
		}
	}
	if gates != 1 {
		t.Errorf("gates = %d, want 1: only the error-level diagnostic", gates)
	}
	lint := strings.Join(fake.commands[len(fake.commands)-1], " ")
	if lint != "node node_modules/@biomejs/biome/bin/biome lint --reporter=json ." {
		t.Errorf("command = %q", lint)
	}
	if res.Tool == nil || res.Tool.Name != "biome" || *res.Tool.Version != "2.1.2" {
		t.Errorf("tool = %+v", res.Tool)
	}
	if len(res.Limitations) != 0 {
		t.Errorf("limitations = %+v, want none: VCS integration was left as the project has it", res.Limitations)
	}
}

const biomeNoIgnoreFile = "/work internalError/fs ━━━━\n\n  × Biome couldn't find an ignore file in the following folder: /work\n\nconfiguration ━━━━\n\n  × Biome exited because the configuration resulted in errors. Please fix them.\n"

func TestBiomeIsRetriedOnceWithoutVCSIntegrationWhenTheMissingGitFolderBreaksItsConfigAndTheOverrideIsRecorded(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`, "biome.json": "{}\n"})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		switch {
		case isVersionQuery(cmd):
			return ok("2.1.2\n")
		case slices.Contains(cmd, "--vcs-enabled=false"):
			return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(projectBiomeJSON)}
		}
		return &docker.ContainerResult{ExitCode: 1, Stderr: []byte(biomeNoIgnoreFile)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 3 {
		t.Fatalf("result = %+v, want the diagnostics of the retry", res)
	}
	if fake.count("biome lint") != 2 {
		t.Errorf("biome ran %d times, want the run and one retry", fake.count("biome lint"))
	}
	if !slices.Contains(res.Command, "--vcs-enabled=false") {
		t.Errorf("command = %v, want the command that produced the result", res.Command)
	}
	if len(res.Limitations) != 1 || res.Limitations[0].ReasonCode != "biome_vcs_disabled" || !strings.Contains(res.Limitations[0].Message, "--vcs-enabled=false") {
		t.Errorf("limitations = %+v, want the override recorded", res.Limitations)
	}
	for _, f := range res.Findings {
		if f.Limitations == nil {
			t.Error("a finding keeps its (empty) list of limitations")
		}
	}
}

func TestABiomeConfigProblemThatHasNothingToDoWithGitIsAProjectErrorWithoutARetry(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`, "biome.json": "{}\n"})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("2.1.2\n")
		}
		return &docker.ContainerResult{ExitCode: 1, Stderr: []byte("biome.json:3:5 deserialize ━━━\n\n  × Found an unknown key `linterr`.\n")}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 1 || !res.Findings[0].Gate || *res.Findings[0].RuleID != "biome-config-error" {
		t.Fatalf("result = %+v, want one Gate of biome-config-error", res)
	}
	if res.Findings[0].Locations[0].Path != "biome.json" || !strings.Contains(res.Findings[0].Evidence[0].Text, "linterr") {
		t.Errorf("finding = %+v", res.Findings[0])
	}
	if fake.count("biome lint") != 1 {
		t.Errorf("biome ran %d times, want once", fake.count("biome lint"))
	}
}

func TestWhenTheRetryWithoutVCSFailsAsWellTheOverrideIsNotClaimedAndTheProjectGetsTheError(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`})
	fake := withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("2.1.2\n")
		}
		return &docker.ContainerResult{ExitCode: 1, Stderr: []byte(biomeNoIgnoreFile)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if len(res.Findings) != 1 || !res.Findings[0].Gate || len(res.Limitations) != 0 {
		t.Errorf("result = %+v", res)
	}
	if fake.count("biome lint") != 2 {
		t.Errorf("biome ran %d times, want exactly one retry", fake.count("biome lint"))
	}
}

func TestAProjectWithBothLintersGetsBoth(t *testing.T) {
	in := lintTree(t, map[string]string{
		"package.json":     `{"devDependencies":{"eslint":"^9","@biomejs/biome":"2.1.2"}}`,
		"eslint.config.js": "module.exports = [];\n",
	})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		switch {
		case isVersionQuery(cmd) && strings.Contains(cmd[2], "eslint"):
			return ok("9.39.0\n")
		case isVersionQuery(cmd):
			return ok("2.1.2\n")
		case strings.Contains(strings.Join(cmd, " "), "eslint.js"):
			return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(`[{"filePath":"/work/a.js","messages":[{"ruleId":"no-undef","severity":2,"message":"m","line":1,"column":1}]}]`)}
		}
		return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(projectBiomeJSON)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	tools := map[string]int{}
	for _, f := range res.Findings {
		tools[f.Evidence[0].Origin]++
	}
	if res.Status != resultset.StatusCompleted || tools["eslint"] != 1 || tools["biome"] != 3 {
		t.Errorf("findings by tool = %v, status %s", tools, res.Status)
	}
}

func TestWhenOneOfTwoLintersCannotRunTheOtherOnesFindingsAreKeptAndTheResultIsPartial(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9","@biomejs/biome":"2.1.2"}}`, "eslint.config.js": "export default [];\n"})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		switch {
		case isVersionQuery(cmd):
			return ok("1.0.0\n")
		case strings.Contains(strings.Join(cmd, " "), "eslint.js"):
			return &docker.ContainerResult{ExitCode: 137, OOMKilled: true}
		}
		return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(projectBiomeJSON)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusPartial || len(res.Findings) != 3 || res.ReasonCode == "" {
		t.Errorf("result = %+v", res)
	}
}

func TestAPackageWhoseInstallIsUnsupportedIsUnsupported(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "export default [];\n"})
	in.Context.Package.InstallUnsupported = &discovery.Unsupported{Code: "workspaces_unsupported", Reason: "npm workspaces"}
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult { return nil })

	res := lintExisting{}.Run(context.Background(), in)

	if res.Status != resultset.StatusUnsupported || res.ReasonCode != "workspaces_unsupported" {
		t.Errorf("result = %+v", res)
	}
}

func TestTheLintersAndTheirVersionsAreRecordedAsAnArtifact(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"@biomejs/biome":"2.1.2"}}`})
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		switch {
		case isVersionQuery(cmd):
			return ok("2.1.2\n")
		case slices.Contains(cmd, "--vcs-enabled=false"):
			return &docker.ContainerResult{Stdout: []byte(`{"diagnostics":[]}`)}
		}
		return &docker.ContainerResult{ExitCode: 1, Stderr: []byte(biomeNoIgnoreFile)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	if len(res.Artifacts) != 1 || res.Artifacts[0].Path != "artifacts/lint.existing/"+in.Context.ID+"/linters.json" {
		t.Fatalf("artifacts = %+v", res.Artifacts)
	}
	var doc struct {
		Linters []struct {
			Name     string   `json:"name"`
			Version  string   `json:"version"`
			Command  []string `json:"command"`
			ExitCode int      `json:"exit_code"`
			Override string   `json:"override"`
		} `json:"linters"`
	}
	if err := json.Unmarshal(res.Artifacts[0].Content, &doc); err != nil || len(doc.Linters) != 1 {
		t.Fatalf("artifact = %s (%v)", res.Artifacts[0].Content, err)
	}
	l := doc.Linters[0]
	if l.Name != "biome" || l.Version != "2.1.2" || !slices.Contains(l.Command, "--vcs-enabled=false") || l.Override == "" {
		t.Errorf("linter = %+v", l)
	}
}

func TestMoreFindingsThanTheCapKeepEveryGateAndCutTheWarningsAndSayHowMany(t *testing.T) {
	in := lintTree(t, map[string]string{"package.json": `{"devDependencies":{"eslint":"^9"}}`, "eslint.config.js": "export default [];\n"})
	var messages []string
	for i := 0; i < eslintMaxFindings+50; i++ {
		messages = append(messages, `{"ruleId":"eqeqeq","severity":1,"message":"w","line":1,"column":1}`)
	}
	messages = append(messages, `{"ruleId":"no-undef","severity":2,"message":"e","line":1,"column":1}`)
	out := `[{"filePath":"/work/a.js","messages":[` + strings.Join(messages, ",") + `]}]`
	withFakeLinters(t, func(cmd []string) *docker.ContainerResult {
		if isVersionQuery(cmd) {
			return ok("9.39.0\n")
		}
		return &docker.ContainerResult{ExitCode: 1, Stdout: []byte(out)}
	})

	res := lintExisting{}.Run(context.Background(), in)

	gates := 0
	for _, f := range res.Findings {
		if f.Gate {
			gates++
		}
	}
	if len(res.Findings) != eslintMaxFindings || gates != 1 {
		t.Errorf("findings = %d with %d Gates, want %d with the Gate kept", len(res.Findings), gates, eslintMaxFindings)
	}
	if res.Status != resultset.StatusPartial || len(res.Limitations) != 1 || res.Limitations[0].ReasonCode != "findings_cut" || !strings.Contains(res.Limitations[0].Message, "51") {
		t.Errorf("status %s, limitations %+v, want partial with findings_cut naming the 51 left out", res.Status, res.Limitations)
	}
}

func TestESLintOutputThatIsNotAJSONArrayIsAnError(t *testing.T) {
	for _, out := range []string{"", "Oops! Something went wrong!", `{"results":[]}`} {
		if _, err := projectESLintFindings(lintInput(t), []byte(out)); err == nil {
			t.Errorf("%q says nothing about the code", out)
		}
	}
	if got, err := projectESLintFindings(lintInput(t), []byte("[]")); err != nil || len(got) != 0 {
		t.Errorf("an empty list is a clean project: %v %v", got, err)
	}
}
