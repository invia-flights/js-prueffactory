package benchmark

import (
	"regexp"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Side indicators are measurements shown next to the score with weight 0. They
// never change the score, the range or the Verdict.
//
// Adding one means adding a row to indicatorDefs. A row either reads one value
// from the completed executions of its Checks (value), or turns every Metric
// whose name starts with metricPrefix into an indicator of its own, which is
// how Coverage and the complexity thresholds appear without the scorer knowing
// their names in advance.

type indicatorDef struct {
	id, label, unit string
	checks          []string
	// value reads the indicator from the executions that completed. It returns
	// nil when there is nothing to report.
	value func(idx *index, measured []*resultset.Execution) *float64
	// metricPrefix selects the Metrics of the Checks that become indicators of
	// their own, named id + "." + the rest of the metric's name.
	metricPrefix string
}

var indicatorDefs = []indicatorDef{
	{id: "coverage", label: "Coverage", checks: []string{"tests.coverage"}, metricPrefix: ""},
	{id: "complexity", label: "Functions above complexity threshold", checks: []string{"quality.metrics"}, metricPrefix: "functions_above_"},
	{id: "duplication", label: "Duplicated code", checks: []string{"quality.clones"}, metricPrefix: "duplication_percent_"},
	{id: "import_cycles", label: "Import cycles", unit: "cycles", checks: []string{"modules.cycles"},
		value: countFindings(func(f *resultset.Finding) bool { return ruleOf(f) == "circular-import" })},
	{id: "unused_files", label: "Unused files", unit: "files", checks: []string{"quality.unused"},
		value: countFindings(ruleIn("unused-file"))},
	{id: "unused_exports", label: "Unused exports", unit: "exports", checks: []string{"quality.unused"},
		value: countFindings(ruleIn("unused-export", "unused-type"))},
	{id: "unused_dependencies", label: "Unused dependencies", unit: "dependencies", checks: []string{"quality.unused"},
		value: countFindings(ruleIn("unused-dependency", "unused-dev-dependency", "unused-optional-peer-dependency"))},
	{id: "jsdoc_type_errors", label: "JSDoc type errors", unit: "errors", checks: []string{"types.javascript"},
		value: countFindings(nil)},
	{id: "strict_gap_errors", label: "Errors that only strict mode reports", unit: "errors", checks: []string{"types.strictness"},
		value: sumNamedMetric("strict_gap_errors")},
	{id: "runtime_warnings", label: "Runtime warnings and open resources", unit: "findings", checks: []string{"runtime.warnings"},
		value: countFindings(nil)},
	{id: "unknown_licenses", label: "Packages without a license in the lockfile", unit: "packages", checks: []string{"security.licenses"},
		value: sumMetrics(func(license string) bool { return license == "none_in_lockfile" })},
	{id: "copyleft_licenses", label: "Packages with a copyleft license", unit: "packages", checks: []string{"security.licenses"},
		value: sumMetrics(isCopyleft)},
	{id: "install_scripts", label: "Packages with install scripts", unit: "packages", checks: []string{"package.install-scripts"},
		value: sumNamedMetric("install_scripts")},
	{id: "source_code_lines", label: "Lines of JavaScript and TypeScript in Source code", unit: "lines", checks: []string{"quality.size"},
		value: sumNamedMetric("lines.source_code:javascript_typescript")},
	// The registry changes without the project changing, so what it says about
	// deprecations is shown and never scored.
	{id: "deprecated_prod", label: "Locked versions marked deprecated, production", unit: "versions", checks: []string{"deps.deprecated"},
		value: sumNamedMetric("deprecated_prod")},
	{id: "deprecated_dev", label: "Locked versions marked deprecated, development", unit: "versions", checks: []string{"deps.deprecated"},
		value: sumNamedMetric("deprecated_dev")},
	// The same holds for how far behind the registry's latest versions the
	// direct dependencies are.
	{id: "libyears_total", label: "Libyears of direct dependencies", unit: "years", checks: []string{"deps.outdated"},
		value: sumNamedMetric("libyears_total")},
	{id: "majors_behind", label: "Direct dependencies a major version or more behind", unit: "dependencies", checks: []string{"deps.outdated"},
		value: sumNamedMetric("majors_behind")},
}

// sideIndicators lists the indicators in report order.
func sideIndicators(idx *index) []resultset.SideIndicator {
	out := []resultset.SideIndicator{}
	for _, def := range indicatorDefs {
		state, reason, measured := indicatorState(idx, def.checks)
		base := resultset.SideIndicator{
			ID: def.id, Label: def.label, Unit: def.unit, State: state, SourceChecks: append([]string{}, def.checks...),
		}
		if reason != "" {
			r := reason
			base.Reason = &r
		}
		if state != resultset.PartMeasured {
			out = append(out, base)
			continue
		}
		if def.value != nil {
			base.Value = rounded2(def.value(idx, measured))
			out = append(out, base)
			continue
		}
		rows := metricRows(idx, def, measured, base)
		if len(rows) == 0 {
			rows = append(rows, base) // measured, but no value to show
		}
		out = append(out, rows...)
	}
	return out
}

// indicatorState says whether an indicator's Checks were measured, had
// nothing to examine, or are unknown. A Check the Report holds no execution of
// is unknown: the build has no such Check, or it did not take part.
func indicatorState(idx *index, checks []string) (state, reason string, measured []*resultset.Execution) {
	var unknown []*resultset.Execution
	applicable, seen := 0, 0
	for _, check := range checks {
		for _, e := range idx.execsOf[check] {
			seen++
			if e.Applicability == resultset.NotApplicable {
				continue
			}
			applicable++
			if classify(e) == classMeasured {
				measured = append(measured, e)
			} else {
				unknown = append(unknown, e)
			}
		}
	}
	switch {
	case seen == 0:
		return resultset.PartUnknown, "not_available", nil
	case applicable == 0:
		return resultset.PartNotApplicable, "", nil
	case len(unknown) > 0:
		return resultset.PartUnknown, unknownReason(unknown), nil
	}
	return resultset.PartMeasured, "", measured
}

func rounded2(v *float64) *float64 {
	if v == nil {
		return nil
	}
	r := round2(*v)
	return &r
}

// --- value readers ---

func countFindings(keep func(*resultset.Finding) bool) func(*index, []*resultset.Execution) *float64 {
	return func(idx *index, measured []*resultset.Execution) *float64 {
		n := 0
		for _, e := range measured {
			for i := range idx.findingsOf[e.ID] {
				f := &idx.findingsOf[e.ID][i]
				if keep == nil || keep(f) {
					n++
				}
			}
		}
		v := float64(n)
		return &v
	}
}

func ruleIn(rules ...string) func(*resultset.Finding) bool {
	return func(f *resultset.Finding) bool {
		for _, r := range rules {
			if ruleOf(f) == r {
				return true
			}
		}
		return false
	}
}

// metricsOf returns the Metrics of the executions, in report order.
func metricsOf(idx *index, measured []*resultset.Execution) []resultset.Metric {
	byCtx := map[string]map[string]bool{}
	for _, e := range measured {
		if byCtx[e.CheckID] == nil {
			byCtx[e.CheckID] = map[string]bool{}
		}
		byCtx[e.CheckID][e.ContextID] = true
	}
	var out []resultset.Metric
	for _, m := range idx.set.Metrics {
		if byCtx[m.CheckID][m.ContextID] {
			out = append(out, m)
		}
	}
	return out
}

func sumMetrics(match func(license string) bool) func(*index, []*resultset.Execution) *float64 {
	return func(idx *index, measured []*resultset.Execution) *float64 {
		sum := 0.0
		for _, m := range metricsOf(idx, measured) {
			name, ok := strings.CutPrefix(m.Name, "license:")
			if ok && m.Value != nil && match(name) {
				sum += *m.Value
			}
		}
		return &sum
	}
}

func sumNamedMetric(name string) func(*index, []*resultset.Execution) *float64 {
	return func(idx *index, measured []*resultset.Execution) *float64 {
		sum := 0.0
		for _, m := range metricsOf(idx, measured) {
			if m.Name == name && m.Value != nil {
				sum += *m.Value
			}
		}
		return &sum
	}
}

// copyleftToken matches the SPDX identifiers of licenses with a copyleft
// effect, strong or weak. An expression such as "MIT OR GPL-3.0" counts when
// any of its identifiers does, which is the cautious reading.
var copyleftToken = regexp.MustCompile(`^(?:A|L)?GPL(?:-.*)?$|^(?:MPL|EPL|CDDL|EUPL|OSL|SSPL|CPAL)(?:-.*)?$|^CC-BY-N?C?-?SA(?:-.*)?$`)

func isCopyleft(license string) bool {
	for _, tok := range strings.FieldsFunc(license, func(r rune) bool { return r == ' ' || r == '(' || r == ')' || r == '/' }) {
		if copyleftToken.MatchString(strings.ToUpper(tok)) {
			return true
		}
	}
	return false
}

// --- indicators made of Metrics ---

// metricRows makes one indicator of each Metric whose name starts with the
// definition's prefix. Percentages are averaged over the Contexts and other
// units added up. A Metric without a value is shown without one, with its
// reason.
func metricRows(idx *index, def indicatorDef, measured []*resultset.Execution, base resultset.SideIndicator) []resultset.SideIndicator {
	type agg struct {
		unit   string
		values []float64
		reason *string
	}
	byName := map[string]*agg{}
	for _, m := range metricsOf(idx, measured) {
		if !strings.HasPrefix(m.Name, def.metricPrefix) {
			continue
		}
		a := byName[m.Name]
		if a == nil {
			a = &agg{unit: m.Unit}
			byName[m.Name] = a
		}
		if m.Value != nil {
			a.values = append(a.values, *m.Value)
		} else if a.reason == nil {
			a.reason = m.Reason
		}
	}
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)
	var rows []resultset.SideIndicator
	for _, n := range names {
		a := byName[n]
		row := base
		row.ID = def.id + "." + strings.TrimPrefix(n, def.metricPrefix)
		row.Label = def.label + ": " + strings.ReplaceAll(strings.TrimPrefix(n, def.metricPrefix), "_", " ")
		row.Unit = a.unit
		if len(a.values) > 0 {
			sum := 0.0
			for _, v := range a.values {
				sum += v
			}
			if a.unit == "percent" {
				sum /= float64(len(a.values))
			}
			row.Value = rounded2(&sum)
		} else {
			row.Reason = a.reason
		}
		rows = append(rows, row)
	}
	return rows
}
