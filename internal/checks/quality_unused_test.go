package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func qualitySignalsPackageContext(t *testing.T) (*discovery.Project, *discovery.Context, string) {
	t.Helper()
	proj, dir := qualitySignals(t)
	for i := range proj.Contexts {
		if proj.Contexts[i].Package != nil {
			return proj, &proj.Contexts[i], dir
		}
	}
	t.Fatal("quality-signals has no package Context")
	return nil, nil, ""
}

func TestUnusedAndCyclesAreImplementedPerPackageWithoutGates(t *testing.T) {
	for _, id := range []string{"quality.unused", "modules.cycles"} {
		entry, ok := Lookup(id)
		if !ok || entry.Status != Implemented || entry.Scope != PerPackage {
			t.Errorf("%s = %+v, want implemented per package", id, entry)
		}
		if entry.CanFireGates {
			t.Errorf("%s must not fire Gates", id)
		}
	}
}

func TestUnusedAndCyclesWaitForTheInstallAndUseTheWorkingCopyAndTheToolset(t *testing.T) {
	_, c, _ := qualitySignalsPackageContext(t)
	for _, id := range []string{"quality.unused", "modules.cycles"} {
		impl := Implementation(id)
		pre, ok := impl.(PrerequisiteUser)
		if !ok || len(pre.Prerequisites(c)) != 1 || pre.Prerequisites(c)[0] != "package.install" {
			t.Errorf("%s must list package.install as its prerequisite", id)
		}
		if w, ok := impl.(WorkingCopyUser); !ok || !w.UsesWorkingCopy() {
			t.Errorf("%s needs the Working copy", id)
		}
		if ts, ok := impl.(ToolsetUser); !ok || !ts.UsesToolset(c) {
			t.Errorf("%s runs a tool from the toolset volume", id)
		}
		if iu, ok := impl.(ImageUser); !ok || len(iu.Images(c)) != 1 {
			t.Errorf("%s must name the image it runs in", id)
		}
	}
}

func TestUnusedAndCyclesExamineTheInstalledPackageNotTheProjectContext(t *testing.T) {
	proj, c, _ := qualitySignalsPackageContext(t)
	for _, id := range []string{"quality.unused", "modules.cycles"} {
		impl := Implementation(id)
		if got, _ := impl.Applicability(proj, c); got != resultset.Applicable {
			t.Errorf("%s in the package Context = %v, want applicable", id, got)
		}
		if got, reason := impl.Applicability(proj, &proj.Contexts[0]); got != resultset.NotApplicable || reason == "" {
			t.Errorf("%s in the project Context = %v (%q), want not_applicable with a reason", id, got, reason)
		}
	}
}

// Recorded from Knip 6.43.0 (`knip --reporter json --no-exit-code`) on the
// quality-signals project and on a project with an undeclared and an
// unresolvable import.
const knipOutput = `{"issues":[
 {"file":"dist/bundle.js","dependencies":[],"devDependencies":[],"optionalPeerDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"enumMembers":[],"namespaceMembers":[],"duplicates":[],"files":[{"name":"dist/bundle.js"}]},
 {"file":"test/fixtures/copy.js","dependencies":[],"devDependencies":[],"optionalPeerDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[],"types":[],"enumMembers":[],"namespaceMembers":[],"duplicates":[],"files":[{"name":"test/fixtures/copy.js"}]},
 {"file":"package.json","dependencies":[{"name":"left-pad"}],"devDependencies":[{"name":"mocha"}],"optionalPeerDependencies":[],"unlisted":[],"binaries":[{"name":"mocha"}],"unresolved":[],"exports":[],"types":[],"enumMembers":[],"namespaceMembers":[],"duplicates":[],"files":[]},
 {"file":"src/cycle-a.js","dependencies":[],"devDependencies":[],"optionalPeerDependencies":[],"unlisted":[],"binaries":[],"unresolved":[],"exports":[{"name":"unusedExport","line":13,"col":27,"pos":211}],"types":[],"enumMembers":[],"namespaceMembers":[],"duplicates":[],"files":[]},
 {"file":"src/index.js","dependencies":[],"devDependencies":[],"optionalPeerDependencies":[],"unlisted":[{"name":"nope-pkg","line":3,"col":22,"pos":36}],"binaries":[],"unresolved":[{"name":"./missing","line":4,"col":25,"pos":73}],"exports":[],"types":[],"enumMembers":[],"namespaceMembers":[],"duplicates":[],"files":[]}
]}`

func knipFindings(t *testing.T) (*Result, *Input) {
	t.Helper()
	proj, c, dir := qualitySignalsPackageContext(t)
	in := &Input{Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir}
	res := interpretKnip(in, []byte(knipOutput))
	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	return res, in
}

func findingsByRule(res *Result) map[string][]resultset.Finding {
	out := map[string][]resultset.Finding{}
	for _, f := range res.Findings {
		out[*f.RuleID] = append(out[*f.RuleID], f)
	}
	return out
}

func TestUnlistedAndUnresolvedImportsAreWarnings(t *testing.T) {
	res, _ := knipFindings(t)
	by := findingsByRule(res)

	for rule, want := range map[string]string{"unlisted-dependency": "nope-pkg", "unresolved-import": "./missing"} {
		got := by[rule]
		if len(got) != 1 {
			t.Fatalf("%s findings = %+v", rule, got)
		}
		f := got[0]
		if f.Severity != resultset.SeverityWarning || f.Gate {
			t.Errorf("%s must be a warning without a Gate: %+v", rule, f)
		}
		if !strings.Contains(f.Message, want) {
			t.Errorf("%s message = %q, want it to name %q", rule, f.Message, want)
		}
		if len(f.Locations) != 1 || f.Locations[0].Path != "src/index.js" || f.Locations[0].Start == nil {
			t.Errorf("%s locations = %+v, want a place in src/index.js", rule, f.Locations)
		}
	}
}

func TestUnusedFilesExportsAndDependenciesAreNotes(t *testing.T) {
	res, _ := knipFindings(t)
	by := findingsByRule(res)

	for rule, want := range map[string]string{
		"unused-export":         "unusedExport",
		"unused-dependency":     "left-pad",
		"unused-dev-dependency": "mocha",
	} {
		got := by[rule]
		if len(got) != 1 {
			t.Fatalf("%s findings = %+v", rule, got)
		}
		if got[0].Severity != resultset.SeverityNote || got[0].Gate || !strings.Contains(got[0].Message, want) {
			t.Errorf("%s = %+v, want a note without a Gate naming %q", rule, got[0], want)
		}
	}
	if len(res.Findings) == 0 {
		t.Fatal("no findings")
	}
	for _, f := range res.Findings {
		if f.Gate {
			t.Errorf("quality.unused never fires a Gate: %+v", f)
		}
		if f.Severity != resultset.SeverityNote && f.Severity != resultset.SeverityWarning {
			t.Errorf("severity = %s", f.Severity)
		}
	}
}

func TestUnusedFilesInBuildOutputAndTestDataAreNotReported(t *testing.T) {
	res, _ := knipFindings(t)
	for _, f := range res.Findings {
		for _, l := range f.Locations {
			if strings.HasPrefix(l.Path, "dist/") || strings.HasPrefix(l.Path, "test/fixtures/") {
				t.Errorf("%s is Build output or Test data, not code the project means to use: %+v", l.Path, f)
			}
		}
	}
}

func TestKnipFindingsAreOnlyDependencyDeclarationsInThePackageManifest(t *testing.T) {
	res, _ := knipFindings(t)
	for _, f := range findingsByRule(res)["unused-dependency"] {
		if f.Locations[0].Path != "package.json" {
			t.Errorf("a dependency finding points at the manifest: %+v", f.Locations)
		}
	}
}

func TestKnipRecordsItsPinnedVersionAndContextTool(t *testing.T) {
	res, _ := knipFindings(t)
	if res.Tool == nil || res.Tool.Name != "knip" || res.Tool.Version == nil || *res.Tool.Version != "6.43.0" {
		t.Errorf("tool = %+v", res.Tool)
	}
	if len(res.ContextTools) != 1 || res.ContextTools[0].Name != "knip" || res.ContextTools[0].Digest == nil {
		t.Errorf("context tools = %+v", res.ContextTools)
	}
}

func TestKnipFindingsAreStableAcrossRuns(t *testing.T) {
	a, _ := knipFindings(t)
	b, _ := knipFindings(t)
	if len(a.Findings) != len(b.Findings) {
		t.Fatal("finding counts differ")
	}
	for i := range a.Findings {
		if a.Findings[i].Fingerprint != b.Findings[i].Fingerprint {
			t.Errorf("fingerprint %d differs", i)
		}
	}
}

func TestKnipOutputThatIsNotJSONIsAToolError(t *testing.T) {
	proj, c, dir := qualitySignalsPackageContext(t)
	in := &Input{Project: proj, Context: c, OriginalPath: "/original", SnapshotDir: dir}
	res := interpretKnip(in, []byte("Error: Cannot find module 'jiti'"))
	if res.Status != resultset.StatusToolError || res.ReasonCode != "knip_output_unreadable" {
		t.Errorf("status = %s, %s", res.Status, res.ReasonCode)
	}
}
