package resultset

import (
	"encoding/json"
	"sort"
)

// canonical is the JSON of a value, used as the last tie-breaker of a sort. The
// ID is left out because it is the temporary key the sort replaces.
func canonical(v any) string {
	switch x := v.(type) {
	case Finding:
		x.ID = ""
		v = x
	case TestCase:
		x.ID = ""
		v = x
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// sortLists puts the lists no ID refers to into a fixed order: Limitations,
// Services and the Inventory.
func (s *Set) sortLists() {
	sort.SliceStable(s.Contexts, func(i, j int) bool { return s.Contexts[i].ID < s.Contexts[j].ID })
	sort.SliceStable(s.Limitations, func(i, j int) bool {
		a, b := s.Limitations[i], s.Limitations[j]
		if x, y := derefString(a.CheckID), derefString(b.CheckID); x != y {
			return x < y
		}
		if a.ReasonCode != b.ReasonCode {
			return a.ReasonCode < b.ReasonCode
		}
		if x, y := derefString(a.Path), derefString(b.Path); x != y {
			return x < y
		}
		return a.Message < b.Message
	})
	sort.SliceStable(s.Services, func(i, j int) bool {
		a, b := s.Services[i], s.Services[j]
		if a.Family != b.Family {
			return a.Family < b.Family
		}
		if a.ComposeService != b.ComposeService {
			return a.ComposeService < b.ComposeService
		}
		return canonical(a) < canonical(b)
	})
	inv := &s.Inventory
	sort.SliceStable(inv.Tests, func(i, j int) bool { return inv.Tests[i].ContextID < inv.Tests[j].ContextID })
	// Suites keep the order they run in, which the Check put them in.
	sort.SliceStable(inv.TestSuites, func(i, j int) bool { return inv.TestSuites[i].ContextID < inv.TestSuites[j].ContextID })
	sort.SliceStable(inv.TestFiles, func(i, j int) bool {
		a, b := inv.TestFiles[i], inv.TestFiles[j]
		if a.ContextID != b.ContextID {
			return a.ContextID < b.ContextID
		}
		if a.Suite != b.Suite {
			return a.Suite < b.Suite
		}
		return a.File < b.File
	})
	sort.SliceStable(inv.Suppressions, func(i, j int) bool {
		a, b := inv.Suppressions[i], inv.Suppressions[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.FileClass < b.FileClass
	})
	sort.SliceStable(inv.FileHashes, func(i, j int) bool {
		a, b := inv.FileHashes[i], inv.FileHashes[j]
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.Role < b.Role
	})
	sort.SliceStable(inv.MovedTestFiles, func(i, j int) bool {
		a, b := inv.MovedTestFiles[i], inv.MovedTestFiles[j]
		if a.ContextID != b.ContextID {
			return a.ContextID < b.ContextID
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.Suite < b.Suite
	})
	sort.SliceStable(inv.Size, func(i, j int) bool {
		a, b := inv.Size[i], inv.Size[j]
		if a.Group != b.Group {
			return a.Group < b.Group
		}
		return a.Name < b.Name
	})
}
