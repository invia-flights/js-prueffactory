package checks_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
)

// entries is a small Catalog: the real one grows as Checks are implemented, and
// Selection rules must not depend on which Checks exist today.
var entries = []checks.Entry{
	{ID: "security.secrets", Family: "security", Status: checks.Implemented},
	{ID: "security.dependencies", Family: "security", Status: checks.Implemented},
	{ID: "security.containers", Family: "security", Status: checks.Planned},
	{ID: "tests.existing", Family: "tests", Status: checks.Implemented},
	{ID: "tests.mutation", Family: "tests", Status: checks.Planned},
	{ID: "sbom.generate", Family: "sbom", Status: checks.Planned},
	{ID: "syntax.parse", Family: "syntax", Status: checks.Implemented},
}

func TestWithoutOnlyTheWholeImplementedCatalogIsSelected(t *testing.T) {
	sel, err := checks.Resolve(entries, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"security.secrets", "security.dependencies", "tests.existing", "syntax.parse"}
	if !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if len(sel.Deselected) != 0 || !sel.IsStandardScope {
		t.Errorf("deselected %v, standard scope %v", sel.Deselected, sel.IsStandardScope)
	}
}

func TestOnlyBuildsTheUnionOfIDsAndFamiliesInCatalogOrder(t *testing.T) {
	// One flag with a comma list, and a repeated flag.
	sel, err := checks.Resolve(entries, []string{"syntax.parse,security"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"security.secrets", "security.dependencies", "syntax.parse"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if want := []string{"tests.existing"}; !slices.Equal(sel.Deselected, want) {
		t.Errorf("deselected = %v, want %v", sel.Deselected, want)
	}
	if sel.IsStandardScope {
		t.Error("a partial Selection must not be standard scope")
	}
	if !slices.Equal(sel.Only, []string{"syntax.parse", "security"}) || len(sel.Exclude) != 0 {
		t.Errorf("requested only %v exclude %v", sel.Only, sel.Exclude)
	}

	again, err := checks.Resolve(entries, []string{"syntax.parse", "security"}, nil)
	if err != nil || !slices.Equal(again.Effective, sel.Effective) {
		t.Errorf("a repeated flag differs from a comma list: %v, %v", again, err)
	}
}

func TestExcludeSubtractsAfterOnly(t *testing.T) {
	sel, err := checks.Resolve(entries, []string{"security"}, []string{"security.dependencies"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"security.secrets"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if !slices.Equal(sel.Exclude, []string{"security.dependencies"}) {
		t.Errorf("requested exclude = %v", sel.Exclude)
	}

	// Exclude alone starts from the whole implemented Catalog.
	sel, err = checks.Resolve(entries, nil, []string{"tests"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"security.secrets", "security.dependencies", "syntax.parse"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if want := []string{"tests.existing"}; !slices.Equal(sel.Deselected, want) {
		t.Errorf("deselected = %v, want %v", sel.Deselected, want)
	}
}

func TestAFamilyWithPlannedMembersSelectsItsImplementedChecksOnly(t *testing.T) {
	sel, err := checks.Resolve(entries, []string{"tests"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"tests.existing"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
}

func TestSelectionErrorsNameTheProblem(t *testing.T) {
	cases := []struct {
		name          string
		only, exclude []string
		want          string
	}{
		{"unknown ID", []string{"tests.exsting"}, nil, `unknown Check or family "tests.exsting"`},
		{"unknown family", []string{"bogus"}, nil, `unknown Check or family "bogus"`},
		{"unknown in exclude", nil, []string{"bogus"}, `unknown Check or family "bogus"`},
		{"planned ID", []string{"tests.mutation"}, nil, "planned"},
		{"planned ID in exclude", nil, []string{"tests.mutation"}, "planned"},
		{"family of planned Checks only", []string{"sbom"}, nil, "planned"},
		{"empty element", []string{"tests,,syntax"}, nil, "empty"},
		{"empty flag value", []string{""}, nil, "empty"},
		{"empty Selection", []string{"tests"}, []string{"tests.existing"}, "no Checks"},
		{"exclude everything", nil, []string{"security", "tests", "syntax"}, "no Checks"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := checks.Resolve(entries, tc.only, tc.exclude)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want one that mentions %q", err, tc.want)
			}
		})
	}
}

// fastEntries has implemented Checks that --fast skips next to ones it keeps,
// and a planned one with the marking. The real Catalog marks Checks that Specs
// B and C implement later, so the rules are tested on this list.
var fastEntries = []checks.Entry{
	{ID: "tests.existing", Family: "tests", Status: checks.Implemented},
	{ID: "tests.mutation", Family: "tests", Status: checks.Implemented, SkippedByFast: true},
	{ID: "api.lint", Family: "api", Status: checks.Implemented},
	{ID: "api.fuzz", Family: "api", Status: checks.Implemented, SkippedByFast: true},
	{ID: "api.dast", Family: "api", Status: checks.Planned, SkippedByFast: true},
}

func TestFastDeselectsTheMarkedImplementedChecks(t *testing.T) {
	sel, err := checks.ResolveFast(fastEntries, nil, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"tests.existing", "api.lint"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if want := []string{"tests.mutation", "api.fuzz"}; !slices.Equal(sel.Deselected, want) {
		t.Errorf("deselected = %v, want %v", sel.Deselected, want)
	}
	if want := []string{"tests.mutation", "api.fuzz"}; !slices.Equal(sel.DeselectedByFast, want) {
		t.Errorf("deselected by --fast = %v, want %v", sel.DeselectedByFast, want)
	}
	if !sel.Fast || sel.IsStandardScope {
		t.Errorf("fast %v, standard scope %v", sel.Fast, sel.IsStandardScope)
	}
}

func TestWithoutFastTheMarkedChecksAreSelected(t *testing.T) {
	sel, err := checks.ResolveFast(fastEntries, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"tests.existing", "tests.mutation", "api.lint", "api.fuzz"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if sel.Fast || len(sel.DeselectedByFast) != 0 || !sel.IsStandardScope {
		t.Errorf("fast %v, by fast %v, standard scope %v", sel.Fast, sel.DeselectedByFast, sel.IsStandardScope)
	}
}

func TestFastRemovesMarkedChecksAfterOnlyAndExclude(t *testing.T) {
	// --only names a marked Check and a kept one: the marked one goes.
	sel, err := checks.ResolveFast(fastEntries, []string{"tests"}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"tests.existing"}; !slices.Equal(sel.Effective, want) {
		t.Errorf("effective = %v, want %v", sel.Effective, want)
	}
	if want := []string{"tests.mutation"}; !slices.Equal(sel.DeselectedByFast, want) {
		t.Errorf("deselected by --fast = %v, want %v", sel.DeselectedByFast, want)
	}

	// A Check that --exclude already removed is not deselected by --fast.
	sel, err = checks.ResolveFast(fastEntries, nil, []string{"tests.mutation"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"api.fuzz"}; !slices.Equal(sel.DeselectedByFast, want) {
		t.Errorf("deselected by --fast = %v, want %v", sel.DeselectedByFast, want)
	}
	if want := []string{"tests.mutation", "api.fuzz"}; !slices.Equal(sel.Deselected, want) {
		t.Errorf("deselected = %v, want %v", sel.Deselected, want)
	}
}

func TestFastWithAnOnlyThatNamesSkippedChecksOnlyIsAnEmptySelection(t *testing.T) {
	_, err := checks.ResolveFast(fastEntries, []string{"tests.mutation,api.fuzz"}, nil, true)
	if err == nil || !strings.Contains(err.Error(), "no Checks") || !strings.Contains(err.Error(), "--fast") {
		t.Fatalf("error = %v, want one about an empty Selection that mentions --fast", err)
	}
}

func TestFastIgnoresAMarkedCheckThatIsStillPlanned(t *testing.T) {
	// --fast alone never trips over api.dast being planned.
	if _, err := checks.ResolveFast(fastEntries, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	// An explicit --only still refuses a planned Check, with or without --fast.
	_, err := checks.ResolveFast(fastEntries, []string{"api.dast"}, nil, true)
	if err == nil || !strings.Contains(err.Error(), "planned") {
		t.Fatalf("error = %v, want the planned Check error", err)
	}
}

func TestTheCatalogMarksMutationFuzzAndDASTAsSkippedByFast(t *testing.T) {
	var marked []string
	for _, e := range checks.Catalog() {
		if e.SkippedByFast {
			marked = append(marked, e.ID)
		}
	}
	if want := []string{"tests.mutation", "api.fuzz", "api.dast"}; !slices.Equal(marked, want) {
		t.Errorf("marked = %v, want %v", marked, want)
	}
}
