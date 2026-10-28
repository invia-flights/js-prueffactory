package lockfile

import "sort"

// MismatchKind says how a manifest dependency and the lockfile disagree.
type MismatchKind string

const (
	// MissingDependency: the lockfile does not install the dependency.
	MissingDependency MismatchKind = "missing"
	// SpecifierMismatch: the lockfile recorded another specifier for it.
	SpecifierMismatch MismatchKind = "specifier"
)

// Mismatch is one dependency of the manifest that `npm ci` would refuse.
type Mismatch struct {
	Kind MismatchKind
	Name string
	// Section is the manifest section that declares it: dependencies,
	// devDependencies or optionalDependencies.
	Section       string
	Specifier     string // as in package.json
	LockSpecifier string // as the lockfile's root entry records it, for SpecifierMismatch
}

// Check compares the dependencies of a manifest with a lockfile, the way
// `npm ci` does before it installs: the lockfile must install every
// dependency, and the root entry must record the manifest's specifier. The
// result is ordered by section and name.
func Check(m *Manifest, l *Lock) []Mismatch {
	root, hasRoot := l.Packages[""]
	var out []Mismatch
	sections := []struct {
		name string
		deps map[string]string
	}{
		{"dependencies", m.Dependencies},
		{"devDependencies", m.DevDependencies},
		{"optionalDependencies", m.OptionalDependencies},
	}
	for _, s := range sections {
		names := make([]string, 0, len(s.deps))
		for n := range s.deps {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			spec := s.deps[n]
			mm := Mismatch{Name: n, Section: s.name, Specifier: spec}
			_, installed := l.Packages["node_modules/"+n]
			recorded, declared := rootSpecifier(root, n)
			switch {
			case !installed || (hasRoot && !declared):
				mm.Kind = MissingDependency
			case hasRoot && recorded != spec:
				mm.Kind, mm.LockSpecifier = SpecifierMismatch, recorded
			default:
				continue
			}
			out = append(out, mm)
		}
	}
	return out
}

func rootSpecifier(root Entry, name string) (string, bool) {
	for _, deps := range []map[string]string{
		root.Dependencies, root.DevDependencies, root.OptionalDependencies, root.PeerDependencies,
	} {
		if spec, ok := deps[name]; ok {
			return spec, true
		}
	}
	return "", false
}
