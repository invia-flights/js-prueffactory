package checks

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Seam: what lint.correctness makes of the combined run's output. The run
// itself needs Docker and is covered by the docker-tagged test in internal/cli.

func problemRun() *eslintRun {
	return &eslintRun{
		Output: eslintOutput{
			Version: "10.13.0",
			Groups:  map[string][]string{"lint.correctness": {"no-self-assign", "no-undef"}, "tests.smells": {"mocha/no-exclusive-tests"}},
			Config:  map[string]any{"eslint": "10.13.0", "groups": map[string]any{"lint.correctness": []string{"no-self-assign", "no-undef"}}},
			Results: []eslintFileResult{
				{Path: "src/index.js", Messages: []eslintMessage{
					{RuleID: "no-self-assign", Message: "'state.count' is assigned to itself.", Line: 5, Column: 3, EndLine: 5, EndColumn: 28},
				}},
				{Path: "src/silenced.js", Messages: []eslintMessage{
					{RuleID: "no-self-assign", Message: "'state.count' is assigned to itself.", Line: 7, Column: 3},
					{RuleID: "mocha/no-exclusive-tests", Message: "Unexpected exclusive mocha test.", Line: 9, Column: 1},
				}},
			},
		},
		ConfigSHA256: "abc123",
	}
}

func TestEveryHitOfAProblemRuleBecomesAWarningWithTheNativeRuleID(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}

	res := interpretLintCorrectness(in, problemRun())

	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status = %s (%s)", res.Status, res.Reason)
	}
	if len(res.Findings) != 2 {
		t.Fatalf("findings = %d, want the two hits of no-self-assign and none for another group's rule: %+v", len(res.Findings), res.Findings)
	}
	for _, f := range res.Findings {
		if f.Gate || f.Severity != resultset.SeverityWarning || f.Confidence != resultset.ConfidenceLikely {
			t.Errorf("finding = %+v, want a warning with confidence likely and no Gate", f)
		}
		if f.RuleID == nil || *f.RuleID != "no-self-assign" {
			t.Errorf("rule = %v, want the native ESLint rule ID", f.RuleID)
		}
		if f.CheckID != "lint.correctness" || f.ContextID != in.Context.ID {
			t.Errorf("check/context = %s/%s", f.CheckID, f.ContextID)
		}
		if len(f.Locations) != 1 || f.Locations[0].FileSHA256 == "" || f.Locations[0].Start == nil {
			t.Errorf("locations = %+v", f.Locations)
		}
	}
	paths := []string{res.Findings[0].Locations[0].Path, res.Findings[1].Locations[0].Path}
	if paths[0] != "src/index.js" || paths[1] != "src/silenced.js" {
		t.Errorf("paths = %v: the hit under the disable comment counts as well", paths)
	}
	if res.Findings[0].Fingerprint.Value == res.Findings[1].Fingerprint.Value {
		t.Error("the same message in two files must have two fingerprints")
	}
}

func TestPathsOfANestedPackageAreRelativeToTheProject(t *testing.T) {
	proj, dir := writeTree(t, map[string]string{
		"package.json":                `{"name":"root"}`,
		"packages/inner/package.json": `{"name":"inner"}`,
		"packages/inner/src/in.js":    "x = x;\n",
	})
	in := &Input{Project: proj, Context: packageContext(t, proj, "packages/inner"), SnapshotDir: dir}
	run := &eslintRun{Output: eslintOutput{
		Groups:  map[string][]string{"lint.correctness": {"no-self-assign"}},
		Results: []eslintFileResult{{Path: "src/in.js", Messages: []eslintMessage{{RuleID: "no-self-assign", Message: "x", Line: 1, Column: 1}}}},
	}}

	res := interpretLintCorrectness(in, run)

	if len(res.Findings) != 1 || res.Findings[0].Locations[0].Path != "packages/inner/src/in.js" {
		t.Fatalf("findings = %+v", res.Findings)
	}
	if res.Findings[0].Locations[0].FileSHA256 == "" {
		t.Error("the file hash must be found at the project path")
	}
}

func TestTheRuleListAndTheConfigHashAreRecorded(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}

	res := interpretLintCorrectness(in, problemRun())

	if len(res.Artifacts) != 1 {
		t.Fatalf("artifacts = %d, want the rule list", len(res.Artifacts))
	}
	a := res.Artifacts[0]
	if a.MediaType != "application/json" || !strings.HasPrefix(a.Path, "artifacts/lint.correctness/") || !strings.Contains(a.Path, in.Context.ID) {
		t.Errorf("artifact = %+v", a)
	}
	var doc struct {
		Check        string   `json:"check"`
		ESLint       string   `json:"eslint_version"`
		Rules        []string `json:"rules"`
		Excluded     []string `json:"excluded_rules"`
		ConfigSHA256 string   `json:"config_sha256"`
	}
	if err := json.Unmarshal(a.Content, &doc); err != nil {
		t.Fatalf("artifact content is not JSON: %v", err)
	}
	if doc.Check != "lint.correctness" || doc.ESLint != "10.13.0" || doc.ConfigSHA256 != "abc123" {
		t.Errorf("doc = %+v", doc)
	}
	if strings.Join(doc.Rules, ",") != "no-self-assign,no-undef" {
		t.Errorf("rules = %v, want this Check's rules and not those of other groups", doc.Rules)
	}
	if strings.Join(doc.Excluded, ",") != "no-await-in-loop,no-use-before-define" {
		t.Errorf("excluded = %v, want the exclusion list", doc.Excluded)
	}

	var tools []string
	for _, tool := range res.ContextTools {
		tools = append(tools, tool.Name+"@"+tool.Version)
		if tool.Name == "eslint-config" && (tool.Digest == nil || *tool.Digest != "abc123") {
			t.Errorf("the config tool entry must carry the hash as its digest: %+v", tool)
		}
	}
	if len(tools) != 2 || tools[0] != "eslint@10.13.0" || !strings.HasPrefix(tools[1], "eslint-config@") {
		t.Errorf("context tools = %v, want eslint and the generated config", tools)
	}
	if res.Tool == nil || res.Tool.Name != "eslint" || res.Tool.Version == nil || *res.Tool.Version != "10.13.0" {
		t.Errorf("tool = %+v", res.Tool)
	}
}

func limitationText(res *Result) string {
	var text []string
	for _, l := range res.Limitations {
		text = append(text, l.Message)
	}
	return strings.Join(text, "\n")
}

func TestAFileESLintCannotParseIsNamedInALimitationIsNotAFindingAndMakesTheCheckPartial(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}
	run := problemRun()
	run.Output.Results = append(run.Output.Results, eslintFileResult{Path: "src/esm.mjs", Messages: []eslintMessage{
		{Fatal: true, Message: "Parsing error: Unexpected token", Line: 1, Column: 1},
	}})

	res := interpretLintCorrectness(in, run)

	// 0 hits in a file that was never read is not a measurement: the Check is
	// partial, so the Benchmark treats it as unknown.
	if res.Status != resultset.StatusPartial || res.ReasonCode != "files_not_parsed" {
		t.Errorf("status = %s, %s (%s), want partial with files_not_parsed", res.Status, res.ReasonCode, res.Reason)
	}
	if !strings.Contains(res.Reason, "1 file") {
		t.Errorf("reason = %q, want the count of files not parsed", res.Reason)
	}
	if len(res.Findings) != 2 {
		t.Errorf("a parse error is syntax.parse's business, not a lint Finding, and the hits of the other files stay: %d findings", len(res.Findings))
	}
	if !strings.Contains(limitationText(res), "src/esm.mjs") {
		t.Errorf("limitations = %q, want the file named", limitationText(res))
	}
}

func TestAFileOverTheSizeCapIsNamedInALimitationAndMakesTheCheckPartial(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}
	run := problemRun()
	run.Oversized = []string{"src/big.js"}

	res := interpretLintCorrectness(in, run)

	if res.Status != resultset.StatusPartial || res.ReasonCode != "check_could_not_run_on_some_files" {
		t.Errorf("status = %s, %s", res.Status, res.ReasonCode)
	}
	if !strings.Contains(limitationText(res), "src/big.js") {
		t.Errorf("limitations = %q, want the file named", limitationText(res))
	}
}

func TestTooManyHitsAreCutAndTheCutIsReported(t *testing.T) {
	proj, dir := eslintProblems(t)
	in := &Input{Project: proj, Context: packageContext(t, proj, "."), OriginalPath: "/original", SnapshotDir: dir}
	var msgs []eslintMessage
	for i := 1; i <= eslintMaxFindings+5; i++ {
		msgs = append(msgs, eslintMessage{RuleID: "no-self-assign", Message: fmt.Sprintf("hit %d", i), Line: i, Column: 1})
	}
	run := &eslintRun{Output: eslintOutput{
		Groups:  map[string][]string{"lint.correctness": {"no-self-assign"}},
		Results: []eslintFileResult{{Path: "src/index.js", Messages: msgs}},
	}}

	res := interpretLintCorrectness(in, run)

	if len(res.Findings) != eslintMaxFindings {
		t.Errorf("findings = %d, want the cap of %d", len(res.Findings), eslintMaxFindings)
	}
	if res.Status != resultset.StatusPartial || len(res.Limitations) == 0 || !strings.Contains(res.Limitations[0].Message, "5 more") {
		t.Errorf("status = %s, limitations = %+v, want the cut named", res.Status, res.Limitations)
	}
}
