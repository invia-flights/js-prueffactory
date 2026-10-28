package render_test

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/render"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// The Checks that share one ESLint run each carry the same Limitation about
// files it could not parse. The Gaps list it once, naming every Check.
// report.json keeps one entry per Check.
func TestGapsListALimitationOnceWhenSeveralChecksShareIt(t *testing.T) {
	s := handMade()
	before := len(s.Limitations)
	same := "ESLint could not parse these files: a.js, b.js"
	for _, id := range []string{"deps.engines", "lint.correctness", "tests.smells"} {
		s.Limitations = append(s.Limitations, resultset.Limitation{ReasonCode: "files_not_parsed", CheckID: ptr(id), Message: same})
	}
	s.Limitations = append(s.Limitations,
		resultset.Limitation{ReasonCode: "files_not_parsed", CheckID: ptr("quality.metrics"), Message: "ESLint could not parse these files: c.js"})
	s.Finalize()
	got := gaps(s)
	if n := strings.Count(got, "ESLint could not parse these files: a.js, b.js"); n != 1 {
		t.Errorf("the shared Limitation is listed %d times, want once:\n%s", n, got)
	}
	if !strings.Contains(got, "Limitation `files_not_parsed` in `deps.engines`, `lint.correctness` and `tests.smells`: ESLint could not parse these files: a.js, b.js") {
		t.Errorf("the Gaps do not name the three Checks:\n%s", got)
	}
	if !strings.Contains(got, "in `quality.metrics`: ESLint could not parse these files: c.js") {
		t.Errorf("a Limitation with another text was merged:\n%s", got)
	}
	if n := len(s.Limitations) - before; n != 4 {
		t.Errorf("the result set gained %d Limitations, want 4", n)
	}
}

// modules.cycles runs once per package. When two packages fall back for lack
// of production entry points, their Limitations have the same text and differ
// only in the package.json they name. The Gaps keep one line per package and
// say which package it is.
func TestGapsKeepOneLinePerPackageWhenTwoPackagesHaveTheSameLimitation(t *testing.T) {
	s := handMade()
	msg := "No production entry point of this package was found among the cruised files."
	for _, p := range []string{"package.json", "ci/complexity/package.json"} {
		s.Limitations = append(s.Limitations,
			resultset.Limitation{ReasonCode: "production_entry_points_unknown", CheckID: ptr("modules.cycles"), Path: ptr(p), Message: msg})
	}
	s.Finalize()
	got := gaps(s)
	for _, want := range []string{
		"- Limitation `production_entry_points_unknown` in `modules.cycles` at `package.json`: " + msg,
		"- Limitation `production_entry_points_unknown` in `modules.cycles` at `ci/complexity/package.json`: " + msg,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Gaps lack %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "`modules.cycles` and `modules.cycles`") {
		t.Errorf("the two packages were merged into one line:\n%s", got)
	}
}

// A Check that did not complete says why in its own Gaps line. When it also
// holds a Limitation with the same code and text, the Gaps do not say it twice.
func TestGapsDoNotRepeatALimitationThatTheChecksOwnLineAlreadySays(t *testing.T) {
	s := handMade()
	e := blockedCheck(s)
	e.ReasonCode = ptr("package_manager_unsupported")
	e.Reason = ptr("the package uses yarn")
	s.Limitations = append(s.Limitations,
		resultset.Limitation{ReasonCode: "package_manager_unsupported", CheckID: ptr(e.CheckID), Message: "the package uses yarn"},
		resultset.Limitation{ReasonCode: "package_manager_unsupported", CheckID: ptr(e.CheckID), Message: "and it has no lockfile either"})
	s.Finalize()
	got := gaps(s)
	if n := strings.Count(got, "the package uses yarn"); n != 1 {
		t.Errorf("the reason is said %d times, want once:\n%s", n, got)
	}
	if !strings.Contains(got, "and it has no lockfile either") {
		t.Errorf("a Limitation with another text was dropped:\n%s", got)
	}
}

// A measurement without a value says why in the Measurements table, and a
// measurement with a long fraction is shown rounded to two places. report.json
// keeps the exact number.
func TestMeasurementsShowTheReasonOfAMissingValueAndRoundLongFractions(t *testing.T) {
	s := handMade()
	s.Metrics = []resultset.Metric{
		{ID: "M-0001", CheckID: "package.manifest", ContextID: "C-0002", Name: "package_manager", Reason: ptr("npm (found by package-lock.json)"), Unit: "name"},
		{ID: "M-0002", CheckID: "quality.clones", ContextID: "C-0001", Name: "duplication_percent_source", Value: ptr(2.5667779632721204), Unit: "percent"},
		{ID: "M-0003", CheckID: "quality.size", ContextID: "C-0001", Name: "lines.extension:.json", Value: ptr(1000000.0), Unit: "lines"},
		{ID: "M-0004", CheckID: "tests.coverage", ContextID: "C-0002", Name: "lines", Value: ptr(88.0), Unit: "percent"},
	}
	s.Finalize()
	got := section(string(render.Markdown(s)), "## Measurements")
	for _, want := range []string{
		"| n/a: npm (found by package-lock.json) |",
		"| 2.57 | percent |",
		"| 1000000 | lines |",
		"| 88 | percent |",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Measurements lack %q:\n%s", want, got)
		}
	}
}
