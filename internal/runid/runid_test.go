package runid_test

import (
	"regexp"
	"testing"
	"time"

	"github.com/invia-flights/jscript-bench/internal/runid"
)

func TestRunIDFormat(t *testing.T) {
	start := time.Date(2026, 10, 25, 10, 15, 0, 0, time.UTC)
	got := runid.New(start, "my-service", fixedSuffix("k3f9"))
	if want := "20261025T101500Z-my-service-k3f9"; got != want {
		t.Fatalf("New = %q, want %q", got, want)
	}
}

func TestRunIDReducesTheFolderName(t *testing.T) {
	start := time.Date(2026, 10, 25, 10, 15, 0, 0, time.UTC)
	cases := map[string]string{
		"My Project_v2":  "my-project-v2",
		"UPPER":          "upper",
		"a..b//c":        "a-b-c",
		"--lead-trail--": "lead-trail",
		"ünïcode":        "n-code",
		"":               "project",
		"!!!":            "project",
	}
	for name, want := range cases {
		got := runid.New(start, name, fixedSuffix("aaaa"))
		if w := "20261025T101500Z-" + want + "-aaaa"; got != w {
			t.Errorf("name %q: %q, want %q", name, got, w)
		}
	}
}

func TestRunIDIsConvertedToUTC(t *testing.T) {
	berlin := time.FixedZone("CET", 3600)
	start := time.Date(2026, 10, 25, 11, 15, 0, 0, berlin)
	if got := runid.New(start, "x", fixedSuffix("aaaa")); got != "20261025T101500Z-x-aaaa" {
		t.Fatalf("New = %q", got)
	}
}

func TestRandomSuffixIsFourLowercaseBase32Characters(t *testing.T) {
	re := regexp.MustCompile(`^[a-z2-7]{4}$`)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		s := runid.RandomSuffix()
		if !re.MatchString(s) {
			t.Fatalf("suffix %q is not four base32 characters", s)
		}
		seen[s] = true
	}
	if len(seen) < 10 {
		t.Fatalf("suffix does not look random: %d distinct in 50", len(seen))
	}
}

func fixedSuffix(s string) func() string { return func() string { return s } }
