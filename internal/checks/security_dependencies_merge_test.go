package checks

import (
	"strings"
	"testing"
)

// osvOf builds a report with one package and the given groups and records.
func osvOf(name, version, groups, vulns string) []byte {
	return []byte(`{"results":[{"packages":[{"package":{"name":"` + name + `","version":"` + version + `"},` +
		`"groups":[` + groups + `],"vulnerabilities":[` + vulns + `]}]}]}`)
}

func TestGroupsThatShareAnAliasAreOneAdvisory(t *testing.T) {
	report := osvOf("minimist", "1.2.5",
		`{"ids":["GHSA-aaaa"],"aliases":["CVE-1","GHSA-aaaa"]},{"ids":["OSV-2"],"aliases":["CVE-1","OSV-2"]}`,
		`{"id":"GHSA-aaaa","aliases":["CVE-1"],"database_specific":{"severity":"HIGH"}},{"id":"OSV-2","aliases":["CVE-1"]}`)
	got, err := interpretOSV(report, lockOf(t, minimistEntry))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || strings.Join(got[0].IDs, ",") != "CVE-1,GHSA-aaaa,OSV-2" || got[0].Severity != "high" {
		t.Fatalf("advisories = %v, want one with all three IDs and the high severity", got)
	}
}

func TestDifferentVulnerabilitiesOfOnePackageVersionStayApart(t *testing.T) {
	report := osvOf("minimist", "1.2.5",
		`{"ids":["GHSA-aaaa"],"aliases":["GHSA-aaaa"]},{"ids":["GHSA-bbbb"],"aliases":["GHSA-bbbb"]}`,
		`{"id":"GHSA-aaaa"},{"id":"GHSA-bbbb"}`)
	got, _ := interpretOSV(report, lockOf(t, minimistEntry))
	if len(got) != 2 {
		t.Fatalf("advisories = %v, want two", got)
	}
}

func TestScopeComesFromTheDevFlagOfTheLockfileEntries(t *testing.T) {
	report := osvOf("minimist", "1.2.5", `{"ids":["GHSA-aaaa"],"aliases":[]}`, `{"id":"GHSA-aaaa"}`)
	dev := lockOf(t, `"node_modules/minimist": {"version": "1.2.5", "dev": true}`)
	got, _ := interpretOSV(report, dev)
	if len(got) != 1 || got[0].Scope != "dev" {
		t.Errorf("only dev entry: %v, want scope dev", got)
	}
	both := lockOf(t, `"node_modules/minimist": {"version": "1.2.5", "dev": true},
		"node_modules/a/node_modules/minimist": {"version": "1.2.5"}`)
	got, _ = interpretOSV(report, both)
	if len(got) != 1 || got[0].Scope != "prod" || got[0].LockKey != "node_modules/a/node_modules/minimist" {
		t.Errorf("a production entry too: %v, want scope prod at the production entry", got)
	}
}

func TestMalwareAdvisoriesAreCriticalWhateverTheDatabaseSays(t *testing.T) {
	report := osvOf("minimist", "1.2.5", `{"ids":["MAL-2024-1"],"aliases":["MAL-2024-1"],"max_severity":"0"}`,
		`{"id":"MAL-2024-1","database_specific":{"severity":"LOW"}}`)
	got, _ := interpretOSV(report, lockOf(t, minimistEntry))
	if len(got) != 1 || got[0].Severity != "critical" || got[0].Fixed != "" {
		t.Fatalf("advisories = %v, want critical without a fix", got)
	}
}

func TestAnAdvisoryWithoutSeverityCountsAsModerateWithANote(t *testing.T) {
	report := osvOf("minimist", "1.2.5", `{"ids":["GHSA-aaaa"],"aliases":[],"max_severity":""}`, `{"id":"GHSA-aaaa"}`)
	got, _ := interpretOSV(report, lockOf(t, minimistEntry))
	if len(got) != 1 || got[0].Severity != "moderate" || got[0].SeverityNote == "" {
		t.Fatalf("advisories = %v, want moderate with a note", got)
	}
}

func TestSeverityFallsBackToTheCVSSScoreOsvScannerComputed(t *testing.T) {
	for score, want := range map[string]string{"9.8": "critical", "7.5": "high", "5.0": "moderate", "3.1": "low"} {
		report := osvOf("minimist", "1.2.5", `{"ids":["GHSA-aaaa"],"aliases":[],"max_severity":"`+score+`"}`, `{"id":"GHSA-aaaa"}`)
		got, _ := interpretOSV(report, lockOf(t, minimistEntry))
		if len(got) != 1 || got[0].Severity != want || got[0].SeverityNote != "" {
			t.Errorf("score %s: %v, want %s without a note", score, got, want)
		}
	}
}

func TestTheFixedVersionIsTheFixOfTheRangeThatContainsTheInstalledVersion(t *testing.T) {
	vuln := `{"id":"GHSA-aaaa","affected":[{"package":{"name":"minimist"},"ranges":[{"type":"SEMVER","events":[
		{"introduced":"0"},{"fixed":"0.2.4"},{"introduced":"1.0.0"},{"fixed":"1.2.6"}]}]}]}`
	// 1.10.0 is past the fix at 1.2.6 in semantic order, so no range contains it.
	for version, want := range map[string]string{"0.2.0": "0.2.4", "1.2.5": "1.2.6", "1.10.0": ""} {
		report := osvOf("minimist", version, `{"ids":["GHSA-aaaa"],"aliases":[]}`, vuln)
		entry := `"node_modules/minimist": {"version": "` + version + `"}`
		got, _ := interpretOSV(report, lockOf(t, entry))
		if len(got) != 1 || got[0].Fixed != want {
			t.Errorf("version %s: %v, want fixed %q", version, got, want)
		}
	}
}

func TestAnAdvisoryWithoutAFixNamesNone(t *testing.T) {
	vuln := `{"id":"GHSA-aaaa","affected":[{"package":{"name":"minimist"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"}]}]}]}`
	got, _ := interpretOSV(osvOf("minimist", "1.2.5", `{"ids":["GHSA-aaaa"],"aliases":[]}`, vuln), lockOf(t, minimistEntry))
	if len(got) != 1 || got[0].Fixed != "" {
		t.Fatalf("advisories = %v, want no fixed version", got)
	}
}

func TestCompareVersionsOrdersSemanticVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.2.5", "1.2.6", -1}, {"1.10.0", "1.2.6", 1}, {"1.2.6", "1.2.6", 0}, {"2.0.0-rc.1", "2.0.0", -1},
		{"2.0.0-rc.2", "2.0.0-rc.10", -1}, {"1.0", "1.0.0", 0}, {"1.0.0+build", "1.0.0", 0}, {"v1.0.1", "1.0.0", 1},
	} {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
