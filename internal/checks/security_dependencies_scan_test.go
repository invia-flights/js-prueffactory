package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/resultset"
)

const twoPackages = `"node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"},
	"node_modules/b": {"version": "2.0.0", "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz"}`

// allPackages is a report of --all-packages for the given name@version list,
// none of them vulnerable.
func allPackages(pkgs ...string) []byte {
	var items []string
	for _, p := range pkgs {
		name, version, _ := strings.Cut(p, "@")
		items = append(items, `{"package":{"name":"`+name+`","version":"`+version+`"},"groups":[],"vulnerabilities":[]}`)
	}
	return []byte(`{"results":[{"packages":[` + strings.Join(items, ",") + `]}]}`)
}

func TestScannerThatSawNoPackagesInALockfileWithPackagesDoesNotCompleteClean(t *testing.T) {
	// Exit 128 is "no packages found". A lockfile of ours that lists packages
	// means the two parsers disagree, and nothing was scanned.
	got := judgeScan(128, nil, lockOf(t, twoPackages))
	if got.Fail == nil || got.Fail.Code != "scanner_saw_no_packages" || got.Fail.Status != resultset.StatusToolError {
		t.Fatalf("judgement = %+v, want a tool_error scanner_saw_no_packages", got)
	}
	// The same when it exits 0 with a report that names no package at all.
	got = judgeScan(0, []byte(`{"results":[]}`), lockOf(t, twoPackages))
	if got.Fail == nil || got.Fail.Code != "scanner_saw_no_packages" {
		t.Fatalf("judgement for an empty report = %+v", got)
	}
}

func TestAnEmptyLockfileIsCleanWhenTheScannerFindsNoPackages(t *testing.T) {
	got := judgeScan(128, nil, lockOf(t, `"node_modules/linked": {"link": true, "resolved": "../x"}`))
	if got.Fail != nil || got.Partial != "" || len(got.Advisories) != 0 {
		t.Fatalf("judgement = %+v, want clean", got)
	}
}

func TestAScannerThatSawFewerPackagesThanTheLockfileListsIsPartial(t *testing.T) {
	got := judgeScan(0, allPackages("a@1.0.0"), lockOf(t, twoPackages))
	if got.Fail != nil || got.Partial == "" || !strings.Contains(got.Partial, "1 of the 2") {
		t.Fatalf("judgement = %+v, want partial naming 1 of 2 packages", got)
	}
}

func TestEqualCountsDoNotHideADifferentSetOfPackages(t *testing.T) {
	// Two of two packages, but not the same two: b was missed and c is one the
	// lockfile does not list.
	got := judgeScan(0, allPackages("a@1.0.0", "c@3.0.0"), lockOf(t, twoPackages))
	if got.Fail != nil {
		t.Fatalf("judgement = %+v", got)
	}
	for _, want := range []string{"b@2.0.0", "c@3.0.0"} {
		if !strings.Contains(got.Partial, want) {
			t.Errorf("partial = %q, want it to name %s", got.Partial, want)
		}
	}
	if strings.Contains(got.Partial, "a@1.0.0") {
		t.Errorf("partial = %q names a package both sides saw", got.Partial)
	}
}

func TestAPackageTheScannerInventedIsAMismatchEvenWhenEverythingElseMatches(t *testing.T) {
	got := judgeScan(0, allPackages("a@1.0.0", "b@2.0.0", "c@3.0.0"), lockOf(t, twoPackages))
	if got.Fail != nil || !strings.Contains(got.Partial, "c@3.0.0") {
		t.Fatalf("judgement = %+v, want a mismatch naming c@3.0.0", got)
	}
}

func TestTheNamedPairsAreCapped(t *testing.T) {
	var entries []string
	for i := 0; i < 30; i++ {
		name := string(rune('a'+i%26)) + string(rune('a'+i/26)) + "pkg"
		entries = append(entries, `"node_modules/`+name+`": {"version": "1.0.0"}`)
	}
	got := judgeScan(0, allPackages("other@9.9.9"), lockOf(t, strings.Join(entries, ",")))
	if got.Fail != nil || !strings.Contains(got.Partial, "and 20 more") {
		t.Fatalf("judgement = %+v, want the list capped at 10 with the rest counted", got)
	}
}

func TestAnAliasedPackageIsMatchedByItsRealName(t *testing.T) {
	lock := lockOf(t, `"node_modules/short": {"name": "long-name", "version": "1.0.0"}`)
	got := judgeScan(0, allPackages("long-name@1.0.0"), lock)
	if got.Fail != nil || got.Partial != "" {
		t.Fatalf("judgement = %+v, want complete: npm aliases name the real package in `name`", got)
	}
}

func TestAScannerThatSawAllPackagesIsComplete(t *testing.T) {
	got := judgeScan(0, allPackages("a@1.0.0", "b@2.0.0"), lockOf(t, twoPackages))
	if got.Fail != nil || got.Partial != "" {
		t.Fatalf("judgement = %+v, want complete", got)
	}
}

func TestVulnerabilitiesReportedButNoneReadableIsAnError(t *testing.T) {
	got := judgeScan(1, allPackages("a@1.0.0", "b@2.0.0"), lockOf(t, twoPackages))
	if got.Fail == nil || got.Fail.Code != "report_unreadable" {
		t.Fatalf("judgement = %+v", got)
	}
}

func TestAnUnreadableReportIsAnError(t *testing.T) {
	got := judgeScan(0, []byte("not json"), lockOf(t, twoPackages))
	if got.Fail == nil || got.Fail.Code != "report_unreadable" {
		t.Fatalf("judgement = %+v", got)
	}
}
