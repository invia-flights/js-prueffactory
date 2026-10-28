package cli_test

import (
	"strings"
	"testing"
)

// Seam A without Docker: what list-checks says about the native lockfile
// Checks for packages that npm does not install.

var lockfileCheckIDs = []string{"security.integrity", "security.licenses", "package.install-scripts"}

// rootPackageApplicability returns the Applicability row of a Check for the
// root package.
func rootPackageApplicability(t *testing.T, l listJSON, id string) (applicability, reason string) {
	t.Helper()
	for _, a := range l.Checks[rowOf(t, l, id)].Applicability {
		if a.Kind == "package" && a.Path == "." {
			return a.Applicability, a.Reason
		}
	}
	t.Fatalf("%s has no row for the root package", id)
	return "", ""
}

func TestListChecksShowsTheLockfileChecksApplicableForAYarnPackage(t *testing.T) {
	l := listChecksJSON(t, testdataProject(t, "yarn-unsupported"), "--format", "json")
	for _, id := range lockfileCheckIDs {
		got, reason := rootPackageApplicability(t, l, id)
		if got != "applicable" {
			t.Errorf("%s = %s (%q), want applicable", id, got, reason)
		}
	}
}

func TestListChecksShowsTheLockfileChecksApplicableForEveryOtherPackageManager(t *testing.T) {
	cases := map[string]map[string]string{
		"pnpm lockfile":        {"package.json": `{"name":"demo"}`, "pnpm-lock.yaml": "lockfileVersion: 9\n"},
		"bun text lockfile":    {"package.json": `{"name":"demo"}`, "bun.lock": "{}\n"},
		"bun binary lockfile":  {"package.json": `{"name":"demo"}`, "bun.lockb": "x"},
		"packageManager field": {"package.json": `{"name":"demo","packageManager":"pnpm@9.1.0"}`},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			l := listChecksJSON(t, projectWith(t, files), "--format", "json")
			for _, id := range lockfileCheckIDs {
				got, reason := rootPackageApplicability(t, l, id)
				if got != "applicable" || !strings.Contains(reason, "unsupported") {
					t.Errorf("%s = %s (%q), want applicable with an unsupported reason", id, got, reason)
				}
			}
		})
	}
}

func TestListChecksKeepsTheLockfileChecksNotApplicableWhenThePackageManagerFieldNamesNpm(t *testing.T) {
	l := listChecksJSON(t, projectWith(t, map[string]string{"package.json": `{"name":"demo","packageManager":"npm@10.8.0"}`}), "--format", "json")
	for _, id := range lockfileCheckIDs {
		if got, reason := rootPackageApplicability(t, l, id); got != "not_applicable" {
			t.Errorf("%s = %s (%q), want not_applicable: an npm package without a lockfile has nothing to examine", id, got, reason)
		}
	}
}

func TestListChecksKeepsTheLockfileChecksNotApplicableWithoutAnyLockfile(t *testing.T) {
	l := listChecksJSON(t, testdataProject(t, "no-lockfile"), "--format", "json")
	for _, id := range lockfileCheckIDs {
		got, reason := rootPackageApplicability(t, l, id)
		if got != "not_applicable" || !strings.HasSuffix(reason, "this package has no lockfile") {
			t.Errorf("%s = %s (%q), want not_applicable because there is no lockfile", id, got, reason)
		}
	}
}
