package checks

import (
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Placement is one Check in one Context, with its Applicability there. Runs and
// `list-checks` both ask for Placements, so they agree on what a Check covers.
type Placement struct {
	Context       *discovery.Context
	Applicability resultset.Applicability
	Reason        string
}

// Placements lists where a Check applies. Per-package Checks get one Placement
// in every package Context, per-project Checks one in the project Context. A
// per-package Check in a project without packages gets one not_applicable
// Placement in the project Context, so a Check is never left out silently.
func Placements(proj *discovery.Project, entry Entry, impl Check) []Placement {
	place := func(c *discovery.Context) Placement {
		app, reason := impl.Applicability(proj, c)
		return Placement{Context: c, Applicability: app, Reason: reason}
	}
	if entry.Scope == PerProject {
		return []Placement{place(&proj.Contexts[0])}
	}
	var out []Placement
	for i := range proj.Contexts {
		if proj.Contexts[i].Package != nil {
			out = append(out, place(&proj.Contexts[i]))
		}
	}
	if len(out) == 0 {
		out = append(out, Placement{
			Context: &proj.Contexts[0], Applicability: resultset.NotApplicable,
			Reason: "the project has no package.json",
		})
	}
	return out
}
