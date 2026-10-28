package checks

import (
	"fmt"
	"strings"
)

// A small unified diff of two texts, for the artifacts of schema.drift. It
// diffs lines with Myers' algorithm after cutting the common first and last
// lines. When the texts differ by more than driftMaxEdits lines it gives up
// finding the shortest edit and shows the lines between the common ends as
// removed and added, which is always correct and only less compact.

const (
	// driftMaxEdits bounds the work and the memory of the line diff.
	driftMaxEdits = 1000
	// driftContext is the number of unchanged lines around a change.
	driftContext = 3
)

type diffOp byte

const (
	opEqual  diffOp = ' '
	opDelete diffOp = '-'
	opInsert diffOp = '+'
)

type diffEdit struct {
	op   diffOp
	line string
}

// splitLines splits a text after each line feed, so that every line but maybe
// the last keeps its line ending.
func splitLines(s string) []string {
	var lines []string
	for len(s) > 0 {
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			lines = append(lines, s)
			break
		}
		lines = append(lines, s[:i+1])
		s = s[i+1:]
	}
	return lines
}

// diffLines returns the edit script that turns a into b.
func diffLines(a, b []string) []diffEdit {
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	var out []diffEdit
	for _, l := range a[:prefix] {
		out = append(out, diffEdit{opEqual, l})
	}
	midA, midB := a[prefix:len(a)-suffix], b[prefix:len(b)-suffix]
	mid, ok := myers(midA, midB)
	if !ok {
		mid = nil
		for _, l := range midA {
			mid = append(mid, diffEdit{opDelete, l})
		}
		for _, l := range midB {
			mid = append(mid, diffEdit{opInsert, l})
		}
	}
	out = append(out, mid...)
	for _, l := range a[len(a)-suffix:] {
		out = append(out, diffEdit{opEqual, l})
	}
	return out
}

// myers finds a shortest edit script of at most driftMaxEdits edits. It
// reports false when there is none that short.
func myers(a, b []string) ([]diffEdit, bool) {
	n, m := len(a), len(b)
	if n == 0 && m == 0 {
		return nil, true
	}
	limit := min(n+m, driftMaxEdits)
	off := limit + 1
	v := make([]int, 2*limit+3)
	var trace [][]int // trace[d] is v before round d
	for d := 0; d <= limit; d++ {
		trace = append(trace, append([]int(nil), v...))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[off+k] = x
			if x >= n && y >= m {
				return backtrack(a, b, trace, off), true
			}
		}
	}
	return nil, false
}

// backtrack walks the trace of myers from the end to the start.
func backtrack(a, b []string, trace [][]int, off int) []diffEdit {
	x, y := len(a), len(b)
	var rev []diffEdit
	for d := len(trace) - 1; d > 0; d-- {
		v := trace[d]
		k := x - y
		var prevK int
		if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := v[off+prevK]
		prevY := prevX - prevK
		for x > prevX && y > prevY {
			rev = append(rev, diffEdit{opEqual, a[x-1]})
			x--
			y--
		}
		if x == prevX {
			rev = append(rev, diffEdit{opInsert, b[prevY]})
		} else {
			rev = append(rev, diffEdit{opDelete, a[prevX]})
		}
		x, y = prevX, prevY
	}
	for x > 0 && y > 0 {
		rev = append(rev, diffEdit{opEqual, a[x-1]})
		x--
		y--
	}
	out := make([]diffEdit, len(rev))
	for i, e := range rev {
		out[len(rev)-1-i] = e
	}
	return out
}

// unifiedDiff renders the difference between two texts as a unified diff with
// the given names in its header. It returns the empty string for equal texts.
func unifiedDiff(oldName, newName, oldText, newText string) string {
	edits := diffLines(splitLines(oldText), splitLines(newText))
	changed := false
	for _, e := range edits {
		if e.op != opEqual {
			changed = true
			break
		}
	}
	if !changed {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "--- %s\n+++ %s\n", oldName, newName)

	// Each hunk spans the changes that lie within 2*driftContext lines of each
	// other, with driftContext lines on both sides.
	for i := 0; i < len(edits); {
		for i < len(edits) && edits[i].op == opEqual {
			i++
		}
		if i == len(edits) {
			break
		}
		start := max(i-driftContext, 0)
		end, quiet := i, 0
		for j := i; j < len(edits); j++ {
			if edits[j].op == opEqual {
				quiet++
				if quiet > 2*driftContext {
					break
				}
				continue
			}
			quiet, end = 0, j
		}
		stop := min(end+1+driftContext, len(edits))

		oldStart, newStart := 1, 1
		for _, e := range edits[:start] {
			if e.op != opInsert {
				oldStart++
			}
			if e.op != opDelete {
				newStart++
			}
		}
		oldCount, newCount := 0, 0
		for _, e := range edits[start:stop] {
			if e.op != opInsert {
				oldCount++
			}
			if e.op != opDelete {
				newCount++
			}
		}
		if oldCount == 0 {
			oldStart--
		}
		if newCount == 0 {
			newStart--
		}
		fmt.Fprintf(&b, "@@ -%s +%s @@\n", hunkRange(oldStart, oldCount), hunkRange(newStart, newCount))
		for _, e := range edits[start:stop] {
			b.WriteByte(byte(e.op))
			b.WriteString(e.line)
			if !strings.HasSuffix(e.line, "\n") {
				b.WriteString("\n\\ No newline at end of file\n")
			}
		}
		i = stop
	}
	return b.String()
}

func hunkRange(start, count int) string {
	if count == 1 {
		return fmt.Sprint(start)
	}
	return fmt.Sprintf("%d,%d", start, count)
}
