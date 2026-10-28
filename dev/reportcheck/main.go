// Command reportcheck validates a report folder the way the tests do: the
// files exist, report.json matches the embedded schema and passes the result
// set's consistency rules. It backs dev/ci-readiness.sh and is not part of the
// shipped binary.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/invia-flights/jscript-bench/internal/resultset"
	"github.com/invia-flights/jscript-bench/internal/schema"
)

// Check returns the problems found in the report folder dir, where both
// report.json and report.md are expected. An empty result means the Report is
// valid.
func Check(dir string) []string { return CheckFiles(dir, true) }

// CheckFiles is Check where report.md is only expected when markdown is true,
// for a folder that a Run with --format json wrote.
func CheckFiles(dir string, markdown bool) []string {
	var problems []string
	names := []string{"report.json"}
	if markdown {
		names = append(names, "report.md")
	}
	for _, name := range names {
		if info, err := os.Stat(filepath.Join(dir, name)); err != nil || !info.Mode().IsRegular() {
			problems = append(problems, name+" is missing from "+dir)
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, "report.json"))
	if err != nil {
		return problems
	}
	if schemaProblems := schema.Validate(data); len(schemaProblems) > 0 {
		return append(problems, schemaProblems...)
	}
	var set resultset.Set
	if err := json.Unmarshal(data, &set); err != nil {
		return append(problems, "report.json cannot be read: "+err.Error())
	}
	return append(problems, set.Validate()...)
}

func main() {
	jsonOnly := flag.Bool("json-only", false, "the folder was written with --format json, so report.md is not expected")
	flag.Usage = func() { fmt.Fprintln(os.Stderr, "usage: reportcheck [-json-only] <report-folder>") }
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	problems := CheckFiles(flag.Arg(0), !*jsonOnly)
	for _, p := range problems {
		fmt.Fprintln(os.Stderr, "reportcheck:", p)
	}
	if len(problems) > 0 {
		os.Exit(1)
	}
}
