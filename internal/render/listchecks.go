package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// ListChecksJSON renders the output of `list-checks --format json`.
func ListChecksJSON(l *checks.Listing) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(l); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ListChecksMarkdown renders the output of `list-checks`: one table row per
// Check of the Catalog.
func ListChecksMarkdown(l *checks.Listing) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "# js-prueffactory list-checks\n\n")
	fmt.Fprintf(&b, "Catalog %s, execution profile %s.", code(l.CatalogVersion), code(l.ExecutionProfile))
	if len(l.Only) > 0 {
		fmt.Fprintf(&b, " Only: %s.", joinCode(l.Only))
	}
	if len(l.Exclude) > 0 {
		fmt.Fprintf(&b, " Exclude: %s.", joinCode(l.Exclude))
	}
	if l.Fast {
		b.WriteString(" With `--fast`: the Checks skipped by `--fast` are not selected.")
	}
	b.WriteString("\n\n")
	b.WriteString("| Check | Family | Status | Can fire Gates | Benchmark area | Skipped by `--fast` | Selected | Applicability |\n")
	b.WriteString("|---|---|---|---|---|---|---|---|\n")
	for _, c := range l.Checks {
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %s | %s | %s | %s |\n",
			cellCode(c.ID), cell(c.Family), cell(string(c.Status)), yesNo(c.CanFireGates), cell(c.BenchmarkArea),
			yesNo(c.SkippedByFast), yesNo(c.Selected), applicabilityCell(c))
	}
	writeListedContexts(&b, l.Contexts)
	writeListedSuites(&b, l.Contexts)
	return []byte(b.String())
}

// writeListedContexts adds the table of Contexts with their Node runtime. Paths,
// versions and reasons come from the project, so they are escaped.
func writeListedContexts(b *strings.Builder, contexts []checks.ListedContext) {
	b.WriteString("\nContexts:\n\n")
	b.WriteString("| Context | Path | Node | Source | Not checked |\n")
	b.WriteString("|---|---|---|---|---|\n")
	for _, c := range contexts {
		node, source, notChecked := "-", "-", "-"
		switch {
		case c.Node != nil:
			node, source = cell(c.Node.Version+" "+c.Node.Variant), cell(c.Node.Source)
			if len(c.Node.NotChecked) > 0 {
				notChecked = cell(strings.Join(c.Node.NotChecked, "; "))
			}
		case c.NodeUnsupported != "":
			node = "unsupported: " + reasonCell(c.NodeUnsupported)
		}
		fmt.Fprintf(b, "| %s | %s | %s | %s | %s |\n", cell(c.ID), cellCode(c.Path), node, source, notChecked)
	}
}

// applicabilityCell lists the Applicability per Context, with the reason where
// there is one. Paths and reasons may hold project text, so they are escaped.
func applicabilityCell(c checks.ListedCheck) string {
	if len(c.Applicability) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(c.Applicability))
	for _, a := range c.Applicability {
		where := "project"
		if a.Kind == "package" {
			where = "package " + cellCode(a.Path)
		}
		s := fmt.Sprintf("%s (%s): %s", where, cell(a.ContextID), cell(string(a.Applicability)))
		if a.Reason != "" {
			s += " - " + reasonCell(a.Reason)
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "; ")
}

// writeListedSuites adds the test suites of every package that has tests, in
// the order they run. Script text and arguments come from the project, so they
// are escaped.
func writeListedSuites(b *strings.Builder, contexts []checks.ListedContext) {
	var rows []string
	for _, c := range contexts {
		t := c.Tests
		if t == nil {
			continue
		}
		if t.Unsupported != nil {
			rows = append(rows, fmt.Sprintf("| %s | - | - | unsupported: %s |", cell(c.ID), reasonCell(t.Unsupported.Reason)))
			continue
		}
		for _, s := range t.Suites {
			rows = append(rows, fmt.Sprintf("| %s | %s | %s | %s |", cell(c.ID), cellCode(s.Origin), cell(s.Runner), cellCode(suiteCommand(s))))
		}
		for _, l := range t.LeftOut {
			rows = append(rows, fmt.Sprintf("| %s | - | - | left out: %s in %s (lint.existing covers it) |", cell(c.ID), cellCode(l.Step), cellCode(l.Script)))
		}
	}
	if len(rows) == 0 {
		return
	}
	b.WriteString("\nTest suites:\n\n")
	b.WriteString("| Context | Suite | Runner | Arguments |\n")
	b.WriteString("|---|---|---|---|\n")
	for _, r := range rows {
		b.WriteString(r + "\n")
	}
}

// suiteCommand is the environment variables and arguments of a suite as one
// line.
func suiteCommand(s checks.ListedSuite) string {
	var parts []string
	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, k+"="+s.Env[k])
	}
	return strings.Join(append(parts, s.Args...), " ")
}
