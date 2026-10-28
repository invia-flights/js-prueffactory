package cli_test

import (
	"strings"
	"testing"
)

// Seam A without Docker: what list-checks says about tests.existing for the
// scripts.test strings real projects have, and for every reason a package's
// tests cannot be run.

func testsExistingRow(t *testing.T, files map[string]string) (applicability, reason string) {
	t.Helper()
	l := listChecksJSON(t, projectWith(t, files), "--format", "json")
	row := l.Checks[rowOf(t, l, "tests.existing")]
	if len(row.Applicability) != 1 {
		t.Fatalf("tests.existing applicability = %+v", row.Applicability)
	}
	return row.Applicability[0].Applicability, row.Applicability[0].Reason
}

func TestTestsExistingIsImplementedAndCanFireGates(t *testing.T) {
	l := listChecksJSON(t, projectWith(t, map[string]string{"package.json": `{"name":"demo"}`}), "--format", "json")
	row := l.Checks[rowOf(t, l, "tests.existing")]
	if row.Status != "implemented" || !row.Selected || !row.CanFireGates || row.BenchmarkArea != "tests" {
		t.Errorf("tests.existing = %+v", row)
	}
}

func TestListChecksAcceptsTheTestScriptsItCanRun(t *testing.T) {
	for name, script := range map[string]string{
		"plain":               "mocha",
		"quoted paths":        `mocha 'test/api' 'test/unit' --config test/mocha-opts.js`,
		"env assignment":      "NODE_ENV=test mocha --exit",
		"cross-env":           "cross-env NODE_ENV=test mocha",
		"c8 wrapper":          "c8 --reporter=lcov mocha test/",
		"nyc wrapper":         "nyc mocha",
		"c8 behind cross-env": "cross-env NODE_ENV=test c8 mocha",
	} {
		got, reason := testsExistingRow(t, map[string]string{
			"package.json": `{"name":"demo","scripts":{"test":` + jsonString(script) + `}}`, "package-lock.json": `{"lockfileVersion":3,"packages":{}}`,
		})
		// The Mocha version, known only after the install, decides how the run
		// goes, so list-checks does not guess (spec: Applicability that depends
		// on installed dependencies is unknown).
		if got != "unknown" || !strings.Contains(reason, "Mocha version") {
			t.Errorf("%s: %q = %s %q, want unknown with the reason that the Mocha version is not known yet", name, script, got, reason)
		}
	}
}

func jsonString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func TestListChecksNamesWhyTheTestsCannotBeRun(t *testing.T) {
	lock := `{"lockfileVersion":3,"packages":{}}`
	cases := []struct {
		name  string
		files map[string]string
		want  []string // texts the reason holds
	}{
		{"jest", map[string]string{"package.json": `{"scripts":{"test":"jest --ci"}}`, "package-lock.json": lock}, []string{"Jest", "jest --ci"}},
		{"vitest", map[string]string{"package.json": `{"scripts":{"test":"vitest run"}}`, "package-lock.json": lock}, []string{"Vitest", "vitest run"}},
		{"ava", map[string]string{"package.json": `{"scripts":{"test":"ava"}}`, "package-lock.json": lock}, []string{"AVA"}},
		{"chained commands", map[string]string{"package.json": `{"scripts":{"test":"npm run lint && mocha"}}`, "package-lock.json": lock}, []string{"npm run lint && mocha", "&&"}},
		{"a script file", map[string]string{"package.json": `{"scripts":{"test":"node scripts/test.js"}}`, "package-lock.json": lock}, []string{"node scripts/test.js"}},
		{"variable expansion", map[string]string{"package.json": `{"scripts":{"test":"mocha $SPECS"}}`, "package-lock.json": lock}, []string{"mocha $SPECS", "$"}},
		{"another package manager", map[string]string{"package.json": `{"scripts":{"test":"mocha"}}`, "yarn.lock": "# yarn\n"}, []string{"yarn.lock"}},
		{"npm workspaces", map[string]string{"package.json": `{"workspaces":["p/*"],"scripts":{"test":"mocha"}}`, "package-lock.json": lock}, []string{"workspaces"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, reason := testsExistingRow(t, c.files)
			if got != "applicable" || !strings.HasPrefix(reason, "unsupported: ") {
				t.Fatalf("tests.existing = %s %q, want applicable with an unsupported reason", got, reason)
			}
			for _, w := range c.want {
				if !strings.Contains(reason, w) {
					t.Errorf("reason %q does not hold %q", reason, w)
				}
			}
		})
	}
}

func TestListChecksFindsMochaThroughItsConfigFileWithoutATestScript(t *testing.T) {
	got, reason := testsExistingRow(t, map[string]string{
		"package.json": `{"name":"demo"}`, ".mocharc.json": `{"spec":["test/*.js"]}`,
		"package-lock.json": `{"lockfileVersion":3,"packages":{}}`,
	})
	if got != "unknown" || !strings.Contains(reason, "Mocha version") {
		t.Errorf("tests.existing = %s %q, want unknown (the Mocha version is known only after the install)", got, reason)
	}
}

func TestListChecksSaysNotApplicableWhenThereIsNothingToRun(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"no test script":    {"package.json": `{"name":"demo","scripts":{"start":"node ."}}`},
		"npm's placeholder": {"package.json": `{"name":"demo","scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}`},
	} {
		got, reason := testsExistingRow(t, files)
		if got != "not_applicable" || !strings.Contains(reason, "no test script") {
			t.Errorf("%s: tests.existing = %s %q", name, got, reason)
		}
	}
}
