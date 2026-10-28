package checks

import (
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// Listing is what `list-checks` shows: the whole Catalog, which Checks the
// current Selection includes, and what each applies to in the project. Its JSON
// form is the output of `list-checks --format json`.
type Listing struct {
	CatalogVersion   string   `json:"catalog_version"`
	ExecutionProfile string   `json:"execution_profile"`
	Only             []string `json:"only"`
	Exclude          []string `json:"exclude"`
	// Fast says that --fast was given: Selected then leaves out the Checks that
	// are skipped by --fast.
	Fast   bool          `json:"fast"`
	Checks []ListedCheck `json:"checks"`
	// Contexts lists the project Context and every package Context with the
	// Node runtime discovery chose for it.
	Contexts []ListedContext `json:"contexts"`
}

// ListedContext is one Context of the Listing.
type ListedContext struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Path string `json:"path"`
	// Node is the runtime of a package Context, or nil for the project Context
	// and for a package whose Node version is unsupported.
	Node *ListedNode `json:"node"`
	// NodeUnsupported says why the package's Node version is unsupported, or
	// is empty.
	NodeUnsupported string `json:"node_unsupported"`
	// Tests is how a package Context runs its tests, or nil for the project
	// Context and for a package without tests.
	Tests *ListedTests `json:"tests"`
}

// ListedTests is the test setup of a package as discovery read it.
type ListedTests struct {
	// Script is the text of `scripts.test`, empty when the tests come from a
	// Mocha config file.
	Script string `json:"script"`
	// Suites are the runner invocations, in the order they run.
	Suites []ListedSuite `json:"suites"`
	// Unsupported says why the tests cannot be run, or is nil.
	Unsupported *ListedUnsupported `json:"unsupported"`
	// LeftOut lists the steps of the test script that are not run because
	// another Check covers them.
	LeftOut []ListedLeftOut `json:"left_out"`
}

// ListedSuite is one suite of a package.
type ListedSuite struct {
	Origin  string            `json:"origin"`
	Runner  string            `json:"runner"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Dropped string            `json:"dropped"`
}

// ListedUnsupported is the reason a package's tests are refused.
type ListedUnsupported struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

// ListedLeftOut is a step of the test script that is not run.
type ListedLeftOut struct {
	Step   string `json:"step"`
	Script string `json:"script"`
}

// ListedNode is the Node runtime of a package Context.
type ListedNode struct {
	Version    string   `json:"version"`
	Source     string   `json:"source"`
	Variant    string   `json:"variant"`
	Image      string   `json:"image"`
	NotChecked []string `json:"not_checked_versions"`
}

// ListedCheck is one row of the Listing.
type ListedCheck struct {
	ID            string `json:"id"`
	Family        string `json:"family"`
	Status        Status `json:"status"`
	CanFireGates  bool   `json:"can_fire_gates"`
	BenchmarkArea string `json:"benchmark_area"`
	Selected      bool   `json:"selected"`
	// SkippedByFast says whether --fast leaves the Check out. It is shown for
	// planned Checks too, where it has no effect yet.
	SkippedByFast bool `json:"skipped_by_fast"`
	// Applicability has one entry per package or project Context. A planned
	// Check has none.
	Applicability []ListedApplicability `json:"applicability"`
}

// ListedApplicability is the Applicability of a Check in one Context.
type ListedApplicability struct {
	ContextID     string                  `json:"context_id"`
	Kind          string                  `json:"kind"`
	Path          string                  `json:"path"`
	Applicability resultset.Applicability `json:"applicability"`
	Reason        string                  `json:"reason"`
}

// List builds the Listing from discovery data alone. implementation returns the
// implementation of a Check ID, or nil for a planned Check.
func List(proj *discovery.Project, entries []Entry, sel *Selection, implementation func(id string) Check) *Listing {
	l := &Listing{
		CatalogVersion: CatalogVersion, ExecutionProfile: ExecutionProfile,
		Only: nonNil(sel.Only), Exclude: nonNil(sel.Exclude), Fast: sel.Fast,
	}
	for _, c := range proj.Contexts {
		lc := ListedContext{ID: c.ID, Kind: c.Kind, Path: c.Path}
		if c.Node != nil {
			lc.Node = &ListedNode{
				Version: c.Node.Version, Source: c.Node.Source, Variant: c.Node.Variant,
				Image: c.Node.Image, NotChecked: nonNil(c.Node.NotChecked),
			}
		}
		if c.Package != nil && c.Package.NodeChoice.Unsupported != nil {
			lc.NodeUnsupported = c.Package.NodeChoice.Unsupported.Reason
		}
		if c.Package != nil && c.Package.Tests != nil {
			lc.Tests = listedTests(c.Package.Tests)
		}
		l.Contexts = append(l.Contexts, lc)
	}
	for _, e := range entries {
		row := ListedCheck{
			ID: e.ID, Family: e.Family, Status: e.Status, CanFireGates: e.CanFireGates, BenchmarkArea: e.Area,
			Selected: sel.Selected(e.ID), SkippedByFast: e.SkippedByFast, Applicability: []ListedApplicability{},
		}
		if impl := implementation(e.ID); impl != nil && e.Status == Implemented {
			for _, p := range Placements(proj, e, impl) {
				row.Applicability = append(row.Applicability, ListedApplicability{
					ContextID: p.Context.ID, Kind: p.Context.Kind, Path: p.Context.Path,
					Applicability: p.Applicability, Reason: p.Reason,
				})
			}
		}
		l.Checks = append(l.Checks, row)
	}
	return l
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func listedTests(t *discovery.TestSetup) *ListedTests {
	out := &ListedTests{Script: t.Script, Suites: []ListedSuite{}, LeftOut: []ListedLeftOut{}}
	for _, s := range t.Suites {
		out.Suites = append(out.Suites, ListedSuite{
			Origin: s.Origin, Runner: string(s.Runner), Args: nonNil(s.Args), Env: s.Env, Dropped: s.Dropped,
		})
	}
	if t.Unsupported != nil {
		out.Unsupported = &ListedUnsupported{Code: t.Unsupported.Code, Reason: t.Unsupported.Reason}
	}
	for _, l := range t.LeftOut {
		out.LeftOut = append(out.LeftOut, ListedLeftOut{Step: l.Step, Script: l.Script})
	}
	return out
}
