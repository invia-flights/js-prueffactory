package checks

import (
	"fmt"
	"strings"
)

// Selection is the Checks a Run or `list-checks` call covers: what was asked
// for with --only and --exclude and what that resulted in.
type Selection struct {
	// Only and Exclude are the requested names, flattened from the flags in the
	// order given.
	Only, Exclude []string
	// Effective holds the selected Check IDs and Deselected the implemented
	// Checks left out, both in Catalog order.
	Effective, Deselected []string
	// IsStandardScope is true when every implemented Check is selected.
	IsStandardScope bool
	// Fast is true when --fast was given. DeselectedByFast holds the Checks it
	// removed from what --only and --exclude had chosen; they are also in
	// Deselected.
	Fast             bool
	DeselectedByFast []string
}

// Selected says whether a Check ID is in the Selection.
func (s *Selection) Selected(id string) bool {
	for _, e := range s.Effective {
		if e == id {
			return true
		}
	}
	return false
}

// Resolve applies --only and --exclude to a Catalog, without --fast. Each argument is one flag
// value and may hold several comma-separated names; a flag may repeat. A name is
// a Check ID or a family, the part of an ID before the first dot. Without only,
// every implemented Check is selected. Only builds the union, then exclude
// subtracts.
//
// A name that is neither a Check nor a family, a planned Check, a family of
// planned Checks only, an empty name and an empty result are errors, so that a
// typo never produces a Run that checked nothing. A family that has both
// implemented and planned members stands for its implemented members.
func Resolve(entries []Entry, only, exclude []string) (*Selection, error) {
	return ResolveFast(entries, only, exclude, false)
}

// ResolveFast is Resolve with --fast: after --only and --exclude it removes
// every implemented Check that is marked "skipped by --fast", and reports it as
// deselected by --fast. A marked Check that is still planned changes nothing.
// A Selection that --fast empties is an error like any other empty Selection.
func ResolveFast(entries []Entry, only, exclude []string, fast bool) (*Selection, error) {
	onlyNames, err := splitNames("--only", only)
	if err != nil {
		return nil, err
	}
	excludeNames, err := splitNames("--exclude", exclude)
	if err != nil {
		return nil, err
	}

	chosen := map[string]bool{}
	if len(onlyNames) == 0 {
		for _, e := range entries {
			if e.Status == Implemented {
				chosen[e.ID] = true
			}
		}
	}
	for _, name := range onlyNames {
		ids, err := expand(entries, "--only", name)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			chosen[id] = true
		}
	}
	for _, name := range excludeNames {
		ids, err := expand(entries, "--exclude", name)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			delete(chosen, id)
		}
	}

	sel := &Selection{Only: onlyNames, Exclude: excludeNames, Fast: fast}
	for _, e := range entries {
		if e.Status != Implemented {
			continue
		}
		if fast && e.SkippedByFast && chosen[e.ID] {
			sel.Deselected = append(sel.Deselected, e.ID)
			sel.DeselectedByFast = append(sel.DeselectedByFast, e.ID)
			continue
		}
		if chosen[e.ID] {
			sel.Effective = append(sel.Effective, e.ID)
		} else {
			sel.Deselected = append(sel.Deselected, e.ID)
		}
	}
	if len(sel.Effective) == 0 {
		return nil, fmt.Errorf("the Selection contains no Checks: %s", describe(onlyNames, excludeNames, fast))
	}
	sel.IsStandardScope = len(sel.Deselected) == 0
	return sel, nil
}

// ResolveCatalog resolves a Selection against the current Catalog.
func ResolveCatalog(only, exclude []string) (*Selection, error) {
	return Resolve(Catalog(), only, exclude)
}

// ResolveCatalogFast resolves a Selection against the current Catalog, with
// --fast when fast is true.
func ResolveCatalogFast(only, exclude []string, fast bool) (*Selection, error) {
	return ResolveFast(Catalog(), only, exclude, fast)
}

func splitNames(flagName string, values []string) ([]string, error) {
	var names []string
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			name := strings.TrimSpace(part)
			if name == "" {
				return nil, fmt.Errorf("%s has an empty Check name in %q", flagName, v)
			}
			names = append(names, name)
		}
	}
	return names, nil
}

// expand returns the implemented Check IDs a name stands for.
func expand(entries []Entry, flagName, name string) ([]string, error) {
	var ids []string
	known, planned := false, false
	for _, e := range entries {
		if e.ID != name && e.Family != name {
			continue
		}
		known = true
		if e.Status == Implemented {
			ids = append(ids, e.ID)
		} else {
			planned = true
		}
	}
	switch {
	case !known:
		return nil, fmt.Errorf("%s: unknown Check or family %q; js-prueffactory list-checks <path> shows the Catalog", flagName, name)
	case len(ids) == 0 && planned:
		return nil, fmt.Errorf("%s: %q is planned and not implemented yet, so it cannot be selected", flagName, name)
	}
	return ids, nil
}

func describe(only, exclude []string, fast bool) string {
	var parts []string
	if len(only) > 0 {
		parts = append(parts, "--only "+strings.Join(only, ","))
	}
	if len(exclude) > 0 {
		parts = append(parts, "--exclude "+strings.Join(exclude, ","))
	}
	if fast {
		parts = append(parts, "--fast")
	}
	if len(parts) == 0 {
		return "the Catalog has no implemented Checks"
	}
	return strings.Join(parts, " ")
}
