package discovery

import (
	"strconv"
	"strings"
)

// nodeRange is an npm semver range, such as the one in `engines.node`, reduced
// to what the tool needs: whether some version of a given Node major satisfies
// it. Versions are encoded as one integer, major*1e12 + minor*1e6 + patch, so
// that every comparator becomes an interval. Prerelease and build suffixes are
// ignored.
type nodeRange struct {
	alternatives []interval
}

// interval is a closed range of encoded versions. It is empty when lo > hi.
type interval struct{ lo, hi int64 }

const (
	versionMax   = int64(99999)*1e12 + int64(99999)*1e6 + 99999
	componentMax = 99999
)

func (a interval) intersect(b interval) interval {
	if b.lo > a.lo {
		a.lo = b.lo
	}
	if b.hi < a.hi {
		a.hi = b.hi
	}
	return a
}

func (a interval) empty() bool { return a.lo > a.hi }

// satisfiedBy says whether some version of the Node major satisfies the range.
func (r *nodeRange) satisfiedBy(major int) bool {
	m := interval{lo: int64(major) * 1e12, hi: int64(major+1)*1e12 - 1}
	for _, alt := range r.alternatives {
		if !alt.intersect(m).empty() {
			return true
		}
	}
	return false
}

// parseNodeRange reads an npm range. It reports false for text it cannot
// understand, so that such text never decides a version.
func parseNodeRange(s string) (*nodeRange, bool) {
	if len(s) > 200 {
		return nil, false
	}
	r := &nodeRange{}
	for _, alt := range strings.Split(s, "||") {
		iv, ok := parseComparatorSet(alt)
		if !ok {
			return nil, false
		}
		r.alternatives = append(r.alternatives, iv)
	}
	return r, true
}

// parseComparatorSet reads space-separated comparators and hyphen ranges, all
// of which must hold.
func parseComparatorSet(s string) (interval, bool) {
	all := interval{0, versionMax}
	tokens := strings.Fields(s)
	// ">= 1.2.3" is one comparator written with a space.
	var merged []string
	for i := 0; i < len(tokens); i++ {
		switch tokens[i] {
		case ">", ">=", "<", "<=", "=", "^", "~", "~>":
			if i+1 < len(tokens) {
				merged = append(merged, tokens[i]+tokens[i+1])
				i++
				continue
			}
			return all, false
		}
		merged = append(merged, tokens[i])
	}
	for i := 0; i < len(merged); i++ {
		if i+2 < len(merged) && merged[i+1] == "-" {
			lo, ok1 := parsePartial(merged[i])
			hi, ok2 := parsePartial(merged[i+2])
			if !ok1 || !ok2 {
				return all, false
			}
			all = all.intersect(interval{lo.low(), hi.high()})
			i += 2
			continue
		}
		iv, ok := parseComparator(merged[i])
		if !ok {
			return all, false
		}
		all = all.intersect(iv)
	}
	return all, true
}

// partial is a version with parts that may be missing or wildcards.
type partial struct {
	major, minor, patch int64
	given               int // how many leading parts are numbers, 0 to 3
}

func enc(major, minor, patch int64) int64 { return major*1e12 + minor*1e6 + patch }

// low is the lowest version the partial stands for.
func (p partial) low() int64 { return enc(p.major, p.minor, p.patch) }

// high is the highest version the partial stands for: 1.2 means up to 1.2.max.
func (p partial) high() int64 {
	switch p.given {
	case 0:
		return versionMax
	case 1:
		return enc(p.major+1, 0, 0) - 1
	case 2:
		return enc(p.major, p.minor+1, 0) - 1
	}
	return p.low()
}

func parsePartial(s string) (partial, bool) {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "v"), "=")
	if i := strings.IndexAny(s, "+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) == 0 || len(parts) > 3 || s == "" {
		return partial{}, false
	}
	var p partial
	vals := [3]*int64{&p.major, &p.minor, &p.patch}
	wild := false
	for i, part := range parts {
		if i == 2 {
			// A prerelease tag on the patch: 1.2.3-beta.1 is read as 1.2.3.
			if j := strings.Index(part, "-"); j >= 0 {
				part = part[:j]
			}
		}
		if part == "x" || part == "X" || part == "*" {
			wild = true
			continue
		}
		if wild || part == "" || len(part) > 5 {
			return partial{}, false
		}
		n, err := strconv.ParseInt(part, 10, 64)
		if err != nil || n < 0 || n > componentMax {
			return partial{}, false
		}
		*vals[i] = n
		p.given = i + 1
	}
	return p, true
}

func parseComparator(tok string) (interval, bool) {
	all := interval{0, versionMax}
	op := ""
	for _, o := range []string{">=", "<=", "~>", ">", "<", "=", "^", "~"} {
		if strings.HasPrefix(tok, o) {
			op = o
			tok = tok[len(o):]
			break
		}
	}
	p, ok := parsePartial(tok)
	if !ok {
		return all, false
	}
	switch op {
	case "", "=":
		return interval{p.low(), p.high()}, true
	case ">":
		if p.given == 0 {
			return interval{1, 0}, true // nothing is above *
		}
		return interval{p.high() + 1, versionMax}, true
	case ">=":
		return interval{p.low(), versionMax}, true
	case "<":
		if p.given == 0 {
			return interval{1, 0}, true
		}
		return interval{0, p.low() - 1}, true
	case "<=":
		return interval{0, p.high()}, true
	case "~", "~>":
		switch p.given {
		case 0:
			return all, true
		case 1:
			return interval{p.low(), enc(p.major+1, 0, 0) - 1}, true
		}
		return interval{p.low(), enc(p.major, p.minor+1, 0) - 1}, true
	case "^":
		switch {
		case p.given == 0:
			return all, true
		case p.major > 0 || p.given == 1:
			return interval{p.low(), enc(p.major+1, 0, 0) - 1}, true
		case p.minor > 0 || p.given == 2:
			return interval{p.low(), enc(p.major, p.minor+1, 0) - 1}, true
		}
		return interval{p.low(), enc(0, 0, p.patch+1) - 1}, true
	}
	return all, false
}
