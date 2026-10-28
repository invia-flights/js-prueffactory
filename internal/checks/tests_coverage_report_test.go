package checks

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// What c8's JSON summary and per-file JSON become: three percentages per
// package as metrics, and every file as an artifact. A value that cannot be
// measured is null with a reason.

const summaryTwoFiles = `{"total": {"lines":{"total":13,"covered":8,"skipped":0,"pct":61.53},"statements":{"total":13,"covered":8,"skipped":0,"pct":61.53},"functions":{"total":3,"covered":1,"skipped":0,"pct":33.33},"branches":{"total":3,"covered":2,"skipped":0,"pct":66.66},"branchesTrue":{"total":0,"covered":0,"skipped":0,"pct":"Unknown"}}
,"/work/pkg/src/index.js": {"lines":{"total":11,"covered":8,"skipped":0,"pct":72.72},"functions":{"total":2,"covered":1,"skipped":0,"pct":50},"statements":{"total":11,"covered":8,"skipped":0,"pct":72.72},"branches":{"total":2,"covered":2,"skipped":0,"pct":100}}
,"/work/pkg/src/unloaded.js": {"lines":{"total":2,"covered":0,"skipped":0,"pct":0},"functions":{"total":1,"covered":0,"skipped":0,"pct":0},"statements":{"total":2,"covered":0,"skipped":0,"pct":0},"branches":{"total":1,"covered":0,"skipped":0,"pct":0}}
}`

const finalTwoFiles = `{"/work/pkg/src/index.js":{"path":"/work/pkg/src/index.js","fnMap":{"0":{"name":"add","decl":{"start":{"line":3,"column":9},"end":{"line":3,"column":12}},"loc":{"start":{"line":3,"column":0},"end":{"line":5,"column":1}}},"1":{"name":"subtract","decl":{"start":{"line":7,"column":9},"end":{"line":7,"column":17}},"loc":{"start":{"line":7,"column":0},"end":{"line":9,"column":1}}}},"f":{"0":1,"1":0}},
"/work/pkg/src/unloaded.js":{"path":"/work/pkg/src/unloaded.js","fnMap":{"0":{"name":"(anonymous_0)","decl":{"start":{"line":2,"column":10},"end":{"line":2,"column":20}},"loc":{"start":{"line":2,"column":10},"end":{"line":2,"column":40}}}},"f":{"0":0}}}`

func metricsByName(ms []resultset.Metric) map[string]resultset.Metric {
	out := map[string]resultset.Metric{}
	for _, m := range ms {
		out[m.Name] = m
	}
	return out
}

func TestCoverageSummaryBecomesLineBranchAndFunctionPercentagesOfThePackage(t *testing.T) {
	cov := interpretCoverage([]byte(summaryTwoFiles), []byte(finalTwoFiles), "/work/pkg", "pkg")

	if cov.Err != "" {
		t.Fatal(cov.Err)
	}
	ms := metricsByName(cov.Metrics)
	for name, want := range map[string]float64{"lines": 61.54, "branches": 66.67, "functions": 33.33} {
		m, ok := ms[name]
		if !ok || m.Value == nil || m.Unit != "percent" || math.Abs(*m.Value-want) > 0.001 {
			t.Errorf("%s = %+v, want %v percent", name, m, want)
		}
		if m.Reason != nil {
			t.Errorf("%s carries a reason without a failing suite: %q", name, *m.Reason)
		}
	}
	if len(cov.Metrics) != 3 {
		t.Errorf("metrics = %+v, want lines, branches and functions", cov.Metrics)
	}
}

func TestCoverageOfAPackageWithoutBranchesIsNullWithAReasonAndNotAnInventedHundredPercent(t *testing.T) {
	summary := `{"total": {"lines":{"total":2,"covered":2,"skipped":0,"pct":100},"statements":{"total":2,"covered":2,"skipped":0,"pct":100},"functions":{"total":1,"covered":1,"skipped":0,"pct":100},"branches":{"total":0,"covered":0,"skipped":0,"pct":"Unknown"}}
,"/work/src/a.js": {"lines":{"total":2,"covered":2,"skipped":0,"pct":100},"functions":{"total":1,"covered":1,"skipped":0,"pct":100},"statements":{"total":2,"covered":2,"skipped":0,"pct":100},"branches":{"total":0,"covered":0,"skipped":0,"pct":"Unknown"}}}`

	cov := interpretCoverage([]byte(summary), nil, "/work", ".")

	ms := metricsByName(cov.Metrics)
	if b := ms["branches"]; b.Value != nil || b.Reason == nil || !strings.Contains(*b.Reason, "no branches") {
		t.Errorf("branches = %+v, want null with a reason", b)
	}
	if l := ms["lines"]; l.Value == nil || *l.Value != 100 {
		t.Errorf("lines = %+v", l)
	}
	var doc struct {
		Files []struct {
			Branches struct {
				Percent *float64 `json:"percent"`
			} `json:"branches"`
		} `json:"files"`
	}
	if err := json.Unmarshal(cov.FilesDocument, &doc); err != nil || len(doc.Files) != 1 || doc.Files[0].Branches.Percent != nil {
		t.Errorf("per-file branch percent should be null: %v %s", err, cov.FilesDocument)
	}
}

func TestCoverageOfAPackageWithoutAnyMeasuredFileIsNullWithAReason(t *testing.T) {
	summary := `{"total": {"lines":{"total":0,"covered":0,"skipped":0,"pct":100},"statements":{"total":0,"covered":0,"skipped":0,"pct":100},"functions":{"total":0,"covered":0,"skipped":0,"pct":100},"branches":{"total":0,"covered":0,"skipped":0,"pct":100}}}`

	cov := interpretCoverage([]byte(summary), nil, "/work", ".")

	for _, m := range cov.Metrics {
		if m.Value != nil || m.Reason == nil || *m.Reason == "" {
			t.Errorf("%s = %+v, want null with a reason (c8 reports 100 for nothing)", m.Name, m)
		}
	}
	if len(cov.Metrics) != 3 {
		t.Errorf("metrics = %+v", cov.Metrics)
	}
}

func TestCoverageOutputThatIsNotReadableIsAnErrorAndNeverANumber(t *testing.T) {
	for name, summary := range map[string]string{"empty": "", "not JSON": "{", "no total": `{"/work/a.js":{}}`} {
		cov := interpretCoverage([]byte(summary), nil, "/work", ".")
		if cov.Err == "" || len(cov.Metrics) != 0 {
			t.Errorf("%s: err %q, metrics %+v", name, cov.Err, cov.Metrics)
		}
	}
}

func TestEveryFileIsInTheArtifactWithProjectRelativePathsAndItsUntestedFunctions(t *testing.T) {
	cov := interpretCoverage([]byte(summaryTwoFiles), []byte(finalTwoFiles), "/work/pkg", "pkg")

	var doc struct {
		Package string `json:"package"`
		Total   struct {
			Lines struct {
				Total, Covered int
				Percent        float64
			} `json:"lines"`
		} `json:"total"`
		Files []struct {
			Path  string `json:"path"`
			Lines struct {
				Total   int      `json:"total"`
				Covered int      `json:"covered"`
				Percent *float64 `json:"percent"`
			} `json:"lines"`
			Functions struct {
				Percent *float64 `json:"percent"`
			} `json:"functions"`
			Untested []struct {
				Name string `json:"name"`
				Line int    `json:"line"`
			} `json:"untested_functions"`
		} `json:"files"`
	}
	if err := json.Unmarshal(cov.FilesDocument, &doc); err != nil {
		t.Fatalf("%v\n%s", err, cov.FilesDocument)
	}
	if strings.Contains(string(cov.FilesDocument), "/work") {
		t.Errorf("a container path leaks into the artifact: %s", cov.FilesDocument)
	}
	if doc.Package != "pkg" || len(doc.Files) != 2 {
		t.Fatalf("doc = %+v", doc)
	}
	a, b := doc.Files[0], doc.Files[1]
	if a.Path != "pkg/src/index.js" || b.Path != "pkg/src/unloaded.js" {
		t.Errorf("paths = %q, %q, want project-relative and sorted", a.Path, b.Path)
	}
	if a.Lines.Total != 11 || a.Lines.Covered != 8 || a.Lines.Percent == nil || *a.Lines.Percent != 72.73 {
		t.Errorf("index.js lines = %+v", a.Lines)
	}
	if len(a.Untested) != 1 || a.Untested[0].Name != "subtract" || a.Untested[0].Line != 7 {
		t.Errorf("index.js untested functions = %+v", a.Untested)
	}
	if len(b.Untested) != 1 || b.Untested[0].Name != "(anonymous_0)" || b.Untested[0].Line != 2 {
		t.Errorf("unloaded.js untested functions = %+v", b.Untested)
	}
}

func TestAFailingSuiteMakesEveryMetricCarryANote(t *testing.T) {
	cov := interpretCoverage([]byte(summaryTwoFiles), nil, "/work/pkg", "pkg")

	cov.NoteFailures("2 tests failed")

	for _, m := range cov.Metrics {
		if m.Value == nil || m.Reason == nil || !strings.Contains(*m.Reason, "2 tests failed") {
			t.Errorf("%s = %+v, want the value and the note", m.Name, m)
		}
	}
}
