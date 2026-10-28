package checks_test

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/invia-flights/jscript-bench/internal/checks"
	"github.com/invia-flights/jscript-bench/internal/discovery"
	"github.com/invia-flights/jscript-bench/internal/resultset"
)

// These tests run the three lockfile Checks natively, as the engine does: on a
// Snapshot folder, without Docker. The shared fixture is the testdata project
// lockfile-problems, whose hand-written lockfile holds one entry per problem.

const lockfileProblems = "../../testdata/projects/lockfile-problems"

var lockfileCheckIDs = []string{"security.integrity", "security.licenses", "package.install-scripts"}

// runLockfileCheck runs one Check in the first package Context of the project
// in dir.
func runLockfileCheck(t *testing.T, id, dir string) *checks.Result {
	t.Helper()
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := proj.Contexts[1]
	impl := checks.Implementation(id)
	if impl == nil {
		t.Fatalf("%s is not implemented", id)
	}
	return impl.Run(context.Background(), &checks.Input{
		Project: proj, Context: &ctx, OriginalPath: "/original", SnapshotDir: dir,
	})
}

// runLockfileCheckOn writes the files into a new project folder first.
func runLockfileCheckOn(t *testing.T, id string, files map[string]string) *checks.Result {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return runLockfileCheck(t, id, dir)
}

// entryNames returns the sorted lockfile entries that Findings name. Every
// lockfile Finding names its entry as `node_modules/...` in backticks.
func entryNames(fs []resultset.Finding) []string {
	var out []string
	for _, f := range fs {
		start := strings.Index(f.Message, "`")
		end := strings.Index(f.Message[start+1:], "`")
		out = append(out, strings.TrimPrefix(f.Message[start+1:start+1+end], "node_modules/"))
	}
	sort.Strings(out)
	return out
}

func TestLockfileChecksAreImplementedNativeAndPerPackage(t *testing.T) {
	for _, id := range lockfileCheckIDs {
		e, ok := checks.Lookup(id)
		if !ok || e.Status != checks.Implemented || e.Scope != checks.PerPackage || e.CanFireGates {
			t.Errorf("%s entry = %+v", id, e)
		}
		if _, runsContainers := checks.Implementation(id).(checks.ImageUser); runsContainers {
			t.Errorf("%s runs natively and must not need an image", id)
		}
	}
}

func TestLockfileChecksOnlyApplyToPackages(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"package.json", "package-lock.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range lockfileCheckIDs {
		impl := checks.Implementation(id)
		if a, _ := impl.Applicability(proj, &proj.Contexts[0]); a != resultset.NotApplicable {
			t.Errorf("%s in the project Context: %s", id, a)
		}
		if a, _ := impl.Applicability(proj, &proj.Contexts[1]); a != resultset.Applicable {
			t.Errorf("%s in a package Context: %s", id, a)
		}
	}
}

func TestAPackageWithoutAnyLockfileIsNotApplicableBecausePackageManifestWarnsAlready(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	proj, err := discovery.Discover(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range lockfileCheckIDs {
		a, reason := checks.Implementation(id).Applicability(proj, &proj.Contexts[1])
		if a != resultset.NotApplicable || !strings.HasSuffix(reason, "this package has no lockfile") {
			t.Errorf("%s: %s, %q", id, a, reason)
		}
	}
}

// A package whose manager nothing set is an npm package, as discovery reads
// it: without a lockfile there is nothing to examine.
func TestAPackageWithoutAManagerAndWithoutALockfileIsNotApplicable(t *testing.T) {
	c := &discovery.Context{ID: "C-0002", Package: &discovery.Package{Path: "."}}
	for _, id := range lockfileCheckIDs {
		a, reason := checks.Implementation(id).Applicability(&discovery.Project{}, c)
		if a != resultset.NotApplicable || !strings.HasSuffix(reason, "this package has no lockfile") {
			t.Errorf("%s: %s, %q", id, a, reason)
		}
	}
}

func TestAVersion1LockfileMakesAllThreeChecksUnsupportedWithTheReason(t *testing.T) {
	files := map[string]string{
		"package.json":      `{"name": "x"}`,
		"package-lock.json": `{"lockfileVersion": 1, "dependencies": {}}`,
	}
	for _, id := range lockfileCheckIDs {
		res := runLockfileCheckOn(t, id, files)
		if res.Status != resultset.StatusUnsupported || res.ReasonCode != "lockfile_version_unsupported" ||
			!strings.Contains(res.Reason, "lockfileVersion 1") {
			t.Errorf("%s: status %s, code %q, reason %q", id, res.Status, res.ReasonCode, res.Reason)
		}
		if len(res.Findings) != 0 || len(res.Metrics) != 0 {
			t.Errorf("%s reported without a usable lockfile: %+v %+v", id, res.Findings, res.Metrics)
		}
	}
}

func TestAPackageWithoutALockfileMakesAllThreeChecksUnsupported(t *testing.T) {
	for _, id := range lockfileCheckIDs {
		res := runLockfileCheckOn(t, id, map[string]string{"package.json": `{"name": "x"}`})
		if res.Status != resultset.StatusUnsupported || res.ReasonCode != "no_lockfile" {
			t.Errorf("%s: status %s, code %q", id, res.Status, res.ReasonCode)
		}
	}
}

// A packageManager field naming another manager next to an npm lockfile: the
// lockfile Checks decide the package manager exactly as package.install does,
// and the package is that manager's with or without a lockfile of its own, so
// every one of them is unsupported with the same reason.
func TestAPackageManagerFieldNextToAnNpmLockfileGivesTheResultOfPackageInstall(t *testing.T) {
	lock := `{"name": "x", "lockfileVersion": 3, "packages": {"": {"name": "x"}}}`
	cases := []struct {
		name        string
		files       map[string]string
		unsupported bool
	}{
		{"with a yarn.lock too", map[string]string{
			"package.json": `{"name": "x", "packageManager": "yarn@4.1.0"}`, "package-lock.json": lock, "yarn.lock": "# yarn\n",
		}, true},
		{"with only the npm lockfile", map[string]string{
			"package.json": `{"name": "x", "packageManager": "yarn@4.1.0"}`, "package-lock.json": lock,
		}, true},
		{"with a field naming npm", map[string]string{
			"package.json": `{"name": "x", "packageManager": "npm@10.2.0"}`, "package-lock.json": lock,
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, content := range c.files {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			proj, err := discovery.Discover(dir)
			if err != nil {
				t.Fatal(err)
			}
			install := proj.Packages[0].InstallUnsupported
			if (install != nil) != c.unsupported {
				t.Fatalf("package.install unsupported = %+v, want %v", install, c.unsupported)
			}
			for _, id := range lockfileCheckIDs {
				if a, _ := checks.Implementation(id).Applicability(proj, &proj.Contexts[1]); a != resultset.Applicable {
					t.Errorf("%s = %s, want applicable", id, a)
				}
				res := runLockfileCheck(t, id, dir)
				switch {
				case c.unsupported && (res.Status != resultset.StatusUnsupported || res.ReasonCode != "package_manager_unsupported" ||
					res.ReasonCode != install.Code || res.Reason != install.Reason):
					t.Errorf("%s = %s %q %q, want unsupported as package.install: %+v", id, res.Status, res.ReasonCode, res.Reason, install)
				case !c.unsupported && res.Status == resultset.StatusUnsupported:
					t.Errorf("%s = unsupported %q, want a Run on the npm lockfile as package.install does", id, res.ReasonCode)
				}
			}
		})
	}
}

// integrityEntries is what security.integrity must find in lockfile-problems:
// one Finding per problem entry, and none for the clean entries, the link and
// the bundled one.
var integrityEntries = map[string][]string{
	"integrity-missing":        {"no-integrity"},
	"integrity-weak":           {"weak-sha1", "weak-sha384"},
	"resolved-not-https":       {"plain-http"},
	"resolved-unexpected-host": {"foreign-host"},
	"dependency-git":           {"git-dep"},
	"dependency-file":          {"file-dep"},
	"dependency-http":          {"http-dep"},
	"dependency-url":           {"url-dep"},
}

func TestSecurityIntegrityFindsEveryKindOfProblemUnderItsOwnRule(t *testing.T) {
	res := runLockfileCheck(t, "security.integrity", lockfileProblems)
	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status %s: %s", res.Status, res.Reason)
	}
	byRule := findingsByRule(res)
	total := 0
	for rule, want := range integrityEntries {
		fs := byRule[rule]
		total += len(fs)
		if got := entryNames(fs); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: entries %v, want %v", rule, got, want)
		}
		for _, f := range fs {
			if f.Gate || f.Severity != resultset.SeverityWarning || f.Kind != resultset.KindDefect {
				t.Errorf("%s: want a warning defect without a Gate: %+v", rule, f)
			}
			loc := f.Locations[0]
			if loc.Path != "package-lock.json" || loc.Start == nil || loc.FileSHA256 == "" {
				t.Errorf("%s: location = %+v, want the lockfile with a line", rule, loc)
			}
			if f.Actual == nil || f.Reproduction.VerifiedBy[0] != "security.integrity" {
				t.Errorf("%s: finding = %+v", rule, f)
			}
		}
	}
	if total != len(res.Findings) {
		t.Errorf("%d findings, but %d under the known rules: %+v", len(res.Findings), total, res.Findings)
	}
}

func TestSecurityIntegrityPointsAtTheLineOfTheEntry(t *testing.T) {
	res := runLockfileCheck(t, "security.integrity", lockfileProblems)
	f := findingsByRule(res)["integrity-missing"][0]
	data, err := os.ReadFile(filepath.Join(lockfileProblems, "package-lock.json"))
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Split(string(data), "\n")[f.Locations[0].Start.Line-1]
	if !strings.Contains(line, `"node_modules/no-integrity"`) {
		t.Errorf("line %d is %q", f.Locations[0].Start.Line, line)
	}
}

func TestSecurityIntegrityTrustsHostsFromTheNpmrcAndThePublicRegistryOnly(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "resolved": "https://reg.example.com/a/-/a-1.0.0.tgz", "integrity": "sha512-x"},
	  "node_modules/b": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/b/-/b-1.0.0.tgz", "integrity": "sha512-x"}}}`
	for name, tc := range map[string]struct {
		npmrc string
		want  int
	}{
		"no npmrc":                 {"", 1},
		"default registry":         {"registry=https://reg.example.com/\n", 0},
		"scoped registry":          {"@s:registry=https://reg.example.com/npm/\n", 0},
		"auth line only":           {"//reg.example.com/:_authToken=${TOKEN}\n", 0},
		"another host":             {"registry=https://other.example.com/\n", 1},
		"comments are not hosts":   {"; registry=https://reg.example.com/\n# registry=https://reg.example.com/\n", 1},
		"an unresolvable variable": {"registry=${REGISTRY}\n", 1},
	} {
		files := map[string]string{"package.json": `{"name": "x"}`, "package-lock.json": lock}
		if tc.npmrc != "" {
			files[".npmrc"] = tc.npmrc
		}
		res := runLockfileCheckOn(t, "security.integrity", files)
		if n := len(findingsByRule(res)["resolved-unexpected-host"]); n != tc.want {
			t.Errorf("%s: %d unexpected-host findings, want %d", name, n, tc.want)
		}
	}
}

func TestSecurityIntegrityWorksOnLockfileVersion2AndReadsShrinkwrap(t *testing.T) {
	lock := `{"lockfileVersion": 2, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}},
	  "dependencies": {"a": {"version": "1.0.0"}}}`
	res := runLockfileCheckOn(t, "security.integrity", map[string]string{"package.json": `{"name": "x"}`, "npm-shrinkwrap.json": lock})
	fs := findingsByRule(res)["integrity-missing"]
	if res.Status != resultset.StatusCompleted || len(fs) != 1 || fs[0].Locations[0].Path != "npm-shrinkwrap.json" {
		t.Fatalf("status %s, findings %+v", res.Status, res.Findings)
	}
}

func TestSecurityIntegrityAcceptsSeveralHashesWhenOneIsSha512(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha1-x sha512-y"}}}`
	res := runLockfileCheckOn(t, "security.integrity", map[string]string{"package.json": `{"name": "x"}`, "package-lock.json": lock})
	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v", res.Findings)
	}
}

func TestSecurityIntegrityFingerprintsDifferPerFinding(t *testing.T) {
	res := runLockfileCheck(t, "security.integrity", lockfileProblems)
	seen := map[string]bool{}
	for _, f := range res.Findings {
		if seen[f.Fingerprint.Value] {
			t.Errorf("two findings share the fingerprint %s", f.Fingerprint.Value)
		}
		seen[f.Fingerprint.Value] = true
	}
}

func TestSecurityIntegrityNeverCopiesCredentialsFromAURL(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "resolved": "git+https://user:s3cret@github.com/acme/a.git#abc"}}}`
	res := runLockfileCheckOn(t, "security.integrity", map[string]string{"package.json": `{"name": "x"}`, "package-lock.json": lock})
	if len(findingsByRule(res)["dependency-git"]) != 1 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		if strings.Contains(f.Message+*f.Actual, "s3cret") {
			t.Errorf("credentials in %+v", f)
		}
	}
}

func TestSecurityIntegrityNeverCopiesTokensFromAQueryStringOrFragment(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "resolved": "https://downloads.example.org/a.tgz?token=s3cret&x=1", "integrity": "sha512-x"},
	  "node_modules/b": {"version": "1.0.0", "resolved": "http://downloads.example.org/b.tgz?token=s3cret"},
	  "node_modules/c": {"version": "1.0.0", "resolved": "git+https://github.com/acme/c.git#s3cret-token"},
	  "node_modules/d": {"version": "1.0.0", "resolved": "git+https://github.com/acme/d.git?token=s3cret#0123456789abcdef0123456789abcdef01234567"},
	  "node_modules/e": {"version": "1.0.0", "resolved": "https://reg.example.net/e/-/e-1.0.0.tgz?token=s3cret", "integrity": "sha512-x"}}}`
	res := runLockfileCheckOn(t, "security.integrity", map[string]string{"package.json": `{"name": "x"}`, "package-lock.json": lock})
	if len(res.Findings) < 5 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		if all := f.Title + f.Message + *f.Actual + *f.Expected; strings.Contains(all, "s3cret") {
			t.Errorf("a token reached %s: %s", ruleOf(f), all)
		}
	}
	for _, f := range findingsByRule(res)["dependency-git"] {
		if strings.Contains(f.Message, "/d.git") && !strings.Contains(*f.Actual, "#0123456789abcdef0123456789abcdef01234567") {
			t.Errorf("the locked commit should stay visible: %s", *f.Actual)
		}
	}
}

func TestSecurityIntegrityShowsAnOpaqueURLAsAPlaceholderAndKeepsFilePaths(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "resolved": "https:s3cret@downloads.example.org/a.tgz", "integrity": "sha512-x"},
	  "node_modules/b": {"version": "1.0.0", "resolved": "git+ssh:s3cret@github.com:acme/b.git"},
	  "node_modules/c": {"version": "1.0.0", "resolved": "file:vendor/c-1.0.0.tgz"},
	  "node_modules/d": {"version": "1.0.0", "resolved": "file:s3cret@vendor/d.tgz"}}}`
	res := runLockfileCheckOn(t, "security.integrity", map[string]string{"package.json": `{"name": "x"}`, "package-lock.json": lock})
	if len(res.Findings) != 4 {
		t.Fatalf("findings = %+v", res.Findings)
	}
	for _, f := range res.Findings {
		if all := f.Title + f.Message + *f.Actual; strings.Contains(all, "s3cret") {
			t.Errorf("an opaque URL reached %s: %s", ruleOf(f), all)
		}
	}
	for _, f := range findingsByRule(res)["dependency-file"] {
		if strings.Contains(f.Message, "node_modules/c`") && *f.Actual != "file:vendor/c-1.0.0.tgz" {
			t.Errorf("the file path should stay visible: %s", *f.Actual)
		}
	}
}

// licenseCounts is what security.licenses must report for lockfile-problems:
// the root package and the link are not counted, the bundled entry and the
// one without a license are `none_in_lockfile`.
var licenseCounts = map[string]float64{
	"MIT":                 6,
	"ISC":                 3,
	"(MIT OR Apache-2.0)": 1,
	"none_in_lockfile":    2,
}

func TestSecurityLicensesGroupsTheLicenseFieldsBySPDXExpression(t *testing.T) {
	res := runLockfileCheck(t, "security.licenses", lockfileProblems)
	if res.Status != resultset.StatusCompleted || len(res.Findings) != 0 {
		t.Fatalf("status %s, findings %+v", res.Status, res.Findings)
	}
	got := map[string]float64{}
	for _, m := range res.Metrics {
		if m.Value == nil || m.Unit != "packages" || !strings.HasPrefix(m.Name, "license:") {
			t.Errorf("metric = %+v", m)
			continue
		}
		got[strings.TrimPrefix(m.Name, "license:")] = *m.Value
	}
	if len(got) != len(licenseCounts) {
		t.Errorf("licenses = %v, want %v", got, licenseCounts)
	}
	for k, want := range licenseCounts {
		if got[k] != want {
			t.Errorf("license %q: %v packages, want %v", k, got[k], want)
		}
	}
}

func TestSecurityLicensesAppliesNoPolicyAndKeepsOldLicenseShapesAsText(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {},
	  "node_modules/a": {"version": "1.0.0", "license": {"type": "MIT", "url": "x"}},
	  "node_modules/b": {"version": "1.0.0", "license": "GPL-3.0-only"}}}`
	res := runLockfileCheckOn(t, "security.licenses", map[string]string{"package.json": `{"name": "x"}`, "package-lock.json": lock})
	if len(res.Findings) != 0 {
		t.Errorf("a license inventory has no policy, but found %+v", res.Findings)
	}
	names := map[string]bool{}
	for _, m := range res.Metrics {
		names[m.Name] = true
	}
	if !names["license:GPL-3.0-only"] || !names[`license:{"type": "MIT", "url": "x"}`] {
		t.Errorf("metrics = %+v", res.Metrics)
	}
}

func metricValue(t *testing.T, res *checks.Result, name string) float64 {
	t.Helper()
	for _, m := range res.Metrics {
		if m.Name == name {
			if m.Value == nil {
				t.Fatalf("metric %s has no value", name)
			}
			return *m.Value
		}
	}
	t.Fatalf("no metric %s in %+v", name, res.Metrics)
	return 0
}

func TestInstallScriptsListsEveryEntryWithHasInstallScript(t *testing.T) {
	res := runLockfileCheck(t, "package.install-scripts", lockfileProblems)
	if res.Status != resultset.StatusCompleted {
		t.Fatalf("status %s: %s", res.Status, res.Reason)
	}
	// A side indicator is no defect: it reports Metrics, never Findings, so a
	// project that merely depends on fsevents is not marked.
	if len(res.Findings) != 0 {
		t.Errorf("findings = %+v", res.Findings)
	}
	var listed []string
	for _, m := range res.Metrics {
		if name, ok := strings.CutPrefix(m.Name, "install_script:"); ok {
			listed = append(listed, name)
			if m.Value == nil || *m.Value != 1 || m.Unit != "packages" {
				t.Errorf("metric = %+v", m)
			}
		}
	}
	sort.Strings(listed)
	if strings.Join(listed, ",") != "node_modules/git-dep,node_modules/no-integrity" {
		t.Errorf("listed entries = %v", listed)
	}
	if n := metricValue(t, res, "install_scripts"); n != 2 {
		t.Errorf("install_scripts = %v, want 2", n)
	}
}

func TestInstallScriptsRecordsWhetherAnAllowScriptsPolicyIsDeclared(t *testing.T) {
	lock := `{"lockfileVersion": 3, "packages": {"": {}, "node_modules/a": {"version": "1.0.0", "hasInstallScript": true}}}`
	for name, tc := range map[string]struct {
		files map[string]string
		want  float64
	}{
		"none":                  {map[string]string{"package.json": `{"name": "x"}`}, 0},
		"in package.json":       {map[string]string{"package.json": `{"name": "x", "allowScripts": {"a": true}}`}, 1},
		"null in package.json":  {map[string]string{"package.json": `{"name": "x", "allowScripts": null}`}, 0},
		"in .npmrc":             {map[string]string{"package.json": `{"name": "x"}`, ".npmrc": "allow-scripts=a\n"}, 1},
		"list form in .npmrc":   {map[string]string{"package.json": `{"name": "x"}`, ".npmrc": "allow-scripts[]=a\n"}, 1},
		"camel case in .npmrc":  {map[string]string{"package.json": `{"name": "x"}`, ".npmrc": "allowScripts=a\n"}, 1},
		"only in a comment":     {map[string]string{"package.json": `{"name": "x"}`, ".npmrc": "; allow-scripts=a\n"}, 0},
		"a different npmrc key": {map[string]string{"package.json": `{"name": "x"}`, ".npmrc": "ignore-scripts=true\n"}, 0},
	} {
		tc.files["package-lock.json"] = lock
		res := runLockfileCheckOn(t, "package.install-scripts", tc.files)
		if got := metricValue(t, res, "allow_scripts_policy"); got != tc.want {
			t.Errorf("%s: allow_scripts_policy = %v, want %v", name, got, tc.want)
		}
	}
}

func TestInstallScriptsWithoutAnyScriptsStillRecordsThePolicyAndACountOfZero(t *testing.T) {
	res := runLockfileCheckOn(t, "package.install-scripts", map[string]string{
		"package.json": `{"name": "x"}`, "package-lock.json": `{"lockfileVersion": 3, "packages": {"": {}}}`,
	})
	if len(res.Findings) != 0 || metricValue(t, res, "install_scripts") != 0 || metricValue(t, res, "allow_scripts_policy") != 0 {
		t.Errorf("res = %+v", res)
	}
}
