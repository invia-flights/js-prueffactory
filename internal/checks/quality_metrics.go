package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"path"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

func init() {
	Register(qualityMetricsID, qualityMetrics{})
	// A maximum of 0 makes each rule report every function, with the function's
	// value in the message; the helper reads the values (see Measure).
	registerESLintGroup(eslintGroup{
		checkID: qualityMetricsID, plugins: []string{"sonarjs"}, sourceOnly: true,
		rules: []eslintRuleSpec{
			{Name: "complexity", Options: []any{0}, Measure: measureCyclomatic},
			{Name: "max-lines-per-function", Options: []any{map[string]any{"max": 0}}, Measure: measureLength},
			{Name: "sonarjs/cognitive-complexity", Options: []any{0}, Measure: measureCognitive},
		},
	})
}

const qualityMetricsID = "quality.metrics"

// The measures of the Check.
const (
	measureCyclomatic = "cyclomatic"
	measureCognitive  = "cognitive"
	measureLength     = "length"
)

// measureKinds lists the measures with the default threshold of their rule and
// the unit of their values. Functions above the threshold are counted.
var measureKinds = []struct {
	kind      string
	threshold int
	unit      string
}{
	{measureCyclomatic, 20, "complexity"},
	{measureCognitive, 15, "complexity"},
	{measureLength, 50, "lines"},
}

// qualityMetrics measures the complexity and length of every function in Source
// code (never Test code, where describe callbacks would count as long functions) with the
// combined ESLint run's measuring rules. It records per-function values in an
// artifact and their percentiles, maximum and the counts above each rule's
// default threshold as Metrics. It is a measurement and has no Findings.
type qualityMetrics struct{}

func (qualityMetrics) Applicability(_ *discovery.Project, c *discovery.Context) (resultset.Applicability, string) {
	return eslintSourceApplicability(c)
}

func (qualityMetrics) Images(c *discovery.Context) []string { return eslintImages(c) }

func (qualityMetrics) UsesToolset(c *discovery.Context) bool { return len(eslintImages(c)) > 0 }

func (qualityMetrics) Run(ctx context.Context, in *Input) *Result {
	run, failed := in.eslintRun(ctx)
	if failed != nil {
		return failed
	}
	return interpretQualityMetrics(in, run)
}

// functionValues is what is known about one function.
type functionValues struct {
	Path       string `json:"path"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	Name       string `json:"name"`
	Cyclomatic int    `json:"cyclomatic"`
	Cognitive  int    `json:"cognitive"`
	Length     int    `json:"length"`
}

func interpretQualityMetrics(in *Input, run *eslintRun) *Result {
	res, _ := eslintHitsResult(in, run, qualityMetricsID, func(string) string { return "warning" })
	// The measuring rules' hits are not Findings.
	res.Findings = nil

	pkgPath := in.Context.Package.Path
	values := map[string][]int{}
	var functions []functionValues
	index := map[string]int{}
	var cognitive []eslintMeasure
	for _, m := range run.Output.Measures {
		switch m.Kind {
		case measureCognitive:
			cognitive = append(cognitive, m)
			values[m.Kind] = append(values[m.Kind], m.Value)
			continue
		case measureCyclomatic, measureLength:
			values[m.Kind] = append(values[m.Kind], m.Value)
		default:
			continue
		}
		// Cyclomatic complexity and length are reported at the start of the
		// function, so those two make a function's identity.
		key := fmt.Sprintf("%s:%d:%d", m.Path, m.Line, m.Column)
		i, ok := index[key]
		if !ok {
			i = len(functions)
			index[key] = i
			functions = append(functions, functionValues{Path: path.Join(pkgPath, m.Path), Line: m.Line, Column: m.Column, Name: m.Name})
		}
		if m.Kind == measureCyclomatic {
			functions[i].Cyclomatic = m.Value
			functions[i].Name = m.Name
		} else {
			functions[i].Length = m.Value
		}
	}
	// The cognitive rule reports at the function's name, which can be after the
	// start. It belongs to the last function that starts at or before it on the
	// same line, or stands alone.
	for _, m := range cognitive {
		best := -1
		for i := range functions {
			f := functions[i]
			if f.Path == path.Join(pkgPath, m.Path) && f.Line == m.Line && f.Column <= m.Column && (best < 0 || f.Column > functions[best].Column) {
				best = i
			}
		}
		if best >= 0 && functions[best].Cognitive == 0 {
			functions[best].Cognitive = m.Value
			continue
		}
		functions = append(functions, functionValues{Path: path.Join(pkgPath, m.Path), Line: m.Line, Column: m.Column, Cognitive: m.Value})
	}
	sort.SliceStable(functions, func(i, j int) bool {
		a, b := functions[i], functions[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Column < b.Column
	})

	// Every function has a cyclomatic complexity of at least 1, so the cyclomatic
	// rule reports all of them. The cognitive rule leaves out functions at 0.
	count := len(values[measureCyclomatic])
	for len(values[measureCognitive]) < count {
		values[measureCognitive] = append(values[measureCognitive], 0)
	}

	why := noFunctionsReason
	if len(run.unparsed(pkgPath)) > 0 {
		why = noFunctionsUnparsedReason
	}
	res.Metrics = append(res.Metrics, countMetric("functions", count, "functions", count > 0, why))
	for _, k := range measureKinds {
		res.Metrics = append(res.Metrics, measureMetrics(k.kind, k.threshold, k.unit, values[k.kind], count > 0, why)...)
	}

	checkID := qualityMetricsID
	var left []string
	if run.Output.MeasuresDropped > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "measures_cut", CheckID: &checkID,
			Message: fmt.Sprintf("%d measures were left out because the package has too many functions, so the values cover only part of them.", run.Output.MeasuresDropped),
		})
		left = append(left, "functions")
	}
	if run.Output.MeasuresUnreadable > 0 {
		res.Limitations = append(res.Limitations, resultset.Limitation{
			ReasonCode: "measures_unreadable", CheckID: &checkID,
			Message: fmt.Sprintf("%d messages of the measuring rules held no number and were left out.", run.Output.MeasuresUnreadable),
		})
		left = append(left, "functions")
	}
	if len(left) > 0 && res.Status == resultset.StatusCompleted {
		res.Status = resultset.StatusPartial
		res.ReasonCode = "check_could_not_run_on_some_files"
		res.Reason = "some functions are missing from this Check; see the Limitations"
	}

	if doc, err := metricsDocument(in, run, functions); err == nil {
		res.Artifacts = append(res.Artifacts, resultset.Artifact{
			ID:   "functions-" + in.Context.ID,
			Path: "artifacts/" + qualityMetricsID + "/" + in.Context.ID + "-functions.json", MediaType: "application/json",
			Content: doc,
		})
	}
	return res
}

func countMetric(name string, n int, unit string, ok bool, why string) resultset.Metric {
	m := resultset.Metric{Name: name, Unit: unit}
	if !ok {
		reason := why
		m.Reason = &reason
		return m
	}
	v := float64(n)
	m.Value = &v
	return m
}

const noFunctionsReason = "the package has no functions in Source code"

// noFunctionsUnparsedReason is the reason when files were not read, where
// "no functions" would be a claim about code ESLint never saw.
const noFunctionsUnparsedReason = "ESLint could not parse the package's files with the source type of their package, so no function was measured (see the Limitation files_not_parsed)"

// measureMetrics are the 50th and 90th percentiles, the maximum and the number
// of values above the threshold of one measure.
func measureMetrics(kind string, threshold int, unit string, vals []int, ok bool, why string) []resultset.Metric {
	sorted := append([]int{}, vals...)
	sort.Ints(sorted)
	above := 0
	for _, v := range sorted {
		if v > threshold {
			above++
		}
	}
	pick := func(name string, v int, unit string) resultset.Metric {
		return countMetric(name, v, unit, ok && len(sorted) > 0, why)
	}
	var max int
	if len(sorted) > 0 {
		max = sorted[len(sorted)-1]
	}
	return []resultset.Metric{
		pick(kind+"_p50", percentile(sorted, 50), unit),
		pick(kind+"_p90", percentile(sorted, 90), unit),
		pick(kind+"_max", max, unit),
		pick(fmt.Sprintf("functions_above_%s_%d", kind, threshold), above, "functions"),
	}
}

// percentile is the nearest-rank percentile of sorted values.
func percentile(sorted []int, p int) int {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(float64(p) / 100 * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	return sorted[rank-1]
}

// metricsDocument is the artifact with the value of every measure per function.
func metricsDocument(in *Input, run *eslintRun, functions []functionValues) ([]byte, error) {
	thresholds := map[string]int{}
	for _, k := range measureKinds {
		thresholds[k.kind] = k.threshold
	}
	if functions == nil {
		functions = []functionValues{}
	}
	doc, err := json.MarshalIndent(struct {
		Check        string           `json:"check"`
		ContextID    string           `json:"context_id"`
		ESLint       string           `json:"eslint_version"`
		ConfigSHA256 string           `json:"config_sha256"`
		Thresholds   map[string]int   `json:"thresholds"`
		Notes        []string         `json:"notes"`
		Functions    []functionValues `json:"functions"`
	}{
		qualityMetricsID, in.Context.ID, run.Output.Version, run.ConfigSHA256, thresholds,
		[]string{
			"Percentiles are nearest-rank values over all functions.",
			"The cognitive complexity rule does not report functions with a value of 0, so they count as 0 and show as 0 here.",
			"Length counts every line of a function, including blank lines and comments.",
		},
		functions,
	}, "", " ")
	if err != nil {
		return nil, err
	}
	return append(doc, '\n'), nil
}
