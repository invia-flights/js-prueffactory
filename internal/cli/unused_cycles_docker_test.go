//go:build docker

package cli_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam A tests of quality.unused and modules.cycles with a real Docker daemon,
// the toolset volume and, for the devDependency case, the public npm registry.

func writeUnusedCyclesFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func ruleFindings(s *resultset.Set, check, rule string) []resultset.Finding {
	var out []resultset.Finding
	for _, f := range findingsOf(s, check) {
		if f.RuleID != nil && *f.RuleID == rule {
			out = append(out, f)
		}
	}
	return out
}

func TestQualitySignalsReportsItsImportCycleAndUnusedExportWithoutGates(t *testing.T) {
	original := copyProject(t, "quality-signals")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.unused,modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d, want 0: neither Check fires Gates\nstderr:\n%s", r.code, r.stderr)
	}
	if r.set.Summary.Gates != 0 {
		t.Errorf("gates = %d", r.set.Summary.Gates)
	}

	unused := oneExecution(t, &r.set, "quality.unused")
	cycles := oneExecution(t, &r.set, "modules.cycles")
	for _, e := range []resultset.Execution{unused, cycles} {
		if e.Status != resultset.StatusCompleted || e.Outcome == resultset.OutcomeFailed || e.ContextID != "C-0002" {
			t.Errorf("%s = %+v, want completed in the package Context", e.CheckID, e)
		}
	}
	if unused.Tool == nil || unused.Tool.Version == nil || *unused.Tool.Version != "6.43.0" {
		t.Errorf("knip tool = %+v", unused.Tool)
	}
	if cycles.Tool == nil || cycles.Tool.Version == nil || *cycles.Tool.Version != "18.7.0" {
		t.Errorf("dependency-cruiser tool = %+v", cycles.Tool)
	}

	cycle := ruleFindings(&r.set, "modules.cycles", "circular-import")
	if len(cycle) != 1 {
		t.Fatalf("cycle findings = %+v, want exactly the cycle-a/cycle-b cycle", findingsOf(&r.set, "modules.cycles"))
	}
	if f := cycle[0]; f.Severity != resultset.SeverityWarning || f.Gate ||
		len(f.Locations) != 2 || f.Locations[0].Path != "src/cycle-a.js" || f.Locations[1].Path != "src/cycle-b.js" {
		t.Errorf("cycle finding = %+v", f)
	}
	if got := len(findingsOf(&r.set, "modules.cycles")); got != 1 {
		t.Errorf("modules.cycles findings = %d, want only the cycle", got)
	}

	export := ruleFindings(&r.set, "quality.unused", "unused-export")
	if len(export) != 1 || !strings.Contains(export[0].Message, "unusedExport") ||
		export[0].Severity != resultset.SeverityNote || export[0].Gate || export[0].Locations[0].Path != "src/cycle-a.js" {
		t.Errorf("unused export findings = %+v", export)
	}
	for _, f := range findingsOf(&r.set, "quality.unused") {
		if f.Gate {
			t.Errorf("a Gate from quality.unused: %+v", f)
		}
		for _, l := range f.Locations {
			if strings.HasPrefix(l.Path, "dist/") || strings.HasPrefix(l.Path, "test/fixtures/") {
				t.Errorf("a finding in Build output or Test data: %+v", f)
			}
		}
	}

	var tools []string
	for _, c := range r.set.Contexts {
		if c.ID == "C-0002" {
			for _, tool := range c.Tools {
				tools = append(tools, tool.Name+"@"+tool.Version)
			}
		}
	}
	if !contains(tools, "knip@6.43.0") || !contains(tools, "dependency-cruiser@18.7.0") {
		t.Errorf("package Context tools = %v", tools)
	}
	r.assertNothingLeft(t)
}

func TestTheProjectsOwnKnipConfigIsUsedButItsCruiserConfigIsNot(t *testing.T) {
	original := copyProject(t, "quality-signals")
	// The project's Knip configuration decides what Knip reports.
	writeUnusedCyclesFile(t, filepath.Join(original, "knip.json"), `{"ignore": ["src/cycle-a.js"]}`)
	// A dependency-cruiser configuration of the project must not weaken ours.
	writeUnusedCyclesFile(t, filepath.Join(original, ".dependency-cruiser.js"), "module.exports = { forbidden: [], options: {} };\n")

	r := realRun(t, context.Background(), "test", original, "--only", "quality.unused,modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	if got := ruleFindings(&r.set, "quality.unused", "unused-export"); len(got) != 0 {
		t.Errorf("knip.json ignores src/cycle-a.js, yet: %+v", got)
	}
	if got := ruleFindings(&r.set, "modules.cycles", "circular-import"); len(got) != 1 {
		t.Errorf("the cycle must still be found: %+v", got)
	}
}

func TestFileNamesThatLookLikeOptionsOrGlobsAreNeverActedOn(t *testing.T) {
	original := copyProject(t, "quality-signals")
	// The names come from the project, which is untrusted. dependency-cruiser
	// reads its arguments as globs and has options such as --config.
	for _, name := range []string{"-x.js", "--config.js", "[id].js", "{a,b}.js", "*.js"} {
		writeUnusedCyclesFile(t, filepath.Join(original, "src", name), "'use strict';\n\nmodule.exports = { name: 'x' };\n")
	}

	r := realRun(t, context.Background(), "test", original, "--only", "modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "modules.cycles")
	if e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v), want completed with a Limitation for the held-back glob names", e.Status, e.Reason)
	}
	var limited bool
	for _, l := range r.set.Limitations {
		if l.ReasonCode == "files_not_scanned" && l.CheckID != nil && *l.CheckID == "modules.cycles" &&
			strings.Contains(l.Message, "[id].js") && strings.Contains(l.Message, "*.js") {
			limited = true
		}
	}
	if !limited {
		t.Errorf("limitations = %+v, want files_not_scanned naming the glob files", r.set.Limitations)
	}
	if got := ruleFindings(&r.set, "modules.cycles", "circular-import"); len(got) != 1 {
		t.Errorf("the cycle must still be found: %+v", got)
	}
}

func TestAProductionImportOfADevDependencyIsAWarning(t *testing.T) {
	original := copyProject(t, "clean-mocha")
	writeUnusedCyclesFile(t, filepath.Join(original, "src", "index.js"),
		"'use strict';\n\nconst mocha = require('mocha');\n\nfunction add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add, mocha };\n")

	r := realRun(t, context.Background(), "test", original, "--only", "modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	e := oneExecution(t, &r.set, "modules.cycles")
	if e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v)", e.Status, e.Reason)
	}
	got := ruleFindings(&r.set, "modules.cycles", "dev-dependency-in-production")
	if len(got) != 1 || got[0].Gate || got[0].Severity != resultset.SeverityWarning || got[0].Locations[0].Path != "src/index.js" ||
		!strings.Contains(got[0].Message, "mocha") {
		t.Errorf("dev dependency findings = %+v", got)
	}
	if r.set.Summary.Gates != 0 {
		t.Errorf("gates = %d", r.set.Summary.Gates)
	}
}

// devDependencyFiles maps the primary path of each dev-dependency-in-production
// Finding to the Finding.
func devDependencyFiles(s *resultset.Set) map[string]resultset.Finding {
	out := map[string]resultset.Finding{}
	for _, f := range ruleFindings(s, "modules.cycles", "dev-dependency-in-production") {
		out[f.Locations[0].Path] = f
	}
	return out
}

func entryPointsUnknown(s *resultset.Set) *resultset.Limitation {
	for i, l := range s.Limitations {
		if l.ReasonCode == "production_entry_points_unknown" && l.CheckID != nil && *l.CheckID == "modules.cycles" {
			return &s.Limitations[i]
		}
	}
	return nil
}

func TestADevScriptMayUseDevDependenciesButCodeTheEntryPointReachesMayNot(t *testing.T) {
	original := copyProject(t, "dev-dependency-scripts")

	r := realRun(t, context.Background(), "test", original, "--only", "modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "modules.cycles"); e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v)", e.Status, e.Reason)
	}
	got := devDependencyFiles(&r.set)
	if _, ok := got["dev/generate.js"]; ok {
		t.Errorf("dev/generate.js runs only from an npm script, yet: %+v", got["dev/generate.js"])
	}
	for _, file := range []string{"src/app.js", "src/lazy.js"} {
		f, ok := got[file]
		if !ok {
			t.Errorf("no finding on %s, which index.js reaches; findings: %+v", file, got)
			continue
		}
		if !strings.Contains(f.Message, "`index.js`") || !strings.Contains(f.Message, "mocha") ||
			f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely || f.Gate {
			t.Errorf("%s: %+v, want a likely warning naming index.js and mocha", file, f)
		}
	}
	if len(got) != 2 {
		t.Errorf("findings on %v, want src/app.js and src/lazy.js", got)
	}
	if l := entryPointsUnknown(&r.set); l != nil {
		t.Errorf("the entry point is known, yet: %+v", l)
	}
	r.assertNothingLeft(t)
}

func TestAFileThatTheEntryPointReachesOnlyThroughASubpathImportIsStillProductionCode(t *testing.T) {
	original := copyProject(t, "dev-dependency-scripts")
	// dependency-cruiser tags such an import "aliased" as well as "local"; the
	// edge must be followed all the same.
	writeUnusedCyclesFile(t, filepath.Join(original, "package.json"),
		`{"name": "dev-dependency-scripts", "version": "1.0.0", "private": true, "main": "index.js", "imports": {"#lib/*": "./src/lib/*.js"}, "scripts": {"generate": "node dev/generate.js"}, "devDependencies": {"mocha": "^10.8.2"}}`+"\n")
	writeUnusedCyclesFile(t, filepath.Join(original, "index.js"),
		"'use strict';\n\nconst { start } = require('./src/app');\nconst { named } = require('#lib/named');\n\nstart();\nnamed();\n")
	writeUnusedCyclesFile(t, filepath.Join(original, "src", "lib", "named.js"),
		"'use strict';\n\nfunction named() {\n  return typeof require('mocha');\n}\n\nmodule.exports = { named };\n")

	r := realRun(t, context.Background(), "test", original, "--only", "modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "modules.cycles"); e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v)", e.Status, e.Reason)
	}
	got := devDependencyFiles(&r.set)
	f, ok := got["src/lib/named.js"]
	if !ok {
		t.Fatalf("no finding on src/lib/named.js, which index.js reaches through #lib/named; findings: %+v", got)
	}
	if !strings.Contains(f.Message, "`index.js`") || !strings.Contains(f.Message, "mocha") {
		t.Errorf("message = %q, want it to name index.js and mocha", f.Message)
	}
	if _, ok := got["dev/generate.js"]; ok {
		t.Errorf("dev/generate.js runs only from an npm script, yet: %+v", got["dev/generate.js"])
	}
}

func TestAJobThatTheHelmChartRunsIsAProductionEntryPoint(t *testing.T) {
	original := copyProject(t, "dev-dependency-scripts")
	// A made-up chart runs the npm script `job` as a CronJob. The job loads a
	// mock that requires the devDependency lazily, behind a switch.
	writeUnusedCyclesFile(t, filepath.Join(original, "package.json"),
		`{"name": "dev-dependency-scripts", "version": "1.0.0", "private": true, "main": "index.js", "scripts": {"generate": "node dev/generate.js", "job": "node src/jobs/job.js"}, "devDependencies": {"mocha": "^10.8.2"}}`+"\n")
	writeUnusedCyclesFile(t, filepath.Join(original, "charts", "dev-dependency-scripts", "Chart.yaml"),
		"apiVersion: v2\nname: dev-dependency-scripts\nversion: 0.1.0\n")
	writeUnusedCyclesFile(t, filepath.Join(original, "charts", "dev-dependency-scripts", "values.yaml"),
		"cronJobs:\n  - name: job\n    schedule: \"*/5 * * * *\"\n    command: [ \"npm\", \"run\", \"job\" ]\n")
	writeUnusedCyclesFile(t, filepath.Join(original, "src", "jobs", "job.js"),
		"'use strict';\n\nconst useMock = require('../../dev/job-mock');\n\nif (process.env.MOCK) {\n  useMock();\n}\n")
	writeUnusedCyclesFile(t, filepath.Join(original, "dev", "job-mock.js"),
		"'use strict';\n\nmodule.exports = function useMock() {\n  const Mocha = require('mocha');\n  return typeof Mocha;\n};\n")

	r := realRun(t, context.Background(), "test", original, "--only", "modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "modules.cycles"); e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v)", e.Status, e.Reason)
	}
	got := devDependencyFiles(&r.set)
	f, ok := got["dev/job-mock.js"]
	if !ok {
		t.Fatalf("no finding on dev/job-mock.js, which the job the chart runs reaches; findings: %+v", got)
	}
	if !strings.Contains(f.Message, "`src/jobs/job.js`") || !strings.Contains(f.Message, "values.yaml") || !strings.Contains(f.Message, "mocha") {
		t.Errorf("message = %q, want it to name src/jobs/job.js, values.yaml and mocha", f.Message)
	}
	if _, ok := got["dev/generate.js"]; ok {
		t.Errorf("dev/generate.js runs only from an npm script that no deployment file names, yet: %+v", got["dev/generate.js"])
	}
	if len(got) != 3 {
		t.Errorf("findings on %v, want src/app.js, src/lazy.js and dev/job-mock.js", got)
	}
	r.assertNothingLeft(t)
}

func TestWithoutAnEntryPointEverySourceFileCountsAsProductionCode(t *testing.T) {
	original := copyProject(t, "dev-dependency-scripts")
	// No main, no index.js, no exports, no bin and no start script.
	if err := os.Rename(filepath.Join(original, "index.js"), filepath.Join(original, "server.js")); err != nil {
		t.Fatal(err)
	}
	writeUnusedCyclesFile(t, filepath.Join(original, "package.json"),
		`{"name": "dev-dependency-scripts", "version": "1.0.0", "private": true, "scripts": {"generate": "node dev/generate.js"}, "devDependencies": {"mocha": "^10.8.2"}}`+"\n")

	r := realRun(t, context.Background(), "test", original, "--only", "modules.cycles")

	if r.code != 0 {
		t.Fatalf("exit = %d\nstderr:\n%s", r.code, r.stderr)
	}
	if e := oneExecution(t, &r.set, "modules.cycles"); e.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%v), want completed: the fallback reports more, not less", e.Status, e.Reason)
	}
	got := devDependencyFiles(&r.set)
	for _, file := range []string{"src/app.js", "src/lazy.js", "dev/generate.js"} {
		if _, ok := got[file]; !ok {
			t.Errorf("no finding on %s; findings: %+v", file, got)
		}
	}
	l := entryPointsUnknown(&r.set)
	if l == nil || !strings.Contains(l.Message, "`main`") {
		t.Fatalf("limitations = %+v, want production_entry_points_unknown naming what was looked for", r.set.Limitations)
	}
	if l.Path == nil || *l.Path != "package.json" {
		t.Errorf("path = %v, want package.json, the package the Limitation is about", l.Path)
	}
}
