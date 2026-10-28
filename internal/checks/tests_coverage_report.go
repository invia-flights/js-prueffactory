package checks

import (
	"encoding/json"
	"fmt"
	"math"
	"path"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const testsCoverageID = "tests.coverage"

// coverageKinds are the three measures of a package, in the order the Report
// shows them, with how c8's summary names them.
var coverageKinds = []struct{ name, key, noun string }{
	{"lines", "lines", "lines"},
	{"branches", "branches", "branches"},
	{"functions", "functions", "functions"},
}

// coverageCount is one measure of c8's JSON summary: what was counted and how
// much of it ran. c8 writes "Unknown" or 100 as the percentage of nothing,
// which is why the percentage is computed from the counts.
type coverageCount struct {
	Total   int `json:"total"`
	Covered int `json:"covered"`
}

// percent is the share of covered items, rounded to two decimals, or nil when
// nothing was counted.
func (c coverageCount) percent() *float64 {
	if c.Total <= 0 {
		return nil
	}
	p := math.Round(float64(c.Covered)/float64(c.Total)*10000) / 100
	return &p
}

type coverageEntry map[string]coverageCount

// coverage is what the c8 output of one package says.
type coverage struct {
	// Metrics are the package's percentages: one per measure, null with a
	// reason when the measure has no items.
	Metrics []resultset.Metric
	// FilesDocument is the per-file artifact.
	FilesDocument []byte
	// Err says why the output could not be read; there are no metrics then.
	Err string
}

// interpretCoverage reads c8's JSON summary and per-file JSON. workDir is the
// package folder in the container and pkgPath the package's path in the
// project; files are named by their path in the project. The per-file JSON is
// optional: without it the artifact lists no untested functions.
func interpretCoverage(summary, perFile []byte, workDir, pkgPath string) *coverage {
	var entries map[string]coverageEntry
	if err := json.Unmarshal(summary, &entries); err != nil {
		return &coverage{Err: "c8's JSON summary is not readable: " + err.Error()}
	}
	total, ok := entries["total"]
	if !ok {
		return &coverage{Err: "c8's JSON summary has no total"}
	}
	delete(entries, "total")

	cov := &coverage{}
	for _, k := range coverageKinds {
		m := resultset.Metric{Name: k.name, Unit: "percent"}
		if p := total[k.key].percent(); p != nil {
			m.Value = p
		} else {
			reason := fmt.Sprintf("the package has no %s to measure", k.noun)
			if len(entries) == 0 {
				reason = "c8 measured no file of the package, so there is nothing to report"
			}
			m.Reason = &reason
		}
		cov.Metrics = append(cov.Metrics, m)
	}
	cov.FilesDocument = coverageFilesDocument(entries, total, untestedFunctions(perFile), workDir, pkgPath)
	return cov
}

// NoteFailures adds a note to every metric: the value is the measurement of a
// run in which tests failed.
func (c *coverage) NoteFailures(what string) {
	note := what + ", so the coverage is that of a run with failures and may be lower than that of a passing run"
	for i := range c.Metrics {
		if c.Metrics[i].Reason == nil {
			n := note
			c.Metrics[i].Reason = &n
		} else {
			n := *c.Metrics[i].Reason + "; " + note
			c.Metrics[i].Reason = &n
		}
	}
}

// untestedFunction is a function no test ran.
type untestedFunction struct {
	Name string `json:"name"`
	Line int    `json:"line"`
}

// untestedFunctions reads c8's per-file JSON (Istanbul's coverage map) and
// lists, by file path in the container, the functions with no hit.
func untestedFunctions(perFile []byte) map[string][]untestedFunction {
	var files map[string]struct {
		FnMap map[string]struct {
			Name string `json:"name"`
			Decl struct {
				Start struct {
					Line int `json:"line"`
				} `json:"start"`
			} `json:"decl"`
		} `json:"fnMap"`
		F map[string]int `json:"f"`
	}
	out := map[string][]untestedFunction{}
	if json.Unmarshal(perFile, &files) != nil {
		return out
	}
	for file, data := range files {
		var list []untestedFunction
		for id, fn := range data.FnMap {
			if data.F[id] == 0 {
				list = append(list, untestedFunction{Name: fn.Name, Line: fn.Decl.Start.Line})
			}
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].Line != list[j].Line {
				return list[i].Line < list[j].Line
			}
			return list[i].Name < list[j].Name
		})
		out[file] = list
	}
	return out
}

// coverageMeasure is one measure in the artifact.
type coverageMeasure struct {
	Total   int      `json:"total"`
	Covered int      `json:"covered"`
	Percent *float64 `json:"percent"`
}

func measureOf(c coverageCount) coverageMeasure {
	return coverageMeasure{Total: c.Total, Covered: c.Covered, Percent: c.percent()}
}

type coverageFileDoc struct {
	Path              string             `json:"path"`
	Lines             coverageMeasure    `json:"lines"`
	Branches          coverageMeasure    `json:"branches"`
	Functions         coverageMeasure    `json:"functions"`
	UntestedFunctions []untestedFunction `json:"untested_functions"`
}

// coverageFilesDocument is the artifact: the totals of the package and one
// entry for every file c8 measured, sorted by path.
func coverageFilesDocument(entries map[string]coverageEntry, total coverageEntry, untested map[string][]untestedFunction, workDir, pkgPath string) []byte {
	files := make([]coverageFileDoc, 0, len(entries))
	for file, e := range entries {
		list := untested[file]
		if list == nil {
			list = []untestedFunction{}
		}
		files = append(files, coverageFileDoc{
			Path:  coverageProjectPath(file, workDir, pkgPath),
			Lines: measureOf(e["lines"]), Branches: measureOf(e["branches"]), Functions: measureOf(e["functions"]),
			UntestedFunctions: list,
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	doc, _ := json.MarshalIndent(map[string]any{
		"check_id": testsCoverageID,
		"package":  pkgPath,
		"total": map[string]coverageMeasure{
			"lines": measureOf(total["lines"]), "branches": measureOf(total["branches"]), "functions": measureOf(total["functions"]),
		},
		"files": files,
	}, "", "  ")
	return append(doc, '\n')
}

// coverageProjectPath turns a path in the container into one relative to the project
// root. A path outside the package folder is not made up: it keeps its own.
func coverageProjectPath(file, workDir, pkgPath string) string {
	rel, ok := strings.CutPrefix(file, workDir+"/")
	if !ok {
		return file
	}
	if pkgPath == "." {
		return rel
	}
	return path.Join(pkgPath, rel)
}
