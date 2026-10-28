package redact

import (
	"fmt"
	"sort"
	"strings"
)

// maxScanned bounds the problems per field that are checked against every
// rewritten field of a larger object.
const maxScanned = 20

// Explain says, for the problems found when the finished Report was validated,
// which of them redaction caused. A problem that starts with a JSON Pointer
// ("/findings/0/locations/0/path_base: value must be ...") names a field; the
// lines name the fields Apply rewrote and the rules or sources that registered
// the values it replaced there, and the fields it did not rewrite. Problems of
// one field in many array elements make one line. A final line lists every rule
// that replaced something. No line contains a value.
//
// It returns nothing when the Redactor holds no values or the problems name no
// field.
func (r *Redactor) Explain(problems []string) []string {
	if r.Len() == 0 {
		return nil
	}
	type group struct {
		first   string // the first pointer of the group
		count   int
		sources map[string]bool
	}
	groups := map[string]*group{}
	var order []string
	for _, p := range problems {
		ptr, _, ok := strings.Cut(p, ": ")
		if !ok || !strings.HasPrefix(ptr, "/") {
			continue
		}
		shape := generalize(ptr)
		g := groups[shape]
		if g == nil {
			g = &group{first: ptr, sources: map[string]bool{}}
			groups[shape] = g
			order = append(order, shape)
		}
		g.count++
		for s := range r.hits[ptr] {
			g.sources[s] = true
		}
		if g.count <= maxScanned && len(g.sources) == 0 {
			// The problem may name an object that holds rewritten fields.
			for hit, srcs := range r.hits {
				if strings.HasPrefix(hit, ptr+"/") {
					for s := range srcs {
						g.sources[s] = true
					}
				}
			}
		}
	}
	var lines, untouched []string
	for _, shape := range order {
		g := groups[shape]
		label := shape
		if g.count == 1 {
			label = g.first
		} else {
			label = fmt.Sprintf("%s, first at %s", shape, g.first)
		}
		if len(g.sources) == 0 {
			untouched = append(untouched, label)
			continue
		}
		lines = append(lines, fmt.Sprintf("%s (%s): redaction rewrote this field; values registered by %s were replaced in it",
			label, plural(g.count, "problem"), joinSet(g.sources)))
	}
	if len(untouched) > 0 {
		lines = append(lines, "redaction did not rewrite "+strings.Join(untouched, ", "))
	}
	if len(lines) > 0 && len(r.sourceCount) > 0 {
		var parts []string
		for s, n := range r.sourceCount {
			parts = append(parts, fmt.Sprintf("%s (%s)", s, plural(n, "replacement")))
		}
		sort.Strings(parts)
		lines = append(lines, "redaction replaced values registered by: "+strings.Join(parts, ", "))
	}
	return lines
}

// generalize turns the array indexes of a JSON Pointer into *.
func generalize(ptr string) string {
	parts := strings.Split(ptr, "/")
	for i, p := range parts {
		if p != "" && strings.Trim(p, "0123456789") == "" {
			parts[i] = "*"
		}
	}
	return strings.Join(parts, "/")
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

func joinSet(set map[string]bool) string {
	var out []string
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return strings.Join(out, " and ")
}
