package engine

import (
	"fmt"
	"slices"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// planned is one Check execution the Run will perform or report as not
// applicable: one Check in one Context.
type planned struct {
	key           string // temporary execution key, replaced by E-0001 and so on
	entry         checks.Entry
	check         checks.Check
	context       *discovery.Context
	applicability resultset.Applicability
	reason        string
	// deselected is true for a Check the Selection leaves out. It is reported
	// as not started and never runs, unless it is a prerequisite.
	deselected bool
	// byFast is true when --fast, and not --only or --exclude, left it out.
	byFast bool
	// prerequisite is true for a deselected Check that runs anyway because
	// something else depends on it: the secret scan, because redaction needs
	// the values it finds, and every Check that a selected one needs (see
	// checks.PrerequisiteUser and resolvePrerequisites). It runs, is reported
	// as not selected and reports no Findings.
	prerequisite bool
	// needs are the executions that must finish before this one starts.
	needs []*planned
	// waits are the installs whose test file probe this execution waits for,
	// because it reads File classes (checks.FileClassReader). Unlike needs,
	// what became of them does not matter: a probe that did not run leaves the
	// static classes. A deselected install in waits runs as a prerequisite.
	waits []*planned
	// follows are the executions that run before this one without it needing
	// them to succeed (checks.RunsAfterUser): tests.flaky starts after the
	// shared first run of tests.existing, whatever became of it. A deselected
	// one runs as a prerequisite.
	follows []*planned
	// orderedAfter are the executions this one starts after when they run
	// (checks.OrderedAfterUser). Unlike follows, a deselected one stays
	// deselected.
	orderedAfter []*planned
}

// runnable says whether the execution has to be performed.
func (p *planned) runnable() bool {
	return (!p.deselected || p.prerequisite) && p.applicability != resultset.NotApplicable
}

// plan lists one execution per implemented Check and Context. A Check that the
// Selection leaves out is planned too, as deselected, so the Report names it
// and Standard completeness counts it. Placements decides where a Check runs.
func plan(proj *discovery.Project, sel *checks.Selection) []*planned {
	var out []*planned
	for _, id := range checks.ImplementedIDs() {
		entry, _ := checks.Lookup(id)
		impl := checks.Implementation(id)
		for _, pl := range checks.Placements(proj, entry, impl) {
			deselected := !sel.Selected(id)
			out = append(out, &planned{
				key: fmt.Sprintf("x%d", len(out)+1), entry: entry, check: impl, context: pl.Context,
				applicability: pl.Applicability, reason: pl.Reason, deselected: deselected,
				byFast:       slices.Contains(sel.DeselectedByFast, id),
				prerequisite: deselected && id == checks.SecretsCheckID,
			})
		}
	}
	resolveProbeWaits(out)
	resolvePrerequisites(out)
	return out
}
