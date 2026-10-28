package checks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func qualitySignals(t *testing.T) (*discovery.Project, string) {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", "quality-signals"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	return proj, dir
}

func TestQualityClonesIsImplementedForTheProjectContext(t *testing.T) {
	entry, ok := Lookup("quality.clones")
	if !ok || entry.Status != Implemented || entry.Scope != PerProject {
		t.Fatalf("quality.clones = %+v, want implemented in the project Context", entry)
	}
	if entry.CanFireGates {
		t.Error("clones are notes, never Gates")
	}
}

func TestClonesApplyWhenTheProjectHasSourceOrTestCode(t *testing.T) {
	proj, _ := qualitySignals(t)
	got, reason := Implementation("quality.clones").Applicability(proj, &proj.Contexts[0])
	if got != resultset.Applicable {
		t.Fatalf("applicability = %v (%s)", got, reason)
	}
}

func TestClonesDoNotApplyWithoutJavaScriptOutsideTestDataAndBuildOutput(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"package.json":        `{"name":"x"}`,
		"README.md":           "# x",
		"test/fixtures/a.js":  "const a = 1;\n",
		"dist/bundle.js":      "const b = 2;\n",
		"src/data.json":       "{}",
		"scripts/deploy.sh":   "echo hi\n",
		"docs/example.js.txt": "x",
	} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, reason := Implementation("quality.clones").Applicability(proj, &proj.Contexts[0])
	if got != resultset.NotApplicable || reason == "" {
		t.Fatalf("applicability = %v (%q), want not_applicable with a reason", got, reason)
	}
}

func TestOnlySourceAndTestCodeGoToTheDuplicationScan(t *testing.T) {
	proj, _ := qualitySignals(t)
	source, test := cloneTargets(proj)
	want := map[string]bool{"src/index.js": true, "src/invoice.js": true, "src/order.js": true, "src/shipping.js": true, "src/cycle-a.js": true, "src/cycle-b.js": true}
	if len(source) != len(want) {
		t.Fatalf("source files = %v", source)
	}
	for _, f := range source {
		if !want[f] {
			t.Errorf("unexpected Source code file %s", f)
		}
	}
	sort.Strings(test)
	if len(test) != 2 || test[0] != "test/index.test.js" || test[1] != "test/long-describe.test.js" {
		t.Errorf("Test code files = %v, want only the two test files (fixtures are Test data, dist is Build output)", test)
	}
}

func TestAProjectWithoutTestCodeGivesTheHelperAnEmptyListNotNull(t *testing.T) {
	var in struct {
		Groups []struct {
			Name  string   `json:"name"`
			Files []string `json:"files"`
		} `json:"groups"`
	}
	raw := cloneHelperInput([]string{"src/a.js"}, nil)
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"name":"test","files":[]`) {
		t.Errorf("input = %s, want the empty test group as []", raw)
	}
}

func cloneHelperOutput(sourcePct float64) cloneOutput {
	return cloneOutput{
		Version: "5.4.2",
		Groups: []cloneGroup{
			{Name: "source", Files: 3, Percentage: sourcePct, DuplicatedLines: 10, Lines: 24, Clones: []cloneBlock{{
				First:  clonePlace{Path: "src/order.js", Start: 3, End: 12},
				Second: clonePlace{Path: "src/invoice.js", Start: 3, End: 12},
				Lines:  10, Tokens: 62, Fragment: "function total(items) {...}",
			}}},
			{Name: "test", Files: 1},
		},
	}
}

func TestClonesBecomeNotesAndTheSourceDuplicationIsAMetric(t *testing.T) {
	proj, dir := qualitySignals(t)
	in := &Input{Project: proj, Context: &proj.Contexts[0], OriginalPath: "/original", SnapshotDir: dir}

	res := interpretClones(in, cloneHelperOutput(41.67))

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	if len(res.Findings) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	f := res.Findings[0]
	if f.Gate || f.Severity != resultset.SeverityNote || f.Kind != resultset.KindHint {
		t.Errorf("a clone must be a note and never a Gate: %+v", f)
	}
	if f.RuleID == nil || *f.RuleID != "clone.source" {
		t.Errorf("rule = %v, want clone.source", f.RuleID)
	}
	// The pair is shown in a fixed order, so the Finding is the same in every Run.
	if len(f.Locations) != 2 || f.Locations[0].Path != "src/invoice.js" || f.Locations[0].Role != "primary" ||
		f.Locations[1].Path != "src/order.js" || f.Locations[1].Role != "related" {
		t.Errorf("locations = %+v", f.Locations)
	}
	if f.Locations[0].Start == nil || f.Locations[0].Start.Line != 3 || f.Locations[0].End == nil || f.Locations[0].End.Line != 12 {
		t.Errorf("the primary location should span lines 3 to 12: %+v", f.Locations[0])
	}
	if f.Locations[0].FileSHA256 == "" {
		t.Error("locations carry the SHA-256 of their file")
	}
	if !strings.Contains(f.Message, "src/order.js") || !strings.Contains(f.Message, "10 lines") {
		t.Errorf("message = %q", f.Message)
	}
	if len(f.Evidence) != 1 || f.Evidence[0].Trust != resultset.TrustUntrusted {
		t.Errorf("the duplicated fragment is untrusted evidence: %+v", f.Evidence)
	}

	metrics := map[string]resultset.Metric{}
	for _, m := range res.Metrics {
		metrics[m.Name] = m
	}
	src, ok := metrics["duplication_percent_source"]
	if !ok || src.Value == nil || *src.Value != 41.67 || src.Unit != "percent" {
		t.Errorf("source metric = %+v", src)
	}
	test := metrics["duplication_percent_test"]
	if test.Value == nil || *test.Value != 0 {
		t.Errorf("test metric = %+v, want 0 for one file without clones", test)
	}
	if res.Tool == nil || res.Tool.Name != "jscpd" || res.Tool.Version == nil || *res.Tool.Version != "5.4.2" {
		t.Errorf("tool = %+v", res.Tool)
	}
	if len(res.ContextTools) != 1 || res.ContextTools[0].Name != "jscpd" || res.ContextTools[0].Version != "5.4.2" || res.ContextTools[0].Digest == nil {
		t.Errorf("context tools = %+v", res.ContextTools)
	}
}

// The title does not name the File class: the rule ID tells the groups apart,
// and the central in_test_code rule gives report.md its "in Test code" hint.
func TestACloneTitleSaysDuplicatedCodeWithoutTheFileClass(t *testing.T) {
	proj, dir := qualitySignals(t)
	in := &Input{Project: proj, Context: &proj.Contexts[0], OriginalPath: "/original", SnapshotDir: dir}
	out := cloneHelperOutput(41.67)
	out.Groups[1] = cloneGroup{Name: "test", Files: 2, Percentage: 50, Clones: []cloneBlock{{
		First:  clonePlace{Path: "test/index.test.js", Start: 1, End: 8},
		Second: clonePlace{Path: "test/long-describe.test.js", Start: 1, End: 8},
		Lines:  8, Tokens: 40, Fragment: "describe('x', () => {...})",
	}}}

	res := interpretClones(in, out)

	rules := map[string]string{}
	for _, f := range res.Findings {
		if f.RuleID != nil {
			rules[*f.RuleID] = f.Title
		}
	}
	for _, rule := range []string{"clone.source", "clone.test"} {
		if got, ok := rules[rule]; !ok || got != "Duplicated code" {
			t.Errorf("title of %s = %q (present %v), want \"Duplicated code\"", rule, got, ok)
		}
	}
}

func TestAGroupWithoutFilesHasNoPercentageInsteadOfAFalseZero(t *testing.T) {
	proj, dir := qualitySignals(t)
	in := &Input{Project: proj, Context: &proj.Contexts[0], OriginalPath: "/original", SnapshotDir: dir}
	out := cloneOutput{Version: "5.4.2", Groups: []cloneGroup{{Name: "source"}, {Name: "test", Files: 2}}}

	res := interpretClones(in, out)

	for _, m := range res.Metrics {
		if m.Name == "duplication_percent_source" && (m.Value != nil || m.Reason == nil || *m.Reason == "") {
			t.Errorf("a project without Source code has no source percentage, with a reason: %+v", m)
		}
	}
}

func TestAFailedScanOfOneGroupIsPartialAndKeepsTheOther(t *testing.T) {
	proj, dir := qualitySignals(t)
	in := &Input{Project: proj, Context: &proj.Contexts[0], OriginalPath: "/original", SnapshotDir: dir}
	out := cloneHelperOutput(41.67)
	out.Groups[1].Error = "Error: boom"

	res := interpretClones(in, out)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "check_could_not_run_on_some_files" || !strings.Contains(res.Reason, "boom") {
		t.Errorf("status = %s, %s, %q", res.Status, res.ReasonCode, res.Reason)
	}
	if len(res.Findings) != 1 {
		t.Errorf("the source group's Finding must survive: %+v", res.Findings)
	}
	for _, m := range res.Metrics {
		if m.Name == "duplication_percent_test" && m.Value != nil {
			t.Errorf("the failed group has no value: %+v", m)
		}
	}
}
