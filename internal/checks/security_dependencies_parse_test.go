package checks

import (
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/lockfile"
)

// Recorded from osv-scanner 2.7.0 (`scan --offline-vulnerabilities --format
// json -L package-lock.json:...`) on a lockfile that locks minimist 1.2.5. Only
// the long reference list was cut.
const osvMinimist = `{
  "results": [{
    "source": {"path": "/scan/package-lock.json", "type": "lockfile"},
    "packages": [{
      "package": {"name": "minimist", "version": "1.2.5", "ecosystem": "npm", "purl": "pkg:npm/minimist@1.2.5?source=PUBLIC_REGISTRY"},
      "groups": [{"ids": ["GHSA-xvch-5gv4-984h"], "aliases": ["CVE-2021-44906", "GHSA-xvch-5gv4-984h"], "max_severity": "9.8"}],
      "vulnerabilities": [{
        "affected": [
          {"package": {"ecosystem": "npm", "name": "minimist", "purl": "pkg:npm/minimist"},
           "ranges": [{"type": "SEMVER", "events": [{"introduced": "1.0.0"}, {"fixed": "1.2.6"}]}]},
          {"package": {"ecosystem": "npm", "name": "minimist", "purl": "pkg:npm/minimist"},
           "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "0.2.4"}]}]}
        ],
        "aliases": ["CVE-2021-44906"],
        "database_specific": {"cwe_ids": ["CWE-1321"], "github_reviewed": true, "severity": "CRITICAL"},
        "id": "GHSA-xvch-5gv4-984h",
        "severity": [{"score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "type": "CVSS_V3"}],
        "summary": "Prototype Pollution in minimist"
      }]
    }]
  }]
}`

// lockOf parses a lockfile of version 3 with the given entries.
func lockOf(t *testing.T, entries string) *lockfile.Lock {
	t.Helper()
	l, err := lockfile.ParseLock([]byte(`{"lockfileVersion": 3, "packages": {"": {"name": "x"}, ` + entries + `}}`))
	if err != nil {
		t.Fatal(err)
	}
	return l
}

const minimistEntry = `"node_modules/minimist": {"version": "1.2.5", "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz"}`

func TestOneVulnerablePackageVersionGivesOneAdvisoryWithAllItsIDs(t *testing.T) {
	got, err := interpretOSV([]byte(osvMinimist), lockOf(t, minimistEntry))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("advisories = %+v, want one", got)
	}
	a := got[0]
	if a.Package != "minimist" || a.Version != "1.2.5" {
		t.Errorf("package = %s@%s", a.Package, a.Version)
	}
	if strings.Join(a.IDs, ",") != "CVE-2021-44906,GHSA-xvch-5gv4-984h" {
		t.Errorf("ids = %v, want the advisory ID and its alias, sorted", a.IDs)
	}
	if a.Severity != "critical" || a.SeverityNote != "" {
		t.Errorf("severity = %q (%q), want critical", a.Severity, a.SeverityNote)
	}
	if a.Scope != "prod" {
		t.Errorf("scope = %q, want prod", a.Scope)
	}
	if a.Fixed != "1.2.6" {
		t.Errorf("fixed = %q, want 1.2.6, the range that contains 1.2.5", a.Fixed)
	}
	if a.LockKey != "node_modules/minimist" {
		t.Errorf("lock key = %q", a.LockKey)
	}
}

func TestACleanScanHasNoAdvisories(t *testing.T) {
	for _, out := range []string{``, `{"results": []}`, `{"results": [{"source": {"path": "x"}, "packages": []}]}`} {
		got, err := interpretOSV([]byte(out), lockOf(t, minimistEntry))
		if err != nil || len(got) != 0 {
			t.Errorf("interpretOSV(%q) = %+v, %v", out, got, err)
		}
	}
}

func TestAnOutputThatIsNotJSONIsAnError(t *testing.T) {
	if _, err := interpretOSV([]byte("Scanned 1 package"), lockOf(t, minimistEntry)); err == nil {
		t.Error("want an error for text that is not the JSON report")
	}
}
