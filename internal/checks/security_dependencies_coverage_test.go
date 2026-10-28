package checks

import (
	"strings"
	"testing"
)

func TestNotCoveringLimitationNamesCountAndHostsWithoutCredentials(t *testing.T) {
	lock := lockOf(t, `
		"node_modules/public": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/public/-/public-1.0.0.tgz"},
		"node_modules/@acme/a": {"version": "2.0.0", "resolved": "https://deploy:s3cret-token@registry.example.invalid:8443/@acme/a/-/a-2.0.0.tgz?token=abc"},
		"node_modules/@acme/b": {"version": "2.0.0", "resolved": "https://registry.example.invalid/@acme/b/-/b-2.0.0.tgz"},
		"node_modules/fromgit": {"version": "1.0.0", "resolved": "git+ssh://git@github.com/x/fromgit.git#abc"},
		"node_modules/scp": {"version": "1.0.0", "resolved": "git@gitlab.example:x/scp.git"}`)
	l := notCoveringLimitation(lock, "package-lock.json")
	if l == nil {
		t.Fatal("no Limitation for four packages the advisory data does not cover")
	}
	if l.ReasonCode != "advisory_data_not_covering" || l.CheckID == nil || *l.CheckID != "security.dependencies" {
		t.Errorf("Limitation = %+v", l)
	}
	for _, want := range []string{"4 packages", "registry.example.invalid", "github.com"} {
		if !strings.Contains(l.Message, want) {
			t.Errorf("message %q lacks %q", l.Message, want)
		}
	}
	for _, bad := range []string{"s3cret", "deploy", "token=", "https://", "8443", "git@"} {
		if strings.Contains(l.Message, bad) {
			t.Errorf("message %q must not hold %q", l.Message, bad)
		}
	}
	covered := lockOf(t, `"node_modules/p": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/p/-/p-1.0.0.tgz"}`)
	if got := notCoveringLimitation(covered, "package-lock.json"); got != nil {
		t.Errorf("fully covered lockfile gave %+v", got)
	}
}

func TestPackagesFromOtherHostsThanThePublicNpmRegistryAreNotCovered(t *testing.T) {
	lock := lockOf(t, `
		"node_modules/public": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/public/-/public-1.0.0.tgz"},
		"node_modules/mirror": {"version": "1.0.0", "resolved": "https://registry.yarnpkg.com/mirror/-/mirror-1.0.0.tgz"},
		"node_modules/@acme/private": {"version": "2.0.0", "resolved": "https://registry.example.invalid/@acme/private/-/private-2.0.0.tgz"},
		"node_modules/@acme/other": {"version": "2.0.0", "resolved": "https://registry.example.invalid:8443/@acme/other/-/other-2.0.0.tgz"},
		"node_modules/fromgit": {"version": "1.0.0", "resolved": "git+ssh://git@github.com/x/fromgit.git#abc"},
		"node_modules/lookalike": {"version": "1.0.0", "resolved": "https://registry.npmjs.org.evil.invalid/lookalike/-/lookalike-1.0.0.tgz"},
		"node_modules/withauth": {"version": "1.0.0", "resolved": "https://user@registry.npmjs.org/withauth/-/withauth-1.0.0.tgz"},
		"node_modules/linked": {"resolved": "packages/linked", "link": true},
		"packages/linked": {"version": "1.0.0"},
		"node_modules/nowhere": {"version": "1.0.0"}`)
	got := notCoveredPackages(lock)
	want := []string{"node_modules/@acme/other", "node_modules/@acme/private", "node_modules/fromgit", "node_modules/lookalike"}
	if len(got) != len(want) {
		t.Fatalf("not covered = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("not covered = %v, want %v", got, want)
		}
	}
}
