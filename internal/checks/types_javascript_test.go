package checks

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam: what types.javascript decides on the host. Which packages it takes,
// the generated tsconfig, and what it makes of TypeScript's output. The run of
// tsc itself needs Docker and is covered by the docker-tagged test in
// internal/cli.

func TestTypesJavascriptIsImplementedPerPackageAsASideIndicatorWithoutGates(t *testing.T) {
	entry, ok := Lookup("types.javascript")
	if !ok || entry.Status != Implemented || entry.Scope != PerPackage {
		t.Fatalf("types.javascript = %+v, want implemented per package", entry)
	}
	if entry.CanFireGates {
		t.Error("types.javascript reports warnings, never Gates")
	}
}

func TestTypesJavascriptNeedsTheInstallAndTheToolset(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	c := packageContext(t, proj, ".")
	impl := Implementation("types.javascript")

	if got := impl.(PrerequisiteUser).Prerequisites(c); !reflect.DeepEqual(got, []string{"package.install"}) {
		t.Errorf("prerequisites = %v, want package.install", got)
	}
	if !impl.(WorkingCopyUser).UsesWorkingCopy() {
		t.Error("the Check reads the installed dependencies in the Working copy")
	}
	if !impl.(ToolsetUser).UsesToolset(c) || len(impl.(ImageUser).Images(c)) != 1 {
		t.Error("the Check runs TypeScript from the toolset in one image")
	}
}

func TestTypeScriptSourceFilesDoNotMakeAPackageUnsupported(t *testing.T) {
	for _, ts := range []string{"src/b.ts", "src/b.tsx", "src/b.mts", "src/b.cts"} {
		t.Run(ts, func(t *testing.T) {
			proj, _ := writeTree(t, map[string]string{
				"package.json": `{"name":"x"}`, "src/a.js": "1;\n", ts: "export {};\n",
				// An editor tsconfig next to a few TypeScript files is no build step.
				"tsconfig.json": `{"compilerOptions":{"strict":true}}`,
			})
			c := packageContext(t, proj, ".")
			impl := Implementation("types.javascript")

			got, reason := impl.Applicability(proj, c)

			if got != resultset.Applicable || reason != "" {
				t.Errorf("applicability = %v (%q), want applicable without a reason", got, reason)
			}
			if len(impl.(ImageUser).Images(c)) != 1 || !impl.(ToolsetUser).UsesToolset(c) {
				t.Error("the Check runs TypeScript from the toolset in one image")
			}
			if p := impl.(PrerequisiteUser).Prerequisites(c); !reflect.DeepEqual(p, []string{"package.install"}) {
				t.Errorf("prerequisites = %v, want package.install", p)
			}
		})
	}
}

func TestAPackageOfOnlyTypeScriptSourceFilesIsChecked(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.ts": "export {};\n"})
	got, reason := Implementation("types.javascript").Applicability(proj, packageContext(t, proj, "."))
	if got != resultset.Applicable || reason != "" {
		t.Errorf("applicability = %v (%q), want applicable", got, reason)
	}
}

func TestAPackageThatNeedsABuildStepForItsTypeScriptStaysUnsupportedWithTheReason(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"tsconfig that emits": {"tsconfig.json": `{"compilerOptions":{"outDir":"dist"}}`},
		"tsc build script":    {"tsconfig.json": "{}", "package.json": `{"name":"x","scripts":{"build":"tsc"}}`},
		"babel config":        {".babelrc": "{}"},
		"bundler config":      {"rollup.config.mjs": "export default {};\n"},
	} {
		t.Run(name, func(t *testing.T) {
			files["src/a.js"], files["src/b.ts"] = "1;\n", "export {};\n"
			if _, ok := files["package.json"]; !ok {
				files["package.json"] = `{"name":"x"}`
			}
			proj, _ := writeTree(t, files)
			c := packageContext(t, proj, ".")
			impl := Implementation("types.javascript")

			got, reason := impl.Applicability(proj, c)

			if got != resultset.Applicable || !strings.HasPrefix(reason, "unsupported: ") || !strings.Contains(reason, "build step") {
				t.Errorf("applicability = %v (%q), want applicable with an unsupported reason naming the build step", got, reason)
			}
			if len(impl.(ImageUser).Images(c)) != 0 || impl.(ToolsetUser).UsesToolset(c) {
				t.Error("an unsupported package needs no image and no toolset")
			}
			if p := impl.(PrerequisiteUser).Prerequisites(c); len(p) != 0 {
				t.Errorf("prerequisites = %v, want none for an unsupported package", p)
			}
			res := impl.Run(t.Context(), &Input{Project: proj, Context: c})
			if res.Status != resultset.StatusUnsupported || res.ReasonCode != "build_step_required" || !strings.Contains(res.Reason, "build step") {
				t.Errorf("result = %s %s %q, want unsupported with the reason", res.Status, res.ReasonCode, res.Reason)
			}
		})
	}
}

func TestABuildConfigWithoutTypeScriptSourceCodeDoesNotChangeTheCheck(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, ".babelrc": "{}", "src/a.js": "1;\n"})
	got, reason := Implementation("types.javascript").Applicability(proj, packageContext(t, proj, "."))
	if got != resultset.Applicable || reason != "" {
		t.Errorf("applicability = %v (%q), want applicable: only TypeScript sources need the build step to be unsupported", got, reason)
	}
}

func TestADeclarationFileOrAnEditorOnlyTsconfigDoesNotMakeAPackageTypeScript(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{
		"package.json": `{"name":"x"}`, "src/a.js": "1;\n", "src/a.d.ts": "export {};\n",
		"src/b.d.mts": "export {};\n", "src/c.d.cts": "export {};\n",
		"tsconfig.json": "{}\n", "jsconfig.json": "{}\n",
	})
	got, reason := Implementation("types.javascript").Applicability(proj, packageContext(t, proj, "."))
	if got != resultset.Applicable || reason != "" {
		t.Errorf("applicability = %v (%q), want applicable: the package is JavaScript", got, reason)
	}
}

func TestPackagesWithoutJavaScriptSourceCodeAreNotApplicable(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{
		"package.json": `{"name":"x"}`, "test/a.test.js": "1;\n", "test/fixtures/f.js": "1;\n", "dist/g.js": "1;\n",
	})
	got, reason := Implementation("types.javascript").Applicability(proj, packageContext(t, proj, "."))
	if got != resultset.NotApplicable || reason == "" {
		t.Errorf("applicability = %v (%q), want not_applicable with a reason", got, reason)
	}
}

func TestTheProjectContextIsNotApplicable(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	got, _ := Implementation("types.javascript").Applicability(proj, &proj.Contexts[0])
	if got != resultset.NotApplicable {
		t.Errorf("project Context = %v, want not_applicable", got)
	}
}

func TestOnlyJavaScriptTypeScriptAndDeclarationFilesOfSourceCodeAreGivenToTypeScriptAsLiteralPaths(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json":   `{"name":"x"}`,
		"src/a.js":       "1;\n",
		"src/b.mjs":      "1;\n",
		"src/c.cjs":      "1;\n",
		"src/d.d.ts":     "export {};\n",
		"src/[id].js":    "1;\n",
		"src/-x.js":      "1;\n",
		"src/e.jsx":      "1;\n",
		"src/f.ts":       "export {};\n",
		"src/g.tsx":      "export {};\n",
		"src/h.mts":      "export {};\n",
		"src/i.cts":      "export {};\n",
		"src/j.d.mts":    "export {};\n",
		"test/b.test.ts": "export {};\n",
		"test/a.test.js": "1;\n",
		"dist/g.js":      "1;\n",
		"README.md":      "# x\n",
	})
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

	got := typesTargets(in)

	want := []string{
		"src/-x.js", "src/[id].js", "src/a.js", "src/b.mjs", "src/c.cjs", "src/d.d.ts",
		"src/f.ts", "src/g.tsx", "src/h.mts", "src/i.cts", "src/j.d.mts",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("targets = %v, want %v", got, want)
	}
}

func generatedConfig(t *testing.T, files []string, pkgPath, node string, mocha bool) map[string]any {
	t.Helper()
	data, err := typesTsconfig(files, pkgPath, node, mocha)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("the generated tsconfig is not JSON: %v\n%s", err, data)
	}
	return cfg
}

func TestTheGeneratedTsconfigIsABasicProfileForJavaScriptThatNeverReadsTheProjectsConfig(t *testing.T) {
	cfg := generatedConfig(t, []string{"src/a.js", "src/[id].js"}, ".", "24", false)

	opts := cfg["compilerOptions"].(map[string]any)
	for k, want := range map[string]any{
		"allowJs": true, "checkJs": true, "noEmit": true, "strict": false, "noImplicitAny": false,
		"module": "nodenext", "target": "es2024", "skipLibCheck": true,
		// .tsx files parse; nothing is emitted, so the JSX is never transformed.
		"jsx": "preserve",
		// An extensionless require of a .json file resolves the way Node does.
		"resolveJsonModule": true,
	} {
		if opts[k] != want {
			t.Errorf("compilerOptions.%s = %v, want %v", k, opts[k], want)
		}
	}
	if !reflect.DeepEqual(opts["types"], []any{"node"}) {
		t.Errorf("types = %v, want node only for a package without Mocha", opts["types"])
	}
	// The package's own types come first, then the toolset's.
	roots, _ := opts["typeRoots"].([]any)
	if len(roots) != 2 || roots[0] != "/work/node_modules/@types" || roots[1] != "/toolset/node_modules/@types" {
		t.Errorf("typeRoots = %v", roots)
	}
	// Literal absolute paths: no glob can match anything else, and a name that
	// starts with "-" or holds "[" means what it says.
	if !reflect.DeepEqual(cfg["files"], []any{"/work/src/a.js", "/work/src/[id].js"}) {
		t.Errorf("files = %v", cfg["files"])
	}
	for _, k := range []string{"include", "exclude", "extends", "references"} {
		if _, ok := cfg[k]; ok {
			t.Errorf("the config has %q: the project's own config and globs must not come in", k)
		}
	}
}

func TestTypeScriptFilesAreListedAsLiteralPathsNextToTheJavaScriptOnes(t *testing.T) {
	cfg := generatedConfig(t, []string{"src/a.js", "src/b.ts", "src/c.tsx", "src/[d].mts", "src/e.d.cts"}, "pkg", "24", false)

	want := []any{"/work/pkg/src/a.js", "/work/pkg/src/b.ts", "/work/pkg/src/c.tsx", "/work/pkg/src/[d].mts", "/work/pkg/src/e.d.cts"}
	if !reflect.DeepEqual(cfg["files"], want) {
		t.Errorf("files = %v, want %v", cfg["files"], want)
	}
	opts := cfg["compilerOptions"].(map[string]any)
	if opts["jsx"] != "preserve" || opts["strict"] != false || opts["noImplicitAny"] != false {
		t.Errorf("options = %v, want jsx set and the basic profile kept", opts)
	}
}

func TestMochaTypesComeInForMochaPackagesAndTheTargetFollowsTheNodeVersion(t *testing.T) {
	cfg := generatedConfig(t, []string{"a.js"}, "packages/inner", "20", true)
	opts := cfg["compilerOptions"].(map[string]any)

	if !reflect.DeepEqual(opts["types"], []any{"node", "mocha"}) {
		t.Errorf("types = %v, want node and mocha", opts["types"])
	}
	if opts["target"] != "es2023" {
		t.Errorf("target = %v, want es2023 for Node 20", opts["target"])
	}
	roots, _ := opts["typeRoots"].([]any)
	want := []any{
		"/work/packages/inner/node_modules/@types", "/work/packages/node_modules/@types",
		"/work/node_modules/@types", "/toolset/node_modules/@types",
	}
	if !reflect.DeepEqual(roots, want) {
		t.Errorf("typeRoots = %v, want %v", roots, want)
	}
	if !reflect.DeepEqual(cfg["files"], []any{"/work/packages/inner/a.js"}) {
		t.Errorf("files = %v", cfg["files"])
	}
}

func TestTheTargetMatchesTheNodeVersion(t *testing.T) {
	for node, want := range map[string]string{
		"24": "es2024", "22": "es2023", "20": "es2023", "18": "es2022", "16": "es2021", "14": "es2020", "12": "es2019",
		"22.4.1": "es2023", "": "es2024", "latest": "es2024", "26": "es2024",
	} {
		if got := tsTarget(node); got != want {
			t.Errorf("tsTarget(%q) = %s, want %s", node, got, want)
		}
	}
}

const tscErrors = `src/index.js(3,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/other.js(10,1): error TS2322: Type 'string' is not assignable to type 'number'.
  Type 'string' is not assignable to type 'number'.
src/legacy (1).js(2,5): error TS2339: Property 'x' does not exist on type '{}'.
node_modules/dep/index.js(1,1): error TS7016: Could not find a declaration file for module 'dep'.
../outside.js(1,1): error TS2304: Cannot find name 'y'.
test/a.test.js(1,1): error TS2304: Cannot find name 'z'.
`

func TestParseTSCReadsDiagnosticsWithTheirContinuationLines(t *testing.T) {
	diags, global := parseTSC(tscErrors)

	if len(global) != 0 {
		t.Fatalf("global = %v", global)
	}
	if len(diags) != 6 {
		t.Fatalf("diagnostics = %+v, want 6", diags)
	}
	d := diags[1]
	if d.Path != "src/other.js" || d.Line != 10 || d.Column != 1 || d.Code != "TS2322" || d.Category != "error" ||
		d.Message != "Type 'string' is not assignable to type 'number'.\nType 'string' is not assignable to type 'number'." {
		t.Errorf("diagnostic = %+v", d)
	}
	if diags[2].Path != "src/legacy (1).js" || diags[2].Line != 2 || diags[2].Column != 5 {
		t.Errorf("a path with parentheses = %+v", diags[2])
	}
}

func TestParseTSCSeparatesDiagnosticsWithoutAFileBecauseTheyMeanTheRunWasWrong(t *testing.T) {
	_, global := parseTSC("error TS2688: Cannot find type definition file for 'mocha'.\n")
	if len(global) != 1 || !strings.Contains(global[0], "TS2688") {
		t.Errorf("global = %v", global)
	}
}

func typesInput(t *testing.T, files map[string]string) *Input {
	proj, dir := writeTree(t, files)
	return &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}
}

func TestEveryDiagnosticInSourceCodeBecomesAWarningWithItsTSCode(t *testing.T) {
	in := typesInput(t, map[string]string{
		"package.json": `{"name":"x"}`, "src/index.js": "1;\n", "src/other.js": "1;\n", "src/legacy (1).js": "1;\n",
		"test/a.test.js": "1;\n",
	})
	diags, _ := parseTSC(tscErrors)

	res := interpretTypes(in, diags, nil, 1)

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	// Only the package's Source code is examined: not node_modules, not files
	// outside the package and not Test code pulled in by an import.
	if len(res.Findings) != 3 {
		t.Fatalf("findings = %d, want the three in Source code: %+v", len(res.Findings), res.Findings)
	}
	f := res.Findings[0]
	if f.CheckID != "types.javascript" || f.ContextID != in.Context.ID || f.Gate || f.Severity != resultset.SeverityWarning {
		t.Errorf("finding = %+v, want a warning without Gate", f)
	}
	if f.RuleID == nil || *f.RuleID != "TS2345" {
		t.Errorf("rule = %v, want the TS code", f.RuleID)
	}
	if f.Locations[0].Path != "src/index.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 3 || f.Locations[0].FileSHA256 == "" {
		t.Errorf("location = %+v", f.Locations[0])
	}
	if !strings.Contains(f.Message, "TS2345") || !strings.Contains(f.Message, "not assignable to parameter") {
		t.Errorf("message = %q", f.Message)
	}
	if res.Findings[0].Fingerprint.Value == res.Findings[1].Fingerprint.Value {
		t.Error("two diagnostics must have two fingerprints")
	}
}

func TestPathsOfADiagnosticInANestedPackageAreRelativeToTheProject(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json": `{"name":"root"}`, "packages/inner/package.json": `{"name":"inner"}`,
		"packages/inner/src/in.js": "1;\n",
	})
	in := &Input{Project: proj, Context: packageContext(t, proj, "packages/inner"), SnapshotDir: dir}
	diags, _ := parseTSC("src/in.js(1,1): error TS2304: Cannot find name 'q'.\n")

	res := interpretTypes(in, diags, nil, 1)

	if len(res.Findings) != 1 || res.Findings[0].Locations[0].Path != "packages/inner/src/in.js" {
		t.Fatalf("findings = %+v", res.Findings)
	}
}

func TestACleanRunCompletesWithoutFindings(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	res := interpretTypes(in, nil, nil, 0)
	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Errorf("result = %s, %d findings", res.Status, len(res.Findings))
	}
}

func TestADiagnosticWithoutAFileOrAFailureWithoutADiagnosticIsAToolError(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})

	res := interpretTypes(in, nil, []string{"error TS2688: Cannot find type definition file for 'mocha'."}, 1)
	if res.Status != resultset.StatusToolError || res.ReasonCode != "tsc_config_error" || !strings.Contains(res.Reason, "TS2688") {
		t.Errorf("global diagnostic = %s %s %q", res.Status, res.ReasonCode, res.Reason)
	}
	res = interpretTypes(in, nil, nil, 2)
	if res.Status != resultset.StatusToolError || res.ReasonCode != "tsc_failed" {
		t.Errorf("exit 2 without a diagnostic = %s %s", res.Status, res.ReasonCode)
	}
	res = interpretTypes(in, nil, nil, 139)
	if res.Status != resultset.StatusToolError || res.ReasonCode != "tsc_failed" {
		t.Errorf("a crash = %s %s", res.Status, res.ReasonCode)
	}
}

func TestDiagnosticsInTypeScriptFilesAreWarningsLikeThoseInJavaScriptFiles(t *testing.T) {
	in := typesInput(t, map[string]string{
		"package.json": `{"name":"x"}`, "src/a.js": "1;\n", "src/b.ts": "export {};\n", "src/c.tsx": "export {};\n",
		"src/d.mts": "export {};\n", "src/e.cts": "export {};\n", "test/f.test.ts": "export {};\n",
	})
	diags, _ := parseTSC(`src/a.js(1,1): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/c.tsx(3,1): error TS2339: Property 'x' does not exist on type '{}'.
src/d.mts(1,1): error TS2304: Cannot find name 'a'.
src/e.cts(1,1): error TS2304: Cannot find name 'b'.
test/f.test.ts(1,1): error TS2304: Cannot find name 'c'.
node_modules/dep/index.d.ts(1,1): error TS2304: Cannot find name 'd'.
`)

	res := interpretTypes(in, diags, nil, 1)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 5 {
		t.Fatalf("status %s, %d findings, want 5 in Source code and none in Test code or node_modules", res.Status, len(res.Findings))
	}
	for _, f := range res.Findings {
		if f.Severity != resultset.SeverityWarning || f.Gate || f.Confidence != resultset.ConfidenceSuspected || f.RuleID == nil || !strings.HasPrefix(*f.RuleID, "TS") {
			t.Errorf("finding = %+v, want a suspected TS warning without Gate", f)
		}
	}
	if f := res.Findings[1]; f.Locations[0].Path != "src/b.ts" || f.Locations[0].Start.Line != 2 || f.Locations[0].Start.Column == nil || *f.Locations[0].Start.Column != 7 {
		t.Errorf("location = %+v", f.Locations[0])
	}
}

func resolutionDiagnostics(n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "src/a.ts(%d,1): error TS2307: Cannot find module '@app/m%d' or its corresponding type declarations.\n", i+1, i)
	}
	return b.String()
}

func metricOf(res *Result, name string) *resultset.Metric {
	for i := range res.Metrics {
		if res.Metrics[i].Name == name {
			return &res.Metrics[i]
		}
	}
	return nil
}

func TestAFloodOfResolutionErrorsGetsALimitationNamingTheMissingProjectConfigAndAMetric(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.ts": "export {};\n", "src/b.js": "1;\n"})
	// 30 unresolved modules and 10 other errors: three quarters of the Findings.
	diags, _ := parseTSC(resolutionDiagnostics(30) + strings.Repeat("src/b.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n", 10))

	res := interpretTypes(in, diags, nil, 2)

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 40 {
		t.Fatalf("status %s, %d findings: the Findings stay in the Report", res.Status, len(res.Findings))
	}
	if len(res.Limitations) != 1 {
		t.Fatalf("limitations = %+v, want one", res.Limitations)
	}
	l := res.Limitations[0]
	if l.ReasonCode != "project_tsconfig_not_used" || l.CheckID == nil || *l.CheckID != "types.javascript" ||
		!strings.Contains(l.Message, "30 of 40") || !strings.Contains(l.Message, "tsconfig") || !strings.Contains(l.Message, "TS2307") {
		t.Errorf("limitation = %+v", l)
	}
	if m := metricOf(res, "resolution_errors"); m == nil || m.Value == nil || *m.Value != 30 || m.Unit != "errors" {
		t.Errorf("metric = %+v, want 30 errors", m)
	}
}

func TestFewResolutionErrorsGetAMetricButNoLimitation(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.ts": "export {};\n", "src/b.js": "1;\n"})
	cases := map[string]string{
		"a small share of many":        resolutionDiagnostics(10) + strings.Repeat("src/b.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n", 90),
		"too few to say anything":      resolutionDiagnostics(4),
		"exactly a fifth is still few": resolutionDiagnostics(10) + strings.Repeat("src/b.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n", 40),
	}
	for name, out := range cases {
		t.Run(name, func(t *testing.T) {
			diags, _ := parseTSC(out)
			res := interpretTypes(in, diags, nil, 2)
			if len(res.Limitations) != 0 {
				t.Errorf("limitations = %+v, want none", res.Limitations)
			}
			if m := metricOf(res, "resolution_errors"); m == nil || m.Value == nil {
				t.Errorf("metric = %+v, want the count", m)
			}
		})
	}
}

func TestACleanRunHasAZeroResolutionErrorMetric(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	res := interpretTypes(in, nil, nil, 0)
	if m := metricOf(res, "resolution_errors"); m == nil || m.Value == nil || *m.Value != 0 {
		t.Errorf("metric = %+v, want 0", m)
	}
}

func TestOtherResolutionCodesCountToo(t *testing.T) {
	for _, code := range []string{"TS2307", "TS2792", "TS2834", "TS2835", "TS2503", "TS2580", "TS2591", "TS2583"} {
		if !typesResolutionCodes[code] {
			t.Errorf("%s is not counted as a resolution error", code)
		}
	}
	for _, code := range []string{"TS2345", "TS2322", "TS2339", "TS2304"} {
		if typesResolutionCodes[code] {
			t.Errorf("%s is a type error of the code, not a resolution error", code)
		}
	}
}

func TestResolutionErrorsDroppedOutsideSourceCodeDoNotCount(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	diags, _ := parseTSC(strings.ReplaceAll(resolutionDiagnostics(30), "src/a.ts", "node_modules/dep/index.d.ts") +
		"src/a.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n")
	res := interpretTypes(in, diags, nil, 2)
	if len(res.Limitations) != 0 || len(res.Findings) != 1 {
		t.Errorf("limitations = %+v, findings = %d: only what the Report keeps counts", res.Limitations, len(res.Findings))
	}
}

// TypeScript never tries ".json" on an extensionless path, even with
// resolveJsonModule, so it reports TS2307 for require('./schema') where Node
// loads schema.json. Those are not findings about the project.
func TestARequireOfAJSONFileThatNodeResolvesIsNotAMissingModule(t *testing.T) {
	in := typesInput(t, map[string]string{
		"package.json": `{"name":"x"}`, "src/a.js": "1;\n", "src/b.js": "1;\n",
		"src/data/schema.json": "{}\n", "src/cfg/index.json": "{}\n",
	})
	diags, _ := parseTSC("" +
		"src/a.js(1,1): error TS2307: Cannot find module './data/schema' or its corresponding type declarations.\n" +
		"src/a.js(2,1): error TS2307: Cannot find module './cfg' or its corresponding type declarations.\n" +
		"src/a.js(3,1): error TS2307: Cannot find module './data/missing' or its corresponding type declarations.\n" +
		"src/a.js(4,1): error TS2307: Cannot find module 'schema' or its corresponding type declarations.\n" +
		"src/a.js(5,1): error TS2307: Cannot find module './data/schema.json' or its corresponding type declarations.\n" +
		"src/b.js(6,1): error TS2307: Cannot find module './schema' or its corresponding type declarations.\n" +
		"src/b.js(7,1): error TS2307: Cannot find module '../src/cfg' or its corresponding type declarations.\n")

	res := interpretTypes(in, diags, nil, 2)

	var left []int
	for _, f := range res.Findings {
		left = append(left, f.Locations[0].Start.Line)
	}
	// ./data/schema and ./cfg (index.json) resolve in Node from src/a.js, and
	// so does ../src/cfg from src/b.js. A missing file, a bare package name, an
	// explicit .json that does not exist and a name that is only in another
	// folder (./schema from src/b.js) stay.
	if !reflect.DeepEqual(left, []int{3, 4, 5, 6}) {
		t.Errorf("findings left at lines %v, want [3 4 5 6]", left)
	}
	if m := metricOf(res, "resolution_errors"); m == nil || m.Value == nil || *m.Value != 4 {
		t.Errorf("metric = %+v, want the 4 real resolution errors", m)
	}
	// What was dropped stays visible: a count, and a list in an artifact.
	if m := metricOf(res, "json_modules_dropped"); m == nil || m.Value == nil || *m.Value != 3 || m.Unit != "errors" {
		t.Errorf("metric = %+v, want 3 dropped errors", m)
	}
	doc := droppedJSONList(t, res)
	if doc.Dropped != 3 || doc.Omitted != 0 || len(doc.Errors) != 3 {
		t.Fatalf("list = %+v, want 3 entries and none omitted", doc)
	}
	want := []droppedJSON{
		{Specifier: "./data/schema", Path: "src/a.js", Line: 1, ResolvesTo: "src/data/schema.json"},
		{Specifier: "./cfg", Path: "src/a.js", Line: 2, ResolvesTo: "src/cfg/index.json"},
		{Specifier: "../src/cfg", Path: "src/b.js", Line: 7, ResolvesTo: "src/cfg/index.json"},
	}
	if !reflect.DeepEqual(doc.Errors, want) {
		t.Errorf("errors = %+v, want %+v", doc.Errors, want)
	}
}

type droppedJSON struct {
	Specifier  string `json:"specifier"`
	Path       string `json:"path"`
	Line       int    `json:"line"`
	ResolvesTo string `json:"resolves_to"`
}

type droppedJSONDoc struct {
	Dropped int           `json:"dropped"`
	Omitted int           `json:"omitted"`
	Errors  []droppedJSON `json:"errors"`
}

func droppedJSONList(t *testing.T, res *Result) droppedJSONDoc {
	t.Helper()
	for _, a := range res.Artifacts {
		if strings.HasSuffix(a.Path, "-json-modules-dropped.json") {
			var doc droppedJSONDoc
			if err := json.Unmarshal(a.Content, &doc); err != nil {
				t.Fatalf("the list is not JSON: %v\n%s", err, a.Content)
			}
			return doc
		}
	}
	t.Fatalf("no list of dropped errors among the artifacts: %+v", res.Artifacts)
	return droppedJSONDoc{}
}

func TestTheListOfDroppedJSONErrorsIsCappedAndTheRestIsCounted(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n", "src/data/schema.json": "{}\n"})
	var out strings.Builder
	for i := 1; i <= 60; i++ {
		fmt.Fprintf(&out, "src/a.js(%d,1): error TS2307: Cannot find module './data/schema' or its corresponding type declarations.\n", i)
	}
	diags, _ := parseTSC(out.String())

	res := interpretTypes(in, diags, nil, 2)

	if m := metricOf(res, "json_modules_dropped"); m == nil || m.Value == nil || *m.Value != 60 {
		t.Errorf("metric = %+v, want all 60 counted", m)
	}
	doc := droppedJSONList(t, res)
	if doc.Dropped != 60 || len(doc.Errors) != 50 || doc.Omitted != 10 || doc.Errors[49].Line != 50 {
		t.Errorf("list = dropped %d, %d entries, omitted %d: want 60, 50 (the first by position) and 10", doc.Dropped, len(doc.Errors), doc.Omitted)
	}
	if m := metricOf(res, "resolution_errors"); m == nil || m.Value == nil || *m.Value != 0 || len(res.Findings) != 0 {
		t.Errorf("metric = %+v, findings = %d: dropped errors count nowhere else", m, len(res.Findings))
	}
}

func TestWithoutDroppedJSONErrorsTheMetricIsZeroAndThereIsNoList(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	diags, _ := parseTSC("src/a.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n")

	res := interpretTypes(in, diags, nil, 2)

	if m := metricOf(res, "json_modules_dropped"); m == nil || m.Value == nil || *m.Value != 0 {
		t.Errorf("metric = %+v, want 0", m)
	}
	for _, a := range res.Artifacts {
		t.Errorf("unexpected artifact %s", a.Path)
	}
}
