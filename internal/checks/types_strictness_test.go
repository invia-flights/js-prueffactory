package checks

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam: what types.strictness decides on the host. Its Applicability, the two
// generated configs, and what it makes of the output of the two tsc runs and
// of type-coverage. The runs themselves need Docker and are covered by the
// docker-tagged test in internal/cli.

func TestTypesStrictnessIsImplementedPerPackageAsACodeCorrectnessCheckWithoutGates(t *testing.T) {
	entry, ok := Lookup("types.strictness")
	if !ok || entry.Status != Implemented || entry.Scope != PerPackage || entry.Area != AreaCodeCorrectness {
		t.Fatalf("types.strictness = %+v, want implemented per package in Code correctness", entry)
	}
	if entry.CanFireGates {
		t.Error("types.strictness reports notes, never Gates")
	}
}

func TestTypesStrictnessNeedsTheInstallAndTheToolsetLikeTypesJavascript(t *testing.T) {
	proj, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	c := packageContext(t, proj, ".")
	impl := Implementation("types.strictness")

	if got := impl.(PrerequisiteUser).Prerequisites(c); !reflect.DeepEqual(got, []string{"package.install"}) {
		t.Errorf("prerequisites = %v, want package.install", got)
	}
	if !impl.(WorkingCopyUser).UsesWorkingCopy() {
		t.Error("the Check reads the installed dependencies in the Working copy")
	}
	if !impl.(ToolsetUser).UsesToolset(c) || len(impl.(ImageUser).Images(c)) != 1 {
		t.Error("the Check runs TypeScript 6 and type-coverage from the toolset in one image")
	}
}

func TestTypesStrictnessIsApplicableWhereTypesJavascriptIsAndUnsupportedForTheSamePackages(t *testing.T) {
	impl := Implementation("types.strictness")

	proj, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n"})
	if got, reason := impl.Applicability(proj, packageContext(t, proj, ".")); got != resultset.Applicable || reason != "" {
		t.Errorf("a package with JavaScript = %s (%s), want applicable", got, reason)
	}
	if got, reason := impl.Applicability(proj, &proj.Contexts[0]); got != resultset.NotApplicable || !strings.Contains(reason, "types.strictness") {
		t.Errorf("the project Context = %s (%q), want not applicable naming this Check", got, reason)
	}

	empty, _ := writeTree(t, map[string]string{"package.json": `{"name":"x"}`, "README.md": "hi\n"})
	if got, _ := impl.Applicability(empty, packageContext(t, empty, ".")); got != resultset.NotApplicable {
		t.Errorf("a package without JavaScript = %s, want not applicable", got)
	}

	build, _ := writeTree(t, map[string]string{
		"package.json": `{"name":"x"}`, "src/a.ts": "export {};\n", "tsconfig.json": `{"compilerOptions":{"outDir":"dist"}}`,
	})
	got, reason := impl.Applicability(build, packageContext(t, build, "."))
	if got != resultset.Applicable || !strings.HasPrefix(reason, "unsupported: ") {
		t.Errorf("a package that needs a build step = %s (%q), want applicable with an unsupported reason", got, reason)
	}
	if pre := impl.(PrerequisiteUser).Prerequisites(packageContext(t, build, ".")); pre != nil {
		t.Errorf("an unsupported package has prerequisites %v, want none", pre)
	}
}

func strictConfig(t *testing.T, files []string, pkgPath, node string, mocha bool) map[string]any {
	t.Helper()
	data, err := typesTsconfigFor(files, pkgPath, node, mocha, true)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("the generated tsconfig is not JSON: %v\n%s", err, data)
	}
	return cfg
}

func TestTheStrictConfigIsTheBasicOneWithStrictOn(t *testing.T) {
	files := []string{"src/a.js", "src/b.ts"}
	basic := generatedConfig(t, files, "packages/api", "24", true)
	strict := strictConfig(t, files, "packages/api", "24", true)

	basicOpts, strictOpts := basic["compilerOptions"].(map[string]any), strict["compilerOptions"].(map[string]any)
	if strictOpts["strict"] != true || strictOpts["noImplicitAny"] != true {
		t.Errorf("strict = %v, noImplicitAny = %v, want both on", strictOpts["strict"], strictOpts["noImplicitAny"])
	}
	if basicOpts["strict"] != false || basicOpts["noImplicitAny"] != false {
		t.Errorf("the basic profile changed: %v", basicOpts)
	}
	// Everything else is identical: the same files, types, type roots and
	// resolution, so that the only difference between the runs is strictness.
	delete(basicOpts, "strict")
	delete(basicOpts, "noImplicitAny")
	delete(strictOpts, "strict")
	delete(strictOpts, "noImplicitAny")
	if !reflect.DeepEqual(basic, strict) {
		t.Errorf("the configs differ beyond strictness:\n%v\n%v", basic, strict)
	}
}

func TestTheBasicConfigOfTypesJavascriptStaysTheBasicProfile(t *testing.T) {
	data, err := typesTsconfig([]string{"src/a.js"}, ".", "24", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"strict": false`) {
		t.Errorf("tsconfig = %s", data)
	}
}

func TestTypeCoverageIsReadFromItsJSONOutput(t *testing.T) {
	got, err := parseTypeCoverage([]byte(`{"succeeded":true,"atLeastFailed":false,"correctCount":17,"percent":89.47,"percentString":"89.47","totalCount":19}`))
	if err != nil || got.Correct != 17 || got.Total != 19 {
		t.Fatalf("coverage = %+v, %v", got, err)
	}
	// type-coverage prints percent null for code without identifiers.
	none, err := parseTypeCoverage([]byte(`{"succeeded":true,"correctCount":0,"percent":null,"percentString":"NaN","totalCount":0}`))
	if err != nil || none.Total != 0 || none.Percent() != 100 {
		t.Errorf("no identifiers = %+v, %v, want 100 percent", none, err)
	}
	for _, bad := range []string{"", "not json", `{"succeeded":true}`, `{"totalCount":2,"correctCount":3}`} {
		if _, err := parseTypeCoverage([]byte(bad)); err == nil {
			t.Errorf("parseTypeCoverage(%q) succeeded, want an error", bad)
		}
	}
}

func TestThePercentIsComputedFromTheCountsAndNotTheRoundedPrintout(t *testing.T) {
	got := typeCoverage{Correct: 2, Total: 3}
	if p := got.Percent(); p < 66.66 || p > 66.67 {
		t.Errorf("percent = %v, want 66.666...", p)
	}
}

// strictInput is a package with a Source file and a Test code file.
func strictInput(t *testing.T) *Input {
	return typesInput(t, map[string]string{
		"package.json": `{"name":"x","scripts":{"test":"mocha"}}`, "src/a.js": "1;\n", "src/b.js": "1;\n", "src/c.ts": "export {};\n",
		"test/a.test.js": "1;\n",
	})
}

func diagnostics(t *testing.T, out string) []tscDiagnostic {
	t.Helper()
	diags, global := parseTSC(out)
	if len(global) > 0 {
		t.Fatalf("global diagnostics %v", global)
	}
	return diags
}

func strictRunOf(diags []tscDiagnostic, exit int) tscRun {
	return tscRun{Diagnostics: diags, Exit: exit}
}

var basicOnly = `src/a.js(3,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
`

var strictToo = basicOnly + `src/a.js(5,10): error TS7006: Parameter 'x' implicitly has an 'any' type.
src/b.js(2,7): error TS2531: Object is possibly 'null'.
`

func fullCoverage() typeCoverage { return typeCoverage{Correct: 10, Total: 10} }

func TestErrorsOnlyTheStrictRunReportsAreTheStrictGapAndBecomeNotes(t *testing.T) {
	in := strictInput(t)

	res := interpretStrictness(in, strictRunOf(diagnostics(t, basicOnly), 2), strictRunOf(diagnostics(t, strictToo), 2), fullCoverage(), nil)

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v, want the two strict-only errors, not the one both runs report", res.Findings)
	}
	f := res.Findings[0]
	if f.CheckID != "types.strictness" || f.ContextID != in.Context.ID || f.Gate || f.Severity != resultset.SeverityNote ||
		f.Confidence != resultset.ConfidenceSuspected {
		t.Errorf("finding = %+v, want a suspected note without Gate", f)
	}
	if f.RuleID == nil || *f.RuleID != "TS7006" || f.Locations[0].Path != "src/a.js" || f.Locations[0].Start == nil || f.Locations[0].Start.Line != 5 {
		t.Errorf("rule %v, location %+v", f.RuleID, f.Locations[0])
	}
	if !strings.Contains(f.Message, "TS7006") || !strings.Contains(f.Message, "implicitly has an 'any' type") {
		t.Errorf("message = %q", f.Message)
	}
	if g := res.Findings[1]; g.RuleID == nil || *g.RuleID != "TS2531" || g.Locations[0].Path != "src/b.js" {
		t.Errorf("second finding = %+v", g)
	}
	if m := metricOf(res, "strict_gap_errors"); m == nil || m.Value == nil || *m.Value != 2 || m.Unit != "errors" {
		t.Errorf("strict_gap_errors = %+v, want 2", m)
	}
}

func TestAnErrorBothRunsReportIsNoGapEvenWhenStrictModeWordsItDifferently(t *testing.T) {
	in := strictInput(t)
	basic := "src/a.js(3,1): error TS2322: Type 'string' is not assignable to type 'number'.\n"
	strict := "src/a.js(3,1): error TS2322: Type 'string | undefined' is not assignable to type 'number'.\n"

	res := interpretStrictness(in, strictRunOf(diagnostics(t, basic), 2), strictRunOf(diagnostics(t, strict), 2), fullCoverage(), nil)

	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v, want none: the error exists in the basic profile too", res.Findings)
	}
	if m := metricOf(res, "strict_gap_errors"); m == nil || *m.Value != 0 {
		t.Errorf("strict_gap_errors = %+v, want 0", m)
	}
}

func TestOnlySourceCodeCountsForTheStrictGap(t *testing.T) {
	in := strictInput(t)
	strict := strictToo + "test/a.test.js(1,1): error TS7006: Parameter 'y' implicitly has an 'any' type.\n" +
		"node_modules/dep/index.d.ts(1,1): error TS7006: Parameter 'z' implicitly has an 'any' type.\n"

	res := interpretStrictness(in, strictRunOf(nil, 0), strictRunOf(diagnostics(t, strict), 2), fullCoverage(), nil)

	if len(res.Findings) != 3 {
		t.Errorf("findings = %d, want the three in Source code and none in Test code or node_modules", len(res.Findings))
	}
}

func TestTheStrictGapIsCountedBeforeTheCutAndTheCutIsReported(t *testing.T) {
	in := strictInput(t)
	var b strings.Builder
	for i := 1; i <= typesMaxFindings+50; i++ {
		fmt.Fprintf(&b, "src/a.js(%d,1): error TS7006: Parameter 'p%d' implicitly has an 'any' type.\n", i, i)
	}

	res := interpretStrictness(in, strictRunOf(nil, 0), strictRunOf(diagnostics(t, b.String()), 2), fullCoverage(), nil)

	if len(res.Findings) != 2000 {
		t.Errorf("findings = %d, want the cap of 2000", len(res.Findings))
	}
	if m := metricOf(res, "strict_gap_errors"); m == nil || *m.Value != 2050 {
		t.Errorf("strict_gap_errors = %+v, want all 2050", m)
	}
	cut := false
	for _, l := range res.Limitations {
		cut = cut || (l.ReasonCode == "findings_cut" && l.CheckID != nil && *l.CheckID == "types.strictness")
	}
	if !cut {
		t.Errorf("limitations = %+v, want findings_cut", res.Limitations)
	}
	// The type coverage is complete, and the cut only shortens the list of
	// notes, so a large untyped project must not turn the Type coverage part
	// into unknown.
	if res.Status != resultset.StatusCompleted || res.ReasonCode != "" {
		t.Errorf("status = %s (%s), want completed", res.Status, res.ReasonCode)
	}
}

func TestTypeCoverageOfSourceCodeAndTestCodeAreTwoMetrics(t *testing.T) {
	in := strictInput(t)

	res := interpretStrictness(in, strictRunOf(nil, 0), strictRunOf(nil, 0),
		typeCoverage{Correct: 33, Total: 40}, &typeCoverage{Correct: 1, Total: 4})

	want := map[string]struct {
		v    float64
		unit string
	}{
		"type_coverage_percent": {82.5, "percent"}, "type_coverage_identifiers": {40, "identifiers"},
		"type_coverage_test_code_percent": {25, "percent"},
	}
	for name, w := range want {
		m := metricOf(res, name)
		if m == nil || m.Value == nil || *m.Value != w.v || m.Unit != w.unit {
			t.Errorf("%s = %+v, want %v %s", name, m, w.v, w.unit)
		}
	}
}

func TestAPackageWithoutTestCodeHasNoTestCodeMetric(t *testing.T) {
	res := interpretStrictness(strictInput(t), strictRunOf(nil, 0), strictRunOf(nil, 0), fullCoverage(), nil)

	if m := metricOf(res, "type_coverage_test_code_percent"); m != nil {
		t.Errorf("test code metric = %+v, want none", m)
	}
}

func TestCodeWithoutIdentifiersIsFullyCovered(t *testing.T) {
	res := interpretStrictness(strictInput(t), strictRunOf(nil, 0), strictRunOf(nil, 0), typeCoverage{}, nil)

	if m := metricOf(res, "type_coverage_percent"); m == nil || m.Value == nil || *m.Value != 100 {
		t.Errorf("type_coverage_percent = %+v, want 100", m)
	}
	if m := metricOf(res, "type_coverage_identifiers"); m == nil || *m.Value != 0 {
		t.Errorf("type_coverage_identifiers = %+v, want 0", m)
	}
}

func TestAFloodOfResolutionErrorsInTheStrictRunGetsTheProjectTsconfigLimitation(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.ts": "export {};\n", "src/b.js": "1;\n"})
	flood := resolutionDiagnostics(30) + strings.Repeat("src/b.js(1,1): error TS2339: Property 'x' does not exist on type '{}'.\n", 10)

	res := interpretStrictness(in, strictRunOf(diagnostics(t, flood), 2), strictRunOf(diagnostics(t, flood), 2), fullCoverage(), nil)

	found := false
	for _, l := range res.Limitations {
		found = found || (l.ReasonCode == "project_tsconfig_not_used" && l.CheckID != nil && *l.CheckID == "types.strictness")
	}
	if !found {
		t.Errorf("limitations = %+v, want project_tsconfig_not_used", res.Limitations)
	}
	if m := metricOf(res, "resolution_errors"); m == nil || *m.Value != 30 {
		t.Errorf("resolution_errors = %+v, want 30", m)
	}
	if len(res.Findings) != 0 {
		t.Errorf("findings = %d: errors that both runs report are no strict gap", len(res.Findings))
	}
}

func TestARequireOfAJSONFileThatNodeResolvesIsNoStrictGap(t *testing.T) {
	in := typesInput(t, map[string]string{"package.json": `{"name":"x"}`, "src/a.js": "1;\n", "src/data.json": "{}\n"})
	strict := "src/a.js(1,1): error TS2307: Cannot find module './data' or its corresponding type declarations.\n"

	res := interpretStrictness(in, strictRunOf(nil, 0), strictRunOf(diagnostics(t, strict), 2), fullCoverage(), nil)

	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v, want none: Node loads data.json", res.Findings)
	}
}

func TestToolProblemsOfEitherRunAreToolErrorsAndNotStatementsAboutTheProject(t *testing.T) {
	in := strictInput(t)
	cases := []struct {
		name          string
		basic, strict tscRun
		code          string
	}{
		{"basic run crashed", tscRun{Exit: 139}, tscRun{}, "tsc_failed"},
		{"strict run crashed", tscRun{}, tscRun{Exit: 3}, "tsc_failed"},
		{"strict run failed silently", tscRun{}, tscRun{Exit: 2}, "tsc_failed"},
		{"config problem", tscRun{Global: []string{"error TS5083: Cannot read file."}, Exit: 1}, tscRun{}, "tsc_config_error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := interpretStrictness(in, c.basic, c.strict, fullCoverage(), nil)
			if res.Status != resultset.StatusToolError || res.ReasonCode != c.code {
				t.Errorf("status %s, reason %s (%s), want tool_error %s", res.Status, res.ReasonCode, res.Reason, c.code)
			}
		})
	}
}

func TestTheResultNamesTheTypeScript6ToolsAndRecordsTheVersionInTheContext(t *testing.T) {
	res := interpretStrictness(strictInput(t), strictRunOf(nil, 0), strictRunOf(nil, 0), fullCoverage(), nil)

	if res.Tool == nil || res.Tool.Name != "tsc6" || res.Tool.Version == nil || *res.Tool.Version != "6.0.2" {
		t.Errorf("tool = %+v, want tsc6 at the pinned 6.0.2", res.Tool)
	}
	names := map[string]string{}
	for _, c := range res.ContextTools {
		names[c.Name] = c.Version
	}
	if names["typescript6"] != "6.0.2" || names["type-coverage"] != "2.30.4" || names["@types/node"] == "" {
		t.Errorf("context tools = %v, want typescript6, type-coverage and the @types", names)
	}
}
