package cli_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// Seam A without Docker: list-checks shows the test suites of every package,
// and why a test script that chains scripts is refused.

type listedTests struct {
	Script string `json:"script"`
	Suites []struct {
		Origin  string            `json:"origin"`
		Runner  string            `json:"runner"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
		Dropped string            `json:"dropped"`
	} `json:"suites"`
	Unsupported *struct {
		Code   string `json:"code"`
		Reason string `json:"reason"`
	} `json:"unsupported"`
	LeftOut []struct {
		Step   string `json:"step"`
		Script string `json:"script"`
	} `json:"left_out"`
}

func listedTestsByPath(t *testing.T, dir string) map[string]*listedTests {
	t.Helper()
	r := call(t, noDockerEnv(t), "list-checks", dir, "--format", "json")
	if r.code != 0 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	var out struct {
		Contexts []struct {
			Path  string       `json:"path"`
			Tests *listedTests `json:"tests"`
		} `json:"contexts"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, r.stdout)
	}
	byPath := map[string]*listedTests{}
	for _, c := range out.Contexts {
		byPath[c.Path] = c.Tests
	}
	return byPath
}

func testdataProject(t *testing.T, name string) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "projects", name))
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestListChecksShowsTheSuitesOfAChainOfNpmScripts(t *testing.T) {
	tests := listedTestsByPath(t, testdataProject(t, "npm-run-chain"))["."]

	if tests == nil || tests.Unsupported != nil {
		t.Fatalf("tests = %+v, want two suites", tests)
	}
	if tests.Script != "npm run test:unit && npm run test:api" {
		t.Errorf("script = %q", tests.Script)
	}
	if len(tests.Suites) != 2 {
		t.Fatalf("suites = %+v", tests.Suites)
	}
	want := []struct{ origin, config string }{
		{"test:unit", "test/config/mocha-unit.js"}, {"test:api", "test/config/mocha-api.js"},
	}
	for i, w := range want {
		s := tests.Suites[i]
		if s.Origin != w.origin || s.Runner != "mocha" || strings.Join(s.Args, " ") != "--config "+w.config {
			t.Errorf("suite %d = %+v, want %s running mocha --config %s", i, s, w.origin, w.config)
		}
	}
}

func TestListChecksShowsTheSuitesInTheMarkdownTable(t *testing.T) {
	r := call(t, noDockerEnv(t), "list-checks", testdataProject(t, "npm-run-chain"))
	if r.code != 0 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	for _, want := range []string{"Test suites:", "`test:unit`", "`test:api`", "mocha", "--config test/config/mocha-api.js"} {
		if !strings.Contains(r.stdout, want) {
			t.Errorf("markdown does not hold %q:\n%s", want, r.stdout)
		}
	}
}

func TestListChecksNamesTheStepAndTheScriptOfARefusedChain(t *testing.T) {
	byPath := listedTestsByPath(t, testdataProject(t, "npm-run-chain-unsupported"))
	cases := []struct {
		path string
		want []string
	}{
		{"packages/or-chain", []string{"||", "`npm run test:unit || npm run test:api`"}},
		{"packages/shell-step", []string{"`./scripts/integration.sh`", "`npm run test:unit && ./scripts/integration.sh`"}},
		{"packages/lifecycle", []string{"`pretest:unit`", "`test:unit`"}},
		{"packages/cycle", []string{"cycle", "test -> test:all -> test:again -> test:all"}},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			tests := byPath[c.path]
			if tests == nil || tests.Unsupported == nil {
				t.Fatalf("tests = %+v, want unsupported", tests)
			}
			if tests.Unsupported.Code != "test_command_unsupported" || len(tests.Suites) != 0 {
				t.Errorf("tests = %+v", tests)
			}
			for _, w := range c.want {
				if !strings.Contains(tests.Unsupported.Reason, w) {
					t.Errorf("reason %q does not hold %q", tests.Unsupported.Reason, w)
				}
			}
		})
	}
	if byPath["."] != nil {
		t.Errorf("the root package has no tests, got %+v", byPath["."])
	}
}

// The Markdown of list-checks shows project text that a reason quotes, such as
// a chain step, as a code span, as report.md does: `&&` stays `&&` and the
// backticks are not escaped.
func TestListChecksMarkdownShowsQuotedTextOfAReasonAsACodeSpan(t *testing.T) {
	r := call(t, noDockerEnv(t), "list-checks", testdataProject(t, "npm-run-chain-unsupported"))
	if r.code != 0 {
		t.Fatalf("exit %d, stderr %q", r.code, r.stderr)
	}
	if strings.Contains(r.stdout, "&amp;") || strings.Contains(r.stdout, "\\`") {
		t.Errorf("a quoted step is HTML-escaped or has escaped backticks:\n%s", r.stdout)
	}
	want := "`npm run test:unit && ./scripts/integration.sh`"
	if !strings.Contains(r.stdout, want) {
		t.Errorf("markdown does not hold %q:\n%s", want, r.stdout)
	}
}
