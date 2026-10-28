package engine

import (
	"fmt"
	"sort"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Prerequisites. A Check that implements checks.PrerequisiteUser needs other
// Checks of the same Context, such as deps.tree after package.install. The plan
// links them (planned.needs) and marks the ones the Selection left out as
// prerequisites, so they run anyway. The scheduler starts a dependent after its
// prerequisites finished (job.after), and the engine decides, from how they
// finished, whether the dependent can run at all.

// Reason codes of a dependent that did not run because of a prerequisite. A
// failure the project caused has its own code, so the Benchmark can tell it
// from one the Run caused. A Run-caused failure keeps the prerequisite's own
// code when it has a specific one, such as missing_registry_credentials.
const (
	reasonPrerequisiteFailedProject = "prerequisite_failed_project"
	reasonPrerequisiteFailedRun     = "prerequisite_failed_run"
	reasonPrerequisiteNotRun        = "prerequisite_not_run"
)

// resolvePrerequisites links every execution to the executions it needs and
// marks deselected ones that a runnable execution needs as prerequisites. A
// prerequisite may need prerequisites itself, so it repeats until nothing
// changes.
func resolvePrerequisites(all []*planned) {
	for _, p := range all {
		if pu, ok := p.check.(checks.PrerequisiteUser); ok {
			for _, id := range pu.Prerequisites(p.context) {
				if q := findPlanned(all, id, p.context); q != nil && q != p {
					p.needs = append(p.needs, q)
				}
			}
		}
		if ru, ok := p.check.(checks.RunsAfterUser); ok {
			for _, id := range ru.RunsAfter(p.context) {
				if q := findPlanned(all, id, p.context); q != nil && q != p {
					p.follows = append(p.follows, q)
				}
			}
		}
		if ou, ok := p.check.(checks.OrderedAfterUser); ok {
			for _, id := range ou.OrderedAfter(p.context) {
				if q := findPlanned(all, id, p.context); q != nil && q != p {
					p.orderedAfter = append(p.orderedAfter, q)
				}
			}
		}
	}
	for changed := true; changed; {
		changed = false
		for _, p := range all {
			if !p.runnable() {
				continue
			}
			for _, q := range append(append(append([]*planned{}, p.needs...), p.waits...), p.follows...) {
				if q.deselected && !q.prerequisite && q.applicability != resultset.NotApplicable {
					q.prerequisite, changed = true, true
				}
			}
		}
	}
}

// resolveProbeWaits links every Check that reads File classes to the installs
// whose probe it waits for: its own package's for a package Check, every
// package's with a probe for a project Check. A package without a probe has
// nothing to wait for.
func resolveProbeWaits(all []*planned) {
	for _, p := range all {
		if r, ok := p.check.(checks.FileClassReader); !ok || !r.ReadsFileClasses() {
			continue
		}
		for _, c := range probedContexts(all, p) {
			if q := findPlanned(all, packageInstallCheck, c); q != nil && q != p && q.applicability != resultset.NotApplicable {
				p.waits = append(p.waits, q)
			}
		}
	}
}

// packageInstallCheck is the Check whose run ends with the test file probe.
const packageInstallCheck = "package.install"

// probedContexts lists the package Contexts whose files the execution examines
// and whose tests have a probe, in plan order.
func probedContexts(all []*planned, p *planned) []*discovery.Context {
	if p.context.Package != nil {
		if checks.HasTestFileProbe(p.context) {
			return []*discovery.Context{p.context}
		}
		return nil
	}
	var out []*discovery.Context
	seen := map[string]bool{}
	for _, q := range all {
		if q.entry.ID == packageInstallCheck && q.context.Package != nil && !seen[q.context.ID] && checks.HasTestFileProbe(q.context) {
			seen[q.context.ID] = true
			out = append(out, q.context)
		}
	}
	return out
}

func findPlanned(all []*planned, checkID string, c *discovery.Context) *planned {
	for _, q := range all {
		if q.entry.ID == checkID && q.context.ID == c.ID {
			return q
		}
	}
	return nil
}

// prerequisitesRun lists, in Catalog order, the Checks that ran without being
// selected because a selected Check needed them.
func (r *run) prerequisitesRun() []string {
	seen := map[string]bool{}
	var ids []string
	// The secret scan reports itself in r.prerequisites (see takeSecretScan).
	for _, id := range r.prerequisites {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, p := range r.planned {
		if p.prerequisite && p.runnable() && !seen[p.entry.ID] {
			seen[p.entry.ID] = true
			ids = append(ids, p.entry.ID)
		}
	}
	order := map[string]int{}
	for i, id := range checks.ImplementedIDs() {
		order[id] = i
	}
	sort.Slice(ids, func(a, b int) bool { return order[ids[a]] < order[ids[b]] })
	return ids
}

// finish remembers how an execution ended, for the executions that wait for it.
func (r *run) finish(p *planned, res *execResult) {
	r.finMu.Lock()
	defer r.finMu.Unlock()
	if r.finished == nil {
		r.finished = map[*planned]*execResult{}
	}
	r.finished[p] = res
}

func (r *run) finishedResult(p *planned) *execResult {
	r.finMu.Lock()
	defer r.finMu.Unlock()
	return r.finished[p]
}

// blockedByPrerequisite returns the result of an execution that cannot run
// because a prerequisite did not complete without a Gate, or nil when it can.
// What happened to the dependent follows from what happened to the
// prerequisite: unsupported stays unsupported, a Gate is the project's fault,
// and anything else that kept the prerequisite from completing is the Run's.
func (r *run) blockedByPrerequisite(p *planned) *execResult {
	for _, q := range p.needs {
		qr := r.finishedResult(q)
		if qr == nil {
			return stopped(p, resultset.StatusBlocked, reasonPrerequisiteNotRun,
				fmt.Sprintf("%s has to run first, but it did not run in this Context", q.entry.ID))
		}
		status := qr.exec.Status
		switch {
		case status == resultset.StatusCompleted && qr.gates == 0:
			continue
		case status == resultset.StatusUnsupported:
			return stopped(p, resultset.StatusUnsupported, deref(qr.exec.ReasonCode), deref(qr.exec.Reason))
		case status == resultset.StatusCompleted:
			return stopped(p, resultset.StatusBlocked, reasonPrerequisiteFailedProject,
				fmt.Sprintf("%s failed because of the project, so there is nothing to examine: %s", q.entry.ID, qr.failure))
		case status == resultset.StatusCancelled || status == resultset.StatusBudgetExhausted:
			return stopped(p, status, deref(qr.exec.ReasonCode), fmt.Sprintf("%s did not finish: %s", q.entry.ID, deref(qr.exec.Reason)))
		}
		code := reasonPrerequisiteFailedRun
		if specific := deref(qr.exec.ReasonCode); specific != "" &&
			(status == resultset.StatusBlocked || status == resultset.StatusInfrastructureError) {
			code = specific
		}
		return stopped(p, resultset.StatusBlocked, code,
			fmt.Sprintf("%s did not complete (%s), so there is nothing to examine: %s", q.entry.ID, status, deref(qr.exec.Reason)))
	}
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// recordNPM puts the npm version a Check found into its Context.
func recordNPM(c *discovery.Context, version string) {
	if version == "" {
		return
	}
	toolsMu.Lock()
	defer toolsMu.Unlock()
	c.NPM = &version
}
