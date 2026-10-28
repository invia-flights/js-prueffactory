package toolvolume

import (
	"testing"
	"time"
)

func TestTheAdvisoryDatabaseIsRefreshedWhenOlderThanTwentyFourHours(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name string
		date string
		want bool
	}{
		{"an hour old", "2026-10-26T11:00:00Z", false},
		{"exactly 24 hours old", "2026-10-25T12:00:00Z", false},
		{"a second over 24 hours", "2026-10-25T11:59:59Z", true},
		{"a week old", "2026-10-19T12:00:00Z", true},
		{"no date at all", "", true},
		{"a date nobody can read", "yesterday", true},
		{"a date in the future", "2026-10-27T12:00:00Z", true},
	} {
		date, _ := parseDBDate(c.date)
		if got := needsRefresh(date, now); got != c.want {
			t.Errorf("%s: needsRefresh = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestTheDatabaseDateRoundTripsThroughItsMarkerFile(t *testing.T) {
	d := time.Date(2026, 10, 26, 8, 30, 15, 0, time.UTC)
	got, ok := parseDBDate(formatDBDate(d) + "\n")
	if !ok || !got.Equal(d) {
		t.Fatalf("parseDBDate(formatDBDate(%v)) = %v, %v", d, got, ok)
	}
}
