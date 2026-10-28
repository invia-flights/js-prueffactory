package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func cyclesInput(t *testing.T) *Input {
	t.Helper()
	proj, c, dir := qualitySignalsPackageContext(t)
	return &Input{Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir}
}

// The shape of the helper's output for quality-signals, whose cycle-a.js and
// cycle-b.js import each other, and for a project whose Source code imports
// mocha, a devDependency, and an alias that nothing configures.
func cruiseOutput() cruiseResult {
	return cruiseResult{
		Version: "18.7.0", TotalCruised: 5,
		Violations: []cruiseViolation{
			{Rule: "no-circular", From: "src/cycle-a.js", To: "src/cycle-b.js", Cycle: []string{"src/cycle-b.js", "src/cycle-a.js"}},
			{Rule: "not-to-dev-dep", From: "src/index.js", To: "node_modules/mocha/index.js", Specifier: "mocha"},
		},
		Unresolved: []cruiseUnresolved{{From: "src/index.js", Module: "@app/thing"}, {From: "src/index.js", Module: "~/thing"}},
	}
}

// qualitySignalsEntries are the production entry points of quality-signals,
// whose package.json names src/index.js as `main`.
var qualitySignalsEntries = productionEntries{Files: []string{"src/index.js"}}

// A service whose index.js loads src/app.js, which loads a devDependency both
// at the top and lazily, and whose dev/generate.js, which only an npm script
// runs, loads one too.
func devScriptsOutput() cruiseResult {
	return cruiseResult{
		Version: "18.7.0", TotalCruised: 4,
		Violations: []cruiseViolation{
			{Rule: "not-to-dev-dep", From: "src/app.js", To: "node_modules/mocha/index.js", Specifier: "mocha"},
			{Rule: "not-to-dev-dep", From: "src/lazy.js", To: "node_modules/mocha/index.js", Specifier: "mocha"},
			{Rule: "not-to-dev-dep", From: "dev/generate.js", To: "node_modules/mocha/index.js", Specifier: "mocha"},
			{Rule: "no-circular", From: "dev/generate.js", To: "dev/helper.js", Cycle: []string{"dev/helper.js", "dev/generate.js"}},
		},
		Edges: map[string][]string{
			"index.js":        {"src/app.js"},
			"src/app.js":      {"src/lazy.js"},
			"dev/generate.js": {"dev/helper.js"},
			"dev/helper.js":   {"dev/generate.js"},
		},
	}
}

func TestOnlyFilesTheProductionEntryPointsReachAreReportedForDevDependencies(t *testing.T) {
	res := interpretCycles(cyclesInput(t), devScriptsOutput(), nil, productionEntries{Files: []string{"index.js"}})

	if res.Status != resultset.StatusCompleted || len(res.Limitations) != 0 {
		t.Fatalf("result = %+v", res)
	}
	got := map[string]resultset.Finding{}
	for _, f := range findingsByRule(res)["dev-dependency-in-production"] {
		got[f.Locations[0].Path] = f
	}
	if len(got) != 2 {
		t.Fatalf("findings on %v, want src/app.js and src/lazy.js only: dev/generate.js is reached by no entry point", got)
	}
	for _, file := range []string{"src/app.js", "src/lazy.js"} {
		f, ok := got[file]
		if !ok {
			t.Errorf("no finding on %s", file)
			continue
		}
		if !strings.Contains(f.Message, "`index.js`") || !strings.Contains(f.Message, "mocha") {
			t.Errorf("message = %q, want it to name the entry point index.js and the package", f.Message)
		}
		if f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate {
			t.Errorf("finding = %+v, want a likely warning without a Gate", f)
		}
	}
	if got := findingsByRule(res)["circular-import"]; len(got) != 1 {
		t.Errorf("a cycle is reported wherever it is: %+v", got)
	}
}

func TestADevDependencyFindingKeepsItsIdentityWhenTheEntryPointsAreKnown(t *testing.T) {
	narrowed := findingsByRule(interpretCycles(cyclesInput(t), devScriptsOutput(), nil, productionEntries{Files: []string{"index.js"}}))["dev-dependency-in-production"]
	fallback := findingsByRule(interpretCycles(cyclesInput(t), devScriptsOutput(), nil, productionEntries{}))["dev-dependency-in-production"]

	before := map[string]resultset.Finding{}
	for _, f := range fallback {
		before[f.Locations[0].Path] = f
	}
	for _, f := range narrowed {
		b := before[f.Locations[0].Path]
		if f.Fingerprint != b.Fingerprint || *f.RuleID != *b.RuleID || f.Severity != b.Severity || f.Confidence != b.Confidence {
			t.Errorf("%s: %+v, want the identity of %+v", f.Locations[0].Path, f, b)
		}
	}
}

func TestWithoutEntryPointsEverySourceFileCountsAndALimitationSaysSo(t *testing.T) {
	res := interpretCycles(cyclesInput(t), devScriptsOutput(), nil, productionEntries{})

	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s, want completed: the fallback reports more, not less", res.Status)
	}
	if got := len(findingsByRule(res)["dev-dependency-in-production"]); got != 3 {
		t.Errorf("dev dependency findings = %d, want all 3", got)
	}
	if len(res.Limitations) != 1 {
		t.Fatalf("limitations = %+v", res.Limitations)
	}
	lim := res.Limitations[0]
	if lim.ReasonCode != "production_entry_points_unknown" || lim.CheckID == nil || *lim.CheckID != "modules.cycles" {
		t.Errorf("limitation = %+v", lim)
	}
	for _, want := range []string{"`main`", "`index.js`", "`exports`", "`bin`", "`start`"} {
		if !strings.Contains(lim.Message, want) {
			t.Errorf("message = %q, want it to name %s", lim.Message, want)
		}
	}
}

// deployedJobInput is the Input of a made-up service whose package.json names
// no entry point and whose Helm values run the npm script `job` as a CronJob.
func deployedJobInput(t *testing.T) *Input {
	t.Helper()
	proj := tree(t, map[string]string{
		"package.json":           `{"name": "svc", "scripts": {"job": "node src/jobs/job.js", "generate": "node dev/generate.js"}}`,
		"package-lock.json":      `{"lockfileVersion": 3, "packages": {}}`,
		"charts/svc/Chart.yaml":  v2Chart,
		"charts/svc/values.yaml": "cronJob:\n  command: [ \"npm\", \"run\", \"job\" ]\n",
		"src/jobs/job.js":        "require('../../dev/job-mock');\n",
		"dev/job-mock.js":        "module.exports = () => require('mocha');\n",
		"dev/generate.js":        "require('mocha');\n",
	})
	for i := range proj.Contexts {
		if proj.Contexts[i].Package != nil {
			return &Input{Project: proj, Context: &proj.Contexts[i], OriginalPath: "/original", SnapshotDir: proj.Root}
		}
	}
	t.Fatal("the made-up service has no package Context")
	return nil
}

// deployedJobOutput is the helper's output for deployedJobInput.
func deployedJobOutput() cruiseResult {
	return cruiseResult{
		Version: "18.7.0", TotalCruised: 3,
		Violations: []cruiseViolation{
			{Rule: "not-to-dev-dep", From: "dev/job-mock.js", To: "node_modules/mocha/index.js", Specifier: "mocha"},
			{Rule: "not-to-dev-dep", From: "dev/generate.js", To: "node_modules/mocha/index.js", Specifier: "mocha"},
		},
		Edges: map[string][]string{"src/jobs/job.js": {"dev/job-mock.js"}},
	}
}

func TestAnEntryPointThatOnlyADeploymentFileStartsNarrowsTheDevDependencyRule(t *testing.T) {
	in := deployedJobInput(t)
	targets, _ := cruiseTargets(in.Context)

	res := interpretCycles(in, deployedJobOutput(), nil, in.cyclesEntryPoints(context.Background(), targets))

	dev := findingsByRule(res)["dev-dependency-in-production"]
	if len(dev) != 1 || dev[0].Locations[0].Path != "dev/job-mock.js" {
		t.Fatalf("findings = %+v, want one on dev/job-mock.js: dev/generate.js runs only from an npm script no deployment file names", dev)
	}
	want := "dev/job-mock.js, reached from the production entry point `src/jobs/job.js` (run by `charts/svc/values.yaml` through `npm run job`), imports `mocha`"
	if !strings.HasPrefix(dev[0].Message, want) {
		t.Errorf("message = %q, want it to start %q", dev[0].Message, want)
	}
	// The value before deployment files counted, and before ticket 06: the
	// SHA-256 of "modules.cycles\0dev-dependency-in-production\0dev/job-mock.js\0mocha\0".
	// The fingerprint leaves the entry point out.
	if got := dev[0].Fingerprint.Value; got != "4ab2ee73370a5cdb3d93f8342ac199af2b08d3e318fc9266633f225c77d22e85" {
		t.Errorf("fingerprint = %s, want the one it had before", got)
	}
	for _, l := range res.Limitations {
		if l.ReasonCode == "production_entry_points_unknown" {
			t.Errorf("the deployment file names an entry point, yet: %+v", l)
		}
	}
}

func TestWithoutEntryPointsTheLimitationNamesTheDeploymentFilesAmongWhatWasLookedFor(t *testing.T) {
	res := interpretCycles(cyclesInput(t), devScriptsOutput(), nil, productionEntries{})

	if len(res.Limitations) != 1 || !strings.Contains(res.Limitations[0].Message, "Helm") ||
		!strings.Contains(res.Limitations[0].Message, "Kubernetes manifests") || !strings.Contains(res.Limitations[0].Message, "Dockerfiles") {
		t.Errorf("limitations = %+v, want production_entry_points_unknown naming the deployment files", res.Limitations)
	}
}

// A project with two packages: the root package names its `main`, the nested
// ci/complexity has no entry point at all. Only the nested package falls back,
// and its Limitation says which package.json it is about.
func TestOnlyThePackageWithoutEntryPointsGetsTheLimitationAndItNamesItsPackageJSON(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"package.json":                `{"name": "root", "main": "server.js"}`,
		"server.js":                   "'use strict';\n",
		"ci/complexity/package.json":  `{"name": "complexity", "scripts": {"report": "node report.js"}}`,
		"ci/complexity/report.js":     "'use strict';\n",
		"ci/complexity/lib/helper.js": "'use strict';\n",
	} {
		writeCyclesFile(t, filepath.Join(dir, filepath.FromSlash(name)), content)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}

	// The packages share one Run, as in the engine.
	shared := NewShared()
	got := map[string][]resultset.Limitation{}
	for i := range proj.Contexts {
		c := &proj.Contexts[i]
		if c.Package == nil {
			continue
		}
		in := &Input{Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir, Shared: shared}
		targets, held := cruiseTargets(c)
		res := interpretCycles(in, cruiseResult{Version: "18.7.0"}, held, in.cyclesEntryPoints(context.Background(), targets))
		got[c.Package.Path] = res.Limitations
	}

	if len(got) != 2 {
		t.Fatalf("packages = %v, want . and ci/complexity", got)
	}
	if len(got["."]) != 0 {
		t.Errorf("the root package names its main, yet: %+v", got["."])
	}
	nested := got["ci/complexity"]
	if len(nested) != 1 || nested[0].ReasonCode != "production_entry_points_unknown" {
		t.Fatalf("ci/complexity limitations = %+v, want one production_entry_points_unknown", nested)
	}
	if nested[0].Path == nil || *nested[0].Path != "ci/complexity/package.json" {
		t.Errorf("path = %v, want ci/complexity/package.json", nested[0].Path)
	}
	if !strings.HasPrefix(nested[0].Message, "No production entry point of this package") {
		t.Errorf("message = %q, want it to start with \"No production entry point of this package\", since the path says which one", nested[0].Message)
	}
}

// Every Limitation of modules.cycles is about one package and names its
// package.json, so a Report on several packages says which one it is about.
func TestEveryLimitationOfTheCheckNamesThePackageJSON(t *testing.T) {
	out := cruiseOutput()
	for i := 0; i <= cruiseMaxFindings; i++ {
		out.Violations = append(out.Violations, cruiseViolation{
			Rule: "not-to-dev-dep", From: fmt.Sprintf("src/gen/f%04d.js", i), To: "node_modules/mocha/index.js", Specifier: "mocha",
		})
	}

	res := interpretCycles(cyclesInput(t), out, []string{"src/[id].js"}, productionEntries{})

	codes := map[string]bool{}
	for _, l := range res.Limitations {
		codes[l.ReasonCode] = true
		if l.Path == nil || *l.Path != "package.json" {
			t.Errorf("%s: path = %v, want package.json", l.ReasonCode, l.Path)
		}
	}
	for _, want := range []string{"findings_cut", "imports_not_resolved", "production_entry_points_unknown", "files_not_scanned"} {
		if !codes[want] {
			t.Errorf("no %s among %+v", want, res.Limitations)
		}
	}
}

func writeCyclesFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestACycleIsOneWarningWhoseLocationsAreItsFiles(t *testing.T) {
	res := interpretCycles(cyclesInput(t), cruiseOutput(), nil, qualitySignalsEntries)

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	by := findingsByRule(res)
	got := by["circular-import"]
	if len(got) != 1 {
		t.Fatalf("cycle findings = %+v", got)
	}
	f := got[0]
	if f.Severity != resultset.SeverityWarning || f.Gate {
		t.Errorf("a cycle is a warning without a Gate: %+v", f)
	}
	if len(f.Locations) != 2 || f.Locations[0].Path != "src/cycle-a.js" || f.Locations[0].Role != "primary" ||
		f.Locations[1].Path != "src/cycle-b.js" || f.Locations[1].Role != "related" {
		t.Errorf("locations = %+v, want the cycle's files, smallest path first", f.Locations)
	}
	if !strings.Contains(f.Message, "src/cycle-a.js -> src/cycle-b.js -> src/cycle-a.js") {
		t.Errorf("message = %q, want the ring starting at the smallest path", f.Message)
	}
}

func TestTheSameCycleSeenFromEachOfItsEdgesIsReportedOnce(t *testing.T) {
	out := cruiseOutput()
	out.Violations = []cruiseViolation{
		{Rule: "no-circular", From: "src/cycle-a.js", To: "src/cycle-b.js", Cycle: []string{"src/cycle-b.js", "src/cycle-a.js"}},
		{Rule: "no-circular", From: "src/cycle-b.js", To: "src/cycle-a.js", Cycle: []string{"src/cycle-a.js", "src/cycle-b.js"}},
	}
	in := cyclesInput(t)

	res := interpretCycles(in, out, nil, qualitySignalsEntries)

	if got := len(findingsByRule(res)["circular-import"]); got != 1 {
		t.Fatalf("cycle findings = %d, want 1", got)
	}
}

func TestAProductionImportOfADevDependencyIsAWarningOnTheImportingFile(t *testing.T) {
	res := interpretCycles(cyclesInput(t), cruiseOutput(), nil, qualitySignalsEntries)

	got := findingsByRule(res)["dev-dependency-in-production"]
	if len(got) != 1 {
		t.Fatalf("findings = %+v", got)
	}
	f := got[0]
	if f.Severity != resultset.SeverityWarning || f.Gate {
		t.Errorf("want a warning without a Gate: %+v", f)
	}
	if len(f.Locations) != 1 || f.Locations[0].Path != "src/index.js" {
		t.Errorf("locations = %+v", f.Locations)
	}
	if !strings.Contains(f.Message, "mocha") {
		t.Errorf("message = %q, want it to name the package", f.Message)
	}
}

func TestImportsTheCruiserCannotResolveAreListedAsALimitation(t *testing.T) {
	res := interpretCycles(cyclesInput(t), cruiseOutput(), nil, qualitySignalsEntries)

	if len(res.Limitations) != 1 {
		t.Fatalf("limitations = %+v", res.Limitations)
	}
	lim := res.Limitations[0]
	if lim.ReasonCode != "imports_not_resolved" || lim.CheckID == nil || *lim.CheckID != "modules.cycles" {
		t.Errorf("limitation = %+v", lim)
	}
	for _, want := range []string{"@app/thing", "~/thing"} {
		if !strings.Contains(lim.Message, want) {
			t.Errorf("message = %q, want it to list %s", lim.Message, want)
		}
	}
}

func TestACleanGraphHasNoFindingsAndNoLimitation(t *testing.T) {
	res := interpretCycles(cyclesInput(t), cruiseResult{Version: "18.7.0", TotalCruised: 5}, nil, qualitySignalsEntries)
	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 || len(res.Limitations) != 0 {
		t.Errorf("result = %+v", res)
	}
}

func TestFilesLeftOutBecauseTheirNamesAreGlobsAreALimitationAndTheCheckStillCompletes(t *testing.T) {
	res := interpretCycles(cyclesInput(t), cruiseResult{Version: "18.7.0"}, []string{"src/[id].js"}, qualitySignalsEntries)

	if res.Status != resultset.StatusCompleted {
		t.Errorf("status = %s, want completed", res.Status)
	}
	if len(res.Limitations) != 1 || res.Limitations[0].ReasonCode != "files_not_scanned" || !strings.Contains(res.Limitations[0].Message, "src/[id].js") {
		t.Errorf("limitations = %+v", res.Limitations)
	}
}

func TestACruiseErrorIsAToolError(t *testing.T) {
	res := interpretCycles(cyclesInput(t), cruiseResult{Error: "boom"}, nil, qualitySignalsEntries)
	if res.Status != resultset.StatusToolError || res.ReasonCode != "dependency_cruiser_failed" || !strings.Contains(res.Reason, "boom") {
		t.Errorf("status = %s, %s, %q", res.Status, res.ReasonCode, res.Reason)
	}
}

func TestOnlySourceCodeJavaScriptGoesToTheCruiserAndGlobNamesAreHeldBack(t *testing.T) {
	_, c, _ := qualitySignalsPackageContext(t)
	targets, held := cruiseTargets(c)
	got := map[string]bool{}
	for _, f := range targets {
		got[f] = true
		if !strings.HasPrefix(f, "src/") {
			t.Errorf("unexpected target %s: tests, Test data and Build output are not production code", f)
		}
	}
	for _, f := range []string{"src/index.js", "src/cycle-a.js", "src/cycle-b.js"} {
		if !got[f] {
			t.Errorf("%s is Source code and missing from %v", f, targets)
		}
	}
	if len(held) != 0 {
		t.Errorf("held = %v", held)
	}

	// The names below are made up by the project, which is untrusted.
	dir := t.TempDir()
	for _, name := range []string{"src/ok.js", "src/[id].js", "src/{a,b}.js", "src/*.js", "src/a(1).js", "src/!x.js", "src/-x.js", "src/with space.js"} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("'use strict';\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	var pkgCtx *discovery.Context
	for i := range p.Contexts {
		if p.Contexts[i].Package != nil {
			pkgCtx = &p.Contexts[i]
		}
	}
	targets, held = cruiseTargets(pkgCtx)
	if strings.Join(targets, ",") != "src/-x.js,src/ok.js,src/with space.js" {
		t.Errorf("targets = %v", targets)
	}
	if strings.Join(held, ",") != "src/!x.js,src/*.js,src/[id].js,src/a(1).js,src/{a,b}.js" {
		t.Errorf("held back = %v", held)
	}
}

func TestTheRuleFileHasExactlyTheTwoRulesAndNothingFromTheProject(t *testing.T) {
	var rules struct {
		Forbidden []struct {
			Name     string `json:"name"`
			Severity string `json:"severity"`
		} `json:"forbidden"`
	}
	if err := json.Unmarshal(cruiseRules, &rules); err != nil {
		t.Fatal(err)
	}
	if len(rules.Forbidden) != 2 || rules.Forbidden[0].Name != "no-circular" || rules.Forbidden[1].Name != "not-to-dev-dep" {
		t.Fatalf("rules = %+v", rules.Forbidden)
	}
	for _, r := range rules.Forbidden {
		if r.Severity != "warn" {
			t.Errorf("%s has severity %q: findings are warnings", r.Name, r.Severity)
		}
	}
}
