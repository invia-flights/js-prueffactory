package checks

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam: what tests.smells, deps.engines and quality.metrics ask of the combined
// ESLint run (their rule groups) and what they make of its output. The run
// itself needs Docker and is covered by the docker-tagged test in internal/cli.

func TestTheThreeChecksAreImplementedPerPackageAndOnlyTestsSmellsCanFireGates(t *testing.T) {
	for id, gates := range map[string]bool{"tests.smells": true, "deps.engines": false, "quality.metrics": false} {
		entry, ok := Lookup(id)
		if !ok || entry.Status != Implemented || entry.Scope != PerPackage || entry.CanFireGates != gates {
			t.Errorf("%s = %+v, want implemented per package, gates=%v", id, entry, gates)
		}
	}
}

func ruleNames(g eslintGroupSpec) []string {
	var out []string
	for _, r := range g.Rules {
		out = append(out, r.Name)
	}
	return out
}

func TestTheTestSmellsGroupHoldsTheThirteenMochaRulesOnTestCodeWithTestAsATestCaseName(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	g, ok := eslintGroups["tests.smells"]
	if !ok {
		t.Fatal("tests.smells has no rule group")
	}

	spec := g.spec(in)

	want := "mocha/handle-done-callback,mocha/no-async-and-done,mocha/no-async-in-sync-tests,mocha/no-async-suite,mocha/no-code-after-done," +
		"mocha/no-conditional-tests,mocha/no-done-twice,mocha/no-empty-title,mocha/no-exclusive-tests,mocha/no-identical-title," +
		"mocha/no-nested-tests,mocha/no-pending-tests,mocha/no-return-and-done"
	got := ruleNames(spec)
	if len(got) != 13 {
		t.Errorf("rules = %v, want 13", got)
	}
	if strings.Join(got, ",") != want {
		t.Errorf("rules = %v, want the spec's list in name order", got)
	}
	if !spec.TestOnly || len(spec.Plugins) != 1 || spec.Plugins[0] != "mocha" || spec.CoreProblem {
		t.Errorf("spec = %+v, want the mocha plugin on Test code only", spec)
	}
	names, _ := json.Marshal(spec.Settings)
	if !strings.Contains(string(names), `"name":"test"`) || !strings.Contains(string(names), `"type":"testCase"`) {
		t.Errorf("settings = %s, want test added as a test-case name", names)
	}
}

func TestTheEnginesGroupHoldsTheFourPluginNRulesWithTheContextsNodeVersion(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	in.Context.Node.Version = "22.11.0"
	g, ok := eslintGroups["deps.engines"]
	if !ok {
		t.Fatal("deps.engines has no rule group")
	}

	spec := g.spec(in)

	want := "n/no-deprecated-api,n/no-unsupported-features/es-builtins,n/no-unsupported-features/es-syntax,n/no-unsupported-features/node-builtins"
	if strings.Join(ruleNames(spec), ",") != want {
		t.Errorf("rules = %v", ruleNames(spec))
	}
	if spec.TestOnly || len(spec.Plugins) != 1 || spec.Plugins[0] != "n" {
		t.Errorf("spec = %+v, want the n plugin on every file", spec)
	}
	settings, _ := json.Marshal(spec.Settings)
	if string(settings) != `{"n":{"version":"22.11.0"}}` {
		t.Errorf("settings = %s, want the Context's exact Node version", settings)
	}
}

func TestANodeVersionThatIsNotPlainNumbersIsNeverGivenToThePlugin(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	g := eslintGroups["deps.engines"]
	// A bare major is the Context's Node major: the plugin is given the exact
	// version of the pinned image of that major (toolset/node.go), such as
	// 24.22.1 for Node 24.
	for version, want := range map[string]string{"24": "24.22.1", "22": "22.23.4", "22.11": "22.11", "22.11.0": "22.11.0", ">=18 || <x": "24.22.1", "": "24.22.1", "v22": "24.22.1"} {
		in.Context.Node.Version = version
		settings, _ := json.Marshal(g.spec(in).Settings)
		if string(settings) != `{"n":{"version":"`+want+`"}}` {
			t.Errorf("version %q gives settings %s, want %s", version, settings, want)
		}
	}
}

func TestTheAlpineVariantGetsTheSameExactVersionWithoutTheSuffix(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	in.Context.Node.Version, in.Context.Node.Variant = "26", "alpine"
	settings, _ := json.Marshal(eslintGroups["deps.engines"].spec(in).Settings)
	if string(settings) != `{"n":{"version":"26.12.1"}}` {
		t.Errorf("settings = %s, want the exact version of the Node 26 image", settings)
	}
}

func TestTheMetricsGroupReportsEveryFunctionOfTheThreeMeasuringRules(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	g, ok := eslintGroups["quality.metrics"]
	if !ok {
		t.Fatal("quality.metrics has no rule group")
	}

	spec := g.spec(in)

	if strings.Join(ruleNames(spec), ",") != "complexity,max-lines-per-function,sonarjs/cognitive-complexity" {
		t.Errorf("rules = %v", ruleNames(spec))
	}
	kinds := map[string]string{}
	for _, r := range spec.Rules {
		kinds[r.Name] = r.Measure
		if len(r.Options) != 1 {
			t.Errorf("%s options = %v, want a threshold of 0 so that every function is reported", r.Name, r.Options)
		}
	}
	if kinds["complexity"] != "cyclomatic" || kinds["max-lines-per-function"] != "length" || kinds["sonarjs/cognitive-complexity"] != "cognitive" {
		t.Errorf("measures = %v", kinds)
	}
	if spec.TestOnly || len(spec.Plugins) != 1 || spec.Plugins[0] != "sonarjs" {
		t.Errorf("spec = %+v", spec)
	}
}

func TestUnusedVarsIgnoresNamesThatStartWithAnUnderscore(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	g, ok := eslintGroups["lint.correctness"]
	if !ok {
		t.Fatal("lint.correctness has no rule group")
	}

	spec := g.spec(in)

	options, _ := json.Marshal(spec.CoreOptions["no-unused-vars"])
	want := `[{"argsIgnorePattern":"^_","caughtErrorsIgnorePattern":"^_","destructuredArrayIgnorePattern":"^_","varsIgnorePattern":"^_"}]`
	if string(options) != want {
		t.Errorf("no-unused-vars options = %s, want %s", options, want)
	}
	if len(spec.CoreOptions) != 1 {
		t.Errorf("core options = %v, want only no-unused-vars", spec.CoreOptions)
	}
}

func smellsRun() *eslintRun {
	rules := []string{"mocha/no-exclusive-tests", "mocha/no-pending-tests"}
	return &eslintRun{
		Output: eslintOutput{
			Version: "10.13.0",
			Groups:  map[string][]string{"tests.smells": rules, "lint.correctness": {"no-self-assign"}},
			Config:  map[string]any{"eslint": "10.13.0"},
			Results: []eslintFileResult{{Path: "test/index.test.js", Messages: []eslintMessage{
				{RuleID: "mocha/no-pending-tests", Message: "Unexpected pending mocha test.", Line: 8, Column: 3},
				{RuleID: "mocha/no-exclusive-tests", Message: "Unexpected exclusive mocha test.", Line: 6, Column: 1},
				{RuleID: "no-self-assign", Message: "another group's hit", Line: 1, Column: 1},
			}}},
		},
		ConfigSHA256: "abc123",
	}
}

func TestACommittedOnlyIsAGateAndOtherSmellsAreWarnings(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

	res := interpretTestsSmells(in, smellsRun())

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	if len(res.Findings) != 2 {
		t.Fatalf("findings = %+v, want the two smells and none of another group's rules", res.Findings)
	}
	for _, f := range res.Findings {
		rule := *f.RuleID
		switch rule {
		case "mocha/no-exclusive-tests":
			if !f.Gate || f.Severity != resultset.SeverityError || f.Confidence != resultset.ConfidenceConfirmed {
				t.Errorf("%s = %+v, want a Gate", rule, f)
			}
		case "mocha/no-pending-tests":
			if f.Gate || f.Severity != resultset.SeverityWarning {
				t.Errorf("%s = %+v, want a warning", rule, f)
			}
		default:
			t.Errorf("unexpected rule %s", rule)
		}
		if f.CheckID != "tests.smells" || f.Locations[0].Path != "test/index.test.js" {
			t.Errorf("finding = %+v", f)
		}
	}
	if res.Tool == nil || res.Tool.Name != "eslint" || len(res.ContextTools) == 0 {
		t.Errorf("tool = %+v, context tools = %+v", res.Tool, res.ContextTools)
	}
}

func TestEnginesFindingsAreWarningsInAnyFile(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	run := &eslintRun{Output: eslintOutput{
		Version: "10.13.0",
		Groups:  map[string][]string{"deps.engines": {"n/no-deprecated-api"}},
		Results: []eslintFileResult{{Path: "src/index.js", Messages: []eslintMessage{
			{RuleID: "n/no-deprecated-api", Message: "'new Buffer()' was deprecated since v6.0.0.", Line: 4, Column: 10},
		}}},
	}}

	res := interpretDepsEngines(in, run)

	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	f := res.Findings[0]
	if f.Gate || f.Severity != resultset.SeverityWarning || f.CheckID != "deps.engines" || *f.RuleID != "n/no-deprecated-api" {
		t.Errorf("finding = %+v, want a warning of deps.engines with the native rule ID", f)
	}
}

func measure(path string, kind string, line, value int) eslintMeasure {
	return eslintMeasure{Path: path, Kind: kind, Line: line, Column: 1, Value: value, Name: "f"}
}

func metricRun(measures ...eslintMeasure) *eslintRun {
	return &eslintRun{
		Output: eslintOutput{
			Version:  "10.13.0",
			Groups:   map[string][]string{"quality.metrics": {"complexity", "max-lines-per-function", "sonarjs/cognitive-complexity"}},
			Config:   map[string]any{"eslint": "10.13.0"},
			Measures: measures,
		},
		ConfigSHA256: "abc123",
	}
}

func metricValues(res *Result) map[string]float64 {
	out := map[string]float64{}
	for _, m := range res.Metrics {
		if m.Value != nil {
			out[m.Name] = *m.Value
		}
	}
	return out
}

func TestMetricsHavePercentilesMaximumAndCountsAboveTheThresholds(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	// Ten functions with cyclomatic complexity 1 to 10, except that the last is 25.
	// Their lengths are 10 to 100 and their cognitive complexities 1 to 10, with
	// the last at 30. Cognitive complexity 0 is never reported by the rule.
	var ms []eslintMeasure
	for i := 1; i <= 10; i++ {
		cyc, cog, length := i, i, i*10
		if i == 10 {
			cyc, cog = 25, 30
		}
		ms = append(ms, measure("src/a.js", "cyclomatic", i, cyc), measure("src/a.js", "length", i, length), measure("src/a.js", "cognitive", i, cog))
	}

	res := interpretQualityMetrics(in, metricRun(ms...))

	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Fatalf("status = %s, findings = %d, want a measurement without Findings", res.Status, len(res.Findings))
	}
	got := metricValues(res)
	want := map[string]float64{
		"functions":                     10,
		"cyclomatic_p50":                5,
		"cyclomatic_p90":                9,
		"cyclomatic_max":                25,
		"functions_above_cyclomatic_20": 1,
		"cognitive_p50":                 5,
		"cognitive_p90":                 9,
		"cognitive_max":                 30,
		"functions_above_cognitive_15":  1,
		"length_p50":                    50,
		"length_p90":                    90,
		"length_max":                    100,
		"functions_above_length_50":     5,
	}
	for name, v := range want {
		if g, ok := got[name]; !ok || g != v {
			t.Errorf("%s = %v (present %v), want %v", name, g, ok, v)
		}
	}
	for _, m := range res.Metrics {
		if m.Unit == "" {
			t.Errorf("metric %s has no unit", m.Name)
		}
	}
}

func TestFunctionsThatTheCognitiveRuleLeavesOutCountAsZero(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	// Four functions, one of them with cognitive complexity 8. The rule does not
	// report the other three because their value of 0 is not above its threshold.
	var ms []eslintMeasure
	for i := 1; i <= 4; i++ {
		ms = append(ms, measure("src/a.js", "cyclomatic", i, 1), measure("src/a.js", "length", i, 3))
	}
	ms = append(ms, measure("src/a.js", "cognitive", 4, 8))

	got := metricValues(interpretQualityMetrics(in, metricRun(ms...)))

	if got["cognitive_p50"] != 0 || got["cognitive_max"] != 8 || got["cognitive_p90"] != 8 {
		t.Errorf("cognitive = p50 %v, p90 %v, max %v; want 0, 8, 8", got["cognitive_p50"], got["cognitive_p90"], got["cognitive_max"])
	}
}

func TestMetricsOfAPackageWithoutFunctionsHaveNoValueAndAReason(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}

	res := interpretQualityMetrics(in, metricRun())

	if res.Status != resultset.StatusCompleted || len(res.Metrics) == 0 {
		t.Fatalf("status = %s, metrics = %d", res.Status, len(res.Metrics))
	}
	for _, m := range res.Metrics {
		if m.Value != nil || m.Reason == nil || *m.Reason == "" {
			t.Errorf("metric %+v, want no value and a reason", m)
		}
	}
}

// When ESLint could not parse the package's files, "no functions in Source code"
// would be false: the Report says that no function was measured because of the
// files it could not read.
func TestMetricsOfAPackageWhoseFilesDidNotParseSayWhy(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	run := metricRun()
	run.Output.Results = []eslintFileResult{{Path: "src/a.js", Messages: []eslintMessage{{Fatal: true, Message: "Parsing error"}}}}

	res := interpretQualityMetrics(in, run)

	for _, m := range res.Metrics {
		if m.Value != nil || m.Reason == nil || !strings.Contains(*m.Reason, "could not parse") {
			t.Fatalf("metric %+v, want no value and a reason that names the unparsed files", m)
		}
	}
}

func TestThePerFunctionValuesAreAnArtifact(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	res := interpretQualityMetrics(in, metricRun(measure("src/a.js", "cyclomatic", 3, 4), measure("src/a.js", "length", 3, 9)))

	if len(res.Artifacts) != 1 {
		t.Fatalf("artifacts = %d, want the per-function values", len(res.Artifacts))
	}
	a := res.Artifacts[0]
	if a.MediaType != "application/json" || !strings.HasPrefix(a.Path, "artifacts/quality.metrics/") || !strings.Contains(a.Path, in.Context.ID) {
		t.Errorf("artifact = %+v", a)
	}
	var doc struct {
		Functions []struct {
			Path       string `json:"path"`
			Line       int    `json:"line"`
			Cyclomatic int    `json:"cyclomatic"`
			Length     int    `json:"length"`
			Cognitive  int    `json:"cognitive"`
		} `json:"functions"`
		ConfigSHA256 string `json:"config_sha256"`
	}
	if err := json.Unmarshal(a.Content, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Functions) != 1 || doc.Functions[0].Path != "src/a.js" || doc.Functions[0].Line != 3 ||
		doc.Functions[0].Cyclomatic != 4 || doc.Functions[0].Length != 9 {
		t.Errorf("functions = %+v", doc.Functions)
	}
	if doc.ConfigSHA256 != "abc123" {
		t.Errorf("config hash = %q", doc.ConfigSHA256)
	}
}

func TestMeasuresThatCouldNotBeReadOrWereCutAreALimitationAndMakeTheCheckPartial(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	run := metricRun(measure("src/a.js", "cyclomatic", 3, 4), measure("src/a.js", "length", 3, 9))
	run.Output.MeasuresDropped = 7

	res := interpretQualityMetrics(in, run)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "check_could_not_run_on_some_files" {
		t.Errorf("status = %s, %s", res.Status, res.ReasonCode)
	}
	if !strings.Contains(limitationText(res), "7") {
		t.Errorf("limitations = %q, want the count of left-out measures", limitationText(res))
	}
}

// A file that ESLint could not parse has no hits because nobody looked, so a
// Check that reads the run is partial when a file of its scope was not parsed.
// What counts as the scope: every linted file for lint.correctness and
// deps.engines, Test code for tests.smells.

func unparsedResult(path string) eslintFileResult {
	return eslintFileResult{Path: path, Messages: []eslintMessage{{Fatal: true, Message: "Parsing error: Unexpected token", Line: 1, Column: 1}}}
}

func TestEveryCheckOfTheRunThatCoversAnUnparsedFileIsPartialWithTheCountInItsReason(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	interpreters := map[string]func(*Input, *eslintRun) *Result{
		"lint.correctness": interpretLintCorrectness,
		"deps.engines":     interpretDepsEngines,
		"tests.smells":     interpretTestsSmells,
	}
	for id, interpret := range interpreters {
		t.Run(id, func(t *testing.T) {
			// src/esm.mjs is Source code, test/index.test.js is Test code.
			run := &eslintRun{Output: eslintOutput{
				Groups:  map[string][]string{id: nil},
				Results: []eslintFileResult{unparsedResult("test/index.test.js"), unparsedResult("src/a.js")},
			}}
			want := 2
			if id == "tests.smells" {
				want = 1 // src/a.js is not Test code
			}

			res := interpret(in, run)

			if res.Status != resultset.StatusPartial || res.ReasonCode != "files_not_parsed" {
				t.Fatalf("status = %s, %s, want partial with files_not_parsed", res.Status, res.ReasonCode)
			}
			wantReason := fmt.Sprintf("ESLint could not parse %d file", want)
			if !strings.Contains(res.Reason, wantReason) {
				t.Errorf("reason = %q, want it to contain %q", res.Reason, wantReason)
			}
			var limit *resultset.Limitation
			for i := range res.Limitations {
				if res.Limitations[i].ReasonCode == "files_not_parsed" {
					limit = &res.Limitations[i]
				}
			}
			if limit == nil || !strings.Contains(limit.Message, "test/index.test.js") {
				t.Errorf("limitations = %+v, want files_not_parsed naming the file", res.Limitations)
			}
		})
	}
}

func TestTestSmellsStayCompletedWhenOnlySourceCodeDidNotParse(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	run := &eslintRun{Output: eslintOutput{
		Groups:  map[string][]string{"tests.smells": nil},
		Results: []eslintFileResult{unparsedResult("src/a.js")},
	}}

	res := interpretTestsSmells(in, run)

	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s (%s): the Check looks at Test code only, and that parsed", res.Status, res.Reason)
	}
}

func TestOversizedAndUnparsedFilesBothShowInThePartialReason(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), SnapshotDir: dir}
	run := &eslintRun{Output: eslintOutput{
		Groups:  map[string][]string{"lint.correctness": nil},
		Results: []eslintFileResult{unparsedResult("src/a.js")},
	}, Oversized: []string{"src/big.js"}}

	res := interpretLintCorrectness(in, run)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "files_not_parsed" ||
		!strings.Contains(res.Reason, "1 file") || !strings.Contains(res.Reason, "files") {
		t.Errorf("status = %s, %s: %q", res.Status, res.ReasonCode, res.Reason)
	}
}
