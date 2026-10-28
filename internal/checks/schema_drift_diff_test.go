package checks

import (
	"strings"
	"testing"
)

func TestUnifiedDiffShowsChangesWithThreeLinesOfContextAndSplitsFarApartHunks(t *testing.T) {
	var old, now []string
	for i := 1; i <= 20; i++ {
		old = append(old, "line "+string(rune('a'+i-1))+"\n")
		now = append(now, "line "+string(rune('a'+i-1))+"\n")
	}
	now[1] = "line B\n"                                                    // line 2 changes
	now = append(now[:16], append([]string{"inserted\n"}, now[16:]...)...) // a line goes in after line 16
	now = append(now[:19], now[20:]...)                                    // old line 19 goes

	got := unifiedDiff("a/f.txt", "b/f.txt", strings.Join(old, ""), strings.Join(now, ""))

	want := `--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,5 @@
 line a
-line b
+line B
 line c
 line d
 line e
@@ -14,7 +14,7 @@
 line n
 line o
 line p
+inserted
 line q
 line r
-line s
 line t
`
	if got != want {
		t.Errorf("diff =\n%s\nwant\n%s", got, want)
	}
}

func TestUnifiedDiffOfEqualTextsIsEmpty(t *testing.T) {
	if got := unifiedDiff("a", "b", "x\ny\n", "x\ny\n"); got != "" {
		t.Errorf("diff = %q, want none", got)
	}
}

func TestUnifiedDiffMarksAMissingFinalLineFeed(t *testing.T) {
	got := unifiedDiff("a", "b", "x\ny", "x\ny\n")

	want := "--- a\n+++ b\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+y\n"
	if got != want {
		t.Errorf("diff = %q, want %q", got, want)
	}
}

func TestUnifiedDiffOfAnEmptyAndAFilledTextIsOneHunk(t *testing.T) {
	got := unifiedDiff("a", "b", "", "x\ny\n")

	want := "--- a\n+++ b\n@@ -0,0 +1,2 @@\n+x\n+y\n"
	if got != want {
		t.Errorf("diff = %q, want %q", got, want)
	}
}

func TestUnifiedDiffOfTextsFarApartInEditsStillReplacesAndNeverLosesALine(t *testing.T) {
	var old, now strings.Builder
	for i := 0; i < 3000; i++ {
		old.WriteString("old " + strings.Repeat("a", i%7) + "\n")
		now.WriteString("new " + strings.Repeat("b", i%5) + "\n")
	}

	got := unifiedDiff("a", "b", old.String(), now.String())

	if strings.Count(got, "\n-old") != 3000 || strings.Count(got, "\n+new") != 3000 {
		t.Errorf("diff has %d removed and %d added lines, want 3000 each", strings.Count(got, "\n-old"), strings.Count(got, "\n+new"))
	}
}
